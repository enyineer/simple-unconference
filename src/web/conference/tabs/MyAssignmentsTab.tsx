import { useCallback, useEffect, useState } from "react";
import {
  Heading, Spinner, Stack,
} from "../../design-system";
import { api } from "../../api";
import { clipToMinute, formatInTz } from "../../../shared/tz";
import type { AgendaData, MyAssignments, Room, Submission } from "../types";
import { EmptyState } from "../ui/EmptyState";
import { RoomInfoSheet } from "../ui/RoomInfoSheet";
import { SessionPicker } from "../ui/SessionPicker";
import { UnplacedCard } from "./my-assignments/UnplacedCard";
import { ScheduleCard } from "./my-assignments/ScheduleCard";
import { CalendarSubscribe } from "./my-assignments/CalendarSubscribe";

export function MyAssignmentsTab({
  slug, timeZone,
}: {
  slug: string;
  timeZone: string;
}) {
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
    api.rooms.listAll({ slug }),
    api.submissions.listAll({ slug, status: "published" }),
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
        setAgenda({ slots: [], slot_series: [], tracks: [], placements: [], mixer_placements: [], participant_count: null });
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
