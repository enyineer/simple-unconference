import { describe, expect, test } from "bun:test";
import { tokenFromSearch } from "./queryToken";

// Regression guard: these links broke when the app moved from hash routing to
// wouter v3 path routing, because the token was scanned out of the pathname
// (which no longer carries the query) instead of the search string.

describe("tokenFromSearch", () => {
  test("reads the token from wouter's useSearch() shape (?-prefixed)", () => {
    expect(tokenFromSearch("?token=5f6801542f913a0f806a0b32aad0871d222f01e28b77a6603eb07adbda26b716"))
      .toBe("5f6801542f913a0f806a0b32aad0871d222f01e28b77a6603eb07adbda26b716");
  });

  test("accepts a bare param string without the leading ?", () => {
    expect(tokenFromSearch("token=abc123def456")).toBe("abc123def456");
  });

  test("returns empty string when the search is empty (no query tail)", () => {
    expect(tokenFromSearch("")).toBe("");
  });

  test("returns empty string when the token param is missing", () => {
    expect(tokenFromSearch("?other=1")).toBe("");
  });

  test("returns empty string when the token param is blank", () => {
    expect(tokenFromSearch("?token=")).toBe("");
  });

  test("ignores other params around the token", () => {
    expect(tokenFromSearch("?next=/conferences/foo&token=abc123def456&x=2"))
      .toBe("abc123def456");
  });
});
