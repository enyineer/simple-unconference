// Unit tests for the shared avatarUrl helper. The critical behavior: the
// initials-fallback URL (no content hash) carries the display label as its
// cache key, so a rename produces a NEW URL and the browser/CDN can't serve
// the previous initials (the endpoint stamps initials with max-age=300).
// See src/server/routes/avatars.ts for the matching caching contract.

import { describe, test, expect } from "bun:test";
import { avatarUrl } from "./helpers";

describe("avatarUrl", () => {
  test("hashed URLs are immutable-cacheable and never versioned", () => {
    expect(avatarUrl("demo", 7, "deadbeef", "Alice")).toBe(
      "/api/avatars/demo/7/deadbeef",
    );
    expect(avatarUrl("demo", 7, "deadbeef")).toBe("/api/avatars/demo/7/deadbeef");
  });

  test("hashless URLs seed the cache key with the display label", () => {
    expect(avatarUrl("demo", 7, null, "Alice")).toBe("/api/avatars/demo/7?v=Alice");
    expect(avatarUrl("demo", 7, null)).toBe("/api/avatars/demo/7?v=");
  });

  test("a rename changes the URL so cached initials are never reused", () => {
    const before = avatarUrl("demo", 7, null, null);
    const after = avatarUrl("demo", 7, null, "Alice Smith");
    expect(before).not.toBe(after);
    expect(avatarUrl("demo", 7, null, "Alice Smith"))
      .toBe(avatarUrl("demo", 7, null, "Alice Smith"));
  });

  test("special characters in the label are encoded", () => {
    expect(avatarUrl("demo", 7, null, "Ana & Béa")).toBe(
      `/api/avatars/demo/7?v=${encodeURIComponent("Ana & Béa")}`,
    );
  });
});
