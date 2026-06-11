import { useState } from "react";
import {
  Badge,
  Button,
  Card,
  Sheet,
  Stack,
  Text,
} from "../../../design-system";
import { useToast } from "../../../design-system/hooks";
import { api, errorCode } from "../../../api";
import type {
  Room,
  Slot,
  SlotSeries,
  Submission,
  Track,
} from "../../types";
import { fmtTimeShort } from "../../helpers";
import { AssignmentRulesTrigger } from "../../ui/AssignmentRulesModal";
import { SLOT_KIND_LABEL, type PreConflict, type SlotKind } from "./types";
import { StaticBody } from "./StaticBody";
import { UnconferenceBody } from "./UnconferenceBody";
import { MixerBody } from "./MixerBody";
import { SlotEditForm } from "./SlotEditForm";
import { SlotConfigure } from "./SlotConfigure";
import { DuplicateSlotForm } from "./DuplicateSlotForm";
import { SeriesEditForm } from "./SeriesEditForm";
import { ResolveConflictsPanel } from "./ResolveConflictsPanel";

export interface SlotBlockProps {
  slug: string;
  slot: Slot;
  /** The series this slot belongs to, when `slot.series_id != null`. Null
   *  for standalone slots. Drives the badge, the "Detach offering" action,
   *  and which configure form mounts (slot-level vs series-level). */
  series: SlotSeries | null;
  rooms: Room[];
  subs: Submission[];
  tracks: Track[];
  placements: {
    slot_id: number;
    submission_id: number;
    room_id: number;
    attendee_count: number;
    star_count: number;
    room_capacity: number;
    manual: boolean;
  }[];
  /** Per-submission start times of OTHER slots the same session is placed in,
   *  so each placement card can show an "also at HH:MM" recurrence hint.
   *  Forwarded straight to `UnconferenceBody`. */
  recurrenceTimes: Map<number, number[]>;
  isMod: boolean;
  timeZone: string;
  onChange: () => Promise<void>;
  onClose?: () => void;
  /** When set, the badge area renders prev/next buttons that hop to the
   *  matching sibling slot. The callback drives the parent's selected-slot
   *  state. Null/undefined hides the navigation. */
  onSelectSlot?: (slotId: number) => void;
  /** When rendered inside a Sheet, skip the outer Card chrome (the sheet
   * already provides the header + container). */
  inSheet?: boolean;
}

export function SlotBlock({
  slug,
  slot,
  series,
  rooms,
  subs,
  tracks,
  placements,
  recurrenceTimes,
  isMod,
  timeZone,
  onChange,
  onClose,
  onSelectSlot,
  inSheet,
}: SlotBlockProps) {
  const [configuring, setConfiguring] = useState(false);
  const [editing, setEditing] = useState(false);
  const [duplicating, setDuplicating] = useState(false);
  const [conflicts, setConflicts] = useState<PreConflict[] | null>(null);
  const toast = useToast();
  const isUnconf = slot.type === "unconference";
  const isMixer = slot.type === "mixer";
  const isAssignable = isUnconf || isMixer;
  const inSeries = series !== null;

  // Effective rooms in this slot's scope. Both unconference and mixer use
  // `unconf_use_all_rooms` + `unconf_room_ids` for room scoping (the field
  // is shared across the two slot types).
  const effectiveRooms = slot.unconf_use_all_rooms
    ? rooms
    : rooms.filter((r) => slot.unconf_room_ids.includes(r.id));
  // Effective sessions eligible for an unconference run: published and
  // not finished, within the slot's submission scope.
  const effectiveSubs = isUnconf
    ? subs
        .filter((s) => s.status === "published" && !s.is_finished)
        .filter(
          (s) =>
            slot.unconf_use_all_submissions ||
            slot.unconf_submission_ids.includes(s.id),
        )
    : [];
  // Reason the Run button is disabled (or null if it's runnable). Surfaced
  // as a tooltip on the disabled button so mods aren't left guessing.
  const runDisabledReason: string | null = (() => {
    if (!isAssignable) return null;
    if (effectiveRooms.length === 0) {
      return isMixer
        ? "No rooms in scope. Add rooms in the Rooms tab or include some in the configuration."
        : "No rooms in scope. Add rooms in the Rooms tab or include some via Configure.";
    }
    if (isUnconf && effectiveSubs.length === 0) {
      return "No published, non-finished sessions in scope. Publish a session in the Sessions tab.";
    }
    return null;
  })();

  async function remove() {
    if (!confirm("Delete this slot?")) return;
    try {
      await api.agenda.deleteSlot({ slug, id: slot.id });
      toast.success("Slot deleted.");
      await onChange();
    } catch (e) {
      toast.error(errorCode(e));
    }
  }

  async function detach() {
    if (!inSeries) return;
    const msg =
      "Detach this offering from its series? It will become a standalone " +
      "slot with the series's current configuration snapshotted onto it; " +
      "future series edits will no longer affect it.";
    if (!confirm(msg)) return;
    try {
      await api.agenda.detachSeries({ slug, slot_id: slot.id });
      toast.success("Offering detached from series.");
      await onChange();
    } catch (e) {
      toast.error(errorCode(e));
    }
  }

  async function runAssignment(excludeSubmissionIds?: number[]) {
    try {
      const r = await api.agenda.assign({
        slug,
        slot_id: slot.id,
        ...(excludeSubmissionIds && excludeSubmissionIds.length > 0
          ? { exclude_submission_ids: excludeSubmissionIds }
          : {}),
      });
      if (r.kind === "conflict") {
        // Hard block on running the assignment — mod has to resolve the
        // conflict in the resolver panel that just mounted below.
        setConflicts(r.conflicts);
        toast.error(
          "Pre-assignment conflict — assignment was not run. Resolve the conflict to continue.",
        );
        return;
      }
      // Success — clear any stale conflict panel from a previous attempt.
      setConflicts(null);
      const noun = isMixer ? "attendee" : "participant";
      const unmatched = isMixer
        ? "they couldn't fit in a room (capacity)."
        : "they need to pick another session.";
      // Build the overlap-exclusions footer when present. Mods see this so
      // they understand why some rooms/sessions/users were filtered out —
      // it's expected behavior, not a problem.
      const ex = r.overlap_exclusions;
      const exParts: string[] = [];
      if (ex.rooms.length > 0) {
        exParts.push(
          `${ex.rooms.length} room(s) (${ex.rooms
            .map((r) => r.name)
            .join(", ")})`,
        );
      }
      if (ex.submissions.length > 0) {
        exParts.push(`${ex.submissions.length} session(s)`);
      }
      if (ex.user_ids.length > 0) {
        exParts.push(`${ex.user_ids.length} ${noun}(s)`);
      }
      const overlapNote =
        exParts.length === 0
          ? ""
          : ` Excluded due to overlapping slots: ${exParts.join(", ")}.`;
      if (r.unplaced_users.length === 0) {
        toast.success("Assignment complete — everyone placed." + overlapNote);
      } else {
        toast.warning(
          `${r.unplaced_users.length} ${noun}(s) could not be placed — ${unmatched}${overlapNote}`,
        );
      }
      await onChange();
    } catch (e) {
      toast.error(errorCode(e));
    }
  }

  const headerLabel = isUnconf
    ? "Unconference"
    : isMixer
    ? slot.title ?? "Mixer"
    : slot.title ?? "Planned slot";
  const badgeText = SLOT_KIND_LABEL[slot.type as SlotKind].toLowerCase();
  const badgeVariant: "primary" | "attention" | "default" = isUnconf
    ? "primary"
    : isMixer
    ? "attention"
    : "default";

  const body = (
    <Stack gap="condensed">
      {/* Meta row — header label (off-sheet only) + time/timezone on the
          left, the assignment-rules `?` trigger on the right. The trigger
          lives here rather than in the action row because it's contextual
          help, not an action. */}
      <Stack direction="row" justify="between" align="center" wrap>
        <Stack gap="condensed">
          {!inSheet && (
            <Stack direction="row" gap="condensed" align="center">
              <strong>{headerLabel}</strong>
              <Badge variant={badgeVariant}>{badgeText}</Badge>
            </Stack>
          )}
          <div
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
              fontSize: 14,
            }}
          >
            <span
              style={{ fontVariantNumeric: "tabular-nums", fontWeight: 500 }}
            >
              {fmtTimeShort(slot.starts_at, timeZone)}
            </span>
            <span
              style={{
                color: "var(--fgColor-muted, var(--uncon-fg-muted, #6e7781))",
              }}
            >
              →
            </span>
            <span
              style={{ fontVariantNumeric: "tabular-nums", fontWeight: 500 }}
            >
              {fmtTimeShort(slot.ends_at, timeZone)}
            </span>
            <span
              style={{
                padding: "1px 8px",
                borderRadius: 999,
                background:
                  "var(--bgColor-muted, var(--uncon-bg-subtle, rgba(0,0,0,0.05)))",
                color: "var(--fgColor-muted, var(--uncon-fg-muted, #6e7781))",
                fontSize: 11,
                marginLeft: 4,
              }}
            >
              {timeZone}
            </span>
            {!inSheet && <Badge variant={badgeVariant}>{badgeText}</Badge>}
            {/* Series indicator. Visible to everyone — non-mods see it as
                context for "this session runs at multiple times"; mods use
                it as a signal that config edits route through the series
                form. Prev/next arrows hop the sheet to a sibling so you
                can compare offerings without closing and re-opening. */}
            {inSeries && slot.series_offering_index !== null && slot.series_total_offerings !== null && (() => {
              const siblings = series?.slot_ids ?? [];
              const idx = siblings.indexOf(slot.id);
              const prevId = idx > 0 ? siblings[idx - 1] : null;
              const nextId = idx >= 0 && idx < siblings.length - 1 ? siblings[idx + 1] : null;
              const canNav = onSelectSlot !== undefined;
              return (
                <Stack direction="row" gap="condensed" align="center">
                  {canNav && (
                    <Button
                      size="small"
                      variant="invisible"
                      onClick={() => prevId != null && onSelectSlot(prevId)}
                      disabled={prevId === null}
                      aria-label="Previous offering"
                    >
                      ‹
                    </Button>
                  )}
                  <Badge variant="default">
                    Offering {slot.series_offering_index} of {slot.series_total_offerings}
                  </Badge>
                  {canNav && (
                    <Button
                      size="small"
                      variant="invisible"
                      onClick={() => nextId != null && onSelectSlot(nextId)}
                      disabled={nextId === null}
                      aria-label="Next offering"
                    >
                      ›
                    </Button>
                  )}
                </Stack>
              );
            })()}
          </div>
        </Stack>
        {isAssignable && <AssignmentRulesTrigger isMod={isMod} />}
      </Stack>

      {/* Action row — primary actions (Edit / Configure / Run) on the
          left, destructive / chrome (Delete / Close) right-aligned via a
          flex spacer so the row reads as two intentional clusters. */}
      {(isMod || onClose) && (
        <Stack direction="row" gap="condensed" align="center" wrap>
          {isMod && (
            <Button onClick={() => setEditing((v) => !v)} size="small">
              {editing ? "Close edit" : "Edit"}
            </Button>
          )}
          {isMod && isAssignable && (
            <>
              {/* Mixer slots configure rooms inline in MixerBody; no separate
               * Configure panel needed. Unconference slots still have one for
               * eligible submissions + avoid-repeats. */}
              {!isMixer && (
                <Button onClick={() => setConfiguring((v) => !v)} size="small">
                  {configuring ? "Close configure" : "Configure"}
                </Button>
              )}
              <Button
                variant="default"
                onClick={() => runAssignment()}
                size="small"
                disabled={runDisabledReason !== null}
              >
                {isMixer ? "Assign rooms" : "Auto-fill this slot from stars"}
              </Button>
              {runDisabledReason && (
                <Text muted>
                  <span title={runDisabledReason}>{runDisabledReason}</span>
                </Text>
              )}
            </>
          )}
          {isMod && (
            <Button onClick={() => setDuplicating(true)} size="small">
              Duplicate
            </Button>
          )}
          {isMod && inSeries && (
            <Button onClick={detach} size="small">
              Detach offering
            </Button>
          )}
          {/* Spacer pushes Delete / Close to the far right. */}
          <div style={{ flex: 1 }} />
          {isMod && (
            <Button variant="danger" onClick={remove} size="small">
              Delete
            </Button>
          )}
          {onClose && (
            <Button variant="invisible" onClick={onClose} size="small">
              Close
            </Button>
          )}
        </Stack>
      )}

      {isMod && duplicating && (
        <Sheet open onClose={() => setDuplicating(false)} title="Duplicate as another offering">
          <DuplicateSlotForm
            slug={slug}
            slot={slot}
            timeZone={timeZone}
            onCancel={() => setDuplicating(false)}
            onDuplicated={async () => {
              setDuplicating(false);
              await onChange();
            }}
          />
        </Sheet>
      )}

      {isMod && editing && (
        <SlotEditForm
          slug={slug}
          slot={slot}
          timeZone={timeZone}
          onSaved={async () => {
            setEditing(false);
            await onChange();
          }}
        />
      )}

      {isAssignable && configuring && (
        inSeries && series
          ? (
            <SeriesEditForm
              slug={slug}
              series={series}
              rooms={rooms}
              subs={subs}
              onSaved={async () => {
                setConfiguring(false);
                await onChange();
              }}
            />
          )
          : (
            <SlotConfigure
              slug={slug}
              slot={slot}
              rooms={rooms}
              subs={subs}
              onSaved={async () => {
                setConfiguring(false);
                await onChange();
              }}
            />
          )
      )}

      {isMod && isUnconf && conflicts && (
        <ResolveConflictsPanel
          slug={slug}
          slot={slot}
          rooms={rooms}
          subs={subs}
          conflicts={conflicts}
          onCancel={() => setConflicts(null)}
          onRerun={async (excludeSubmissionIds) => {
            await onChange();
            await runAssignment(excludeSubmissionIds);
          }}
        />
      )}

      {isUnconf && (
        <UnconferenceBody
          slug={slug}
          slot={slot}
          subs={subs}
          rooms={rooms}
          placements={placements}
          recurrenceTimes={recurrenceTimes}
          timeZone={timeZone}
          onChange={onChange}
          isMod={isMod}
        />
      )}
      {isMixer && (
        <MixerBody
          slug={slug}
          slot={slot}
          rooms={rooms}
          isMod={isMod}
          onChange={onChange}
        />
      )}
      {!isUnconf && !isMixer && (
        <StaticBody
          slug={slug}
          slot={slot}
          rooms={rooms}
          subs={subs}
          tracks={tracks}
          isMod={isMod}
          onChange={onChange}
        />
      )}
    </Stack>
  );

  return inSheet ? body : <Card>{body}</Card>;
}
