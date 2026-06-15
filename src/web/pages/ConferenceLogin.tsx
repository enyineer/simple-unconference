// Per-conference identity login. Reached when a participant lands on
// /c/<slug>/login (either by typing the URL or because they tried to open
// /conferences/<slug> without a valid identity cookie).
//
// This is *not* the same as the global owner login at /. An identity is
// scoped to one conference and its cookie name is uncon_session_<confId>.

import { useEffect, useRef, useState } from "react";
import {
  Button, Card, Form, Heading, Link, PageLayout, Stack, Text, TextInput,
} from "../design-system";
import { useToast } from "../design-system/hooks";
import { api, errorCode, errorFields } from "../api";
import { useForm } from "../useForm";
import {
  ConfLoginSchema, RequestPasswordResetSchema, safeParse,
} from "../../shared/schemas";
import { TurnstileWidget, type TurnstileWidgetHandle } from "../components/TurnstileWidget";

export function ConferenceLoginPage({
  slug, onLoggedIn, onCancel,
}: {
  slug: string;
  onLoggedIn: () => void;
  onCancel: () => void;
}) {
  const toast = useToast();
  const [mode, setMode] = useState<"login" | "forgot">("login");
  const [busy, setBusy] = useState(false);
  const [resetSent, setResetSent] = useState(false);
  const [turnstileSiteKey, setTurnstileSiteKey] = useState<string | null>(null);
  const turnstileRef = useRef<TurnstileWidgetHandle | null>(null);
  const form = useForm(ConfLoginSchema, { email: "", password: "" });
  // 5c: when a verified global account is already signed in and this
  // conference has an unlinked identity matching its email, offer one-click
  // linking instead of a fresh per-conference login. null = still checking.
  const [accountEmail, setAccountEmail] = useState<string | null>(null);
  const [linkable, setLinkable] = useState<boolean | null>(null);
  const [showPasswordLogin, setShowPasswordLogin] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api.config.get()
      .then((c) => { if (!cancelled) setTurnstileSiteKey(c.turnstile_site_key); })
      .catch(() => { /* no widget on config failure; server still enforces */ });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    // Logged in globally + verified? Does this conference show up as linkable?
    // Any failure (not logged in, unverified, no email transport) just falls
    // back to the normal login form.
    (async () => {
      try {
        const me = await api.auth.me();
        const discoverable = await api.account.discoverLinkable();
        if (cancelled) return;
        setAccountEmail(me.email);
        setLinkable(discoverable.some((c) => c.slug === slug));
      } catch {
        if (!cancelled) setLinkable(false);
      }
    })();
    return () => { cancelled = true; };
  }, [slug]);

  async function linkSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api.account.linkConferenceIdentity({ slug, password: form.values.password ?? "" });
      onLoggedIn();
    } catch (err) {
      const code = errorCode(err);
      if (code === "invalid_credentials") {
        form.setErrors({ password: "That password doesn't match. Your account is safe either way." });
      } else {
        toast.error(humanError(code));
      }
    } finally {
      setBusy(false);
    }
  }

  function switchMode(next: "login" | "forgot") {
    setMode(next);
    setResetSent(false);
    form.setErrors({});
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();

    if (mode === "forgot") {
      const turnstileToken = turnstileSiteKey !== null
        ? (turnstileRef.current?.getResponse() ?? "")
        : "";
      if (turnstileSiteKey !== null && turnstileToken === "") {
        toast.error("Please complete the verification challenge before continuing.");
        return;
      }
      const r = safeParse(RequestPasswordResetSchema, {
        email: form.values.email, turnstile_token: turnstileToken || undefined,
      });
      if (!r.ok) { form.setErrors(r.errors); return; }
      setBusy(true);
      try {
        await api.conferences.requestPasswordReset({ slug, ...r.data });
        setResetSent(true);
      } catch (err) {
        toast.error(humanError(errorCode(err)));
        turnstileRef.current?.reset();
      } finally {
        setBusy(false);
      }
      return;
    }

    const r = safeParse(ConfLoginSchema, form.values);
    if (!r.ok) { form.setErrors(r.errors); return; }
    setBusy(true);
    try {
      await api.conferences.login({ slug, ...r.data });
      onLoggedIn();
    } catch (err) {
      const fields = errorFields(err);
      if (fields) form.setErrors(fields);
      else toast.error(humanError(errorCode(err)));
    } finally {
      setBusy(false);
    }
  }

  return (
    <PageLayout>
      <Stack gap="spacious">
        <Heading level={1}>
          {mode === "login" ? "Sign in to this conference" : "Reset your password"}
        </Heading>

        <Card title={mode === "login" ? "Sign in" : "Forgot password"}>
          {mode === "login" && linkable && !showPasswordLogin ? (
            <Stack gap="normal">
              <Text muted>
                You&apos;re signed in as <strong>{accountEmail}</strong>. Add this
                conference to your account so you can open it with this login.
              </Text>
              <Form onSubmit={linkSubmit}>
                <TextInput
                  label="Your password for this conference" type="password" required
                  value={form.values.password ?? ""}
                  onChange={(e) => form.setValue("password", e.target.value)}
                  error={form.fieldError("password")}
                />
                <Stack gap="condensed">
                  <Stack direction="row" gap="condensed" align="center">
                    <Button type="submit" variant="primary" disabled={busy}>
                      Add to my account
                    </Button>
                    <Link muted href="#" onClick={(e) => { e.preventDefault(); onCancel(); }}>
                      Back
                    </Link>
                  </Stack>
                  <Link muted href="#" onClick={(e) => { e.preventDefault(); setShowPasswordLogin(true); }}>
                    Sign in with this conference&apos;s password instead
                  </Link>
                </Stack>
              </Form>
            </Stack>
          ) : mode === "forgot" && resetSent ? (
            <Stack gap="normal">
              <Text muted>
                If an account exists for that email in this conference, we&apos;ve
                sent a link to reset your password. Check your inbox (and spam
                folder) - the link expires shortly.
              </Text>
              <Stack direction="row" gap="condensed" align="center">
                <Button variant="primary" onClick={() => switchMode("login")}>
                  Back to sign in
                </Button>
              </Stack>
            </Stack>
          ) : (
            <>
              <Text muted>
                {mode === "login"
                  ? "Use the email + password you set when you joined this conference. Other conferences use separate accounts."
                  : "Enter the email you joined this conference with and we'll send you a link to choose a new password."}
              </Text>
              <Form onSubmit={submit}>
                <TextInput
                  label="Email" type="email" required
                  value={form.values.email ?? ""}
                  onChange={(e) => form.setValue("email", e.target.value)}
                  error={form.fieldError("email")}
                />
                {mode === "login" && (
                  <TextInput
                    label="Password" type="password" required
                    value={form.values.password ?? ""}
                    onChange={(e) => form.setValue("password", e.target.value)}
                    error={form.fieldError("password")}
                  />
                )}
                {mode === "forgot" && turnstileSiteKey !== null && (
                  <TurnstileWidget ref={turnstileRef} siteKey={turnstileSiteKey} />
                )}
                <Stack direction="row" gap="condensed" align="center">
                  <Button type="submit" variant="primary" disabled={busy}>
                    {mode === "login" ? "Sign in" : "Send reset link"}
                  </Button>
                  {mode === "login" ? (
                    <Link muted href="#" onClick={(e) => { e.preventDefault(); switchMode("forgot"); }}>
                      Forgot password?
                    </Link>
                  ) : (
                    <Link muted href="#" onClick={(e) => { e.preventDefault(); switchMode("login"); }}>
                      Back to sign in
                    </Link>
                  )}
                  <Link muted href="#" onClick={(e) => { e.preventDefault(); onCancel(); }}>
                    Back
                  </Link>
                </Stack>
              </Form>
            </>
          )}
        </Card>
      </Stack>
    </PageLayout>
  );
}

function humanError(code: string): string {
  return ({
    invalid_credentials: "Wrong email or password.",
    conference_not_found: "We couldn't find that conference.",
    captcha_required: "Please complete the verification challenge.",
    captcha_failed: "Verification failed. Refresh and try again.",
    rate_limited: "You're doing that too fast. Slow down and try again shortly.",
  } as Record<string, string>)[code] ?? code;
}
