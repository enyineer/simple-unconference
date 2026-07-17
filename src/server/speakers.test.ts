// Unit tests for the effective-speaker helper (the single source of the
// "default to the submitter" rule) + integration tests for the RPC set-speakers
// path, the scheduler's parallel-speaker rule, and the non-blocking manual
// `speaker_warning`.

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  setupTestApp, Client, type TestApp, inviteAndClaim,
} from "./test-helpers";
import {
  effectiveSpeakers, effectiveSpeakerKeys, effectiveSpeakerIdentityIds,
  effectiveSpeakerNames, normalizeSpeakerName,
} from "./lib/speakers";

const FUTURE = Math.floor((Date.now() + 7 * 24 * 60 * 60 * 1000) / 60_000) * 60_000;
const HOUR = 60 * 60_000;

// ---------------------------------------------------------------------------
// Pure helper
// ---------------------------------------------------------------------------

describe("effective speakers helper", () => {
  test("no speaker rows defaults to the submitter", () => {
    const sub = { submitterId: 7, submitter: { name: "Ada", profilePublished: true }, speakers: [] };
    expect([...effectiveSpeakerKeys(sub)]).toEqual(["identity:7"]);
    expect(effectiveSpeakerIdentityIds(sub)).toEqual([7]);
    expect(effectiveSpeakerNames(sub)).toEqual(["Ada"]);
    expect(effectiveSpeakers(sub)[0]).toEqual({
      key: "identity:7", identityId: 7, name: "Ada", profilePublished: true,
    });
  });

  test("explicit registered speakers override the submitter", () => {
    const sub = {
      submitterId: 7,
      submitter: { name: "Ada", profilePublished: false },
      speakers: [
        { identityId: 11, name: null, identity: { name: "Grace", profilePublished: true } },
        { identityId: 12, name: null, identity: { name: "Alan", profilePublished: false } },
      ],
    };
    expect([...effectiveSpeakerKeys(sub)]).toEqual(["identity:11", "identity:12"]);
    expect(effectiveSpeakerIdentityIds(sub)).toEqual([11, 12]);
    expect(effectiveSpeakerNames(sub)).toEqual(["Grace", "Alan"]);
    // Submitter (7) is NOT in the effective set once explicit speakers exist.
    expect([...effectiveSpeakerKeys(sub)]).not.toContain("identity:7");
  });

  test("free-form names normalize into name: keys and are not attendees", () => {
    const sub = {
      submitterId: 7,
      submitter: { name: "Ada", profilePublished: false },
      speakers: [
        { identityId: null, name: "  Jane   Doe  ", identity: null },
        { identityId: 12, name: null, identity: { name: "Alan", profilePublished: true } },
      ],
    };
    expect([...effectiveSpeakerKeys(sub)]).toEqual(["name:jane doe", "identity:12"]);
    // Free-form names aren't identity ids → not counted as attendees.
    expect(effectiveSpeakerIdentityIds(sub)).toEqual([12]);
    // Display keeps the original (un-normalized) free-form string.
    expect(effectiveSpeakerNames(sub)).toEqual(["  Jane   Doe  ", "Alan"]);
  });

  test("normalizeSpeakerName lowercases, trims, collapses whitespace", () => {
    expect(normalizeSpeakerName("  Jane\t  Doe ")).toBe("jane doe");
    expect(normalizeSpeakerName("ALAN")).toBe("alan");
  });
});

// ---------------------------------------------------------------------------
// Integration
// ---------------------------------------------------------------------------

let ctx: TestApp;

async function freshConf(prefix: string) {
  const owner = new Client(ctx.app);
  await owner.rpc.auth.signup({ email: `${prefix}-o@e.com`, password: "secret123", name: "Owner" });
  const conf = await owner.rpc.conferences.create({ name: `Conf ${prefix}` });
  return { owner, slug: conf.slug };
}

describe("submissions.set-speakers RPC", () => {
  beforeAll(() => { ctx = setupTestApp(); });
  afterAll(async () => { await ctx.cleanup(); });

  test("mod sets registered + free-form speakers; effective set emitted", async () => {
    const { owner, slug } = await freshConf("spk-set");
    const { identity_id } = await inviteAndClaim(ctx.app, owner, slug, "grace@e.com", "secret123", "Grace");
    const sub = await owner.rpc.submissions.create({
      slug, title: "Talk",
      speakers: [{ identity_id }, { name: "Jane Doe" }],
    });
    const [row] = await owner.rpc.submissions.listAll({ slug });
    expect(row!.id).toBe(sub.id);
    expect(row!.speakers).toEqual([
      { identity_id, name: "Grace", profile_published: false },
      { identity_id: null, name: "Jane Doe", profile_published: false },
    ]);
  });

  test("no speakers → effective list defaults to the submitter", async () => {
    const { owner, slug } = await freshConf("spk-default");
    const me = await owner.rpc.conferences.me({ slug });
    const sub = await owner.rpc.submissions.create({ slug, title: "Solo" });
    const rows = await owner.rpc.submissions.listAll({ slug });
    const row = rows.find((r) => r.id === sub.id)!;
    expect(row.speakers).toEqual([
      { identity_id: me.id, name: "Owner", profile_published: row.submitter_profile_published },
    ]);
  });

  test("update replaces the speaker set; empty array clears back to submitter", async () => {
    const { owner, slug } = await freshConf("spk-replace");
    const me = await owner.rpc.conferences.me({ slug });
    const sub = await owner.rpc.submissions.create({
      slug, title: "Talk", speakers: [{ name: "Alpha" }, { name: "Beta" }],
    });
    await owner.rpc.submissions.update({ slug, id: sub.id, speakers: [{ name: "Gamma" }] });
    let row = (await owner.rpc.submissions.listAll({ slug })).find((r) => r.id === sub.id)!;
    expect(row.speakers.map((s) => s.name)).toEqual(["Gamma"]);
    // Empty array clears → back to submitter default.
    await owner.rpc.submissions.update({ slug, id: sub.id, speakers: [] });
    row = (await owner.rpc.submissions.listAll({ slug })).find((r) => r.id === sub.id)!;
    expect(row.speakers).toEqual([
      { identity_id: me.id, name: "Owner", profile_published: row.submitter_profile_published },
    ]);
  });

  test("duplicate registered speakers are deduped; free-form dedupe by normalized name", async () => {
    const { owner, slug } = await freshConf("spk-dedupe");
    const { identity_id } = await inviteAndClaim(ctx.app, owner, slug, "g@e.com", "secret123", "Grace");
    const sub = await owner.rpc.submissions.create({
      slug, title: "T",
      speakers: [{ identity_id }, { identity_id }, { name: "Jane Doe" }, { name: "  jane   doe " }],
    });
    const row = (await owner.rpc.submissions.listAll({ slug })).find((r) => r.id === sub.id)!;
    expect(row.speakers).toEqual([
      { identity_id, name: "Grace", profile_published: false },
      { identity_id: null, name: "Jane Doe", profile_published: false },
    ]);
  });

  test("a row with neither identity_id nor name is rejected", async () => {
    const { owner, slug } = await freshConf("spk-neither");
    await expect(
      owner.rpc.submissions.create({ slug, title: "T", speakers: [{}] }),
    ).rejects.toThrow("speaker_invalid");
  });

  test("a row with BOTH identity_id and name is rejected", async () => {
    const { owner, slug } = await freshConf("spk-both");
    const { identity_id } = await inviteAndClaim(ctx.app, owner, slug, "g@e.com");
    await expect(
      owner.rpc.submissions.create({
        slug, title: "T", speakers: [{ identity_id, name: "X" }],
      }),
    ).rejects.toThrow("speaker_invalid");
  });

  test("a registered speaker not in the conference is rejected", async () => {
    const { owner, slug } = await freshConf("spk-foreign");
    await expect(
      owner.rpc.submissions.create({ slug, title: "T", speakers: [{ identity_id: 999999 }] }),
    ).rejects.toThrow("speaker_not_in_conference");
  });

  test("more than 10 speakers is rejected at the schema level", async () => {
    const { owner, slug } = await freshConf("spk-cap");
    const many = Array.from({ length: 11 }, (_, i) => ({ name: `S${i}` }));
    await expect(
      owner.rpc.submissions.create({ slug, title: "T", speakers: many }),
    ).rejects.toThrow();
  });

  test("participants can't set speakers (silently ignored)", async () => {
    const { owner, slug } = await freshConf("spk-nonmod");
    await owner.rpc.conferences.update({ slug, participant_submissions_enabled: true });
    const { client: part, identity_id } = await inviteAndClaim(ctx.app, owner, slug, "p@e.com", "secret123", "Pat");
    const { identity_id: other } = await inviteAndClaim(ctx.app, owner, slug, "o@e.com", "secret123", "Other");
    const sub = await part.rpc.submissions.create({
      slug, title: "T", speakers: [{ identity_id: other }],
    });
    const row = (await part.rpc.submissions.listAll({ slug })).find((r) => r.id === sub.id)!;
    // Speaker rows ignored → defaults to the participant submitter.
    expect(row.speakers).toEqual([
      { identity_id, name: "Pat", profile_published: row.submitter_profile_published },
    ]);
  });
});

describe("scheduler parallel-speaker rule", () => {
  beforeAll(() => { ctx = setupTestApp(); });
  afterAll(async () => { await ctx.cleanup(); });

  // Two published sessions authored by the SAME mod (default submitter), each
  // credited to a DIFFERENT free-form speaker. s1 is placed in one slot; an
  // overlapping slot then auto-assigns. Before the speaker split, s2 would be
  // excluded (busy_submitter on the shared submitter); with distinct speakers
  // it's free to run in parallel.
  test("same submitter, different free-form speakers → parallel placement allowed", async () => {
    const { owner, slug } = await freshConf("sch-different");
    const roomA = await owner.rpc.rooms.create({ slug, name: "A", capacity: 30 });
    await owner.rpc.rooms.create({ slug, name: "B", capacity: 30 });
    const s1 = await owner.rpc.submissions.create({ slug, title: "One", speakers: [{ name: "Alice" }] });
    const s2 = await owner.rpc.submissions.create({ slug, title: "Two", speakers: [{ name: "Bob" }] });
    await owner.rpc.submissions.publish({ slug, id: s1.id });
    await owner.rpc.submissions.publish({ slug, id: s2.id });
    const slot1 = await owner.rpc.agenda.createSlot({
      slug, type: "unconference", title: "U1", starts_at: FUTURE, ends_at: FUTURE + HOUR,
    });
    await owner.rpc.agenda.placeSubmission({ slug, slot_id: slot1.id, submission_id: s1.id, room_id: roomA.id });
    const slot2 = await owner.rpc.agenda.createSlot({
      slug, type: "unconference", title: "U2", starts_at: FUTURE, ends_at: FUTURE + HOUR,
    });
    const r = await owner.rpc.agenda.assign({ slug, slot_id: slot2.id });
    if (r.kind !== "unconference") throw new Error("expected unconference");
    // Different speaker → s2 is NOT excluded and gets placed in the overlapping slot.
    expect(r.placements.some((p) => p.submission_id === s2.id)).toBe(true);
    expect(r.overlap_exclusions.submissions.some((e) => e.id === s2.id)).toBe(false);
  });

  // Two placed sessions sharing the SAME free-form speaker across overlapping
  // slots: the second is excluded with reason busy_submitter.
  test("same free-form speaker across overlapping slots → excluded", async () => {
    const { owner, slug } = await freshConf("sch-samename");
    const roomA = await owner.rpc.rooms.create({ slug, name: "A", capacity: 30 });
    await owner.rpc.rooms.create({ slug, name: "B", capacity: 30 });
    const s1 = await owner.rpc.submissions.create({ slug, title: "One", speakers: [{ name: "Alice" }] });
    const s2 = await owner.rpc.submissions.create({ slug, title: "Two", speakers: [{ name: "alice" }] });
    await owner.rpc.submissions.publish({ slug, id: s1.id });
    await owner.rpc.submissions.publish({ slug, id: s2.id });
    // Slot 1 gets s1 manually placed; slot 2 overlaps and auto-assigns.
    const slot1 = await owner.rpc.agenda.createSlot({
      slug, type: "unconference", title: "U1", starts_at: FUTURE, ends_at: FUTURE + HOUR,
    });
    await owner.rpc.agenda.placeSubmission({ slug, slot_id: slot1.id, submission_id: s1.id, room_id: roomA.id });
    const slot2 = await owner.rpc.agenda.createSlot({
      slug, type: "unconference", title: "U2", starts_at: FUTURE, ends_at: FUTURE + HOUR,
    });
    const r = await owner.rpc.agenda.assign({ slug, slot_id: slot2.id });
    if (r.kind !== "unconference") throw new Error("expected unconference");
    // s2 shares the "alice" speaker with the placed s1 → excluded (not placed).
    expect(r.placements.some((p) => p.submission_id === s2.id)).toBe(false);
    expect(r.overlap_exclusions.submissions.some(
      (e) => e.id === s2.id && e.reason === "busy_submitter",
    )).toBe(true);
  });

  // A session with an explicit speaker list ignores its submitter for the
  // conflict: the submitter speaking elsewhere no longer blocks it.
  test("explicit speaker list frees the submitter for parallel scheduling", async () => {
    const { owner, slug } = await freshConf("sch-explicit");
    const roomA = await owner.rpc.rooms.create({ slug, name: "A", capacity: 30 });
    await owner.rpc.rooms.create({ slug, name: "B", capacity: 30 });
    // s1 has no explicit speakers → submitter (owner) is the speaker.
    const s1 = await owner.rpc.submissions.create({ slug, title: "One" });
    // s2 authored by the same owner but credited to a different person.
    const s2 = await owner.rpc.submissions.create({ slug, title: "Two", speakers: [{ name: "Guest" }] });
    await owner.rpc.submissions.publish({ slug, id: s1.id });
    await owner.rpc.submissions.publish({ slug, id: s2.id });
    const slot1 = await owner.rpc.agenda.createSlot({
      slug, type: "unconference", title: "U1", starts_at: FUTURE, ends_at: FUTURE + HOUR,
    });
    await owner.rpc.agenda.placeSubmission({ slug, slot_id: slot1.id, submission_id: s1.id, room_id: roomA.id });
    const slot2 = await owner.rpc.agenda.createSlot({
      slug, type: "unconference", title: "U2", starts_at: FUTURE, ends_at: FUTURE + HOUR,
    });
    const r = await owner.rpc.agenda.assign({ slug, slot_id: slot2.id });
    if (r.kind !== "unconference") throw new Error("expected unconference");
    // s2's speaker is "Guest", not the owner → not blocked by s1's owner-speaker.
    expect(r.placements.some((p) => p.submission_id === s2.id)).toBe(true);
  });

  // Regression guard: with NO explicit speakers anywhere, the submitter-collision
  // behavior is byte-identical to before (same submitter, two sessions, one
  // excluded).
  test("no explicit speakers → submitter collision unchanged", async () => {
    const { owner, slug } = await freshConf("sch-legacy");
    const roomA = await owner.rpc.rooms.create({ slug, name: "A", capacity: 30 });
    await owner.rpc.rooms.create({ slug, name: "B", capacity: 30 });
    const s1 = await owner.rpc.submissions.create({ slug, title: "One" });
    const s2 = await owner.rpc.submissions.create({ slug, title: "Two" });
    await owner.rpc.submissions.publish({ slug, id: s1.id });
    await owner.rpc.submissions.publish({ slug, id: s2.id });
    const slot1 = await owner.rpc.agenda.createSlot({
      slug, type: "unconference", title: "U1", starts_at: FUTURE, ends_at: FUTURE + HOUR,
    });
    await owner.rpc.agenda.placeSubmission({ slug, slot_id: slot1.id, submission_id: s1.id, room_id: roomA.id });
    const slot2 = await owner.rpc.agenda.createSlot({
      slug, type: "unconference", title: "U2", starts_at: FUTURE, ends_at: FUTURE + HOUR,
    });
    const r = await owner.rpc.agenda.assign({ slug, slot_id: slot2.id });
    if (r.kind !== "unconference") throw new Error("expected unconference");
    expect(r.placements.some((p) => p.submission_id === s2.id)).toBe(false);
    expect(r.overlap_exclusions.submissions.some(
      (e) => e.id === s2.id && e.reason === "busy_submitter",
    )).toBe(true);
  });
});

describe("manual placement speaker_warning (non-blocking)", () => {
  beforeAll(() => { ctx = setupTestApp(); });
  afterAll(async () => { await ctx.cleanup(); });

  test("scheduleSubmission surfaces a warning but still commits", async () => {
    const { owner, slug } = await freshConf("warn-schedule");
    const roomA = await owner.rpc.rooms.create({ slug, name: "A", capacity: 30 });
    const roomB = await owner.rpc.rooms.create({ slug, name: "B", capacity: 30 });
    // Two sessions sharing the free-form speaker "Alice".
    const s1 = await owner.rpc.submissions.create({ slug, title: "One", speakers: [{ name: "Alice" }] });
    const s2 = await owner.rpc.submissions.create({ slug, title: "Two", speakers: [{ name: "Alice" }] });
    await owner.rpc.submissions.publish({ slug, id: s1.id });
    await owner.rpc.submissions.publish({ slug, id: s2.id });
    const slot1 = await owner.rpc.agenda.createSlot({
      slug, type: "normal", title: "N1", starts_at: FUTURE, ends_at: FUTURE + HOUR,
    });
    const slot2 = await owner.rpc.agenda.createSlot({
      slug, type: "normal", title: "N2", starts_at: FUTURE, ends_at: FUTURE + HOUR,
    });
    // Place s1 into slot1/roomA first.
    await owner.rpc.agenda.setTrack({ slug, slot_id: slot1.id, room_id: roomA.id, submission_id: s1.id });
    // Now schedule s2 into the overlapping slot2 — same speaker → warning.
    const r = await owner.rpc.agenda.scheduleSubmission({ slug, slot_id: slot2.id, submission_id: s2.id });
    if (r.kind !== "ok") throw new Error("expected ok (non-blocking)");
    expect(r.room_id).toBe(roomB.id);
    expect(r.speaker_warning).toBeDefined();
    expect(r.speaker_warning!.speaker_name).toBe("Alice");
    expect(r.speaker_warning!.session_title).toBe("One");
    // The track committed regardless of the warning.
    const tracks = await ctx.prisma.trackAssignment.findMany({ where: { slotId: slot2.id } });
    expect(tracks.some((t) => t.submissionId === s2.id)).toBe(true);
  });

  test("no warning when speakers differ", async () => {
    const { owner, slug } = await freshConf("warn-none");
    const roomA = await owner.rpc.rooms.create({ slug, name: "A", capacity: 30 });
    const roomB = await owner.rpc.rooms.create({ slug, name: "B", capacity: 30 });
    const s1 = await owner.rpc.submissions.create({ slug, title: "One", speakers: [{ name: "Alice" }] });
    const s2 = await owner.rpc.submissions.create({ slug, title: "Two", speakers: [{ name: "Bob" }] });
    await owner.rpc.submissions.publish({ slug, id: s1.id });
    await owner.rpc.submissions.publish({ slug, id: s2.id });
    const slot1 = await owner.rpc.agenda.createSlot({
      slug, type: "normal", title: "N1", starts_at: FUTURE, ends_at: FUTURE + HOUR,
    });
    const slot2 = await owner.rpc.agenda.createSlot({
      slug, type: "normal", title: "N2", starts_at: FUTURE, ends_at: FUTURE + HOUR,
    });
    await owner.rpc.agenda.setTrack({ slug, slot_id: slot1.id, room_id: roomA.id, submission_id: s1.id });
    const r = await owner.rpc.agenda.setTrack({ slug, slot_id: slot2.id, room_id: roomB.id, submission_id: s2.id });
    if (r.kind !== "ok") throw new Error("expected ok");
    expect(r.speaker_warning).toBeUndefined();
  });

  test("placeSubmission surfaces a warning for a shared registered speaker", async () => {
    const { owner, slug } = await freshConf("warn-place");
    const roomA = await owner.rpc.rooms.create({ slug, name: "A", capacity: 30 });
    const roomB = await owner.rpc.rooms.create({ slug, name: "B", capacity: 30 });
    const { identity_id } = await inviteAndClaim(ctx.app, owner, slug, "grace@e.com", "secret123", "Grace");
    const s1 = await owner.rpc.submissions.create({ slug, title: "One", speakers: [{ identity_id }] });
    const s2 = await owner.rpc.submissions.create({ slug, title: "Two", speakers: [{ identity_id }] });
    await owner.rpc.submissions.publish({ slug, id: s1.id });
    await owner.rpc.submissions.publish({ slug, id: s2.id });
    const slot1 = await owner.rpc.agenda.createSlot({
      slug, type: "unconference", title: "U1", starts_at: FUTURE, ends_at: FUTURE + HOUR,
    });
    const slot2 = await owner.rpc.agenda.createSlot({
      slug, type: "unconference", title: "U2", starts_at: FUTURE, ends_at: FUTURE + HOUR,
    });
    await owner.rpc.agenda.placeSubmission({ slug, slot_id: slot1.id, submission_id: s1.id, room_id: roomA.id });
    const r = await owner.rpc.agenda.placeSubmission({ slug, slot_id: slot2.id, submission_id: s2.id, room_id: roomB.id });
    if (r.kind !== "ok") throw new Error("expected ok");
    expect(r.speaker_warning).toBeDefined();
    expect(r.speaker_warning!.speaker_name).toBe("Grace");
  });
});
