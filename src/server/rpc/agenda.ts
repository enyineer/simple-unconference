import { ORPCError } from "@orpc/server";
import type { PrismaClient, Prisma } from "@prisma/client";
import {
  requireConf, actorIdentityId,
  normalizeLabels, resolveFinished,
} from "./shared";
import { clipToMinute } from "../../shared/tz";
import { assignUnconferenceSlot, assignMixerSlot, pairKey, type AssignmentInput } from "../assignment";
import { effectiveSlotConfig, SLOT_CONFIG_INCLUDE } from "../lib/slot-config";
import { createNotifications } from "../notifications";

// Shapes of pre-assignment conflicts surfaced by `runAssignmentForSlot`.
// Mirrors the `PreAssignmentConflict` union in the API contract.
type PreAssignmentConflict =
  | {
      kind: "duplicate_room" | "out_of_scope";
      room_id: number;
      room_name: string;
      submissions: { id: number; title: string }[];
    }
  | {
      kind: "unsatisfiable_requirements";
      submission: { id: number; title: string };
      required_tags: string[];
      // Names of rooms in the slot's effective scope whose tag set satisfies
      // the submission's requirements. Empty array = no room in this slot
      // matches at all. Non-empty = matching rooms exist but every one was
      // already claimed by a higher-priority session (pinned or more starred).
      candidate_room_names: string[];
    };

// USER-FACING DOCS: the plain-language description of the steps below
// (top-N selection, pin/tag pre-assignments, bipartite matching with
// cascade analysis, overlap exclusions, finished filter, manual picks)
// is rendered to mods + participants by
// `src/web/conference/ui/AssignmentRulesModal.tsx`. **Update that file
// whenever you change anything in `runAssignmentForSlot` or
// `runMixerForSlot` below** — it's the single source of truth for what
// the algorithm promises to do.
async function runAssignmentForSlot(
  prisma: PrismaClient,
  confId: number,
  slotId: number,
  excludeSubmissionIds?: ReadonlySet<number>,
) {
  const slot = await prisma.agendaSlot.findUniqueOrThrow({
    where: { id: slotId },
    include: SLOT_CONFIG_INCLUDE,
  });
  const cfg = effectiveSlotConfig(slot);

  const roomWhere = cfg.unconfUseAllRooms
    ? { conferenceId: confId }
    : { conferenceId: confId, id: { in: cfg.roomIds } };
  let rooms = await prisma.room.findMany({
    where: roomWhere, select: { id: true, capacity: true, name: true },
  });

  const subWhere = cfg.unconfUseAllSubmissions
    ? { conferenceId: confId, status: "published" as const }
    : {
        conferenceId: confId, status: "published" as const,
        id: { in: cfg.submissionIds },
      };
  const rawSubs = await prisma.submission.findMany({
    where: subWhere,
    select: {
      id: true, title: true, submitterId: true,
      maxPlacements: true, manuallyFinished: true,
      preAssignedRoomId: true,
      allowOverlappingPlacements: true,
      roomRequirements: { select: { value: true } },
    },
  });
  // Count placements + static tracks per submission, excluding the current
  // slot itself so a re-run doesn't push a still-eligible submission over
  // the cap. Both kinds of placement count toward "finished".
  const [otherPlacements, otherTracks, confRow] = await Promise.all([
    prisma.unconferencePlacement.groupBy({
      by: ["submissionId"],
      where: {
        slotId: { not: slotId },
        slot: { conferenceId: confId },
      },
      _count: { submissionId: true },
    }),
    prisma.trackAssignment.groupBy({
      by: ["submissionId"],
      where: {
        slotId: { not: slotId },
        slot: { conferenceId: confId },
      },
      _count: { submissionId: true },
    }),
    prisma.conference.findUniqueOrThrow({
      where: { id: confId }, select: { submissionMaxPlacementsDefault: true },
    }),
  ]);
  const placementCountBySub = new Map<number, number>();
  for (const p of otherPlacements) {
    placementCountBySub.set(p.submissionId, (placementCountBySub.get(p.submissionId) ?? 0) + p._count.submissionId);
  }
  for (const t of otherTracks) {
    placementCountBySub.set(t.submissionId, (placementCountBySub.get(t.submissionId) ?? 0) + t._count.submissionId);
  }
  let eligibleSubs = rawSubs.filter((s) => {
    if (excludeSubmissionIds?.has(s.id)) return false;
    const { is_finished } = resolveFinished(
      { maxPlacements: s.maxPlacements, manuallyFinished: s.manuallyFinished },
      confRow.submissionMaxPlacementsDefault,
      placementCountBySub.get(s.id) ?? 0,
    );
    return !is_finished;
  });

  // ----- Overlap exclusions ----------------------------------------------
  //
  // Sessions running in agenda slots that overlap this slot's time window
  // create three classes of conflict the algorithm should silently work
  // around (mod sees them as informational exclusions, not blocking
  // conflicts):
  //
  //   (a) Room reuse: a room booked by an overlapping slot can't be used
  //       here. We drop it from the room pool.
  //   (b) Busy submitter: a submitter speaking in an overlapping slot
  //       can't host a *different* session here. We drop those sessions
  //       from the candidate pool.
  //   (c) Same-session double-booking: a session already placed in an
  //       overlapping slot can't be placed here unless its
  //       `allowOverlappingPlacements` flag is set (mods opt-in for
  //       sessions designed to run in parallel — recurring workshops, etc).
  //   (d) Busy participant: a user already locked into an overlapping slot
  //       can't attend another session here. We drop them from the stars
  //       map below. "Locked into" means ANY of:
  //         - they have an explicit UserAssignment row in the overlapping
  //           slot (unconference / mixer / manual pick);
  //         - they starred a Submission that's placed (unconference) or
  //           scheduled as a TrackAssignment in the overlapping slot —
  //           Path C derivation says they'll attend it;
  //         - they're the submitter of such a Submission (auto-derived
  //           speaking gig);
  //         - the overlapping slot has any mandatory TrackAssignment
  //           (everyone in the conference is force-attending).
  //
  // The overlap-detection query is a single round-trip with placements,
  // tracks, and user-assignments loaded in parallel.
  const busyUserIds = new Set<number>();
  const overlapExcludedRooms: { id: number; name: string }[] = [];
  const overlapExcludedSubs: { id: number; title: string; reason: "same_session" | "busy_submitter" }[] = [];
  {
    const overlappingSlots = await prisma.agendaSlot.findMany({
      where: {
        conferenceId: confId,
        id: { not: slotId },
        // Overlap = startsAt < other.endsAt AND endsAt > other.startsAt.
        startsAt: { lt: slot.endsAt },
        endsAt: { gt: slot.startsAt },
      },
      select: { id: true },
    });
    const overlappingIds = overlappingSlots.map((s) => s.id);
    if (overlappingIds.length > 0) {
      const [overlapPlacements, overlapTracks, overlapAssigns] = await Promise.all([
        prisma.unconferencePlacement.findMany({
          where: { slotId: { in: overlappingIds } },
          select: { submissionId: true, roomId: true },
        }),
        prisma.trackAssignment.findMany({
          where: { slotId: { in: overlappingIds } },
          select: { submissionId: true, roomId: true, mandatory: true },
        }),
        prisma.userAssignment.findMany({
          where: { slotId: { in: overlappingIds } },
          select: { userId: true, submissionId: true, roomId: true },
        }),
      ]);

      const excludedRoomIds = new Set<number>();
      const overlapPlacedSessionIds = new Set<number>();
      let hasMandatoryOverlap = false;
      for (const p of overlapPlacements) {
        excludedRoomIds.add(p.roomId);
        overlapPlacedSessionIds.add(p.submissionId);
      }
      for (const t of overlapTracks) {
        excludedRoomIds.add(t.roomId);
        overlapPlacedSessionIds.add(t.submissionId);
        if (t.mandatory) hasMandatoryOverlap = true;
      }
      for (const a of overlapAssigns) {
        busyUserIds.add(a.userId);
        if (a.roomId !== null) excludedRoomIds.add(a.roomId);
      }

      // For (b): map submitter → set of session IDs they're hosting in
      // overlapping slots. A candidate sub is blocked when its submitter is
      // hosting a *different* session there (same session is the (c) case).
      const placedOverlappingByOtherSubmitter = overlapPlacedSessionIds.size === 0
        ? []
        : await prisma.submission.findMany({
            where: { id: { in: [...overlapPlacedSessionIds] } },
            select: { id: true, submitterId: true },
          });
      const placementsBySubmitter = new Map<number, Set<number>>();
      for (const p of placedOverlappingByOtherSubmitter) {
        let set = placementsBySubmitter.get(p.submitterId);
        if (!set) { set = new Set(); placementsBySubmitter.set(p.submitterId, set); }
        set.add(p.id);
      }

      // Path C busy-user derivation: stars + submitter + mandatory.
      //   - Stars on overlapping placed/tracked sessions → the starring user
      //     is going to attend that session (MyAssignments derives the row).
      //   - Submitter of any overlapping placed/tracked session → they're
      //     speaking; they can't also be a participant elsewhere.
      //   - Any mandatory track in an overlapping slot → every conference
      //     identity is force-attending. We union the full identity list.
      // We run these as one parallel batch (only the queries we actually need).
      const needDerivedStars = overlapPlacedSessionIds.size > 0;
      const needAllIdentities = hasMandatoryOverlap;
      const [derivedStarsRows, allIdentitiesForMandatory] = await Promise.all([
        needDerivedStars
          ? prisma.star.findMany({
              where: { submissionId: { in: [...overlapPlacedSessionIds] } },
              select: { userId: true },
            })
          : Promise.resolve([] as { userId: number }[]),
        needAllIdentities
          ? prisma.conferenceIdentity.findMany({
              where: { conferenceId: confId },
              select: { id: true },
            })
          : Promise.resolve([] as { id: number }[]),
      ]);
      for (const s of derivedStarsRows) busyUserIds.add(s.userId);
      for (const p of placedOverlappingByOtherSubmitter) busyUserIds.add(p.submitterId);
      if (hasMandatoryOverlap) {
        for (const i of allIdentitiesForMandatory) busyUserIds.add(i.id);
      }

      // Apply (c) and (b) to the candidate pool.
      eligibleSubs = eligibleSubs.filter((s) => {
        if (overlapPlacedSessionIds.has(s.id) && !s.allowOverlappingPlacements) {
          overlapExcludedSubs.push({ id: s.id, title: s.title, reason: "same_session" });
          return false;
        }
        const hosting = placementsBySubmitter.get(s.submitterId);
        if (hosting) {
          // Check for a *different* session — if the submitter's only
          // overlapping placement is this same session itself (allowed via
          // the (c) escape), no (b) conflict.
          let hasDifferent = false;
          for (const sid of hosting) {
            if (sid !== s.id) { hasDifferent = true; break; }
          }
          if (hasDifferent) {
            overlapExcludedSubs.push({ id: s.id, title: s.title, reason: "busy_submitter" });
            return false;
          }
        }
        return true;
      });

      // Apply (a) to rooms.
      const roomNameById = new Map(rooms.map((r) => [r.id, r.name]));
      rooms = rooms.filter((r) => {
        if (excludedRoomIds.has(r.id)) {
          overlapExcludedRooms.push({ id: r.id, name: roomNameById.get(r.id) ?? "" });
          return false;
        }
        return true;
      });
    }
  }
  const submissions = eligibleSubs.map((s) => ({ id: s.id, submitterId: s.submitterId }));
  const submissionIds = new Set(submissions.map((s) => s.id));

  // Load stars + identities up front: we need per-submission star counts to
  // compute the top-N placement set (which the conflict gate uses), and the
  // same data builds the `stars` map for the algorithm itself.
  const [starsRows, identityRows] = await Promise.all([
    prisma.star.findMany({
      where: { submission: { conferenceId: confId, status: "published" } },
      select: { userId: true, submissionId: true },
    }),
    prisma.conferenceIdentity.findMany({
      where: { conferenceId: confId }, select: { id: true },
    }),
  ]);
  const stars = new Map<number, Set<number>>();
  for (const i of identityRows) {
    // (d) Drop users assigned to overlapping slots. Their stars are
    // ignored for this slot's matching; they're reported in
    // overlap_exclusions.user_ids so the mod knows why they weren't
    // placed.
    if (busyUserIds.has(i.id)) continue;
    stars.set(i.id, new Set());
  }
  const starCountBySub = new Map<number, number>();
  for (const id of submissionIds) starCountBySub.set(id, 0);
  for (const s of starsRows) {
    if (!submissionIds.has(s.submissionId)) continue;
    if (busyUserIds.has(s.userId)) continue;
    stars.get(s.userId)?.add(s.submissionId);
    starCountBySub.set(s.submissionId, (starCountBySub.get(s.submissionId) ?? 0) + 1);
  }

  // Top-N: stars decide which submissions are placed. Pre-assignment only
  // chooses *which room* a placed submission occupies; a pin on a session
  // that doesn't make the top-N is silently ignored (no conflict raised).
  const subsByPopularity = [...eligibleSubs].sort((a, b) => {
    const sa = starCountBySub.get(a.id) ?? 0;
    const sb = starCountBySub.get(b.id) ?? 0;
    if (sb !== sa) return sb - sa;
    return a.id - b.id;
  });
  const numPlaced = Math.min(rooms.length, subsByPopularity.length);
  const topNSubs = subsByPopularity.slice(0, numPlaced);

  // ----- Pre-assignment conflict gate + bipartite room matching ---------
  //
  // Two stages, both restricted to top-N (sessions that stars say will run):
  //
  //   Stage 1: pinned-only pre-checks. Catches user errors with crisp
  //   messages before we attempt anything fancy:
  //     - duplicate_room: two pinned sessions target the same room.
  //     - out_of_scope: a pinned room isn't in the slot's effective room set.
  //
  //   Stage 2: bipartite matching for the rest. Build a bipartite graph
  //   (sessions ↔ rooms) where edges encode eligibility:
  //     - Pinned: single edge to the pinned room.
  //     - Tag-constrained (room_requirements non-empty): edges to rooms
  //       whose tag set is a superset of the requirements.
  //     - Unconstrained: edges to every room.
  //   Then run Kuhn's algorithm (augmenting-path bipartite matching),
  //   processing sessions in popularity desc order and rooms in capacity
  //   desc order. The matching is *optimal*: if any feasible top-N → room
  //   assignment exists, the algorithm finds one. Augmenting paths swap
  //   earlier assignments around when a constrained session needs a room
  //   already claimed by a flexible one — so unconstrained sessions step
  //   aside automatically. Pins are processed first (in stage 2 they're
  //   matched before tag-constrained / unconstrained sessions touch the
  //   graph), so a tag-constrained session can never displace a pin.
  //
  //   Unmatched top-N sessions surface as `unsatisfiable_requirements`
  //   conflicts, with `candidate_room_names` listing the rooms whose tags
  //   match (so the mod sees whether the issue is "no matching room
  //   exists" vs "all matching rooms are already claimed").
  const roomById = new Map<number, { id: number; name: string; capacity: number }>();
  for (const r of rooms) roomById.set(r.id, r);
  const conflicts: PreAssignmentConflict[] = [];
  const preAssignments = new Map<number, number>(); // submissionId -> roomId
  {
    const groupedByRoom = new Map<number, { id: number; title: string }[]>();
    const outOfScope = new Map<number, { roomName: string | null; subs: { id: number; title: string }[] }>();
    for (const s of topNSubs) {
      if (s.preAssignedRoomId === null) continue;
      const room = roomById.get(s.preAssignedRoomId);
      if (!room) {
        const cur = outOfScope.get(s.preAssignedRoomId)
          ?? { roomName: null, subs: [] as { id: number; title: string }[] };
        cur.subs.push({ id: s.id, title: s.title });
        outOfScope.set(s.preAssignedRoomId, cur);
        continue;
      }
      const arr = groupedByRoom.get(s.preAssignedRoomId) ?? [];
      arr.push({ id: s.id, title: s.title });
      groupedByRoom.set(s.preAssignedRoomId, arr);
    }
    if (outOfScope.size > 0) {
      const ids = [...outOfScope.keys()];
      const extraRooms = await prisma.room.findMany({
        where: { id: { in: ids }, conferenceId: confId },
        select: { id: true, name: true },
      });
      for (const r of extraRooms) {
        const e = outOfScope.get(r.id);
        if (e) e.roomName = r.name;
      }
      for (const [roomId, e] of outOfScope) {
        conflicts.push({
          kind: "out_of_scope",
          room_id: roomId,
          room_name: e.roomName ?? "(unknown room)",
          submissions: e.subs.sort((a, b) => a.id - b.id),
        });
      }
    }
    const reservedByPin = new Set<number>();
    for (const [roomId, subs] of groupedByRoom) {
      if (subs.length > 1) {
        conflicts.push({
          kind: "duplicate_room",
          room_id: roomId,
          room_name: roomById.get(roomId)!.name,
          submissions: subs.sort((a, b) => a.id - b.id),
        });
      } else {
        preAssignments.set(subs[0]!.id, roomId);
        reservedByPin.add(roomId);
      }
    }
    if (conflicts.length > 0) {
      conflicts.sort((a, b) => {
        if (a.kind !== b.kind) return a.kind === "duplicate_room" ? -1 : 1;
        // Both are duplicate_room or both out_of_scope — sort by room_id for stability.
        if (a.kind !== "unsatisfiable_requirements" && b.kind !== "unsatisfiable_requirements") {
          return a.room_id - b.room_id;
        }
        return 0;
      });
      return { kind: "conflict" as const, conflicts };
    }

    // ----- Stage 2: bipartite matching with up-front cascade analysis -----
    //
    // Only sessions with explicit room constraints (a pin or a non-empty
    // room_requirements set) participate in bipartite matching. Pins are
    // handled in stage 1 above (their rooms are already reserved); here we
    // match tag-constrained sessions to remaining rooms via Kuhn's
    // algorithm. Unconstrained sessions don't enter the matching — they
    // would let augmenting paths displace more-popular sessions from
    // preferred rooms. They're placed later by the existing star →
    // largest-room zip on leftover rooms.
    //
    // **Cascade analysis (the "up-front" part):** when a top-N constrained
    // session can't be matched (its required tags aren't satisfiable given
    // current room reservations), we record the conflict, drop the session
    // from the trial top-N, and pull in the next-most-starred eligible
    // candidate to refill the cut. Then we re-run the matching. We keep
    // cascading until either every constrained session in the trial top-N
    // is matched OR we've exhausted the candidate list. The mod sees ALL
    // sessions that would have conflicted in one comprehensive resolve
    // panel — no need to resolve, re-run, resolve again.
    //
    // Load room tags for rooms in scope.
    const roomTagsRows = rooms.length === 0
      ? []
      : await prisma.roomTag.findMany({
          where: { roomId: { in: rooms.map((r) => r.id) } },
          select: { roomId: true, value: true },
        });
    const tagsByRoom = new Map<number, Set<string>>();
    for (const r of rooms) tagsByRoom.set(r.id, new Set());
    for (const row of roomTagsRows) tagsByRoom.get(row.roomId)!.add(row.value);

    function roomSatisfies(roomId: number, requirements: string[]): boolean {
      if (requirements.length === 0) return true;
      const tags = tagsByRoom.get(roomId)!;
      for (const req of requirements) if (!tags.has(req)) return false;
      return true;
    }
    const roomsByCapacity = [...rooms].sort((a, b) =>
      a.capacity !== b.capacity ? b.capacity - a.capacity : a.id - b.id,
    );

    // Pre-compute eligible/matching rooms for every eligible sub (not just
    // top-N) — cascade may pull anyone in.
    const eligibleRoomsBySub = new Map<number, number[]>();
    const matchingRoomsBySub = new Map<number, number[]>();
    const requirementsBySub = new Map<number, string[]>();
    for (const s of eligibleSubs) {
      const reqs = s.roomRequirements.map((r) => r.value);
      requirementsBySub.set(s.id, reqs);
      const allMatching = roomsByCapacity
        .filter((r) => roomSatisfies(r.id, reqs))
        .map((r) => r.id);
      matchingRoomsBySub.set(s.id, allMatching);
      eligibleRoomsBySub.set(s.id, allMatching.filter((rid) => !reservedByPin.has(rid)));
    }

    function canUse(subId: number, roomId: number): boolean {
      return (eligibleRoomsBySub.get(subId) ?? []).includes(roomId);
    }

    // Cascade loop. `trial` starts as top-N by stars; whenever a constrained
    // session can't match, it's logged as a conflict and replaced by the
    // next candidate from `subsByPopularity`. Iteration cap is generous
    // (every eligible sub could potentially cycle through) — termination
    // is guaranteed because `nextIdx` only advances and we never re-add
    // dropped sessions.
    let trial = [...topNSubs];
    let nextIdx = numPlaced;
    const tagConflictsBySub = new Map<number, PreAssignmentConflict>();
    let matchSub = new Map<number, number>();
    let matchRoom = new Map<number, number>();
    const maxIter = eligibleSubs.length + 2;

    for (let iter = 0; iter < maxIter; iter++) {
      // Filter to constrained-only this iteration. Order doesn't affect the
      // final feasibility (Kuhn's max-matching is order-independent in
      // cardinality); post-processing handles capacity preference below.
      const tagConstrainedTrial = trial.filter(
        (s) => s.preAssignedRoomId === null && s.roomRequirements.length > 0,
      );
      matchSub = new Map();
      matchRoom = new Map();
      function augment(subId: number, visited: Set<number>): boolean {
        const eligible = eligibleRoomsBySub.get(subId) ?? [];
        for (const roomId of eligible) {
          if (visited.has(roomId)) continue;
          visited.add(roomId);
          const cur = matchRoom.get(roomId);
          if (cur === undefined || augment(cur, visited)) {
            matchSub.set(subId, roomId);
            matchRoom.set(roomId, subId);
            return true;
          }
        }
        return false;
      }
      for (const s of tagConstrainedTrial) augment(s.id, new Set());

      const unmatched = tagConstrainedTrial.filter((s) => !matchSub.has(s.id));
      if (unmatched.length === 0) break; // All constrained members of trial fit — done.

      // Record each unmatched session as a tag conflict (first-seen wins;
      // a session can only appear once in `trial` so re-keying is safe).
      for (const u of unmatched) {
        if (!tagConflictsBySub.has(u.id)) {
          const requiredTags = requirementsBySub.get(u.id) ?? [];
          const candidateIds = matchingRoomsBySub.get(u.id) ?? [];
          tagConflictsBySub.set(u.id, {
            kind: "unsatisfiable_requirements",
            submission: { id: u.id, title: u.title },
            required_tags: requiredTags,
            candidate_room_names: candidateIds.map((rid) => roomById.get(rid)!.name),
          });
        }
      }
      // Drop unmatched from trial and refill from `subsByPopularity` if
      // there are more candidates beyond the current top-N cut.
      const unmatchedIds = new Set(unmatched.map((u) => u.id));
      trial = trial.filter((t) => !unmatchedIds.has(t.id));
      let refilled = false;
      while (trial.length < numPlaced && nextIdx < subsByPopularity.length) {
        const next = subsByPopularity[nextIdx++]!;
        if (!unmatchedIds.has(next.id)) {
          trial.push(next);
          refilled = true;
        }
      }
      if (!refilled && trial.length === 0) break;
      // If we couldn't refill (out of candidates) but trial shrunk, continue
      // — the next iteration's matching might succeed on a smaller trial.
      if (!refilled && unmatched.length === 0) break; // defensive: should never hit
    }

    if (tagConflictsBySub.size > 0) {
      // Report all detected conflicts in popularity DESC for stable UI order.
      const sorted = [...tagConflictsBySub.values()].sort((a, b) => {
        if (a.kind !== "unsatisfiable_requirements" || b.kind !== "unsatisfiable_requirements") return 0;
        const sa = starCountBySub.get(a.submission.id) ?? 0;
        const sb = starCountBySub.get(b.submission.id) ?? 0;
        if (sa !== sb) return sb - sa;
        return a.submission.id - b.submission.id;
      });
      return { kind: "conflict" as const, conflicts: sorted };
    }

    // Post-processing swap pass — same as before, on the final matching.
    const matchedConstrained = trial.filter(
      (s) => s.preAssignedRoomId === null && s.roomRequirements.length > 0 && matchSub.has(s.id),
    );
    let swapped = true;
    while (swapped) {
      swapped = false;
      for (let i = 0; i < matchedConstrained.length; i++) {
        for (let j = 0; j < matchedConstrained.length; j++) {
          if (i === j) continue;
          const a = matchedConstrained[i]!;
          const b = matchedConstrained[j]!;
          const aPop = starCountBySub.get(a.id) ?? 0;
          const bPop = starCountBySub.get(b.id) ?? 0;
          if (aPop < bPop) continue;
          if (aPop === bPop && a.id > b.id) continue;
          const ra = matchSub.get(a.id)!;
          const rb = matchSub.get(b.id)!;
          if (roomById.get(rb)!.capacity <= roomById.get(ra)!.capacity) continue;
          if (!canUse(a.id, rb)) continue;
          if (!canUse(b.id, ra)) continue;
          matchSub.set(a.id, rb);
          matchSub.set(b.id, ra);
          matchRoom.set(rb, a.id);
          matchRoom.set(ra, b.id);
          swapped = true;
        }
      }
    }

    // Drain matched sessions into preAssignments.
    for (const [sid, rid] of matchSub) preAssignments.set(sid, rid);

    // Cascade may have promoted candidates outside the original top-N. We
    // need the downstream algorithm to know the final top-N — `trial` is
    // that set. Update `topNSubs` so the unconstrained → leftover-room zip
    // operates on the right pool.
    topNSubs.splice(0, topNSubs.length, ...trial);
  }

  // Build the prior-assignments map the algorithm uses to skip "user already
  // attended this submission in a previous slot."
  //
  // Two independent axes decide which prior UserAssignments count:
  //   - Conference-wide repeats: when the *current* slot has
  //     `unconfAvoidRepeats=true`, prior assignments in NON-sibling slots
  //     are included (the existing default).
  //   - Cross-sibling repeats: when the current slot belongs to a series
  //     and that series has `avoidRepeatsAcrossSiblings=true`, prior
  //     assignments in SIBLING slots are included.
  //
  // The two flags are independent, so the four combinations cover every
  // case mods asked for: full conference-wide avoid + sibling avoid
  // (workshop repeated for capacity); conference-wide off + sibling on
  // (only series-local rotation); conference-wide on + sibling off
  // (sibling-exempt — "open discussion runs 3x, you can attend all 3");
  // both off (do not avoid anything).
  const siblingSlotIds = cfg.series
    ? (await prisma.agendaSlot.findMany({
        where: { seriesId: cfg.series.id, id: { not: slotId } },
        select: { id: true },
      })).map((s) => s.id)
    : [];
  const siblingSet = new Set(siblingSlotIds);
  const conferenceWideAvoid = cfg.unconfAvoidRepeats;
  const acrossSiblingsAvoid = cfg.series?.avoidRepeatsAcrossSiblings ?? false;

  // Two sources contribute to prior attendance:
  //   1. Explicit UserAssignment rows in non-current unconference slots
  //      (the original source).
  //   2. Derived planned-track attendance (Path C): every TrackAssignment in
  //      a non-current slot contributes (userId, submissionId) tuples for
  //      every starring user, the submitter, and — when mandatory — every
  //      conference identity. Without this, a starred planned-track session
  //      wouldn't count toward avoid-repeats for cross-slot rotation.
  const [prior, priorTracks] = await Promise.all([
    prisma.userAssignment.findMany({
      where: {
        slot: { conferenceId: confId, type: "unconference", id: { not: slotId } },
        submissionId: { not: null },
      },
      select: { userId: true, submissionId: true, slotId: true },
    }),
    prisma.trackAssignment.findMany({
      where: { slot: { conferenceId: confId, id: { not: slotId } } },
      select: {
        slotId: true, submissionId: true, mandatory: true,
        submission: { select: { submitterId: true } },
      },
    }),
  ]);
  const priorAssignments = new Map<number, Set<number>>();
  function recordPrior(userId: number, submissionId: number, fromSlotId: number) {
    const isSibling = siblingSet.has(fromSlotId);
    const include = isSibling ? acrossSiblingsAvoid : conferenceWideAvoid;
    if (!include) return;
    let set = priorAssignments.get(userId);
    if (!set) { set = new Set(); priorAssignments.set(userId, set); }
    set.add(submissionId);
  }
  for (const p of prior) {
    if (p.submissionId === null) continue;
    recordPrior(p.userId, p.submissionId, p.slotId);
  }
  // Derive star + submitter + mandatory contributors from prior planned tracks.
  // Only fetch stars / identities when there's actually planned-track history
  // AND at least one avoid axis is on (otherwise the data is thrown away).
  const anyAvoid = conferenceWideAvoid || acrossSiblingsAvoid;
  if (anyAvoid && priorTracks.length > 0) {
    const priorSubIds = [...new Set(priorTracks.map((t) => t.submissionId))];
    const hasMandatoryPrior = priorTracks.some((t) => t.mandatory);
    const [priorStarRows, mandatoryIdentities] = await Promise.all([
      prisma.star.findMany({
        where: { submissionId: { in: priorSubIds } },
        select: { userId: true, submissionId: true },
      }),
      hasMandatoryPrior
        ? prisma.conferenceIdentity.findMany({
            where: { conferenceId: confId }, select: { id: true },
          })
        : Promise.resolve([] as { id: number }[]),
    ]);
    // Map submission -> [slotIds where it's tracked] so we can attribute each
    // (userId, submissionId) pair to the right slot for sibling-axis filtering.
    const subToSlotIds = new Map<number, number[]>();
    for (const t of priorTracks) {
      const arr = subToSlotIds.get(t.submissionId) ?? [];
      arr.push(t.slotId);
      subToSlotIds.set(t.submissionId, arr);
    }
    // Stars: every starring user attends every tracked offering of the sub.
    for (const s of priorStarRows) {
      const slots = subToSlotIds.get(s.submissionId);
      if (!slots) continue;
      for (const sid of slots) recordPrior(s.userId, s.submissionId, sid);
    }
    // Submitter: derived per track row directly.
    for (const t of priorTracks) {
      recordPrior(t.submission.submitterId, t.submissionId, t.slotId);
    }
    // Mandatory: every identity attends every mandatory track.
    if (hasMandatoryPrior) {
      for (const t of priorTracks) {
        if (!t.mandatory) continue;
        for (const i of mandatoryIdentities) {
          recordPrior(i.id, t.submissionId, t.slotId);
        }
      }
    }
  }

  const manualRows = await prisma.userAssignment.findMany({
    where: { slotId, manual: true, submissionId: { not: null } },
    select: { userId: true, submissionId: true },
  });
  const fixedAssignments = new Map<number, number>();
  for (const m of manualRows) {
    if (m.submissionId !== null) fixedAssignments.set(m.userId, m.submissionId);
  }

  // The cascade analysis above may have replaced top-N members; pass the
  // final (post-cascade) set as the algorithm's submission pool so its
  // internal top-N selection matches the route's decisions and every
  // pre-assignment lands in a session it expects to place.
  const input: AssignmentInput = {
    rooms: rooms.map((r) => ({ id: r.id, capacity: r.capacity })),
    submissions: topNSubs.map((s) => ({ id: s.id, submitter_id: s.submitterId })),
    stars, priorAssignments,
    // The algorithm only consults `priorAssignments` when this is true. We
    // pre-filtered the map per-axis above, so passing true whenever either
    // axis wants avoidance yields the right behaviour with an empty map
    // (no-op) when neither does.
    avoidRepeats: conferenceWideAvoid || acrossSiblingsAvoid,
    fixedAssignments,
    preAssignments,
  };
  const result = assignUnconferenceSlot(input);

  const roomBySubmission = new Map<number, number>();
  for (const p of result.placements) roomBySubmission.set(p.submission_id, p.room_id);
  const honoredManual = new Set<number>();
  for (const a of result.user_assignments) {
    if (fixedAssignments.get(a.user_id) === a.submission_id) honoredManual.add(a.user_id);
  }

  await prisma.$transaction([
    prisma.unconferencePlacement.deleteMany({ where: { slotId } }),
    prisma.userAssignment.deleteMany({ where: { slotId } }),
    prisma.unconferencePlacement.createMany({
      data: result.placements.map((p) => ({
        slotId, submissionId: p.submission_id, roomId: p.room_id,
      })),
    }),
    prisma.userAssignment.createMany({
      data: result.user_assignments.map((a) => ({
        slotId, userId: a.user_id, submissionId: a.submission_id,
        roomId: roomBySubmission.get(a.submission_id) ?? null,
        manual: honoredManual.has(a.user_id),
      })),
    }),
  ]);

  return {
    placements: result.placements.map((p) => ({ ...p, slot_id: slotId })),
    user_assignments: result.user_assignments.map((a) => ({ ...a, slot_id: slotId })),
    unplaced_users: result.unplaced_users,
    overlap_exclusions: {
      rooms: overlapExcludedRooms,
      submissions: overlapExcludedSubs,
      user_ids: [...busyUserIds].sort((a, b) => a - b),
    },
  };
}

async function runMixerForSlot(prisma: PrismaClient, confId: number, slotId: number) {
  const slot = await prisma.agendaSlot.findUniqueOrThrow({
    where: { id: slotId },
    include: SLOT_CONFIG_INCLUDE,
  });
  const cfg = effectiveSlotConfig(slot);
  const conf = await prisma.conference.findUniqueOrThrow({
    where: { id: confId },
    select: { mixerAvoidRepeatsDefault: true },
  });

  const roomWhere = cfg.unconfUseAllRooms
    ? { conferenceId: confId }
    : { conferenceId: confId, id: { in: cfg.roomIds } };
  let rooms = await prisma.room.findMany({
    where: roomWhere, select: { id: true, capacity: true, name: true },
  });
  const identityRows = await prisma.conferenceIdentity.findMany({
    where: { conferenceId: confId }, select: { id: true },
  });

  // ----- Overlap exclusions (mixer) --------------------------------------
  //
  // Mixers have no sessions, so only the room (a) and participant (d)
  // overlap rules apply. We drop rooms used by overlapping slots and
  // exclude participants already assigned in overlapping slots.
  const busyUserIds = new Set<number>();
  const overlapExcludedRooms: { id: number; name: string }[] = [];
  {
    const overlappingSlots = await prisma.agendaSlot.findMany({
      where: {
        conferenceId: confId,
        id: { not: slotId },
        startsAt: { lt: slot.endsAt },
        endsAt: { gt: slot.startsAt },
      },
      select: { id: true },
    });
    const overlappingIds = overlappingSlots.map((s) => s.id);
    if (overlappingIds.length > 0) {
      const [overlapPlacements, overlapTracks, overlapAssigns] = await Promise.all([
        prisma.unconferencePlacement.findMany({
          where: { slotId: { in: overlappingIds } },
          select: { roomId: true },
        }),
        prisma.trackAssignment.findMany({
          where: { slotId: { in: overlappingIds } },
          select: { roomId: true },
        }),
        prisma.userAssignment.findMany({
          where: { slotId: { in: overlappingIds } },
          select: { userId: true, roomId: true },
        }),
      ]);
      const excludedRoomIds = new Set<number>();
      for (const p of overlapPlacements) excludedRoomIds.add(p.roomId);
      for (const t of overlapTracks) excludedRoomIds.add(t.roomId);
      for (const a of overlapAssigns) {
        busyUserIds.add(a.userId);
        if (a.roomId !== null) excludedRoomIds.add(a.roomId);
      }
      const roomNameById = new Map(rooms.map((r) => [r.id, r.name]));
      rooms = rooms.filter((r) => {
        if (excludedRoomIds.has(r.id)) {
          overlapExcludedRooms.push({ id: r.id, name: roomNameById.get(r.id) ?? "" });
          return false;
        }
        return true;
      });
    }
  }
  // Drop busy participants — they're already in an overlapping slot.
  const eligibleUserIds = identityRows
    .map((i) => i.id)
    .filter((id) => !busyUserIds.has(id));

  // Pairing avoidance has the same two independent axes as unconference
  // avoid-repeats (see runAssignmentForSlot for the rationale):
  //   - Conference-wide: when *this* slot is exclusive, gather pairings
  //     from every other exclusive mixer EXCEPT siblings.
  //   - Cross-sibling: when this slot's series has
  //     `avoidRepeatsAcrossSiblings=true`, gather pairings from every
  //     sibling regardless of each sibling's own `mixerAvoidRepeats`
  //     (the series-level opt-in trumps the per-slot setting for siblings).
  // "Other" still excludes this slot itself so re-running doesn't avoid
  // its own pairings.
  const conferenceWideAvoid = cfg.mixerAvoidRepeats ?? conf.mixerAvoidRepeatsDefault;
  const siblingSlotIds = cfg.series
    ? (await prisma.agendaSlot.findMany({
        where: { seriesId: cfg.series.id, id: { not: slotId } },
        select: { id: true },
      })).map((s) => s.id)
    : [];
  const siblingSet = new Set(siblingSlotIds);
  const acrossSiblingsAvoid = cfg.series?.avoidRepeatsAcrossSiblings ?? false;

  let priorPairings: Set<string> | undefined;
  if (conferenceWideAvoid || (acrossSiblingsAvoid && siblingSlotIds.length > 0)) {
    // Filtering on `type: "mixer"` against the slot column is safe because
    // `type` is immutable per series — a sibling of a mixer series has
    // `slot.type === "mixer"` set at duplicate time.
    const otherMixers = await prisma.agendaSlot.findMany({
      where: {
        conferenceId: confId,
        type: "mixer",
        id: { not: slotId },
      },
      select: {
        id: true,
        mixerAvoidRepeats: true,
        series: { select: { mixerAvoidRepeats: true } },
      },
    });
    const exclusiveSlotIds = otherMixers
      .filter((m) => {
        const isSibling = siblingSet.has(m.id);
        if (isSibling) {
          // Siblings are included when the series opts in, regardless of
          // each sibling's own mixerAvoidRepeats setting.
          return acrossSiblingsAvoid;
        }
        if (!conferenceWideAvoid) return false;
        const eff = m.series ? m.series.mixerAvoidRepeats : m.mixerAvoidRepeats;
        return eff ?? conf.mixerAvoidRepeatsDefault;
      })
      .map((m) => m.id);
    priorPairings = new Set<string>();
    if (exclusiveSlotIds.length > 0) {
      const priorAssigns = await prisma.userAssignment.findMany({
        where: { slotId: { in: exclusiveSlotIds }, roomId: { not: null } },
        select: { slotId: true, userId: true, roomId: true },
      });
      const byRoom = new Map<string, number[]>();
      for (const a of priorAssigns) {
        const key = `${a.slotId}:${a.roomId}`;
        const arr = byRoom.get(key) ?? [];
        arr.push(a.userId);
        byRoom.set(key, arr);
      }
      for (const [, users] of byRoom) {
        for (let i = 0; i < users.length; i++) {
          for (let j = i + 1; j < users.length; j++) {
            priorPairings.add(pairKey(users[i]!, users[j]!));
          }
        }
      }
    }
  }

  const result = assignMixerSlot({
    rooms: rooms.map((r) => ({ id: r.id, capacity: r.capacity })),
    userIds: eligibleUserIds, seed: slotId, priorPairings,
  });

  await prisma.$transaction([
    prisma.unconferencePlacement.deleteMany({ where: { slotId } }),
    prisma.userAssignment.deleteMany({ where: { slotId } }),
    prisma.userAssignment.createMany({
      data: result.room_assignments.map((a) => ({
        slotId, userId: a.user_id, submissionId: null, roomId: a.room_id,
      })),
    }),
  ]);

  return {
    room_assignments: result.room_assignments.map((a) => ({ ...a, slot_id: slotId })),
    unplaced_users: result.unplaced_users,
    overlap_exclusions: {
      rooms: overlapExcludedRooms,
      submissions: [],
      user_ids: [...busyUserIds].sort((a, b) => a - b),
    },
  };
}

// Series-with-its-rooms-and-submissions, the input shape both snapshot
// helpers below need. We pre-load it once at the call site to avoid
// re-fetching inside each per-member loop iteration.
type SeriesSnapshot = {
  id: number;
  unconfUseAllRooms: boolean;
  unconfUseAllSubmissions: boolean;
  unconfAvoidRepeats: boolean;
  mixerAvoidRepeats: boolean | null;
  selectedRooms: { roomId: number }[];
  selectedSubmissions: { submissionId: number }[];
};

// Copy a series's resolved config onto a member slot's own columns +
// SlotRoom/SlotSubmission rows. The caller is responsible for clearing
// the slot's `seriesId` (or for the caller's transaction to do so), since
// the same helper is reused by deleteSeries / detachSeries / auto-detach.
async function snapshotSeriesOntoSlot(
  tx: Prisma.TransactionClient,
  series: SeriesSnapshot,
  slotId: number,
) {
  await tx.agendaSlot.update({
    where: { id: slotId },
    data: {
      seriesId: null,
      unconfUseAllRooms: series.unconfUseAllRooms,
      unconfUseAllSubmissions: series.unconfUseAllSubmissions,
      unconfAvoidRepeats: series.unconfAvoidRepeats,
      mixerAvoidRepeats: series.mixerAvoidRepeats,
    },
  });
  await tx.slotRoom.deleteMany({ where: { slotId } });
  if (series.selectedRooms.length > 0) {
    await tx.slotRoom.createMany({
      data: series.selectedRooms.map((r) => ({ slotId, roomId: r.roomId })),
    });
  }
  await tx.slotSubmission.deleteMany({ where: { slotId } });
  if (series.selectedSubmissions.length > 0) {
    await tx.slotSubmission.createMany({
      data: series.selectedSubmissions.map((s) => ({ slotId, submissionId: s.submissionId })),
    });
  }
}

// Called after any sibling removal (deleteSlot on a series member, the
// user-initiated detach in detachSeries). A series with 0 or 1 members is
// pointless — the badge would read "Offering 1 of 1" and the series form
// would offer to edit a "shared" config that's really only used by one
// slot. We dissolve in that case: snapshot the series config onto the
// lone survivor (so its behaviour is preserved) and delete the series.
async function maybeAutoDetachSingleton(prisma: PrismaClient, seriesId: number) {
  const series = await prisma.slotSeries.findUnique({
    where: { id: seriesId },
    include: {
      slots: { select: { id: true } },
      selectedRooms: { select: { roomId: true } },
      selectedSubmissions: { select: { submissionId: true } },
    },
  });
  if (!series) return;
  if (series.slots.length > 1) return;
  await prisma.$transaction(async (tx) => {
    if (series.slots.length === 1) {
      await snapshotSeriesOntoSlot(tx, series, series.slots[0]!.id);
    }
    await tx.slotSeries.delete({ where: { id: series.id } });
  });
}

export const agendaRouter = {
  get: requireConf("participant").agenda.get.handler(async ({ context }) => {
    const confId = context.conferenceId;
    const userId = actorIdentityId(context);
    const [slots, series, tracks, placements, myStars, mixerAssigns, unconfCounts, conf] = await Promise.all([
      // Every slot is read with its series + own join rows so
      // `effectiveSlotConfig` can resolve which side owns each field. No
      // separate SlotRoom/SlotSubmission scan is needed — the include covers
      // both sides at once.
      context.prisma.agendaSlot.findMany({
        where: { conferenceId: confId }, orderBy: { startsAt: "asc" },
        include: SLOT_CONFIG_INCLUDE,
      }),
      // Surface every series in the conference so the client can render
      // "offering 2 of 3" badges and route series-level edits.
      context.prisma.slotSeries.findMany({
        where: { conferenceId: confId },
        include: {
          selectedRooms: { select: { roomId: true } },
          selectedSubmissions: { select: { submissionId: true } },
          slots: { orderBy: { startsAt: "asc" }, select: { id: true } },
        },
      }),
      // Tracks come with their linked submission so the client can render
      // title + submitter without an extra round-trip, and with a per-track
      // star count derived from the submission's stars (Path C: the planned
      // schedule and the unconference algorithm share one Star table).
      context.prisma.trackAssignment.findMany({
        where: { slot: { conferenceId: confId } },
        include: {
          submission: {
            select: {
              title: true,
              submitterId: true,
              _count: { select: { stars: true } },
            },
          },
          requirements: { select: { value: true }, orderBy: { value: "asc" } },
        },
      }),
      context.prisma.unconferencePlacement.findMany({
        where: { slot: { conferenceId: confId } },
        include: {
          // Demand vs supply signal: total stars on the submission and the
          // assigned room's capacity. Surfaces a "Room may be full" warning
          // when stars exceed capacity (clients render the badge).
          submission: { select: { _count: { select: { stars: true } } } },
          room: { select: { capacity: true } },
        },
      }),
      // Replaces the StaticStar lookup. `starred_by_me` on a Track is now
      // "did the viewer star the linked submission" — no per-track table.
      context.prisma.star.findMany({
        where: { userId, submission: { conferenceId: confId } },
        select: { submissionId: true },
      }),
      context.prisma.userAssignment.groupBy({
        by: ["slotId", "roomId"],
        where: { slot: { conferenceId: confId, type: "mixer" }, roomId: { not: null } },
        _count: { userId: true },
      }),
      context.prisma.userAssignment.groupBy({
        by: ["slotId", "submissionId"],
        where: { slot: { conferenceId: confId, type: "unconference" }, submissionId: { not: null } },
        _count: { userId: true },
      }),
      context.prisma.conference.findUniqueOrThrow({
        where: { id: confId },
        select: { mixerAvoidRepeatsDefault: true },
      }),
    ]);
    const starredSubIds = new Set(myStars.map((s) => s.submissionId));
    const siblingsBySeries = new Map<number, number[]>(
      series.map((s) => [s.id, s.slots.map((x) => x.id)]),
    );
    return {
      slots: slots.map((s) => {
        const eff = effectiveSlotConfig(s);
        const siblings = s.seriesId ? siblingsBySeries.get(s.seriesId) ?? [] : null;
        const offeringIndex = siblings ? siblings.indexOf(s.id) + 1 : null;
        return {
          id: s.id, type: s.type, title: s.title, description: s.description,
          starts_at: s.startsAt.getTime(), ends_at: s.endsAt.getTime(),
          unconf_use_all_rooms: eff.unconfUseAllRooms,
          unconf_use_all_submissions: eff.unconfUseAllSubmissions,
          unconf_avoid_repeats: eff.unconfAvoidRepeats,
          mixer_avoid_repeats: eff.mixerAvoidRepeats,
          mixer_avoid_repeats_effective: eff.mixerAvoidRepeats ?? conf.mixerAvoidRepeatsDefault,
          unconf_room_ids: eff.roomIds,
          unconf_submission_ids: eff.submissionIds,
          series_id: s.seriesId,
          series_offering_index: offeringIndex,
          series_total_offerings: siblings ? siblings.length : null,
        };
      }),
      slot_series: series.map((s) => ({
        id: s.id,
        type: s.type,
        title: s.title,
        description: s.description,
        unconf_use_all_rooms: s.unconfUseAllRooms,
        unconf_use_all_submissions: s.unconfUseAllSubmissions,
        unconf_avoid_repeats: s.unconfAvoidRepeats,
        mixer_avoid_repeats: s.mixerAvoidRepeats,
        avoid_repeats_across_siblings: s.avoidRepeatsAcrossSiblings,
        unconf_room_ids: s.selectedRooms.map((r) => r.roomId),
        unconf_submission_ids: s.selectedSubmissions.map((x) => x.submissionId),
        slot_ids: s.slots.map((x) => x.id),
      })),
      tracks: tracks.map((t) => ({
        id: t.id, slot_id: t.slotId, room_id: t.roomId,
        submission_id: t.submissionId, speakers: t.speakers,
        // Track display name always comes from the linked submission now.
        title: t.submission.title,
        star_count: t.submission._count.stars,
        starred_by_me: starredSubIds.has(t.submissionId),
        requirements: t.requirements.map((r) => r.value),
        mandatory: t.mandatory,
      })),
      placements: placements.map((p) => {
        const count = unconfCounts.find((u) =>
          u.slotId === p.slotId && u.submissionId === p.submissionId)?._count.userId ?? 0;
        return {
          slot_id: p.slotId, submission_id: p.submissionId, room_id: p.roomId,
          attendee_count: count,
          star_count: p.submission._count.stars,
          room_capacity: p.room.capacity,
        };
      }),
      mixer_placements: mixerAssigns
        .filter((m) => m.roomId !== null)
        .map((m) => ({
          slot_id: m.slotId, room_id: m.roomId as number,
          attendee_count: m._count.userId,
        })),
    };
  }),

  createSlot: requireConf("moderator").agenda.createSlot.handler(async ({ input, context }) => {
    // Cross-field check that lived on `CreateSlotSchema` via `v.forward`.
    // It got dropped when we spread the schema entries into the contract
    // (the spread loses the pipe-attached validator); enforced here instead.
    if (input.ends_at <= input.starts_at) {
      throw new ORPCError("BAD_REQUEST", { message: "ends_before_starts" });
    }
    const created = await context.prisma.agendaSlot.create({
      data: {
        conferenceId: context.conferenceId,
        type: input.type,
        title: input.title ?? null,
        description: input.description ?? null,
        startsAt: new Date(clipToMinute(input.starts_at)),
        endsAt: new Date(clipToMinute(input.ends_at)),
        // Only meaningful for mixer slots; harmless null on others.
        mixerAvoidRepeats: input.type === "mixer"
          ? (input.mixer_avoid_repeats ?? null)
          : null,
      },
    });
    return { id: created.id };
  }),

  updateSlot: requireConf("moderator").agenda.updateSlot.handler(async ({ input, context }) => {
    // Same cross-field check as createSlot — only fire when both sides supplied.
    if (input.starts_at !== undefined && input.ends_at !== undefined
        && input.ends_at <= input.starts_at) {
      throw new ORPCError("BAD_REQUEST", { message: "ends_before_starts" });
    }
    const slot = await context.prisma.agendaSlot.findFirst({
      where: { id: input.id, conferenceId: context.conferenceId },
    });
    if (!slot) throw new ORPCError("NOT_FOUND");
    // When the slot belongs to a series, config fields (rooms/submissions
    // pool, avoid-repeats flags, etc.) are series-owned. The mod must route
    // those edits through `agenda.updateSeries`. Per-instance fields
    // (time, title, description) remain editable here.
    if (slot.seriesId !== null) {
      const seriesOwned = (
        input.unconf_use_all_rooms !== undefined
        || input.unconf_use_all_submissions !== undefined
        || input.unconf_avoid_repeats !== undefined
        || input.mixer_avoid_repeats !== undefined
        || input.unconf_room_ids !== undefined
        || input.unconf_submission_ids !== undefined
      );
      if (seriesOwned) {
        throw new ORPCError("BAD_REQUEST", { message: "field_is_series_owned" });
      }
    }
    await context.prisma.$transaction(async (tx) => {
      await tx.agendaSlot.update({
        where: { id: input.id },
        data: {
          title: input.title ?? undefined,
          description: input.description ?? undefined,
          startsAt: input.starts_at ? new Date(clipToMinute(input.starts_at)) : undefined,
          endsAt: input.ends_at ? new Date(clipToMinute(input.ends_at)) : undefined,
          unconfUseAllRooms: input.unconf_use_all_rooms ?? undefined,
          unconfUseAllSubmissions: input.unconf_use_all_submissions ?? undefined,
          unconfAvoidRepeats: input.unconf_avoid_repeats ?? undefined,
          // Distinguish "not in the patch" from "explicit null (inherit)".
          // `mixer_avoid_repeats` is the only nullable field on this update.
          mixerAvoidRepeats: input.mixer_avoid_repeats === undefined
            ? undefined
            : input.mixer_avoid_repeats,
        },
      });
      if (input.unconf_room_ids !== undefined) {
        const validRooms = await tx.room.findMany({
          where: { conferenceId: context.conferenceId, id: { in: input.unconf_room_ids } },
          select: { id: true },
        });
        const ok = new Set(validRooms.map((r) => r.id));
        await tx.slotRoom.deleteMany({ where: { slotId: input.id } });
        if (ok.size > 0) {
          await tx.slotRoom.createMany({
            data: [...ok].map((roomId) => ({ slotId: input.id, roomId })),
          });
        }
      }
      if (input.unconf_submission_ids !== undefined) {
        const validSubs = await tx.submission.findMany({
          where: { conferenceId: context.conferenceId, id: { in: input.unconf_submission_ids } },
          select: { id: true },
        });
        const ok = new Set(validSubs.map((s) => s.id));
        await tx.slotSubmission.deleteMany({ where: { slotId: input.id } });
        if (ok.size > 0) {
          await tx.slotSubmission.createMany({
            data: [...ok].map((submissionId) => ({ slotId: input.id, submissionId })),
          });
        }
      }
    });
    return { ok: true as const };
  }),

  deleteSlot: requireConf("moderator").agenda.deleteSlot.handler(async ({ input, context }) => {
    // Look up the slot's series link first — after deletion we may need to
    // collapse the series if only one member remains (a "series of one" is
    // just a standalone slot in disguise; keeping the wrapper around is
    // pointless and surfaces a noisy "Offering 1 of 1" badge).
    const slot = await context.prisma.agendaSlot.findFirst({
      where: { id: input.id, conferenceId: context.conferenceId },
      select: { id: true, seriesId: true },
    });
    if (!slot) return { ok: true as const };
    await context.prisma.agendaSlot.delete({ where: { id: slot.id } });
    if (slot.seriesId !== null) {
      await maybeAutoDetachSingleton(context.prisma, slot.seriesId);
    }
    return { ok: true as const };
  }),

  duplicateSlot: requireConf("moderator").agenda.duplicateSlot.handler(async ({ input, context }) => {
    if (input.new_ends_at <= input.new_starts_at) {
      throw new ORPCError("BAD_REQUEST", { message: "ends_before_starts" });
    }
    const source = await context.prisma.agendaSlot.findFirst({
      where: { id: input.id, conferenceId: context.conferenceId },
      include: {
        selectedRooms: { select: { roomId: true } },
        selectedSubmissions: { select: { submissionId: true } },
        // Planned slots carry their schedule content in TrackAssignment
        // rows (one per room/track). For a duplicate to be useful — same
        // workshop running twice, same keynote across two timeslots — we
        // copy those rows onto the new sibling. Unconference / mixer slots
        // have no tracks; the include just returns an empty array.
        trackAssignments: {
          include: { requirements: { select: { value: true } } },
        },
      },
    });
    if (!source) throw new ORPCError("NOT_FOUND");

    const result = await context.prisma.$transaction(async (tx) => {
      let seriesId = source.seriesId;
      if (seriesId === null) {
        // Bootstrap a series rooted at the source's current config. The
        // series now owns these fields; the source slot's own columns and
        // SlotRoom/SlotSubmission rows are left in place but stop being
        // read (the resolver routes through the series).
        const created = await tx.slotSeries.create({
          data: {
            conferenceId: context.conferenceId,
            type: source.type,
            title: source.title,
            description: source.description,
            unconfUseAllRooms: source.unconfUseAllRooms,
            unconfUseAllSubmissions: source.unconfUseAllSubmissions,
            unconfAvoidRepeats: source.unconfAvoidRepeats,
            mixerAvoidRepeats: source.mixerAvoidRepeats,
            // avoidRepeatsAcrossSiblings defaults to true — matches the
            // common case where each session in the duplicated block should
            // only land on a given attendee's schedule once.
          },
        });
        seriesId = created.id;
        if (source.selectedRooms.length > 0) {
          await tx.seriesRoom.createMany({
            data: source.selectedRooms.map((r) => ({ seriesId: seriesId!, roomId: r.roomId })),
          });
        }
        if (source.selectedSubmissions.length > 0) {
          await tx.seriesSubmission.createMany({
            data: source.selectedSubmissions.map((s) => ({ seriesId: seriesId!, submissionId: s.submissionId })),
          });
        }
        await tx.agendaSlot.update({
          where: { id: source.id }, data: { seriesId },
        });
      }
      // The new sibling carries only per-instance fields + the FK back to
      // the series. Its `type` is copied because `type` is treated as
      // immutable per series (SQL filters against agenda_slots.type need to
      // stay correct without a join). Every other config field is left at
      // schema default and ignored by the resolver while seriesId is set.
      const sibling = await tx.agendaSlot.create({
        data: {
          conferenceId: context.conferenceId,
          seriesId,
          type: source.type,
          title: input.title ?? source.title,
          description: source.description,
          startsAt: new Date(clipToMinute(input.new_starts_at)),
          endsAt: new Date(clipToMinute(input.new_ends_at)),
        },
      });
      // Copy each TrackAssignment onto the sibling, preserving the linked
      // submission, optional addendum speakers, and mandatory flag.
      // Per-user stars are not copied — under Path C they live on the
      // Submission (not the Track), so the sibling automatically appears on
      // every starred-by-user MyAssignments via the derivation rule.
      // We create rows one at a time (instead of `createMany`) so we can
      // pick up each new row's id to attach its TrackRequirement children.
      for (const src of source.trackAssignments) {
        const copy = await tx.trackAssignment.create({
          data: {
            slotId: sibling.id,
            roomId: src.roomId,
            submissionId: src.submissionId,
            speakers: src.speakers,
            mandatory: src.mandatory,
          },
          select: { id: true },
        });
        if (src.requirements.length > 0) {
          await tx.trackRequirement.createMany({
            data: src.requirements.map((r) => ({ trackId: copy.id, value: r.value })),
          });
        }
      }
      return { slotId: sibling.id, seriesId: seriesId! };
    });

    return { slot_id: result.slotId, series_id: result.seriesId };
  }),

  updateSeries: requireConf("moderator").agenda.updateSeries.handler(async ({ input, context }) => {
    const series = await context.prisma.slotSeries.findFirst({
      where: { id: input.id, conferenceId: context.conferenceId },
      include: {
        slots: { select: { id: true } },
        selectedRooms: { select: { roomId: true } },
        selectedSubmissions: { select: { submissionId: true } },
      },
    });
    if (!series) throw new ORPCError("NOT_FOUND");

    const memberSlotIds = series.slots.map((s) => s.id);

    // Compute pool diffs to identify what would be orphaned. We only need
    // to check track assignments + placements when a pool field is being
    // tightened (use-all flipped off, or items removed from the explicit
    // list). When use-all is staying on, no rooms or submissions can be
    // dropped, so no orphans are possible.
    const nextUseAllRooms = input.unconf_use_all_rooms ?? series.unconfUseAllRooms;
    const nextUseAllSubs  = input.unconf_use_all_submissions ?? series.unconfUseAllSubmissions;
    const nextRoomIds = input.unconf_room_ids ?? series.selectedRooms.map((r) => r.roomId);
    const nextSubIds  = input.unconf_submission_ids ?? series.selectedSubmissions.map((s) => s.submissionId);

    let orphanedTrackIds: number[] = [];
    let orphanedPlacementKeys: { slotId: number; submissionId: number }[] = [];
    let removedRoomIds: number[] = [];
    let removedSubmissionIds: number[] = [];

    if (memberSlotIds.length > 0) {
      // Track assignments live on AgendaSlot via roomId + submissionId. They
      // become orphans when their room or submission falls out of the
      // narrowed pool. Same for unconference placements.
      if (!nextUseAllRooms) {
        const okRooms = new Set(nextRoomIds);
        const prevRooms = new Set(series.selectedRooms.map((r) => r.roomId));
        // When use-all flipped from true → false, *every* room not in
        // nextRoomIds is "removed." When the list narrowed in place,
        // removed = prev \ next.
        if (series.unconfUseAllRooms) {
          // Can't list all conference rooms cheaply without an extra query;
          // any track/placement with a roomId not in okRooms is orphaned.
          const tracks = await context.prisma.trackAssignment.findMany({
            where: { slotId: { in: memberSlotIds }, NOT: { roomId: { in: nextRoomIds } } },
            select: { id: true, roomId: true },
          });
          orphanedTrackIds = tracks.map((t) => t.id);
          const places = await context.prisma.unconferencePlacement.findMany({
            where: { slotId: { in: memberSlotIds }, NOT: { roomId: { in: nextRoomIds } } },
            select: { slotId: true, submissionId: true, roomId: true },
          });
          orphanedPlacementKeys = places.map((p) => ({ slotId: p.slotId, submissionId: p.submissionId }));
          removedRoomIds = [...new Set([...tracks.map((t) => t.roomId), ...places.map((p) => p.roomId)])];
        } else {
          const dropped = [...prevRooms].filter((id) => !okRooms.has(id));
          if (dropped.length > 0) {
            const tracks = await context.prisma.trackAssignment.findMany({
              where: { slotId: { in: memberSlotIds }, roomId: { in: dropped } },
              select: { id: true },
            });
            orphanedTrackIds = tracks.map((t) => t.id);
            const places = await context.prisma.unconferencePlacement.findMany({
              where: { slotId: { in: memberSlotIds }, roomId: { in: dropped } },
              select: { slotId: true, submissionId: true },
            });
            orphanedPlacementKeys = places.map((p) => ({ slotId: p.slotId, submissionId: p.submissionId }));
            removedRoomIds = dropped;
          }
        }
      }
      if (!nextUseAllSubs) {
        const okSubs = new Set(nextSubIds);
        const prevSubs = new Set(series.selectedSubmissions.map((s) => s.submissionId));
        if (series.unconfUseAllSubmissions) {
          const tracks = await context.prisma.trackAssignment.findMany({
            where: {
              slotId: { in: memberSlotIds },
              NOT: { submissionId: { in: nextSubIds } },
            },
            select: { id: true, submissionId: true },
          });
          orphanedTrackIds = [...new Set([...orphanedTrackIds, ...tracks.map((t) => t.id)])];
          const places = await context.prisma.unconferencePlacement.findMany({
            where: { slotId: { in: memberSlotIds }, NOT: { submissionId: { in: nextSubIds } } },
            select: { slotId: true, submissionId: true },
          });
          orphanedPlacementKeys = [
            ...orphanedPlacementKeys,
            ...places.map((p) => ({ slotId: p.slotId, submissionId: p.submissionId })),
          ];
          removedSubmissionIds = [...new Set([
            ...tracks.map((t) => t.submissionId),
            ...places.map((p) => p.submissionId),
          ])];
        } else {
          const dropped = [...prevSubs].filter((id) => !okSubs.has(id));
          if (dropped.length > 0) {
            const tracks = await context.prisma.trackAssignment.findMany({
              where: { slotId: { in: memberSlotIds }, submissionId: { in: dropped } },
              select: { id: true },
            });
            orphanedTrackIds = [...new Set([...orphanedTrackIds, ...tracks.map((t) => t.id)])];
            const places = await context.prisma.unconferencePlacement.findMany({
              where: { slotId: { in: memberSlotIds }, submissionId: { in: dropped } },
              select: { slotId: true, submissionId: true },
            });
            orphanedPlacementKeys = [
              ...orphanedPlacementKeys,
              ...places.map((p) => ({ slotId: p.slotId, submissionId: p.submissionId })),
            ];
            removedSubmissionIds = dropped;
          }
        }
      }
    }

    if ((orphanedTrackIds.length > 0 || orphanedPlacementKeys.length > 0) && !input.confirm) {
      // UserAssignments hang off both tracks and placements, but participant-
      // schedule rows derived from them get cleaned up implicitly when we
      // delete the parent (no FK cascade — handled below in the apply path).
      // We surface a precise count for the confirm dialog.
      const userAssignCount = await context.prisma.userAssignment.count({
        where: {
          slotId: { in: memberSlotIds },
          OR: [
            ...(orphanedPlacementKeys.length > 0
              ? [{ OR: orphanedPlacementKeys.map(({ slotId, submissionId }) => ({ slotId, submissionId })) }]
              : []),
          ],
        },
      });
      return {
        kind: "needs_confirmation" as const,
        removed_track_assignments: orphanedTrackIds.length,
        removed_unconference_placements: orphanedPlacementKeys.length,
        removed_user_assignments: userAssignCount,
        removed_room_ids: removedRoomIds,
        removed_submission_ids: removedSubmissionIds,
      };
    }

    // Apply the patch: write SlotSeries + replace its join tables. The
    // resolver (effectiveSlotConfig) routes every read through these rows
    // for series members, so no per-slot propagation is needed — the slots'
    // own columns and SlotRoom/SlotSubmission stay where they were (stale
    // and unread until/unless the slot is detached).
    await context.prisma.$transaction(async (tx) => {
      await tx.slotSeries.update({
        where: { id: series.id },
        data: {
          title: input.title ?? undefined,
          description: input.description ?? undefined,
          unconfUseAllRooms: input.unconf_use_all_rooms ?? undefined,
          unconfUseAllSubmissions: input.unconf_use_all_submissions ?? undefined,
          unconfAvoidRepeats: input.unconf_avoid_repeats ?? undefined,
          mixerAvoidRepeats: input.mixer_avoid_repeats === undefined
            ? undefined
            : input.mixer_avoid_repeats,
          avoidRepeatsAcrossSiblings: input.avoid_repeats_across_siblings ?? undefined,
        },
      });

      if (input.unconf_room_ids !== undefined) {
        const validRooms = await tx.room.findMany({
          where: { conferenceId: context.conferenceId, id: { in: input.unconf_room_ids } },
          select: { id: true },
        });
        const ok = [...new Set(validRooms.map((r) => r.id))];
        await tx.seriesRoom.deleteMany({ where: { seriesId: series.id } });
        if (ok.length > 0) {
          await tx.seriesRoom.createMany({ data: ok.map((roomId) => ({ seriesId: series.id, roomId })) });
        }
      }
      if (input.unconf_submission_ids !== undefined) {
        const validSubs = await tx.submission.findMany({
          where: { conferenceId: context.conferenceId, id: { in: input.unconf_submission_ids } },
          select: { id: true },
        });
        const ok = [...new Set(validSubs.map((s) => s.id))];
        await tx.seriesSubmission.deleteMany({ where: { seriesId: series.id } });
        if (ok.length > 0) {
          await tx.seriesSubmission.createMany({
            data: ok.map((submissionId) => ({ seriesId: series.id, submissionId })),
          });
        }
      }

      // Cascade-delete orphans (caller supplied `confirm: true` or there
      // were none to begin with). UserAssignments tied to dropped placements
      // go too, so participant schedules don't reference removed sessions.
      if (orphanedTrackIds.length > 0) {
        await tx.trackAssignment.deleteMany({ where: { id: { in: orphanedTrackIds } } });
      }
      if (orphanedPlacementKeys.length > 0) {
        for (const { slotId, submissionId } of orphanedPlacementKeys) {
          await tx.unconferencePlacement.deleteMany({ where: { slotId, submissionId } });
          await tx.userAssignment.deleteMany({ where: { slotId, submissionId } });
        }
      }
    });

    return { kind: "ok" as const };
  }),

  detachSeries: requireConf("moderator").agenda.detachSeries.handler(async ({ input, context }) => {
    const slot = await context.prisma.agendaSlot.findFirst({
      where: { id: input.slot_id, conferenceId: context.conferenceId },
      include: {
        series: {
          include: {
            selectedRooms: { select: { roomId: true } },
            selectedSubmissions: { select: { submissionId: true } },
          },
        },
      },
    });
    if (!slot) throw new ORPCError("NOT_FOUND");
    if (slot.seriesId === null || !slot.series) {
      throw new ORPCError("BAD_REQUEST", { message: "not_in_series" });
    }
    const series = slot.series;
    // Snapshot the series's current config onto the slot's own columns and
    // join rows, then clear the FK. After this the slot is standalone and
    // behaves exactly as it did while linked. `type` is already in sync
    // (immutable per series).
    await context.prisma.$transaction(async (tx) => {
      await snapshotSeriesOntoSlot(tx, series, slot.id);
    });
    // If detaching this slot leaves the series with one remaining member,
    // there's no point keeping the series around — auto-detach the
    // singleton too.
    await maybeAutoDetachSingleton(context.prisma, series.id);
    return { ok: true as const };
  }),

  deleteSeries: requireConf("moderator").agenda.deleteSeries.handler(async ({ input, context }) => {
    const series = await context.prisma.slotSeries.findFirst({
      where: { id: input.id, conferenceId: context.conferenceId },
      include: {
        slots: { select: { id: true } },
        selectedRooms: { select: { roomId: true } },
        selectedSubmissions: { select: { submissionId: true } },
      },
    });
    if (!series) throw new ORPCError("NOT_FOUND");
    if (input.mode === "series_only") {
      // Snapshot the series's config onto each member before detaching, so
      // every surviving slot keeps its current effective config as a
      // standalone slot.
      await context.prisma.$transaction(async (tx) => {
        for (const member of series.slots) {
          await snapshotSeriesOntoSlot(tx, series, member.id);
        }
        await tx.slotSeries.delete({ where: { id: series.id } });
      });
    } else {
      // mode === "with_slots": every sibling goes too. Delete slots first
      // (the FK is SetNull, so dropping the series alone would just orphan
      // the members rather than removing them).
      await context.prisma.$transaction([
        context.prisma.agendaSlot.deleteMany({
          where: { id: { in: series.slots.map((s) => s.id) } },
        }),
        context.prisma.slotSeries.delete({ where: { id: series.id } }),
      ]);
    }
    return { ok: true as const };
  }),

  setTrack: requireConf("moderator").agenda.setTrack.handler(async ({ input, context }) => {
    const slot = await context.prisma.agendaSlot.findFirst({
      where: { id: input.slot_id, conferenceId: context.conferenceId },
    });
    if (!slot) throw new ORPCError("NOT_FOUND");
    if (slot.type !== "normal") throw new ORPCError("BAD_REQUEST", { message: "not_a_static_slot" });
    // Path C: every planned track is anchored to a Submission. Custom-title
    // tracks no longer exist — to schedule an invited speaker who isn't a
    // participant, the mod creates a Submission for them first.
    const submission = await context.prisma.submission.findFirst({
      where: { id: input.submission_id, conferenceId: context.conferenceId },
      select: { id: true },
    });
    if (!submission) throw new ORPCError("BAD_REQUEST", { message: "submission_not_in_conference" });
    const speakers = (input.speakers ?? "").trim() || null;
    // Track requirements are replaced (not merged) on each save so the
    // editor's "clear all" intent is honored. When omitted, leave the
    // existing set untouched.
    const reqs = input.requirements === undefined
      ? undefined
      : normalizeLabels(input.requirements);

    await context.prisma.$transaction(async (tx) => {
      const track = await tx.trackAssignment.upsert({
        where: { slotId_roomId: { slotId: input.slot_id, roomId: input.room_id } },
        create: {
          slotId: input.slot_id, roomId: input.room_id,
          submissionId: input.submission_id,
          speakers,
          mandatory: input.mandatory ?? false,
        },
        update: {
          submissionId: input.submission_id,
          speakers,
          // Omit from update payload when client didn't send it, so existing
          // value sticks (avoids clobbering a mod-toggled flag on unrelated edits).
          mandatory: input.mandatory ?? undefined,
        },
        select: { id: true },
      });
      if (reqs !== undefined) {
        await tx.trackRequirement.deleteMany({ where: { trackId: track.id } });
        if (reqs.length > 0) {
          await tx.trackRequirement.createMany({
            data: reqs.map((value) => ({ trackId: track.id, value })),
          });
        }
      }
    });
    return { ok: true as const };
  }),

  clearTrack: requireConf("moderator").agenda.clearTrack.handler(async ({ input, context }) => {
    const slot = await context.prisma.agendaSlot.findFirst({
      where: { id: input.slot_id, conferenceId: context.conferenceId },
    });
    if (!slot) throw new ORPCError("NOT_FOUND");
    await context.prisma.trackAssignment.deleteMany({
      where: { slotId: input.slot_id, roomId: input.room_id },
    });
    return { ok: true as const };
  }),

  // Auto-room counterpart to `setTrack`. The mod picks a submission; the
  // server picks the room. Priority order:
  //   1. `Submission.preAssignedRoomId` — hard pin. If the room is in the
  //      slot's effective scope and not yet taken, we use it. Out-of-scope
  //      or taken → structured conflict.
  //   2. Otherwise, find the largest free room in scope whose tag set
  //      satisfies every entry of `Submission.roomRequirements`. Ties broken
  //      by smallest room id (deterministic).
  //   3. If no such room exists, we report whether the failure is "no rooms
  //      match the tag set at all" or "matching rooms exist but every one
  //      is taken" via `candidate_room_names`.
  // This is intentionally simpler than the unconference matcher: we never
  // swap rooms of *existing* tracks, so mods see predictable, additive
  // changes. If they need a swap, they can clear a track and re-schedule.
  scheduleSubmission: requireConf("moderator").agenda.scheduleSubmission.handler(async ({ input, context }) => {
    const slot = await context.prisma.agendaSlot.findFirst({
      where: { id: input.slot_id, conferenceId: context.conferenceId },
      include: SLOT_CONFIG_INCLUDE,
    });
    if (!slot) throw new ORPCError("NOT_FOUND");
    if (slot.type !== "normal") {
      throw new ORPCError("BAD_REQUEST", { message: "not_a_static_slot" });
    }
    const submission = await context.prisma.submission.findFirst({
      where: { id: input.submission_id, conferenceId: context.conferenceId },
      select: {
        id: true,
        preAssignedRoomId: true,
        roomRequirements: { select: { value: true } },
      },
    });
    if (!submission) {
      throw new ORPCError("BAD_REQUEST", { message: "submission_not_in_conference" });
    }

    const cfg = effectiveSlotConfig(slot);
    const roomWhere = cfg.unconfUseAllRooms
      ? { conferenceId: context.conferenceId }
      : { conferenceId: context.conferenceId, id: { in: cfg.roomIds } };
    const [scopedRooms, existingTracks] = await Promise.all([
      context.prisma.room.findMany({
        where: roomWhere,
        select: { id: true, name: true, capacity: true },
      }),
      context.prisma.trackAssignment.findMany({
        where: { slotId: input.slot_id },
        select: { roomId: true },
      }),
    ]);
    const takenRoomIds = new Set(existingTracks.map((t) => t.roomId));
    const requiredTags = submission.roomRequirements.map((r) => r.value);

    // Resolve all rooms' tags up front so we can build `candidate_room_names`
    // for conflict responses without an extra query.
    const roomTagsRows = scopedRooms.length === 0
      ? []
      : await context.prisma.roomTag.findMany({
          where: { roomId: { in: scopedRooms.map((r) => r.id) } },
          select: { roomId: true, value: true },
        });
    const tagsByRoom = new Map<number, Set<string>>();
    for (const r of scopedRooms) tagsByRoom.set(r.id, new Set());
    for (const row of roomTagsRows) tagsByRoom.get(row.roomId)?.add(row.value);
    function roomSatisfiesRequirements(roomId: number): boolean {
      if (requiredTags.length === 0) return true;
      const tags = tagsByRoom.get(roomId);
      if (!tags) return false;
      for (const req of requiredTags) if (!tags.has(req)) return false;
      return true;
    }

    // For "pinned room taken / out of scope" responses we may need the room
    // name even when it isn't in scope. Fetch lazily only if needed.
    async function fetchRoomName(roomId: number): Promise<string | null> {
      const inScope = scopedRooms.find((r) => r.id === roomId);
      if (inScope) return inScope.name;
      const row = await context.prisma.room.findFirst({
        where: { id: roomId, conferenceId: context.conferenceId },
        select: { name: true },
      });
      return row?.name ?? null;
    }

    let chosenRoomId: number | null = null;
    if (submission.preAssignedRoomId !== null) {
      const pinnedId = submission.preAssignedRoomId;
      const pinnedRoom = scopedRooms.find((r) => r.id === pinnedId) ?? null;
      if (!pinnedRoom) {
        return {
          kind: "conflict" as const,
          reason: "pin_room_out_of_scope" as const,
          pinned_room: { id: pinnedId, name: (await fetchRoomName(pinnedId)) ?? "(unknown room)" },
          required_tags: requiredTags,
          candidate_room_names: [],
        };
      }
      if (takenRoomIds.has(pinnedId)) {
        return {
          kind: "conflict" as const,
          reason: "pin_room_taken" as const,
          pinned_room: { id: pinnedId, name: pinnedRoom.name },
          required_tags: requiredTags,
          candidate_room_names: [],
        };
      }
      chosenRoomId = pinnedId;
    } else {
      const matching = scopedRooms.filter((r) => roomSatisfiesRequirements(r.id));
      const free = matching.filter((r) => !takenRoomIds.has(r.id));
      if (free.length === 0) {
        // Two distinct failure modes here, both surfaced clearly to the mod:
        //   - `matching.length === 0` and we have any requirements →
        //     "unsatisfiable_requirements" (no room has the right tags).
        //   - matching rooms exist but are all taken → "no_free_room" with
        //     `candidate_room_names` filled so the mod sees what to clear.
        if (requiredTags.length > 0 && matching.length === 0) {
          return {
            kind: "conflict" as const,
            reason: "unsatisfiable_requirements" as const,
            pinned_room: null,
            required_tags: requiredTags,
            candidate_room_names: [],
          };
        }
        return {
          kind: "conflict" as const,
          reason: requiredTags.length > 0
            ? "unsatisfiable_requirements" as const
            : "no_free_room" as const,
          pinned_room: null,
          required_tags: requiredTags,
          candidate_room_names: matching.map((r) => r.name),
        };
      }
      // Largest capacity first, smallest id as deterministic tiebreaker.
      free.sort((a, b) => {
        if (a.capacity !== b.capacity) return b.capacity - a.capacity;
        return a.id - b.id;
      });
      chosenRoomId = free[0]!.id;
    }

    const speakers = (input.speakers ?? "").trim() || null;
    const reqs = input.requirements === undefined
      ? undefined
      : normalizeLabels(input.requirements);
    const chosenRoom = scopedRooms.find((r) => r.id === chosenRoomId)!;

    const track = await context.prisma.$transaction(async (tx) => {
      const created = await tx.trackAssignment.create({
        data: {
          slotId: input.slot_id,
          roomId: chosenRoomId!,
          submissionId: input.submission_id,
          speakers,
          mandatory: input.mandatory ?? false,
        },
        select: { id: true },
      });
      if (reqs !== undefined && reqs.length > 0) {
        await tx.trackRequirement.createMany({
          data: reqs.map((value) => ({ trackId: created.id, value })),
        });
      }
      return created;
    });

    return {
      kind: "ok" as const,
      track_id: track.id,
      room_id: chosenRoomId!,
      room_name: chosenRoom.name,
    };
  }),

  // Path C: planned-track "stars" no longer exist as a separate concept.
  // Participants star the underlying Submission via `submissions.star`, and
  // every linked TrackAssignment derives onto their MyAssignments. The old
  // `agenda.starTrack` / `agenda.unstarTrack` endpoints have been removed.

  assign: requireConf("moderator").agenda.assign.handler(async ({ input, context }) => {
    const slot = await context.prisma.agendaSlot.findFirst({
      where: { id: input.slot_id, conferenceId: context.conferenceId },
    });
    if (!slot) throw new ORPCError("NOT_FOUND");
    if (slot.type === "unconference") {
      const excludes = input.exclude_submission_ids && input.exclude_submission_ids.length > 0
        ? new Set(input.exclude_submission_ids)
        : undefined;
      const r = await runAssignmentForSlot(context.prisma, context.conferenceId, input.slot_id, excludes);
      // Pre-assignment conflicts surface here as a structured result; no
      // notifications, no DB writes — the moderator resolves the conflict
      // and re-runs.
      if ("kind" in r && r.kind === "conflict") {
        return r;
      }
      // Notify each assigned participant. The "manual" picks (preserved across
      // re-runs) re-notify too — harmless and lets the participant know the
      // round was finalized.
      const subTitles = new Map<number, string>(
        (await context.prisma.submission.findMany({
          where: { id: { in: r.user_assignments.map((a) => a.submission_id) } },
          select: { id: true, title: true },
        })).map((s) => [s.id, s.title]),
      );
      await createNotifications(context.prisma, r.user_assignments.map((a) => ({
        identityId: a.user_id,
        kind: "unconf_assigned" as const,
        title: "You were assigned to a session",
        body: subTitles.get(a.submission_id) ?? null,
        ctaLabel: "Open schedule",
        ctaHref: "tab:me",
      })));
      return { kind: "unconference" as const, ...r };
    }
    if (slot.type === "mixer") {
      const r = await runMixerForSlot(context.prisma, context.conferenceId, input.slot_id);
      const roomNames = new Map<number, string>(
        (await context.prisma.room.findMany({
          where: { id: { in: r.room_assignments.map((a) => a.room_id) } },
          select: { id: true, name: true },
        })).map((rm) => [rm.id, rm.name]),
      );
      await createNotifications(context.prisma, r.room_assignments.map((a) => ({
        identityId: a.user_id,
        kind: "mixer_assigned" as const,
        title: "You were placed for a mixer",
        body: roomNames.get(a.room_id) ?? null,
        ctaLabel: "Open schedule",
        ctaHref: "tab:me",
      })));
      return { kind: "mixer" as const, ...r };
    }
    throw new ORPCError("BAD_REQUEST", { message: "not_an_assignable_slot" });
  }),

  myAssignments: requireConf("participant").agenda.myAssignments.handler(async ({ context }) => {
    const confId = context.conferenceId;
    const userId = actorIdentityId(context);
    const [assigns, placements, derivedTracks, expertBookerBookings, ownExpert] = await Promise.all([
      context.prisma.userAssignment.findMany({
        where: { userId, slot: { conferenceId: confId } },
        include: {
          submission: { select: { title: true } },
          slot: { select: { id: true, type: true, startsAt: true, endsAt: true } },
          room: { select: { id: true, name: true } },
        },
      }),
      context.prisma.unconferencePlacement.findMany({
        where: { slot: { conferenceId: confId } },
      }),
      // Path C derivation: a TrackAssignment lands on the participant's
      // schedule when ANY of:
      //   - it's `mandatory: true` (everyone attends);
      //   - the participant has starred the linked Submission;
      //   - the participant IS the linked Submission's submitter (so the
      //     submitter sees their own scheduled speaking gigs without needing
      //     to star themselves).
      // This single query unions all three sources at the DB level. Dedup is
      // implicit because TrackAssignment rows are unique.
      context.prisma.trackAssignment.findMany({
        where: {
          slot: { conferenceId: confId },
          OR: [
            { mandatory: true },
            { submission: { stars: { some: { userId } } } },
            { submission: { submitterId: userId } },
          ],
        },
        include: {
          submission: {
            select: {
              title: true, submitterId: true,
              // Used to surface a "this room may be crowded" hint to the
              // participant when more people starred than the room holds.
              _count: { select: { stars: true } },
            },
          },
          slot: { select: { startsAt: true, endsAt: true } },
          room: { select: { capacity: true } },
        },
      }),
      // Bookings I made as the booker.
      context.prisma.expertBooking.findMany({
        where: { bookerId: userId, expert: { conferenceId: confId } },
        include: {
          expert: { include: { identity: { select: { name: true, email: true } } } },
        },
      }),
      // If this identity is promoted to expert in this conference, surface
      // every booking other people made against them too.
      context.prisma.expert.findUnique({
        where: { identityId: userId },
        include: {
          bookings: {
            include: { booker: { select: { name: true, email: true } } },
          },
        },
      }),
    ]);
    const placementBySubAndSlot = new Map<string, number>();
    for (const p of placements) {
      placementBySubAndSlot.set(`${p.slotId}:${p.submissionId}`, p.roomId);
    }
    const assignableSlots = await context.prisma.agendaSlot.findMany({
      where: { conferenceId: confId, type: { in: ["unconference", "mixer"] } },
      select: { id: true },
    });
    const myAssignedSlots = new Set(assigns.map((a) => a.slotId));
    const slotsWithAssignments = new Set([
      ...placements.map((p) => p.slotId),
      ...(await context.prisma.userAssignment.findMany({
        where: { slot: { conferenceId: confId, type: "mixer" } },
        select: { slotId: true }, distinct: ["slotId"],
      })).map((a) => a.slotId),
    ]);
    const unplaced_slots = assignableSlots
      .filter((s) => slotsWithAssignments.has(s.id) && !myAssignedSlots.has(s.id))
      .map((s) => s.id);

    // Bookings against this user as the expert are only surfaced when the
    // expert record is in *this* conference (Expert.identityId is globally
    // unique on a ConferenceIdentity, which is already conference-scoped, but
    // we still guard the include payload).
    const expertSelfBookings = (ownExpert && ownExpert.conferenceId === confId)
      ? ownExpert.bookings
      : [];

    return {
      assignments: [
        ...assigns.map((a) => ({
          source: a.slot.type === "mixer" ? "mixer" as const : "unconference" as const,
          slot_id: a.slotId,
          submission_id: a.submissionId,
          room_id: a.roomId
            ?? (a.submissionId
              ? placementBySubAndSlot.get(`${a.slotId}:${a.submissionId}`) ?? null
              : null),
          starts_at: a.slot.startsAt.getTime(),
          ends_at: a.slot.endsAt.getTime(),
          title: a.submission?.title
            ?? (a.slot.type === "mixer" ? a.room?.name ?? null : null),
          manual: a.manual,
        })),
        // Path C derived planned-track rows. The `OR`'d query above unions
        // mandatory + starred-submission + submitter-self. We tag the row
        // with the originating reason so the client can render distinct
        // affordances (e.g. "Required" badge for mandatory, "You're
        // speaking" for submitter-self).
        ...derivedTracks.map((t) => ({
          source: "static" as const,
          slot_id: t.slotId,
          submission_id: t.submissionId,
          room_id: t.roomId,
          starts_at: t.slot.startsAt.getTime(),
          ends_at: t.slot.endsAt.getTime(),
          title: t.submission.title,
          manual: false as const,
          mandatory: t.mandatory,
          is_submitter: t.submission.submitterId === userId,
          expected_attendance: t.submission._count.stars,
          room_capacity: t.room?.capacity ?? null,
        })),
        ...expertBookerBookings.map((b) => ({
          source: "expert" as const,
          slot_id: null,
          submission_id: null,
          room_id: b.roomId,
          starts_at: b.startsAt.getTime(),
          ends_at: b.endsAt.getTime(),
          title: `Expert: ${b.expert.identity.name ?? b.expert.identity.email}`,
          manual: true,
          booking_id: b.id,
          expert_role: "booker" as const,
        })),
        ...expertSelfBookings.map((b) => ({
          source: "expert" as const,
          slot_id: null,
          submission_id: null,
          room_id: b.roomId,
          starts_at: b.startsAt.getTime(),
          ends_at: b.endsAt.getTime(),
          title: `Booked by ${b.booker.name ?? b.booker.email}`,
          manual: false,
          booking_id: b.id,
          expert_role: "expert" as const,
        })),
      ],
      unplaced_slots,
    };
  }),

  pickAssignment: requireConf("participant").agenda.pickAssignment.handler(async ({ input, context }) => {
    const slot = await context.prisma.agendaSlot.findFirst({
      where: { id: input.slot_id, conferenceId: context.conferenceId },
      select: { id: true, type: true },
    });
    if (!slot) throw new ORPCError("NOT_FOUND");
    if (slot.type !== "unconference") {
      throw new ORPCError("BAD_REQUEST", { message: "not_an_unconference_slot" });
    }
    return context.prisma.$transaction(async (tx) => {
      const placement = await tx.unconferencePlacement.findFirst({
        where: { slotId: input.slot_id, submissionId: input.submission_id },
        select: { roomId: true, room: { select: { capacity: true } } },
      });
      if (!placement) throw new ORPCError("NOT_FOUND", { message: "not_placed" });
      const myIdentityId = actorIdentityId(context);
      const load = await tx.userAssignment.count({
        where: {
          slotId: input.slot_id, submissionId: input.submission_id,
          NOT: { userId: myIdentityId },
        },
      });
      if (load >= placement.room.capacity) {
        throw new ORPCError("CONFLICT", { message: "session_full" });
      }
      await tx.userAssignment.upsert({
        where: { slotId_userId: { slotId: input.slot_id, userId: myIdentityId } },
        create: {
          slotId: input.slot_id, userId: myIdentityId,
          submissionId: input.submission_id, roomId: placement.roomId, manual: true,
        },
        update: {
          submissionId: input.submission_id, roomId: placement.roomId, manual: true,
        },
      });
      return { ok: true as const };
    });
  }),

  unpickAssignment: requireConf("participant").agenda.unpickAssignment.handler(async ({ input, context }) => {
    const slot = await context.prisma.agendaSlot.findFirst({
      where: { id: input.slot_id, conferenceId: context.conferenceId },
      select: { id: true },
    });
    if (!slot) throw new ORPCError("NOT_FOUND");
    await context.prisma.userAssignment.deleteMany({
      where: { slotId: input.slot_id, userId: actorIdentityId(context), manual: true },
    });
    return { ok: true as const };
  }),
};
