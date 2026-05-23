import { useEffect, useState } from "react";
import { Badge, Button, Stack } from "../../../design-system";
import { api } from "../../../api";
import type { Room, Slot, Submission } from "../../types";
import { ProfileLink } from "../../ProfileLink";
import { SessionPicker } from "../../ui/SessionPicker";

export function UnconferenceBody({
  slug,
  slot,
  subs,
  rooms,
  placements,
  onChange,
  isMod,
}: {
  slug: string;
  slot: Slot;
  subs: Submission[];
  rooms: Room[];
  placements: {
    slot_id: number;
    submission_id: number;
    room_id: number;
    attendee_count: number;
    star_count: number;
    room_capacity: number;
  }[];
  onChange: () => Promise<void>;
  isMod: boolean;
}) {
  const [myAssignment, setMyAssignment] = useState<{
    submission_id: number | null;
    manual: boolean;
  } | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);

  // Pull just this user's row for the slot so we can show "Your session" and
  // open the picker with the right "current pick" highlighted.
  useEffect(() => {
    api.agenda
      .myAssignments({ slug })
      .then((m) => {
        const a = m.assignments.find(
          (x) => x.slot_id === slot.id && x.source === "unconference",
        );
        setMyAssignment(
          a
            ? { submission_id: a.submission_id, manual: a.manual ?? false }
            : null,
        );
      })
      .catch(() => setMyAssignment(null));
  }, [slug, slot.id, placements]);

  const subById = new Map(subs.map((s) => [s.id, s]));
  const roomById = new Map(rooms.map((r) => [r.id, r]));

  const eligibleRooms = slot.unconf_use_all_rooms
    ? rooms
    : rooms.filter((r) => slot.unconf_room_ids.includes(r.id));
  const eligibleSubs = slot.unconf_use_all_submissions
    ? subs
    : subs.filter((s) => slot.unconf_submission_ids.includes(s.id));

  const muted = "var(--fgColor-muted, var(--uncon-fg-muted, #6e7781))";

  const summaryPillStyle: React.CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    padding: "4px 10px",
    borderRadius: 999,
    background:
      "var(--bgColor-muted, var(--uncon-bg-subtle, rgba(0,0,0,0.05)))",
    color: muted,
    fontSize: 12,
    lineHeight: "16px",
    whiteSpace: "nowrap",
  };

  // The Change-session row is participant-facing. We show it whenever the
  // slot has placements (the picker would be empty otherwise), regardless of
  // whether the user is currently placed — it doubles as "pick a session"
  // for unplaced and "switch session" for placed.
  const showSwitcher = placements.length > 0;
  const currentSub = myAssignment?.submission_id ?? null;
  const currentSubTitle = currentSub
    ? subById.get(currentSub)?.title ?? `#${currentSub}`
    : null;

  return (
    <Stack gap="condensed">
      <div
        style={{
          display: "flex",
          gap: 8,
          flexWrap: "wrap",
          alignItems: "center",
        }}
      >
        <span style={summaryPillStyle}>
          Rooms: {eligibleRooms.length}
          {slot.unconf_use_all_rooms ? " (all)" : ""}
        </span>
        <span style={summaryPillStyle}>
          Submissions: {eligibleSubs.length}
          {slot.unconf_use_all_submissions ? " (all)" : ""}
        </span>
      </div>

      {showSwitcher && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            flexWrap: "wrap",
            padding: "10px 12px",
            borderRadius: 8,
            border:
              "1px solid var(--borderColor-muted, var(--uncon-border-muted, #e5e7eb))",
            background:
              "var(--bgColor-muted, var(--uncon-bg-subtle, rgba(0,0,0,0.03)))",
          }}
        >
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 2,
              minWidth: 0,
            }}
          >
            <span
              style={{
                fontSize: 12,
                color: muted,
                textTransform: "uppercase",
                letterSpacing: 0.4,
                fontWeight: 600,
              }}
            >
              Your session
            </span>
            <span style={{ fontSize: 14, wordBreak: "break-word" }}>
              {currentSubTitle ?? "Not assigned yet"}
              {myAssignment?.manual && (
                <span
                  style={{
                    marginLeft: 6,
                    color: "var(--fgColor-accent, #2563eb)",
                    fontSize: 11,
                    fontWeight: 600,
                  }}
                >
                  · manual pick
                </span>
              )}
            </span>
          </div>
          <Button
            size="small"
            variant={currentSub ? "default" : "primary"}
            onClick={() => setPickerOpen(true)}
          >
            {currentSub ? "Change session" : "Pick a session"}
          </Button>
        </div>
      )}

      <SessionPicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        slug={slug}
        slotId={slot.id}
        placements={placements}
        subs={subs}
        rooms={rooms}
        currentSubmissionId={currentSub}
        onChanged={onChange}
      />

      {placements.length === 0 ? (
        <div
          style={{
            padding: 16,
            borderRadius: 8,
            border:
              "1px dashed var(--borderColor-muted, var(--uncon-border-muted, #d0d7de))",
            color: muted,
            fontSize: 13,
            textAlign: "center",
          }}
        >
          No placements yet — run assignment to fill.
        </div>
      ) : (
        <Stack gap="condensed">
          {placements.map((p) => {
            const sub = subById.get(p.submission_id);
            const room = roomById.get(p.room_id);
            return (
              <div
                key={p.submission_id}
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr auto",
                  gap: "8px 12px",
                  padding: 12,
                  borderRadius: 8,
                  border: `1px solid var(--borderColor-muted, var(--uncon-border-muted, #e5e7eb))`,
                  background:
                    "var(--bgColor-default, var(--uncon-bg, transparent))",
                }}
              >
                <span
                  style={{
                    gridColumn: 1,
                    gridRow: 1,
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                    padding: "2px 8px",
                    borderRadius: 999,
                    background:
                      "var(--bgColor-muted, var(--uncon-bg-subtle, rgba(0,0,0,0.05)))",
                    color: muted,
                    fontSize: 11,
                    fontWeight: 600,
                    textTransform: "uppercase",
                    letterSpacing: 0.4,
                    width: "fit-content",
                  }}
                >
                  <span
                    style={{
                      display: "inline-block",
                      width: 6,
                      height: 6,
                      borderRadius: "50%",
                      background:
                        "var(--borderColor-neutral-emphasis, var(--uncon-fg-muted, #6e7781))",
                    }}
                  />
                  {room?.name ?? "?"}
                  {room && (
                    <span style={{ opacity: 0.6, fontWeight: 400 }}>
                      · {room.capacity}
                    </span>
                  )}
                </span>
                <div
                  style={{
                    gridColumn: 2,
                    gridRow: 1,
                    display: "flex",
                    gap: 6,
                    alignItems: "center",
                  }}
                >
                  {p.star_count > p.room_capacity && (
                    <span
                      title={`${p.star_count} people starred this session — the room holds ${p.room_capacity}. The algorithm placed ${p.attendee_count}; the remaining ${p.star_count - p.attendee_count} starrers are unplaced or in another starred session.`}
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 4,
                        padding: "2px 8px",
                        borderRadius: 999,
                        background:
                          "var(--bgColor-danger-muted, rgba(207,34,46,0.12))",
                        color: "var(--fgColor-danger, #cf222e)",
                        fontSize: 11,
                        fontWeight: 600,
                        textTransform: "uppercase",
                        letterSpacing: 0.4,
                      }}
                    >
                      ⚠ Room may be full ({p.star_count}/{p.room_capacity})
                    </span>
                  )}
                </div>
                <div
                  style={{
                    gridColumn: "1 / -1",
                    gridRow: 2,
                    fontSize: 16,
                    fontWeight: 600,
                    lineHeight: "22px",
                    wordBreak: "break-word",
                  }}
                >
                  {sub?.title ?? `#${p.submission_id}`}
                </div>
                {sub?.submitter_name && (
                  <div
                    style={{
                      gridColumn: "1 / -1",
                      gridRow: 3,
                      color: muted,
                      fontSize: 13,
                    }}
                  >
                    <ProfileLink
                      slug={slug}
                      identityId={sub.submitter_id ?? null}
                      linkable={isMod || sub.submitter_profile_published}
                    >
                      {sub.submitter_name}
                    </ProfileLink>
                  </div>
                )}
                {sub &&
                  (sub.pre_assigned_room_id !== null ||
                    sub.room_requirements.length > 0) && (
                    <div
                      style={{
                        gridColumn: "1 / -1",
                        gridRow: 4,
                        display: "flex",
                        gap: 6,
                        flexWrap: "wrap",
                        marginTop: 4,
                      }}
                    >
                      {sub.pre_assigned_room_id !== null && (
                        <Badge variant="attention">pinned to this room</Badge>
                      )}
                      {sub.room_requirements.length > 0 && (
                        <Badge variant="default">
                          needs: {sub.room_requirements.join(", ")}
                        </Badge>
                      )}
                    </div>
                  )}
              </div>
            );
          })}
        </Stack>
      )}
    </Stack>
  );
}
