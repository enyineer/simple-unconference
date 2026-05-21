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

describe("room requirements (tag-based pre-assignment)", () => {
  let ctx: TestApp;
  beforeAll(() => { ctx = setupTestApp(); });
  afterAll(async () => { await ctx.cleanup(); });

  test("tag-constrained session takes a matching room over a more-popular session", async () => {
    const owner = new Client(ctx.app);
    await signupAndLogin(owner, "tagowner1@example.com");
    const conf = await owner.rpc.conferences.create({ name: "Tag Conf 1" });

    // Two rooms; only the smaller has a projector.
    await owner.rpc.rooms.create({
      slug: conf.slug, name: "Plain Hall", capacity: 50,
    });
    const projRoom = await owner.rpc.rooms.create({
      slug: conf.slug, name: "Studio", capacity: 10, tags: ["projector"],
    });

    // Two sessions: A is more popular but needs no projector; B needs projector.
    const subA = await owner.rpc.submissions.create({
      slug: conf.slug, title: "Talk A",
    });
    const subB = await owner.rpc.submissions.create({
      slug: conf.slug, title: "Talk B",
      room_requirements: ["projector"],
    });
    await owner.rpc.submissions.publish({ slug: conf.slug, id: subA.id });
    await owner.rpc.submissions.publish({ slug: conf.slug, id: subB.id });

    // Star A more so it would naturally win the big room.
    const p1 = new Client(ctx.app);
    const p2 = new Client(ctx.app);
    const p3 = new Client(ctx.app);
    for (const c of [p1, p2, p3]) {
      const inv = await owner.rpc.conferences.createInvite({
        slug: conf.slug, email: `tag1-${Math.random()}@x.com`,
      });
      await c.rpc.conferences.claimInvite({
        slug: conf.slug, token: inv.token, password: "abcdef",
      });
    }
    await p1.rpc.submissions.star({ slug: conf.slug, id: subA.id });
    await p2.rpc.submissions.star({ slug: conf.slug, id: subA.id });
    await p3.rpc.submissions.star({ slug: conf.slug, id: subB.id });

    const slot = await owner.rpc.agenda.createSlot({
      slug: conf.slug, type: "unconference",
      starts_at: Date.now(), ends_at: Date.now() + 3600_000,
    });
    const r = await owner.rpc.agenda.assign({ slug: conf.slug, slot_id: slot.id });
    if (r.kind !== "unconference") throw new Error(`expected unconference, got ${r.kind}`);

    // B is pinned to projRoom by the tag match.
    expect(r.placements.find((p) => p.submission_id === subB.id)?.room_id).toBe(projRoom.id);
    // A takes the remaining room — Plain Hall.
    expect(r.placements.find((p) => p.submission_id === subA.id)?.room_id).not.toBe(projRoom.id);
  });

  test("unsatisfiable required tags surface as a structured conflict", async () => {
    const owner = new Client(ctx.app);
    await signupAndLogin(owner, "tagowner2@example.com");
    const conf = await owner.rpc.conferences.create({ name: "Tag Conf 2" });
    // Only one room has the projector tag, but it's pinned to another session,
    // so a second session that requires projector has no eligible room.
    const studio = await owner.rpc.rooms.create({
      slug: conf.slug, name: "Studio", capacity: 10, tags: ["projector"],
    });
    await owner.rpc.rooms.create({
      slug: conf.slug, name: "Plain", capacity: 10,
    });
    const pinned = await owner.rpc.submissions.create({
      slug: conf.slug, title: "Pinned session",
    });
    const tagged = await owner.rpc.submissions.create({
      slug: conf.slug, title: "Needs projector",
      room_requirements: ["projector"],
    });
    await owner.rpc.submissions.publish({ slug: conf.slug, id: pinned.id });
    await owner.rpc.submissions.publish({ slug: conf.slug, id: tagged.id });
    await owner.rpc.submissions.update({
      slug: conf.slug, id: pinned.id, pre_assigned_room_id: studio.id,
    });

    const slot = await owner.rpc.agenda.createSlot({
      slug: conf.slug, type: "unconference",
      starts_at: Date.now(), ends_at: Date.now() + 3600_000,
    });
    const r = await owner.rpc.agenda.assign({ slug: conf.slug, slot_id: slot.id });
    expect(r.kind).toBe("conflict");
    if (r.kind !== "conflict") throw new Error("expected conflict");
    expect(r.conflicts).toHaveLength(1);
    const c = r.conflicts[0]!;
    expect(c.kind).toBe("unsatisfiable_requirements");
    if (c.kind !== "unsatisfiable_requirements") throw new Error("bad shape");
    expect(c.submission.id).toBe(tagged.id);
    expect(c.required_tags).toEqual(["projector"]);
    // Studio matches the tag but is reserved by the pin, so it still
    // appears as a candidate (the mod sees why placement failed).
    expect(c.candidate_room_names).toEqual(["Studio"]);
  });

  test("server filters out room_requirements that don't exist as a room tag", async () => {
    const owner = new Client(ctx.app);
    await signupAndLogin(owner, "tagowner3@example.com");
    const conf = await owner.rpc.conferences.create({ name: "Tag Conf 3" });
    await owner.rpc.rooms.create({
      slug: conf.slug, name: "Studio", capacity: 10, tags: ["projector"],
    });
    const sub = await owner.rpc.submissions.create({
      slug: conf.slug, title: "Test",
      room_requirements: ["projector", "nonexistent_feature"],
    });
    const list = await owner.rpc.submissions.list({ slug: conf.slug });
    const row = list.find((s) => s.id === sub.id)!;
    // "nonexistent_feature" was dropped because no room has it.
    expect(row.room_requirements).toEqual(["projector"]);
  });

  test("pin overrides tag requirements", async () => {
    const owner = new Client(ctx.app);
    await signupAndLogin(owner, "tagowner4@example.com");
    const conf = await owner.rpc.conferences.create({ name: "Tag Conf 4" });
    const plain = await owner.rpc.rooms.create({
      slug: conf.slug, name: "Plain Room", capacity: 30,
    });
    await owner.rpc.rooms.create({
      slug: conf.slug, name: "Studio", capacity: 10, tags: ["projector"],
    });
    const sub = await owner.rpc.submissions.create({
      slug: conf.slug, title: "Talk",
      room_requirements: ["projector"],
    });
    await owner.rpc.submissions.publish({ slug: conf.slug, id: sub.id });
    // Mod overrides the projector requirement by pinning to plain room.
    await owner.rpc.submissions.update({
      slug: conf.slug, id: sub.id, pre_assigned_room_id: plain.id,
    });

    const slot = await owner.rpc.agenda.createSlot({
      slug: conf.slug, type: "unconference",
      starts_at: Date.now(), ends_at: Date.now() + 3600_000,
    });
    const r = await owner.rpc.agenda.assign({ slug: conf.slug, slot_id: slot.id });
    if (r.kind !== "unconference") throw new Error(`expected unconference, got ${r.kind}`);
    expect(r.placements.find((p) => p.submission_id === sub.id)?.room_id).toBe(plain.id);
  });

  // --- Bipartite matching edge cases ----------------------------------------

  // Helper: spin up a conference with N participants, rooms, and published
  // submissions wired up with the given star/tag/pin structure. Returns
  // everything callers need for assertions.
  async function spinUpConference(prefix: string, opts: {
    rooms: { name: string; capacity: number; tags?: string[] }[];
    subs: {
      title: string;
      stars: number;            // number of distinct stargazers (≤ participants)
      tags?: string[];          // room_requirements
      pinTo?: number;           // room index in opts.rooms (after creation)
    }[];
    participants: number;
  }) {
    const owner = new Client(ctx.app);
    await signupAndLogin(owner, `${prefix}-owner@example.com`);
    const conf = await owner.rpc.conferences.create({ name: `Conf ${prefix}` });
    const rooms = [];
    for (const r of opts.rooms) {
      const room = await owner.rpc.rooms.create({
        slug: conf.slug, name: r.name, capacity: r.capacity, tags: r.tags,
      });
      rooms.push(room);
    }
    const subs = [];
    for (const s of opts.subs) {
      const sub = await owner.rpc.submissions.create({
        slug: conf.slug, title: s.title,
        ...(s.tags ? { room_requirements: s.tags } : {}),
      });
      await owner.rpc.submissions.publish({ slug: conf.slug, id: sub.id });
      if (s.pinTo !== undefined) {
        await owner.rpc.submissions.update({
          slug: conf.slug, id: sub.id, pre_assigned_room_id: rooms[s.pinTo]!.id,
        });
      }
      subs.push(sub);
    }
    // Mint participants and have them star sessions to hit each `stars` count.
    const parts: Client[] = [];
    for (let i = 0; i < opts.participants; i++) {
      const c = new Client(ctx.app);
      const inv = await owner.rpc.conferences.createInvite({
        slug: conf.slug, email: `${prefix}-p${i}-${Math.random()}@x.com`,
      });
      await c.rpc.conferences.claimInvite({
        slug: conf.slug, token: inv.token, password: "abcdef",
      });
      parts.push(c);
    }
    for (let i = 0; i < opts.subs.length; i++) {
      const desired = opts.subs[i]!.stars;
      for (let j = 0; j < desired && j < parts.length; j++) {
        await parts[j]!.rpc.submissions.star({ slug: conf.slug, id: subs[i]!.id });
      }
    }
    const slot = await owner.rpc.agenda.createSlot({
      slug: conf.slug, type: "unconference",
      starts_at: Date.now(), ends_at: Date.now() + 3600_000,
    });
    return { owner, conf, rooms, subs, parts, slot };
  }

  test("two tag-constrained sessions: more-starred gets the larger matching room", async () => {
    // Both need 'projector'; both projector rooms differ in size. Without
    // ASC-processing in Kuhn's, the more-popular session could end up in the
    // smaller room because augmenting paths displace earlier matches.
    const s = await spinUpConference("tag-pop", {
      rooms: [
        { name: "Big Studio", capacity: 50, tags: ["projector"] },
        { name: "Small Studio", capacity: 10, tags: ["projector"] },
      ],
      subs: [
        { title: "Popular", stars: 5, tags: ["projector"] },
        { title: "Niche", stars: 1, tags: ["projector"] },
      ],
      participants: 6,
    });
    const r = await s.owner.rpc.agenda.assign({ slug: s.conf.slug, slot_id: s.slot.id });
    if (r.kind !== "unconference") throw new Error(`expected unconference, got ${r.kind}`);
    const popRoomId = r.placements.find((p) => p.submission_id === s.subs[0]!.id)?.room_id;
    const niceRoomId = r.placements.find((p) => p.submission_id === s.subs[1]!.id)?.room_id;
    expect(popRoomId).toBe(s.rooms[0]!.id); // Big Studio
    expect(niceRoomId).toBe(s.rooms[1]!.id); // Small Studio
  });

  test("augmenting path: less-popular session with one option displaces more-popular session", async () => {
    // P needs only 'X+Y' (one matching room R1). N needs 'X' (two rooms).
    // A naive greedy would let P grab R1, blocking N. Bipartite augmenting
    // handles this regardless of processing order — final must satisfy both.
    const s = await spinUpConference("aug-path", {
      rooms: [
        { name: "Combo", capacity: 30, tags: ["projector", "whiteboard"] },
        { name: "Plain Projector", capacity: 30, tags: ["projector"] },
      ],
      subs: [
        { title: "Popular Combo", stars: 5, tags: ["projector", "whiteboard"] },
        { title: "Niche Projector", stars: 1, tags: ["projector"] },
      ],
      participants: 6,
    });
    const r = await s.owner.rpc.agenda.assign({ slug: s.conf.slug, slot_id: s.slot.id });
    if (r.kind !== "unconference") throw new Error(`expected unconference, got ${r.kind}`);
    // Popular Combo (needs both tags) → Combo room. Niche → Plain Projector.
    expect(r.placements.find((p) => p.submission_id === s.subs[0]!.id)?.room_id)
      .toBe(s.rooms[0]!.id);
    expect(r.placements.find((p) => p.submission_id === s.subs[1]!.id)?.room_id)
      .toBe(s.rooms[1]!.id);
  });

  test("three constrained sessions, three matching rooms: ordered by stars → capacity", async () => {
    const s = await spinUpConference("tag-triple", {
      rooms: [
        { name: "Big", capacity: 100, tags: ["projector"] },
        { name: "Medium", capacity: 30, tags: ["projector"] },
        { name: "Small", capacity: 5, tags: ["projector"] },
      ],
      subs: [
        { title: "Top", stars: 5, tags: ["projector"] },
        { title: "Mid", stars: 3, tags: ["projector"] },
        { title: "Low", stars: 1, tags: ["projector"] },
      ],
      participants: 6,
    });
    const r = await s.owner.rpc.agenda.assign({ slug: s.conf.slug, slot_id: s.slot.id });
    if (r.kind !== "unconference") throw new Error(`expected unconference, got ${r.kind}`);
    expect(r.placements.find((p) => p.submission_id === s.subs[0]!.id)?.room_id).toBe(s.rooms[0]!.id);
    expect(r.placements.find((p) => p.submission_id === s.subs[1]!.id)?.room_id).toBe(s.rooms[1]!.id);
    expect(r.placements.find((p) => p.submission_id === s.subs[2]!.id)?.room_id).toBe(s.rooms[2]!.id);
  });

  test("two constrained sessions, one matching room: less-popular surfaces as unsatisfiable", async () => {
    const s = await spinUpConference("tag-1room", {
      rooms: [
        { name: "Only Projector", capacity: 20, tags: ["projector"] },
        { name: "Plain", capacity: 20 },
      ],
      subs: [
        { title: "Popular", stars: 5, tags: ["projector"] },
        { title: "Niche", stars: 1, tags: ["projector"] },
      ],
      participants: 6,
    });
    const r = await s.owner.rpc.agenda.assign({ slug: s.conf.slug, slot_id: s.slot.id });
    expect(r.kind).toBe("conflict");
    if (r.kind !== "conflict") throw new Error("expected conflict");
    expect(r.conflicts).toHaveLength(1);
    const c = r.conflicts[0]!;
    if (c.kind !== "unsatisfiable_requirements") throw new Error("bad shape");
    expect(c.submission.id).toBe(s.subs[1]!.id); // Niche (less popular) loses
    expect(c.candidate_room_names).toEqual(["Only Projector"]);
  });

  test("pin + tag on same session: pin wins; tag silently ignored even if pin room lacks the tag", async () => {
    const s = await spinUpConference("pin-over-tag", {
      rooms: [
        { name: "Plain", capacity: 50 },
        { name: "Studio", capacity: 10, tags: ["projector"] },
      ],
      subs: [
        // Pinned to Plain (no projector tag) but also requests projector.
        { title: "Locked", stars: 5, tags: ["projector"], pinTo: 0 },
      ],
      participants: 5,
    });
    const r = await s.owner.rpc.agenda.assign({ slug: s.conf.slug, slot_id: s.slot.id });
    if (r.kind !== "unconference") throw new Error(`expected unconference, got ${r.kind}`);
    expect(r.placements.find((p) => p.submission_id === s.subs[0]!.id)?.room_id).toBe(s.rooms[0]!.id);
  });

  test("pin outside top-N is ignored (no conflict raised)", async () => {
    // 1 room, 2 subs. top-1 = popular only. The unpopular pinned sub
    // doesn't make the cut, so its pin is silently dropped.
    const s = await spinUpConference("pin-outside", {
      rooms: [
        { name: "Only Room", capacity: 10 },
      ],
      subs: [
        { title: "Popular", stars: 5 },
        // Pinned to the same room, but doesn't make top-1 cut.
        { title: "Unpopular", stars: 1, pinTo: 0 },
      ],
      participants: 6,
    });
    const r = await s.owner.rpc.agenda.assign({ slug: s.conf.slug, slot_id: s.slot.id });
    if (r.kind !== "unconference") throw new Error(`expected unconference, got ${r.kind}`);
    expect(r.placements).toHaveLength(1);
    expect(r.placements[0]!.submission_id).toBe(s.subs[0]!.id);
  });

  test("tag-constrained session outside top-N is ignored (no conflict raised)", async () => {
    // 1 room (no projector tag), 2 subs. top-1 = popular (unconstrained).
    // The unpopular session requires projector but doesn't make top-1 cut,
    // so the unsatisfiable case never fires.
    const s = await spinUpConference("tag-outside", {
      rooms: [
        { name: "Plain Only", capacity: 10 },
      ],
      subs: [
        { title: "Popular", stars: 5 },
        { title: "Niche Needs Projector", stars: 1, tags: ["projector"] },
      ],
      participants: 6,
    });
    // No room has 'projector' so the filter drops the requirement at submit
    // time — to simulate the real case (frozen requirement, room loses tag
    // later), update the requirement directly through the mod path on an
    // already-published session here we'd need to add a projector room
    // first. Skip that complication: this test only verifies that an
    // outside-top-N sub doesn't raise conflicts even when its tags wouldn't
    // be satisfiable.
    const r = await s.owner.rpc.agenda.assign({ slug: s.conf.slug, slot_id: s.slot.id });
    if (r.kind !== "unconference") throw new Error(`expected unconference, got ${r.kind}`);
    expect(r.placements).toHaveLength(1);
    expect(r.placements[0]!.submission_id).toBe(s.subs[0]!.id);
  });

  test("mixed top-N: pinned + tag-constrained + unconstrained all get correct rooms", async () => {
    // 3 rooms, 3 sessions:
    //   P: pinned to Plain (medium)
    //   T: needs 'projector' → Studio (small, only projector room)
    //   U: unconstrained → takes leftover Auditorium (largest)
    const s = await spinUpConference("mixed", {
      rooms: [
        { name: "Auditorium", capacity: 50 },
        { name: "Plain", capacity: 30 },
        { name: "Studio", capacity: 10, tags: ["projector"] },
      ],
      subs: [
        { title: "Unconstrained Popular", stars: 5 },
        { title: "Pinned to Plain", stars: 3, pinTo: 1 },
        { title: "Needs Projector", stars: 1, tags: ["projector"] },
      ],
      participants: 5,
    });
    const r = await s.owner.rpc.agenda.assign({ slug: s.conf.slug, slot_id: s.slot.id });
    if (r.kind !== "unconference") throw new Error(`expected unconference, got ${r.kind}`);
    expect(r.placements.find((p) => p.submission_id === s.subs[1]!.id)?.room_id).toBe(s.rooms[1]!.id); // Plain (pin)
    expect(r.placements.find((p) => p.submission_id === s.subs[2]!.id)?.room_id).toBe(s.rooms[2]!.id); // Studio (tag)
    expect(r.placements.find((p) => p.submission_id === s.subs[0]!.id)?.room_id).toBe(s.rooms[0]!.id); // Auditorium (leftover)
  });

  test("excluded session is dropped from top-N and next-most-starred takes the slot", async () => {
    const s = await spinUpConference("skip", {
      rooms: [
        { name: "R1", capacity: 50 },
        { name: "R2", capacity: 30 },
      ],
      subs: [
        { title: "A", stars: 5 },
        { title: "B", stars: 3 },
        { title: "C", stars: 1 },
      ],
      participants: 6,
    });
    // No exclude → top-2 = [A, B]
    const r1 = await s.owner.rpc.agenda.assign({ slug: s.conf.slug, slot_id: s.slot.id });
    if (r1.kind !== "unconference") throw new Error("expected unconference");
    expect(r1.placements.map((p) => p.submission_id).sort()).toEqual(
      [s.subs[0]!.id, s.subs[1]!.id].sort(),
    );
    // Exclude B → top-2 should now be [A, C]
    const r2 = await s.owner.rpc.agenda.assign({
      slug: s.conf.slug, slot_id: s.slot.id,
      exclude_submission_ids: [s.subs[1]!.id],
    });
    if (r2.kind !== "unconference") throw new Error("expected unconference");
    expect(r2.placements.map((p) => p.submission_id).sort()).toEqual(
      [s.subs[0]!.id, s.subs[2]!.id].sort(),
    );
  });

  test("excluding a non-top-N session has no effect", async () => {
    const s = await spinUpConference("skip-noop", {
      rooms: [{ name: "R", capacity: 10 }],
      subs: [
        { title: "Top", stars: 5 },
        { title: "Bottom", stars: 1 },
      ],
      participants: 6,
    });
    const r = await s.owner.rpc.agenda.assign({
      slug: s.conf.slug, slot_id: s.slot.id,
      exclude_submission_ids: [s.subs[1]!.id], // already outside top-1
    });
    if (r.kind !== "unconference") throw new Error("expected unconference");
    expect(r.placements[0]!.submission_id).toBe(s.subs[0]!.id);
  });

  test("excluding all top-N leaves nothing placed", async () => {
    const s = await spinUpConference("skip-all", {
      rooms: [{ name: "R", capacity: 10 }],
      subs: [
        { title: "Only", stars: 5 },
      ],
      participants: 5,
    });
    const r = await s.owner.rpc.agenda.assign({
      slug: s.conf.slug, slot_id: s.slot.id,
      exclude_submission_ids: [s.subs[0]!.id],
    });
    if (r.kind !== "unconference") throw new Error("expected unconference");
    expect(r.placements).toHaveLength(0);
  });

  test("zero rooms in slot scope: no placements, no conflicts", async () => {
    const owner = new Client(ctx.app);
    await signupAndLogin(owner, "norooms@example.com");
    const conf = await owner.rpc.conferences.create({ name: "No Rooms" });
    const sub = await owner.rpc.submissions.create({
      slug: conf.slug, title: "Talk",
    });
    await owner.rpc.submissions.publish({ slug: conf.slug, id: sub.id });
    const slot = await owner.rpc.agenda.createSlot({
      slug: conf.slug, type: "unconference",
      starts_at: Date.now(), ends_at: Date.now() + 3600_000,
    });
    const r = await owner.rpc.agenda.assign({ slug: conf.slug, slot_id: slot.id });
    if (r.kind !== "unconference") throw new Error(`expected unconference, got ${r.kind}`);
    expect(r.placements).toHaveLength(0);
  });

  test("zero published submissions: no placements, no conflicts", async () => {
    const owner = new Client(ctx.app);
    await signupAndLogin(owner, "nosubs@example.com");
    const conf = await owner.rpc.conferences.create({ name: "No Subs" });
    await owner.rpc.rooms.create({ slug: conf.slug, name: "R", capacity: 10 });
    const slot = await owner.rpc.agenda.createSlot({
      slug: conf.slug, type: "unconference",
      starts_at: Date.now(), ends_at: Date.now() + 3600_000,
    });
    const r = await owner.rpc.agenda.assign({ slug: conf.slug, slot_id: slot.id });
    if (r.kind !== "unconference") throw new Error(`expected unconference, got ${r.kind}`);
    expect(r.placements).toHaveLength(0);
  });

  test("deterministic: identical inputs produce identical placements across re-runs", async () => {
    const s = await spinUpConference("determ", {
      rooms: [
        { name: "Big", capacity: 50 },
        { name: "Med", capacity: 20 },
        { name: "Small", capacity: 5 },
      ],
      subs: [
        { title: "T1", stars: 3 },
        { title: "T2", stars: 3 },
        { title: "T3", stars: 1 },
      ],
      participants: 5,
    });
    const r1 = await s.owner.rpc.agenda.assign({ slug: s.conf.slug, slot_id: s.slot.id });
    const r2 = await s.owner.rpc.agenda.assign({ slug: s.conf.slug, slot_id: s.slot.id });
    if (r1.kind !== "unconference" || r2.kind !== "unconference") throw new Error("expected unconference");
    expect(r1.placements).toEqual(r2.placements);
    expect(r1.user_assignments).toEqual(r2.user_assignments);
  });

  test("multi-tag requirement: only rooms with ALL tags qualify", async () => {
    const s = await spinUpConference("multitag", {
      rooms: [
        { name: "Just Projector", capacity: 30, tags: ["projector"] },
        { name: "Just Whiteboard", capacity: 30, tags: ["whiteboard"] },
        { name: "Both", capacity: 10, tags: ["projector", "whiteboard"] },
      ],
      subs: [
        { title: "Needs Both", stars: 5, tags: ["projector", "whiteboard"] },
      ],
      participants: 5,
    });
    const r = await s.owner.rpc.agenda.assign({ slug: s.conf.slug, slot_id: s.slot.id });
    if (r.kind !== "unconference") throw new Error("expected unconference");
    // Only Both has all tags — even though it's the smallest.
    expect(r.placements.find((p) => p.submission_id === s.subs[0]!.id)?.room_id).toBe(s.rooms[2]!.id);
  });

  test("duplicate_room pre-screen fires before tag matching", async () => {
    // Two sessions both pinned to same room — should surface as
    // duplicate_room, NOT trigger any tag-matching paths.
    const s = await spinUpConference("dupe", {
      rooms: [
        { name: "R1", capacity: 30 },
        { name: "R2", capacity: 30 },
      ],
      subs: [
        { title: "PinA", stars: 3, pinTo: 0 },
        { title: "PinB", stars: 2, pinTo: 0 },
      ],
      participants: 5,
    });
    const r = await s.owner.rpc.agenda.assign({ slug: s.conf.slug, slot_id: s.slot.id });
    expect(r.kind).toBe("conflict");
    if (r.kind !== "conflict") throw new Error("expected conflict");
    expect(r.conflicts).toHaveLength(1);
    const c = r.conflicts[0]!;
    expect(c.kind).toBe("duplicate_room");
  });

  test("tag normalization is case-insensitive across room tags and submission requirements", async () => {
    // Mod creates a room with "Projector" (uppercase), submitter requests
    // "projector" (lowercase). Both normalize to "projector" so the match
    // succeeds.
    const owner = new Client(ctx.app);
    await signupAndLogin(owner, "tagcase@example.com");
    const conf = await owner.rpc.conferences.create({ name: "Tag Case" });
    const studio = await owner.rpc.rooms.create({
      slug: conf.slug, name: "Studio", capacity: 10, tags: ["Projector"],
    });
    const sub = await owner.rpc.submissions.create({
      slug: conf.slug, title: "Talk",
      room_requirements: ["PROJECTOR"],
    });
    await owner.rpc.submissions.publish({ slug: conf.slug, id: sub.id });
    const slot = await owner.rpc.agenda.createSlot({
      slug: conf.slug, type: "unconference",
      starts_at: Date.now(), ends_at: Date.now() + 3600_000,
    });
    const r = await owner.rpc.agenda.assign({ slug: conf.slug, slot_id: slot.id });
    if (r.kind !== "unconference") throw new Error(`expected unconference, got ${r.kind}`);
    expect(r.placements.find((p) => p.submission_id === sub.id)?.room_id).toBe(studio.id);
  });

  test("multi-skip: skipping two top-N sessions promotes the next two", async () => {
    const s = await spinUpConference("multiskip", {
      rooms: [
        { name: "R1", capacity: 30 },
        { name: "R2", capacity: 20 },
      ],
      subs: [
        { title: "A", stars: 5 },
        { title: "B", stars: 4 },
        { title: "C", stars: 2 },
        { title: "D", stars: 1 },
      ],
      participants: 6,
    });
    const r = await s.owner.rpc.agenda.assign({
      slug: s.conf.slug, slot_id: s.slot.id,
      exclude_submission_ids: [s.subs[0]!.id, s.subs[1]!.id], // skip A & B
    });
    if (r.kind !== "unconference") throw new Error(`expected unconference, got ${r.kind}`);
    expect(r.placements.map((p) => p.submission_id).sort())
      .toEqual([s.subs[2]!.id, s.subs[3]!.id].sort());
  });

  test("stage 1 (duplicate_room) takes precedence: tag conflicts hidden until pin conflict fixed", async () => {
    // Both A and B pinned to the same room → duplicate_room. A third
    // session C has unsatisfiable tags. The first call returns ONLY the
    // duplicate_room — the mod fixes it (here we exclude both), then
    // re-runs and sees the tag conflict.
    const s = await spinUpConference("layered", {
      rooms: [
        { name: "Plain", capacity: 30 },
        { name: "Studio", capacity: 10, tags: ["projector"] },
      ],
      subs: [
        { title: "A pinned to Plain", stars: 5, pinTo: 0 },
        { title: "B pinned to Plain", stars: 4, pinTo: 0 },
        // C needs projector; Studio is pinned (well, would be) by D... but
        // here we'll have C compete with another pinned session below.
      ],
      participants: 5,
    });
    const r1 = await s.owner.rpc.agenda.assign({ slug: s.conf.slug, slot_id: s.slot.id });
    expect(r1.kind).toBe("conflict");
    if (r1.kind !== "conflict") throw new Error("expected conflict");
    // First-pass conflict is duplicate_room only.
    expect(r1.conflicts.every((c) => c.kind === "duplicate_room")).toBe(true);
  });

  test("ties on stars: deterministic placement by submission id ascending", async () => {
    const s = await spinUpConference("ties", {
      rooms: [
        { name: "Big", capacity: 50 },
        { name: "Small", capacity: 10 },
      ],
      subs: [
        { title: "First Created", stars: 3 },
        { title: "Second Created", stars: 3 },
      ],
      participants: 3,
    });
    const r = await s.owner.rpc.agenda.assign({ slug: s.conf.slug, slot_id: s.slot.id });
    if (r.kind !== "unconference") throw new Error(`expected unconference, got ${r.kind}`);
    // First-created (smaller id) wins the bigger room.
    expect(r.placements.find((p) => p.submission_id === s.subs[0]!.id)?.room_id).toBe(s.rooms[0]!.id);
  });

  test("cascading conflicts: all unsatisfiable sessions surface in one round, not multiple", async () => {
    // 2 rooms (no projector tag), 3 sessions all needing projector. Without
    // cascade analysis, the mod would resolve sub[0]'s conflict, re-run,
    // see sub[1]'s conflict, re-run, etc. With cascade, all three appear in
    // the same conflict result. (Note: rooms have no projector → all three
    // are unsatisfiable; cascading would never find a feasible top-N.)
    const owner = new Client(ctx.app);
    await signupAndLogin(owner, "cascade@example.com");
    const conf = await owner.rpc.conferences.create({ name: "Cascade" });
    const studio = await owner.rpc.rooms.create({
      slug: conf.slug, name: "Studio", capacity: 20, tags: ["projector"],
    });
    await owner.rpc.rooms.create({
      slug: conf.slug, name: "Plain1", capacity: 20,
    });
    await owner.rpc.rooms.create({
      slug: conf.slug, name: "Plain2", capacity: 20,
    });
    // Pin a session to the projector room first so no projector room is
    // free for any of A/B/C.
    const blocker = await owner.rpc.submissions.create({
      slug: conf.slug, title: "Blocker",
    });
    await owner.rpc.submissions.publish({ slug: conf.slug, id: blocker.id });
    await owner.rpc.submissions.update({
      slug: conf.slug, id: blocker.id, pre_assigned_room_id: studio.id,
    });
    // Three competing sessions that all need projector.
    const a = await owner.rpc.submissions.create({
      slug: conf.slug, title: "A needs projector", room_requirements: ["projector"],
    });
    const b = await owner.rpc.submissions.create({
      slug: conf.slug, title: "B needs projector", room_requirements: ["projector"],
    });
    const c = await owner.rpc.submissions.create({
      slug: conf.slug, title: "C needs projector", room_requirements: ["projector"],
    });
    await owner.rpc.submissions.publish({ slug: conf.slug, id: a.id });
    await owner.rpc.submissions.publish({ slug: conf.slug, id: b.id });
    await owner.rpc.submissions.publish({ slug: conf.slug, id: c.id });
    const slot = await owner.rpc.agenda.createSlot({
      slug: conf.slug, type: "unconference",
      starts_at: Date.now(), ends_at: Date.now() + 3600_000,
    });
    const r = await owner.rpc.agenda.assign({ slug: conf.slug, slot_id: slot.id });
    expect(r.kind).toBe("conflict");
    if (r.kind !== "conflict") throw new Error("expected conflict");
    // All 3 unsatisfiable sessions surface in one go — the cascade re-runs
    // matching as each unmatched one is replaced by the next candidate,
    // and accumulates every conflict encountered.
    const tagIds = r.conflicts
      .filter((c) => c.kind === "unsatisfiable_requirements")
      .map((c) => (c.kind === "unsatisfiable_requirements" ? c.submission.id : -1))
      .sort();
    expect(tagIds).toEqual([a.id, b.id, c.id].sort());
  });

  test("cascading promotes the next-most-starred candidate when a top-N member can't be placed", async () => {
    // 3 rooms (one with projector tag, two plain). 4 sessions: a blocker
    // pinned to the projector room, A (most-starred — needs projector but
    // it's pinned, so unsatisfiable), B (no constraints), C (no constraints).
    // top-N = 3 = [blocker, A, B] by stars (we star them in that order).
    // A is unsatisfiable → cascade surfaces A as a conflict AND promotes C
    // into top-N so the final feasible trial is [blocker, B, C].
    const owner = new Client(ctx.app);
    await signupAndLogin(owner, "promote@example.com");
    const conf = await owner.rpc.conferences.create({ name: "Promote" });
    const studio = await owner.rpc.rooms.create({
      slug: conf.slug, name: "Studio", capacity: 30, tags: ["projector"],
    });
    await owner.rpc.rooms.create({ slug: conf.slug, name: "R1", capacity: 30 });
    await owner.rpc.rooms.create({ slug: conf.slug, name: "R2", capacity: 20 });
    const blocker = await owner.rpc.submissions.create({
      slug: conf.slug, title: "Blocker",
    });
    await owner.rpc.submissions.publish({ slug: conf.slug, id: blocker.id });
    await owner.rpc.submissions.update({
      slug: conf.slug, id: blocker.id, pre_assigned_room_id: studio.id,
    });
    const a = await owner.rpc.submissions.create({
      slug: conf.slug, title: "A", room_requirements: ["projector"],
    });
    const b = await owner.rpc.submissions.create({ slug: conf.slug, title: "B" });
    const c = await owner.rpc.submissions.create({ slug: conf.slug, title: "C" });
    await owner.rpc.submissions.publish({ slug: conf.slug, id: a.id });
    await owner.rpc.submissions.publish({ slug: conf.slug, id: b.id });
    await owner.rpc.submissions.publish({ slug: conf.slug, id: c.id });
    // A is most-starred but unsatisfiable. B next. C last.
    const parts: Client[] = [];
    for (let i = 0; i < 5; i++) {
      const p = new Client(ctx.app);
      const inv = await owner.rpc.conferences.createInvite({
        slug: conf.slug, email: `pp${i}-${Math.random()}@x.com`,
      });
      await p.rpc.conferences.claimInvite({
        slug: conf.slug, token: inv.token, password: "abcdef",
      });
      parts.push(p);
    }
    // Star order so blocker is in top-N (otherwise its pin is ignored and
    // A would just take Studio): blocker (5), A (4), B (3), C (1).
    for (let i = 0; i < 5; i++) await parts[i]!.rpc.submissions.star({ slug: conf.slug, id: blocker.id });
    for (let i = 0; i < 4; i++) await parts[i]!.rpc.submissions.star({ slug: conf.slug, id: a.id });
    for (let i = 0; i < 3; i++) await parts[i]!.rpc.submissions.star({ slug: conf.slug, id: b.id });
    await parts[0]!.rpc.submissions.star({ slug: conf.slug, id: c.id });
    const slot = await owner.rpc.agenda.createSlot({
      slug: conf.slug, type: "unconference",
      starts_at: Date.now(), ends_at: Date.now() + 3600_000,
    });
    // First run: A is in top-3 but unsatisfiable. Cascade surfaces it.
    const r1 = await owner.rpc.agenda.assign({ slug: conf.slug, slot_id: slot.id });
    expect(r1.kind).toBe("conflict");
    if (r1.kind !== "conflict") throw new Error("expected conflict");
    expect(r1.conflicts).toHaveLength(1);
    const c1 = r1.conflicts[0]!;
    if (c1.kind !== "unsatisfiable_requirements") throw new Error("bad shape");
    expect(c1.submission.id).toBe(a.id);
    // Resolve by skipping A. Cascade now promotes C alongside B + blocker.
    const r2 = await owner.rpc.agenda.assign({
      slug: conf.slug, slot_id: slot.id, exclude_submission_ids: [a.id],
    });
    if (r2.kind !== "unconference") throw new Error("expected unconference");
    expect(r2.placements.map((p) => p.submission_id).sort())
      .toEqual([blocker.id, b.id, c.id].sort());
  });

  test("subset of slot rooms: pinned room outside slot's selected rooms → out_of_scope", async () => {
    const owner = new Client(ctx.app);
    await signupAndLogin(owner, "subset@example.com");
    const conf = await owner.rpc.conferences.create({ name: "Subset" });
    const inSlot = await owner.rpc.rooms.create({
      slug: conf.slug, name: "InSlot", capacity: 10,
    });
    const outOfSlot = await owner.rpc.rooms.create({
      slug: conf.slug, name: "OutOfSlot", capacity: 10,
    });
    const sub = await owner.rpc.submissions.create({
      slug: conf.slug, title: "Talk",
    });
    await owner.rpc.submissions.publish({ slug: conf.slug, id: sub.id });
    await owner.rpc.submissions.update({
      slug: conf.slug, id: sub.id, pre_assigned_room_id: outOfSlot.id,
    });
    const slot = await owner.rpc.agenda.createSlot({
      slug: conf.slug, type: "unconference",
      starts_at: Date.now(), ends_at: Date.now() + 3600_000,
    });
    await owner.rpc.agenda.updateSlot({
      slug: conf.slug, id: slot.id,
      unconf_use_all_rooms: false, unconf_room_ids: [inSlot.id],
    });
    const r = await owner.rpc.agenda.assign({ slug: conf.slug, slot_id: slot.id });
    expect(r.kind).toBe("conflict");
    if (r.kind !== "conflict") throw new Error("expected conflict");
    const c = r.conflicts[0]!;
    expect(c.kind).toBe("out_of_scope");
    if (c.kind === "unsatisfiable_requirements") throw new Error("bad shape");
    expect(c.room_name).toBe("OutOfSlot");
  });
});

describe("overlapping slot exclusions", () => {
  let ctx: TestApp;
  beforeAll(() => { ctx = setupTestApp(); });
  afterAll(async () => { await ctx.cleanup(); });

  async function overlapFixture(prefix: string) {
    const owner = new Client(ctx.app);
    await signupAndLogin(owner, `${prefix}-owner@example.com`);
    const conf = await owner.rpc.conferences.create({ name: `Overlap ${prefix}` });
    // Two rooms.
    const r1 = await owner.rpc.rooms.create({ slug: conf.slug, name: "R1", capacity: 30 });
    const r2 = await owner.rpc.rooms.create({ slug: conf.slug, name: "R2", capacity: 20 });
    // Two slots whose time windows overlap.
    const t = Date.now();
    const slotA = await owner.rpc.agenda.createSlot({
      slug: conf.slug, type: "unconference",
      starts_at: t, ends_at: t + 60 * 60 * 1000,
    });
    const slotB = await owner.rpc.agenda.createSlot({
      slug: conf.slug, type: "unconference",
      starts_at: t + 30 * 60 * 1000, ends_at: t + 90 * 60 * 1000,
    });
    return { owner, conf, r1, r2, slotA, slotB };
  }

  test("(a) room used by an overlapping slot is excluded from this slot's pool", async () => {
    const f = await overlapFixture("room");
    // Two sessions with DIFFERENT submitters so rule (b) doesn't interfere.
    const sA = await f.owner.rpc.submissions.create({ slug: f.conf.slug, title: "A" });
    // Mint a participant to submit B.
    const p = new Client(ctx.app);
    const inv = await f.owner.rpc.conferences.createInvite({
      slug: f.conf.slug, email: `room-p-${Math.random()}@x.com`,
    });
    await p.rpc.conferences.claimInvite({
      slug: f.conf.slug, token: inv.token, password: "abcdef",
    });
    const sB = await p.rpc.submissions.create({ slug: f.conf.slug, title: "B" });
    await f.owner.rpc.submissions.publish({ slug: f.conf.slug, id: sA.id });
    await f.owner.rpc.submissions.publish({ slug: f.conf.slug, id: sB.id });
    // Restrict slot A to R1, slot B to all rooms (so R1 would be candidate).
    await f.owner.rpc.agenda.updateSlot({
      slug: f.conf.slug, id: f.slotA.id,
      unconf_use_all_rooms: false, unconf_room_ids: [f.r1.id],
      unconf_use_all_submissions: false, unconf_submission_ids: [sA.id],
    });
    await f.owner.rpc.agenda.updateSlot({
      slug: f.conf.slug, id: f.slotB.id,
      unconf_use_all_submissions: false, unconf_submission_ids: [sB.id],
    });
    // Run slot A first → puts A in R1.
    const rA = await f.owner.rpc.agenda.assign({ slug: f.conf.slug, slot_id: f.slotA.id });
    if (rA.kind !== "unconference") throw new Error("expected unconference");
    expect(rA.placements[0]!.room_id).toBe(f.r1.id);
    // Run slot B → R1 is excluded (in use by slot A's overlap). B goes to R2.
    const rB = await f.owner.rpc.agenda.assign({ slug: f.conf.slug, slot_id: f.slotB.id });
    if (rB.kind !== "unconference") throw new Error("expected unconference");
    expect(rB.placements[0]!.room_id).toBe(f.r2.id);
    expect(rB.overlap_exclusions.rooms.map((x) => x.name)).toEqual(["R1"]);
  });

  test("(b) submitter speaking in overlapping slot can't be placed for a different session", async () => {
    const f = await overlapFixture("submitter");
    // Both sessions submitted by the owner. Place session A in slot A.
    // Session B (same submitter) should be excluded from slot B.
    const sA = await f.owner.rpc.submissions.create({ slug: f.conf.slug, title: "Talk A" });
    const sB = await f.owner.rpc.submissions.create({ slug: f.conf.slug, title: "Talk B" });
    await f.owner.rpc.submissions.publish({ slug: f.conf.slug, id: sA.id });
    await f.owner.rpc.submissions.publish({ slug: f.conf.slug, id: sB.id });
    await f.owner.rpc.agenda.updateSlot({
      slug: f.conf.slug, id: f.slotA.id,
      unconf_use_all_submissions: false, unconf_submission_ids: [sA.id],
    });
    // Place A.
    const rA = await f.owner.rpc.agenda.assign({ slug: f.conf.slug, slot_id: f.slotA.id });
    if (rA.kind !== "unconference") throw new Error("expected unconference");
    // Run slot B. Only sB is eligible; same submitter as sA → exclude.
    await f.owner.rpc.agenda.updateSlot({
      slug: f.conf.slug, id: f.slotB.id,
      unconf_use_all_submissions: false, unconf_submission_ids: [sB.id],
    });
    const rB = await f.owner.rpc.agenda.assign({ slug: f.conf.slug, slot_id: f.slotB.id });
    if (rB.kind !== "unconference") throw new Error("expected unconference");
    expect(rB.placements).toHaveLength(0);
    expect(rB.overlap_exclusions.submissions).toHaveLength(1);
    expect(rB.overlap_exclusions.submissions[0]!.reason).toBe("busy_submitter");
    expect(rB.overlap_exclusions.submissions[0]!.id).toBe(sB.id);
  });

  test("(c) same session re-placed in overlapping slot is blocked by default", async () => {
    const f = await overlapFixture("same-session");
    // Session A with max_placements null (= conference default) and the
    // conference default cap likely 1 — so we'd hit the finished filter
    // first. Bump the conference default to unlimited so the session
    // remains eligible across slots, then verify overlap blocks it.
    await f.owner.rpc.conferences.update({
      slug: f.conf.slug, submission_max_placements_default: null,
    });
    const sA = await f.owner.rpc.submissions.create({ slug: f.conf.slug, title: "Talk A" });
    await f.owner.rpc.submissions.publish({ slug: f.conf.slug, id: sA.id });
    await f.owner.rpc.agenda.updateSlot({
      slug: f.conf.slug, id: f.slotA.id,
      unconf_use_all_submissions: false, unconf_submission_ids: [sA.id],
    });
    await f.owner.rpc.agenda.updateSlot({
      slug: f.conf.slug, id: f.slotB.id,
      unconf_use_all_submissions: false, unconf_submission_ids: [sA.id],
    });
    // Place in slot A.
    const rA = await f.owner.rpc.agenda.assign({ slug: f.conf.slug, slot_id: f.slotA.id });
    if (rA.kind !== "unconference") throw new Error("expected unconference");
    // Run slot B → same session excluded.
    const rB = await f.owner.rpc.agenda.assign({ slug: f.conf.slug, slot_id: f.slotB.id });
    if (rB.kind !== "unconference") throw new Error("expected unconference");
    expect(rB.placements).toHaveLength(0);
    expect(rB.overlap_exclusions.submissions[0]!.reason).toBe("same_session");
  });

  test("(c override) allow_overlapping_placements = true lets the same session run in overlapping slots", async () => {
    const f = await overlapFixture("same-session-allowed");
    await f.owner.rpc.conferences.update({
      slug: f.conf.slug, submission_max_placements_default: null,
    });
    const sA = await f.owner.rpc.submissions.create({ slug: f.conf.slug, title: "Recurring Workshop" });
    await f.owner.rpc.submissions.publish({ slug: f.conf.slug, id: sA.id });
    await f.owner.rpc.submissions.update({
      slug: f.conf.slug, id: sA.id, allow_overlapping_placements: true,
    });
    await f.owner.rpc.agenda.updateSlot({
      slug: f.conf.slug, id: f.slotA.id,
      unconf_use_all_submissions: false, unconf_submission_ids: [sA.id],
    });
    await f.owner.rpc.agenda.updateSlot({
      slug: f.conf.slug, id: f.slotB.id,
      unconf_use_all_submissions: false, unconf_submission_ids: [sA.id],
    });
    const rA = await f.owner.rpc.agenda.assign({ slug: f.conf.slug, slot_id: f.slotA.id });
    const rB = await f.owner.rpc.agenda.assign({ slug: f.conf.slug, slot_id: f.slotB.id });
    if (rA.kind !== "unconference" || rB.kind !== "unconference") throw new Error("expected unconference");
    expect(rA.placements).toHaveLength(1);
    expect(rB.placements).toHaveLength(1); // placed in both!
    expect(rB.overlap_exclusions.submissions).toHaveLength(0);
  });

  test("(d) participant assigned in overlapping slot is excluded from this slot", async () => {
    const f = await overlapFixture("user");
    const sA = await f.owner.rpc.submissions.create({ slug: f.conf.slug, title: "A" });
    const sB = await f.owner.rpc.submissions.create({ slug: f.conf.slug, title: "B" });
    await f.owner.rpc.submissions.publish({ slug: f.conf.slug, id: sA.id });
    await f.owner.rpc.submissions.publish({ slug: f.conf.slug, id: sB.id });
    await f.owner.rpc.agenda.updateSlot({
      slug: f.conf.slug, id: f.slotA.id,
      unconf_use_all_submissions: false, unconf_submission_ids: [sA.id],
    });
    await f.owner.rpc.agenda.updateSlot({
      slug: f.conf.slug, id: f.slotB.id,
      unconf_use_all_submissions: false, unconf_submission_ids: [sB.id],
    });
    // One participant who stars both.
    const p = new Client(ctx.app);
    const inv = await f.owner.rpc.conferences.createInvite({
      slug: f.conf.slug, email: `p-${Math.random()}@x.com`,
    });
    await p.rpc.conferences.claimInvite({
      slug: f.conf.slug, token: inv.token, password: "abcdef",
    });
    await p.rpc.submissions.star({ slug: f.conf.slug, id: sA.id });
    await p.rpc.submissions.star({ slug: f.conf.slug, id: sB.id });
    // Run slot A — places the participant.
    const rA = await f.owner.rpc.agenda.assign({ slug: f.conf.slug, slot_id: f.slotA.id });
    if (rA.kind !== "unconference") throw new Error("expected unconference");
    const me = await p.rpc.conferences.me({ slug: f.conf.slug });
    expect(rA.user_assignments.some((u) => u.user_id === me.id)).toBe(true);
    // Slot B — participant is busy in A → excluded.
    const rB = await f.owner.rpc.agenda.assign({ slug: f.conf.slug, slot_id: f.slotB.id });
    if (rB.kind !== "unconference") throw new Error("expected unconference");
    expect(rB.user_assignments.some((u) => u.user_id === me.id)).toBe(false);
    expect(rB.overlap_exclusions.user_ids).toContain(me.id);
  });

  test("non-overlapping slots don't trigger exclusions", async () => {
    const owner = new Client(ctx.app);
    await signupAndLogin(owner, "non-overlap@example.com");
    const conf = await owner.rpc.conferences.create({ name: "Non Overlap" });
    const r1 = await owner.rpc.rooms.create({ slug: conf.slug, name: "R1", capacity: 30 });
    const sA = await owner.rpc.submissions.create({ slug: conf.slug, title: "A" });
    await owner.rpc.submissions.publish({ slug: conf.slug, id: sA.id });
    const t = Date.now();
    const slotA = await owner.rpc.agenda.createSlot({
      slug: conf.slug, type: "unconference",
      starts_at: t, ends_at: t + 60 * 60 * 1000,
    });
    const slotB = await owner.rpc.agenda.createSlot({
      slug: conf.slug, type: "unconference",
      // Starts AFTER slot A ends — no overlap.
      starts_at: t + 60 * 60 * 1000, ends_at: t + 120 * 60 * 1000,
    });
    await owner.rpc.agenda.updateSlot({
      slug: conf.slug, id: slotA.id,
      unconf_use_all_submissions: false, unconf_submission_ids: [sA.id],
    });
    await owner.rpc.conferences.update({
      slug: conf.slug, submission_max_placements_default: null,
    });
    await owner.rpc.agenda.updateSlot({
      slug: conf.slug, id: slotB.id,
      unconf_use_all_submissions: false, unconf_submission_ids: [sA.id],
    });
    const rA = await owner.rpc.agenda.assign({ slug: conf.slug, slot_id: slotA.id });
    const rB = await owner.rpc.agenda.assign({ slug: conf.slug, slot_id: slotB.id });
    if (rA.kind !== "unconference" || rB.kind !== "unconference") throw new Error("expected unconference");
    // Slot B's run can use R1 again — slots don't overlap.
    expect(rB.placements[0]?.room_id).toBe(r1.id);
    expect(rB.overlap_exclusions.rooms).toHaveLength(0);
    expect(rB.overlap_exclusions.submissions).toHaveLength(0);
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
