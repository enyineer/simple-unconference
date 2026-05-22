// Anonymous join page. Reached via two flavors of URL:
//   /c/<slug>/join?t=<inviteToken>   -- moderator-issued invite for one email
//   /c/<slug>/join?t=<joinLinkToken> -- shared self-signup token, owner-managed
//
// We decide which mode we're in by calling `previewInvite` first. If it
// resolves, the token is an invite and the email is locked. Otherwise we
// fall through to the join-link signup form and let the participant supply
// their own email.

import { useEffect, useRef, useState } from "react";
import {
  Banner, Button, Card, Form, Heading, Link, PageLayout, Spinner, Stack, Text, TextInput,
} from "../design-system";
import { useToast } from "../design-system/hooks";
import { api, errorCode, errorFields } from "../api";
import { useForm } from "../useForm";
import { InviteClaimSchema, SignupViaLinkSchema, safeParse } from "../../shared/schemas";
import { TurnstileWidget, type TurnstileWidgetHandle } from "../components/TurnstileWidget";
import { quotaErrorMessage } from "../quotaErrors";

type Mode =
  | { kind: "loading" }
  | { kind: "invite"; email: string; conferenceName: string; expiresAt: number }
  | { kind: "join_link"; conferenceName: string | null }
  | { kind: "error"; reason: string };

function readToken(): string | null {
  const hash = window.location.hash;
  const qIdx = hash.indexOf("?");
  if (qIdx === -1) return null;
  const params = new URLSearchParams(hash.slice(qIdx + 1));
  return params.get("t");
}

export function JoinPage({
  slug, onJoined, onCancel,
}: {
  slug: string;
  onJoined: () => void;
  onCancel: () => void;
}) {
  const token = readToken();
  const [mode, setMode] = useState<Mode>(() =>
    token ? { kind: "loading" } : { kind: "error", reason: "missing_token" },
  );
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  // Only required for the join_link flow (open-link signup). Invite claims
  // are gated by the invite token itself, so we leave them un-Turnstile'd
  // to avoid friction-blocking legitimate invitees.
  const [turnstileSiteKey, setTurnstileSiteKey] = useState<string | null>(null);
  const turnstileRef = useRef<TurnstileWidgetHandle | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.config.get()
      .then((c) => { if (!cancelled) setTurnstileSiteKey(c.turnstile_site_key); })
      .catch(() => { /* leave null — server will reject if it ends up enforcing */ });
    return () => { cancelled = true; };
  }, []);

  // Both flows share the same field set; the invite flow locks the email.
  const form = useForm(SignupViaLinkSchema, {
    token: token ?? "",
    email: "",
    password: "",
    name: "",
  });

  useEffect(() => {
    if (!token) return;
    api.conferences.previewInvite({ slug, token })
      .then((preview) => {
        form.setValue("email", preview.email);
        setMode({
          kind: "invite",
          email: preview.email,
          conferenceName: preview.conference_name,
          expiresAt: preview.expires_at,
        });
      })
      .catch((e) => {
        const code = errorCode(e);
        // NOT_FOUND or invalid_invite -> treat the token as a join link
        // candidate and let the participant supply their own email.
        if (code === "NOT_FOUND" || code === "invalid_invite") {
          setMode({ kind: "join_link", conferenceName: null });
        } else if (code === "already_claimed" || code === "expired") {
          setMode({ kind: "error", reason: code });
        } else {
          setMode({ kind: "join_link", conferenceName: null });
        }
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, token]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!token) return;

    // Read straight from the widget at submit time — avoids any race between
    // Cloudflare's callback and React state.
    const turnstileToken = turnstileSiteKey !== null
      ? (turnstileRef.current?.getResponse() ?? "")
      : "";

    if (mode.kind === "invite") {
      if (turnstileSiteKey !== null && turnstileToken === "") {
        toast.error("Please complete the verification challenge before continuing.");
        return;
      }
      const r = safeParse(InviteClaimSchema, {
        token,
        password: form.values.password,
        name: form.values.name,
        turnstile_token: turnstileToken || undefined,
      });
      if (!r.ok) { form.setErrors(r.errors); return; }
      setBusy(true);
      try {
        await api.conferences.claimInvite({ slug, ...r.data });
        onJoined();
      } catch (err) {
        const fields = errorFields(err);
        if (fields) form.setErrors(fields);
        else toast.error(quotaErrorMessage(err) ?? humanError(errorCode(err)));
        turnstileRef.current?.reset();
      } finally { setBusy(false); }
      return;
    }

    if (mode.kind === "join_link") {
      if (turnstileSiteKey !== null && turnstileToken === "") {
        toast.error("Please complete the verification challenge before continuing.");
        return;
      }
      const r = safeParse(SignupViaLinkSchema, {
        ...form.values,
        turnstile_token: turnstileToken || undefined,
      });
      if (!r.ok) { form.setErrors(r.errors); return; }
      setBusy(true);
      try {
        await api.conferences.signupViaLink({ slug, ...r.data });
        onJoined();
      } catch (err) {
        const fields = errorFields(err);
        if (fields) form.setErrors(fields);
        else toast.error(quotaErrorMessage(err) ?? humanError(errorCode(err)));
        // Turnstile tokens are single-use; reset so the widget mints a fresh
        // one for the retry.
        turnstileRef.current?.reset();
      } finally { setBusy(false); }
    }
  }

  if (mode.kind === "loading") {
    return <PageLayout><Spinner label="Loading invitation…" /></PageLayout>;
  }

  if (mode.kind === "error") {
    return (
      <PageLayout>
        <Stack gap="spacious">
          <Heading level={1}>Join conference</Heading>
          <Card title="This link can't be used">
            <Banner variant="critical">{humanError(mode.reason)}</Banner>
            <div style={{ marginTop: 12 }}>
              <Link href="#" onClick={(e) => { e.preventDefault(); onCancel(); }}>
                Back to your conferences
              </Link>
            </div>
          </Card>
        </Stack>
      </PageLayout>
    );
  }

  const isInvite = mode.kind === "invite";
  const title = isInvite
    ? `Join ${mode.conferenceName}`
    : "Join conference";

  return (
    <PageLayout>
      <Stack gap="spacious">
        <Heading level={1}>{title}</Heading>

        <Card title={isInvite ? "Claim your invite" : "Create your account"}>
          {isInvite && (
            <Text muted>
              You were invited as <strong>{mode.email}</strong>. Pick a password to claim it.
            </Text>
          )}
          {!isInvite && (
            <Text muted>
              Your identity is scoped to this conference only. It won&apos;t be visible in any other.
            </Text>
          )}
          <Form onSubmit={submit}>
            <TextInput
              label="Email"
              type="email"
              required
              disabled={isInvite}
              value={form.values.email ?? ""}
              onChange={(e) => form.setValue("email", e.target.value)}
              error={form.fieldError("email")}
            />
            <TextInput
              label="Name (optional)"
              value={form.values.name ?? ""}
              onChange={(e) => form.setValue("name", e.target.value)}
              error={form.fieldError("name")}
            />
            <TextInput
              label="Password"
              type="password"
              required
              value={form.values.password ?? ""}
              onChange={(e) => form.setValue("password", e.target.value)}
              error={form.fieldError("password")}
            />
            {turnstileSiteKey !== null && (
              <TurnstileWidget
                ref={turnstileRef}
                siteKey={turnstileSiteKey}
              />
            )}
            <Stack direction="row" gap="condensed" align="center">
              <Button type="submit" variant="primary" disabled={busy}>
                {isInvite ? "Join conference" : "Sign up"}
              </Button>
              <Link href="#" onClick={(e) => { e.preventDefault(); onCancel(); }}>
                Cancel
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
    missing_token: "This URL doesn't include a token. Ask the organizer for a fresh invite link.",
    invalid_invite: "This invite is no longer valid.",
    invalid_join_link: "This join link is no longer valid.",
    already_claimed: "This invite has already been used.",
    expired: "This invite has expired. Ask the organizer to send a new one.",
    join_link_expired: "This join link has expired.",
    join_link_exhausted: "This join link is no longer accepting new sign-ups.",
    email_already_in_conference: "An account with that email already exists in this conference. Try signing in instead.",
    conference_not_found: "We couldn't find that conference.",
    captcha_required: "Please complete the verification challenge.",
    captcha_failed: "Verification failed. Refresh and try again.",
    quota_exceeded: "This conference has reached its participant limit. Contact the organizer.",
  } as Record<string, string>)[code] ?? code;
}
