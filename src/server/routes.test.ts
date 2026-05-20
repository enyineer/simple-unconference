// End-to-end-ish tests that exercise the full oRPC router against a real
// Prisma client + temp SQLite DB. Each describe block creates its own DB
// so tests don't share state.
//
// Identity model: signup/login on `auth.*` is for global *owners* only.
// Participants/moderators inside a conference are minted via the
// invite + claim flow exposed under `conferences.*`. The helper
// `inviteAndClaim(...)` in test-helpers.ts wraps the boilerplate.

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  setupTestApp, Client, ORPCError, type TestApp,
  inviteAndClaim, signupViaJoinLink,
} from "./test-helpers";

async function signupAndLogin(c: Client, email: string, password = "secret123", name = "User") {
  return await c.rpc.auth.signup({ email, password, name });
}

describe("auth flow (global owner)", () => {
  let ctx: TestApp;
  beforeAll(() => { ctx = setupTestApp(); });
  afterAll(async () => { await ctx.cleanup(); });

  test("signup, /me, logout, login again", async () => {
    const c = new Client(ctx.app);
    await signupAndLogin(c, "alice@example.com");

    const me = await c.rpc.auth.me();
    expect(me).toMatchObject({ email: "alice@example.com" });

    await c.rpc.auth.logout();
    await expect(c.rpc.auth.me()).rejects.toBeInstanceOf(ORPCError);

    await c.rpc.auth.login({ email: "alice@example.com", password: "secret123" });
    await c.rpc.auth.me();
  });

  test("signup rejects duplicate email", async () => {
    const c = new Client(ctx.app);
    await signupAndLogin(c, "dup@example.com");
    const c2 = new Client(ctx.app);
    await expect(
      c2.rpc.auth.signup({ email: "dup@example.com", password: "secret123" }),
    ).rejects.toBeInstanceOf(ORPCError);
  });

  test("login rejects wrong password", async () => {
    const c = new Client(ctx.app);
    await signupAndLogin(c, "carol@example.com");
    const c2 = new Client(ctx.app);
    await expect(
      c2.rpc.auth.login({ email: "carol@example.com", password: "wrong" }),
    ).rejects.toBeInstanceOf(ORPCError);
  });
});

describe("conferences + roles", () => {
  let ctx: TestApp;
  beforeAll(() => { ctx = setupTestApp(); });
  afterAll(async () => { await ctx.cleanup(); });

  test("owner creates conference; non-members can't see it; promote moderator works", async () => {
    const owner = new Client(ctx.app);
    await signupAndLogin(owner, "owner@example.com");
    const conf = await owner.rpc.conferences.create({ name: "Mini Unconf" });
    expect(conf.slug).toBe("mini-unconf");

    // Invite Bob and let him claim it.
    const { client: bob, identity_id: bobId } =
      await inviteAndClaim(ctx.app, owner, conf.slug, "bob@example.com");

    // Bob can read conference; cannot create invites.
    const bobView = await bob.rpc.conferences.get({ slug: conf.slug });
    expect(bobView.my_role).toBe("participant");
    expect(bobView.design_system).toBe("github"); // default

    await expect(bob.rpc.conferences.createInvite({
      slug: conf.slug, email: "x@example.com",
    })).rejects.toBeInstanceOf(ORPCError);

    // A stranger (global owner who isn't part of this conference) gets a thrown error.
    const stranger = new Client(ctx.app);
    await signupAndLogin(stranger, "stranger@example.com");
    await expect(stranger.rpc.conferences.get({ slug: conf.slug }))
      .rejects.toBeInstanceOf(ORPCError);

    // Owner promotes Bob to moderator.
    await owner.rpc.conferences.addModerator({ slug: conf.slug, user_id: bobId });

    // Bob can now create invites.
    await bob.rpc.conferences.createInvite({
      slug: conf.slug, email: "newbie@example.com",
    });
  });

  test("conference timezone: round-trips on create/get/patch; invalid TZ rejected", async () => {
    const owner = new Client(ctx.app);
    await signupAndLogin(owner, "tzowner@example.com");

    const created = await owner.rpc.conferences.create({
      name: "TZ Conf", timezone: "Europe/Berlin",
    });
    expect(created.timezone).toBe("Europe/Berlin");

    const info = await owner.rpc.conferences.get({ slug: created.slug });
    expect(info.timezone).toBe("Europe/Berlin");

    await owner.rpc.conferences.update({ slug: created.slug, timezone: "America/New_York" });
    const info2 = await owner.rpc.conferences.get({ slug: created.slug });
    expect(info2.timezone).toBe("America/New_York");

    try {
      await owner.rpc.conferences.update({ slug: created.slug, timezone: "Mars/Olympus" });
      throw new Error("expected to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(ORPCError);
      expect((e as ORPCError<string, unknown>).code).toBe("BAD_REQUEST");
    }

    const r2 = await owner.rpc.conferences.create({ name: "Default TZ" });
    expect(r2.timezone).toBe("UTC");
  });

  test("owner can change conference design system; moderators cannot", async () => {
    const owner = new Client(ctx.app);
    await signupAndLogin(owner, "dsowner@example.com");
    const conf = await owner.rpc.conferences.create({ name: "DS Test" });

    await owner.rpc.conferences.update({ slug: conf.slug, design_system: "minimal" });
    const info = await owner.rpc.conferences.get({ slug: conf.slug });
    expect(info.design_system).toBe("minimal");

    await expect(owner.rpc.conferences.update({ slug: conf.slug, design_system: "bogus" }))
      .rejects.toBeInstanceOf(ORPCError);

    // Promote a participant to moderator and confirm they can't change design.
    const { client: mod, identity_id: modId } =
      await inviteAndClaim(ctx.app, owner, conf.slug, "dsmod@example.com");
    await owner.rpc.conferences.addModerator({ slug: conf.slug, user_id: modId });
    await expect(mod.rpc.conferences.update({ slug: conf.slug, design_system: "github" }))
      .rejects.toBeInstanceOf(ORPCError);
  });

  test("privacy: non-mods can't list participants; submitter_email is stripped for them", async () => {
    const owner = new Client(ctx.app);
    await signupAndLogin(owner, "priv-owner@example.com");
    const conf = await owner.rpc.conferences.create({ name: "Privacy" });

    const { client: alice } =
      await inviteAndClaim(ctx.app, owner, conf.slug, "alice-priv@example.com");
    const { client: bob } =
      await inviteAndClaim(ctx.app, owner, conf.slug, "bob-priv@example.com");

    // Alice publishes a submission.
    const sub = await alice.rpc.submissions.create({ slug: conf.slug, title: "Talk by Alice" });
    await owner.rpc.submissions.publish({ slug: conf.slug, id: sub.id });

    // Bob reads submissions: submitter_email must be null, submitter_name exposed.
    const bobList = await bob.rpc.submissions.list({ slug: conf.slug });
    expect(bobList.length).toBe(1);
    expect(bobList[0]!.submitter_email).toBeNull();
    expect("submitter_name" in bobList[0]!).toBe(true);
    expect(typeof bobList[0]!.submitter_id).toBe("number");

    const ownerList = await owner.rpc.submissions.list({ slug: conf.slug });
    expect(ownerList[0]!.submitter_email).toBe("alice-priv@example.com");

    await expect(bob.rpc.conferences.listParticipants({ slug: conf.slug }))
      .rejects.toBeInstanceOf(ORPCError);
  });

  test("importInvites: bulk-creates invites from one-email-per-line CSV", async () => {
    const owner = new Client(ctx.app);
    await signupAndLogin(owner, "csvowner@example.com");
    const conf = await owner.rpc.conferences.create({ name: "Bulk Invite" });

    const csv = `a@e.com
b@e.com
not-an-email
`;
    const j = await owner.rpc.conferences.importInvites({ slug: conf.slug, csv });
    expect(j.added).toBe(2);
    expect(j.skipped).toBe(1);
    expect(j.invites.length).toBe(2);

    // The invites show up as pending.
    const pending = await owner.rpc.conferences.listInvites({ slug: conf.slug });
    const pendingEmails = new Set(pending.filter((i) => i.claimed_at === null).map((i) => i.email));
    expect(pendingEmails.has("a@e.com")).toBe(true);
    expect(pendingEmails.has("b@e.com")).toBe(true);
  });

  test("rooms support description + tags; PATCH replaces tags atomically", async () => {
    const owner = new Client(ctx.app);
    await signupAndLogin(owner, "roomowner@example.com");
    const conf = await owner.rpc.conferences.create({ name: "Room Edit" });

    const room = await owner.rpc.rooms.create({
      slug: conf.slug,
      name: "Auditorium", capacity: 200,
      description: "Ground floor, near the cafe.",
      tags: ["Projector", "ground floor"],
    });
    expect(room.description).toBe("Ground floor, near the cafe.");
    expect(room.tags).toEqual(["ground floor", "projector"]);

    await owner.rpc.rooms.update({
      slug: conf.slug, id: room.id,
      name: "Main Hall",
      tags: ["projector"],
    });

    const list = await owner.rpc.rooms.list({ slug: conf.slug });
    expect(list[0]!.name).toBe("Main Hall");
    expect(list[0]!.tags).toEqual(["projector"]);
    expect(list[0]!.description).toBe("Ground floor, near the cafe.");

    await owner.rpc.rooms.update({
      slug: conf.slug, id: room.id,
      description: null,
    });
    const list2 = await owner.rpc.rooms.list({ slug: conf.slug });
    expect(list2[0]!.description).toBeNull();
  });

  test("non-owner can't delete moderators or remove owner", async () => {
    const owner = new Client(ctx.app);
    await signupAndLogin(owner, "o2@example.com");
    const conf = await owner.rpc.conferences.create({ name: "Roles Test" });

    const { identity_id: bobId } =
      await inviteAndClaim(ctx.app, owner, conf.slug, "bobr@example.com");
    await owner.rpc.conferences.addModerator({ slug: conf.slug, user_id: bobId });

    const { client: carol } =
      await inviteAndClaim(ctx.app, owner, conf.slug, "carolr@example.com");
    const carolId = (await carol.rpc.conferences.me({ slug: conf.slug })).id;
    await owner.rpc.conferences.addModerator({ slug: conf.slug, user_id: carolId });

    // Carol (moderator) cannot remove Bob (another moderator).
    await expect(carol.rpc.conferences.removeParticipant({ slug: conf.slug, user_id: bobId }))
      .rejects.toBeInstanceOf(ORPCError);

    // Try to remove the owner's identity row: find it via listParticipants.
    const all = await owner.rpc.conferences.listParticipants({ slug: conf.slug });
    const ownerRow = all.find((p) => p.role === "owner");
    expect(ownerRow).toBeTruthy();
    await expect(carol.rpc.conferences.removeParticipant({ slug: conf.slug, user_id: ownerRow!.user_id }))
      .rejects.toBeInstanceOf(ORPCError);
  });

  test("owner can rename the conference; non-owners cannot", async () => {
    const owner = new Client(ctx.app);
    await signupAndLogin(owner, "renameowner@example.com");
    const conf = await owner.rpc.conferences.create({ name: "Old Name" });

    await owner.rpc.conferences.update({ slug: conf.slug, name: "New Name" });
    const after = await owner.rpc.conferences.get({ slug: conf.slug });
    expect(after.name).toBe("New Name");

    // Moderators don't get to rename — `conferences.update` is owner-only.
    const { client: mod } =
      await inviteAndClaim(ctx.app, owner, conf.slug, "renamemod@example.com");
    const modId = (await mod.rpc.conferences.me({ slug: conf.slug })).id;
    await owner.rpc.conferences.addModerator({ slug: conf.slug, user_id: modId });
    await expect(mod.rpc.conferences.update({ slug: conf.slug, name: "Hijacked" }))
      .rejects.toBeInstanceOf(ORPCError);

    // Empty/whitespace names are rejected at the schema layer.
    await expect(owner.rpc.conferences.update({ slug: conf.slug, name: "   " }))
      .rejects.toBeInstanceOf(ORPCError);
  });

  test("owner can delete the conference; non-owners cannot; cascades wipe related rows", async () => {
    const owner = new Client(ctx.app);
    await signupAndLogin(owner, "delowner@example.com");
    const conf = await owner.rpc.conferences.create({ name: "Doomed" });
    await owner.rpc.rooms.create({ slug: conf.slug, name: "R1", capacity: 10 });
    const { client: part } =
      await inviteAndClaim(ctx.app, owner, conf.slug, "delpart@example.com");
    await part.rpc.submissions.create({ slug: conf.slug, title: "Talk" });

    // Promote a moderator and confirm they still can't delete.
    const { client: mod } =
      await inviteAndClaim(ctx.app, owner, conf.slug, "delmod@example.com");
    const modId = (await mod.rpc.conferences.me({ slug: conf.slug })).id;
    await owner.rpc.conferences.addModerator({ slug: conf.slug, user_id: modId });
    await expect(mod.rpc.conferences.delete({ slug: conf.slug }))
      .rejects.toBeInstanceOf(ORPCError);
    await expect(part.rpc.conferences.delete({ slug: conf.slug }))
      .rejects.toBeInstanceOf(ORPCError);

    // Owner can. After deletion the slug is gone, so .get 404s, and the
    // owner's global account is still around to start a fresh conference.
    await owner.rpc.conferences.delete({ slug: conf.slug });
    await expect(owner.rpc.conferences.get({ slug: conf.slug }))
      .rejects.toBeInstanceOf(ORPCError);
    const list = await owner.rpc.conferences.list();
    expect(list.find((c) => c.slug === conf.slug)).toBeUndefined();

    // Re-using the same name still works (slug uniqueness is the constraint).
    const fresh = await owner.rpc.conferences.create({ name: "Doomed" });
    expect(fresh.slug).toBeTruthy();
  });
});

describe("submissions + stars + publish", () => {
  let ctx: TestApp;
  beforeAll(() => { ctx = setupTestApp(); });
  afterAll(async () => { await ctx.cleanup(); });

  test("tags + requirements: submitter sets them; mod edits another user's submission", async () => {
    const owner = new Client(ctx.app);
    await signupAndLogin(owner, "tagowner@example.com");
    const conf = await owner.rpc.conferences.create({ name: "Tag Test" });

    const { client: part } =
      await inviteAndClaim(ctx.app, owner, conf.slug, "tagpart@example.com");

    const sub = await part.rpc.submissions.create({
      slug: conf.slug,
      title: "Workshop time",
      description: "hands-on",
      tags: ["Workshop", " discussion "],
      requirements: ["Laptop", "GitHub Account"],
    });

    await owner.rpc.submissions.publish({ slug: conf.slug, id: sub.id });

    const partList = await part.rpc.submissions.list({ slug: conf.slug });
    expect(partList.length).toBe(1);
    expect(partList[0]!.tags).toEqual(["discussion", "workshop"]);
    expect(partList[0]!.requirements).toEqual(["github account", "laptop"]);

    await owner.rpc.submissions.update({
      slug: conf.slug, id: sub.id,
      title: "Updated workshop",
      tags: ["workshop"],
    });

    const after = await owner.rpc.submissions.list({ slug: conf.slug });
    expect(after[0]!.title).toBe("Updated workshop");
    expect(after[0]!.tags).toEqual(["workshop"]);
    expect(after[0]!.requirements).toEqual(["github account", "laptop"]);

    await expect(owner.rpc.submissions.update({
      slug: conf.slug, id: sub.id, tags: ["a,b"],
    })).rejects.toBeInstanceOf(ORPCError);

    // A third participant can't edit someone else's submission.
    const { client: other } =
      await inviteAndClaim(ctx.app, owner, conf.slug, "tagother@example.com");
    await expect(other.rpc.submissions.update({
      slug: conf.slug, id: sub.id, title: "hacked",
    })).rejects.toBeInstanceOf(ORPCError);
  });

  test("participants submit; only mods can publish; stars require published", async () => {
    const owner = new Client(ctx.app);
    await signupAndLogin(owner, "subown@example.com");
    const conf = await owner.rpc.conferences.create({ name: "Subs" });

    const { client: part } =
      await inviteAndClaim(ctx.app, owner, conf.slug, "part@example.com");

    const sub = await part.rpc.submissions.create({
      slug: conf.slug, title: "On Bun + React", description: "A walkthrough",
    });
    expect(sub.status).toBe("submitted");

    await expect(part.rpc.submissions.publish({ slug: conf.slug, id: sub.id }))
      .rejects.toBeInstanceOf(ORPCError);

    await expect(part.rpc.submissions.star({ slug: conf.slug, id: sub.id }))
      .rejects.toBeInstanceOf(ORPCError);

    // Participants see their *own* unpublished submissions (so they can
    // delete a draft before a mod decides). Other not-yet-published sessions
    // are still hidden until a mod publishes them.
    let list = await part.rpc.submissions.list({ slug: conf.slug });
    expect(list.map((s) => s.id)).toEqual([sub.id]);
    expect(list[0]!.status).toBe("submitted");

    await owner.rpc.submissions.publish({ slug: conf.slug, id: sub.id });

    await part.rpc.submissions.star({ slug: conf.slug, id: sub.id });

    list = await part.rpc.submissions.list({ slug: conf.slug });
    expect(list.length).toBe(1);
    expect(list[0]!.star_count).toBe(1);
    expect(list[0]!.starred_by_me).toBe(true);

    await part.rpc.submissions.unstar({ slug: conf.slug, id: sub.id });
    list = await part.rpc.submissions.list({ slug: conf.slug });
    expect(list[0]!.starred_by_me).toBe(false);
    expect(list[0]!.star_count).toBe(0);
  });

  test("participant submissions toggle: disabling blocks participants but not mods", async () => {
    const owner = new Client(ctx.app);
    await signupAndLogin(owner, "togowner@example.com");
    const conf = await owner.rpc.conferences.create({ name: "Submit Toggle" });

    // Default is enabled: participants can submit.
    const detailBefore = await owner.rpc.conferences.get({ slug: conf.slug });
    expect(detailBefore.participant_submissions_enabled).toBe(true);

    const { client: part } =
      await inviteAndClaim(ctx.app, owner, conf.slug, "togpart@example.com");

    const ok = await part.rpc.submissions.create({
      slug: conf.slug, title: "Allowed while open",
    });
    expect(ok.status).toBe("submitted");

    // Owner disables participant submissions.
    await owner.rpc.conferences.update({
      slug: conf.slug, participant_submissions_enabled: false,
    });
    const detailAfter = await owner.rpc.conferences.get({ slug: conf.slug });
    expect(detailAfter.participant_submissions_enabled).toBe(false);

    // Participant is now blocked.
    await expect(part.rpc.submissions.create({
      slug: conf.slug, title: "Should be rejected",
    })).rejects.toBeInstanceOf(ORPCError);

    // Moderators can still submit.
    const { client: mod } =
      await inviteAndClaim(ctx.app, owner, conf.slug, "togmod@example.com");
    const modId = (await mod.rpc.conferences.me({ slug: conf.slug })).id;
    await owner.rpc.conferences.addModerator({ slug: conf.slug, user_id: modId });
    const modSub = await mod.rpc.submissions.create({
      slug: conf.slug, title: "Moderator submission",
    });
    expect(modSub.status).toBe("submitted");

    // Owner can also still submit in their own conference.
    const ownerSub = await owner.rpc.submissions.create({
      slug: conf.slug, title: "Owner submission",
    });
    expect(ownerSub.status).toBe("submitted");

    // Re-enabling lets the participant submit again.
    await owner.rpc.conferences.update({
      slug: conf.slug, participant_submissions_enabled: true,
    });
    const reopened = await part.rpc.submissions.create({
      slug: conf.slug, title: "Allowed again",
    });
    expect(reopened.status).toBe("submitted");
  });
});

describe("rooms + agenda + unconference assignment", () => {
  let ctx: TestApp;
  beforeAll(() => { ctx = setupTestApp(); });
  afterAll(async () => { await ctx.cleanup(); });

  test("full happy path: rooms, submissions, stars, slot, assign", async () => {
    const owner = new Client(ctx.app);
    await signupAndLogin(owner, "agendaowner@example.com");
    const conf = await owner.rpc.conferences.create({ name: "Agenda Test" });

    const bigRoom = await owner.rpc.rooms.create({ slug: conf.slug, name: "Auditorium", capacity: 50 });
    const smallRoom = await owner.rpc.rooms.create({ slug: conf.slug, name: "Side Room", capacity: 2 });

    const partIds: number[] = [];
    const partClients: Client[] = [];
    for (let i = 0; i < 5; i++) {
      const { client, identity_id } =
        await inviteAndClaim(ctx.app, owner, conf.slug, `p${i}@example.com`);
      partIds.push(identity_id);
      partClients.push(client);
    }

    const subA = await partClients[0]!.rpc.submissions.create({
      slug: conf.slug, title: "Session A",
    });
    const subB = await partClients[0]!.rpc.submissions.create({
      slug: conf.slug, title: "Session B",
    });
    await owner.rpc.submissions.publish({ slug: conf.slug, id: subA.id });
    await owner.rpc.submissions.publish({ slug: conf.slug, id: subB.id });

    for (const cl of partClients) {
      await cl.rpc.submissions.star({ slug: conf.slug, id: subA.id });
    }
    await partClients[1]!.rpc.submissions.star({ slug: conf.slug, id: subB.id });

    const slot = await owner.rpc.agenda.createSlot({
      slug: conf.slug,
      type: "unconference",
      starts_at: Date.now(),
      ends_at: Date.now() + 60 * 60 * 1000,
    });

    const result = await owner.rpc.agenda.assign({ slug: conf.slug, slot_id: slot.id });
    if (result.kind !== "unconference") throw new Error("expected unconference result");

    const placeForA = result.placements.find((p) => p.submission_id === subA.id);
    expect(placeForA!.room_id).toBe(bigRoom.id);
    const placeForB = result.placements.find((p) => p.submission_id === subB.id);
    expect(placeForB!.room_id).toBe(smallRoom.id);

    expect(result.user_assignments.length + result.unplaced_users.length).toBe(6); // 5 parts + owner

    const p1Assign = result.user_assignments.find((a) => a.user_id === partIds[1]);
    expect(p1Assign?.submission_id).toBe(subB.id);

    const meBody = await partClients[2]!.rpc.agenda.myAssignments({ slug: conf.slug });
    expect(meBody.assignments[0]!.submission_id).toBe(subA.id);
    expect(meBody.assignments[0]!.room_id).toBe(bigRoom.id);
  });

  test("static-slot track stores speakers and links a submission OR a custom title", async () => {
    const owner = new Client(ctx.app);
    await signupAndLogin(owner, "trkowner@example.com");
    const conf = await owner.rpc.conferences.create({ name: "Tracks" });
    const room = await owner.rpc.rooms.create({ slug: conf.slug, name: "Auditorium", capacity: 100 });
    const sub = await owner.rpc.submissions.create({
      slug: conf.slug, title: "Keynote: Bun and React",
    });
    await owner.rpc.submissions.publish({ slug: conf.slug, id: sub.id });

    const slot = await owner.rpc.agenda.createSlot({
      slug: conf.slug,
      type: "normal", title: "Opening Keynote",
      starts_at: Date.now(), ends_at: Date.now() + 60 * 60 * 1000,
    });

    await owner.rpc.agenda.setTrack({
      slug: conf.slug, slot_id: slot.id,
      room_id: room.id, submission_id: sub.id, speakers: "Alice Anderson",
    });
    let agenda = await owner.rpc.agenda.get({ slug: conf.slug });
    expect(agenda.tracks[0]!.submission_id).toBe(sub.id);
    expect(agenda.tracks[0]!.speakers).toBe("Alice Anderson");

    await owner.rpc.agenda.setTrack({
      slug: conf.slug, slot_id: slot.id,
      room_id: room.id, submission_id: null, title: "Welcome", speakers: "Carol",
    });
    agenda = await owner.rpc.agenda.get({ slug: conf.slug });
    expect(agenda.tracks[0]!.submission_id).toBeNull();
    expect(agenda.tracks[0]!.title).toBe("Welcome");
    expect(agenda.tracks[0]!.speakers).toBe("Carol");

    await owner.rpc.agenda.clearTrack({
      slug: conf.slug, slot_id: slot.id, room_id: room.id,
    });
    agenda = await owner.rpc.agenda.get({ slug: conf.slug });
    expect(agenda.tracks.length).toBe(0);
  });

  test("unconference per-slot scope restricts rooms and submissions used by assignment", async () => {
    const owner = new Client(ctx.app);
    await signupAndLogin(owner, "scopeowner@example.com");
    const conf = await owner.rpc.conferences.create({ name: "Scope" });

    await owner.rpc.rooms.create({ slug: conf.slug, name: "Big", capacity: 50 });
    const roomB = await owner.rpc.rooms.create({ slug: conf.slug, name: "Small", capacity: 10 });

    const subA = await owner.rpc.submissions.create({ slug: conf.slug, title: "Talk A" });
    const subB = await owner.rpc.submissions.create({ slug: conf.slug, title: "Talk B" });
    await owner.rpc.submissions.publish({ slug: conf.slug, id: subA.id });
    await owner.rpc.submissions.publish({ slug: conf.slug, id: subB.id });

    const { client: part } =
      await inviteAndClaim(ctx.app, owner, conf.slug, "scopepart@example.com");
    await part.rpc.submissions.star({ slug: conf.slug, id: subA.id });
    await part.rpc.submissions.star({ slug: conf.slug, id: subB.id });

    const slot = await owner.rpc.agenda.createSlot({
      slug: conf.slug,
      type: "unconference", starts_at: Date.now(), ends_at: Date.now() + 60 * 60 * 1000,
    });
    await owner.rpc.agenda.updateSlot({
      slug: conf.slug, id: slot.id,
      unconf_use_all_rooms: false,
      unconf_use_all_submissions: false,
      unconf_room_ids: [roomB.id],
      unconf_submission_ids: [subB.id],
    });

    const agenda = await owner.rpc.agenda.get({ slug: conf.slug });
    const slotInfo = agenda.slots.find((s) => s.id === slot.id);
    expect(slotInfo!.unconf_use_all_rooms).toBe(false);
    expect(slotInfo!.unconf_room_ids).toEqual([roomB.id]);
    expect(slotInfo!.unconf_submission_ids).toEqual([subB.id]);

    const res = await owner.rpc.agenda.assign({ slug: conf.slug, slot_id: slot.id });
    if (res.kind !== "unconference") throw new Error("expected unconference result");
    expect(res.placements.length).toBe(1);
    expect(res.placements[0]!.submission_id).toBe(subB.id);
    expect(res.placements[0]!.room_id).toBe(roomB.id);
  });

  test("attendees can star a static track and it appears in /me/assignments", async () => {
    const owner = new Client(ctx.app);
    await signupAndLogin(owner, "starowner@example.com");
    const conf = await owner.rpc.conferences.create({ name: "Static Stars" });
    const room = await owner.rpc.rooms.create({ slug: conf.slug, name: "Auditorium", capacity: 100 });

    const slot = await owner.rpc.agenda.createSlot({
      slug: conf.slug,
      type: "normal", title: "Keynote",
      starts_at: Date.now(), ends_at: Date.now() + 60 * 60 * 1000,
    });
    await owner.rpc.agenda.setTrack({
      slug: conf.slug, slot_id: slot.id,
      room_id: room.id, title: "Welcome", speakers: "Alice",
    });

    const agendaRes = await owner.rpc.agenda.get({ slug: conf.slug });
    const trackId = agendaRes.tracks[0]!.id;

    const { client: part } =
      await inviteAndClaim(ctx.app, owner, conf.slug, "starpart@example.com");

    await part.rpc.agenda.starTrack({ slug: conf.slug, slot_id: slot.id, track_id: trackId });

    const partAgenda = await part.rpc.agenda.get({ slug: conf.slug });
    const trk = partAgenda.tracks.find((t) => t.id === trackId);
    expect(trk!.starred_by_me).toBe(true);
    expect(trk!.star_count).toBe(1);

    const me = await part.rpc.agenda.myAssignments({ slug: conf.slug });
    expect(me.assignments.length).toBe(1);
    expect(me.assignments[0]!.source).toBe("static");
    expect(me.assignments[0]!.room_id).toBe(room.id);
    expect(me.assignments[0]!.title).toBe("Welcome");

    await part.rpc.agenda.unstarTrack({ slug: conf.slug, slot_id: slot.id, track_id: trackId });
    const me2 = await part.rpc.agenda.myAssignments({ slug: conf.slug });
    expect(me2.assignments.length).toBe(0);

    const unconfSlot = await owner.rpc.agenda.createSlot({
      slug: conf.slug,
      type: "unconference", starts_at: Date.now(), ends_at: Date.now() + 60 * 60 * 1000,
    });
    await expect(part.rpc.agenda.starTrack({
      slug: conf.slug, slot_id: unconfSlot.id, track_id: trackId,
    })).rejects.toBeInstanceOf(ORPCError);
  });

  test("mandatory static tracks show up in every participant's schedule and can't be unstarred", async () => {
    const owner = new Client(ctx.app);
    await signupAndLogin(owner, "mandowner@example.com");
    const conf = await owner.rpc.conferences.create({ name: "Mandatory" });
    const room = await owner.rpc.rooms.create({ slug: conf.slug, name: "Main Hall", capacity: 500 });

    const start = Date.now();
    const slot = await owner.rpc.agenda.createSlot({
      slug: conf.slug, type: "normal", title: "Keynote",
      starts_at: start, ends_at: start + 60 * 60 * 1000,
    });
    await owner.rpc.agenda.setTrack({
      slug: conf.slug, slot_id: slot.id,
      room_id: room.id, title: "Opening Keynote", speakers: "Alice",
      mandatory: true,
    });

    const agendaRes = await owner.rpc.agenda.get({ slug: conf.slug });
    const track = agendaRes.tracks.find((t) => t.slot_id === slot.id)!;
    expect(track.mandatory).toBe(true);

    // Two participants — neither has starred anything — both see the keynote.
    const { client: p1 } =
      await inviteAndClaim(ctx.app, owner, conf.slug, "mandp1@example.com");
    const { client: p2 } =
      await inviteAndClaim(ctx.app, owner, conf.slug, "mandp2@example.com");

    for (const p of [p1, p2]) {
      const me = await p.rpc.agenda.myAssignments({ slug: conf.slug });
      const keynoteRow = me.assignments.find((a) => a.source === "static" && a.slot_id === slot.id);
      expect(keynoteRow).toBeTruthy();
      expect(keynoteRow!.title).toBe("Opening Keynote");
      expect(keynoteRow!.mandatory).toBe(true);
    }

    // Unstar is rejected outright (FORBIDDEN) — can't opt out of mandatory.
    await expect(p1.rpc.agenda.unstarTrack({
      slug: conf.slug, slot_id: slot.id, track_id: track.id,
    })).rejects.toBeInstanceOf(ORPCError);

    // Schedule still includes it after the rejected unstar attempt.
    const after = await p1.rpc.agenda.myAssignments({ slug: conf.slug });
    expect(after.assignments.some((a) => a.source === "static" && a.slot_id === slot.id)).toBe(true);

    // Star is a silent no-op (mandatory tracks don't need explicit star rows).
    await p1.rpc.agenda.starTrack({ slug: conf.slug, slot_id: slot.id, track_id: track.id });
    const afterStar = await p1.rpc.agenda.myAssignments({ slug: conf.slug });
    // Still exactly one row for the keynote (no duplication).
    expect(afterStar.assignments.filter((a) => a.source === "static" && a.slot_id === slot.id))
      .toHaveLength(1);

    // Mod can clear the mandatory flag — track stays, but is no longer
    // force-attended; an opted-in participant still has it via their star.
    await owner.rpc.agenda.setTrack({
      slug: conf.slug, slot_id: slot.id,
      room_id: room.id, title: "Opening Keynote", speakers: "Alice",
      mandatory: false,
    });
    const after2 = await p2.rpc.agenda.myAssignments({ slug: conf.slug });
    expect(after2.assignments.some((a) => a.source === "static" && a.slot_id === slot.id))
      .toBe(false);
  });

  test("slot can be moved + resized via PATCH starts_at/ends_at", async () => {
    const owner = new Client(ctx.app);
    await signupAndLogin(owner, "moveowner@example.com");
    const conf = await owner.rpc.conferences.create({ name: "Move" });
    const slot = await owner.rpc.agenda.createSlot({
      slug: conf.slug,
      type: "normal", title: "Talks",
      starts_at: 1_700_000_000_000,
      ends_at:   1_700_003_600_000,
    });

    const newStart = 1_700_001_800_000;
    const newEnd   = 1_700_007_200_000;
    await owner.rpc.agenda.updateSlot({
      slug: conf.slug, id: slot.id,
      starts_at: newStart, ends_at: newEnd,
    });

    const a = await owner.rpc.agenda.get({ slug: conf.slug });
    const updated = a.slots.find((s) => s.id === slot.id);
    expect(updated!.starts_at).toBe(newStart);
    expect(updated!.ends_at).toBe(newEnd);

    await expect(owner.rpc.agenda.updateSlot({
      slug: conf.slug, id: slot.id,
      starts_at: newEnd, ends_at: newStart,
    })).rejects.toBeInstanceOf(ORPCError);
  });

  test("agenda assign on a non-unconference slot returns 400", async () => {
    const owner = new Client(ctx.app);
    await signupAndLogin(owner, "agenda2@example.com");
    const conf = await owner.rpc.conferences.create({ name: "A2" });
    await owner.rpc.rooms.create({ slug: conf.slug, name: "R1", capacity: 10 });
    const slot = await owner.rpc.agenda.createSlot({
      slug: conf.slug,
      type: "normal",
      title: "Keynote",
      starts_at: Date.now(),
      ends_at: Date.now() + 3600_000,
    });
    await expect(owner.rpc.agenda.assign({ slug: conf.slug, slot_id: slot.id }))
      .rejects.toBeInstanceOf(ORPCError);
  });

  test("submitter is auto-assigned to their own placed unconference session", async () => {
    const owner = new Client(ctx.app);
    await signupAndLogin(owner, "subowner@example.com");
    const conf = await owner.rpc.conferences.create({ name: "SubHost" });
    await owner.rpc.rooms.create({ slug: conf.slug, name: "Hall", capacity: 50 });

    const { client: host } =
      await inviteAndClaim(ctx.app, owner, conf.slug, "host@example.com");
    const sub = await host.rpc.submissions.create({ slug: conf.slug, title: "Host's talk" });
    await owner.rpc.submissions.publish({ slug: conf.slug, id: sub.id });

    const slot = await owner.rpc.agenda.createSlot({
      slug: conf.slug,
      type: "unconference",
      starts_at: Date.now(), ends_at: Date.now() + 3600_000,
    });
    const res = await owner.rpc.agenda.assign({ slug: conf.slug, slot_id: slot.id });
    if (res.kind !== "unconference") throw new Error("expected unconference result");

    const hostAssign = res.user_assignments.find((a) => a.submission_id === sub.id);
    expect(hostAssign).toBeTruthy();
    const me = await host.rpc.agenda.myAssignments({ slug: conf.slug });
    expect(me.assignments[0]!.submission_id).toBe(sub.id);
  });

  test("unconference avoid_repeats prevents the same session twice for one attendee", async () => {
    const owner = new Client(ctx.app);
    await signupAndLogin(owner, "repeatowner@example.com");
    const conf = await owner.rpc.conferences.create({ name: "Repeats" });
    await owner.rpc.rooms.create({ slug: conf.slug, name: "A", capacity: 5 });
    await owner.rpc.rooms.create({ slug: conf.slug, name: "B", capacity: 5 });

    const subA = await owner.rpc.submissions.create({ slug: conf.slug, title: "Talk A" });
    const subB = await owner.rpc.submissions.create({ slug: conf.slug, title: "Talk B" });
    await owner.rpc.submissions.publish({ slug: conf.slug, id: subA.id });
    await owner.rpc.submissions.publish({ slug: conf.slug, id: subB.id });

    const { client: part } =
      await inviteAndClaim(ctx.app, owner, conf.slug, "p@example.com");
    await part.rpc.submissions.star({ slug: conf.slug, id: subA.id });
    await part.rpc.submissions.star({ slug: conf.slug, id: subB.id });

    const slot1 = await owner.rpc.agenda.createSlot({
      slug: conf.slug,
      type: "unconference", starts_at: Date.now(), ends_at: Date.now() + 3600_000,
    });
    await owner.rpc.agenda.updateSlot({
      slug: conf.slug, id: slot1.id,
      unconf_use_all_submissions: false, unconf_submission_ids: [subA.id],
    });
    await owner.rpc.agenda.assign({ slug: conf.slug, slot_id: slot1.id });

    const slot2 = await owner.rpc.agenda.createSlot({
      slug: conf.slug,
      type: "unconference",
      starts_at: Date.now() + 2 * 3600_000, ends_at: Date.now() + 3 * 3600_000,
    });
    const res2 = await owner.rpc.agenda.assign({ slug: conf.slug, slot_id: slot2.id });
    if (res2.kind !== "unconference") throw new Error("expected unconference result");

    const me = await part.rpc.agenda.myAssignments({ slug: conf.slug });
    const slot2Entry = me.assignments.find((a) => a.slot_id === slot2.id);
    expect(slot2Entry?.submission_id).toBe(subB.id);
  });

  test("mixer slot evenly distributes all members across rooms", async () => {
    const owner = new Client(ctx.app);
    await signupAndLogin(owner, "mixerowner@example.com");
    const conf = await owner.rpc.conferences.create({ name: "Mixer" });
    const roomA = await owner.rpc.rooms.create({ slug: conf.slug, name: "Lounge A", capacity: 10 });
    const roomB = await owner.rpc.rooms.create({ slug: conf.slug, name: "Lounge B", capacity: 10 });

    const partClients: Client[] = [];
    for (let i = 0; i < 4; i++) {
      const { client } =
        await inviteAndClaim(ctx.app, owner, conf.slug, `m${i}@example.com`);
      partClients.push(client);
    }

    const slot = await owner.rpc.agenda.createSlot({
      slug: conf.slug,
      type: "mixer", title: "Meet each other",
      starts_at: Date.now(), ends_at: Date.now() + 1800_000,
    });

    const res = await owner.rpc.agenda.assign({ slug: conf.slug, slot_id: slot.id });
    if (res.kind !== "mixer") throw new Error("expected mixer result");
    expect(res.room_assignments.length).toBe(5);
    expect(res.unplaced_users.length).toBe(0);

    const counts = new Map<number, number>();
    for (const a of res.room_assignments) {
      counts.set(a.room_id, (counts.get(a.room_id) ?? 0) + 1);
    }
    expect(counts.get(roomA.id) ?? 0).toBeGreaterThanOrEqual(2);
    expect(counts.get(roomB.id) ?? 0).toBeGreaterThanOrEqual(2);

    const agenda = await owner.rpc.agenda.get({ slug: conf.slug });
    const mp = agenda.mixer_placements.filter((m) => m.slot_id === slot.id);
    expect(mp.length).toBe(2);
    expect(mp.reduce((acc, m) => acc + m.attendee_count, 0)).toBe(5);

    const me = await partClients[0]!.rpc.agenda.myAssignments({ slug: conf.slug });
    const entry = me.assignments.find((a) => a.slot_id === slot.id);
    expect(entry).toBeTruthy();
    expect(entry!.source).toBe("mixer");
    expect([roomA.id, roomB.id]).toContain(entry!.room_id!);
  });

  test("two exclusive mixers avoid re-pairing the same participants", async () => {
    // Conference default is "exclusive mix" (true). 4 users, 2 rooms of cap 2.
    // A perfect anti-repeat layout exists, so mixer #2 must contain zero pairs
    // that already appeared in mixer #1.
    const owner = new Client(ctx.app);
    await signupAndLogin(owner, "mixerexcl@example.com");
    const conf = await owner.rpc.conferences.create({ name: "MixerExcl" });
    const roomA = await owner.rpc.rooms.create({ slug: conf.slug, name: "A", capacity: 2 });
    const roomB = await owner.rpc.rooms.create({ slug: conf.slug, name: "B", capacity: 2 });

    for (let i = 0; i < 4; i++) {
      await inviteAndClaim(ctx.app, owner, conf.slug, `mx${i}@example.com`);
    }

    const slot1 = await owner.rpc.agenda.createSlot({
      slug: conf.slug, type: "mixer", title: "Mixer 1",
      starts_at: Date.now(), ends_at: Date.now() + 1800_000,
    });
    const slot2 = await owner.rpc.agenda.createSlot({
      slug: conf.slug, type: "mixer", title: "Mixer 2",
      starts_at: Date.now() + 3600_000, ends_at: Date.now() + 5400_000,
    });

    const m1raw = await owner.rpc.agenda.assign({ slug: conf.slug, slot_id: slot1.id });
    const m2raw = await owner.rpc.agenda.assign({ slug: conf.slug, slot_id: slot2.id });
    if (m1raw.kind !== "mixer" || m2raw.kind !== "mixer") throw new Error("expected mixer");
    const m1 = m1raw, m2 = m2raw;

    function pairings(rs: { user_id: number; room_id: number }[]): Set<string> {
      const byRoom = new Map<number, number[]>();
      for (const a of rs) {
        const arr = byRoom.get(a.room_id) ?? [];
        arr.push(a.user_id);
        byRoom.set(a.room_id, arr);
      }
      const out = new Set<string>();
      for (const [, us] of byRoom) {
        for (let i = 0; i < us.length; i++) {
          for (let j = i + 1; j < us.length; j++) {
            const [a, b] = us[i]! < us[j]! ? [us[i]!, us[j]!] : [us[j]!, us[i]!];
            out.add(`${a}:${b}`);
          }
        }
      }
      return out;
    }

    const p1 = pairings(m1.room_assignments);
    const p2 = pairings(m2.room_assignments);
    // 4 users in 2 rooms of cap 2 → each mixer emits 2 pairs.
    expect(p1.size).toBe(2);
    expect(p2.size).toBe(2);
    // With exclusive mix on (the default), none of mixer 1's pairs should
    // appear in mixer 2. This used to fail under the old per-slot-seed mixer
    // which had no knowledge of prior placements.
    for (const p of p2) expect(p1.has(p)).toBe(false);
    expect(roomA.id).toBeGreaterThan(0);
    expect(roomB.id).toBeGreaterThan(0);
  });

  test("mixer with fresh-shuffle override ignores prior mixers", async () => {
    // Owner flips the slot's per-slot setting to false. The algorithm should
    // then NOT receive priorPairings, so output equals the no-history baseline.
    const owner = new Client(ctx.app);
    await signupAndLogin(owner, "mixerfresh@example.com");
    const conf = await owner.rpc.conferences.create({ name: "MixerFresh" });
    await owner.rpc.rooms.create({ slug: conf.slug, name: "A", capacity: 4 });
    await owner.rpc.rooms.create({ slug: conf.slug, name: "B", capacity: 4 });

    for (let i = 0; i < 4; i++) {
      await inviteAndClaim(ctx.app, owner, conf.slug, `fr${i}@example.com`);
    }

    const slot1 = await owner.rpc.agenda.createSlot({
      slug: conf.slug, type: "mixer", title: "Mixer 1",
      starts_at: Date.now(), ends_at: Date.now() + 1800_000,
    });
    const slot2 = await owner.rpc.agenda.createSlot({
      slug: conf.slug, type: "mixer", title: "Mixer 2 (fresh)",
      starts_at: Date.now() + 3600_000, ends_at: Date.now() + 5400_000,
    });

    // Flip slot2 to fresh-shuffle (false).
    await owner.rpc.agenda.updateSlot({
      slug: conf.slug, id: slot2.id, mixer_avoid_repeats: false,
    });

    await owner.rpc.agenda.assign({ slug: conf.slug, slot_id: slot1.id });
    await owner.rpc.agenda.assign({ slug: conf.slug, slot_id: slot2.id });

    // Verify the SlotOut surfaces the override + effective mode.
    const agenda = await owner.rpc.agenda.get({ slug: conf.slug });
    const s1 = agenda.slots.find((s) => s.id === slot1.id);
    const s2 = agenda.slots.find((s) => s.id === slot2.id);
    expect(s1?.mixer_avoid_repeats).toBe(null);                  // inherit
    expect(s1?.mixer_avoid_repeats_effective).toBe(true);        // conf default = true
    expect(s2?.mixer_avoid_repeats).toBe(false);                 // explicit fresh
    expect(s2?.mixer_avoid_repeats_effective).toBe(false);
  });

  test("conference default = fresh shuffle: exclusive mixers ignore non-exclusive history", async () => {
    // When conference default is false, an inheriting slot is fresh-shuffle.
    // A slot can still opt into exclusive mix individually.
    const owner = new Client(ctx.app);
    await signupAndLogin(owner, "mixerdefault@example.com");
    const conf = await owner.rpc.conferences.create({ name: "MixerDefault" });
    await owner.rpc.conferences.update({
      slug: conf.slug, mixer_avoid_repeats_default: false,
    });

    const detail = await owner.rpc.conferences.get({ slug: conf.slug });
    expect(detail.mixer_avoid_repeats_default).toBe(false);

    const slot = await owner.rpc.agenda.createSlot({
      slug: conf.slug, type: "mixer", title: "M",
      starts_at: Date.now(), ends_at: Date.now() + 1800_000,
    });
    const agenda = await owner.rpc.agenda.get({ slug: conf.slug });
    const s = agenda.slots.find((x) => x.id === slot.id);
    expect(s?.mixer_avoid_repeats).toBe(null);                 // inherit
    expect(s?.mixer_avoid_repeats_effective).toBe(false);      // resolves to fresh
  });
});

describe("manual session switching", () => {
  let ctx: TestApp;
  beforeAll(() => { ctx = setupTestApp(); });
  afterAll(async () => { await ctx.cleanup(); });

  async function buildSlot(opts: { capA: number; capB: number; participants: number; tag: string }) {
    const owner = new Client(ctx.app);
    await signupAndLogin(owner, `${opts.tag}@example.com`);
    const conf = await owner.rpc.conferences.create({ name: opts.tag });
    const roomA = await owner.rpc.rooms.create({ slug: conf.slug, name: "A", capacity: opts.capA });
    const roomB = await owner.rpc.rooms.create({ slug: conf.slug, name: "B", capacity: opts.capB });
    const subA = await owner.rpc.submissions.create({ slug: conf.slug, title: "Talk A" });
    const subB = await owner.rpc.submissions.create({ slug: conf.slug, title: "Talk B" });
    await owner.rpc.submissions.publish({ slug: conf.slug, id: subA.id });
    await owner.rpc.submissions.publish({ slug: conf.slug, id: subB.id });

    const parts: Client[] = [];
    for (let i = 0; i < opts.participants; i++) {
      const { client } =
        await inviteAndClaim(ctx.app, owner, conf.slug, `${opts.tag}-p${i}@example.com`);
      parts.push(client);
    }

    const slot = await owner.rpc.agenda.createSlot({
      slug: conf.slug,
      type: "unconference", starts_at: Date.now(), ends_at: Date.now() + 3600_000,
    });
    return { owner, conf, roomA, roomB, subA, subB, parts, slot };
  }

  test("unplaced participant can pick a non-full session", async () => {
    const { owner, conf, subA, subB, parts, slot, roomB } = await buildSlot({
      capA: 1, capB: 1, participants: 3, tag: "pickflow",
    });
    for (const p of parts) {
      await p.rpc.submissions.star({ slug: conf.slug, id: subA.id });
    }
    await owner.rpc.agenda.assign({ slug: conf.slug, slot_id: slot.id });

    let unplaced: Client | null = null;
    for (const p of parts) {
      const me = await p.rpc.agenda.myAssignments({ slug: conf.slug });
      if (me.unplaced_slots.includes(slot.id)) { unplaced = p; break; }
    }
    expect(unplaced).not.toBeNull();

    await unplaced!.rpc.agenda.pickAssignment({
      slug: conf.slug, slot_id: slot.id, submission_id: subB.id,
    });

    const me = await unplaced!.rpc.agenda.myAssignments({ slug: conf.slug });
    const entry = me.assignments.find((a) => a.slot_id === slot.id);
    expect(entry!.submission_id).toBe(subB.id);
    expect(entry!.room_id).toBe(roomB.id);
    expect(entry!.manual).toBe(true);
    expect(me.unplaced_slots).not.toContain(slot.id);
  });

  test("picking a full session returns 409 session_full", async () => {
    const { owner, conf, subA, parts, slot } = await buildSlot({
      capA: 1, capB: 1, participants: 3, tag: "pickfull",
    });
    await parts[0]!.rpc.submissions.star({ slug: conf.slug, id: subA.id });
    await owner.rpc.agenda.assign({ slug: conf.slug, slot_id: slot.id });

    try {
      await parts[1]!.rpc.agenda.pickAssignment({
        slug: conf.slug, slot_id: slot.id, submission_id: subA.id,
      });
      throw new Error("expected to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(ORPCError);
      expect((e as ORPCError<string, unknown>).message).toBe("session_full");
    }
  });

  test("picking a submission that isn't placed returns 404 not_placed", async () => {
    const { owner, conf, subB, parts, slot } = await buildSlot({
      capA: 5, capB: 5, participants: 2, tag: "picknotplaced",
    });
    await owner.rpc.agenda.updateSlot({
      slug: conf.slug, id: slot.id,
      unconf_use_all_submissions: false, unconf_submission_ids: [],
    });
    await owner.rpc.agenda.assign({ slug: conf.slug, slot_id: slot.id });

    try {
      await parts[0]!.rpc.agenda.pickAssignment({
        slug: conf.slug, slot_id: slot.id, submission_id: subB.id,
      });
      throw new Error("expected to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(ORPCError);
      expect((e as ORPCError<string, unknown>).message).toBe("not_placed");
    }
  });

  test("already-placed participant can switch to another non-full session", async () => {
    const { owner, conf, subA, subB, parts, slot, roomB } = await buildSlot({
      capA: 5, capB: 5, participants: 1, tag: "switchplaced",
    });
    await parts[0]!.rpc.submissions.star({ slug: conf.slug, id: subA.id });
    await owner.rpc.agenda.assign({ slug: conf.slug, slot_id: slot.id });
    let me = await parts[0]!.rpc.agenda.myAssignments({ slug: conf.slug });
    expect(me.assignments[0]!.submission_id).toBe(subA.id);
    expect(me.assignments[0]!.manual).toBe(false);

    await parts[0]!.rpc.agenda.pickAssignment({
      slug: conf.slug, slot_id: slot.id, submission_id: subB.id,
    });

    me = await parts[0]!.rpc.agenda.myAssignments({ slug: conf.slug });
    expect(me.assignments[0]!.submission_id).toBe(subB.id);
    expect(me.assignments[0]!.room_id).toBe(roomB.id);
    expect(me.assignments[0]!.manual).toBe(true);
  });

  test("manual pick is preserved when moderator re-runs assignment", async () => {
    const { owner, conf, subA, subB, parts, slot, roomB } = await buildSlot({
      capA: 5, capB: 5, participants: 1, tag: "rerunlock",
    });
    await parts[0]!.rpc.submissions.star({ slug: conf.slug, id: subA.id });
    await owner.rpc.agenda.assign({ slug: conf.slug, slot_id: slot.id });
    await parts[0]!.rpc.agenda.pickAssignment({
      slug: conf.slug, slot_id: slot.id, submission_id: subB.id,
    });
    await owner.rpc.agenda.assign({ slug: conf.slug, slot_id: slot.id });

    const me = await parts[0]!.rpc.agenda.myAssignments({ slug: conf.slug });
    expect(me.assignments[0]!.submission_id).toBe(subB.id);
    expect(me.assignments[0]!.room_id).toBe(roomB.id);
    expect(me.assignments[0]!.manual).toBe(true);
  });

  test("DELETE /me/assignment unlocks the user — they get re-shuffled next run", async () => {
    const { owner, conf, subA, subB, parts, slot } = await buildSlot({
      capA: 5, capB: 5, participants: 1, tag: "unlock",
    });
    await parts[0]!.rpc.submissions.star({ slug: conf.slug, id: subA.id });
    await owner.rpc.agenda.assign({ slug: conf.slug, slot_id: slot.id });
    await parts[0]!.rpc.agenda.pickAssignment({
      slug: conf.slug, slot_id: slot.id, submission_id: subB.id,
    });
    await parts[0]!.rpc.agenda.unpickAssignment({ slug: conf.slug, slot_id: slot.id });
    await owner.rpc.agenda.assign({ slug: conf.slug, slot_id: slot.id });
    const me = await parts[0]!.rpc.agenda.myAssignments({ slug: conf.slug });
    expect(me.assignments[0]!.submission_id).toBe(subA.id);
    expect(me.assignments[0]!.manual).toBe(false);
  });

  test("manual pick on a non-unconference slot returns 400", async () => {
    const owner = new Client(ctx.app);
    await signupAndLogin(owner, "wrongslot@example.com");
    const conf = await owner.rpc.conferences.create({ name: "Wrong" });
    const slot = await owner.rpc.agenda.createSlot({
      slug: conf.slug,
      type: "normal", title: "Keynote",
      starts_at: Date.now(), ends_at: Date.now() + 3600_000,
    });
    try {
      await owner.rpc.agenda.pickAssignment({
        slug: conf.slug, slot_id: slot.id, submission_id: 1,
      });
      throw new Error("expected to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(ORPCError);
      expect((e as ORPCError<string, unknown>).message).toBe("not_an_unconference_slot");
    }
  });

  test("GET /agenda exposes attendee_count for each placement", async () => {
    const { owner, conf, subA, parts, slot } = await buildSlot({
      capA: 5, capB: 5, participants: 3, tag: "counts",
    });
    for (const p of parts) {
      await p.rpc.submissions.star({ slug: conf.slug, id: subA.id });
    }
    await owner.rpc.agenda.assign({ slug: conf.slug, slot_id: slot.id });
    const agenda = await owner.rpc.agenda.get({ slug: conf.slug });
    const pA = agenda.placements.find((p) => p.submission_id === subA.id);
    expect(pA!.attendee_count).toBe(4);
  });
});

describe("per-conference calendar feed", () => {
  let ctx: TestApp;
  beforeAll(() => { ctx = setupTestApp(); });
  afterAll(async () => { await ctx.cleanup(); });

  test("conferences.getCalendar lazy-generates a token and returns its path", async () => {
    const owner = new Client(ctx.app);
    await signupAndLogin(owner, "ical@example.com");
    const conf = await owner.rpc.conferences.create({ name: "Cal One" });

    const body = await owner.rpc.conferences.getCalendar({ slug: conf.slug });
    expect(typeof body.token).toBe("string");
    expect(body.token.length).toBeGreaterThanOrEqual(32);
    expect(body.path).toBe(`/api/calendar/${body.token}.ics`);

    // Idempotent: returns the same token on a second call.
    const body2 = await owner.rpc.conferences.getCalendar({ slug: conf.slug });
    expect(body2.token).toBe(body.token);
  });

  test("conferences.resetCalendar rotates the token and invalidates the old URL", async () => {
    const owner = new Client(ctx.app);
    await signupAndLogin(owner, "icalreset@example.com");
    const conf = await owner.rpc.conferences.create({ name: "Cal Reset" });

    const oldToken = (await owner.rpc.conferences.getCalendar({ slug: conf.slug })).token;
    const newToken = (await owner.rpc.conferences.resetCalendar({ slug: conf.slug })).token;
    expect(newToken).not.toBe(oldToken);

    const stale = await owner.get(`/api/calendar/${oldToken}.ics`);
    expect(stale.status).toBe(404);
    const fresh = await owner.get(`/api/calendar/${newToken}.ics`);
    expect(fresh.status).toBe(200);
  });

  test("token endpoint requires authentication for the conference", async () => {
    const anon = new Client(ctx.app);
    await expect(anon.rpc.conferences.getCalendar({ slug: "anything" }))
      .rejects.toBeInstanceOf(ORPCError);
  });

  test("public .ics endpoint requires no cookie — token is the auth", async () => {
    const owner = new Client(ctx.app);
    await signupAndLogin(owner, "icalpub@example.com");
    const conf = await owner.rpc.conferences.create({ name: "Pub Cal" });
    const { token } = await owner.rpc.conferences.getCalendar({ slug: conf.slug });

    const anon = new Client(ctx.app);
    const r = await anon.get(`/api/calendar/${token}.ics`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/calendar");
    const body = await r.text();
    expect(body.startsWith("BEGIN:VCALENDAR")).toBe(true);
    expect(body.trimEnd().endsWith("END:VCALENDAR")).toBe(true);
  });

  test(".ics feed rejects malformed/unknown tokens", async () => {
    const anon = new Client(ctx.app);
    expect((await anon.get("/api/calendar/.ics")).status).toBe(404);
    expect((await anon.get("/api/calendar/short.ics")).status).toBe(404);
    expect((await anon.get("/api/calendar/" + "z".repeat(64) + ".ics")).status).toBe(404);
    expect((await anon.get("/api/calendar/" + "a".repeat(64))).status).toBe(404);
  });

  test("feed contains a VEVENT for each assignment (unconference + mixer + static-star)", async () => {
    const owner = new Client(ctx.app);
    await signupAndLogin(owner, "icalfeed@example.com");
    const conf = await owner.rpc.conferences.create({ name: "Feed" });
    const room = await owner.rpc.rooms.create({ slug: conf.slug, name: "Main Hall", capacity: 50 });

    const sub = await owner.rpc.submissions.create({
      slug: conf.slug, title: "Title; with, special\\chars",
    });
    await owner.rpc.submissions.publish({ slug: conf.slug, id: sub.id });
    await owner.rpc.submissions.star({ slug: conf.slug, id: sub.id });

    const unconfSlot = await owner.rpc.agenda.createSlot({
      slug: conf.slug,
      type: "unconference",
      starts_at: Date.UTC(2026, 5, 1, 10, 0, 0),
      ends_at:   Date.UTC(2026, 5, 1, 11, 0, 0),
    });
    await owner.rpc.agenda.assign({ slug: conf.slug, slot_id: unconfSlot.id });

    const mixerSlot = await owner.rpc.agenda.createSlot({
      slug: conf.slug,
      type: "mixer", title: "Lunch tables",
      starts_at: Date.UTC(2026, 5, 1, 12, 0, 0),
      ends_at:   Date.UTC(2026, 5, 1, 13, 0, 0),
    });
    await owner.rpc.agenda.assign({ slug: conf.slug, slot_id: mixerSlot.id });

    const staticSlot = await owner.rpc.agenda.createSlot({
      slug: conf.slug,
      type: "normal", title: "Keynote",
      starts_at: Date.UTC(2026, 5, 1, 9, 0, 0),
      ends_at:   Date.UTC(2026, 5, 1, 9, 30, 0),
    });
    await owner.rpc.agenda.setTrack({
      slug: conf.slug, slot_id: staticSlot.id,
      room_id: room.id, title: "Welcome", speakers: "Alice",
    });
    const agenda = await owner.rpc.agenda.get({ slug: conf.slug });
    const trackId = agenda.tracks.find((t) => t.slot_id === staticSlot.id)!.id;
    await owner.rpc.agenda.starTrack({
      slug: conf.slug, slot_id: staticSlot.id, track_id: trackId,
    });

    const { token } = await owner.rpc.conferences.getCalendar({ slug: conf.slug });
    const anon = new Client(ctx.app);
    const r = await anon.get(`/api/calendar/${token}.ics`);
    const body = await r.text();

    const vevents = body.match(/BEGIN:VEVENT/g) ?? [];
    expect(vevents.length).toBe(3);

    expect(body).toContain("Title\\; with\\, special\\\\chars");
    expect(body).toContain("Lunch tables");
    expect(body).toContain("Welcome");
    expect(body).toMatch(/UID:unconference-\d+-\d+@simple-unconference\r\n/);
    expect(body).toMatch(/UID:mixer-\d+-\d+@simple-unconference\r\n/);
    expect(body).toMatch(/UID:static-\d+-\d+@simple-unconference\r\n/);
    expect(body).toContain("DTSTART:20260601T090000Z");
  });

  test("feed is scoped to ONE conference — other conferences' events do not leak", async () => {
    const owner = new Client(ctx.app);
    await signupAndLogin(owner, "icaliso@example.com");

    // Same global owner creates two conferences. Each one auto-mints a
    // distinct ConferenceIdentity; each has its own calendar token + feed.
    const c1 = await owner.rpc.conferences.create({ name: "Conf One" });
    const c2 = await owner.rpc.conferences.create({ name: "Conf Two" });
    await owner.rpc.rooms.create({ slug: c1.slug, name: "R1", capacity: 10 });
    await owner.rpc.rooms.create({ slug: c2.slug, name: "R2", capacity: 10 });

    const m1 = await owner.rpc.agenda.createSlot({
      slug: c1.slug,
      type: "mixer", title: "Mix A",
      starts_at: Date.UTC(2026, 5, 1, 10, 0, 0),
      ends_at:   Date.UTC(2026, 5, 1, 11, 0, 0),
    });
    const m2 = await owner.rpc.agenda.createSlot({
      slug: c2.slug,
      type: "mixer", title: "Mix B",
      starts_at: Date.UTC(2026, 5, 2, 10, 0, 0),
      ends_at:   Date.UTC(2026, 5, 2, 11, 0, 0),
    });
    await owner.rpc.agenda.assign({ slug: c1.slug, slot_id: m1.id });
    await owner.rpc.agenda.assign({ slug: c2.slug, slot_id: m2.id });

    const { token: tok1 } = await owner.rpc.conferences.getCalendar({ slug: c1.slug });
    const { token: tok2 } = await owner.rpc.conferences.getCalendar({ slug: c2.slug });
    expect(tok1).not.toBe(tok2);

    const anon = new Client(ctx.app);
    const body1 = await (await anon.get(`/api/calendar/${tok1}.ics`)).text();
    const body2 = await (await anon.get(`/api/calendar/${tok2}.ics`)).text();

    // Each feed contains its own conference and ONLY its own.
    expect(body1).toContain("Mix A");
    expect(body1).toContain("Conf One");
    expect(body1).not.toContain("Mix B");
    expect(body1).not.toContain("Conf Two");

    expect(body2).toContain("Mix B");
    expect(body2).toContain("Conf Two");
    expect(body2).not.toContain("Mix A");
    expect(body2).not.toContain("Conf One");
  });
});

// ===========================================================================
// Per-conference identity isolation
//
// These tests are the central privacy invariants of the Phase 1-9 migration:
// an identity in Conf A must not exist in / authenticate against / be visible
// from Conf B. The owner-auto-mint flow is also pinned here.

describe("per-conference identity isolation", () => {
  let ctx: TestApp;
  beforeAll(() => { ctx = setupTestApp(); });
  afterAll(async () => { await ctx.cleanup(); });

  test("identity in Conf A cannot log into Conf B (different password universe)", async () => {
    // Two owners, two conferences. Same participant email in each, but the
    // identity rows are distinct.
    const ownerA = new Client(ctx.app);
    await signupAndLogin(ownerA, "isoA-owner@example.com");
    const confA = await ownerA.rpc.conferences.create({ name: "Iso A" });

    const ownerB = new Client(ctx.app);
    await signupAndLogin(ownerB, "isoB-owner@example.com");
    const confB = await ownerB.rpc.conferences.create({ name: "Iso B" });

    // Alice joins Conf A with password X. She is NOT in Conf B at all.
    const { client: aliceA } =
      await inviteAndClaim(ctx.app, ownerA, confA.slug, "alice@example.com", "password-A");

    // Brand new client tries to log into Conf B with the same email + the Conf-A password.
    const stranger = new Client(ctx.app);
    await expect(stranger.rpc.conferences.login({
      slug: confB.slug, email: "alice@example.com", password: "password-A",
    })).rejects.toBeInstanceOf(ORPCError);

    // Aleady-claimed identity in Conf A can still act in Conf A — sanity.
    const meA = await aliceA.rpc.conferences.me({ slug: confA.slug });
    expect(meA.email).toBe("alice@example.com");
  });

  test("identity cookie for Conf A does NOT grant access to Conf B", async () => {
    const ownerA = new Client(ctx.app);
    await signupAndLogin(ownerA, "xconfA@example.com");
    const confA = await ownerA.rpc.conferences.create({ name: "Cross A" });

    const ownerB = new Client(ctx.app);
    await signupAndLogin(ownerB, "xconfB@example.com");
    const confB = await ownerB.rpc.conferences.create({ name: "Cross B" });

    // Alice in Conf A only.
    const { client: aliceA } =
      await inviteAndClaim(ctx.app, ownerA, confA.slug, "alice@example.com");

    // Her client carries the Conf-A identity cookie. Try to read Conf B's
    // conference detail — must be rejected.
    await expect(aliceA.rpc.conferences.get({ slug: confB.slug }))
      .rejects.toBeInstanceOf(ORPCError);
    await expect(aliceA.rpc.conferences.me({ slug: confB.slug }))
      .rejects.toBeInstanceOf(ORPCError);
    await expect(aliceA.rpc.submissions.list({ slug: confB.slug }))
      .rejects.toBeInstanceOf(ORPCError);
  });

  test("the SAME email can exist in two conferences as completely independent accounts", async () => {
    const ownerA = new Client(ctx.app);
    await signupAndLogin(ownerA, "twinA@example.com");
    const confA = await ownerA.rpc.conferences.create({ name: "Twin A" });

    const ownerB = new Client(ctx.app);
    await signupAndLogin(ownerB, "twinB@example.com");
    const confB = await ownerB.rpc.conferences.create({ name: "Twin B" });

    const { identity_id: idA } =
      await inviteAndClaim(ctx.app, ownerA, confA.slug, "twin@example.com", "twin-pw-A");
    const { identity_id: idB } =
      await inviteAndClaim(ctx.app, ownerB, confB.slug, "twin@example.com", "twin-pw-B");

    // Different identity ids; neither references the other.
    expect(idA).not.toBe(idB);

    // Password A logs into Conf A, not Conf B; and vice versa.
    const cA = new Client(ctx.app);
    await cA.rpc.conferences.login({ slug: confA.slug, email: "twin@example.com", password: "twin-pw-A" });
    await expect(cA.rpc.conferences.login({
      slug: confB.slug, email: "twin@example.com", password: "twin-pw-A",
    })).rejects.toBeInstanceOf(ORPCError);

    const cB = new Client(ctx.app);
    await cB.rpc.conferences.login({ slug: confB.slug, email: "twin@example.com", password: "twin-pw-B" });
  });

  test("owner first-visit auto-mints exactly one identity with ownerUserId set", async () => {
    const owner = new Client(ctx.app);
    const ownerProfile = await owner.rpc.auth.signup({
      email: "automint@example.com", password: "secret123", name: "Auto",
    });
    const conf = await owner.rpc.conferences.create({ name: "Auto Mint" });

    // Touch a conference-scoped endpoint twice — must still produce exactly
    // one identity row.
    await owner.rpc.conferences.get({ slug: conf.slug });
    await owner.rpc.conferences.get({ slug: conf.slug });

    const rows = await ctx.prisma.conferenceIdentity.findMany({
      where: { conferenceId: conf.id },
      select: { id: true, email: true, ownerUserId: true, role: true },
    });
    expect(rows.length).toBe(1);
    expect(rows[0]!.email).toBe("automint@example.com");
    expect(rows[0]!.ownerUserId).toBe(ownerProfile.id);
  });

  test("invite token for Conf A cannot be claimed in Conf B", async () => {
    const ownerA = new Client(ctx.app);
    await signupAndLogin(ownerA, "tokA@example.com");
    const confA = await ownerA.rpc.conferences.create({ name: "Token A" });

    const ownerB = new Client(ctx.app);
    await signupAndLogin(ownerB, "tokB@example.com");
    const confB = await ownerB.rpc.conferences.create({ name: "Token B" });

    const invite = await ownerA.rpc.conferences.createInvite({
      slug: confA.slug, email: "x@example.com",
    });

    // Try to use the Conf-A invite token in Conf B — must reject.
    const anon = new Client(ctx.app);
    await expect(anon.rpc.conferences.previewInvite({
      slug: confB.slug, token: invite.token,
    })).rejects.toBeInstanceOf(ORPCError);
    await expect(anon.rpc.conferences.claimInvite({
      slug: confB.slug, token: invite.token, password: "secret123",
    })).rejects.toBeInstanceOf(ORPCError);
  });

  test("an invite cannot be claimed twice", async () => {
    const owner = new Client(ctx.app);
    await signupAndLogin(owner, "twiceowner@example.com");
    const conf = await owner.rpc.conferences.create({ name: "Twice" });

    const invite = await owner.rpc.conferences.createInvite({
      slug: conf.slug, email: "twice@example.com",
    });

    const c1 = new Client(ctx.app);
    await c1.rpc.conferences.claimInvite({
      slug: conf.slug, token: invite.token, password: "secret123",
    });

    const c2 = new Client(ctx.app);
    try {
      await c2.rpc.conferences.claimInvite({
        slug: conf.slug, token: invite.token, password: "secret123",
      });
      throw new Error("expected to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(ORPCError);
      expect(["already_claimed", "email_already_in_conference"])
        .toContain((e as ORPCError<string, unknown>).message);
    }
  });

  test("join link is disabled by default and rejects signups while disabled", async () => {
    const owner = new Client(ctx.app);
    await signupAndLogin(owner, "linkdis@example.com");
    const conf = await owner.rpc.conferences.create({ name: "Link Off" });

    const initial = await owner.rpc.conferences.getJoinLink({ slug: conf.slug });
    expect(initial.enabled).toBe(false);
    expect(initial.token).toBeNull();

    // Owner enables the link.
    const enabled = await owner.rpc.conferences.setJoinLink({
      slug: conf.slug, enabled: true,
    });
    expect(enabled.enabled).toBe(true);
    expect(enabled.token).not.toBeNull();

    // Anonymous self-sign-up works.
    const anon = new Client(ctx.app);
    const joined = await anon.rpc.conferences.signupViaLink({
      slug: conf.slug, token: enabled.token!,
      email: "joiner@example.com", password: "secret123",
    });
    expect(joined.email).toBe("joiner@example.com");
    expect(joined.role).toBe("participant");

    // Owner disables the link; further sign-ups rejected.
    await owner.rpc.conferences.setJoinLink({ slug: conf.slug, enabled: false });
    const anon2 = new Client(ctx.app);
    await expect(anon2.rpc.conferences.signupViaLink({
      slug: conf.slug, token: enabled.token!,
      email: "lateguest@example.com", password: "secret123",
    })).rejects.toBeInstanceOf(ORPCError);
  });

  test("rotated join token invalidates the previous URL", async () => {
    const owner = new Client(ctx.app);
    await signupAndLogin(owner, "linkrot@example.com");
    const conf = await owner.rpc.conferences.create({ name: "Link Rotate" });

    const old = await owner.rpc.conferences.setJoinLink({ slug: conf.slug, enabled: true });
    expect(old.token).not.toBeNull();
    const rotated = await owner.rpc.conferences.rotateJoinLink({ slug: conf.slug });
    expect(rotated.token).not.toBe(old.token);

    // After rotation the link is disabled by default — re-enable to test the
    // active-but-mismatching-token case.
    await owner.rpc.conferences.setJoinLink({ slug: conf.slug, enabled: true });

    const anon = new Client(ctx.app);
    await expect(anon.rpc.conferences.signupViaLink({
      slug: conf.slug, token: old.token!,
      email: "stale@example.com", password: "secret123",
    })).rejects.toBeInstanceOf(ORPCError);
  });

  test("self-signed-up identity via join link can log in afterwards", async () => {
    const owner = new Client(ctx.app);
    await signupAndLogin(owner, "joinflow@example.com");
    const conf = await owner.rpc.conferences.create({ name: "Join Flow" });

    const { client: joined } = await signupViaJoinLink(
      ctx.app, owner, conf.slug, "self@example.com", "selfpass",
    );
    const me = await joined.rpc.conferences.me({ slug: conf.slug });
    expect(me.email).toBe("self@example.com");

    // A fresh client logs in with the chosen password.
    const fresh = new Client(ctx.app);
    const loginMe = await fresh.rpc.conferences.login({
      slug: conf.slug, email: "self@example.com", password: "selfpass",
    });
    expect(loginMe.id).toBe(me.id);
  });
});

// =========================================================================
// Submission max-placements / finished sessions
// =========================================================================

describe("session max placements (finished sessions)", () => {
  let ctx: TestApp;
  beforeAll(() => { ctx = setupTestApp(); });
  afterAll(async () => { await ctx.cleanup(); });

  test("default cap = 1: a placed session drops out of the next unconference pool", async () => {
    const owner = new Client(ctx.app);
    await signupAndLogin(owner, "finowner1@example.com");
    const conf = await owner.rpc.conferences.create({ name: "Fin Once" });
    // Confirm the default surfaces on the detail.
    const detail = await owner.rpc.conferences.get({ slug: conf.slug });
    expect(detail.submission_max_placements_default).toBe(1);

    // Two rooms so both submissions can place in the first slot.
    await owner.rpc.rooms.create({ slug: conf.slug, name: "R1", capacity: 50 });
    await owner.rpc.rooms.create({ slug: conf.slug, name: "R2", capacity: 50 });

    const { client: p1 } = await inviteAndClaim(ctx.app, owner, conf.slug, "fp1@example.com");
    const { client: p2 } = await inviteAndClaim(ctx.app, owner, conf.slug, "fp2@example.com");

    const subA = await p1.rpc.submissions.create({ slug: conf.slug, title: "A" });
    const subB = await p2.rpc.submissions.create({ slug: conf.slug, title: "B" });
    await owner.rpc.submissions.publish({ slug: conf.slug, id: subA.id });
    await owner.rpc.submissions.publish({ slug: conf.slug, id: subB.id });
    await p1.rpc.submissions.star({ slug: conf.slug, id: subA.id });
    await p2.rpc.submissions.star({ slug: conf.slug, id: subB.id });

    const slot1 = await owner.rpc.agenda.createSlot({
      slug: conf.slug, type: "unconference",
      starts_at: Date.now(), ends_at: Date.now() + 60 * 60 * 1000,
    });
    const r1 = await owner.rpc.agenda.assign({ slug: conf.slug, slot_id: slot1.id });
    if (r1.kind !== "unconference") throw new Error("expected unconference");
    expect(r1.placements.map((p) => p.submission_id).sort()).toEqual([subA.id, subB.id].sort());

    // Now A and B are each placed once; conference default is 1, so the next
    // unconference slot should not consider either of them.
    const slot2 = await owner.rpc.agenda.createSlot({
      slug: conf.slug, type: "unconference",
      starts_at: Date.now() + 2 * 60 * 60 * 1000,
      ends_at:   Date.now() + 3 * 60 * 60 * 1000,
    });
    const r2 = await owner.rpc.agenda.assign({ slug: conf.slug, slot_id: slot2.id });
    if (r2.kind !== "unconference") throw new Error("expected unconference");
    expect(r2.placements.length).toBe(0);

    // The participant submissions list filters finished sessions out for
    // non-mods, but mods still see them with placement_count + is_finished.
    const partList = await p1.rpc.submissions.list({ slug: conf.slug });
    expect(partList.map((s) => s.id)).toEqual([]);

    const modList = await owner.rpc.submissions.list({ slug: conf.slug });
    expect(modList.map((s) => s.id).sort()).toEqual([subA.id, subB.id].sort());
    for (const row of modList) {
      expect(row.is_finished).toBe(true);
      expect(row.placement_count).toBe(1);
    }
  });

  test("rerunning the same slot does not push a session over the cap (slot's own placements ignored)", async () => {
    const owner = new Client(ctx.app);
    await signupAndLogin(owner, "finowner2@example.com");
    const conf = await owner.rpc.conferences.create({ name: "Fin Rerun" });
    const room = await owner.rpc.rooms.create({ slug: conf.slug, name: "R", capacity: 50 });
    const { client: p1 } = await inviteAndClaim(ctx.app, owner, conf.slug, "rr1@example.com");
    const subA = await p1.rpc.submissions.create({ slug: conf.slug, title: "A" });
    await owner.rpc.submissions.publish({ slug: conf.slug, id: subA.id });
    await p1.rpc.submissions.star({ slug: conf.slug, id: subA.id });

    const slot = await owner.rpc.agenda.createSlot({
      slug: conf.slug, type: "unconference",
      starts_at: Date.now(), ends_at: Date.now() + 60 * 60 * 1000,
    });
    const r1 = await owner.rpc.agenda.assign({ slug: conf.slug, slot_id: slot.id });
    if (r1.kind !== "unconference") throw new Error("unc1");
    expect(r1.placements.length).toBe(1);

    const r2 = await owner.rpc.agenda.assign({ slug: conf.slug, slot_id: slot.id });
    if (r2.kind !== "unconference") throw new Error("unc2");
    expect(r2.placements.length).toBe(1);
    void room;
  });

  test("moderator override: setting max_placements=null lifts the cap for one session", async () => {
    const owner = new Client(ctx.app);
    await signupAndLogin(owner, "finowner3@example.com");
    const conf = await owner.rpc.conferences.create({ name: "Fin Override" });
    const room = await owner.rpc.rooms.create({ slug: conf.slug, name: "R", capacity: 50 });
    const { client: p1 } = await inviteAndClaim(ctx.app, owner, conf.slug, "ov1@example.com");

    const sub = await p1.rpc.submissions.create({ slug: conf.slug, title: "Recurring" });
    await owner.rpc.submissions.publish({ slug: conf.slug, id: sub.id });
    await p1.rpc.submissions.star({ slug: conf.slug, id: sub.id });

    // Conference default is 1; mod raises this session's cap to unlimited via
    // a large number (no separate "unlimited" sentinel in the API). Use 99.
    await owner.rpc.submissions.update({
      slug: conf.slug, id: sub.id, max_placements: 99,
    });

    const slot1 = await owner.rpc.agenda.createSlot({
      slug: conf.slug, type: "unconference",
      starts_at: Date.now(), ends_at: Date.now() + 60 * 60 * 1000,
    });
    const slot2 = await owner.rpc.agenda.createSlot({
      slug: conf.slug, type: "unconference",
      starts_at: Date.now() + 2 * 60 * 60 * 1000,
      ends_at:   Date.now() + 3 * 60 * 60 * 1000,
    });
    await owner.rpc.agenda.assign({ slug: conf.slug, slot_id: slot1.id });
    const r2 = await owner.rpc.agenda.assign({ slug: conf.slug, slot_id: slot2.id });
    if (r2.kind !== "unconference") throw new Error("expected unconf");
    expect(r2.placements.length).toBe(1);
    void room;
  });

  test("manually_finished excludes a session immediately and hides it from participants", async () => {
    const owner = new Client(ctx.app);
    await signupAndLogin(owner, "finowner4@example.com");
    const conf = await owner.rpc.conferences.create({ name: "Fin Manual" });
    const room = await owner.rpc.rooms.create({ slug: conf.slug, name: "R", capacity: 50 });
    const { client: p1 } = await inviteAndClaim(ctx.app, owner, conf.slug, "mf1@example.com");

    const sub = await p1.rpc.submissions.create({ slug: conf.slug, title: "Withdrawn" });
    await owner.rpc.submissions.publish({ slug: conf.slug, id: sub.id });
    await p1.rpc.submissions.star({ slug: conf.slug, id: sub.id });

    // Mod marks finished before it ever runs. Default cap is 1 but
    // manually_finished short-circuits.
    await owner.rpc.submissions.update({
      slug: conf.slug, id: sub.id, manually_finished: true,
    });

    const slot = await owner.rpc.agenda.createSlot({
      slug: conf.slug, type: "unconference",
      starts_at: Date.now(), ends_at: Date.now() + 60 * 60 * 1000,
    });
    const r = await owner.rpc.agenda.assign({ slug: conf.slug, slot_id: slot.id });
    if (r.kind !== "unconference") throw new Error("expected unconf");
    expect(r.placements.length).toBe(0);

    // Participant doesn't see it.
    const partList = await p1.rpc.submissions.list({ slug: conf.slug });
    expect(partList).toEqual([]);

    // Mod sees it with manually_finished + is_finished + placement_count=0.
    const modList = await owner.rpc.submissions.list({ slug: conf.slug });
    expect(modList.length).toBe(1);
    expect(modList[0]!.is_finished).toBe(true);
    expect(modList[0]!.manually_finished).toBe(true);
    expect(modList[0]!.placement_count).toBe(0);
    void room;
  });

  test("static TrackAssignment counts toward placement_count", async () => {
    const owner = new Client(ctx.app);
    await signupAndLogin(owner, "finowner5@example.com");
    const conf = await owner.rpc.conferences.create({ name: "Fin Static" });
    const room = await owner.rpc.rooms.create({ slug: conf.slug, name: "R", capacity: 50 });
    const { client: p1 } = await inviteAndClaim(ctx.app, owner, conf.slug, "st1@example.com");

    const sub = await p1.rpc.submissions.create({ slug: conf.slug, title: "Keynote" });
    await owner.rpc.submissions.publish({ slug: conf.slug, id: sub.id });

    const slotNormal = await owner.rpc.agenda.createSlot({
      slug: conf.slug, type: "normal",
      starts_at: Date.now(), ends_at: Date.now() + 60 * 60 * 1000,
    });
    await owner.rpc.agenda.setTrack({
      slug: conf.slug, slot_id: slotNormal.id, room_id: room.id, submission_id: sub.id,
    });

    // After being placed in a static slot, the session is finished and the
    // next unconference assignment must exclude it.
    const modList = await owner.rpc.submissions.list({ slug: conf.slug });
    expect(modList[0]!.placement_count).toBe(1);
    expect(modList[0]!.is_finished).toBe(true);

    // Participant doesn't see it on the Sessions overview.
    const partList = await p1.rpc.submissions.list({ slug: conf.slug });
    expect(partList).toEqual([]);

    await p1.rpc.submissions.star({ slug: conf.slug, id: sub.id }).catch(() => {});
    const slotUnconf = await owner.rpc.agenda.createSlot({
      slug: conf.slug, type: "unconference",
      starts_at: Date.now() + 2 * 60 * 60 * 1000,
      ends_at:   Date.now() + 3 * 60 * 60 * 1000,
    });
    const r = await owner.rpc.agenda.assign({ slug: conf.slug, slot_id: slotUnconf.id });
    if (r.kind !== "unconference") throw new Error("expected unconf");
    expect(r.placements.length).toBe(0);
  });

  test("non-mod sees own unpublished submissions; published-only for others", async () => {
    const owner = new Client(ctx.app);
    await signupAndLogin(owner, "selfvis@example.com");
    const conf = await owner.rpc.conferences.create({ name: "Self Visibility" });
    const { client: alice } = await inviteAndClaim(ctx.app, owner, conf.slug, "alice@example.com");
    const { client: bob } = await inviteAndClaim(ctx.app, owner, conf.slug, "bob@example.com");

    const a = await alice.rpc.submissions.create({ slug: conf.slug, title: "Alice's draft" });
    const b = await bob.rpc.submissions.create({ slug: conf.slug, title: "Bob's draft" });
    // Bob publishes nothing yet. Alice sees her own draft on the list (which
    // previously hid all non-published rows from non-mods).
    const aliceList = await alice.rpc.submissions.list({ slug: conf.slug });
    expect(aliceList.map((s) => s.id)).toContain(a.id);
    expect(aliceList.map((s) => s.id)).not.toContain(b.id);

    // After Bob's submission is published, Alice sees both.
    await owner.rpc.submissions.publish({ slug: conf.slug, id: b.id });
    const aliceList2 = await alice.rpc.submissions.list({ slug: conf.slug });
    expect(aliceList2.map((s) => s.id).sort()).toEqual([a.id, b.id].sort());
  });

  test("submitter can delete own submitted session; can't delete after publish", async () => {
    const owner = new Client(ctx.app);
    await signupAndLogin(owner, "delown@example.com");
    const conf = await owner.rpc.conferences.create({ name: "Delete Own" });
    const { client: alice } = await inviteAndClaim(ctx.app, owner, conf.slug, "ad@example.com");

    const a = await alice.rpc.submissions.create({ slug: conf.slug, title: "Draft" });
    await alice.rpc.submissions.delete({ slug: conf.slug, id: a.id });
    const after = await alice.rpc.submissions.list({ slug: conf.slug });
    expect(after.map((s) => s.id)).not.toContain(a.id);

    // Once published, the submitter loses the right to delete (mods still can).
    const a2 = await alice.rpc.submissions.create({ slug: conf.slug, title: "Published" });
    await owner.rpc.submissions.publish({ slug: conf.slug, id: a2.id });
    await expect(alice.rpc.submissions.delete({ slug: conf.slug, id: a2.id }))
      .rejects.toBeInstanceOf(ORPCError);

    await owner.rpc.submissions.delete({ slug: conf.slug, id: a2.id });
    const final = await owner.rpc.submissions.list({ slug: conf.slug });
    expect(final.map((s) => s.id)).not.toContain(a2.id);
  });

  test("submitter cannot delete someone else's submission", async () => {
    const owner = new Client(ctx.app);
    await signupAndLogin(owner, "delcross@example.com");
    const conf = await owner.rpc.conferences.create({ name: "Delete Cross" });
    const { client: alice } = await inviteAndClaim(ctx.app, owner, conf.slug, "x1@example.com");
    const { client: bob }   = await inviteAndClaim(ctx.app, owner, conf.slug, "x2@example.com");

    const a = await alice.rpc.submissions.create({ slug: conf.slug, title: "Alice only" });
    await expect(bob.rpc.submissions.delete({ slug: conf.slug, id: a.id }))
      .rejects.toBeInstanceOf(ORPCError);
  });

  test("conference default lifted to null = unlimited reuse across slots", async () => {
    const owner = new Client(ctx.app);
    await signupAndLogin(owner, "finowner6@example.com");
    const conf = await owner.rpc.conferences.create({ name: "Fin Unlimited" });
    await owner.rpc.conferences.update({
      slug: conf.slug, submission_max_placements_default: null,
    });
    const detail = await owner.rpc.conferences.get({ slug: conf.slug });
    expect(detail.submission_max_placements_default).toBeNull();

    const room = await owner.rpc.rooms.create({ slug: conf.slug, name: "R", capacity: 50 });
    const { client: p1 } = await inviteAndClaim(ctx.app, owner, conf.slug, "ul1@example.com");
    const sub = await p1.rpc.submissions.create({ slug: conf.slug, title: "Always" });
    await owner.rpc.submissions.publish({ slug: conf.slug, id: sub.id });
    await p1.rpc.submissions.star({ slug: conf.slug, id: sub.id });

    const slot1 = await owner.rpc.agenda.createSlot({
      slug: conf.slug, type: "unconference",
      starts_at: Date.now(), ends_at: Date.now() + 60 * 60 * 1000,
    });
    const slot2 = await owner.rpc.agenda.createSlot({
      slug: conf.slug, type: "unconference",
      starts_at: Date.now() + 2 * 60 * 60 * 1000,
      ends_at:   Date.now() + 3 * 60 * 60 * 1000,
    });
    const r1 = await owner.rpc.agenda.assign({ slug: conf.slug, slot_id: slot1.id });
    const r2 = await owner.rpc.agenda.assign({ slug: conf.slug, slot_id: slot2.id });
    if (r1.kind !== "unconference" || r2.kind !== "unconference") throw new Error("unc");
    expect(r1.placements.length).toBe(1);
    expect(r2.placements.length).toBe(1);
    void room;
  });
});

describe("notifications", () => {
  let ctx: TestApp;
  beforeAll(() => { ctx = setupTestApp(); });
  afterAll(async () => { await ctx.cleanup(); });

  test("publishing notifies the submitter; mods get a 'new submission' ping", async () => {
    const owner = new Client(ctx.app);
    await signupAndLogin(owner, "nowner@example.com");
    const conf = await owner.rpc.conferences.create({ name: "Notify" });
    const { client: part } =
      await inviteAndClaim(ctx.app, owner, conf.slug, "npart@example.com");

    // Owner has no notifications initially.
    let ownerInbox = await owner.rpc.notifications.list({ slug: conf.slug });
    expect(ownerInbox.unread_count).toBe(0);

    const sub = await part.rpc.submissions.create({
      slug: conf.slug, title: "Hello",
    });

    // Mods (owner here) get a "submission_received" ping.
    ownerInbox = await owner.rpc.notifications.list({ slug: conf.slug });
    expect(ownerInbox.unread_count).toBe(1);
    expect(ownerInbox.items[0]!.kind).toBe("submission_received");

    // Submitter has no notification yet.
    let partInbox = await part.rpc.notifications.list({ slug: conf.slug });
    expect(partInbox.unread_count).toBe(0);

    await owner.rpc.submissions.publish({ slug: conf.slug, id: sub.id });

    partInbox = await part.rpc.notifications.list({ slug: conf.slug });
    expect(partInbox.unread_count).toBe(1);
    expect(partInbox.items[0]!.kind).toBe("submission_published");
    expect(partInbox.items[0]!.cta_href).toBe("tab:sessions");

    // markRead toggles unread count.
    await part.rpc.notifications.markRead({
      slug: conf.slug, id: partInbox.items[0]!.id,
    });
    partInbox = await part.rpc.notifications.list({ slug: conf.slug });
    expect(partInbox.unread_count).toBe(0);
    expect(partInbox.items[0]!.read_at).not.toBeNull();
  });

  test("rejection notifies the submitter; markAllRead clears everything", async () => {
    const owner = new Client(ctx.app);
    await signupAndLogin(owner, "rejowner@example.com");
    const conf = await owner.rpc.conferences.create({ name: "Reject" });
    const { client: part } =
      await inviteAndClaim(ctx.app, owner, conf.slug, "rejpart@example.com");

    const sub = await part.rpc.submissions.create({
      slug: conf.slug, title: "Nope",
    });
    await owner.rpc.submissions.reject({ slug: conf.slug, id: sub.id });

    const before = await part.rpc.notifications.list({ slug: conf.slug });
    expect(before.unread_count).toBe(1);
    expect(before.items[0]!.kind).toBe("submission_rejected");

    await part.rpc.notifications.markAllRead({ slug: conf.slug });
    const after = await part.rpc.notifications.list({ slug: conf.slug });
    expect(after.unread_count).toBe(0);
  });

  test("assign notifies every placed participant", async () => {
    const owner = new Client(ctx.app);
    await signupAndLogin(owner, "asnown@example.com");
    const conf = await owner.rpc.conferences.create({ name: "Assign Notify" });
    await owner.rpc.rooms.create({ slug: conf.slug, name: "Hall", capacity: 50 });

    const parts: Client[] = [];
    for (let i = 0; i < 3; i++) {
      const { client } =
        await inviteAndClaim(ctx.app, owner, conf.slug, `as${i}@example.com`);
      parts.push(client);
    }
    const sub = await parts[0]!.rpc.submissions.create({
      slug: conf.slug, title: "Talk",
    });
    await owner.rpc.submissions.publish({ slug: conf.slug, id: sub.id });
    for (const c of parts) {
      await c.rpc.submissions.star({ slug: conf.slug, id: sub.id });
    }
    const slot = await owner.rpc.agenda.createSlot({
      slug: conf.slug, type: "unconference",
      starts_at: Date.now(), ends_at: Date.now() + 60 * 60 * 1000,
    });
    await owner.rpc.agenda.assign({ slug: conf.slug, slot_id: slot.id });

    for (const c of parts) {
      const inbox = await c.rpc.notifications.list({ slug: conf.slug });
      const assigned = inbox.items.find((n) => n.kind === "unconf_assigned");
      expect(assigned).toBeDefined();
      expect(assigned!.cta_href).toBe("tab:me");
    }
  });

  test("expert booking notifies the expert; cancellation notifies the other party", async () => {
    const owner = new Client(ctx.app);
    await signupAndLogin(owner, "expnown@example.com");
    const conf = await owner.rpc.conferences.create({ name: "Exp Notify" });
    const room = await owner.rpc.rooms.create({
      slug: conf.slug, name: "Booth", capacity: 4,
    });

    const { client: expertC, identity_id: expertId } =
      await inviteAndClaim(ctx.app, owner, conf.slug, "exp@example.com");
    const { client: booker } =
      await inviteAndClaim(ctx.app, owner, conf.slug, "bk@example.com");

    const pool = await owner.rpc.experts.createPool({
      slug: conf.slug, name: "Booths", room_ids: [room.id],
    });
    const expert = await owner.rpc.experts.promote({
      slug: conf.slug, identity_id: expertId, pool_id: pool.id,
    });
    const start = Date.now() + 60 * 60 * 1000;
    await owner.rpc.experts.createTimeframe({
      slug: conf.slug, expert_id: expert.id,
      starts_at: start, ends_at: start + 60 * 60 * 1000,
      slot_duration_minutes: 30,
    });

    const booking = await booker.rpc.experts.book({
      slug: conf.slug, expert_id: expert.id, starts_at: start,
    });

    // Expert got a "expert_booked" notification.
    const expInbox = await expertC.rpc.notifications.list({ slug: conf.slug });
    expect(expInbox.items.find((n) => n.kind === "expert_booked")).toBeDefined();

    // Booker cancels — expert gets a cancellation notification.
    await booker.rpc.experts.cancelBooking({
      slug: conf.slug, booking_id: booking.booking_id,
    });
    const expInbox2 = await expertC.rpc.notifications.list({ slug: conf.slug });
    expect(expInbox2.items.find((n) => n.kind === "expert_booking_cancelled"))
      .toBeDefined();
  });

  test("inbox is isolated per identity", async () => {
    const owner = new Client(ctx.app);
    await signupAndLogin(owner, "isoown@example.com");
    const conf = await owner.rpc.conferences.create({ name: "Iso" });
    const { client: a } =
      await inviteAndClaim(ctx.app, owner, conf.slug, "iso-a@example.com");
    const { client: b } =
      await inviteAndClaim(ctx.app, owner, conf.slug, "iso-b@example.com");

    const subA = await a.rpc.submissions.create({ slug: conf.slug, title: "A" });
    await owner.rpc.submissions.publish({ slug: conf.slug, id: subA.id });

    const aInbox = await a.rpc.notifications.list({ slug: conf.slug });
    const bInbox = await b.rpc.notifications.list({ slug: conf.slug });
    expect(aInbox.items.find((n) => n.kind === "submission_published")).toBeDefined();
    expect(bInbox.items.find((n) => n.kind === "submission_published")).toBeUndefined();
  });
});
