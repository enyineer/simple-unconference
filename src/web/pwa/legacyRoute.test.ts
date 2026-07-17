import { describe, expect, test } from "bun:test";
import { legacyHashToPath } from "./legacyRoute";

describe("legacyHashToPath", () => {
  test("migrates a conference hash route to a path", () => {
    expect(legacyHashToPath("#/conferences/foo", "")).toBe("/conferences/foo");
  });

  test("migrates a tab sub-route", () => {
    expect(legacyHashToPath("#/conferences/foo/agenda", "")).toBe("/conferences/foo/agenda");
  });

  test("keeps the hash payload's own query tail", () => {
    expect(legacyHashToPath("#/auth/verify?token=abc123", "")).toBe(
      "/auth/verify?token=abc123",
    );
    expect(legacyHashToPath("#/board/foo?t=tok", "")).toBe("/board/foo?t=tok");
  });

  test("folds a pre-hoisted real search param into the result", () => {
    // wouter's old hash navigate sometimes hoisted ?next= into the real search.
    expect(legacyHashToPath("#/", "?next=/conferences/foo")).toBe("/?next=/conferences/foo");
  });

  test("hash payload query wins over the real search on key conflicts", () => {
    expect(legacyHashToPath("#/auth/reset?token=fromhash", "?token=fromsearch")).toBe(
      "/auth/reset?token=fromhash",
    );
  });

  test("returns null when there's no hash route to migrate", () => {
    expect(legacyHashToPath("", "")).toBeNull();
    expect(legacyHashToPath("#", "")).toBeNull();
    expect(legacyHashToPath("#section", "")).toBeNull(); // a plain anchor, not a route
  });
});
