import { useCallback, useEffect, useState } from "react";
import { useToast } from "../../design-system/hooks";
import {
  Button, Heading, Spinner, Stack,
} from "../../design-system";
import { api, errorCode } from "../../api";
import { clipToMinute, formatInTz } from "../../../shared/tz";
import { dayKeyInTz, fmtDayShort, fmtTimeShort } from "../helpers";
import type { AgendaData, MyAssignments, Room, Slot, Submission } from "../types";
import { EmptyState } from "../ui/EmptyState";
import { Pill } from "../ui/Pill";
import { CopyButton } from "../ui/CopyButton";
import { RoomInfoSheet } from "../ui/RoomInfoSheet";
import { SessionPicker } from "../ui/SessionPicker";

export function MyAssignmentsTab({
  slug, timeZone,
}: { slug: string; timeZone: string }) {
  const [data, setData] = useState<MyAssignments | null>(null);
  const [agenda, setAgenda] = useState<AgendaData | null>(null);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [subs, setSubs] = useState<Submission[]>([]);
  // Which room's info sheet (if any) is currently open. Clicking the chip
  // on a schedule entry sets this; the sheet closes itself.
  const [openRoom, setOpenRoom] = useState<Room | null>(null);
  // Which slot's session picker is currently open. The picker is shared
  // across "Pick a session" (unplaced) and "Change session" (placed).
  const [pickerSlotId, setPickerSlotId] = useState<number | null>(null);

  const fetchAll = useCallback(() => Promise.all([
    api.agenda.myAssignments({ slug }),
    api.agenda.get({ slug }),
    api.rooms.list({ slug }),
    api.submissions.list({ slug, status: "published" }),
  ]), [slug]);
  async function refresh() {
    const [m, a, r, s] = await fetchAll();
    setData(m); setAgenda(a); setRooms(r); setSubs(s);
  }

  useEffect(() => {
    let cancelled = false;
    fetchAll()
      .then(([m, a, r, s]) => {
        if (cancelled) return;
        setData(m); setAgenda(a); setRooms(r); setSubs(s);
      })
      .catch(() => {
        if (cancelled) return;
        setData({ assignments: [], unplaced_slots: [] });
        setAgenda({ slots: [], slot_series: [], tracks: [], placements: [], mixer_placements: [] });
      });
    return () => { cancelled = true; };
  }, [fetchAll]);

  if (!data || !agenda) return <Spinner label="Loading…" />;

  const slotById = new Map(agenda.slots.map((s) => [s.id, s]));
  const roomById = new Map(rooms.map((r) => [r.id, r]));

  // Sort all assignments chronologically (using the denormalized event window
  // so expert bookings — which have no AgendaSlot — sort alongside the rest),
  // then group by day so the page mirrors the calendar layout.
  const sorted = [...data.assignments].sort((a, b) => a.starts_at - b.starts_at);
  const groups = new Map<string, typeof sorted>();
  for (const a of sorted) {
    const dayKey = formatInTz(a.starts_at, timeZone, {
      weekday: "long", year: "numeric", month: "long", day: "numeric",
    });
    const arr = groups.get(dayKey) ?? [];
    arr.push(a);
    groups.set(dayKey, arr);
  }

  // Path C cross-row signals: when a participant stars one Submission that's
  // scheduled in multiple planned offerings (the typical sibling case), the
  // derivation yields multiple rows with the same `submission_id`. We
  // surface that connection inline ("Also at 14:00 Hall") so the user
  // understands the rows are the same content, not separate sessions.
  //
  // And when two starred rows overlap in time, we flag the conflict.
  const alternatesBySubId = new Map<number, typeof sorted>();
  for (const a of sorted) {
    if (a.submission_id === null) continue;
    const arr = alternatesBySubId.get(a.submission_id) ?? [];
    arr.push(a);
    alternatesBySubId.set(a.submission_id, arr);
  }
  function rowKey(a: typeof sorted[number]): string {
    return `${a.source}-${a.slot_id ?? `b${a.booking_id ?? 0}`}-${a.submission_id ?? "0"}`;
  }
  function alternatesFor(a: typeof sorted[number]): { starts_at: number; title: string | null }[] {
    if (a.submission_id === null) return [];
    return (alternatesBySubId.get(a.submission_id) ?? [])
      .filter((other) => rowKey(other) !== rowKey(a))
      .map((other) => ({ starts_at: other.starts_at, title: other.title }));
  }
  function conflictsFor(a: typeof sorted[number]): string[] {
    const out: string[] = [];
    // Clip to whole minute (same granularity as the displayed labels) so a
    // touching-minute boundary doesn't get flagged as a 30s overlap.
    const aStart = clipToMinute(a.starts_at);
    const aEnd = clipToMinute(a.ends_at);
    for (const other of sorted) {
      if (rowKey(other) === rowKey(a)) continue;
      // Same-submission rows aren't conflicts — they're shown as alternates
      // instead. Real conflicts are between different content at the same time.
      if (a.submission_id !== null && a.submission_id === other.submission_id) continue;
      const oStart = clipToMinute(other.starts_at);
      const oEnd = clipToMinute(other.ends_at);
      // Standard half-open overlap test on whole-minute edges.
      if (aStart < oEnd && oStart < aEnd) {
        out.push(other.title ?? "Another session");
      }
    }
    return out;
  }

  return (
    <Stack gap="spacious">
      <Heading level={2}>Your schedule</Heading>

      <CalendarSubscribe slug={slug} />

      {data.unplaced_slots.length > 0 && (
        <UnplacedCard
          slotIds={data.unplaced_slots}
          slotById={slotById}
          timeZone={timeZone}
          onPick={(sid) => setPickerSlotId(sid)}
        />
      )}

      {sorted.length === 0 ? (
        <EmptyState message="Nothing on your schedule yet. Star sessions on the Sessions tab or the Agenda to add them here — one star covers both the unconference algorithm and any planned-slot offering of that session." />
      ) : (
        <Stack gap="spacious">
          {[...groups.entries()].map(([day, items]) => (
            <Stack key={day} gap="condensed">
              <div style={{
                fontSize: 12, fontWeight: 600,
                textTransform: "uppercase", letterSpacing: 0.6,
                color: "var(--fgColor-muted, var(--uncon-fg-muted, #6e7781))",
              }}>
                {day}
              </div>
              <Stack gap="condensed">
                {items.map((a) => {
                  const room = a.room_id ? roomById.get(a.room_id) : null;
                  return (
                    <ScheduleCard
                      key={rowKey(a)}
                      title={a.title ?? "(removed)"}
                      source={a.source}
                      manual={a.manual ?? false}
                      mandatory={a.mandatory ?? false}
                      isSubmitter={a.is_submitter ?? false}
                      expectedAttendance={a.expected_attendance ?? null}
                      roomCapacity={a.room_capacity ?? null}
                      startsAt={a.starts_at}
                      endsAt={a.ends_at}
                      room={room}
                      timeZone={timeZone}
                      alternates={alternatesFor(a)}
                      conflicts={conflictsFor(a)}
                      onRoomClick={(r) => setOpenRoom(r)}
                      onChangeSession={
                        a.source === "unconference" && a.slot_id !== null
                          ? () => setPickerSlotId(a.slot_id)
                          : undefined
                      }
                    />
                  );
                })}
              </Stack>
            </Stack>
          ))}
        </Stack>
      )}

      <RoomInfoSheet room={openRoom} onClose={() => setOpenRoom(null)} />

      <SessionPicker
        open={pickerSlotId !== null}
        onClose={() => setPickerSlotId(null)}
        slug={slug}
        slotId={pickerSlotId ?? 0}
        placements={pickerSlotId !== null
          ? agenda.placements.filter((p) => p.slot_id === pickerSlotId)
          : []}
        subs={subs}
        rooms={rooms}
        currentSubmissionId={pickerSlotId !== null
          ? (data.assignments.find((a) => a.slot_id === pickerSlotId
              && a.source === "unconference")?.submission_id ?? null)
          : null}
        onChanged={refresh}
      />
    </Stack>
  );
}

// Polished unplaced-slots card. One card, attention-color stripe, with a
// compact list of slots inside. No fat Banner above — the card itself
// carries the warning context. Each row leans on typography hierarchy
// rather than borders/backgrounds to feel less heavy.
function UnplacedCard({
  slotIds, slotById, timeZone, onPick,
}: {
  slotIds: number[];
  slotById: Map<number, Slot>;
  timeZone: string;
  onPick: (slotId: number) => void;
}) {
  const muted = "var(--fgColor-muted, var(--uncon-fg-muted, #6e7781))";
  const attention = "var(--fgColor-attention, var(--uncon-warning-fg, #9a6700))";
  const attentionBg = "var(--bgColor-attention-muted, rgba(187, 128, 9, 0.10))";
  const attentionBorder = "var(--borderColor-attention-muted, rgba(187, 128, 9, 0.45))";

  return (
    <div style={{
      display: "grid",
      gridTemplateColumns: "auto 1fr",
      gap: "0 12px",
      padding: 16,
      borderRadius: 10,
      border: `1px solid ${attentionBorder}`,
      background: attentionBg,
    }}>
      {/* Compact warning glyph in the left rail. Single triangle + dot,
          drawn inline so we don't depend on an icon library. */}
      <svg
        width="18" height="18" viewBox="0 0 16 16" aria-hidden
        style={{ marginTop: 2, color: attention }}
      >
        <path d="M8 1.5 L15 14 L1 14 Z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
        <path d="M8 6 L8 10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        <circle cx="8" cy="12" r="0.9" fill="currentColor" />
      </svg>

      <div style={{ minWidth: 0 }}>
        <div style={{
          fontSize: 14, fontWeight: 600, lineHeight: "20px",
          color: "var(--fgColor-default, var(--uncon-fg, inherit))",
        }}>
          {slotIds.length === 1 ? "Pick a session" : `Pick a session for ${slotIds.length} slots`}
        </div>
        <div style={{ fontSize: 13, color: muted, marginTop: 2 }}>
          Your starred sessions filled up. Switch into any non-full session below.
        </div>

        <div style={{
          display: "flex", flexDirection: "column",
          marginTop: 12,
          borderTop: `1px solid ${attentionBorder}`,
        }}>
          {slotIds.map((sid, i) => {
            const slot = slotById.get(sid);
            return (
              <div
                key={sid}
                style={{
                  display: "flex", alignItems: "center", justifyContent: "space-between",
                  gap: 12, flexWrap: "wrap",
                  paddingTop: i === 0 ? 12 : 10,
                  paddingBottom: i === slotIds.length - 1 ? 0 : 10,
                  borderBottom: i === slotIds.length - 1
                    ? "none"
                    : `1px solid ${attentionBorder}`,
                }}
              >
                <div style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
                  {slot ? (
                    <span style={{
                      fontVariantNumeric: "tabular-nums",
                      fontSize: 14, fontWeight: 600,
                      color: "var(--fgColor-default, var(--uncon-fg, inherit))",
                    }}>
                      {fmtTimeShort(slot.starts_at, timeZone)}
                      <span style={{ color: muted, margin: "0 6px", fontWeight: 400 }}>→</span>
                      {fmtTimeShort(slot.ends_at, timeZone)}
                    </span>
                  ) : (
                    <span style={{ color: muted }}>—</span>
                  )}
                  <span style={{ fontSize: 12, color: muted }}>
                    {slot?.title ?? "Unconference slot"}
                  </span>
                </div>
                <Button size="small" variant="primary" onClick={() => onPick(sid)}>
                  Pick a session
                </Button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

type ScheduleSource = "unconference" | "static" | "mixer" | "expert";

const SOURCE_LABEL: Record<ScheduleSource, string> = {
  unconference: "unconference",
  static: "planned",
  mixer: "mixer",
  expert: "expert",
};

function ScheduleCard({
  title, source, manual, mandatory, isSubmitter,
  expectedAttendance, roomCapacity,
  startsAt, endsAt, room, timeZone,
  alternates, conflicts, onRoomClick, onChangeSession,
}: {
  title: string;
  source: ScheduleSource;
  /** True if the user manually picked this session (vs algorithm placement). */
  manual: boolean;
  /** Static rows: moderator marked this session as required for everyone. */
  mandatory: boolean;
  /** Static rows: true when the viewer is the linked submission's submitter
   *  (so they're speaking, not attending). Drives a "You're speaking" badge
   *  so the row reads correctly. */
  isSubmitter: boolean;
  /** Static rows only: how many people starred the linked submission
   *  (rough attendance estimate). Null for non-static sources. */
  expectedAttendance: number | null;
  /** Static rows only: capacity of the assigned room. Null when not applicable. */
  roomCapacity: number | null;
  startsAt: number;
  endsAt: number;
  room: Room | null | undefined;
  timeZone: string;
  /** Other times the same submission is scheduled. Path C surfaces these so
   *  the user understands sibling/repeat offerings are one session, not many. */
  alternates: { starts_at: number; title: string | null }[];
  /** Titles of other starred rows whose time window overlaps this one.
   *  Empty when there's no conflict. */
  conflicts: string[];
  /** Opens the room info sheet. When omitted the chip is non-interactive. */
  onRoomClick?: (room: Room) => void;
  /** Opens the session-switch picker. Only set for unconference sources. */
  onChangeSession?: () => void;
}) {
  // Soft capacity warning: only shown for non-mandatory planned tracks where
  // more participants starred the session than the room can hold. Advisory
  // only — the assignment algorithm never enforces a hard cap on stars.
  const showCapacityWarning =
    source === "static" && !mandatory
    && expectedAttendance !== null && roomCapacity !== null
    && expectedAttendance > roomCapacity;
  const muted = "var(--fgColor-muted, var(--uncon-fg-muted, #6e7781))";
  // Accent stripe per source: unconference = accent (blue), mixer = success
  // (green), expert = done (purple), planned = neutral.
  const accent = source === "unconference"
    ? "var(--borderColor-accent-emphasis, #0969da)"
    : source === "mixer"
      ? "var(--borderColor-success-emphasis, #1a7f37)"
      : source === "expert"
        ? "var(--borderColor-done-emphasis, #8250df)"
        : "var(--borderColor-neutral-emphasis, #6e7781)";

  return (
    <div style={{
      display: "grid",
      gridTemplateColumns: "auto 1fr auto",
      gap: 16,
      alignItems: "center",
      padding: "12px 16px",
      borderRadius: 8,
      border: "1px solid var(--borderColor-muted, var(--uncon-border-muted, #e5e7eb))",
      borderLeft: `4px solid ${accent}`,
      background: "var(--bgColor-default, var(--uncon-bg, transparent))",
    }}>
      <div style={{
        display: "flex", flexDirection: "column", alignItems: "flex-start",
        minWidth: 72,
        fontVariantNumeric: "tabular-nums",
      }}>
        <div style={{ fontSize: 18, fontWeight: 600, lineHeight: "22px" }}>
          {fmtTimeShort(startsAt, timeZone)}
        </div>
        <div style={{ fontSize: 12, color: muted, lineHeight: "16px" }}>
          → {fmtTimeShort(endsAt, timeZone)}
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
        <div style={{
          fontSize: 15, fontWeight: 600, lineHeight: "20px",
          wordBreak: "break-word",
        }}>
          {title}
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
          <Pill variant={
            source === "unconference" ? "primary"
              : source === "mixer" ? "success"
              : source === "expert" ? "primary"
              : "default"
          }>
            {SOURCE_LABEL[source]}
          </Pill>
          {mandatory && <Pill variant="attention">required</Pill>}
          {manual && <Pill variant="primary">manual pick</Pill>}
          {isSubmitter && <Pill variant="success">you&apos;re speaking</Pill>}
          {showCapacityWarning && (
            <Pill variant="attention">
              room may be crowded ({expectedAttendance}/{roomCapacity})
            </Pill>
          )}
          {conflicts.length > 0 && (
            <Pill variant="attention">
              conflicts with {conflicts[0]}{conflicts.length > 1 ? ` (+${conflicts.length - 1})` : ""}
            </Pill>
          )}
          {onChangeSession && (
            <button
              type="button"
              onClick={onChangeSession}
              style={{
                background: "transparent", border: "none", padding: 0,
                color: "var(--fgColor-accent, #2563eb)",
                fontFamily: "inherit", fontSize: 12,
                cursor: "pointer", textDecoration: "underline",
              }}
            >
              Change session
            </button>
          )}
        </div>
        {alternates.length > 0 && (() => {
          // Path C: same Submission scheduled in multiple offerings (e.g.
          // sibling slots of a series). One star → many rows; this caption
          // tells the user they're the same content so they can decide
          // which one to actually attend.
          //
          // When any alternate sits on a different conference-local day than
          // this row, prefix every alternate with the short day so the user
          // can tell "20:07" tomorrow from "20:07" today.
          const sortedAlts = [...alternates].sort((a, b) => a.starts_at - b.starts_at);
          const thisDay = dayKeyInTz(startsAt, timeZone);
          const multiDay = sortedAlts.some(
            (alt) => dayKeyInTz(alt.starts_at, timeZone) !== thisDay,
          );
          return (
            <div style={{ fontSize: 12, color: muted }}>
              Same session{alternates.length > 1 ? "s" : ""} also at{" "}
              {sortedAlts.map((alt, i) => (
                <span key={i} style={{ fontVariantNumeric: "tabular-nums" }}>
                  {i > 0 ? ", " : ""}
                  {multiDay
                    ? `${fmtDayShort(alt.starts_at, timeZone)} ${fmtTimeShort(alt.starts_at, timeZone)}`
                    : fmtTimeShort(alt.starts_at, timeZone)}
                </span>
              ))}
            </div>
          );
        })()}
      </div>

      {room && (
        onRoomClick ? (
          <button
            type="button"
            onClick={() => onRoomClick(room)}
            title={`View info for ${room.name}`}
            style={{
              display: "inline-flex", alignItems: "center", gap: 6,
              padding: "2px 10px", borderRadius: 999,
              background: "var(--bgColor-muted, var(--uncon-bg-subtle, rgba(0,0,0,0.05)))",
              color: muted,
              fontSize: 11, fontWeight: 600,
              textTransform: "uppercase", letterSpacing: 0.4,
              whiteSpace: "nowrap",
              border: "1px solid transparent",
              cursor: "pointer",
              fontFamily: "inherit",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.borderColor = "var(--borderColor-default, var(--uncon-border, #d0d7de))";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.borderColor = "transparent";
            }}
          >
            <span style={{
              display: "inline-block", width: 6, height: 6, borderRadius: "50%",
              background: "var(--borderColor-neutral-emphasis, var(--uncon-fg-muted, #6e7781))",
            }} />
            {room.name}
            <span style={{ opacity: 0.55, fontWeight: 400, fontSize: 10 }}>›</span>
          </button>
        ) : (
          <span style={{
            display: "inline-flex", alignItems: "center", gap: 6,
            padding: "2px 10px", borderRadius: 999,
            background: "var(--bgColor-muted, var(--uncon-bg-subtle, rgba(0,0,0,0.05)))",
            color: muted,
            fontSize: 11, fontWeight: 600,
            textTransform: "uppercase", letterSpacing: 0.4,
            whiteSpace: "nowrap",
          }}>
            <span style={{
              display: "inline-block", width: 6, height: 6, borderRadius: "50%",
              background: "var(--borderColor-neutral-emphasis, var(--uncon-fg-muted, #6e7781))",
            }} />
            {room.name}
          </span>
        )
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Subscribe-in-your-calendar card. One URL per user that works across every
// conference they're in — calendar apps subscribe and poll on their own.

function CalendarSubscribe({ slug }: { slug: string }) {
  const [path, setPath] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  useEffect(() => {
    api.conferences.getCalendar({ slug })
      .then((r) => setPath(r.path))
      .catch((e: unknown) => toast.error(errorCode(e)));
  }, [slug, toast]);

  const url = path ? `${window.location.origin}${path}` : "";
  // webcal:// scheme makes most native calendar apps offer one-click subscribe
  // on link click (Apple Calendar, Outlook, Thunderbird, Chrome Android).
  // Firefox Android deliberately blocks dispatch of non-allowlisted schemes
  // to external apps (Mozilla policy, not a per-device bug), so the click is
  // silently dropped there. Serving https:// instead would just download a
  // one-time .ics snapshot — losing the auto-update behavior promised by
  // the panel — so we show paste-by-URL instructions on Firefox Android
  // rather than a button that imports without subscribing.
  const isFirefoxAndroid = typeof navigator !== "undefined"
    && /Firefox/.test(navigator.userAgent)
    && /Android/.test(navigator.userAgent);
  const webcalUrl = path
    ? `webcal://${window.location.host}${path}`
    : "";

  async function reset() {
    if (!confirm("Generate a new link? Any calendar app currently subscribed will stop syncing until you give it the new URL.")) return;
    setBusy(true);
    try {
      const r = await api.conferences.resetCalendar({ slug });
      setPath(r.path);
    } catch (e) {
      toast.error(errorCode(e));
    } finally { setBusy(false); }
  }

  const muted = "var(--fgColor-muted, var(--uncon-fg-muted, #6e7781))";

  // Compact calendar glyph drawn inline so we don't depend on an icon library.
  const icon = (
    <svg width="20" height="20" viewBox="0 0 16 16" aria-hidden style={{ color: muted }}>
      <rect x="1.75" y="3" width="12.5" height="11.25" rx="1.5"
        fill="none" stroke="currentColor" strokeWidth="1.3" />
      <path d="M1.75 6.5 H14.25" stroke="currentColor" strokeWidth="1.3" />
      <path d="M5 1.5 V4.25 M11 1.5 V4.25"
        stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );

  return (
    <div style={{
      padding: 16,
      borderRadius: 10,
      border: "1px solid var(--borderColor-muted, var(--uncon-border-muted, #e5e7eb))",
      background: "var(--bgColor-default, var(--uncon-bg, transparent))",
    }}>
      <div style={{
        display: "grid",
        gridTemplateColumns: "auto 1fr",
        gap: "0 12px",
      }}>
        <div style={{ paddingTop: 1 }}>{icon}</div>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
            <strong style={{ fontSize: 14, lineHeight: "20px" }}>Sync to your calendar</strong>
            <span style={{ fontSize: 12, color: muted }}>
              iCalendar feed · updates automatically
            </span>
          </div>
          <div style={{ fontSize: 13, color: muted, marginTop: 2 }}>
            Subscribe in Apple Calendar, Google Calendar, Outlook, Thunderbird, or any iCal app.
          </div>

          {!path ? (
            <div style={{ marginTop: 12 }}><Spinner label="Loading…" /></div>
          ) : (
            <>
              {/* URL field with an inline Copy affordance on the right —
                  visually one element so the action is right where the URL is. */}
              <div style={{
                display: "flex", alignItems: "stretch",
                marginTop: 12,
                border: "1px solid var(--borderColor-default, var(--uncon-border, #d0d7de))",
                borderRadius: 8,
                background: "var(--bgColor-muted, var(--uncon-bg-subtle, rgba(0,0,0,0.03)))",
                overflow: "hidden",
              }}>
                <input
                  type="text"
                  value={url}
                  readOnly
                  onFocus={(e) => e.currentTarget.select()}
                  aria-label="Subscription URL"
                  style={{
                    flex: 1, minWidth: 0,
                    padding: "8px 10px",
                    border: "none",
                    background: "transparent",
                    color: "var(--fgColor-default, var(--uncon-fg, inherit))",
                    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                    fontSize: 12,
                    outline: "none",
                  }}
                />
                <CopyButton
                  variant="inset"
                  value={url}
                  disabled={busy}
                  successMessage="Calendar subscription URL copied."
                  fallbackPromptLabel="Copy this calendar subscription URL:"
                />
              </div>

              <div style={{
                display: "flex", alignItems: "center", justifyContent: "space-between",
                gap: 8, marginTop: 10, flexWrap: "wrap",
              }}>
                {isFirefoxAndroid ? (
                  // Firefox for Android can't launch external apps from
                  // webcal:// links, and importing the https:// .ics would
                  // be a one-time snapshot — not the subscription this
                  // panel promises. So instead of a broken/misleading
                  // button, tell the user how to subscribe manually using
                  // the URL above.
                  <div
                    style={{
                      flex: 1,
                      minWidth: 0,
                      fontSize: 12,
                      color: muted,
                      lineHeight: "16px",
                    }}
                  >
                    Firefox for Android can&apos;t open calendar links
                    directly. Copy the URL above and paste it into your
                    calendar app&apos;s &quot;Add by URL&quot; / &quot;Add
                    subscription&quot; setting to subscribe with
                    auto-updates.
                  </div>
                ) : (
                  // Rendered as a real anchor (not a button calling
                  // `window.location.assign`) so the browser treats the
                  // click as a normal link navigation. The webcal:// scheme
                  // is dispatched to the OS intent resolver, which hands
                  // off to Apple Calendar / Outlook / Google Calendar etc.
                  <a
                    href={webcalUrl}
                    aria-disabled={busy || undefined}
                    style={{
                      display: "inline-block",
                      padding: "5px 12px",
                      borderRadius: 6,
                      border: "1px solid rgba(27,31,36,0.15)",
                      background: busy
                        ? "var(--bgColor-disabled, var(--uncon-bg-subtle, #6e7781))"
                        : "var(--button-primary-bgColor-rest, var(--bgColor-success-emphasis, #1f883d))",
                      color: "var(--button-primary-fgColor-rest, #ffffff)",
                      fontFamily: "inherit",
                      fontSize: 12,
                      fontWeight: 600,
                      lineHeight: "20px",
                      textDecoration: "none",
                      cursor: busy ? "default" : "pointer",
                      pointerEvents: busy ? "none" : undefined,
                    }}
                  >
                    Open in calendar app
                  </a>
                )}
                <button
                  type="button"
                  onClick={reset}
                  disabled={busy}
                  style={{
                    background: "transparent", border: "none", padding: 0,
                    color: muted,
                    fontFamily: "inherit", fontSize: 12,
                    cursor: busy ? "default" : "pointer",
                    textDecoration: "underline",
                  }}
                  title="Generate a new URL and revoke this one"
                >
                  Reset link
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
