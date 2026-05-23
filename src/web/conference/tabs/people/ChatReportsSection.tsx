// Mod-only chat moderation surface. Lives at the bottom of PeopleTab.
// Two stacked sections, each paginated + searchable:
//   - Reports: open reports first (review/resolve), then a collapsed view
//     of resolved ones for audit.
//   - Bans: currently-banned identities with an Unban action.

import { useState } from "react";
import { Badge, Button, Heading, Sheet, Spinner, Stack, Text, Textarea, TextInput } from "../../../design-system";
import { api, errorCode } from "../../../api";
import type {
  ChatBanOut,
  MessageReportOut,
  MessageReportSummaryOut,
} from "../../../../shared/contract";
import { EmptyState } from "../../ui/EmptyState";
import { Pager } from "../../ui/Pager";
import { usePaginatedList } from "../../usePaginatedList";

interface ChatReportsSectionProps {
  slug: string;
}

type StatusFilter = "open" | "resolved" | "all";

export function ChatReportsSection({ slug }: ChatReportsSectionProps) {
  const [status, setStatus] = useState<StatusFilter>("open");
  const [activeReport, setActiveReport] = useState<MessageReportOut | null>(null);
  const [openingId, setOpeningId] = useState<number | null>(null);

  const reports = usePaginatedList<MessageReportSummaryOut>(
    (input) => api.moderation.listChatReports({ slug, status, ...input }),
    { pageSize: 25 },
  );
  const bans = usePaginatedList<ChatBanOut>(
    (input) => api.moderation.listChatBans({ slug, ...input }),
    { pageSize: 25 },
  );

  // Status filter sits outside the hook, so refresh manually when it flips.
  // The hook resets paging when its input dependencies change at fetch time;
  // because `status` is captured in the closure passed to it, we trigger a
  // refresh to pick up the new value.
  function changeStatus(next: StatusFilter) {
    setStatus(next);
    // Schedule the refresh after the state update; the hook reads the new
    // closure on the next render.
    queueMicrotask(() => reports.refresh());
  }

  async function openReport(summary: MessageReportSummaryOut) {
    if (openingId !== null) return;
    setOpeningId(summary.id);
    try {
      const full = await api.moderation.getChatReport({
        slug, report_id: summary.id,
      });
      setActiveReport(full);
    } catch {
      // Sheet stays closed; the row keeps its data and the moderator can retry.
    } finally {
      setOpeningId(null);
    }
  }

  async function unban(identityId: number) {
    try {
      await api.moderation.unbanFromChat({ slug, identity_id: identityId });
    } catch { /* no-op */ }
    bans.refresh();
  }

  return (
    <Stack gap="spacious">
      <Stack gap="condensed">
        <Stack direction="row" justify="between" align="center" wrap>
          <Heading level={3}>Chat reports</Heading>
          <div style={{ display: "flex", gap: 4 }}>
            {(["open", "resolved", "all"] as StatusFilter[]).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => changeStatus(s)}
                style={{
                  padding: "4px 10px",
                  fontSize: 12,
                  borderRadius: 6,
                  border: 0,
                  background: s === status
                    ? "var(--bgColor-accent-muted, rgba(64,132,246,0.16))"
                    : "transparent",
                  color: s === status
                    ? "var(--fgColor-accent, #2563eb)"
                    : "var(--fgColor-muted)",
                  cursor: "pointer",
                  textTransform: "capitalize",
                }}
              >
                {s}
              </button>
            ))}
          </div>
        </Stack>

        <TextInput
          label="Search reports"
          placeholder="Search by reason, reporter, sender, or message text"
          value={reports.q}
          onChange={(e) => reports.setQ(e.target.value)}
        />

        {reports.loading && reports.items.length === 0 ? (
          <Spinner label="Loading…" />
        ) : reports.items.length === 0 ? (
          <Text muted>
            {reports.q.trim()
              ? `No reports match "${reports.q}".`
              : status === "open" ? "No open reports." : "Nothing here."}
          </Text>
        ) : (
          <Stack gap="condensed">
            {reports.items.map((r) => (
              <ReportRow
                key={r.id}
                report={r}
                busy={openingId === r.id}
                onOpen={() => openReport(r)}
              />
            ))}
          </Stack>
        )}

        <Pager
          page={reports.page}
          pageSize={reports.pageSize}
          total={reports.total}
          loading={reports.loading}
          hasPrev={reports.hasPrev}
          hasNext={reports.hasNext}
          onPrev={reports.prev}
          onNext={reports.next}
          noun="reports"
        />
      </Stack>

      <Stack gap="condensed">
        <Heading level={3}>Banned from chat</Heading>

        <TextInput
          label="Search bans"
          placeholder="Search by name, email, or ban reason"
          value={bans.q}
          onChange={(e) => bans.setQ(e.target.value)}
        />

        {bans.loading && bans.items.length === 0 ? (
          <Spinner label="Loading…" />
        ) : bans.items.length === 0 ? (
          <EmptyState
            message={
              bans.q.trim()
                ? `No bans match "${bans.q}".`
                : "No one is currently banned from chat."
            }
          />
        ) : (
          <Stack gap="condensed">
            {bans.items.map((b) => (
              <Stack
                key={b.identity_id}
                direction="row"
                justify="between"
                align="center"
                wrap
              >
                <div>
                  <strong>{b.name ?? `Identity #${b.identity_id}`}</strong>
                  <div style={{ fontSize: 12, color: "var(--fgColor-muted)" }}>
                    {b.reason ?? "No reason provided"}
                    {b.banned_by ? ` · by ${b.banned_by}` : ""}
                    {" · "}
                    {new Date(b.banned_at).toLocaleDateString()}
                  </div>
                </div>
                <Button size="small" onClick={() => unban(b.identity_id)}>
                  Unban
                </Button>
              </Stack>
            ))}
          </Stack>
        )}

        <Pager
          page={bans.page}
          pageSize={bans.pageSize}
          total={bans.total}
          loading={bans.loading}
          hasPrev={bans.hasPrev}
          hasNext={bans.hasNext}
          onPrev={bans.prev}
          onNext={bans.next}
          noun="bans"
        />
      </Stack>

      {activeReport && (
        <ReportSheet
          slug={slug}
          report={activeReport}
          onClose={() => setActiveReport(null)}
          onResolved={() => {
            setActiveReport(null);
            reports.refresh();
            bans.refresh();
          }}
        />
      )}
    </Stack>
  );
}

function ReportRow({
  report, busy, onOpen,
}: {
  report: MessageReportSummaryOut;
  busy: boolean;
  onOpen: () => void;
}) {
  const muted = "var(--fgColor-muted, #6e7781)";
  return (
    <button
      type="button"
      onClick={onOpen}
      disabled={busy}
      style={{
        background: "var(--bgColor-default, transparent)",
        border: "1px solid var(--borderColor-muted, #e5e7eb)",
        borderRadius: 8,
        padding: "10px 12px",
        textAlign: "left",
        cursor: busy ? "wait" : "pointer",
        color: "var(--fgColor-default, inherit)",
        display: "flex",
        flexDirection: "column",
        gap: 4,
        opacity: busy ? 0.7 : 1,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, fontSize: 13 }}>
        <span>
          <strong>{report.reporter_name ?? "Someone"}</strong>
          {" reported "}
          <strong>{report.reported_sender_name ?? "a user"}</strong>
        </span>
        <span style={{ color: muted, fontSize: 12 }}>
          {new Date(report.created_at).toLocaleString()}
        </span>
      </div>
      <div style={{ fontSize: 12, color: muted, fontStyle: "italic" }}>
        “{truncate(report.reason, 140)}”
      </div>
      {report.message_preview && (
        <div style={{ fontSize: 12, color: muted }}>
          Message: “{report.message_preview}”
        </div>
      )}
      {report.resolved_at !== null && (
        <div style={{ display: "flex", gap: 6 }}>
          <Badge variant="default">resolved</Badge>
          {report.action && <Badge variant="default">{report.action}</Badge>}
        </div>
      )}
    </button>
  );
}

function ReportSheet({
  slug, report, onClose, onResolved,
}: {
  slug: string;
  report: MessageReportOut;
  onClose: () => void;
  onResolved: () => void;
}) {
  const [busy, setBusy] = useState<"dismiss" | "warn" | "ban" | null>(null);
  const [modReason, setModReason] = useState("");

  async function resolve(action: "dismiss" | "warn" | "ban") {
    setBusy(action);
    try {
      const trimmed = modReason.trim();
      await api.moderation.resolveChatReport({
        slug,
        report_id: report.id,
        action,
        // Sent for warn + ban; server falls back to the reporter's reason
        // when empty. Omitted for dismiss (irrelevant).
        mod_reason: action === "dismiss" ? undefined : (trimmed || undefined),
      });
      onResolved();
    } catch { /* keep sheet open */ }
    finally { setBusy(null); }
  }

  const muted = "var(--fgColor-muted, #6e7781)";
  const resolved = report.resolved_at !== null;
  // Reserved for a "could not load context" inline error in a future iteration.
  void slug;
  void errorCode;

  return (
    <Sheet open onClose={onClose} title="Report details">
      <Stack gap="spacious">
        <Stack gap="condensed">
          <Text>
            <strong>{report.reporter_name ?? "Someone"}</strong>
            {" reported a message from "}
            <strong>{report.reported_sender_name ?? "a user"}</strong>
          </Text>
          <Text muted>Reason: {report.reason}</Text>
          <Text muted>Reported {new Date(report.created_at).toLocaleString()}</Text>
        </Stack>

        <Stack gap="condensed">
          <Heading level={4}>The reported message</Heading>
          <MessageQuote body={report.message.body} deletedReason={report.message.deleted_reason} editedAt={report.message.edited_at} />
          {report.revisions.length > 0 && (
            <div>
              <Text muted>Previous versions ({report.revisions.length}):</Text>
              {report.revisions.map((rev, i) => (
                <div key={i} style={{ marginTop: 6 }}>
                  <MessageQuote body={rev.body} deletedReason={null} editedAt={null} />
                  <div style={{ fontSize: 11, color: muted, marginTop: 2 }}>
                    {new Date(rev.created_at).toLocaleString()}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Stack>

        <Stack gap="condensed">
          <Heading level={4}>Context</Heading>
          {report.surrounding_messages.length === 0 ? (
            <Text muted>No surrounding messages.</Text>
          ) : (
            report.surrounding_messages.map((m) => (
              <div key={m.id} style={{
                opacity: m.id === report.message.id ? 1 : 0.6,
                fontWeight: m.id === report.message.id ? 600 : 400,
              }}>
                <MessageQuote body={m.body} deletedReason={m.deleted_reason} editedAt={m.edited_at} />
              </div>
            ))
          )}
        </Stack>

        {!resolved && (
          <Stack gap="condensed">
            <Heading level={4}>Resolve</Heading>
            <Textarea
              label="Reason shown to the sender (used for warn or ban; falls back to the reporter's reason if blank)"
              rows={2}
              placeholder={report.reason}
              value={modReason}
              onChange={(e) => setModReason(e.target.value)}
            />
            <Stack direction="row" gap="condensed">
              <Button onClick={() => void resolve("dismiss")} disabled={busy !== null}>
                Dismiss
              </Button>
              <Button onClick={() => void resolve("warn")} disabled={busy !== null}>
                Warn sender
              </Button>
              <Button variant="danger" onClick={() => void resolve("ban")} disabled={busy !== null}>
                Ban sender
              </Button>
            </Stack>
          </Stack>
        )}
        {resolved && (
          <Text muted>
            Already resolved: <strong>{report.action ?? "?"}</strong>
          </Text>
        )}
      </Stack>
    </Sheet>
  );
}

function MessageQuote({
  body, deletedReason, editedAt,
}: { body: string | null; deletedReason: string | null; editedAt: number | null }) {
  return (
    <div style={{
      borderLeft: "3px solid var(--borderColor-default, #d0d7de)",
      paddingLeft: 10,
      fontSize: 13,
      whiteSpace: "pre-wrap",
      wordBreak: "break-word",
      color: body === null ? "var(--fgColor-muted)" : "var(--fgColor-default)",
      fontStyle: body === null ? "italic" : "normal",
    }}>
      {body ?? `[deleted: ${deletedReason ?? "unknown reason"}]`}
      {editedAt && body !== null && (
        <span style={{ marginLeft: 6, fontSize: 11, color: "var(--fgColor-muted)" }}>(edited)</span>
      )}
    </div>
  );
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}
