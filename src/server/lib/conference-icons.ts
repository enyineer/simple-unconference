// Per-conference app icon storage (PWA install icon). Parallels lib/avatars.ts:
// uploads are piped through `sharp`, resized to square PNGs at 192 and 512 on a
// solid dark background (so they're maskable-safe), and stored under
// `data/conference-icons/<conferenceId>/<size>.png`. The root can be overridden
// via CONFERENCE_ICON_DIR so tests isolate uploads.
//
// Notes:
// - The on-disk path is never returned to clients. The HTTP route at
//   `/api/conference-icons/:slug/:size[/:hash]` is the only public surface, and
//   it falls back to the built-in default icon bytes (never 404) so the web app
//   manifest icon always resolves.
// - PNG (not webp) because installable-app manifest icons need broad platform
//   support; iOS home-screen icons in particular expect PNG.

import { mkdirSync, readFileSync, existsSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import sharp from "sharp";

// The two icon sizes the web app manifest declares. 192 for the launcher /
// install prompt, 512 for splash + high-DPI home screens.
export const ICON_SIZES = [192, 512] as const;
export type IconSize = (typeof ICON_SIZES)[number];

// 16 hex chars = 64 bits of sha256 — collision-resistant enough for
// per-conference content versioning and short enough to keep URLs tidy.
const HASH_HEX_LEN = 16;

// Solid dark fill behind the (contain-fitted) source image. Matches the board /
// manifest theme color so a non-square logo blends into the maskable safe area
// instead of showing transparent corners on platforms that don't honor alpha.
const BG = { r: 0x0a, g: 0x0d, b: 0x12, alpha: 1 } as const;

function rootDir(): string {
  return process.env.CONFERENCE_ICON_DIR ?? "./data/conference-icons";
}

export function conferenceIconDir(conferenceId: number): string {
  return join(rootDir(), String(conferenceId));
}

export function conferenceIconPathFor(conferenceId: number, size: IconSize): string {
  return join(conferenceIconDir(conferenceId), `${size}.png`);
}

export function computeIconHash(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex").slice(0, HASH_HEX_LEN);
}

export interface WriteConferenceIconResult {
  // The 512 on-disk path (representative — both sizes are written together).
  path: string;
  // Content hash derived from the 512 PNG, used to cache-bust served URLs.
  hash: string;
}

// Pipes the incoming bytes through sharp, producing square PNGs at every
// ICON_SIZE. Non-square sources are `contain`-fitted onto the solid dark
// background so the whole logo stays visible (better than a center crop for a
// brand mark) while remaining maskable-safe. Throws if sharp can't decode the
// input — the route surfaces that as a 400.
export async function writeConferenceIcon(
  conferenceId: number,
  bytes: ArrayBuffer | Uint8Array | Buffer,
): Promise<WriteConferenceIconResult> {
  mkdirSync(conferenceIconDir(conferenceId), { recursive: true });
  const input = bytes instanceof Buffer
    ? bytes
    : bytes instanceof Uint8Array
      ? Buffer.from(bytes)
      : Buffer.from(new Uint8Array(bytes));

  let hash = "";
  let path = "";
  for (const size of ICON_SIZES) {
    const out = await sharp(input)
      .rotate()
      .resize(size, size, { fit: "contain", position: "center", background: BG })
      .flatten({ background: BG })
      .png()
      .toBuffer();
    const p = conferenceIconPathFor(conferenceId, size);
    await Bun.write(p, out);
    // Hash keyed off the largest rendition — deterministic per source + config.
    if (size === 512) {
      hash = computeIconHash(out);
      path = p;
    }
  }
  return { path, hash };
}

export function readConferenceIcon(conferenceId: number, size: IconSize): Buffer | null {
  const path = conferenceIconPathFor(conferenceId, size);
  return existsSync(path) ? readFileSync(path) : null;
}

// Best-effort cleanup of a conference's stored icons (both sizes + the dir).
// Safe to call when nothing was ever uploaded.
export function deleteConferenceIcon(conferenceId: number): void {
  const dir = conferenceIconDir(conferenceId);
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
}

// Built-in default icon bytes, read from the public assets that ship with the
// web build. Both `dist/` (production static output) and `src/web/public/`
// (dev + tests) are present in the runtime image, so try dist first then fall
// back to source. Cached after first read since the bytes never change.
const defaultIconCache = new Map<IconSize, Buffer>();

export function defaultIconBytes(size: IconSize): Buffer {
  const cached = defaultIconCache.get(size);
  if (cached) return cached;
  const candidates = [
    join(import.meta.dir, "../../../dist", `icon-${size}.png`),
    join(import.meta.dir, "../../web/public", `icon-${size}.png`),
  ];
  for (const p of candidates) {
    if (existsSync(p)) {
      const bytes = readFileSync(p);
      defaultIconCache.set(size, bytes);
      return bytes;
    }
  }
  // Both locations missing would be a packaging bug — surface it loudly rather
  // than serving a broken manifest icon silently.
  throw new Error(`default conference icon icon-${size}.png not found`);
}
