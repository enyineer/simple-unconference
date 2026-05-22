// Experts tab: lets owner/mods promote conference members to "Expert", define
// bookable timeframes, manage expert room pools, and lets every conference
// member browse experts and book a 1:1 slot.
//
// Privacy: non-mods never see other bookers' names/emails (parity with the
// submitter_email rule in Submissions). The booker sees their own row.

import { useEffect, useMemo, useState } from "react";
import {
  Badge, Banner, Button, DateTime, Form, Heading, Select, Sheet, Spinner,
  Stack, Text, TextInput, Textarea,
} from "../../design-system";
import { useToast } from "../../design-system/hooks";
import { api, errorCode } from "../../api";
import type { Role, Room, Participant } from "../types";
import { EmptyState } from "../ui/EmptyState";
import { SearchableSelect } from "../ui/SearchableSelect";
import { Tip } from "../ui/Tip";
import { formatInTz } from "../../../shared/tz";
import { useNow } from "../../useNow";

interface ExpertSlot {
  starts_at: number;
  ends_at: number;
  timeframe_id: number;
  booking_id: number | null;
  booker_name: string | null;
  booker_email: string | null;
  room_id: number | null;
  is_mine: boolean;
}
interface ExpertTimeframe {
  id: number;
  starts_at: number;
  ends_at: number;
  slot_duration_minutes: number;
}
interface Expert {
  id: number;
  identity_id: number;
  name: string | null;
  email: string | null;
  bio: string | null;
  pool_id: number | null;
  pool_name: string | null;
  room_ids: number[];
  timeframes: ExpertTimeframe[];
  slots: ExpertSlot[];
}
interface ExpertPool {
  id: number;
  name: string;
  room_ids: number[];
  expert_count: number;
}

export function ExpertsTab({
  slug, role, timeZone,
}: {
  slug: string;
  role: Role;
  timeZone: string;
}) {
  const isMod = role === "owner" || role === "moderator";

  const [experts, setExperts] = useState<Expert[] | null>(null);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [pools, setPools] = useState<ExpertPool[] | null>(null);
  const [people, setPeople] = useState<Participant[]>([]);
  const toast = useToast();

  const [poolsSheetOpen, setPoolsSheetOpen] = useState(false);
  const [promoteSheetOpen, setPromoteSheetOpen] = useState(false);
  const [tfExpertId, setTfExpertId] = useState<number | null>(null);
  const [editExpertId, setEditExpertId] = useState<number | null>(null);

  async function refresh() {
    try {
      const [ex, rs] = await Promise.all([
        api.experts.list({ slug }),
        api.rooms.list({ slug }),
      ]);
      setExperts(ex);
      setRooms(rs);
      if (isMod) {
        const [pp, ps] = await Promise.all([
          api.experts.listPools({ slug }),
          api.conferences.listParticipants({ slug }),
        ]);
        setPools(pp);
        setPeople(ps);
      }
    } catch (e) {
      toast.error(errorCode(e));
    }
  }
  useEffect(() => { refresh(); /* eslint-disable-line */ }, [slug, isMod]);

  async function book(expertId: number, slot: ExpertSlot) {
    try {
      await api.experts.book({ slug, expert_id: expertId, starts_at: slot.starts_at });
      toast.success("Booked. See you there!");
      await refresh();
    } catch (e) { toast.error(humanError(errorCode(e))); }
  }

  async function cancel(bookingId: number) {
    if (!confirm("Cancel this booking?")) return;
    try {
      await api.experts.cancelBooking({ slug, booking_id: bookingId });
      toast.success("Booking cancelled.");
      await refresh();
    } catch (e) { toast.error(humanError(errorCode(e))); }
  }

  async function demote(id: number) {
    if (!confirm("Remove expert status? All their timeframes and bookings will be deleted.")) return;
    try { await api.experts.demote({ slug, id }); }
    catch (e) { toast.error(humanError(errorCode(e))); }
    await refresh();
  }

  async function deleteTimeframe(expertId: number, id: number) {
    if (!confirm("Delete this timeframe? Existing bookings inside it will also be cancelled.")) return;
    try { await api.experts.deleteTimeframe({ slug, expert_id: expertId, id }); }
    catch (e) { toast.error(humanError(errorCode(e))); }
    await refresh();
  }

  const editingExpert = editExpertId
    ? experts?.find((e) => e.id === editExpertId) ?? null
    : null;
  const tfExpert = tfExpertId
    ? experts?.find((e) => e.id === tfExpertId) ?? null
    : null;

  // A new expert needs *something* to allocate as a room: either at least one
  // room (to be picked individually) or at least one pool (which itself must
  // contain rooms — empty pools wouldn't help, but creating them is on the
  // mod). Without either, promotion would always produce no_rooms_configured.
  const canPromote = rooms.length > 0 || (pools ?? []).length > 0;

  return (
    <Stack gap="spacious">
      <Stack direction="row" justify="between" align="center" wrap>
        <Heading level={2}>Experts</Heading>
        {isMod && (
          <Stack direction="row" gap="condensed">
            <Button onClick={() => setPoolsSheetOpen(true)}>Room pools</Button>
            <Button
              variant="primary"
              disabled={!canPromote}
              onClick={() => setPromoteSheetOpen(true)}
            >
              + Promote expert
            </Button>
          </Stack>
        )}
      </Stack>

      <Tip>
        Book a 1:1 chat with an expert. Each expert offers timeframes with
        fixed-length slots — pick one that works for you. A room is assigned
        automatically when you book.
      </Tip>

      {isMod && !canPromote && (
        // Persistent precondition — *not* a transient action result, so it
        // stays as an inline Banner. Tells the mod which prerequisite they
        // need to satisfy before "+ Promote expert" can be used.
        <Banner variant="warning">
          You need at least one room (Rooms tab) or one room pool before you can
          promote an expert.
        </Banner>
      )}

      {!experts ? (
        <Spinner label="Loading…" />
      ) : experts.length === 0 ? (
        <EmptyState message={isMod
          ? "No experts yet. Promote someone from your People list."
          : "No experts yet. The organizers haven't set any up."} />
      ) : (
        <Stack gap="spacious">
          {experts.map((e) => (
            <ExpertCard
              key={e.id}
              expert={e}
              rooms={rooms}
              isMod={isMod}
              timeZone={timeZone}
              onBook={(slot) => book(e.id, slot)}
              onCancel={cancel}
              onDemote={() => demote(e.id)}
              onAddTimeframe={() => setTfExpertId(e.id)}
              onDeleteTimeframe={(tfId) => deleteTimeframe(e.id, tfId)}
              onEdit={() => setEditExpertId(e.id)}
            />
          ))}
        </Stack>
      )}

      {isMod && (
        <PromoteExpertSheet
          open={promoteSheetOpen}
          slug={slug}
          rooms={rooms}
          pools={pools ?? []}
          people={people}
          existingExpertIdentityIds={new Set((experts ?? []).map((e) => e.identity_id))}
          onClose={() => setPromoteSheetOpen(false)}
          onDone={() => { setPromoteSheetOpen(false); refresh(); }}
        />
      )}

      {isMod && editingExpert && (
        <EditExpertSheet
          open
          slug={slug}
          expert={editingExpert}
          rooms={rooms}
          pools={pools ?? []}
          onClose={() => setEditExpertId(null)}
          onDone={() => { setEditExpertId(null); refresh(); }}
        />
      )}

      {isMod && tfExpert && (
        <TimeframeSheet
          open
          slug={slug}
          expert={tfExpert}
          timeZone={timeZone}
          onClose={() => setTfExpertId(null)}
          onDone={() => { setTfExpertId(null); refresh(); }}
        />
      )}

      {isMod && (
        <PoolsSheet
          open={poolsSheetOpen}
          slug={slug}
          rooms={rooms}
          pools={pools ?? []}
          onClose={() => setPoolsSheetOpen(false)}
          onDone={() => { refresh(); }}
        />
      )}
    </Stack>
  );
}

// ---------------------------------------------------------------------------
// ExpertCard — one expert, their bio, their slots.
// ---------------------------------------------------------------------------

function ExpertCard({
  expert: e, rooms, isMod, timeZone,
  onBook, onCancel, onDemote, onAddTimeframe, onDeleteTimeframe, onEdit,
}: {
  expert: Expert;
  rooms: Room[];
  isMod: boolean;
  timeZone: string;
  onBook: (slot: ExpertSlot) => void;
  onCancel: (bookingId: number) => void;
  onDemote: () => void;
  onAddTimeframe: () => void;
  onDeleteTimeframe: (id: number) => void;
  onEdit: () => void;
}) {
  const muted = "var(--fgColor-muted, var(--uncon-fg-muted, #6e7781))";
  const display = e.name || e.email || `Expert #${e.id}`;
  const initial = (display.trim().charAt(0) || "?").toUpperCase();

  const hasBookingConfig = e.pool_id !== null || e.room_ids.length > 0;
  const myBooking = e.slots.find((s) => s.is_mine);

  return (
    <div style={{
      padding: 16,
      borderRadius: 8,
      border: "1px solid var(--borderColor-muted, var(--uncon-border-muted, #e5e7eb))",
      background: "var(--bgColor-default, var(--uncon-bg, transparent))",
    }}>
      <Stack direction="row" justify="between" align="start" gap="normal" wrap>
        <Stack direction="row" gap="normal" align="center">
          <div
            aria-hidden
            style={{
              width: 40, height: 40, borderRadius: "50%",
              background: "var(--bgColor-muted, var(--uncon-bg-subtle, rgba(0,0,0,0.06)))",
              color: muted,
              display: "flex", alignItems: "center", justifyContent: "center",
              fontWeight: 600, fontSize: 16,
            }}
          >
            {initial}
          </div>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 16, fontWeight: 600 }}>{display}</div>
            {isMod && e.email && (
              <div style={{ fontSize: 12, color: muted }}>{e.email}</div>
            )}
            <Stack direction="row" gap="condensed" align="center" wrap>
              <Badge variant="primary">Expert</Badge>
              {e.pool_id !== null && e.pool_name && (
                <Badge variant="default">Pool: {e.pool_name}</Badge>
              )}
              {e.pool_id === null && e.room_ids.length > 0 && (
                <Badge variant="default">
                  {e.room_ids.length} room{e.room_ids.length === 1 ? "" : "s"}
                </Badge>
              )}
              {!hasBookingConfig && (
                <Badge variant="danger">No rooms configured</Badge>
              )}
            </Stack>
          </div>
        </Stack>

        {isMod && (
          <Stack direction="row" gap="condensed">
            <Button size="small" onClick={onEdit}>Edit</Button>
            <Button size="small" onClick={onAddTimeframe}>+ Timeframe</Button>
            <Button size="small" variant="danger" onClick={onDemote}>Demote</Button>
          </Stack>
        )}
      </Stack>

      {e.bio && (
        <div style={{ marginTop: 10, fontSize: 14, lineHeight: 1.5, whiteSpace: "pre-wrap" }}>
          {e.bio}
        </div>
      )}

      {myBooking && (
        <div style={{
          marginTop: 12, padding: 10, borderRadius: 6,
          background: "var(--bgColor-success-muted, rgba(46,160,67,0.12))",
          color: "var(--fgColor-success, #1a7f37)",
          fontSize: 13,
        }}>
          <strong>Your booking:</strong>{" "}
          {fmtRange(myBooking.starts_at, myBooking.ends_at, timeZone)}
          {myBooking.room_id !== null && (
            <> in {rooms.find((r) => r.id === myBooking.room_id)?.name ?? `room #${myBooking.room_id}`}</>
          )}
          {" — "}
          <button
            type="button"
            onClick={() => onCancel(myBooking.booking_id!)}
            style={{
              background: "transparent", border: "none", padding: 0,
              color: "inherit", textDecoration: "underline", cursor: "pointer",
              fontSize: 13,
            }}
          >
            cancel
          </button>
        </div>
      )}

      <div style={{ marginTop: 14 }}>
        {e.slots.length === 0 ? (
          <Text muted>No bookable slots yet.</Text>
        ) : (
          <Stack gap="condensed">
            {e.timeframes.map((tf) => {
              const slotsInTf = e.slots.filter((s) => s.timeframe_id === tf.id);
              return (
                <div key={tf.id}>
                  <Stack direction="row" justify="between" align="center" wrap>
                    <Text muted>
                      {fmtRange(tf.starts_at, tf.ends_at, timeZone)} · {tf.slot_duration_minutes}-min slots
                    </Text>
                    {isMod && (
                      <Button size="small" variant="invisible" onClick={() => onDeleteTimeframe(tf.id)}>
                        Delete timeframe
                      </Button>
                    )}
                  </Stack>
                  <div style={{
                    marginTop: 6,
                    display: "grid",
                    gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))",
                    gap: 6,
                  }}>
                    {slotsInTf.map((s) => (
                      <SlotChip
                        key={s.starts_at}
                        slot={s}
                        rooms={rooms}
                        canBook={hasBookingConfig}
                        timeZone={timeZone}
                        isMod={isMod}
                        onBook={() => onBook(s)}
                        onCancel={() => s.booking_id !== null && onCancel(s.booking_id)}
                      />
                    ))}
                  </div>
                </div>
              );
            })}
          </Stack>
        )}
      </div>
    </div>
  );
}

function SlotChip({
  slot: s, rooms, canBook, timeZone, isMod, onBook, onCancel,
}: {
  slot: ExpertSlot;
  rooms: Room[];
  canBook: boolean;
  timeZone: string;
  isMod: boolean;
  onBook: () => void;
  onCancel: () => void;
}) {
  const muted = "var(--fgColor-muted, var(--uncon-fg-muted, #6e7781))";
  const now = useNow();
  const isPast = s.starts_at <= now;
  const isBooked = s.booking_id !== null;

  const bg = s.is_mine
    ? "var(--bgColor-success-muted, rgba(46,160,67,0.10))"
    : isBooked
      ? "var(--bgColor-muted, var(--uncon-bg-subtle, rgba(0,0,0,0.04)))"
      : "var(--bgColor-default, var(--uncon-bg, transparent))";
  const border = s.is_mine
    ? "1px solid var(--borderColor-success-muted, rgba(46,160,67,0.4))"
    : "1px solid var(--borderColor-muted, var(--uncon-border-muted, #e5e7eb))";

  return (
    <div style={{
      padding: 8, borderRadius: 6, border, background: bg,
      display: "flex", flexDirection: "column", gap: 4,
      opacity: isPast && !s.is_mine ? 0.5 : 1,
    }}>
      <div style={{ fontSize: 13, fontWeight: 500 }}>
        {fmtTime(s.starts_at, timeZone)} – {fmtTime(s.ends_at, timeZone)}
      </div>
      {isBooked ? (
        <>
          <div style={{ fontSize: 11, color: muted }}>
            {s.is_mine
              ? "You — "
              : isMod
                ? `${s.booker_name || s.booker_email || "Booked"} — `
                : "Booked"}
            {s.room_id !== null && (
              <span>{rooms.find((r) => r.id === s.room_id)?.name ?? "room"}</span>
            )}
          </div>
          {(s.is_mine || isMod) && !isPast && (
            <Button size="small" variant="invisible" onClick={onCancel}>Cancel</Button>
          )}
        </>
      ) : isPast ? (
        <div style={{ fontSize: 11, color: muted }}>Past</div>
      ) : (
        <Button
          size="small"
          variant="primary"
          disabled={!canBook}
          onClick={onBook}
        >
          Book
        </Button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// PromoteExpertSheet — pick a member, optional bio, choose pool OR rooms.
// ---------------------------------------------------------------------------

function PromoteExpertSheet({
  open, slug, rooms, pools, people, existingExpertIdentityIds, onClose, onDone,
}: {
  open: boolean;
  slug: string;
  rooms: Room[];
  pools: ExpertPool[];
  people: Participant[];
  existingExpertIdentityIds: Set<number>;
  onClose: () => void;
  onDone: () => void;
}) {
  const [identityId, setIdentityId] = useState<string>("");
  const [bio, setBio] = useState("");
  const [mode, setMode] = useState<"pool" | "rooms">("pool");
  const [poolId, setPoolId] = useState<string>("");
  const [roomIds, setRoomIds] = useState<Set<number>>(new Set());
  const toast = useToast();

  const candidates = useMemo(
    () => people.filter((p) => !existingExpertIdentityIds.has(p.user_id)),
    [people, existingExpertIdentityIds],
  );

  // Reset fields when the sheet closes. Detected via the "previous value"
  // pattern (adjusting state during render) rather than an effect so the
  // next render already shows the cleared values when the user reopens.
  const [wasOpen, setWasOpen] = useState(open);
  if (wasOpen !== open) {
    setWasOpen(open);
    if (!open) {
      setIdentityId(""); setBio(""); setMode("pool");
      setPoolId(""); setRoomIds(new Set());
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!identityId) { toast.error("Pick a member."); return; }
    try {
      await api.experts.promote({
        slug,
        identity_id: Number(identityId),
        bio: bio.trim() || undefined,
        pool_id: mode === "pool" && poolId ? Number(poolId) : null,
        room_ids: mode === "rooms" ? [...roomIds] : undefined,
      });
      onDone();
    } catch (err) { toast.error(humanError(errorCode(err))); }
  }

  return (
    <Sheet open={open} onClose={onClose} title="Promote to expert">
      <Form onSubmit={submit}>
        <SearchableSelect
          label="Member"
          value={identityId}
          onChange={setIdentityId}
          options={[
            { value: "", label: "Pick a conference member…" },
            ...candidates.map((p) => ({
              value: String(p.user_id),
              label: p.name && p.name.trim() ? p.name : p.email,
              hint: p.name && p.name.trim() ? p.email : undefined,
            })),
          ]}
          placeholder="Search by name or email…"
        />
        <Textarea
          label="Bio / expertise (shown to all members)"
          rows={3}
          value={bio}
          onChange={(e) => setBio(e.target.value)}
          placeholder="e.g. 10y Rust, distributed systems, happy to talk about anything"
        />
        <Select
          label="Rooms for bookings"
          value={mode}
          onChange={(e) => setMode(e.target.value as "pool" | "rooms")}
          options={[
            { value: "pool", label: "From a pool" },
            { value: "rooms", label: "Specific rooms" },
          ]}
        />
        {mode === "pool" ? (
          <SearchableSelect
            label="Pool"
            value={poolId}
            onChange={setPoolId}
            options={[
              { value: "", label: "— No pool (booking will fail) —" },
              ...pools.map((p) => ({
                value: String(p.id),
                label: p.name,
                hint: `${p.room_ids.length} room${p.room_ids.length === 1 ? "" : "s"}`,
              })),
            ]}
            placeholder="Search pools…"
          />
        ) : (
          <RoomCheckboxes rooms={rooms} value={roomIds} onChange={setRoomIds} />
        )}
        <Stack direction="row" gap="condensed">
          <Button type="submit" variant="primary">Promote</Button>
          <Button onClick={onClose}>Cancel</Button>
        </Stack>
      </Form>
    </Sheet>
  );
}

// ---------------------------------------------------------------------------
// EditExpertSheet — change bio / pool / rooms after promotion.
// ---------------------------------------------------------------------------

function EditExpertSheet({
  open, slug, expert, rooms, pools, onClose, onDone,
}: {
  open: boolean;
  slug: string;
  expert: Expert;
  rooms: Room[];
  pools: ExpertPool[];
  onClose: () => void;
  onDone: () => void;
}) {
  const [bio, setBio] = useState(expert.bio ?? "");
  const [mode, setMode] = useState<"pool" | "rooms">(expert.pool_id !== null ? "pool" : "rooms");
  const [poolId, setPoolId] = useState<string>(expert.pool_id !== null ? String(expert.pool_id) : "");
  const [roomIds, setRoomIds] = useState<Set<number>>(new Set(expert.room_ids));
  const toast = useToast();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    try {
      await api.experts.update({
        slug,
        id: expert.id,
        bio: bio.trim() || null,
        pool_id: mode === "pool" && poolId ? Number(poolId) : null,
        room_ids: mode === "rooms" ? [...roomIds] : [],
      });
      onDone();
    } catch (err) { toast.error(humanError(errorCode(err))); }
  }

  const display = expert.name || expert.email || `Expert #${expert.id}`;
  return (
    <Sheet open={open} onClose={onClose} title={`Edit ${display}`}>
      <Form onSubmit={submit}>
        <Textarea
          label="Bio"
          rows={3}
          value={bio}
          onChange={(e) => setBio(e.target.value)}
        />
        <Select
          label="Rooms for bookings"
          value={mode}
          onChange={(e) => setMode(e.target.value as "pool" | "rooms")}
          options={[
            { value: "pool", label: "From a pool" },
            { value: "rooms", label: "Specific rooms" },
          ]}
        />
        {mode === "pool" ? (
          <SearchableSelect
            label="Pool"
            value={poolId}
            onChange={setPoolId}
            options={[
              { value: "", label: "— No pool —" },
              ...pools.map((p) => ({
                value: String(p.id),
                label: p.name,
                hint: `${p.room_ids.length} room${p.room_ids.length === 1 ? "" : "s"}`,
              })),
            ]}
            placeholder="Search pools…"
          />
        ) : (
          <RoomCheckboxes rooms={rooms} value={roomIds} onChange={setRoomIds} />
        )}
        <Stack direction="row" gap="condensed">
          <Button type="submit" variant="primary">Save</Button>
          <Button onClick={onClose}>Cancel</Button>
        </Stack>
      </Form>
    </Sheet>
  );
}

// ---------------------------------------------------------------------------
// TimeframeSheet — add a new timeframe to an expert.
// ---------------------------------------------------------------------------

function TimeframeSheet({
  open, slug, expert, timeZone, onClose, onDone,
}: {
  open: boolean;
  slug: string;
  expert: Expert;
  timeZone: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [startsAt, setStartsAt] = useState<number>(() => {
    return Math.ceil(Date.now() / 3_600_000) * 3_600_000;
  });
  const [endsAt, setEndsAt] = useState<number>(() => {
    return Math.ceil(Date.now() / 3_600_000) * 3_600_000 + 60 * 60_000;
  });
  const [duration, setDuration] = useState<string>("15");
  const toast = useToast();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const mins = Number(duration);
    if (!Number.isFinite(mins) || mins < 5) { toast.error("Slot length must be at least 5 minutes."); return; }
    if (endsAt <= startsAt) { toast.error("End must be after start."); return; }
    if ((endsAt - startsAt) < mins * 60_000) { toast.error("Timeframe is shorter than one slot."); return; }
    try {
      await api.experts.createTimeframe({
        slug,
        expert_id: expert.id,
        starts_at: startsAt,
        ends_at: endsAt,
        slot_duration_minutes: mins,
      });
      onDone();
    } catch (err) { toast.error(humanError(errorCode(err))); }
  }

  const display = expert.name || expert.email || `Expert #${expert.id}`;
  return (
    <Sheet open={open} onClose={onClose} title={`Timeframe for ${display}`}>
      <Tip>
        Slots are generated automatically — a 60-minute window with 15-minute
        slots produces 4 bookable slots.
      </Tip>
      <Form onSubmit={submit}>
        <DateTime
          label="Starts at"
          value={startsAt}
          onChange={setStartsAt}
          timeZone={timeZone}
          max={endsAt}
        />
        <DateTime
          label="Ends at"
          value={endsAt}
          onChange={setEndsAt}
          timeZone={timeZone}
          min={startsAt}
        />
        <TextInput
          label="Slot length (minutes)"
          type="number"
          value={duration}
          onChange={(e) => setDuration(e.target.value)}
        />
        <Stack direction="row" gap="condensed">
          <Button type="submit" variant="primary">Add timeframe</Button>
          <Button onClick={onClose}>Cancel</Button>
        </Stack>
      </Form>
    </Sheet>
  );
}

// ---------------------------------------------------------------------------
// PoolsSheet — CRUD for the conference's expert room pools.
// ---------------------------------------------------------------------------

function PoolsSheet({
  open, slug, rooms, pools, onClose, onDone,
}: {
  open: boolean;
  slug: string;
  rooms: Room[];
  pools: ExpertPool[];
  onClose: () => void;
  onDone: () => void;
}) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [roomIds, setRoomIds] = useState<Set<number>>(new Set());
  const toast = useToast();

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) { toast.error("Pool name is required."); return; }
    try {
      await api.experts.createPool({ slug, name: name.trim(), room_ids: [...roomIds] });
      setName(""); setRoomIds(new Set()); setCreating(false);
      onDone();
    } catch (err) { toast.error(humanError(errorCode(err))); }
  }

  async function remove(id: number) {
    if (!confirm("Delete this pool? Experts using it will be left without rooms.")) return;
    try { await api.experts.deletePool({ slug, id }); }
    catch (err) { toast.error(humanError(errorCode(err))); }
    onDone();
  }

  return (
    <Sheet open={open} onClose={onClose} title="Expert room pools">
      <Tip>
        A pool is a named set of rooms reserved for expert chats. Assign an
        expert to a pool and bookings will draw the first available room from
        it. You can also assign specific rooms per expert instead.
      </Tip>
      <Stack gap="spacious">
        {pools.length === 0 ? (
          <EmptyState message="No pools yet." />
        ) : (
          <Stack gap="condensed">
            {pools.map((p) => (
              <PoolRow
                key={p.id}
                pool={p}
                rooms={rooms}
                slug={slug}
                onChanged={onDone}
                onDelete={() => remove(p.id)}
              />
            ))}
          </Stack>
        )}
        {!creating ? (
          <Stack direction="row" gap="condensed">
            <Button onClick={() => setCreating(true)}>+ Add pool</Button>
          </Stack>
        ) : (
          <Form onSubmit={create}>
            <TextInput
              label="Pool name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Quiet corners"
            />
            <RoomCheckboxes rooms={rooms} value={roomIds} onChange={setRoomIds} />
            <Stack direction="row" gap="condensed">
              <Button type="submit" variant="primary">Create pool</Button>
              <Button onClick={() => setCreating(false)}>Cancel</Button>
            </Stack>
          </Form>
        )}
      </Stack>
    </Sheet>
  );
}

function PoolRow({
  pool, rooms, slug, onChanged, onDelete,
}: {
  pool: ExpertPool;
  rooms: Room[];
  slug: string;
  onChanged: () => void;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(pool.name);
  const [roomIds, setRoomIds] = useState<Set<number>>(new Set(pool.room_ids));
  const toast = useToast();

  async function save() {
    try {
      await api.experts.updatePool({ slug, id: pool.id, name: name.trim() || pool.name, room_ids: [...roomIds] });
      setEditing(false);
      onChanged();
    } catch (e) { toast.error(humanError(errorCode(e))); }
  }

  return (
    <div style={{
      padding: 12,
      borderRadius: 8,
      border: "1px solid var(--borderColor-muted, var(--uncon-border-muted, #e5e7eb))",
    }}>
      {!editing ? (
        <Stack direction="row" justify="between" align="center" wrap>
          <div>
            <div style={{ fontWeight: 600 }}>{pool.name}</div>
            <Text muted>
              {pool.room_ids.length} room{pool.room_ids.length === 1 ? "" : "s"} ·{" "}
              {pool.expert_count} expert{pool.expert_count === 1 ? "" : "s"}
            </Text>
          </div>
          <Stack direction="row" gap="condensed">
            <Button size="small" onClick={() => setEditing(true)}>Edit</Button>
            <Button size="small" variant="danger" onClick={onDelete}>Delete</Button>
          </Stack>
        </Stack>
      ) : (
        <Stack gap="condensed">
          <TextInput label="Pool name" value={name} onChange={(e) => setName(e.target.value)} />
          <RoomCheckboxes rooms={rooms} value={roomIds} onChange={setRoomIds} />
          <Stack direction="row" gap="condensed">
            <Button size="small" variant="primary" onClick={save}>Save</Button>
            <Button size="small" onClick={() => { setEditing(false); setName(pool.name); setRoomIds(new Set(pool.room_ids)); }}>Cancel</Button>
          </Stack>
        </Stack>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------

function RoomCheckboxes({
  rooms, value, onChange,
}: {
  rooms: Room[];
  value: Set<number>;
  onChange: (next: Set<number>) => void;
}) {
  if (rooms.length === 0) {
    return <Text muted>No rooms yet — add some on the Rooms tab first.</Text>;
  }
  return (
    <div style={{
      display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))",
      gap: 6,
    }}>
      {rooms.map((r) => {
        const on = value.has(r.id);
        return (
          <label
            key={r.id}
            style={{
              display: "flex", alignItems: "center", gap: 8,
              padding: 8, borderRadius: 6,
              border: "1px solid var(--borderColor-muted, var(--uncon-border-muted, #e5e7eb))",
              background: on ? "var(--bgColor-accent-muted, rgba(64,132,246,0.08))" : "transparent",
              cursor: "pointer",
              fontSize: 13,
            }}
          >
            <input
              type="checkbox"
              checked={on}
              onChange={() => {
                const next = new Set(value);
                if (on) next.delete(r.id); else next.add(r.id);
                onChange(next);
              }}
            />
            <span>{r.name}</span>
          </label>
        );
      })}
    </div>
  );
}

function fmtRange(startMs: number, endMs: number, tz: string): string {
  const sameDay = formatInTz(startMs, tz, { year: "numeric", month: "2-digit", day: "2-digit" })
    === formatInTz(endMs, tz, { year: "numeric", month: "2-digit", day: "2-digit" });
  const dateLabel = formatInTz(startMs, tz, { weekday: "short", month: "short", day: "numeric" });
  const startTime = formatInTz(startMs, tz, { hour: "2-digit", minute: "2-digit" });
  const endTime = formatInTz(endMs, tz, { hour: "2-digit", minute: "2-digit" });
  if (sameDay) return `${dateLabel}, ${startTime}-${endTime}`;
  const endDate = formatInTz(endMs, tz, { weekday: "short", month: "short", day: "numeric" });
  return `${dateLabel} ${startTime} – ${endDate} ${endTime}`;
}

function fmtTime(ms: number, tz: string): string {
  return formatInTz(ms, tz, { hour: "2-digit", minute: "2-digit" });
}

function humanError(code: string): string {
  return ({
    cannot_book_self: "You can't book yourself.",
    slot_not_found: "That slot no longer exists.",
    slot_in_past: "That slot is in the past.",
    already_booked_expert: "You already booked this expert. Cancel your existing booking first.",
    overlapping_booking: "You already have a booking that overlaps this slot.",
    no_room_available: "Every eligible room is busy at that time. Try a different slot.",
    no_rooms_configured: "This expert has no rooms set up yet.",
    pool_name_taken: "A pool with that name already exists.",
    already_expert: "That person is already an expert.",
    not_a_member: "That person is not in this conference.",
    pool_not_found: "Pool not found.",
    timeframe_too_short: "The timeframe is shorter than one slot.",
    ends_before_starts: "End time must be after start time.",
  } as Record<string, string>)[code] ?? code;
}
