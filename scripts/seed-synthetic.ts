// Synthetic data seed for screenshots / demos.
//
// Builds a single conference with the owner set to `nico.enking@gmail.com`
// (the existing dev account) and a rich set of related rows so every UI
// surface has something interesting to render: rooms with tags, submissions
// in every status, static tracks (some mandatory, some with requirements),
// finished and capped submissions, a successful unconference + a partially-
// failed one (so the "pick a session" banner shows), mixer assignments,
// manual picks, expert pools + bookings, pending invites, an enabled join
// link, and a mixed-state notification inbox.
//
// Re-runnable: deletes any existing conference with the same slug first.
// Run: `bun scripts/seed-synthetic.ts`

import { getPrisma } from "../src/server/db";
import { hashPassword } from "../src/server/auth";
import {
  assignUnconferenceSlot,
  assignMixerSlot,
  pairKey,
} from "../src/server/assignment";

const OWNER_EMAIL = "nico.enking@gmail.com";
const OWNER_NAME = "Nico Enking";
const CONFERENCE_SLUG = "techsummit-2026";
const CONFERENCE_NAME = "TechSummit 2026";
const TIMEZONE = "Europe/Berlin";

// Conference is set for tomorrow + day-after so screenshots show upcoming
// schedule. Wall-clock anchors are computed in the conference timezone so
// "09:00 Berlin time" lands on the right epoch regardless of where the
// seed is run from.
function dayInTz(daysFromToday: number, hour: number, minute: number): Date {
  // Build an ISO instant for `hour:minute` Berlin time on (today + N days).
  // Berlin is UTC+2 in May (CEST). We hard-code the offset because seeding
  // doesn't need full tz lib correctness — just stable demo timestamps.
  const today = new Date();
  const d = new Date(today.getTime() + daysFromToday * 24 * 60 * 60_000);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  // Berlin CEST = UTC+2 in late May.
  const utcHour = hour - 2;
  const iso = `${yyyy}-${mm}-${dd}T${String(utcHour).padStart(2, "0")}:${String(
    minute,
  ).padStart(2, "0")}:00Z`;
  return new Date(iso);
}

const PASSWORD = "demo1234";

async function main() {
  const prisma = getPrisma();
  console.log("Seeding synthetic data…");

  // ---------- owner user (upsert) -----------------------------------------
  const ownerHash = await hashPassword(PASSWORD);
  const owner = await prisma.user.upsert({
    where: { email: OWNER_EMAIL },
    update: { name: OWNER_NAME },
    create: { email: OWNER_EMAIL, name: OWNER_NAME, passwordHash: ownerHash },
  });
  console.log(`Owner: ${owner.email} (id=${owner.id})`);

  // ---------- wipe any prior demo conference ------------------------------
  await prisma.conference.deleteMany({ where: { slug: CONFERENCE_SLUG } });

  // ---------- conference --------------------------------------------------
  const conf = await prisma.conference.create({
    data: {
      name: CONFERENCE_NAME,
      slug: CONFERENCE_SLUG,
      ownerId: owner.id,
      designSystem: "github",
      timezone: TIMEZONE,
      mixerAvoidRepeatsDefault: true,
      submissionMaxPlacementsDefault: 1,
      participantSubmissionsEnabled: true,
    },
  });
  console.log(`Conference: ${conf.slug} (id=${conf.id})`);

  // ---------- join link ---------------------------------------------------
  await prisma.conferenceJoinLink.create({
    data: {
      conferenceId: conf.id,
      token: "demo-join-" + crypto.randomUUID().slice(0, 12),
      enabled: true,
      maxUses: 50,
      usedCount: 3,
    },
  });

  // ---------- identities --------------------------------------------------
  const sharedHash = await hashPassword(PASSWORD);

  type IdSpec = {
    email: string;
    name: string;
    role: "participant" | "moderator";
    claimed?: boolean;
  };

  // Nico's per-conference identity is the auto-minted owner row. Created
  // upfront so seeded stars/submissions/etc. can reference it.
  const nicoIdentity = await prisma.conferenceIdentity.create({
    data: {
      conferenceId: conf.id,
      email: owner.email,
      name: owner.name,
      passwordHash: null,
      role: "participant",
      ownerUserId: owner.id,
      claimedAt: new Date(),
      calendarToken: "demo-cal-" + crypto.randomUUID().slice(0, 16),
      colorMode: "auto",
    },
  });

  const peopleSpec: IdSpec[] = [
    { email: "alice@example.com",  name: "Alice Adams",       role: "moderator" },
    { email: "bob@example.com",    name: "Bob Becker",        role: "moderator" },
    { email: "carla@example.com",  name: "Carla Costa",       role: "participant" },
    { email: "daniel@example.com", name: "Daniel Diaz",       role: "participant" },
    { email: "erin@example.com",   name: "Erin Edwards",      role: "participant" },
    { email: "felix@example.com",  name: "Felix Fischer",     role: "participant" },
    { email: "gabi@example.com",   name: "Gabriela Gomez",    role: "participant" },
    { email: "henry@example.com",  name: "Henry Hayes",       role: "participant" },
    { email: "iris@example.com",   name: "Iris Ivanov",       role: "participant" },
    { email: "jamal@example.com",  name: "Jamal Jenkins",     role: "participant" },
    { email: "kira@example.com",   name: "Kira Klein",        role: "participant" },
    { email: "luca@example.com",   name: "Luca Lopez",        role: "participant" },
    { email: "maya@example.com",   name: "Maya Mitchell",     role: "participant" },
    { email: "noah@example.com",   name: "Noah Novak",        role: "participant" },
    { email: "olive@example.com",  name: "Olive Owens",       role: "participant" },
    { email: "paul@example.com",   name: "Paul Park",         role: "participant" },
  ];

  const peopleByEmail = new Map<string, { id: number; name: string; email: string }>();
  peopleByEmail.set(nicoIdentity.email, { id: nicoIdentity.id, name: nicoIdentity.name!, email: nicoIdentity.email });

  for (const p of peopleSpec) {
    const row = await prisma.conferenceIdentity.create({
      data: {
        conferenceId: conf.id,
        email: p.email,
        name: p.name,
        passwordHash: sharedHash,
        role: p.role,
        claimedAt: new Date(),
        calendarToken: "demo-cal-" + crypto.randomUUID().slice(0, 16),
        colorMode: "auto",
      },
    });
    peopleByEmail.set(p.email, { id: row.id, name: row.name!, email: row.email });
  }

  // Pending invites (some participants haven't joined yet).
  const invites = [
    { email: "pending.parker@example.com", role: "participant" as const },
    { email: "pending.quinn@example.com",  role: "participant" as const },
    { email: "pending.rivera@example.com", role: "moderator"   as const },
  ];
  for (const inv of invites) {
    await prisma.conferenceInvite.create({
      data: {
        conferenceId: conf.id,
        email: inv.email,
        token: "inv-" + crypto.randomUUID().slice(0, 16),
        role: inv.role,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60_000),
      },
    });
  }

  // ---------- rooms -------------------------------------------------------
  const roomSpec = [
    { name: "Main Hall",   capacity: 120, description: "Auditorium on the ground floor, step-free access.", tags: ["projector", "wheelchair-accessible"] },
    { name: "Workshop A",  capacity: 24,  description: "Bright room with whiteboards.",                       tags: ["whiteboard", "projector"] },
    { name: "Workshop B",  capacity: 20,  description: "Cozy room above the cafe.",                           tags: ["whiteboard"] },
    { name: "Lab 1",       capacity: 12,  description: "Hands-on lab with desktop machines.",                 tags: ["computers", "ground-floor"] },
    { name: "Lab 2",       capacity: 12,  description: "Mirror of Lab 1.",                                    tags: ["computers"] },
    { name: "Quiet Room",  capacity: 8,   description: "Small room reserved for 1:1 conversations.",          tags: ["quiet"] },
    { name: "Cafeteria",   capacity: 80,  description: "Tables, snacks and coffee on tap.",                   tags: ["food"] },
    { name: "Lounge",      capacity: 15,  description: "Sofas and bean bags.",                                tags: ["informal"] },
  ];
  const rooms: { id: number; name: string; capacity: number }[] = [];
  for (const r of roomSpec) {
    const row = await prisma.room.create({
      data: {
        conferenceId: conf.id,
        name: r.name,
        capacity: r.capacity,
        description: r.description,
        tags: { create: r.tags.map((value) => ({ value })) },
      },
    });
    rooms.push({ id: row.id, name: row.name, capacity: row.capacity });
  }
  const roomByName = (n: string) => rooms.find((r) => r.name === n)!;

  // ---------- submissions -------------------------------------------------
  type SubSpec = {
    title: string;
    description: string;
    submitter: string; // email
    status: "submitted" | "published" | "rejected";
    tags?: string[];
    requirements?: string[];
    maxPlacements?: number | null; // undefined = inherit default (=1)
    manuallyFinished?: boolean;
    // --- assignment controls (mod-set) -------------------------------------
    // Mod pin: the room name to pin this submission to. Resolved against the
    // already-created `rooms` array at insert time.
    preAssignedRoomName?: string;
    // Required room features (tag values). Must match an existing room tag.
    roomRequirements?: string[];
    // Lets the session be placed in overlapping slots (recurring workshops).
    allowOverlappingPlacements?: boolean;
  };
  const submissionsSpec: SubSpec[] = [
    { title: "Modern TypeScript in 2026", submitter: "alice@example.com",
      description: "A whirlwind tour of the type system features that finally feel ergonomic.",
      status: "published", tags: ["workshop", "frontend"], requirements: ["laptop", "github account"] },
    { title: "Distributed systems debugging", submitter: "bob@example.com",
      description: "War stories from a year of debugging at scale.",
      status: "published", tags: ["talk", "backend"] },
    { title: "Sourdough hacking", submitter: "carla@example.com",
      description: "What yeast taught me about CI/CD.",
      status: "published", tags: ["lightning", "fun"] },
    { title: "The art of code review", submitter: "daniel@example.com",
      description: "How to give feedback that actually lands.",
      status: "published", tags: ["discussion"] },
    { title: "From REST to GraphQL: a journey", submitter: "erin@example.com",
      description: "Migrating a production API with no downtime.",
      status: "published", tags: ["talk", "api"], maxPlacements: 2 },
    { title: "Living off the land: shell tricks", submitter: "felix@example.com",
      description: "Awk, sed and friends.",
      status: "published", tags: ["lightning"], requirements: ["terminal"] },
    { title: "Designing better APIs", submitter: "gabi@example.com",
      description: "Six years of API design mistakes condensed into one hour.",
      status: "published", tags: ["workshop", "api"] },
    { title: "Vim vs Emacs: a fair fight",      submitter: "henry@example.com",
      description: "Spoiler: nobody wins.",
      status: "published", tags: ["discussion"], manuallyFinished: true },
    { title: "WebAssembly in production",        submitter: "iris@example.com",
      description: "Wasm beyond the demos.",
      status: "published", tags: ["talk", "frontend"] },
    { title: "Building reliable distributed databases", submitter: "jamal@example.com",
      description: "Consensus, replication, and where they go wrong.",
      status: "published", tags: ["talk", "backend"] },
    { title: "Open source sustainability", submitter: "kira@example.com",
      description: "How to keep a project alive past the hype cycle.",
      status: "published", tags: ["discussion"] },
    { title: "Functional patterns in Go", submitter: "luca@example.com",
      description: "Yes, you can do FP in Go. Should you?",
      status: "published", tags: ["talk", "backend"] },
    { title: "Mobile-first dev workflow", submitter: "maya@example.com",
      description: "Editing code on an iPad, unironically.",
      status: "published", tags: ["lightning"] },
    { title: "Beyond unit tests", submitter: "noah@example.com",
      description: "Property tests, fuzzing and contract tests.",
      status: "submitted", tags: ["workshop"] },
    { title: "Why I love SQL", submitter: "olive@example.com",
      description: "Window functions are a love language.",
      status: "submitted", tags: ["talk"] },
    { title: "The startup spirit", submitter: "carla@example.com",
      description: "How to keep momentum after the seed round.",
      status: "submitted", tags: ["discussion"] },
    { title: "Cryptocurrency rant", submitter: "henry@example.com",
      description: "Strong opinions, weakly held.",
      status: "rejected", tags: ["discussion"] },
    { title: "10x developer manifesto", submitter: "felix@example.com",
      description: "(do not approve)",
      status: "rejected", tags: ["talk"] },

    // ----- Demo: conflict-triggering submissions (for testing the resolve
    // panel UI). These are scoped to the "Conflict demo" unconference slot
    // created below; running that slot's assignment will surface both a
    // `duplicate_room` conflict (two sessions pinned to Main Hall) and an
    // `unsatisfiable_requirements` conflict (a session needing projector +
    // whiteboard whose only matching room is also pinned). The "Recurring
    // Workshop" submission has `allowOverlappingPlacements: true` so you
    // can verify the "allows overlap" badge + behavior.
    { title: "Demo: Live Coding Showcase", submitter: "alice@example.com",
      description: "Pinned to Main Hall (will collide with the next demo session).",
      status: "published", tags: ["demo"],
      preAssignedRoomName: "Main Hall" },
    { title: "Demo: Keynote Encore", submitter: "bob@example.com",
      description: "Also pinned to Main Hall — triggers a duplicate-room conflict.",
      status: "published", tags: ["demo"],
      preAssignedRoomName: "Main Hall" },
    { title: "Demo: Multimedia Workshop", submitter: "gabi@example.com",
      description: "Needs both projector AND whiteboard. Only Workshop A satisfies that — and Workshop A is pinned to another session in the demo, so this one will surface as `unsatisfiable_requirements`.",
      status: "published", tags: ["demo"],
      roomRequirements: ["projector", "whiteboard"] },
    { title: "Demo: Pinned to Workshop A", submitter: "carla@example.com",
      description: "Pinned to Workshop A so the Multimedia Workshop's tag matching can't find a free projector+whiteboard room.",
      status: "published", tags: ["demo"],
      preAssignedRoomName: "Workshop A" },
    { title: "Demo: Recurring Workshop", submitter: "daniel@example.com",
      description: "Has `allow_overlapping_placements` on — can be scheduled in overlapping slots.",
      status: "published", tags: ["demo"], maxPlacements: null,
      allowOverlappingPlacements: true },
  ];

  const submissions: { id: number; title: string; submitterId: number; status: string }[] = [];
  for (const s of submissionsSpec) {
    const submitter = peopleByEmail.get(s.submitter)!;
    const pinnedRoomId = s.preAssignedRoomName
      ? roomByName(s.preAssignedRoomName).id
      : null;
    const row = await prisma.submission.create({
      data: {
        conferenceId: conf.id,
        submitterId: submitter.id,
        title: s.title,
        description: s.description,
        status: s.status,
        maxPlacements: s.maxPlacements,
        manuallyFinished: s.manuallyFinished ?? false,
        preAssignedRoomId: pinnedRoomId,
        allowOverlappingPlacements: s.allowOverlappingPlacements ?? false,
        tags: s.tags ? { create: s.tags.map((value) => ({ value })) } : undefined,
        requirements: s.requirements
          ? { create: s.requirements.map((value) => ({ value })) }
          : undefined,
        roomRequirements: s.roomRequirements
          ? { create: s.roomRequirements.map((value) => ({ value })) }
          : undefined,
      },
    });
    submissions.push({ id: row.id, title: row.title, submitterId: row.submitterId, status: row.status });
  }
  const subByTitle = (t: string) => submissions.find((s) => s.title === t)!;

  // ---------- stars on submissions ----------------------------------------
  // Spread stars so popularity is uneven (a handful of clear favourites,
  // many with 0-2 stars, a few unstarred). Stars by Nico make his
  // schedule interesting.
  const starGraph: Array<[email: string, titles: string[]]> = [
    [OWNER_EMAIL,           ["Modern TypeScript in 2026", "Distributed systems debugging", "From REST to GraphQL: a journey", "Designing better APIs", "WebAssembly in production"]],
    ["alice@example.com",   ["Distributed systems debugging", "From REST to GraphQL: a journey", "The art of code review"]],
    ["bob@example.com",     ["Modern TypeScript in 2026", "Designing better APIs", "Functional patterns in Go"]],
    ["carla@example.com",   ["Modern TypeScript in 2026", "Sourdough hacking", "Living off the land: shell tricks"]],
    ["daniel@example.com",  ["Modern TypeScript in 2026", "The art of code review", "Designing better APIs", "Open source sustainability"]],
    ["erin@example.com",    ["Modern TypeScript in 2026", "From REST to GraphQL: a journey", "WebAssembly in production"]],
    ["felix@example.com",   ["Distributed systems debugging", "Living off the land: shell tricks", "Building reliable distributed databases"]],
    ["gabi@example.com",    ["Designing better APIs", "WebAssembly in production", "Mobile-first dev workflow"]],
    ["henry@example.com",   ["The art of code review", "Open source sustainability"]],
    ["iris@example.com",    ["WebAssembly in production", "Modern TypeScript in 2026", "From REST to GraphQL: a journey"]],
    ["jamal@example.com",   ["Building reliable distributed databases", "Distributed systems debugging"]],
    ["kira@example.com",    ["Open source sustainability", "The art of code review", "Designing better APIs"]],
    ["luca@example.com",    ["Functional patterns in Go", "Distributed systems debugging"]],
    ["maya@example.com",    ["Mobile-first dev workflow", "Modern TypeScript in 2026"]],
    ["noah@example.com",    ["The art of code review"]],
    ["olive@example.com",   ["Designing better APIs", "From REST to GraphQL: a journey"]],
    ["paul@example.com",    []], // intentionally unstarred — shows the "no stars yet" hint
  ];
  for (const [email, titles] of starGraph) {
    const who = peopleByEmail.get(email)!;
    for (const t of titles) {
      const sub = subByTitle(t);
      if (sub.status !== "published") continue;
      await prisma.star.create({ data: { userId: who.id, submissionId: sub.id } });
    }
  }

  // ---------- agenda slots ------------------------------------------------
  // Day 1 = tomorrow (relative to "today" at run time).
  const D1 = 1;
  const D2 = 2;

  // S1 — Opening keynote (normal, single mandatory track)
  const sOpening = await prisma.agendaSlot.create({
    data: {
      conferenceId: conf.id, type: "normal",
      title: "Opening", description: "Welcome to TechSummit 2026.",
      startsAt: dayInTz(D1, 9, 0), endsAt: dayInTz(D1, 9, 30),
    },
  });
  const trkOpening = await prisma.trackAssignment.create({
    data: {
      slotId: sOpening.id, roomId: roomByName("Main Hall").id,
      submissionId: null, title: "Opening: Welcome to TechSummit 2026",
      speakers: "Nico Enking", mandatory: true,
    },
  });
  void trkOpening;

  // S2 — Workshop block (normal, three tracks, one with extra TrackRequirements)
  const sWorkshop = await prisma.agendaSlot.create({
    data: {
      conferenceId: conf.id, type: "normal",
      title: "Workshop block", description: "Pick a workshop or hop between rooms.",
      startsAt: dayInTz(D1, 9, 30), endsAt: dayInTz(D1, 10, 30),
    },
  });
  const trkTS = await prisma.trackAssignment.create({
    data: {
      slotId: sWorkshop.id, roomId: roomByName("Workshop A").id,
      submissionId: subByTitle("Modern TypeScript in 2026").id,
      requirements: { create: [{ value: "laptop" }, { value: "node 22+" }] },
    },
  });
  await prisma.trackAssignment.create({
    data: {
      slotId: sWorkshop.id, roomId: roomByName("Main Hall").id,
      submissionId: subByTitle("From REST to GraphQL: a journey").id,
    },
  });
  await prisma.trackAssignment.create({
    data: {
      slotId: sWorkshop.id, roomId: roomByName("Lab 1").id,
      submissionId: subByTitle("Designing better APIs").id,
    },
  });
  // Static-star the TypeScript track for Nico + a few others (so his
  // calendar shows it, and Sessions/Agenda show non-zero static stars).
  for (const email of [OWNER_EMAIL, "carla@example.com", "daniel@example.com", "iris@example.com"]) {
    await prisma.staticStar.create({
      data: { userId: peopleByEmail.get(email)!.id, trackId: trkTS.id },
    });
  }

  // S3 — Coffee mixer #1 (mixer, exclusive)
  const sMixer1 = await prisma.agendaSlot.create({
    data: {
      conferenceId: conf.id, type: "mixer",
      title: "Coffee mixer", description: "20-minute icebreaker; you'll be assigned a room.",
      startsAt: dayInTz(D1, 10, 30), endsAt: dayInTz(D1, 11, 0),
      unconfUseAllRooms: false,
      mixerAvoidRepeats: true,
      selectedRooms: {
        create: [
          { roomId: roomByName("Lounge").id },
          { roomId: roomByName("Workshop A").id },
          { roomId: roomByName("Workshop B").id },
          { roomId: roomByName("Lab 1").id },
        ],
      },
    },
  });
  const mixer1Rooms = [
    roomByName("Lounge"),
    roomByName("Workshop A"),
    roomByName("Workshop B"),
    roomByName("Lab 1"),
  ];
  const allUserIds = [nicoIdentity.id, ...peopleSpec.map((p) => peopleByEmail.get(p.email)!.id)];
  const mixer1 = assignMixerSlot({
    rooms: mixer1Rooms.map((r) => ({ id: r.id, capacity: r.capacity })),
    userIds: allUserIds,
    seed: sMixer1.id,
  });
  for (const a of mixer1.room_assignments) {
    await prisma.userAssignment.create({
      data: { slotId: sMixer1.id, userId: a.user_id, roomId: a.room_id },
    });
  }
  // Build pair history for the next "exclusive" mixer to consume.
  const priorPairings = new Set<string>();
  {
    const byRoom = new Map<number, number[]>();
    for (const a of mixer1.room_assignments) {
      if (!byRoom.has(a.room_id)) byRoom.set(a.room_id, []);
      byRoom.get(a.room_id)!.push(a.user_id);
    }
    for (const occupants of byRoom.values()) {
      for (let i = 0; i < occupants.length; i++) {
        for (let j = i + 1; j < occupants.length; j++) {
          priorPairings.add(pairKey(occupants[i]!, occupants[j]!));
        }
      }
    }
  }

  // S4 — Unconference #1 (avoid repeats, all rooms, all submissions)
  const sUnconf1 = await prisma.agendaSlot.create({
    data: {
      conferenceId: conf.id, type: "unconference",
      title: "Unconference round 1", description: null,
      startsAt: dayInTz(D1, 11, 0), endsAt: dayInTz(D1, 12, 0),
      unconfAvoidRepeats: true,
    },
  });
  const publishedSubs = submissions.filter((s) => s.status === "published");
  // Demo (conflict-trigger) submissions live in a dedicated slot below — keep
  // them out of the regular unconference rounds so the main demo data still
  // produces clean placements.
  const isDemoSub = (title: string) => title.startsWith("Demo: ");
  const eligibleSubs1 = publishedSubs
    .filter((s) => s.title !== "Vim vs Emacs: a fair fight") // manually-finished
    .filter((s) => !isDemoSub(s.title));
  const stars1 = new Map<number, Set<number>>();
  for (const [email, titles] of starGraph) {
    const uid = peopleByEmail.get(email)!.id;
    const set = new Set<number>();
    for (const t of titles) {
      const sub = subByTitle(t);
      if (sub.status !== "published") continue;
      if (sub.title === "Vim vs Emacs: a fair fight") continue;
      set.add(sub.id);
    }
    stars1.set(uid, set);
  }
  const unconf1 = assignUnconferenceSlot({
    rooms: rooms.map((r) => ({ id: r.id, capacity: r.capacity })),
    submissions: eligibleSubs1.map((s) => ({ id: s.id, submitter_id: s.submitterId })),
    stars: stars1,
    avoidRepeats: true,
  });
  for (const p of unconf1.placements) {
    await prisma.unconferencePlacement.create({
      data: { slotId: sUnconf1.id, submissionId: p.submission_id, roomId: p.room_id },
    });
  }
  const u1RoomBySub = new Map<number, number>(
    unconf1.placements.map((p) => [p.submission_id, p.room_id]),
  );
  for (const a of unconf1.user_assignments) {
    await prisma.userAssignment.create({
      data: {
        slotId: sUnconf1.id, userId: a.user_id, submissionId: a.submission_id,
        roomId: u1RoomBySub.get(a.submission_id) ?? null,
      },
    });
  }

  // S5 — Lunch (normal, single ad-hoc track)
  const sLunch = await prisma.agendaSlot.create({
    data: {
      conferenceId: conf.id, type: "normal",
      title: "Lunch", description: "Catered in the cafeteria.",
      startsAt: dayInTz(D1, 12, 0), endsAt: dayInTz(D1, 13, 0),
    },
  });
  await prisma.trackAssignment.create({
    data: {
      slotId: sLunch.id, roomId: roomByName("Cafeteria").id,
      title: "Lunch", speakers: null,
    },
  });

  // S6 — Unconference #2 (scoped — selected rooms + subs; leaves people unplaced)
  const scopedRooms = [roomByName("Workshop B"), roomByName("Lab 2"), roomByName("Lounge")];
  const scopedSubs = [
    subByTitle("Sourdough hacking"),
    subByTitle("Mobile-first dev workflow"),
    subByTitle("Functional patterns in Go"),
  ];
  const sUnconf2 = await prisma.agendaSlot.create({
    data: {
      conferenceId: conf.id, type: "unconference",
      title: "Unconference round 2 (scoped)",
      description: "Smaller rooms; fewer submissions.",
      startsAt: dayInTz(D1, 13, 0), endsAt: dayInTz(D1, 14, 0),
      unconfUseAllRooms: false,
      unconfUseAllSubmissions: false,
      unconfAvoidRepeats: true,
      selectedRooms: {
        create: scopedRooms.map((r) => ({ roomId: r.id })),
      },
      selectedSubmissions: {
        create: scopedSubs.map((s) => ({ submissionId: s.id })),
      },
    },
  });
  // Build a stars map where Nico has stars only on submissions outside the
  // scoped pool, so his identity ends up unplaced and "Pick a session"
  // shows on his My Assignments tab.
  const stars2 = new Map<number, Set<number>>();
  for (const uid of allUserIds) {
    const set = new Set<number>();
    if (uid !== nicoIdentity.id && uid !== peopleByEmail.get("paul@example.com")!.id) {
      // Give everyone else a star on one of the scoped subs so they get placed.
      const pickedIdx = (uid + sUnconf2.id) % scopedSubs.length;
      set.add(scopedSubs[pickedIdx]!.id);
    }
    stars2.set(uid, set);
  }
  // Prior assignments from Unconf#1, fed into avoid-repeats.
  const priorBySlot = new Map<number, Set<number>>();
  for (const a of unconf1.user_assignments) {
    if (!priorBySlot.has(a.user_id)) priorBySlot.set(a.user_id, new Set());
    priorBySlot.get(a.user_id)!.add(a.submission_id);
  }
  const unconf2 = assignUnconferenceSlot({
    rooms: scopedRooms.map((r) => ({ id: r.id, capacity: r.capacity })),
    submissions: scopedSubs.map((s) => ({ id: s.id, submitter_id: s.submitterId })),
    stars: stars2,
    priorAssignments: priorBySlot,
    avoidRepeats: true,
  });
  for (const p of unconf2.placements) {
    await prisma.unconferencePlacement.create({
      data: { slotId: sUnconf2.id, submissionId: p.submission_id, roomId: p.room_id },
    });
  }
  const u2RoomBySub = new Map<number, number>(
    unconf2.placements.map((p) => [p.submission_id, p.room_id]),
  );
  for (const a of unconf2.user_assignments) {
    await prisma.userAssignment.create({
      data: {
        slotId: sUnconf2.id, userId: a.user_id, submissionId: a.submission_id,
        roomId: u2RoomBySub.get(a.submission_id) ?? null,
      },
    });
  }
  // Promote one user-assignment in Unconf #1 to "manual" so the manual-pick
  // pill is visible somewhere.
  const manualVictim = unconf1.user_assignments.find(
    (a) => a.user_id === peopleByEmail.get("kira@example.com")!.id,
  );
  if (manualVictim) {
    await prisma.userAssignment.update({
      where: { slotId_userId: { slotId: sUnconf1.id, userId: manualVictim.user_id } },
      data: { manual: true },
    });
  }

  // S6.5 — Conflict-demo unconference slot (intentionally NOT pre-run so
  // moderators can click "Run assignment" and exercise the resolve panel).
  //
  // Scoped to the "Demo: …" submissions seeded above:
  //   - Two sessions pinned to Main Hall  → duplicate_room conflict.
  //   - "Demo: Pinned to Workshop A"      → claims Workshop A.
  //   - "Demo: Multimedia Workshop"       → needs projector+whiteboard
  //     (only Workshop A satisfies both, and it's pinned) →
  //     unsatisfiable_requirements conflict.
  //   - "Demo: Recurring Workshop"        → flagged allow-overlap (mostly
  //     here so the badge shows somewhere).
  const demoSubs = submissions.filter((s) => s.title.startsWith("Demo: "));
  const demoRoomSet = [
    roomByName("Main Hall"),
    roomByName("Workshop A"),
    roomByName("Workshop B"),
    roomByName("Lab 1"),
  ];
  await prisma.agendaSlot.create({
    data: {
      conferenceId: conf.id, type: "unconference",
      title: "Unconference round 3 (conflict demo)",
      description: "Click 'Run assignment' to surface a duplicate-room conflict and an unmet-requirements conflict — built for testing the resolve panel.",
      startsAt: dayInTz(D1, 15, 0), endsAt: dayInTz(D1, 16, 0),
      unconfUseAllRooms: false,
      unconfUseAllSubmissions: false,
      unconfAvoidRepeats: true,
      selectedRooms: {
        create: demoRoomSet.map((r) => ({ roomId: r.id })),
      },
      selectedSubmissions: {
        create: demoSubs.map((s) => ({ submissionId: s.id })),
      },
    },
  });

  // S7 — Coffee mixer #2 (mixer, NOT YET RUN — moderator UI shows "run mixer")
  await prisma.agendaSlot.create({
    data: {
      conferenceId: conf.id, type: "mixer",
      title: "Afternoon mixer",
      description: "Fresh shuffle: ignores earlier mixers.",
      startsAt: dayInTz(D1, 14, 0), endsAt: dayInTz(D1, 14, 30),
      unconfUseAllRooms: false,
      mixerAvoidRepeats: false,
      selectedRooms: {
        create: [
          { roomId: roomByName("Lounge").id },
          { roomId: roomByName("Workshop A").id },
          { roomId: roomByName("Cafeteria").id },
        ],
      },
    },
  });

  // S8 — Unconference #3 (NOT YET RUN — moderator UI shows "run assignment")
  await prisma.agendaSlot.create({
    data: {
      conferenceId: conf.id, type: "unconference",
      title: "Unconference round 3",
      description: "Star sessions you want to see.",
      startsAt: dayInTz(D1, 14, 30), endsAt: dayInTz(D1, 15, 30),
      unconfAvoidRepeats: true,
    },
  });

  // S9 — Day 1 wrap (normal)
  const sWrap = await prisma.agendaSlot.create({
    data: {
      conferenceId: conf.id, type: "normal",
      title: "Day 1 wrap", description: "Day 1 retrospective and demos.",
      startsAt: dayInTz(D1, 16, 0), endsAt: dayInTz(D1, 17, 0),
    },
  });
  await prisma.trackAssignment.create({
    data: {
      slotId: sWrap.id, roomId: roomByName("Main Hall").id,
      title: "Demos + open mic", speakers: "Alice Adams, Bob Becker",
    },
  });

  // ----- Day 2 ------------------------------------------------------------
  // S10 — Morning mixer (ran; exclusive, consumes prior pairings)
  const sMixer2 = await prisma.agendaSlot.create({
    data: {
      conferenceId: conf.id, type: "mixer",
      title: "Morning mixer", description: "Different room, different people.",
      startsAt: dayInTz(D2, 9, 0), endsAt: dayInTz(D2, 9, 30),
      unconfUseAllRooms: false,
      mixerAvoidRepeats: true,
      selectedRooms: {
        create: [
          { roomId: roomByName("Workshop A").id },
          { roomId: roomByName("Workshop B").id },
          { roomId: roomByName("Lab 2").id },
          { roomId: roomByName("Lounge").id },
        ],
      },
    },
  });
  const mixer2Rooms = [
    roomByName("Workshop A"),
    roomByName("Workshop B"),
    roomByName("Lab 2"),
    roomByName("Lounge"),
  ];
  const mixer2 = assignMixerSlot({
    rooms: mixer2Rooms.map((r) => ({ id: r.id, capacity: r.capacity })),
    userIds: allUserIds,
    seed: sMixer2.id,
    priorPairings,
  });
  for (const a of mixer2.room_assignments) {
    await prisma.userAssignment.create({
      data: { slotId: sMixer2.id, userId: a.user_id, roomId: a.room_id },
    });
  }

  // S11 — Hackathon block (normal, two parallel tracks, long slot, requirements)
  const sHack = await prisma.agendaSlot.create({
    data: {
      conferenceId: conf.id, type: "normal",
      title: "Hackathon block",
      description: "Two hour collaborative build.",
      startsAt: dayInTz(D2, 10, 0), endsAt: dayInTz(D2, 12, 0),
    },
  });
  await prisma.trackAssignment.create({
    data: {
      slotId: sHack.id, roomId: roomByName("Lab 1").id,
      submissionId: subByTitle("WebAssembly in production").id,
      requirements: { create: [{ value: "laptop" }, { value: "rust toolchain" }] },
    },
  });
  await prisma.trackAssignment.create({
    data: {
      slotId: sHack.id, roomId: roomByName("Lab 2").id,
      submissionId: subByTitle("Building reliable distributed databases").id,
    },
  });

  // S12 — Closing keynote (normal, mandatory)
  const sClose = await prisma.agendaSlot.create({
    data: {
      conferenceId: conf.id, type: "normal",
      title: "Closing keynote",
      description: "Closing remarks + raffle.",
      startsAt: dayInTz(D2, 14, 0), endsAt: dayInTz(D2, 15, 0),
    },
  });
  await prisma.trackAssignment.create({
    data: {
      slotId: sClose.id, roomId: roomByName("Main Hall").id,
      title: "Closing keynote", speakers: "Surprise guest",
      mandatory: true,
    },
  });

  // ---------- experts ----------------------------------------------------
  const pool = await prisma.expertRoomPool.create({
    data: {
      conferenceId: conf.id,
      name: "Expert Corner",
      rooms: {
        create: [
          { roomId: roomByName("Quiet Room").id },
          { roomId: roomByName("Lounge").id },
        ],
      },
    },
  });

  async function makeExpert(emailKey: string, bio: string, opts: { poolId?: number; roomNames?: string[] }) {
    const id = peopleByEmail.get(emailKey)!.id;
    const expert = await prisma.expert.create({
      data: {
        conferenceId: conf.id,
        identityId: id,
        bio,
        poolId: opts.poolId ?? null,
        rooms: opts.roomNames
          ? { create: opts.roomNames.map((n) => ({ roomId: roomByName(n).id })) }
          : undefined,
      },
    });
    return expert;
  }

  const expertAlice = await makeExpert("alice@example.com", "TypeScript, React, design systems. Happy to talk about types you don't love yet.", { poolId: pool.id });
  const expertBob = await makeExpert("bob@example.com", "Distributed systems, observability and oncall sanity.", { poolId: pool.id });
  const expertIris = await makeExpert("iris@example.com", "WebAssembly, low-level Rust, and crossing the wasm/JS boundary.", { roomNames: ["Lab 2"] });

  // Timeframes: tomorrow 13:00-14:00 (3x 20-min slots) for everyone, plus
  // a day-2 11:00-12:00 set.
  async function timeframe(expertId: number, day: number, hour: number, mins: number, dur: number) {
    return prisma.expertTimeframe.create({
      data: {
        expertId,
        startsAt: dayInTz(day, hour, mins),
        endsAt: dayInTz(day, hour + Math.floor((mins + dur * 60) / 3600), (mins + dur * 60) % 3600),
        slotDurationMinutes: dur,
      },
    });
  }
  async function expertWindow(expertId: number, day: number, startHour: number, endHour: number, durMin: number) {
    return prisma.expertTimeframe.create({
      data: {
        expertId,
        startsAt: dayInTz(day, startHour, 0),
        endsAt: dayInTz(day, endHour, 0),
        slotDurationMinutes: durMin,
      },
    });
  }
  void timeframe;

  const tfAliceD1 = await expertWindow(expertAlice.id, D1, 13, 14, 20);
  const tfAliceD2 = await expertWindow(expertAlice.id, D2, 11, 12, 20);
  const tfBobD1   = await expertWindow(expertBob.id,   D1, 13, 14, 20);
  const tfIrisD1  = await expertWindow(expertIris.id,  D1, 13, 14, 20);
  const tfIrisD2  = await expertWindow(expertIris.id,  D2, 11, 12, 30);

  async function book(expertId: number, tfId: number, bookerEmail: string, day: number, h: number, m: number, durMin: number, roomName: string) {
    await prisma.expertBooking.create({
      data: {
        expertId,
        timeframeId: tfId,
        bookerId: peopleByEmail.get(bookerEmail)!.id,
        roomId: roomByName(roomName).id,
        startsAt: dayInTz(day, h, m),
        endsAt:   dayInTz(day, h + Math.floor((m + durMin) / 60), (m + durMin) % 60),
      },
    });
  }

  // A spread of bookings: Nico books Alice + Iris, others book the rest.
  await book(expertAlice.id, tfAliceD1.id, OWNER_EMAIL,         D1, 13, 0,  20, "Quiet Room");
  await book(expertAlice.id, tfAliceD1.id, "carla@example.com", D1, 13, 20, 20, "Quiet Room");
  await book(expertBob.id,   tfBobD1.id,   "daniel@example.com", D1, 13, 0,  20, "Lounge");
  await book(expertBob.id,   tfBobD1.id,   "kira@example.com",   D1, 13, 40, 20, "Lounge");
  await book(expertIris.id,  tfIrisD1.id,  "henry@example.com",  D1, 13, 0,  20, "Lab 2");
  await book(expertIris.id,  tfIrisD2.id,  OWNER_EMAIL,          D2, 11, 0,  30, "Lab 2");

  void tfAliceD2;

  // ---------- notifications (Nico's inbox) --------------------------------
  const nicoId = nicoIdentity.id;
  type N = Parameters<typeof prisma.notification.create>[0]["data"];
  const notifs: Array<N & { _read?: boolean; _ageMin?: number }> = [
    { identityId: nicoId, kind: "submission_received",
      title: "New submission needs review",
      body: 'Olive Owens submitted "Why I love SQL".',
      ctaLabel: "Review", ctaHref: "tab:sessions", _read: false, _ageMin: 8 },
    { identityId: nicoId, kind: "submission_received",
      title: "New submission needs review",
      body: 'Noah Novak submitted "Beyond unit tests".',
      ctaLabel: "Review", ctaHref: "tab:sessions", _read: false, _ageMin: 47 },
    { identityId: nicoId, kind: "submission_received",
      title: "New submission needs review",
      body: 'Carla Costa submitted "The startup spirit".',
      ctaLabel: "Review", ctaHref: "tab:sessions", _read: false, _ageMin: 130 },
    { identityId: nicoId, kind: "expert_booked",
      title: "Expert chat confirmed",
      body: "Alice Adams · today 13:00-13:20 · Quiet Room",
      ctaLabel: "See schedule", ctaHref: "tab:my-assignments", _read: false, _ageMin: 220 },
    { identityId: nicoId, kind: "expert_booked",
      title: "Expert chat confirmed",
      body: "Iris Ivanov · day 2, 11:00-11:30 · Lab 2",
      ctaLabel: "See schedule", ctaHref: "tab:my-assignments", _read: true, _ageMin: 360 },
    { identityId: nicoId, kind: "unconf_assigned",
      title: "You were placed in an unconference",
      body: "Round 1 · check My Assignments for your room.",
      ctaLabel: "Open", ctaHref: "tab:my-assignments", _read: true, _ageMin: 500 },
    { identityId: nicoId, kind: "mixer_assigned",
      title: "Mixer room assigned",
      body: "Morning mixer (day 2) — your room is waiting.",
      ctaLabel: "Open", ctaHref: "tab:my-assignments", _read: true, _ageMin: 720 },
    { identityId: nicoId, kind: "submission_published",
      title: "Your submission was published",
      body: '"Modern TypeScript in 2026" is now visible to participants.',
      ctaLabel: "View", ctaHref: "tab:sessions", _read: true, _ageMin: 1440 },
  ];
  for (const n of notifs) {
    const { _read, _ageMin, ...data } = n;
    const created = await prisma.notification.create({ data });
    const when = new Date(Date.now() - (_ageMin ?? 0) * 60_000);
    await prisma.notification.update({
      where: { id: created.id },
      data: { createdAt: when, readAt: _read ? new Date(when.getTime() + 5 * 60_000) : null },
    });
  }

  // Also drop a couple of notifications onto another moderator (Alice) so
  // screenshots taken as a different role still show a populated bell.
  const aliceId = peopleByEmail.get("alice@example.com")!.id;
  await prisma.notification.createMany({
    data: [
      { identityId: aliceId, kind: "submission_received",
        title: "New submission needs review",
        body: 'Olive Owens submitted "Why I love SQL".',
        ctaLabel: "Review", ctaHref: "tab:sessions" },
      { identityId: aliceId, kind: "unconf_assigned",
        title: "You were placed in an unconference",
        body: "Round 1 · check My Assignments for your room.",
        ctaLabel: "Open", ctaHref: "tab:my-assignments" },
    ],
  });

  console.log("\nDone.");
  console.log(`  Owner login: ${OWNER_EMAIL} (use your existing password)`);
  console.log(`  Shared participant password: ${PASSWORD}`);
  console.log(`  Conference URL: /c/${CONFERENCE_SLUG}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await getPrisma().$disconnect();
  });
