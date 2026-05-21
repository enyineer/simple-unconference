// Resource-switched messages for the server's `quota_exceeded` errors.
// The server attaches structured data — `{ resource, limit, current }` — so
// every page that can hit a quota wall can show the specific cap that was
// reached and what to do about it.
//
// Returns `null` for non-quota errors so callers can chain with their own
// humanError() mapping (and fall back to the raw code only when no helper
// matches).

import { ApiError } from "./api";

interface QuotaData {
  resource?: string;
  limit?: number;
  current?: number;
}

export function quotaErrorMessage(e: unknown): string | null {
  if (!(e instanceof ApiError)) return null;
  if (e.message !== "quota_exceeded") return null;

  const data = (e.data as QuotaData | undefined) ?? {};
  const limit = data.limit ?? 0;

  switch (data.resource) {
    case "conferences_per_user":
      return `This instance limits each account to ${limit} conference${limit === 1 ? "" : "s"}. Delete or transfer one before creating another.`;

    case "sessions_per_user_per_conference":
      return `You've reached the limit of ${limit} session${limit === 1 ? "" : "s"} for this conference. Delete one of yours before submitting another.`;

    case "participants_per_conference":
      return `This conference has reached its participant cap of ${limit}. Ask the owner if they can raise it.`;

    case "pending_invites_per_conference":
      return `This conference has ${limit} unclaimed invites — the cap for this instance. Wait for invitees to claim, or revoke some pending ones.`;

    case "rooms_per_conference":
      return `This conference has reached its room cap of ${limit}.`;

    default:
      // Unknown resource: still informative without leaking raw codes.
      return limit > 0
        ? `Quota of ${limit} reached for this resource on this instance.`
        : "Quota limit reached on this instance.";
  }
}
