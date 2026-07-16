// Wrap-up report (F3). A moderator opens this from the Agenda header to see
// the conference at a glance: headline numbers, the session funnel, top
// sessions, room utilization, and expert bookings. Fetched lazily on open.
//
// Print-friendly: a "Print" button calls window.print(), and a page-scoped
// @media print block (same precedent as Login's PAGE_STYLES) hides the rest
// of the app so only the report prints, cleanly on white. The report lives in
// a `#event-report-print` container that the print CSS keeps visible.

import { useEffect, useState } from "react";
import { Button, Sheet, Spinner, Stack, Text } from "../../design-system";
import { api, errorCode } from "../../api";
import type { EventReportOut } from "../../../shared/contract";

const PRINT_STYLES = `
@media print {
  body * { visibility: hidden !important; }
  #event-report-print, #event-report-print * { visibility: visible !important; }
  #event-report-print {
    position: absolute; left: 0; top: 0; width: 100%;
    padding: 0; margin: 0;
    color: #111 !important;
    -webkit-print-color-adjust: exact; print-color-adjust: exact;
  }
  #event-report-print * { color: #111 !important; }
  #event-report-print .er-bar-track { background: #eaeef2 !important; }
  #event-report-print .er-bar-fill { background: #57606a !important; }
  .er-noprint { display: none !important; }
}
`;

export function EventReportSheet({
  slug, open, onClose,
}: {
  slug: string;
  open: boolean;
  onClose: () => void;
}) {
  // Track which (open-cycle, slug) the fetched report belongs to. Deriving
  // `loading` from this avoids a synchronous setState in the effect: a fresh
  // open re-fetches and shows the spinner until its own result lands, without
  // resetting state imperatively.
  const [report, setReport] = useState<EventReportOut | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadedSlug, setLoadedSlug] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    api.conferences.report({ slug })
      .then((r) => { if (!cancelled) { setReport(r); setError(null); setLoadedSlug(slug); } })
      .catch((e) => { if (!cancelled) { setError(errorCode(e)); setReport(null); setLoadedSlug(slug); } });
    return () => { cancelled = true; };
  }, [open, slug]);

  const loading = open && loadedSlug !== slug;

  return (
    <Sheet open={open} onClose={onClose} title="Event report">
      <style>{PRINT_STYLES}</style>
      {loading && <Spinner label="Building report…" />}
      {!loading && error && (
        <Text muted>Could not load the report: {error}</Text>
      )}
      {!loading && !error && report && (
        <Stack gap="spacious">
          <div id="event-report-print">
            <ReportBody report={report} />
          </div>
          <Stack direction="row" gap="condensed" className="er-noprint">
            <Button variant="primary" onClick={() => window.print()}>Print</Button>
            <Button onClick={onClose}>Close</Button>
          </Stack>
        </Stack>
      )}
    </Sheet>
  );
}

function ReportBody({ report }: { report: EventReportOut }) {
  const muted = "var(--fgColor-muted, var(--uncon-fg-muted, #6e7781))";
  return (
    <Stack gap="spacious">
      {/* Headline numbers as stat tiles. */}
      <StatGrid>
        <StatTile label="Participants" value={report.participant_count} />
        <StatTile label="Seats filled" value={report.seats_filled} />
        <StatTile label="Stars" value={report.stars_total} />
        <StatTile label="Takeaways" value={report.takeaway_count} />
        <StatTile label="Expert bookings" value={report.expert_bookings_count} />
      </StatGrid>

      {/* Session funnel: submitted → published → scheduled. */}
      <Section title="Sessions">
        <StatGrid>
          <StatTile label="Submitted" value={report.sessions.submitted} />
          <StatTile label="Published" value={report.sessions.published} />
          <StatTile label="Scheduled" value={report.sessions.placed_or_scheduled} />
        </StatGrid>
      </Section>

      {/* Top sessions by stars. */}
      <Section title="Top sessions">
        {report.top_sessions.length === 0 ? (
          <Text muted>No starred sessions yet.</Text>
        ) : (
          <Stack gap="condensed">
            {report.top_sessions.map((s, i) => (
              <div key={i} style={{
                display: "flex", alignItems: "center", gap: 12,
                padding: "8px 12px", borderRadius: 8,
                border: "1px solid var(--borderColor-muted, var(--uncon-border-muted, #e5e7eb))",
              }}>
                <span style={{
                  fontSize: 13, fontWeight: 700, color: muted,
                  width: 20, textAlign: "right", fontVariantNumeric: "tabular-nums",
                }}>
                  {i + 1}
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 600, wordBreak: "break-word" }}>
                    {s.title}
                  </div>
                  {s.submitter_name && (
                    <div style={{ fontSize: 12, color: muted }}>{s.submitter_name}</div>
                  )}
                </div>
                <span style={{
                  fontSize: 13, fontWeight: 600, whiteSpace: "nowrap",
                  fontVariantNumeric: "tabular-nums",
                }}>
                  ★ {s.star_count}
                </span>
              </div>
            ))}
          </Stack>
        )}
      </Section>

      {/* Room utilization. */}
      <Section title="Rooms">
        {report.rooms.length === 0 ? (
          <Text muted>No rooms yet.</Text>
        ) : (
          <Stack gap="condensed">
            {report.rooms.map((r, i) => (
              <RoomRow
                key={i}
                name={r.name}
                capacity={r.capacity}
                used={r.used_slots}
                available={r.available_slots}
                muted={muted}
              />
            ))}
          </Stack>
        )}
      </Section>

      <div style={{ fontSize: 12, color: muted }}>
        Generated {new Date(report.generated_at).toLocaleString()}
      </div>
    </Stack>
  );
}

function RoomRow({
  name, capacity, used, available, muted,
}: {
  name: string;
  capacity: number;
  used: number;
  available: number;
  muted: string;
}) {
  const pct = available > 0 ? Math.min(100, Math.round((used / available) * 100)) : 0;
  return (
    <div style={{
      display: "flex", flexDirection: "column", gap: 6,
      padding: "10px 12px", borderRadius: 8,
      border: "1px solid var(--borderColor-muted, var(--uncon-border-muted, #e5e7eb))",
    }}>
      <div style={{
        display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 10,
      }}>
        <span style={{ fontSize: 14, fontWeight: 600, wordBreak: "break-word" }}>{name}</span>
        <span style={{ fontSize: 12, color: muted, whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}>
          {used}/{available} slots · seats {capacity}
        </span>
      </div>
      <div className="er-bar-track" style={{
        height: 6, borderRadius: 999, overflow: "hidden",
        background: "var(--bgColor-muted, var(--uncon-bg-subtle, rgba(0,0,0,0.06)))",
      }}>
        <div className="er-bar-fill" style={{
          width: `${pct}%`, height: "100%", borderRadius: 999,
          background: "var(--fgColor-accent, #2563eb)",
        }} />
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Stack gap="condensed">
      <div style={{
        fontSize: 12, fontWeight: 600,
        textTransform: "uppercase", letterSpacing: 0.6,
        color: "var(--fgColor-muted, var(--uncon-fg-muted, #6e7781))",
      }}>
        {title}
      </div>
      {children}
    </Stack>
  );
}

function StatGrid({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      display: "grid",
      gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))",
      gap: 10,
    }}>
      {children}
    </div>
  );
}

function StatTile({ label, value }: { label: string; value: number }) {
  return (
    <div style={{
      display: "flex", flexDirection: "column", gap: 2,
      padding: "12px 14px", borderRadius: 10,
      border: "1px solid var(--borderColor-muted, var(--uncon-border-muted, #e5e7eb))",
      background: "var(--bgColor-muted, var(--uncon-bg-subtle, rgba(0,0,0,0.025)))",
    }}>
      <span style={{
        fontSize: 26, fontWeight: 700, lineHeight: "30px",
        fontVariantNumeric: "tabular-nums",
      }}>
        {value}
      </span>
      <span style={{
        fontSize: 11, fontWeight: 600, letterSpacing: 0.4,
        textTransform: "uppercase",
        color: "var(--fgColor-muted, var(--uncon-fg-muted, #6e7781))",
      }}>
        {label}
      </span>
    </div>
  );
}
