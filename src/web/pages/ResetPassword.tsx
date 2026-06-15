// Password-reset landing page. Reached from the link in a reset email:
//   - global owner:        #/auth/reset?token=...
//   - conference identity: #/c/<slug>/reset?token=...
//
// `scope` selects which RPC pair to call. On success the server logs the
// caller in (sets the session cookie) and returns the fresh identity, so we
// just navigate into the app.

import { useEffect, useRef, useState } from "react";
import {
  Button, Card, Form, Heading, Link, PageLayout, Stack, Text, TextInput,
} from "../design-system";
import { useToast } from "../design-system/hooks";
import { api, errorCode, errorFields } from "../api";
import { ResetPasswordSchema, safeParse } from "../../shared/schemas";
import { TurnstileWidget, type TurnstileWidgetHandle } from "../components/TurnstileWidget";

export type ResetScope = { kind: "owner" } | { kind: "conference"; slug: string };

export function ResetPasswordPage({
  scope, token, onDone, onCancel,
}: {
  scope: ResetScope;
  token: string;
  onDone: () => void;
  onCancel: () => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [errors, setErrors] = useState<{ password?: string; confirm?: string }>({});
  const [turnstileSiteKey, setTurnstileSiteKey] = useState<string | null>(null);
  const turnstileRef = useRef<TurnstileWidgetHandle | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.config.get()
      .then((c) => { if (!cancelled) setTurnstileSiteKey(c.turnstile_site_key); })
      .catch(() => { /* no widget on config failure; server still enforces */ });
    return () => { cancelled = true; };
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (password !== confirm) {
      setErrors({ confirm: "Passwords don't match." });
      return;
    }

    const turnstileToken = turnstileSiteKey !== null
      ? (turnstileRef.current?.getResponse() ?? "")
      : "";
    if (turnstileSiteKey !== null && turnstileToken === "") {
      toast.error("Please complete the verification challenge before continuing.");
      return;
    }

    const parsed = safeParse(ResetPasswordSchema, {
      token, password, turnstile_token: turnstileToken || undefined,
    });
    if (!parsed.ok) {
      // Field errors come back keyed by schema path (token / password).
      setErrors({ password: parsed.errors.password });
      if (parsed.errors.token) toast.error(parsed.errors.token);
      return;
    }

    setBusy(true);
    try {
      if (scope.kind === "owner") {
        await api.auth.resetPassword(parsed.data);
      } else {
        await api.conferences.resetPassword({ slug: scope.slug, ...parsed.data });
      }
      toast.success("Password updated. You're signed in.");
      onDone();
    } catch (err) {
      const fields = errorFields(err);
      if (fields) setErrors({ password: fields.password });
      else toast.error(humanError(errorCode(err)));
      turnstileRef.current?.reset();
    } finally {
      setBusy(false);
    }
  }

  return (
    <PageLayout>
      <Stack gap="spacious">
        <Heading level={1}>Choose a new password</Heading>
        <Card title="Reset password">
          <Text muted>
            Enter a new password for your account. This link can only be used once.
          </Text>
          <Form onSubmit={submit}>
            <TextInput
              label="New password" type="password" required
              value={password}
              onChange={(e) => { setPassword(e.target.value); setErrors({}); }}
              error={errors.password}
            />
            <TextInput
              label="Confirm new password" type="password" required
              value={confirm}
              onChange={(e) => { setConfirm(e.target.value); setErrors({}); }}
              error={errors.confirm}
            />
            {turnstileSiteKey !== null && (
              <TurnstileWidget ref={turnstileRef} siteKey={turnstileSiteKey} />
            )}
            <Stack direction="row" gap="condensed" align="center">
              <Button type="submit" variant="primary" disabled={busy}>
                Update password
              </Button>
              <Link muted href="#" onClick={(e) => { e.preventDefault(); onCancel(); }}>
                Back to sign in
              </Link>
            </Stack>
          </Form>
        </Card>
      </Stack>
    </PageLayout>
  );
}

function humanError(code: string): string {
  return ({
    invalid_or_expired_token: "This reset link is invalid or has expired. Request a new one.",
    conference_not_found: "We couldn't find that conference.",
    captcha_required: "Please complete the verification challenge.",
    captcha_failed: "Verification failed. Refresh and try again.",
    rate_limited: "You're doing that too fast. Slow down and try again shortly.",
  } as Record<string, string>)[code] ?? code;
}
