// Email-verification UI (account-linking Phase 5).
//
//  - VerifyEmailWall: the "verify before entering" screen shown to a logged-in
//    but unverified owner. Numeric code (auto-submits at 6 digits, OS
//    one-time-code autofill), resend with a live 30s cooldown matching the
//    server throttle, inline errors. Nothing else in the owner area is
//    reachable until this passes.
//  - VerifyEmailTokenPage: handles the magic-link route (#/auth/verify?token=).
//    Confirms on mount and drops the caller into the app; works in any browser.

import { useEffect, useState } from "react";
import {
  PageLayout, Card, Stack, Text, TextInput, Button, Heading, Link, Form, Spinner,
} from "../design-system";
import { useToast } from "../design-system/hooks";
import { api, errorCode } from "../api";

const RESEND_COOLDOWN_S = 30;

function humanError(code: string): string {
  return ({
    invalid_code: "That code isn't right. Check the email and try again.",
    code_expired: "That code has expired. Send yourself a new one.",
    code_attempts_exceeded: "Too many tries. Send yourself a new code below.",
    invalid_or_expired_token: "This confirmation link is invalid or has expired.",
    rate_limited: "Please wait a moment before requesting another email.",
  } as Record<string, string>)[code] ?? "Something went wrong. Please try again.";
}

export function VerifyEmailWall({
  email, onVerified, onLogout,
}: {
  email: string;
  onVerified: () => void;
  onLogout: () => void;
}) {
  const toast = useToast();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [resending, setResending] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const [error, setError] = useState<string | undefined>();

  // Tick the resend cooldown down to zero.
  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  async function confirm(value: string) {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await api.auth.verifyEmail({ code: value });
      toast.success("Email confirmed.");
      onVerified();
    } catch (err) {
      setError(humanError(errorCode(err)));
      setCode("");
    } finally {
      setBusy(false);
    }
  }

  function onCodeChange(raw: string) {
    const next = raw.replace(/\D/g, "").slice(0, 6);
    setCode(next);
    setError(undefined);
    // Auto-submit once the full code is entered (matches OTP UX).
    if (next.length === 6) void confirm(next);
  }

  async function resend() {
    setResending(true);
    setError(undefined);
    try {
      await api.auth.resendVerification();
      toast.success("Sent a fresh code to your email.");
      setCooldown(RESEND_COOLDOWN_S);
    } catch (err) {
      const c = errorCode(err);
      // The server's 30s cooldown — reflect it in the button instead of an error.
      if (c === "rate_limited") setCooldown(RESEND_COOLDOWN_S);
      else toast.error(humanError(c));
    } finally {
      setResending(false);
    }
  }

  return (
    <PageLayout>
      <Stack gap="spacious">
        <Heading level={1}>Confirm your email</Heading>
        <Card title="Check your inbox to continue">
          <Stack gap="normal">
            <Text muted>
              We sent a confirmation to <strong>{email}</strong>. Enter the
              6-digit code below, or just click the link in that email.
            </Text>
            <Form onSubmit={(e) => { e.preventDefault(); if (code.length === 6) void confirm(code); }}>
              <TextInput
                label="6-digit code"
                placeholder="123456"
                inputMode="numeric"
                autoComplete="one-time-code"
                autoFocus
                value={code}
                onChange={(e) => onCodeChange(e.target.value)}
                error={error}
                required
              />
              <Stack gap="condensed">
                <Stack direction="row" gap="condensed" align="center" wrap>
                  <Button type="submit" variant="primary" disabled={busy || code.length !== 6}>
                    Confirm
                  </Button>
                  <Button onClick={resend} disabled={resending || cooldown > 0}>
                    {cooldown > 0 ? `Resend in ${cooldown}s` : "Resend email"}
                  </Button>
                </Stack>
                <Link muted href="#" onClick={(e) => { e.preventDefault(); onLogout(); }}>
                  Sign out
                </Link>
              </Stack>
            </Form>
          </Stack>
        </Card>
      </Stack>
    </PageLayout>
  );
}

export function VerifyEmailTokenPage({
  token, onDone,
}: {
  token: string;
  onDone: () => void;
}) {
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api.auth.verifyEmailByToken({ token })
      .then(() => { if (!cancelled) onDone(); })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
    // onDone is stable enough for this one-shot confirm; token drives it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  if (failed) {
    return (
      <PageLayout>
        <Stack gap="spacious">
          <Heading level={1}>Confirmation link</Heading>
          <Card title="Couldn't confirm with this link">
            <Stack gap="normal">
              <Text muted>
                This link has already been used or has expired. If you already
                confirmed your email, just sign in.
              </Text>
              <div>
                <Button variant="primary" onClick={onDone}>Go to sign in</Button>
              </div>
            </Stack>
          </Card>
        </Stack>
      </PageLayout>
    );
  }
  return (
    <PageLayout>
      <Spinner label="Confirming your email…" />
    </PageLayout>
  );
}
