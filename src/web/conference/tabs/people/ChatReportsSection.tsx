// Mod-only chat moderation surface. Lives at the bottom of PeopleTab.
// Two stacked sections:
//   - Reports: open reports first (review/resolve), then a collapsed view
//     of resolved ones for audit.
//   - Bans: currently-banned identities with an Unban action.

import { useCallback, useEffect, useState } from "react";
import { Badge, Button, Heading, Sheet, Stack, Text, Textarea } from "../../../design-system";
import { api } from "../../../api";
import type { MessageReportOut, ChatBanOut } from "../../../../shared/contract";

interface ChatReportsSectionProps {
  slug: string;
}

type StatusFilter = "open" | "resolved" | "all";

export function ChatReportsSection({ slug }: ChatReportsSectionProps) {
  const [reports, setReports] = useState<MessageReportOut[] | null>(null);
  const [bans, setBans] = useState<ChatBanOut[] | null>(null);
  const [status, setStatus] = useState<StatusFilter>("open");
  const [activeReport, setActiveReport] = useState<MessageReportOut | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [r, b] = await Promise.all([
        api.moderation.listChatReports({ slug, status }),
        api.moderation.listChatBans({ slug }),
      ]);
      setReports(r);
      setBans(b);
    } catch {
      setReports([]);
      setBans([]);
    }
  }, [slug, status]);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      api.moderation.listChatReports({ slug, status }),
      api.moderation.listChatBans({ slug }),
    ])
      .then(([r, b]) => {
        if (cancelled) return;
        setReports(r);
        setBans(b);
      })
      .catch(() => {
        if (cancelled) return;
        setReports([]);
        setBans([]);
      });
    return () => { cancelled = true; };
  }, [slug, status]);

  async function unban(identityId: number) {
    await api.moderation.unbanFromChat({ slug, identity_id: identityId }).catch(() => { /* no-op */ });
    void refresh();
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
                onClick={() => setStatus(s)}
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
        {reports === null && <Text muted>Loading…</Text>}
        {reports !== null && reports.length === 0 && (
          <Text muted>
            {status === "open" ? "No open reports." : "Nothing here."}
          </Text>
        )}
        {reports?.map((r) => (
          <ReportRow key={r.id} report={r} onOpen={() => setActiveReport(r)} />
        ))}
      </Stack>

      <Stack gap="condensed">
        <Heading level={3}>Banned from chat</Heading>
        {bans === null && <Text muted>Loading…</Text>}
        {bans !== null && bans.length === 0 && (
          <Text muted>No one is currently banned from chat.</Text>
        )}
        {bans?.map((b) => (
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

      {activeReport && (
        <ReportSheet
          slug={slug}
          report={activeReport}
          onClose={() => setActiveReport(null)}
          onResolved={() => { setActiveReport(null); void refresh(); }}
        />
      )}
    </Stack>
  );
}

function ReportRow({ report, onOpen }: { report: MessageReportOut; onOpen: () => void }) {
  const muted = "var(--fgColor-muted, #6e7781)";
  return (
    <button
      type="button"
      onClick={onOpen}
      style={{
        background: "var(--bgColor-default, transparent)",
        border: "1px solid var(--borderColor-muted, #e5e7eb)",
        borderRadius: 8,
        padding: "10px 12px",
        textAlign: "left",
        cursor: "pointer",
        color: "var(--fgColor-default, inherit)",
        display: "flex",
        flexDirection: "column",
        gap: 4,
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
