// Global agenda attendee router (pure function — no DB access).
//
// USER-FACING DOCS: the plain-language explanation shown to mods and
// participants lives in `src/web/conference/ui/AssignmentRulesModal.tsx`.
// **Update that file whenever you change behavior here** — it's the single
// source of truth for what we promise the algorithm will do.
//
// Unlike `assignUnconferenceSlot` (which solves ONE slot greedily and also
// decides which submission goes in which room), this function routes USERS
// across the WHOLE agenda at once over a FIXED set of occurrences. An
// "occurrence" is one moderator-/algorithm-authored placement: a submission
// running in a specific slot + room. The router never creates or moves
// occurrences — it only assigns attendees to them.
//
// What the global solve buys us that per-slot greedy cannot:
//   1. Cross-slot lookahead. A user starring A (one slot) and B (recurring)
//      is routed to A now and B later instead of double-booking, because all
//      slots are solved jointly.
//   2. Split across occurrences. A recurring session's starers are spread
//      evenly across its occurrences instead of dumped into the first.
//
// Hard constraints (never traded away by the optimizer):
//   - room capacity per occurrence,
//   - at most ONE session per user per time-band (overlapping slots collapse
//     into one band),
//   - fixed (manual) picks and submitter-as-host placements are pre-pinned.
//
// Optimized objective: maximize starred-occurrence attendance, then balance
// the load across occurrences of the same submission. Modeled as an integer
// min-cost flow; deterministic (all collections canonicalized by id, all
// tie-breaks lexicographic) so re-running identical inputs is byte-identical.
//
// NOTE on the graph shape: the per-user band gate is the LAST per-user node
// before the shared occurrence node, so a unit of flow can only reach an
// occurrence through its OWN band — keeping the ≤1-per-band constraint exact.
// (A naive `band → submission → occurrence` layering leaks: a band-gated unit
// could exit to an occurrence in a different band and let the user
// double-book.) Per-submission "attend once" is enforced by a cap-1 ticket
// node upstream; a final deterministic repair pass fixes the rare residual
// case where a user is routed to the same submission twice.

import type { ID } from "../shared/types";

/** One placement: a submission running in a specific slot + room. */
export interface AgendaOccurrence {
  /** Stable unique id for this occurrence (caller-assigned). */
  id: ID;
  slot_id: ID;
  submission_id: ID;
  room_id: ID;
  capacity: number;
  /** The user who submitted this session (submitter-as-host rule). */
  submitter_id: ID;
  /**
   * Time-band id. Occurrences whose slots overlap in time share a band, so a
   * user can attend at most one of them. Non-overlapping slots get distinct
   * bands. Two occurrences in the SAME slot share that slot's band.
   */
  band_id: ID;
}

export interface AgendaAssignmentInput {
  occurrences: AgendaOccurrence[];
  /** Per user: which submissions did they star? Users who starred nothing are
   *  still expected as keys (empty set) so they surface in `unplaced_users`. */
  stars: Map<ID, Set<ID>>;
  /**
   * Manual picks the user made themselves — `(user, occurrence)` pairs pinned
   * before the solve (capacity reserved, band consumed). Entries whose
   * occurrence doesn't exist, or that collide with another pin in the same
   * band for the same user, are dropped deterministically (lowest occurrence
   * id wins the band).
   */
  fixedAssignments?: { user_id: ID; occurrence_id: ID }[];
  /**
   * Per user: submissions they've already attended OUTSIDE this solve (e.g. a
   * mandatory planned track). Occurrences of these submissions are removed
   * from the user's candidate set.
   */
  priorAttendance?: Map<ID, Set<ID>>;
  /** Per user: bands already consumed outside this solve (mixers, planned
   *  tracks). The user can't be routed into an occurrence in these bands. */
  busyBands?: Map<ID, Set<ID>>;
  /** When false, submitters are NOT auto-assigned to host their own placed
   *  sessions. Defaults to true (matches the per-slot algorithm). */
  submitterHost?: boolean;
}

export interface AgendaUserAssignment {
  slot_id: ID;
  user_id: ID;
  submission_id: ID;
  room_id: ID;
  occurrence_id: ID;
}

export interface AgendaAssignmentResult {
  user_assignments: AgendaUserAssignment[];
  /** Users who starred at least one (eligible) submission but got no seat. */
  unplaced_users: ID[];
}

// Cost units, ordered by magnitude so each tier only ever breaks ties left by
// the tier above it:
//   ATTEND_REWARD  ≫ USER_DIMINISH ≫ SEAT_STEP·maxCapacity
//
// - ATTEND_REWARD: attending a starred occurrence is hugely rewarded, so the
//   optimizer always seats a starred user when capacity allows.
// - USER_DIMINISH: the k-th session a single user attends costs k·USER_DIMINISH
//   more than their first. This is a convex per-user penalty that makes the
//   optimizer prefer giving many users their FIRST session over giving one
//   user several — i.e. coverage/fairness, and the cross-slot "lookahead"
//   (a scarce session goes to the user who has no later alternative).
// - SEAT_STEP: the k-th seat of an occurrence costs k·SEAT_STEP, so equal
//   demand splits evenly across occurrences of the same submission.
const ATTEND_REWARD = 1_000_000_000;
const USER_DIMINISH = 1_000_000;
const SEAT_STEP = 1;

// ---------------------------------------------------------------------------
// Min-cost flow (successive shortest paths; augments only NEGATIVE-cost paths
// so the result maximizes reward minus balance cost without forcing every
// user to be seated). Integer costs, deterministic path reconstruction.
// ---------------------------------------------------------------------------

interface FlowEdge {
  to: number;
  cap: number;
  cost: number;
  flow: number;
  rev: number; // index of the reverse edge in `graph[to]`
}

class MinCostFlow {
  readonly graph: FlowEdge[][] = [];

  addNode(): number {
    this.graph.push([]);
    return this.graph.length - 1;
  }

  /** Directed edge u→v. Returns the index of the forward edge in `graph[u]`. */
  addEdge(u: number, v: number, cap: number, cost: number): number {
    const idx = this.graph[u]!.length;
    this.graph[u]!.push({ to: v, cap, cost, flow: 0, rev: this.graph[v]!.length });
    this.graph[v]!.push({ to: u, cap: 0, cost: -cost, flow: 0, rev: idx });
    return idx;
  }

  edgeFlow(u: number, idx: number): number {
    return this.graph[u]![idx]!.flow;
  }

  /**
   * Push flow from s to t along the cheapest augmenting path, stopping once the
   * cheapest path is no longer negative.
   *
   * Successive shortest paths with Johnson potentials: a single Bellman-Ford
   * pass seeds node potentials (the graph has negative reward edges), then each
   * augmentation runs Dijkstra on reduced (non-negative) costs — O(E log V) per
   * path instead of SPFA's O(V·E), which matters at conference scale. Potentials
   * are maintained so reduced costs stay non-negative. Deterministic: the heap
   * breaks ties by node id and reconstruction follows a recorded predecessor
   * tree, so identical (canonicalized) inputs give identical paths.
   */
  solve(s: number, t: number): void {
    const n = this.graph.length;

    // Seed potentials with a Bellman-Ford (SPFA) pass over the initial graph.
    const pot = new Array<number>(n).fill(Infinity);
    pot[s] = 0;
    {
      const inQueue = new Array<boolean>(n).fill(false);
      const queue: number[] = [s];
      inQueue[s] = true;
      while (queue.length > 0) {
        const u = queue.shift()!;
        inQueue[u] = false;
        const du = pot[u]!;
        const edges = this.graph[u]!;
        for (let i = 0; i < edges.length; i++) {
          const e = edges[i]!;
          if (e.cap - e.flow <= 0) continue;
          const nd = du + e.cost;
          if (nd < pot[e.to]!) {
            pot[e.to] = nd;
            if (!inQueue[e.to]!) { inQueue[e.to] = true; queue.push(e.to); }
          }
        }
      }
    }
    for (let i = 0; i < n; i++) if (pot[i] === Infinity) pot[i] = 0;

    const dist = new Array<number>(n).fill(Infinity);
    const prevTail = new Array<number>(n).fill(-1);
    const prevIdx = new Array<number>(n).fill(-1);
    const done = new Array<boolean>(n).fill(false);

    for (;;) {
      dist.fill(Infinity);
      done.fill(false);
      dist[s] = 0;
      // Binary heap of [reducedDist, node]; ties broken by node id for
      // determinism.
      const heap = new BinaryHeap();
      heap.push(0, s);
      while (heap.size > 0) {
        const [d, u] = heap.pop();
        if (done[u]) continue;
        done[u] = true;
        const pu = pot[u]!;
        const edges = this.graph[u]!;
        for (let i = 0; i < edges.length; i++) {
          const e = edges[i]!;
          if (e.cap - e.flow <= 0) continue;
          const rc = e.cost + pu - pot[e.to]!; // reduced cost ≥ 0
          const nd = d + rc;
          if (nd < dist[e.to]!) {
            dist[e.to] = nd;
            prevTail[e.to] = u;
            prevIdx[e.to] = i;
            heap.push(nd, e.to);
          }
        }
      }
      if (dist[t] === Infinity) break;

      // Update potentials; the true shortest s→t distance is now pot[t].
      for (let i = 0; i < n; i++) if (dist[i]! < Infinity) pot[i] = pot[i]! + dist[i]!;
      if (pot[t]! >= 0) break; // cheapest augmenting path no longer helps

      let push = Infinity;
      let v = t;
      while (v !== s) {
        const e = this.graph[prevTail[v]!]![prevIdx[v]!]!;
        push = Math.min(push, e.cap - e.flow);
        v = prevTail[v]!;
      }
      v = t;
      while (v !== s) {
        const tail = prevTail[v]!;
        const e = this.graph[tail]![prevIdx[v]!]!;
        e.flow += push;
        this.graph[e.to]![e.rev]!.flow -= push;
        v = tail;
      }
    }
  }
}

// Binary min-heap keyed by (dist, node) for the Dijkstra inner loop.
class BinaryHeap {
  private readonly ds: number[] = [];
  private readonly ns: number[] = [];

  get size(): number { return this.ns.length; }

  private less(i: number, j: number): boolean {
    return this.ds[i]! !== this.ds[j]! ? this.ds[i]! < this.ds[j]! : this.ns[i]! < this.ns[j]!;
  }

  push(d: number, node: number): void {
    this.ds.push(d); this.ns.push(node);
    let i = this.ds.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.less(i, p)) break;
      this.swap(i, p); i = p;
    }
  }

  pop(): [number, number] {
    const d = this.ds[0]!, node = this.ns[0]!;
    const last = this.ds.length - 1;
    this.swap(0, last);
    this.ds.pop(); this.ns.pop();
    let i = 0;
    const len = this.ds.length;
    for (;;) {
      const l = 2 * i + 1, r = 2 * i + 2;
      let m = i;
      if (l < len && this.less(l, m)) m = l;
      if (r < len && this.less(r, m)) m = r;
      if (m === i) break;
      this.swap(i, m); i = m;
    }
    return [d, node];
  }

  private swap(i: number, j: number): void {
    const td = this.ds[i]!; this.ds[i] = this.ds[j]!; this.ds[j] = td;
    const tn = this.ns[i]!; this.ns[i] = this.ns[j]!; this.ns[j] = tn;
  }
}

// ---------------------------------------------------------------------------

/**
 * Route attendees across a whole agenda over a fixed occurrence set.
 */
export function assignAgenda(input: AgendaAssignmentInput): AgendaAssignmentResult {
  const submitterHost = input.submitterHost ?? true;
  const priorAttendance = input.priorAttendance ?? new Map<ID, Set<ID>>();
  const busyBands = input.busyBands ?? new Map<ID, Set<ID>>();

  const occurrences = [...input.occurrences].sort((a, b) => a.id - b.id);
  const occById = new Map<ID, AgendaOccurrence>();
  for (const o of occurrences) occById.set(o.id, o);
  const userIds = [...input.stars.keys()].sort((a, b) => a - b);

  const remainingCap = new Map<ID, number>();
  for (const o of occurrences) remainingCap.set(o.id, Math.max(0, o.capacity));

  const usedBands = new Map<ID, Set<ID>>();
  const attendedSubs = new Map<ID, Set<ID>>();
  const forced: AgendaUserAssignment[] = [];
  for (const uid of userIds) {
    usedBands.set(uid, new Set(busyBands.get(uid) ?? []));
    attendedSubs.set(uid, new Set(priorAttendance.get(uid) ?? []));
  }

  // Lock a (user, occurrence) into the result, consuming a seat + the band.
  const lockIn = (uid: ID, occ: AgendaOccurrence): boolean => {
    if (!input.stars.has(uid)) return false;
    const cap = remainingCap.get(occ.id) ?? 0;
    if (cap <= 0) return false;
    const bands = usedBands.get(uid)!;
    if (bands.has(occ.band_id)) return false;
    const subs = attendedSubs.get(uid)!;
    if (subs.has(occ.submission_id)) return false;
    remainingCap.set(occ.id, cap - 1);
    bands.add(occ.band_id);
    subs.add(occ.submission_id);
    forced.push({
      slot_id: occ.slot_id, user_id: uid, submission_id: occ.submission_id,
      room_id: occ.room_id, occurrence_id: occ.id,
    });
    return true;
  };

  // Pre-pass 1: fixed (manual) picks. Highest priority; lowest occurrence id
  // wins a band for a user.
  const fixedEntries = [...(input.fixedAssignments ?? [])]
    .filter((f) => occById.has(f.occurrence_id) && input.stars.has(f.user_id))
    .sort((a, b) =>
      a.user_id !== b.user_id ? a.user_id - b.user_id : a.occurrence_id - b.occurrence_id,
    );
  for (const f of fixedEntries) lockIn(f.user_id, occById.get(f.occurrence_id)!);

  // Pre-pass 2: submitter-as-host. For each occurrence force its submitter to
  // host it; multi-session submitters host the most-starred (id-asc tiebreak).
  if (submitterHost) {
    const starCount = new Map<ID, number>();
    for (const set of input.stars.values()) {
      for (const sid of set) starCount.set(sid, (starCount.get(sid) ?? 0) + 1);
    }
    const hostOrder = [...occurrences].sort((a, b) => {
      const sa = starCount.get(a.submission_id) ?? 0;
      const sb = starCount.get(b.submission_id) ?? 0;
      if (sb !== sa) return sb - sa;
      return a.id - b.id;
    });
    for (const occ of hostOrder) lockIn(occ.submitter_id, occ);
  }

  // --- Solve one residual min-cost flow over the star-users. ---
  // Graph: SOURCE -> U(u) -> US(u,s) -> UBin(u,b) -> UBout(u,b) -> O(o) -> SINK
  // `supplyCap` bounds how many sessions each user may be handed (their convex
  // SOURCE supply). Returns each user's chosen occurrences — which may contain a
  // same-submission duplicate from cross-routing through a shared band gate; the
  // caller detects that and re-solves with a tighter supply for that user.
  const runFlow = (active: ID[], supplyCap: Map<ID, number>): Map<ID, AgendaOccurrence[]> => {
    const flow = new MinCostFlow();
    const SOURCE = flow.addNode();
    const SINK = flow.addNode();

    const occNode = new Map<ID, number>();
    for (const o of occurrences) {
      const cap = remainingCap.get(o.id) ?? 0;
      if (cap <= 0) continue;
      const node = flow.addNode();
      occNode.set(o.id, node);
      for (let k = 0; k < cap; k++) flow.addEdge(node, SINK, 1, k * SEAT_STEP);
    }

    const rewardEdges: { uid: ID; occ: AgendaOccurrence; tail: number; idx: number }[] = [];
    for (const uid of active) {
      const starred = input.stars.get(uid)!;
      if (starred.size === 0) continue;
      const bands = usedBands.get(uid)!;
      const subsDone = attendedSubs.get(uid)!;

      const candBySub = new Map<ID, AgendaOccurrence[]>();
      for (const o of occurrences) {
        if (!occNode.has(o.id)) continue;
        if (!starred.has(o.submission_id)) continue;
        if (subsDone.has(o.submission_id)) continue;
        if (bands.has(o.band_id)) continue;
        let arr = candBySub.get(o.submission_id);
        if (!arr) { arr = []; candBySub.set(o.submission_id, arr); }
        arr.push(o);
      }
      if (candBySub.size === 0) continue;

      const uNode = flow.addNode();
      const candBands = new Set<ID>();
      for (const arr of candBySub.values()) for (const o of arr) candBands.add(o.band_id);
      // A user can attend at most min(distinct candidate bands, distinct
      // candidate submissions) sessions, capped further by `supplyCap`.
      const naturalCap = Math.min(candBands.size, candBySub.size);
      const sup = Math.min(naturalCap, supplyCap.get(uid) ?? naturalCap);
      // Convex per-user supply: the k-th session this user attends costs
      // k·USER_DIMINISH more, so the optimizer spreads scarce sessions across
      // users (coverage) before handing anyone a second seat.
      for (let k = 0; k < sup; k++) flow.addEdge(SOURCE, uNode, 1, k * USER_DIMINISH);

      const ubIn = new Map<ID, number>();
      const ubOut = new Map<ID, number>();
      const bandNode = (band: ID): { inNode: number; outNode: number } => {
        const existing = ubIn.get(band);
        if (existing !== undefined) return { inNode: existing, outNode: ubOut.get(band)! };
        const a = flow.addNode();
        const b = flow.addNode();
        flow.addEdge(a, b, 1, 0); // ≤1 session per band (HARD; band gate is last)
        ubIn.set(band, a);
        ubOut.set(band, b);
        return { inNode: a, outNode: b };
      };

      const subIds = [...candBySub.keys()].sort((a, b) => a - b);
      for (const sid of subIds) {
        const occs = candBySub.get(sid)!.sort((a, b) => a.id - b.id);
        const usNode = flow.addNode();
        flow.addEdge(uNode, usNode, 1, 0); // one ticket per starred submission
        const bandsForSub = [...new Set(occs.map((o) => o.band_id))].sort((a, b) => a - b);
        for (const band of bandsForSub) flow.addEdge(usNode, bandNode(band).inNode, 1, 0);
        for (const o of occs) {
          const outNode = bandNode(o.band_id).outNode;
          const idx = flow.addEdge(outNode, occNode.get(o.id)!, 1, -ATTEND_REWARD);
          rewardEdges.push({ uid, occ: o, tail: outNode, idx });
        }
      }
    }

    flow.solve(SOURCE, SINK);

    const out = new Map<ID, AgendaOccurrence[]>();
    for (const r of rewardEdges) {
      if (flow.edgeFlow(r.tail, r.idx) <= 0) continue;
      let arr = out.get(r.uid);
      if (!arr) { arr = []; out.set(r.uid, arr); }
      arr.push(r.occ);
    }
    return out;
  };

  // --- Solve, then re-solve globally if cross-routing produced any duplicate. ---
  // Cross-routing through a shared band gate can hand a user the SAME submission
  // in two bands (a wasteful artifact, never what a single star wants). When
  // that happens we cap that user's supply to the distinct-submission count they
  // actually attended and re-run the WHOLE flow, so the freed occurrence is
  // re-optimized across all users rather than greedily reassigned. `supplyCap`
  // only ever shrinks, so this converges in a few passes.
  // Re-solve with tightened supply for any user the flow handed a duplicate
  // submission. Each round caps more users and converges, but the cascade can
  // be long on large, dense agendas; we bound the rounds (this is a moderator
  // batch action, not a hot path) and let the output dedup below guarantee no
  // duplicate ever ships even if a round budget is hit. Small agendas converge
  // in one or two rounds.
  const starUsers = userIds.filter((u) => input.stars.get(u)!.size > 0);
  const supplyCap = new Map<ID, number>();
  const MAX_ROUNDS = 6;
  let assigned = runFlow(starUsers, supplyCap);
  for (let round = 0; round < MAX_ROUNDS; round++) {
    let anyDuplicate = false;
    for (const uid of starUsers) {
      const occs = assigned.get(uid) ?? [];
      const distinct = new Set(occs.map((o) => o.submission_id));
      if (distinct.size < occs.length) {
        supplyCap.set(uid, distinct.size);
        anyDuplicate = true;
      }
    }
    if (!anyDuplicate) break;
    assigned = runFlow(starUsers, supplyCap);
  }

  const result: AgendaUserAssignment[] = [...forced];
  for (const uid of starUsers) {
    const seenSub = new Set<ID>();
    for (const o of (assigned.get(uid) ?? []).sort((a, b) => a.id - b.id)) {
      if (seenSub.has(o.submission_id)) continue; // safety: never emit a duplicate
      seenSub.add(o.submission_id);
      result.push({
        slot_id: o.slot_id, user_id: uid, submission_id: o.submission_id,
        room_id: o.room_id, occurrence_id: o.id,
      });
      attendedSubs.get(uid)!.add(o.submission_id);
    }
  }

  // --- Unplaced: users who still want a starred submission but got nothing. ---
  const placedUsers = new Set<ID>(result.map((a) => a.user_id));
  const unplaced: ID[] = [];
  for (const uid of userIds) {
    if (placedUsers.has(uid)) continue;
    const starred = input.stars.get(uid)!;
    const subsDone = attendedSubs.get(uid)!;
    let wantsSomething = false;
    for (const sid of starred) {
      if (!subsDone.has(sid)) { wantsSomething = true; break; }
    }
    if (wantsSomething) unplaced.push(uid);
  }
  unplaced.sort((a, b) => a - b);

  result.sort((a, b) =>
    a.user_id !== b.user_id ? a.user_id - b.user_id
      : a.slot_id !== b.slot_id ? a.slot_id - b.slot_id
        : a.occurrence_id - b.occurrence_id,
  );

  return { user_assignments: result, unplaced_users: unplaced };
}
