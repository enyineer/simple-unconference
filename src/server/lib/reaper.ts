// Background reaper for abandoned pending signups (account-linking Phase 3).
//
// When email verification is on, signup creates an unverified User and emails a
// code/link. If the person never completes verification, that row lingers
// forever and holds the unique email. `auth.signup` already lets the rightful
// owner reclaim an unverified row on re-signup, so this isn't a correctness
// requirement - it's hygiene: it stops abandoned unverified rows from
// accumulating (and frees the email for a fresh signup once the link is well
// past its TTL).
//
// Only rows that are unverified AND whose verification link expired more than
// REAP_GRACE_MS ago are deleted. Verified accounts and in-flight signups are
// never touched. Unverified users own no data (conference creation is gated on
// verification), so deletion is safe; sessions cascade.

import type { PrismaClient } from "@prisma/client";

const REAP_INTERVAL_MS = 15 * 60_000;
// Buffer beyond the link TTL before a row is considered abandoned.
const REAP_GRACE_MS = 60 * 60_000;

// One reap pass. Exported for tests; returns the number of rows deleted.
export async function reapPendingUsers(prisma: PrismaClient): Promise<number> {
  const cutoff = new Date(Date.now() - REAP_GRACE_MS);
  const res = await prisma.user.deleteMany({
    where: {
      emailVerifiedAt: null,
      emailVerifyLinkExpiresAt: { not: null, lt: cutoff },
    },
  });
  return res.count;
}

export function startPendingUserReaper(prisma: PrismaClient): void {
  const tick = () => {
    reapPendingUsers(prisma).catch((e) => {
      console.error("[reaper] pending-user reap failed", e);
    });
  };
  setInterval(tick, REAP_INTERVAL_MS).unref?.();
}
