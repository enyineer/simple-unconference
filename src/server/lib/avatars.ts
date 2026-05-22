// Avatar storage helpers. Files live under `data/avatars/<conferenceId>/<identityId>.webp`,
// resized and normalized via `sharp` (256x256 cover, EXIF-rotated). The root
// directory can be overridden via `AVATAR_DIR` so tests can isolate uploads.
//
// Notes:
// - The on-disk path is never returned to clients. The HTTP route at
//   `/api/avatars/:slug/:identityId` is the only public surface.
// - When no file exists (or visibility is denied) the GET endpoint falls
//   back to a deterministic initials SVG so existence isn't leaked via
//   404 vs 200 status codes.

import { mkdirSync, readFileSync, existsSync, unlinkSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import sharp from "sharp";

// 16 hex chars = 64 bits of sha256 -- collision-resistant enough for
// per-identity content versioning and short enough to keep URLs tidy.
const HASH_HEX_LEN = 16;

export function computeAvatarHash(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex").slice(0, HASH_HEX_LEN);
}

function rootDir(): string {
  return process.env.AVATAR_DIR ?? "./data/avatars";
}

export function avatarPathFor(conferenceId: number, identityId: number): string {
  return join(rootDir(), String(conferenceId), `${identityId}.webp`);
}

export interface WriteAvatarResult {
  path: string;
  bytes: Buffer;
  hash: string;
}

// Pipes the incoming bytes through sharp, normalizing orientation and
// downscaling to a square 256x256 webp. Returns the on-disk path, the
// processed bytes, and a content hash for cache-busting URLs.
export async function writeAvatar(
  conferenceId: number,
  identityId: number,
  bytes: ArrayBuffer | Uint8Array | Buffer,
): Promise<WriteAvatarResult> {
  mkdirSync(join(rootDir(), String(conferenceId)), { recursive: true });
  const input = bytes instanceof Buffer
    ? bytes
    : bytes instanceof Uint8Array
      ? Buffer.from(bytes)
      : Buffer.from(new Uint8Array(bytes));
  const out = await sharp(input)
    .rotate()
    .resize(256, 256, { fit: "cover", position: "center" })
    .webp({ quality: 85 })
    .toBuffer();
  const path = avatarPathFor(conferenceId, identityId);
  await Bun.write(path, out);
  return { path, bytes: out, hash: computeAvatarHash(out) };
}

export function readAvatar(conferenceId: number, identityId: number): Buffer | null {
  const path = avatarPathFor(conferenceId, identityId);
  return existsSync(path) ? readFileSync(path) : null;
}

export function avatarStat(conferenceId: number, identityId: number): { mtimeMs: number; size: number } | null {
  const path = avatarPathFor(conferenceId, identityId);
  if (!existsSync(path)) return null;
  const s = statSync(path);
  return { mtimeMs: s.mtimeMs, size: s.size };
}

export function deleteAvatar(conferenceId: number, identityId: number): void {
  const path = avatarPathFor(conferenceId, identityId);
  if (existsSync(path)) unlinkSync(path);
}

// Deterministic initials SVG fallback. `name` may be null when the viewer is
// not allowed to know whose identity this is (existence-leak guard) -- in that
// case the SVG renders a `?` and uses only the identityId-derived hue.
export function initialsSvg(name: string | null, identityId: number): string {
  const parts = (name ?? "").split(/\s+/).filter(Boolean);
  const letters = parts
    .slice(0, 2)
    .map((s) => s[0]!.toUpperCase())
    .join("");
  const initials = letters.length > 0 ? letters : "?";
  // Stable hue derived from the identity id. Multiplier picked to spread
  // adjacent ids across the color wheel.
  const hue = (identityId * 137) % 360;
  // No newlines inside the SVG: keeps content-length predictable and avoids
  // accidentally generating XML whitespace nodes inside <text>.
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256">` +
    `<rect width="256" height="256" fill="hsl(${hue} 60% 45%)"/>` +
    `<text x="128" y="128" text-anchor="middle" dominant-baseline="central" ` +
    `font-family="system-ui,sans-serif" font-size="120" font-weight="600" fill="#fff">${initials}</text>` +
    `</svg>`;
}
