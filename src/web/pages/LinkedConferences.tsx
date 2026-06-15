// Account-linking dashboard section (account-linking Phase 5, auto-suggest UI).
//
// Two lists, both self-scoped:
//   - "Conferences on your account": identities already linked to this global
//     account; opening one resolves via the global cookie (no extra login).
//   - "We found you in": conferences with an account matching the user's email
//     that aren't linked yet. One-click "Add to my account" asks for that
//     conference's password once (proof of control), then links it.
//
// Rendered only when the instance has email configured (linking is gated on a
// verified email). Renders nothing while loading or when both lists are empty,
// so it stays invisible for users it doesn't apply to.

import { useEffect, useState } from "react";
import {
  Stack, Heading, Button, Text, Sheet, Form, TextInput,
} from "../design-system";
import { useToast } from "../design-system/hooks";
import { api, errorCode, errorFields } from "../api";

interface Linkable {
  slug: string;
  name: string;
  role: "owner" | "moderator" | "participant";
}

const ROW_STYLE: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  gap: 12,
  padding: "12px 16px",
  borderRadius: 10,
  border: "1px solid var(--borderColor-muted, var(--uncon-border-muted, #e5e7eb))",
  background: "var(--bgColor-default, var(--uncon-bg, transparent))",
};

export function LinkedConferencesSection({ onOpen }: { onOpen: (slug: string) => void }) {
  const toast = useToast();
  const [linked, setLinked] = useState<Linkable[] | null>(null);
  const [discoverable, setDiscoverable] = useState<Linkable[]>([]);
  const [linkTarget, setLinkTarget] = useState<Linkable | null>(null);

  async function load() {
    try {
      const [l, d] = await Promise.all([
        api.account.listLinked(),
        api.account.discoverLinkable(),
      ]);
      setLinked(l);
      setDiscoverable(d);
    } catch {
      setLinked([]);
      setDiscoverable([]);
    }
  }

  useEffect(() => {
    let cancelled = false;
    Promise.all([api.account.listLinked(), api.account.discoverLinkable()])
      .then(([l, d]) => { if (!cancelled) { setLinked(l); setDiscoverable(d); } })
      .catch(() => { if (!cancelled) { setLinked([]); setDiscoverable([]); } });
    return () => { cancelled = true; };
  }, []);

  async function remove(slug: string) {
    try {
      await api.account.unlinkConferenceIdentity({ slug });
      await load();
      toast.success("Removed from your account. You can still sign in to it directly.");
    } catch (err) {
      toast.error(errorCode(err));
    }
  }

  // Quiet while loading or when there's nothing to show.
  if (linked === null) return null;
  if (linked.length === 0 && discoverable.length === 0) return null;

  const muted = "var(--fgColor-muted, var(--uncon-fg-muted, #6e7781))";

  return (
    <Stack gap="condensed">
      {linked.length > 0 && (
        <>
          <Heading level={2}>Conferences on your account</Heading>
          {linked.map((c) => (
            <div key={c.slug} style={ROW_STYLE}>
              <span style={{ fontSize: 15, fontWeight: 600 }}>{c.name}</span>
              <Stack direction="row" gap="condensed" align="center">
                <Button variant="primary" onClick={() => onOpen(c.slug)}>Open</Button>
                <Button onClick={() => remove(c.slug)}>Remove</Button>
              </Stack>
            </div>
          ))}
        </>
      )}

      {discoverable.length > 0 && (
        <>
          <Heading level={2}>Conferences you can add</Heading>
          <Text>
            <span style={{ color: muted, fontSize: 13 }}>
              We recognized your email in these conferences. Add one to open it
              with this login.
            </span>
          </Text>
          {discoverable.map((c) => (
            <div key={c.slug} style={ROW_STYLE}>
              <span style={{ fontSize: 15, fontWeight: 600 }}>{c.name}</span>
              <Button variant="primary" onClick={() => setLinkTarget(c)}>
                Add to my account
              </Button>
            </div>
          ))}
        </>
      )}

      <Sheet
        open={linkTarget !== null}
        onClose={() => setLinkTarget(null)}
        title={linkTarget ? `Add "${linkTarget.name}" to your account` : ""}
      >
        {linkTarget && (
          <LinkForm
            conf={linkTarget}
            onCancel={() => setLinkTarget(null)}
            onLinked={async () => {
              setLinkTarget(null);
              await load();
              toast.success("Added to your account.");
            }}
          />
        )}
      </Sheet>
    </Stack>
  );
}

function LinkForm({
  conf, onCancel, onLinked,
}: {
  conf: Linkable;
  onCancel: () => void;
  onLinked: () => void | Promise<void>;
}) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await api.account.linkConferenceIdentity({ slug: conf.slug, password });
      await onLinked();
    } catch (err) {
      const fields = errorFields(err);
      if (fields?.password) setError(fields.password);
      else {
        const code = errorCode(err);
        setError(
          code === "invalid_credentials"
            ? "That password doesn't match. Your account is safe either way."
            : code === "already_linked"
              ? "That conference is already linked to another account."
              : "Something went wrong. Please try again.",
        );
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Stack gap="condensed">
      <Text>
        <span style={{ fontSize: 13 }}>
          Enter your password for <strong>{conf.name}</strong> (the one you set
          when you joined it).
        </span>
      </Text>
      <Form onSubmit={submit}>
        <TextInput
          label="Conference password"
          type="password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          error={error}
        />
        <Stack direction="row" gap="condensed">
          <Button type="submit" variant="primary" disabled={busy || !password}>
            Add
          </Button>
          <Button onClick={onCancel} disabled={busy}>Cancel</Button>
        </Stack>
      </Form>
    </Stack>
  );
}
