import { useState, useEffect, useRef } from "react";
import {
  PageLayout, Stack, Card, TextInput, Button, Form, Link, Text,
} from "../design-system";
import { useToast } from "../design-system/hooks";
import { api, errorCode, errorFields } from "../api";
import { useForm } from "../useForm";
import { useRoute } from "../router";
import {
  LoginSchema, SignupSchema, RequestPasswordResetSchema, safeParse,
} from "../../shared/schemas";
import { TurnstileWidget, type TurnstileWidgetHandle } from "../components/TurnstileWidget";

const REPO_URL = "https://github.com/enyineer/simple-unconference";
const REPO_API = "https://api.github.com/repos/enyineer/simple-unconference";

// Pull the optional post-login `?next=` target. Used to bounce conference
// owners back to the conference they came from after they sign in with their
// organizer account. Path-based routing: `?next=` is a real search param.
function readNext(): string | null {
  return new URLSearchParams(window.location.search).get("next");
}

// Drop a consumed (or abandoned) `?next=` from the real URL search so it
// doesn't linger and re-trigger a redirect on a later, unrelated sign-in.
function clearNextSearchParam() {
  if (!window.location.search) return;
  const params = new URLSearchParams(window.location.search);
  if (!params.has("next")) return;
  params.delete("next");
  const rest = params.toString();
  history.replaceState(
    null, "",
    window.location.pathname + (rest ? `?${rest}` : "") + window.location.hash,
  );
}

// Only honor internal, relative destinations. Reject protocol-relative
// (`//host`), any scheme (`https://…`, `javascript:…`), and backslash tricks
// so a crafted `next` can never redirect off-site.
function safeNext(raw: string | null): string | null {
  if (!raw) return null;
  if (!raw.startsWith("/")) return null;
  if (raw.startsWith("//") || raw.startsWith("/\\")) return null;
  if (raw.includes("://") || raw.includes("\\")) return null;
  return raw;
}

// Page-scoped styles. Inlined here so the landing owns its identity without
// leaking into the rest of the app. All colors flow through DS CSS vars
// (Primer `--*Color-*` / Minimal `--uncon-*`) so dark mode + theme swaps
// inherit correctly.
const PAGE_STYLES = `
.unconf-landing { display: flex; flex-direction: column; gap: 56px; padding: 8px 0 24px; }
.unconf-brandbar { display: flex; align-items: center; justify-content: space-between; }
.unconf-brand {
  font-size: 15px; font-weight: 700; letter-spacing: -0.01em;
  color: var(--fgColor-default, var(--uncon-fg, inherit));
}
.unconf-brand-dot {
  display: inline-block; width: 7px; height: 7px; border-radius: 999px;
  background: var(--fgColor-accent, var(--uncon-primary, #2563eb));
  margin-right: 8px; vertical-align: middle;
}
.unconf-icon-link {
  display: inline-flex; align-items: center; justify-content: center;
  width: 36px; height: 36px; border-radius: 999px;
  color: var(--fgColor-muted, var(--uncon-fg-muted, #6b7280));
  text-decoration: none;
  transition: color 120ms ease, background 120ms ease, transform 120ms ease;
}
.unconf-icon-link:hover {
  color: var(--fgColor-default, var(--uncon-fg, inherit));
  background: var(--bgColor-muted, var(--uncon-bg-subtle, rgba(127,127,127,0.08)));
}

.unconf-hero { display: flex; flex-direction: column; gap: 18px; max-width: 720px; }
.unconf-eyebrow {
  display: inline-flex; align-items: center; gap: 8px;
  font-size: 11px; font-weight: 600;
  letter-spacing: 0.14em; text-transform: uppercase;
  color: var(--fgColor-accent, var(--uncon-primary, #2563eb));
}
.unconf-eyebrow::before {
  content: ""; display: inline-block; width: 18px; height: 1.5px;
  background: currentColor; opacity: 0.7;
}
.unconf-display {
  font-size: clamp(34px, 5.6vw, 56px);
  font-weight: 700;
  line-height: 1.05;
  letter-spacing: -0.025em;
  margin: 0;
  color: var(--fgColor-default, var(--uncon-fg, inherit));
}
.unconf-display em {
  font-style: normal;
  color: var(--fgColor-accent, var(--uncon-primary, #2563eb));
}
.unconf-lede {
  font-size: 17px; line-height: 1.55; max-width: 620px;
  color: var(--fgColor-muted, var(--uncon-fg-muted, #6b7280));
  margin: 0;
}
.unconf-source-row { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin-top: 4px; }
.unconf-source-pill {
  display: inline-flex; align-items: center; gap: 8px;
  padding: 6px 12px; border-radius: 999px;
  border: 1px solid var(--borderColor-default, var(--uncon-border, rgba(127,127,127,0.25)));
  background: var(--bgColor-muted, var(--uncon-bg-subtle, rgba(127,127,127,0.04)));
  color: var(--fgColor-default, var(--uncon-fg, inherit));
  font-size: 13px; font-weight: 500; text-decoration: none;
  transition: border-color 120ms ease, background 120ms ease, transform 120ms ease;
}
.unconf-source-pill:hover {
  border-color: var(--fgColor-accent, var(--uncon-primary, #2563eb));
  transform: translateY(-1px);
}
.unconf-star {
  display: inline-flex; align-items: center; gap: 4px;
  padding-left: 10px; margin-left: 2px;
  border-left: 1px solid var(--borderColor-muted, var(--uncon-border-muted, rgba(127,127,127,0.2)));
  color: var(--fgColor-muted, var(--uncon-fg-muted, #6b7280));
  font-variant-numeric: tabular-nums;
}

.unconf-features {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
  gap: 14px;
}
.unconf-feature {
  display: flex; flex-direction: column; gap: 10px;
  padding: 20px 22px;
  border: 1px solid var(--borderColor-default, var(--uncon-border, rgba(127,127,127,0.22)));
  border-radius: 12px;
  background: var(--bgColor-default, var(--uncon-bg, transparent));
  transition: border-color 160ms ease, transform 160ms ease, box-shadow 160ms ease;
}
.unconf-feature:hover {
  border-color: var(--fgColor-accent, var(--uncon-primary, #2563eb));
  transform: translateY(-2px);
  box-shadow: 0 8px 24px -16px rgba(0,0,0,0.18);
}
.unconf-feature-icon {
  display: inline-flex; align-items: center; justify-content: center;
  width: 34px; height: 34px; border-radius: 10px;
  background: var(--bgColor-muted, var(--uncon-bg-subtle, rgba(127,127,127,0.08)));
  color: var(--fgColor-accent, var(--uncon-primary, #2563eb));
}
.unconf-feature-title {
  font-size: 15px; font-weight: 600; margin: 0;
  color: var(--fgColor-default, var(--uncon-fg, inherit));
}
.unconf-feature-body {
  font-size: 14px; line-height: 1.5; margin: 0;
  color: var(--fgColor-muted, var(--uncon-fg-muted, #6b7280));
}

.unconf-signin { max-width: 440px; width: 100%; align-self: center; }
.unconf-signin-section {
  display: flex; flex-direction: column; align-items: center; gap: 14px;
  padding-top: 8px;
}
.unconf-signin-heading {
  font-size: 13px; font-weight: 600;
  letter-spacing: 0.08em; text-transform: uppercase;
  color: var(--fgColor-muted, var(--uncon-fg-muted, #6b7280));
}
`;

function GitHubIcon({ size = 18 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M12 .5C5.73.5.75 5.48.75 11.75c0 4.96 3.22 9.16 7.69 10.65.56.1.77-.24.77-.54v-2.1c-3.13.68-3.79-1.32-3.79-1.32-.51-1.3-1.25-1.65-1.25-1.65-1.02-.7.08-.69.08-.69 1.13.08 1.72 1.16 1.72 1.16 1 1.72 2.63 1.22 3.27.93.1-.73.39-1.22.71-1.5-2.5-.29-5.13-1.25-5.13-5.56 0-1.23.44-2.23 1.16-3.02-.12-.29-.5-1.44.11-3 0 0 .95-.3 3.1 1.15a10.7 10.7 0 0 1 5.64 0c2.15-1.45 3.1-1.15 3.1-1.15.61 1.56.23 2.71.11 3 .72.79 1.16 1.79 1.16 3.02 0 4.32-2.63 5.27-5.14 5.55.4.35.76 1.03.76 2.08v3.08c0 .3.2.65.78.54 4.46-1.49 7.68-5.69 7.68-10.65C23.25 5.48 18.27.5 12 .5z" />
    </svg>
  );
}

function StarIcon({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 2.5l2.9 6.5 7.1.7-5.4 4.8 1.6 7-6.2-3.7-6.2 3.7 1.6-7L2 9.7l7.1-.7L12 2.5z" />
    </svg>
  );
}

function useGitHubStars(): number | null {
  const [stars, setStars] = useState<number | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch(REPO_API, { headers: { Accept: "application/vnd.github+json" } })
      .then((r) => (r.ok ? r.json() : null))
      .then((data: unknown) => {
        if (cancelled || !data || typeof data !== "object") return;
        const n = (data as { stargazers_count?: unknown }).stargazers_count;
        if (typeof n === "number") setStars(n);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);
  return stars;
}

function BrandBar() {
  return (
    <div className="unconf-brandbar">
      <span className="unconf-brand">
        <span className="unconf-brand-dot" aria-hidden="true" />
        Unconf
      </span>
      <a
        href={REPO_URL}
        target="_blank"
        rel="noopener noreferrer"
        aria-label="View source on GitHub"
        title="View source on GitHub"
        className="unconf-icon-link"
      >
        <GitHubIcon size={20} />
      </a>
    </div>
  );
}

function Hero({ stars }: { stars: number | null }) {
  return (
    <section className="unconf-hero">
      <span className="unconf-eyebrow">Self-hosted Open Space platform</span>
      <h1 className="unconf-display">
        Run an unconference <em>without</em> spreadsheets.
      </h1>
      <p className="unconf-lede">
        Pitch sessions, vote with stars, and let the schedule emerge from what people
        actually want to talk about. Open source, self-hosted, no SaaS lock-in.
      </p>
      <div className="unconf-source-row">
        <a href={REPO_URL} target="_blank" rel="noopener noreferrer" className="unconf-source-pill">
          <GitHubIcon size={14} />
          Source on GitHub
          {stars !== null && (
            <span className="unconf-star">
              <StarIcon size={11} />
              {stars.toLocaleString()}
            </span>
          )}
        </a>
      </div>
    </section>
  );
}

type FeatureGlyph = "spark" | "grid" | "user" | "server";

function FeatureGlyph({ glyph }: { glyph: FeatureGlyph }) {
  const common = {
    width: 18,
    height: 18,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };
  switch (glyph) {
    case "spark":
      return (
        <svg {...common}>
          <path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1" />
          <circle cx="12" cy="12" r="3" />
        </svg>
      );
    case "grid":
      return (
        <svg {...common}>
          <rect x="3" y="3" width="7" height="7" rx="1.5" />
          <rect x="14" y="3" width="7" height="7" rx="1.5" />
          <rect x="3" y="14" width="7" height="7" rx="1.5" />
          <rect x="14" y="14" width="7" height="7" rx="1.5" />
        </svg>
      );
    case "user":
      return (
        <svg {...common}>
          <circle cx="12" cy="8" r="3.5" />
          <path d="M4.5 20a7.5 7.5 0 0 1 15 0" />
        </svg>
      );
    case "server":
      return (
        <svg {...common}>
          <rect x="3" y="4" width="18" height="7" rx="1.5" />
          <rect x="3" y="13" width="18" height="7" rx="1.5" />
          <path d="M7 7.5h.01M7 16.5h.01" />
        </svg>
      );
  }
}

const FEATURES: Array<{ glyph: FeatureGlyph; title: string; body: string }> = [
  {
    glyph: "spark",
    title: "Open Space, made digital",
    body: "Participants pitch sessions and vote with stars. The agenda forms from genuine interest, not the loudest voice in the room.",
  },
  {
    glyph: "grid",
    title: "Rooms auto-assigned",
    body: "A deterministic algorithm fills rooms by interest, respects per-slot scope, and avoids double-booking submitters.",
  },
  {
    glyph: "user",
    title: "Experts on the side",
    body: "Book 1:1 time with experts in parallel to the sessions. Slot owners and other bookings stay private to moderators.",
  },
  {
    glyph: "server",
    title: "Self-hostable on anything",
    body: "Single Bun process, SQLite by default, Docker image and Helm chart published. No tracking, no telemetry, your data stays yours.",
  },
];

function Features() {
  return (
    <section className="unconf-features" aria-label="Features">
      {FEATURES.map((f) => (
        <article key={f.title} className="unconf-feature">
          <span className="unconf-feature-icon">
            <FeatureGlyph glyph={f.glyph} />
          </span>
          <h3 className="unconf-feature-title">{f.title}</h3>
          <p className="unconf-feature-body">{f.body}</p>
        </article>
      ))}
    </section>
  );
}

export function LoginPage({ onLoggedIn }: { onLoggedIn: () => void }) {
  const toast = useToast();
  const { navigate } = useRoute();
  // Where to land after a successful sign-in (e.g. the conference an owner was
  // trying to open). Ignored for unverified accounts so the email-verification
  // wall still takes over at `/`.
  const nextTarget = safeNext(readNext());
  const [mode, setMode] = useState<"login" | "signup" | "forgot">("login");
  const [busy, setBusy] = useState(false);
  // Set after a forgot-password request so we can show the (deliberately
  // generic, non-enumerating) confirmation instead of the form.
  const [resetSent, setResetSent] = useState(false);
  // null = still loading; true/false = known. Defaults to permissive (true)
  // on fetch failure so a transient outage doesn't lock out new owners.
  const [signupEnabled, setSignupEnabled] = useState<boolean | null>(null);
  // Non-null when the server has Turnstile configured. Drives whether we
  // render the widget at all + whether we hold the form until a token arrives.
  const [turnstileSiteKey, setTurnstileSiteKey] = useState<string | null>(null);
  const turnstileRef = useRef<TurnstileWidgetHandle | null>(null);
  const stars = useGitHubStars();

  useEffect(() => {
    let cancelled = false;
    api.config.get()
      .then((c) => {
        if (cancelled) return;
        setSignupEnabled(c.signup_enabled);
        setTurnstileSiteKey(c.turnstile_site_key);
      })
      .catch(() => { if (!cancelled) setSignupEnabled(true); });
    return () => { cancelled = true; };
  }, []);

  // If signup gets disabled while the form is in signup mode (e.g. operator
  // flipped the env var between page load and submit), force back to login.
  // Adjusted during render so the next paint already reflects the corrected
  // mode rather than briefly showing the disallowed signup form.
  if (signupEnabled === false && mode === "signup") setMode("login");

  // Same field set, two schemas — pick at submit time.
  const form = useForm(SignupSchema, { email: "", password: "", name: "" });

  async function submit(e: React.FormEvent) {
    e.preventDefault();

    // Read the token straight from the widget at submit time. Avoids any
    // race between Cloudflare's callback firing and React state catching up.
    const turnstileToken = turnstileSiteKey !== null
      ? (turnstileRef.current?.getResponse() ?? "")
      : "";
    if (turnstileSiteKey !== null && turnstileToken === "") {
      toast.error("Please complete the verification challenge before continuing.");
      return;
    }

    if (mode === "forgot") {
      const r = safeParse(RequestPasswordResetSchema, {
        email: form.values.email, turnstile_token: turnstileToken || undefined,
      });
      if (!r.ok) { form.setErrors(r.errors); return; }
      setBusy(true);
      try {
        await api.auth.requestPasswordReset(r.data);
        // Always show success — the server never reveals whether the email
        // maps to a real account.
        setResetSent(true);
      } catch (e) {
        toast.error(humanError(errorCode(e)));
        turnstileRef.current?.reset();
      } finally {
        setBusy(false);
      }
      return;
    }

    const baseFields = mode === "login"
      ? { email: form.values.email, password: form.values.password }
      : form.values;
    const withToken = { ...baseFields, turnstile_token: turnstileToken || undefined };
    const r = mode === "login"
      ? safeParse(LoginSchema, withToken)
      : safeParse(SignupSchema, withToken);
    if (!r.ok) {
      form.setErrors(r.errors);
      return;
    }

    setBusy(true);
    try {
      if (mode === "login") {
        const me = await api.auth.login(r.data as { email: string; password: string; turnstile_token?: string });
        onLoggedIn();
        // Honor `next` only for verified accounts. Unverified owners must hit
        // the verification wall at `/`, so we leave the route untouched and let
        // App render it. Either way the param is spent — clear it from the URL
        // search (wouter keeps existing search on navigation) so it can't
        // re-trigger on a later sign-in.
        clearNextSearchParam();
        if (me.email_verified && nextTarget) navigate(nextTarget);
      } else {
        await api.auth.signup(r.data as { email: string; password: string; name?: string; turnstile_token?: string });
        onLoggedIn();
      }
    } catch (e) {
      const fields = errorFields(e);
      if (fields) form.setErrors(fields);
      else toast.error(humanError(errorCode(e)));
      // Turnstile tokens are single-use; reset so the widget mints a fresh one
      // for the next attempt.
      turnstileRef.current?.reset();
    } finally {
      setBusy(false);
    }
  }

  // Switch between login / signup / forgot, clearing transient state so a
  // stale error or confirmation doesn't bleed across modes.
  function switchMode(next: "login" | "signup" | "forgot") {
    setMode(next);
    setResetSent(false);
    form.setErrors({});
  }

  return (
    <PageLayout>
      <style>{PAGE_STYLES}</style>
      <div className="unconf-landing">
        <BrandBar />
        <Hero stars={stars} />
        <Features />

        <div className="unconf-signin-section">
          <span className="unconf-signin-heading">
            {mode === "login" ? "Sign in to continue"
              : mode === "signup" ? "Create your account"
              : "Reset your password"}
          </span>
          <div className="unconf-signin">
            <Card title={mode === "login" ? "Sign in"
              : mode === "signup" ? "Create account"
              : "Forgot password"}>
              {mode === "forgot" && resetSent ? (
                <Stack gap="normal">
                  <Text muted>
                    If an account exists for that email, we&apos;ve sent a link
                    to reset your password. Check your inbox (and spam folder) -
                    the link expires shortly.
                  </Text>
                  <Stack direction="row" gap="condensed" align="center">
                    <Button variant="primary" onClick={() => switchMode("login")}>
                      Back to sign in
                    </Button>
                  </Stack>
                </Stack>
              ) : (
                <Form onSubmit={submit}>
                  {mode === "forgot" && (
                    <Text muted>
                      Enter your account email and we&apos;ll send you a link to
                      choose a new password.
                    </Text>
                  )}
                  <TextInput
                    label="Email" type="email" required
                    value={form.values.email ?? ""}
                    onChange={(e) => form.setValue("email", e.target.value)}
                    error={form.fieldError("email")}
                  />
                  {mode !== "forgot" && (
                    <TextInput
                      label="Password" type="password" required
                      value={form.values.password ?? ""}
                      onChange={(e) => form.setValue("password", e.target.value)}
                      error={form.fieldError("password")}
                    />
                  )}
                  {mode === "signup" && (
                    <TextInput
                      label="Name (optional)"
                      value={form.values.name ?? ""}
                      onChange={(e) => form.setValue("name", e.target.value)}
                      error={form.fieldError("name")}
                    />
                  )}
                  {turnstileSiteKey !== null && (
                    <TurnstileWidget
                      ref={turnstileRef}
                      siteKey={turnstileSiteKey}
                    />
                  )}
                  <Stack direction="row" gap="condensed" align="center">
                    <Button type="submit" variant="primary" disabled={busy}>
                      {mode === "login" ? "Sign in"
                        : mode === "signup" ? "Create account"
                        : "Send reset link"}
                    </Button>
                    {mode === "login" && (
                      <Link muted href="#" onClick={(e) => { e.preventDefault(); switchMode("forgot"); }}>
                        Forgot password?
                      </Link>
                    )}
                    {mode === "forgot" && (
                      <Link muted href="#" onClick={(e) => { e.preventDefault(); switchMode("login"); }}>
                        Back to sign in
                      </Link>
                    )}
                    {mode !== "forgot" && signupEnabled !== false && (
                      <Text muted>
                        {mode === "login" ? "No account?" : "Already have one?"}{" "}
                        <Link
                          href="#"
                          onClick={(e) => {
                            e.preventDefault();
                            switchMode(mode === "login" ? "signup" : "login");
                          }}
                        >
                          {mode === "login" ? "Sign up" : "Sign in"}
                        </Link>
                      </Text>
                    )}
                    {mode === "login" && signupEnabled === false && (
                      <Text muted>Signup is disabled on this instance.</Text>
                    )}
                  </Stack>
                  {mode === "login" && (
                    <Text muted>
                      Joining a conference as a participant? Conferences have their
                      own sign-in - open your invitation or join link, or the
                      conference&apos;s sign-in page. This page is for organizer
                      accounts (people who run conferences).
                    </Text>
                  )}
                </Form>
              )}
            </Card>
          </div>
        </div>
      </div>
    </PageLayout>
  );
}

function humanError(code: string): string {
  return {
    invalid_credentials: "Wrong email or password for an organizer account. Conference passwords don't work here - each conference has its own sign-in.",
    email_taken: "Email is already registered.",
    signup_disabled: "Signup is disabled on this instance.",
    account_locked: "Too many failed attempts. Try again in a few minutes.",
    captcha_required: "Please complete the verification challenge.",
    captcha_failed: "Verification failed. Refresh and try again.",
    rate_limited: "You're doing that too fast. Slow down and try again shortly.",
  }[code] ?? code;
}
