// Web Push (OS-level notifications) transport.
//
// Env-gated exactly like lib/turnstile.ts and lib/email.ts: when the VAPID keys
// are unset this module is inert — `webPushConfigured()` reports false, the
// client never renders the opt-in, and `sendPushForNotification()` returns
// immediately without touching the DB. That keeps push free for self-hosted
// instances that don't want to generate + carry a VAPID keypair.
//
// When configured, this is a best-effort AUGMENT to the in-app bell (never a
// replacement): every `createNotification` fire-and-forgets a push here. A push
// failure must never affect the notification write, so every path swallows.
//
// Payloads are privacy-safe (display names / titles only, NEVER emails) —
// mirrors the wider bell + board privacy contract. Generate a keypair with
// `bun run scripts/gen-vapid.ts`.

import webpush, { WebPushError, type PushSubscription } from "web-push";
import type { PrismaClient } from "@prisma/client";

// Read env on each access (parity with turnstile/email) so tests can flip the
// config without restarting. Returns null when unset/blank.
function publicKey(): string | null {
  return process.env.VAPID_PUBLIC_KEY?.trim() || null;
}
function privateKey(): string | null {
  return process.env.VAPID_PRIVATE_KEY?.trim() || null;
}

// The VAPID `sub` claim must be a `mailto:` address or an `https:` URL. Prefer
// an explicit VAPID_SUBJECT; fall back to the instance origin when it's https;
// last-resort a mailto placeholder (a bare http://localhost would be rejected
// by the push service, so we never hand one through).
function subject(): string {
  const explicit = process.env.VAPID_SUBJECT?.trim();
  if (explicit) return explicit;
  const appUrl = process.env.APP_URL?.trim();
  if (appUrl && appUrl.startsWith("https://")) return appUrl.replace(/\/+$/, "");
  return "mailto:admin@example.com";
}

// True only when both VAPID keys are present. Drives config.get's
// `vapid_public_key` (null when false) and gates the client opt-in.
export function webPushConfigured(): boolean {
  return publicKey() !== null && privateKey() !== null;
}

// The public key the SPA needs to call `pushManager.subscribe`. Null when
// unconfigured so the client knows not to render the opt-in control.
export function vapidPublicKey(): string | null {
  return publicKey();
}

// setVapidDetails mutates process-global web-push state; only call it right
// before a send, keyed to the CURRENT env, so a mid-process env flip (tests)
// isn't cached.
function applyVapidDetails(): boolean {
  const pub = publicKey();
  const priv = privateKey();
  if (!pub || !priv) return false;
  webpush.setVapidDetails(subject(), pub, priv);
  return true;
}

// Privacy-safe push payload. `url` is a hash deep-link the service worker opens
// on click. NEVER carries an email.
export interface PushPayload {
  title: string;
  body: string | null;
  url: string;
}

// Low-level single send. Returns a discriminated result rather than throwing:
//   - { ok: true }              delivered
//   - { ok: false, gone: true } the subscription is dead (404/410) — caller
//                               should delete the row
//   - { ok: false, gone: false } transient failure — keep the row, try later
export type SendOutcome =
  | { ok: true }
  | { ok: false; gone: boolean };

export async function sendWebPush(
  subscription: PushSubscription,
  payload: PushPayload,
): Promise<SendOutcome> {
  if (!applyVapidDetails()) return { ok: false, gone: false };
  try {
    await webpush.sendNotification(subscription, JSON.stringify(payload));
    return { ok: true };
  } catch (err: unknown) {
    if (err instanceof WebPushError) {
      // 404 Not Found / 410 Gone: the browser dropped the subscription. Any
      // other status (429, 5xx, network) is transient — don't delete.
      const gone = err.statusCode === 404 || err.statusCode === 410;
      return { ok: false, gone };
    }
    return { ok: false, gone: false };
  }
}

// Translate a notification's `ctaHref` into a path deep-link the service worker
// can open. Mirrors NotificationBell's click routing:
//   - "tab:<key>"  → /conferences/<slug>/<key>   (the tab sub-route)
//   - "/<path>"    → <path>                       (a full SPA path)
//   - null / other → /conferences/<slug>/         (the conference home)
export function deepLinkForNotification(
  slug: string,
  ctaHref: string | null | undefined,
): string {
  if (ctaHref && ctaHref.startsWith("tab:")) {
    return `/conferences/${slug}/${ctaHref.slice("tab:".length)}`;
  }
  if (ctaHref && ctaHref.startsWith("/")) {
    return ctaHref;
  }
  return `/conferences/${slug}/`;
}

// Injectable send fn — real one by default; tests pass a fake so the stale-row
// cleanup path can be exercised without a real push endpoint.
type Sender = (
  subscription: PushSubscription,
  payload: PushPayload,
) => Promise<SendOutcome>;

// Best-effort fan-out to every device the identity registered. Called
// fire-and-forget from `createNotification` AFTER the row write + bus publish.
// Fully inert (zero DB work) when unconfigured. Never throws — a push failure
// must never affect the notification write or the request.
export async function sendPushForNotification(
  prisma: PrismaClient,
  identityId: number,
  input: { title: string; body?: string | null; ctaHref?: string | null },
  sender: Sender = sendWebPush,
): Promise<void> {
  if (!webPushConfigured()) return;
  try {
    const identity = await prisma.conferenceIdentity.findUnique({
      where: { id: identityId },
      select: {
        conference: { select: { slug: true } },
        pushSubscriptions: {
          select: { id: true, endpoint: true, p256dh: true, auth: true },
        },
      },
    });
    if (!identity || identity.pushSubscriptions.length === 0) return;

    const payload: PushPayload = {
      title: input.title,
      body: input.body ?? null,
      url: deepLinkForNotification(identity.conference.slug, input.ctaHref),
    };

    const staleIds: number[] = [];
    await Promise.all(
      identity.pushSubscriptions.map(async (sub) => {
        const outcome = await sender(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          payload,
        );
        if (!outcome.ok && outcome.gone) staleIds.push(sub.id);
      }),
    );

    if (staleIds.length > 0) {
      await prisma.pushSubscription.deleteMany({ where: { id: { in: staleIds } } });
    }
  } catch (err) {
    // Best-effort: log and swallow so the notification path is never affected.
    console.error("[webpush] sendPushForNotification failed", err);
  }
}
