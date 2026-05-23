import { base } from "./shared";
import { LIMITS } from "../lib/limits";
import { turnstileSiteKey } from "../lib/turnstile";

// Truthy = signup blocked. Treats "1"/"true"/"yes" (any case) as on; anything
// else (including unset) leaves global signup enabled — safe default for
// existing deployments.
function isSignupDisabled(): boolean {
  const v = process.env.DISABLE_SIGNUP;
  if (!v) return false;
  return /^(1|true|yes)$/i.test(v.trim());
}

export const configRouter = {
  get: base.config.get.handler(async () => {
    return {
      signup_enabled: !isSignupDisabled(),
      turnstile_site_key: turnstileSiteKey(),
      max_conferences_per_user:
        LIMITS.maxConferencesPerUser === 0 ? null : LIMITS.maxConferencesPerUser,
      max_sessions_per_user_per_conference:
        LIMITS.maxSessionsPerUserPerConference === 0
          ? null
          : LIMITS.maxSessionsPerUserPerConference,
    };
  }),
};

export { isSignupDisabled };
