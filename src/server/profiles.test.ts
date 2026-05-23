// Phase 2 smoke tests + Phase 6 privacy regression suite for the profiles.*
// RPC namespace. The smoke block covers wiring; the regression block pins
// the privacy contract (unpublished invisible, email never leaked, entries
// filtered by isPublic, cross-conference isolation, full-replacement
// semantics, tag cap + dedup) and the link-everywhere signals that the
// list responses now carry (submitter_profile_published / profile_published).

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  setupTestApp, Client, ORPCError, type TestApp,
  inviteAndClaim,
} from "./test-helpers";

describe("profiles.* smoke", () => {
  let ctx: TestApp;
  beforeAll(() => { ctx = setupTestApp(); });
  afterAll(async () => { await ctx.cleanup(); });

  test("updateMine writes bio + entries + tags; get returns the same payload", async () => {
    const owner = new Client(ctx.app);
    await owner.rpc.auth.signup({ email: "po@example.com", password: "secret123", name: "Owner" });
    const conf = await owner.rpc.conferences.create({ name: "Profile Smoke" });

    const { client: alice, identity_id: aliceId } =
      await inviteAndClaim(ctx.app, owner, conf.slug, "alice@example.com", "secret123", "Alice");

    // Empty initial profile.
    const before = await alice.rpc.profiles.get({ slug: conf.slug, identity_id: aliceId });
    expect(before.is_me).toBe(true);
    expect(before.can_edit).toBe(true);
    expect(before.bio).toBeNull();
    expect(before.entries).toEqual([]);
    expect(before.tags).toEqual([]);
    expect(before.profile_published).toBe(false);

    // Write bio + tags + one public link entry.
    const saved = await alice.rpc.profiles.updateMine({
      slug: conf.slug,
      profile_published: true,
      bio: "Hello from the test suite.",
      pronouns: "they/them",
      title: "Engineer",
      company: "Acme",
      entries: [
        {
          kind: "GitHub",
          value: "@alice",
          href: "https://github.com/alice",
          category: "link",
          is_public: true,
          position: 0,
        },
      ],
      tags: ["typescript", "infra", "infra"], // duplicate dedups
    });
    expect(saved.bio).toBe("Hello from the test suite.");
    expect(saved.profile_published).toBe(true);
    expect(saved.entries).toHaveLength(1);
    expect(saved.entries[0]!.kind).toBe("GitHub");
    expect(saved.tags).toEqual(["infra", "typescript"]);

    // Round-trip via .get to confirm persistence + read path.
    const after = await alice.rpc.profiles.get({ slug: conf.slug, identity_id: aliceId });
    expect(after.bio).toBe("Hello from the test suite.");
    expect(after.title).toBe("Engineer");
    expect(after.company).toBe("Acme");
    expect(after.pronouns).toBe("they/them");
    expect(after.tags).toEqual(["infra", "typescript"]);
    expect(after.entries).toHaveLength(1);
    expect(after.entries[0]!.href).toBe("https://github.com/alice");
  });

  test("profiles.list includes published identities; non-mods don't see unpublished", async () => {
    const owner = new Client(ctx.app);
    await owner.rpc.auth.signup({ email: "po2@example.com", password: "secret123" });
    const conf = await owner.rpc.conferences.create({ name: "Directory Smoke" });

    const { client: alice, identity_id: aliceId } =
      await inviteAndClaim(ctx.app, owner, conf.slug, "alice2@example.com", "secret123", "Alice");
    const { client: bob } =
      await inviteAndClaim(ctx.app, owner, conf.slug, "bob2@example.com", "secret123", "Bob");

    // Alice publishes; Bob stays unpublished.
    await alice.rpc.profiles.updateMine({ slug: conf.slug, profile_published: true });

    // Non-mod (Bob) sees only Alice.
    const bobView = (await bob.rpc.profiles.list({ slug: conf.slug })).items;
    const bobIds = bobView.map((p) => p.identity_id);
    expect(bobIds).toContain(aliceId);
    expect(bobView.every((p) => p.identity_id === aliceId || p.title !== undefined)).toBe(true);
    // Only one published profile exists.
    expect(bobView).toHaveLength(1);

    // Mod (owner) sees everyone in the conference.
    const ownerView = (await owner.rpc.profiles.list({ slug: conf.slug })).items;
    expect(ownerView.length).toBeGreaterThanOrEqual(2);
  });

  test("non-mod fetching an unpublished other profile gets NOT_FOUND", async () => {
    const owner = new Client(ctx.app);
    await owner.rpc.auth.signup({ email: "po3@example.com", password: "secret123" });
    const conf = await owner.rpc.conferences.create({ name: "Hidden Smoke" });

    const { identity_id: aliceId } =
      await inviteAndClaim(ctx.app, owner, conf.slug, "alice3@example.com", "secret123", "Alice");
    const { client: bob } =
      await inviteAndClaim(ctx.app, owner, conf.slug, "bob3@example.com", "secret123", "Bob");

    // Alice didn't publish; Bob can't see her profile.
    await expect(
      bob.rpc.profiles.get({ slug: conf.slug, identity_id: aliceId }),
    ).rejects.toBeInstanceOf(ORPCError);
  });

  test("mod updateAny succeeds; participant cannot call updateAny", async () => {
    const owner = new Client(ctx.app);
    await owner.rpc.auth.signup({ email: "po4@example.com", password: "secret123" });
    const conf = await owner.rpc.conferences.create({ name: "Mod Edit Smoke" });

    const { client: alice, identity_id: aliceId } =
      await inviteAndClaim(ctx.app, owner, conf.slug, "alice4@example.com", "secret123", "Alice");

    // Owner (mod-level) edits Alice's profile.
    const r = await owner.rpc.profiles.updateAny({
      slug: conf.slug, identity_id: aliceId,
      title: "Speaker",
    });
    expect(r.title).toBe("Speaker");

    // Alice (participant) cannot call updateAny.
    await expect(
      alice.rpc.profiles.updateAny({ slug: conf.slug, identity_id: aliceId, title: "x" }),
    ).rejects.toBeInstanceOf(ORPCError);
  });

  test("non-mod can see own unpublished profile via profiles.get", async () => {
    const owner = new Client(ctx.app);
    await owner.rpc.auth.signup({ email: "po6@example.com", password: "secret123" });
    const conf = await owner.rpc.conferences.create({ name: "Self Smoke" });

    const { client: alice, identity_id: aliceId } =
      await inviteAndClaim(ctx.app, owner, conf.slug, "alice6@example.com", "secret123", "Alice");

    // Alice has never published. She can still see her own profile and
    // gets all the self-only signals (is_me, can_edit, own email).
    const r = await alice.rpc.profiles.get({ slug: conf.slug, identity_id: aliceId });
    expect(r.profile_published).toBe(false);
    expect(r.is_me).toBe(true);
    expect(r.can_edit).toBe(true);
    expect(r.email).toBe("alice6@example.com");
  });

  test("mod sees an unpublished other profile with email populated", async () => {
    const owner = new Client(ctx.app);
    await owner.rpc.auth.signup({ email: "po7@example.com", password: "secret123" });
    const conf = await owner.rpc.conferences.create({ name: "Mod View Smoke" });

    const { identity_id: aliceId } =
      await inviteAndClaim(ctx.app, owner, conf.slug, "alice7@example.com", "secret123", "Alice");

    // Owner is mod-level. Alice never published; owner still sees her,
    // with the canonical email (mods need it to coordinate).
    const r = await owner.rpc.profiles.get({ slug: conf.slug, identity_id: aliceId });
    expect(r.profile_published).toBe(false);
    expect(r.is_me).toBe(false);
    expect(r.can_edit).toBe(true);
    expect(r.email).toBe("alice7@example.com");
  });

  test("entries: non-mod sees only is_public=true; mod sees all", async () => {
    const owner = new Client(ctx.app);
    await owner.rpc.auth.signup({ email: "po8@example.com", password: "secret123" });
    const conf = await owner.rpc.conferences.create({ name: "Entries Smoke" });

    const { client: alice, identity_id: aliceId } =
      await inviteAndClaim(ctx.app, owner, conf.slug, "alice8@example.com", "secret123", "Alice");
    const { client: bob } =
      await inviteAndClaim(ctx.app, owner, conf.slug, "bob8@example.com", "secret123", "Bob");

    // Alice publishes a public link and a private contact (mods + self only).
    await alice.rpc.profiles.updateMine({
      slug: conf.slug,
      profile_published: true,
      entries: [
        { kind: "GitHub", value: "@alice", href: "https://github.com/alice",
          category: "link", is_public: true, position: 0 },
        { kind: "Signal", value: "+1 555 0100", href: null,
          category: "contact", is_public: false, position: 1 },
      ],
    });

    // Non-mod Bob sees the public one only.
    const bobView = await bob.rpc.profiles.get({ slug: conf.slug, identity_id: aliceId });
    expect(bobView.entries.map((e) => e.kind)).toEqual(["GitHub"]);

    // Owner (mod) sees both.
    const modView = await owner.rpc.profiles.get({ slug: conf.slug, identity_id: aliceId });
    expect(modView.entries.map((e) => e.kind).sort()).toEqual(["GitHub", "Signal"]);

    // Alice herself (self === self) also sees the private one.
    const selfView = await alice.rpc.profiles.get({ slug: conf.slug, identity_id: aliceId });
    expect(selfView.entries.map((e) => e.kind).sort()).toEqual(["GitHub", "Signal"]);
  });

  test("canonical email is never returned to non-mods (get + list)", async () => {
    const owner = new Client(ctx.app);
    await owner.rpc.auth.signup({ email: "po9@example.com", password: "secret123" });
    const conf = await owner.rpc.conferences.create({ name: "Email Leak Smoke" });

    const { client: alice, identity_id: aliceId } =
      await inviteAndClaim(ctx.app, owner, conf.slug, "alice9@example.com", "secret123", "Alice");
    const { client: bob } =
      await inviteAndClaim(ctx.app, owner, conf.slug, "bob9@example.com", "secret123", "Bob");
    await alice.rpc.profiles.updateMine({ slug: conf.slug, profile_published: true });

    // profiles.get returns email: null for non-mod viewers of other profiles.
    const bobGetsAlice = await bob.rpc.profiles.get({ slug: conf.slug, identity_id: aliceId });
    expect(bobGetsAlice.email).toBeNull();

    // profiles.list has no `email` field on the summary at all; assert the
    // serialized payload doesn't contain Alice's address as a defense-in-depth
    // regression guard (e.g. against a future select including `email`).
    const bobList = (await bob.rpc.profiles.list({ slug: conf.slug })).items;
    expect(JSON.stringify(bobList)).not.toContain("alice9@example.com");
  });

  test("updateAny across conferences returns NOT_FOUND", async () => {
    const owner = new Client(ctx.app);
    await owner.rpc.auth.signup({ email: "po10@example.com", password: "secret123" });
    const confA = await owner.rpc.conferences.create({ name: "Cross A" });
    const confB = await owner.rpc.conferences.create({ name: "Cross B" });

    // Alice exists in confA only.
    const { identity_id: aliceInA } =
      await inviteAndClaim(ctx.app, owner, confA.slug, "alicex@example.com", "secret123", "Alice");

    // Owner is mod of both; but cannot reach Alice via confB's slug. The
    // findFirst({ id, conferenceId }) guard returns NOT_FOUND for
    // cross-conference identity lookups.
    await expect(
      owner.rpc.profiles.updateAny({
        slug: confB.slug, identity_id: aliceInA, title: "Sneaky",
      }),
    ).rejects.toBeInstanceOf(ORPCError);
  });

  test("entries full-replacement leaves no orphans", async () => {
    const owner = new Client(ctx.app);
    await owner.rpc.auth.signup({ email: "po11@example.com", password: "secret123" });
    const conf = await owner.rpc.conferences.create({ name: "Replacement Smoke" });

    const { client: alice, identity_id: aliceId } =
      await inviteAndClaim(ctx.app, owner, conf.slug, "alice11@example.com", "secret123", "Alice");

    // Seed three entries.
    await alice.rpc.profiles.updateMine({
      slug: conf.slug,
      entries: [
        { kind: "A", value: "a", href: null, category: "link", is_public: true, position: 0 },
        { kind: "B", value: "b", href: null, category: "link", is_public: true, position: 1 },
        { kind: "C", value: "c", href: null, category: "link", is_public: true, position: 2 },
      ],
    });
    expect(await ctx.prisma.profileEntry.count({ where: { identityId: aliceId } })).toBe(3);

    // Replace with a single entry. The old three must be deleted, not orphaned.
    await alice.rpc.profiles.updateMine({
      slug: conf.slug,
      entries: [
        { kind: "Z", value: "z", href: null, category: "link", is_public: true, position: 0 },
      ],
    });
    const dbCount = await ctx.prisma.profileEntry.count({ where: { identityId: aliceId } });
    expect(dbCount).toBe(1);
  });

  test("tags dedup; over-cap is rejected by validation", async () => {
    const owner = new Client(ctx.app);
    await owner.rpc.auth.signup({ email: "po12@example.com", password: "secret123" });
    const conf = await owner.rpc.conferences.create({ name: "Tag Cap Smoke" });

    const { client: alice } =
      await inviteAndClaim(ctx.app, owner, conf.slug, "alice12@example.com", "secret123", "Alice");

    // Dedup happens server-side and the returned list is sorted.
    const dedup = await alice.rpc.profiles.updateMine({
      slug: conf.slug,
      tags: ["a", "b", "a", "c", "b"],
    });
    expect(dedup.tags).toEqual(["a", "b", "c"]);

    // 21 tags exceeds the schema's maxLength(20).
    const tooMany = Array.from({ length: 21 }, (_, i) => `t${i}`);
    await expect(
      alice.rpc.profiles.updateMine({ slug: conf.slug, tags: tooMany }),
    ).rejects.toBeInstanceOf(ORPCError);
  });

  test("submissions.list carries submitter_profile_published for link-everywhere gating", async () => {
    const owner = new Client(ctx.app);
    await owner.rpc.auth.signup({ email: "po13@example.com", password: "secret123" });
    const conf = await owner.rpc.conferences.create({ name: "Link-Everywhere Smoke" });

    const { client: alice } =
      await inviteAndClaim(ctx.app, owner, conf.slug, "alice13@example.com", "secret123", "Alice");

    // Alice submits a session. Her profile is unpublished.
    await alice.rpc.submissions.create({
      slug: conf.slug, title: "T", description: "D",
    });

    const beforePublish = await alice.rpc.submissions.listAll({ slug: conf.slug });
    expect(beforePublish.length).toBeGreaterThan(0);
    expect(beforePublish[0]!.submitter_profile_published).toBe(false);

    // After publish, the field flips. The Web SessionCard reads this to
    // decide whether ProfileLink renders as a link or as plain text.
    await alice.rpc.profiles.updateMine({ slug: conf.slug, profile_published: true });
    const afterPublish = await alice.rpc.submissions.listAll({ slug: conf.slug });
    expect(afterPublish[0]!.submitter_profile_published).toBe(true);
  });

  test("experts.list carries profile_published for link-everywhere gating", async () => {
    const owner = new Client(ctx.app);
    await owner.rpc.auth.signup({ email: "po14@example.com", password: "secret123" });
    const conf = await owner.rpc.conferences.create({ name: "Experts Link Smoke" });

    const { client: alice, identity_id: aliceId } =
      await inviteAndClaim(ctx.app, owner, conf.slug, "alice14@example.com", "secret123", "Alice");

    // Promote Alice to expert. Her profile is unpublished.
    await owner.rpc.experts.promote({
      slug: conf.slug, identity_id: aliceId, pool_id: null, room_ids: [],
    });

    const before = await alice.rpc.experts.list({ slug: conf.slug });
    const aliceBefore = before.find((e) => e.identity_id === aliceId);
    expect(aliceBefore?.profile_published).toBe(false);

    await alice.rpc.profiles.updateMine({ slug: conf.slug, profile_published: true });
    const after = await alice.rpc.experts.list({ slug: conf.slug });
    const aliceAfter = after.find((e) => e.identity_id === aliceId);
    expect(aliceAfter?.profile_published).toBe(true);
  });

  test("deleteAvatar nulls own avatar reference", async () => {
    const owner = new Client(ctx.app);
    await owner.rpc.auth.signup({ email: "po5@example.com", password: "secret123" });
    const conf = await owner.rpc.conferences.create({ name: "Avatar Smoke" });

    const { client: alice, identity_id: aliceId } =
      await inviteAndClaim(ctx.app, owner, conf.slug, "alice5@example.com", "secret123", "Alice");

    // Seed avatarPath + avatarHash directly via prisma so the smoke test is
    // hermetic (the upload route produces this pair naturally).
    await ctx.prisma.conferenceIdentity.update({
      where: { id: aliceId },
      data: { avatarPath: "/tmp/fake.webp", avatarHash: "deadbeefcafef00d" },
    });
    const seeded = await alice.rpc.profiles.get({ slug: conf.slug, identity_id: aliceId });
    expect(seeded.avatar_hash).toBe("deadbeefcafef00d");

    await alice.rpc.profiles.deleteAvatar({ slug: conf.slug });
    const after = await alice.rpc.profiles.get({ slug: conf.slug, identity_id: aliceId });
    expect(after.avatar_hash).toBeNull();
  });
});
