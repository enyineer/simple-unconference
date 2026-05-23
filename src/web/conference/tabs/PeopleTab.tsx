import { useState } from "react";
import {
  Badge, Button, Form, Heading, Sheet, Spinner, Stack, TextInput, Textarea, Text,
} from "../../design-system";
import { useToast } from "../../design-system/hooks";
import { api, errorCode } from "../../api";
import { quotaErrorMessage } from "../../quotaErrors";
import type { InviteOut, ParticipantOut } from "../../../shared/contract";
import type { Participant, Role } from "../types";
import { CopyButton } from "../ui/CopyButton";
import { EmptyState } from "../ui/EmptyState";
import { Pager } from "../ui/Pager";
import { Tip } from "../ui/Tip";
import { useNow } from "../../useNow";
import { usePaginatedList } from "../usePaginatedList";
import { ChatReportsSection } from "./people/ChatReportsSection";

type PendingInvite = InviteOut;

function absoluteUrl(relative: string): string {
  // The router is hash-based, so paths live after the `#`. Combine with
  // origin so moderators can paste the URL into email/Slack and the
  // recipient lands on the right page.
  return `${window.location.origin}/#${relative}`;
}

export function PeopleTab({ slug, role }: { slug: string; role: Role }) {
  const isMod = role === "owner" || role === "moderator";
  const isOwner = role === "owner";
  const toast = useToast();

  const people = usePaginatedList<ParticipantOut>(
    (input) => api.conferences.listParticipants({ slug, ...input }),
    { pageSize: 25 },
  );

  const invites = usePaginatedList<InviteOut>(
    (input) => api.conferences.listInvites({ slug, status: "pending", ...input }),
    { pageSize: 25 },
  );

  const [inviteSheetOpen, setInviteSheetOpen] = useState(false);
  const [singleEmail, setSingleEmail] = useState("");
  const [bulkCsv, setBulkCsv] = useState("");
  const [exporting, setExporting] = useState(false);

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
      invites.refresh();
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
      invites.refresh();
    } catch (e) {
      toast.error(quotaErrorMessage(e) ?? humanInviteError(errorCode(e)));
    }
  }

  async function revokeInvite(id: number) {
    if (!confirm("Revoke this invite? The link will stop working immediately.")) return;
    try {
      await api.conferences.revokeInvite({ slug, id });
      toast.success("Invite revoked.");
    } catch (e) { toast.error(errorCode(e)); }
    invites.refresh();
  }

  async function setRoleAction(userId: number, action: "promote" | "demote") {
    try {
      if (action === "promote") await api.conferences.addModerator({ slug, user_id: userId });
      else await api.conferences.removeModerator({ slug, user_id: userId });
      toast.success(action === "promote" ? "Promoted to moderator." : "Demoted to participant.");
    } catch (e) {
      toast.error(errorCode(e));
    }
    people.refresh();
  }

  async function remove(userId: number) {
    if (!confirm("Remove this participant?")) return;
    try {
      await api.conferences.removeParticipant({ slug, user_id: userId });
      toast.success("Participant removed.");
    } catch (e) { toast.error(errorCode(e)); }
    people.refresh();
  }

  // Server-side CSV export. Streams every pending invite matching the
  // current search query — paging the client through them would race
  // against creates / claims.
  async function downloadCsv() {
    if (exporting) return;
    setExporting(true);
    try {
      const { invites: pending } = await api.conferences.exportInvites({
        slug,
        q: invites.q.trim() || undefined,
      });
      if (pending.length === 0) {
        toast.error("No pending invites match the current filter.");
        return;
      }
      downloadInvitesCsv(slug, pending);
      toast.success(`Exported ${pending.length} pending invite${pending.length === 1 ? "" : "s"}.`);
    } catch (e) {
      toast.error(errorCode(e));
    } finally {
      setExporting(false);
    }
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

      <TextInput
        label="Search people"
        placeholder="Search by name or email"
        value={people.q}
        onChange={(e) => people.setQ(e.target.value)}
      />

      {people.loading && people.items.length === 0 ? (
        <Spinner label="Loading…" />
      ) : people.items.length === 0 ? (
        <EmptyState
          message={people.q.trim() ? `No members match "${people.q}".` : "No members yet."}
          action={people.q.trim() ? (
            <Button size="small" onClick={people.reset}>Clear search</Button>
          ) : undefined}
        />
      ) : (
        <Stack gap="condensed">
          {people.items.map((p) => (
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

      <Pager
        page={people.page}
        pageSize={people.pageSize}
        total={people.total}
        loading={people.loading}
        hasPrev={people.hasPrev}
        hasNext={people.hasNext}
        onPrev={people.prev}
        onNext={people.next}
        noun="people"
      />

      {isMod && <ChatReportsSection slug={slug} />}

      {isMod && (
        <Stack gap="condensed">
          <Stack direction="row" justify="between" align="center" wrap>
            <Heading level={3}>Pending invites</Heading>
            {invites.total > 0 && (
              <Button size="small" onClick={downloadCsv} disabled={exporting}>
                {exporting ? "Exporting…" : "Download CSV"}
              </Button>
            )}
          </Stack>

          <TextInput
            label="Search invites"
            placeholder="Search invites by email"
            value={invites.q}
            onChange={(e) => invites.setQ(e.target.value)}
          />

          {invites.loading && invites.items.length === 0 ? (
            <Spinner label="Loading…" />
          ) : invites.items.length === 0 ? (
            <EmptyState
              message={
                invites.q.trim()
                  ? `No pending invites match "${invites.q}".`
                  : "No pending invites."
              }
              action={invites.q.trim() ? (
                <Button size="small" onClick={invites.reset}>Clear search</Button>
              ) : undefined}
            />
          ) : (
            <Stack gap="condensed">
              {invites.items.map((inv) => (
                <InviteRow
                  key={inv.id}
                  invite={inv}
                  inviteUrl={absoluteUrl(inv.url)}
                  onRevoke={() => revokeInvite(inv.id)}
                />
              ))}
            </Stack>
          )}

          <Pager
            page={invites.page}
            pageSize={invites.pageSize}
            total={invites.total}
            loading={invites.loading}
            hasPrev={invites.hasPrev}
            hasNext={invites.hasNext}
            onPrev={invites.prev}
            onNext={invites.next}
            noun="invites"
          />
        </Stack>
      )}
    </Stack>
  );
}

function InviteRow({
  invite, inviteUrl, onRevoke,
}: {
  invite: PendingInvite;
  inviteUrl: string;
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
        <CopyButton
          label="Copy link"
          value={inviteUrl}
          disabled={expired}
          successMessage={`Invite link for ${invite.email} copied.`}
          fallbackPromptLabel="Copy this invite link:"
        />
        <Button size="small" variant="danger" onClick={onRevoke}>Revoke</Button>
      </div>
    </div>
  );
}

function csvEscape(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function buildInvitesCsv(invites: PendingInvite[]): string {
  const headers = ["email", "role", "token", "url", "created_at", "expires_at"];
  const rows = invites.map((inv) => [
    inv.email,
    inv.role,
    inv.token,
    absoluteUrl(inv.url),
    new Date(inv.created_at).toISOString(),
    new Date(inv.expires_at).toISOString(),
  ].map(csvEscape).join(","));
  return [headers.join(","), ...rows].join("\r\n") + "\r\n";
}

function downloadInvitesCsv(slug: string, invites: PendingInvite[]): void {
  // Prepend a UTF-8 BOM so Excel opens non-ASCII emails correctly.
  const blob = new Blob(["﻿" + buildInvitesCsv(invites)], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const stamp = new Date().toISOString().slice(0, 10);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${slug}-pending-invites-${stamp}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
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
