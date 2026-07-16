import { useEffect, useState } from "react";
import { Badge, Button, Stack } from "../../../design-system";
import { useToast } from "../../../design-system/hooks";
import { api, errorCode } from "../../../api";
import type { Room, Slot, Submission } from "../../types";
import { fmtTimeMaybeDay, spansMultipleDays } from "../../helpers";
import { ProfileLink } from "../../ProfileLink";
import { SessionPicker } from "../../ui/SessionPicker";
import { PlacementAuthor } from "./PlacementAuthor";

export function UnconferenceBody({
  slug,
  slot,
  subs,
  rooms,
  placements,
  recurrenceTimes,
  timeZone,
  onChange,
  isMod,
  myIdentityId,
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
    manual: boolean;
  }[];
  /** Per-submission start times of OTHER slots the same session is placed in.
   *  Powers the "also at HH:MM" recurrence hint. */
  recurrenceTimes: Map<number, number[]>;
  timeZone: string;
  onChange: () => Promise<void>;
  isMod: boolean;
  /** The viewer's conference identity id. Used to recognize "you submitted a
   *  session placed here" before any seating run has assigned them a seat. */
  myIdentityId: number;
}) {
  const [myAssignment, setMyAssignment] = useState<{
    submission_id: number | null;
    manual: boolean;
  } | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [removing, setRemoving] = useState<number | null>(null);
  const toast = useToast();

  async function unplace(submissionId: number) {
    setRemoving(submissionId);
    try {
      await api.agenda.unplaceSubmission({ slug, slot_id: slot.id, submission_id: submissionId });
      await onChange();
    } catch (e) {
      toast.error(errorCode(e));
    } finally {
      setRemoving(null);
    }
  }

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
  // Before a seating run has assigned any seat, a submitter whose session is
  // placed here already knows where they'll be: seating pins them into their
  // own session (unless they manually pick another). Show that instead of a
  // misleading "Not assigned yet".
  const hostedSub = currentSub === null
    ? placements
        .map((p) => subById.get(p.submission_id))
        .find((s) => s !== undefined && s.submitter_id === myIdentityId) ?? null
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
          Sessions: {eligibleSubs.length}
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
              {currentSubTitle ?? hostedSub?.title ?? "Not assigned yet"}
              {myAssignment?.manual && (
                <span
                  style={{
                    marginLeft: 6,
                    color: "var(--fgColor-accent, #2563eb)",
                    fontSize: 11,
                    fontWeight: 600,
                  }}
                >
                  · chose this
                </span>
              )}
              {!currentSub && hostedSub && (
                <span
                  style={{
                    marginLeft: 6,
                    color: "var(--fgColor-accent, #2563eb)",
                    fontSize: 11,
                    fontWeight: 600,
                  }}
                  title="You submitted this session, so seating will place you in it as the host - unless you pick a different session yourself."
                >
                  · you host this
                </span>
              )}
            </span>
          </div>
          <Button
            size="small"
            variant={currentSub || hostedSub ? "default" : "primary"}
            onClick={() => setPickerOpen(true)}
          >
            {currentSub || hostedSub ? "Change session" : "Pick a session"}
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
          No sessions placed here yet.{" "}
          {isMod
            ? "Use “Place sessions from stars” above, or place a session by hand below."
            : "Check back once the moderator sets up this slot."}
        </div>
      ) : (
        <Stack gap="condensed">
          {placements.map((p) => {
            const sub = subById.get(p.submission_id);
            const room = roomById.get(p.room_id);
            const recTimes = recurrenceTimes.get(p.submission_id) ?? [];
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
                    // Never wrap inside the pill — when space runs out, the
                    // badge cluster on the right wraps whole pills instead.
                    whiteSpace: "nowrap",
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
                    flexWrap: "wrap",
                    justifyContent: "flex-end",
                  }}
                >
                  <span
                    title={
                      p.manual
                        ? "You placed this session into this room by hand."
                        : "“Place sessions from stars” placed this session by star ranking."
                    }
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      padding: "2px 8px",
                      borderRadius: 999,
                      background: p.manual
                        ? "var(--bgColor-accent-muted, rgba(64,132,246,0.12))"
                        : "var(--bgColor-muted, var(--uncon-bg-subtle, rgba(0,0,0,0.05)))",
                      color: p.manual
                        ? "var(--fgColor-accent, #2563eb)"
                        : muted,
                      fontSize: 11,
                      fontWeight: 600,
                      textTransform: "uppercase",
                      letterSpacing: 0.4,
                    }}
                  >
                    {p.manual ? "placed by you" : "by stars"}
                  </span>
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
                  {sub && sub.priority !== "normal" && (
                    <span
                      title={
                        sub.priority === "high"
                          ? "High priority — the algorithm places and fills this session first."
                          : "Low priority — the algorithm places and fills this session last."
                      }
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        padding: "2px 8px",
                        borderRadius: 999,
                        background:
                          sub.priority === "high"
                            ? "var(--bgColor-attention-muted, rgba(212,167,44,0.16))"
                            : "var(--bgColor-muted, var(--uncon-bg-subtle, rgba(0,0,0,0.05)))",
                        color:
                          sub.priority === "high"
                            ? "var(--fgColor-attention, #9a6700)"
                            : muted,
                        fontSize: 11,
                        fontWeight: 600,
                        textTransform: "uppercase",
                        letterSpacing: 0.4,
                      }}
                    >
                      {sub.priority === "high" ? "High priority" : "Low priority"}
                    </span>
                  )}
                  {isMod && (
                    <Button
                      size="small"
                      variant="danger"
                      onClick={() => unplace(p.submission_id)}
                      disabled={removing === p.submission_id}
                    >
                      {removing === p.submission_id ? "Removing…" : "Remove"}
                    </Button>
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
                {recTimes.length > 0 && (
                  <div
                    title="The same session is placed on other slots — it recurs."
                    style={{
                      gridColumn: "1 / -1",
                      gridRow: 4,
                      color: muted,
                      fontSize: 12,
                      lineHeight: "18px",
                    }}
                  >
                    <span aria-hidden style={{ marginRight: 6 }}>↻</span>
                    Also runs{" "}
                    {(() => {
                      // Show the day too when this session's occurrences span
                      // more than one day (otherwise 9:00 vs 9:00 is ambiguous).
                      const withDay = spansMultipleDays(
                        [slot.starts_at, ...recTimes], timeZone,
                      );
                      return recTimes
                        .map((t) => fmtTimeMaybeDay(t, timeZone, withDay))
                        .join(" · ");
                    })()}
                  </div>
                )}
                {sub &&
                  (sub.pre_assigned_room_id !== null ||
                    sub.room_requirements.length > 0) && (
                    <div
                      style={{
                        gridColumn: "1 / -1",
                        gridRow: recTimes.length > 0 ? 5 : 4,
                        display: "flex",
                        gap: 6,
                        flexWrap: "wrap",
                        marginTop: 4,
                      }}
                    >
                      {sub.pre_assigned_room_id !== null && (
                        <Badge variant="attention">reserved for this room</Badge>
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

      {isMod && (
        <PlacementAuthor
          slug={slug}
          slotId={slot.id}
          eligibleSubs={eligibleSubs}
          eligibleRooms={eligibleRooms}
          placedSubmissionIds={new Set(placements.map((p) => p.submission_id))}
          takenRoomIds={new Set(placements.map((p) => p.room_id))}
          onChange={onChange}
        />
      )}
    </Stack>
  );
}
