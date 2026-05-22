import { useCallback, useEffect, useState } from "react";
import {
  Badge, Button, Form, Heading, Sheet, Spinner, Stack, TextInput, Textarea, Text,
} from "../../design-system";
import { useToast } from "../../design-system/hooks";
import { api, errorCode } from "../../api";
import { quotaErrorMessage } from "../../quotaErrors";
import type { Participant, Role } from "../types";
import { EmptyState } from "../ui/EmptyState";
import { Tip } from "../ui/Tip";
import { useNow } from "../../useNow";

interface PendingInvite {
  id: number;
  email: string;
  token: string;
  url: string;
  role: "moderator" | "participant";
  created_at: number;
  expires_at: number;
  claimed_at: number | null;
}

function absoluteUrl(relative: string): string {
  // The router is hash-based, so paths live after the `#`. Combine with
  // origin so moderators can paste the URL into email/Slack and the
  // recipient lands on the right page.
  return `${window.location.origin}/#${relative}`;
}

export function PeopleTab({ slug, role }: { slug: string; role: Role }) {
  const isMod = role === "owner" || role === "moderator";
  const isOwner = role === "owner";

  const [people, setPeople] = useState<Participant[] | null>(null);
  const [invites, setInvites] = useState<PendingInvite[] | null>(null);

  const [inviteSheetOpen, setInviteSheetOpen] = useState(false);
  const [singleEmail, setSingleEmail] = useState("");
  const [bulkCsv, setBulkCsv] = useState("");
  const toast = useToast();

  const fetchAll = useCallback(() => Promise.all([
    api.conferences.listParticipants({ slug }),
    api.conferences.listInvites({ slug }).catch(() => [] as PendingInvite[]),
  ]), [slug]);
  async function refresh() {
    const [pp, inv] = await fetchAll();
    setPeople(pp);
    setInvites(inv);
  }
  useEffect(() => {
    let cancelled = false;
    fetchAll()
      .then(([pp, inv]) => {
        if (cancelled) return;
        setPeople(pp); setInvites(inv);
      })
      .catch(() => { if (!cancelled) setPeople([]); });
    return () => { cancelled = true; };
  }, [fetchAll]);

  function resetInviteSheet() {
    setSingleEmail("");
    setBulkCsv("");
  }

  async function sendSingleInvite(e: React.FormEvent) {
    e.preventDefault();
    if (!singleEmail.trim()) return;
    try {
      const inv = await api.conferences.createInvite({ slug, email: singleEmail.trim() });
      toast.success(`Invite link ready for ${inv.email}. Copy it from "Pending invites" below.`);
      setSingleEmail("");
      await refresh();
    } catch (e) {
      toast.error(quotaErrorMessage(e) ?? humanInviteError(errorCode(e)));
    }
  }

  async function sendBulkInvites() {
    if (!bulkCsv.trim()) return;
    try {
      const result = await api.conferences.importInvites({ slug, csv: bulkCsv });
      const msgs: string[] = [`Added ${result.added}.`];
      if (result.skipped > 0) msgs.push(`Skipped ${result.skipped}.`);
      toast.success(msgs.join(" "));
      setBulkCsv("");
      await refresh();
    } catch (e) {
      toast.error(quotaErrorMessage(e) ?? humanInviteError(errorCode(e)));
    }
  }

  async function copyInviteLink(invite: PendingInvite) {
    const url = absoluteUrl(invite.url);
    try { await navigator.clipboard.writeText(url); }
    catch { /* clipboard blocked — fall back to selection prompt */
      window.prompt("Copy this invite link:", url);
    }
  }

  async function revokeInvite(id: number) {
    if (!confirm("Revoke this invite? The link will stop working immediately.")) return;
    try { await api.conferences.revokeInvite({ slug, id }); }
    catch (e) { toast.error(errorCode(e)); }
    await refresh();
  }

  async function setRoleAction(userId: number, action: "promote" | "demote") {
    if (action === "promote") await api.conferences.addModerator({ slug, user_id: userId });
    else await api.conferences.removeModerator({ slug, user_id: userId });
    await refresh();
  }

  async function remove(userId: number) {
    if (!confirm("Remove this participant?")) return;
    try { await api.conferences.removeParticipant({ slug, user_id: userId }); }
    catch (e) { toast.error(errorCode(e)); }
    await refresh();
  }

  return (
    <Stack gap="spacious">
      <Stack direction="row" justify="between" align="center" wrap>
        <Heading level={2}>People</Heading>
        {isMod && (
          <Button
            variant="primary"
            onClick={() => { resetInviteSheet(); setInviteSheetOpen(true); }}
          >
            + Invite people
          </Button>
        )}
      </Stack>

      <Sheet open={inviteSheetOpen} onClose={() => setInviteSheetOpen(false)} title="Invite people">
        <Tip>
          We send an invite token, not a password. The recipient sets their own password
          when they click the link.
        </Tip>

        <Stack gap="spacious">
          <Form onSubmit={sendSingleInvite}>
            <TextInput
              label="Invite one email"
              type="email"
              placeholder="alice@example.com"
              value={singleEmail}
              onChange={(e) => setSingleEmail(e.target.value)}
            />
            <Stack direction="row" gap="condensed">
              <Button type="submit" variant="primary" disabled={!singleEmail.trim()}>
                Create invite
              </Button>
            </Stack>
          </Form>

          <Stack gap="condensed">
            <Text muted>Or invite many at once. One email per line.</Text>
            <Textarea
              label="Bulk invite"
              rows={6}
              value={bulkCsv}
              onChange={(e) => setBulkCsv(e.target.value)}
              placeholder={"alice@example.com\nbob@example.com"}
            />
            <Stack direction="row" gap="condensed">
              <Button onClick={sendBulkInvites} disabled={!bulkCsv.trim()}>
                Create invites
              </Button>
            </Stack>
          </Stack>
        </Stack>
      </Sheet>

      {!people ? (
        <Spinner label="Loading…" />
      ) : people.length === 0 ? (
        <EmptyState message="No members yet." />
      ) : (
        <Stack gap="condensed">
          {people.map((p) => (
            <MemberRow
              key={p.user_id}
              participant={p}
              isMod={isMod}
              isOwner={isOwner}
              onSetRole={(action) => setRoleAction(p.user_id, action)}
              onRemove={() => remove(p.user_id)}
            />
          ))}
        </Stack>
      )}

      {isMod && (
        <Stack gap="condensed">
          <Heading level={3}>Pending invites</Heading>
          {!invites ? (
            <Spinner label="Loading…" />
          ) : invites.filter((i) => i.claimed_at === null).length === 0 ? (
            <EmptyState message="No pending invites." />
          ) : (
            <Stack gap="condensed">
              {invites
                .filter((i) => i.claimed_at === null)
                .map((inv) => (
                  <InviteRow
                    key={inv.id}
                    invite={inv}
                    onCopy={() => copyInviteLink(inv)}
                    onRevoke={() => revokeInvite(inv.id)}
                  />
                ))}
            </Stack>
          )}
        </Stack>
      )}
    </Stack>
  );
}

function InviteRow({
  invite, onCopy, onRevoke,
}: {
  invite: PendingInvite;
  onCopy: () => void | Promise<void>;
  onRevoke: () => void | Promise<void>;
}) {
  const muted = "var(--fgColor-muted, var(--uncon-fg-muted, #6e7781))";
  const now = useNow();
  const expiresLabel = formatExpiry(invite.expires_at);
  const expired = invite.expires_at <= now;
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "1fr auto",
        gap: 12,
        alignItems: "center",
        padding: 12,
        borderRadius: 8,
        border: "1px solid var(--borderColor-muted, var(--uncon-border-muted, #e5e7eb))",
        background: "var(--bgColor-default, var(--uncon-bg, transparent))",
      }}
    >
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 15, fontWeight: 500, lineHeight: "20px" }}>{invite.email}</div>
        <div style={{ fontSize: 12, color: muted, marginTop: 2 }}>
          {expired ? "Expired" : `Expires ${expiresLabel}`} - {invite.role}
        </div>
      </div>
      <div style={{ display: "flex", gap: 6 }}>
        <Button size="small" onClick={onCopy} disabled={expired}>Copy link</Button>
        <Button size="small" variant="danger" onClick={onRevoke}>Revoke</Button>
      </div>
    </div>
  );
}

function formatExpiry(ms: number): string {
  const diff = ms - Date.now();
  if (diff <= 0) return "now";
  const days = Math.floor(diff / (24 * 60 * 60 * 1000));
  if (days >= 1) return `in ${days}d`;
  const hours = Math.floor(diff / (60 * 60 * 1000));
  if (hours >= 1) return `in ${hours}h`;
  const mins = Math.max(1, Math.floor(diff / (60 * 1000)));
  return `in ${mins}m`;
}

function humanInviteError(code: string): string {
  return ({
    email_already_in_conference: "That email is already in this conference.",
    validation: "Check the email address.",
  } as Record<string, string>)[code] ?? code;
}

function MemberRow({
  participant: p, isMod, isOwner, onSetRole, onRemove,
}: {
  participant: Participant;
  isMod: boolean;
  isOwner: boolean;
  onSetRole: (action: "promote" | "demote") => void;
  onRemove: () => void;
}) {
  const muted = "var(--fgColor-muted, var(--uncon-fg-muted, #6e7781))";
  const initial = (p.name ?? p.email).trim().charAt(0).toUpperCase() || "?";

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "auto 1fr auto",
        gap: 12,
        alignItems: "center",
        padding: 12,
        borderRadius: 8,
        border: "1px solid var(--borderColor-muted, var(--uncon-border-muted, #e5e7eb))",
        background: "var(--bgColor-default, var(--uncon-bg, transparent))",
      }}
    >
      <div
        aria-hidden
        style={{
          width: 36, height: 36, borderRadius: "50%",
          background: "var(--bgColor-muted, var(--uncon-bg-subtle, rgba(0,0,0,0.06)))",
          color: muted,
          display: "flex", alignItems: "center", justifyContent: "center",
          fontWeight: 600, fontSize: 14,
        }}
      >
        {initial}
      </div>

      <div style={{ minWidth: 0 }}>
        <div style={{
          fontSize: 15, fontWeight: 500, lineHeight: "20px",
          whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
        }}>
          {p.name || p.email}
        </div>
        {p.name && (
          <div style={{ fontSize: 12, color: muted, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {p.email}
          </div>
        )}
        <div style={{ marginTop: 4 }}>
          <Badge variant={p.role === "owner" ? "primary" : p.role === "moderator" ? "attention" : "default"}>
            {p.role}
          </Badge>
        </div>
      </div>

      <div style={{ display: "flex", gap: 6 }}>
        {isOwner && p.role === "participant" && (
          <Button size="small" onClick={() => onSetRole("promote")}>Make moderator</Button>
        )}
        {isOwner && p.role === "moderator" && (
          <Button size="small" onClick={() => onSetRole("demote")}>Revoke moderator</Button>
        )}
        {isMod && p.role !== "owner" && (
          <Button size="small" variant="danger" onClick={onRemove}>Remove</Button>
        )}
      </div>
    </div>
  );
}
