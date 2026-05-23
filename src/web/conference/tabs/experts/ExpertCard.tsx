import { Badge, Button, Stack, Text } from "../../../design-system";
import type { Room } from "../../types";
import { ProfileLink } from "../../ProfileLink";
import { SlotChip } from "./SlotChip";
import { fmtRange } from "./helpers";
import type { Expert, ExpertSlot } from "./types";

export function ExpertCard({
  slug, expert: e, rooms, isMod, timeZone,
  onBook, onCancel, onDemote, onAddTimeframe, onDeleteTimeframe, onEdit,
}: {
  slug: string;
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
            <div style={{ fontSize: 16, fontWeight: 600 }}>
              <ProfileLink
                slug={slug}
                identityId={e.identity_id}
                linkable={isMod || e.profile_published}
              >
                {display}
              </ProfileLink>
            </div>
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
