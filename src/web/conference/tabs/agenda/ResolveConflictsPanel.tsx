import { useState } from "react";
import { Button } from "../../../design-system";
import { useToast } from "../../../design-system/hooks";
import { api, errorCode } from "../../../api";
import type { Room, Slot, Submission } from "../../types";
import { SearchableSelect } from "../../ui/SearchableSelect";
import type { PreConflict, ResolveAction } from "./types";

// ---- Pre-assignment conflict resolver --------------------------------------
//
// When two pinned sessions want the same room, or a pinned room isn't in
// the slot's scope, the server returns a structured conflict instead of
// running. The panel lets the moderator resolve each grouped conflict via
// one of three actions per session:
//   - skip: drop this session from the pool just for the next run (no
//     persistent change — the next-most-starred session takes the room).
//   - move: rewrite the session's pinned room to a different room.
//   - clear: unpin the session entirely (algorithm auto-places it).
// Mutating actions (move / clear) batch into `submissions.update` calls
// queued until the moderator clicks "Apply and re-run", so partial edits
// don't accumulate on Cancel. Skips are one-shot and live only in this
// component's state.

export function ResolveConflictsPanel({
  slug,
  slot: _slot,
  rooms,
  subs,
  conflicts,
  onCancel,
  onRerun,
}: {
  slug: string;
  slot: Slot;
  rooms: Room[];
  subs: Submission[];
  conflicts: PreConflict[];
  onCancel: () => void;
  onRerun: (excludeSubmissionIds: number[]) => Promise<void>;
}) {
  const muted = "var(--fgColor-muted, var(--uncon-fg-muted, #6e7781))";

  // Every conflicting submission shows up in `actions` so its row has a
  // controlled state. Defaults are picked so a single click "Apply" usually
  // resolves the conflict without further input: for tag conflicts the most
  // non-destructive option (skip) is preselected; for pin conflicts the
  // mod still has to pick which session yields, so we leave them on "keep"
  // and clearly flag the unresolved state.
  const allSubIds = Array.from(
    new Set(
      conflicts.flatMap((c) =>
        c.kind === "unsatisfiable_requirements"
          ? [c.submission.id]
          : c.submissions.map((s) => s.id),
      ),
    ),
  );
  const defaultActionFor = (subId: number): ResolveAction => {
    const inTagConflict = conflicts.some(
      (c) =>
        c.kind === "unsatisfiable_requirements" && c.submission.id === subId,
    );
    return inTagConflict ? { kind: "skip" } : { kind: "keep" };
  };
  const [actions, setActions] = useState<Record<number, ResolveAction>>(() => {
    const init: Record<number, ResolveAction> = {};
    for (const id of allSubIds) init[id] = defaultActionFor(id);
    return init;
  });
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  function setAction(subId: number, action: ResolveAction) {
    setActions((prev) => ({ ...prev, [subId]: action }));
  }

  // Build the per-submission room picker options. Offer every conference
  // room *except* the session's current pin (no-op) and rooms already
  // pinned by a non-conflicting submission (would just create a fresh
  // conflict).
  const pinnedRoomIdsByOthers = new Set<number>();
  for (const s of subs) {
    if (s.pre_assigned_room_id === null) continue;
    if (allSubIds.includes(s.id)) continue;
    pinnedRoomIdsByOthers.add(s.pre_assigned_room_id);
  }
  function roomOptionsFor(currentPin: number | null) {
    return rooms
      .filter((r) => r.id !== currentPin && !pinnedRoomIdsByOthers.has(r.id))
      .map((r) => ({
        value: String(r.id),
        label: r.name,
        hint: `Capacity ${r.capacity}`,
      }));
  }

  // Counts at the bottom — and we use `unresolvedKeep` to disable Apply
  // when the mod hasn't actually resolved a pin conflict (still on "keep"
  // for both sides). Without this, clicking Apply just re-runs and shows
  // the same conflict.
  const summary = (() => {
    let skip = 0,
      move = 0,
      clear = 0,
      keep = 0;
    for (const id of allSubIds) {
      const a = actions[id];
      if (!a) continue;
      if (a.kind === "skip") skip++;
      else if (a.kind === "move") move++;
      else if (a.kind === "clear") clear++;
      else keep++;
    }
    return { skip, move, clear, keep, total: allSubIds.length };
  })();
  const isResolved = (() => {
    // Each conflict must have at least one of its sessions changed from
    // "keep" (or be a tag-only conflict resolved via skip/move).
    for (const c of conflicts) {
      if (c.kind === "unsatisfiable_requirements") {
        const a = actions[c.submission.id];
        if (!a || a.kind === "keep") return false;
      } else {
        const all = c.submissions;
        const anyAction = all.some((cs) => {
          const a = actions[cs.id];
          return a && a.kind !== "keep";
        });
        if (!anyAction) return false;
      }
    }
    return true;
  })();

  async function apply() {
    setBusy(true);
    try {
      // Persist move / clear actions first so the next run sees the new pins.
      for (const id of allSubIds) {
        const a = actions[id];
        if (!a) continue;
        if (a.kind === "move") {
          await api.submissions.update({
            slug,
            id,
            pre_assigned_room_id: a.roomId,
          });
        } else if (a.kind === "clear") {
          await api.submissions.update({
            slug,
            id,
            pre_assigned_room_id: null,
          });
        }
      }
      const excludes = allSubIds.filter((id) => actions[id]?.kind === "skip");
      await onRerun(excludes);
    } catch (e) {
      toast.error(errorCode(e));
    } finally {
      setBusy(false);
    }
  }

  // Radio option styled as a labelled card row. Cleaner and far less
  // visually noisy than four pill buttons + a separate description line.
  function ActionOption({
    name,
    current,
    value,
    title,
    hint,
    onSelect,
    danger,
  }: {
    name: string;
    current: string;
    value: string;
    title: string;
    hint: string;
    onSelect: () => void;
    danger?: boolean;
  }) {
    const checked = current === value;
    return (
      <label
        style={{
          display: "flex",
          alignItems: "flex-start",
          gap: 10,
          padding: "10px 12px",
          borderRadius: 8,
          border: `1px solid ${
            checked
              ? "var(--borderColor-accent-emphasis, #2563eb)"
              : "var(--borderColor-muted, var(--uncon-border-muted, #d0d7de))"
          }`,
          background: checked
            ? "var(--bgColor-accent-muted, rgba(37, 99, 235, 0.08))"
            : "transparent",
          cursor: "pointer",
          transition: "border-color .12s ease, background .12s ease",
        }}
      >
        <input
          type="radio"
          name={name}
          checked={checked}
          onChange={onSelect}
          style={{ marginTop: 3, flexShrink: 0 }}
        />
        <div style={{ minWidth: 0 }}>
          <div
            style={{
              fontSize: 13,
              fontWeight: 600,
              color: danger && !checked ? muted : "inherit",
            }}
          >
            {title}
          </div>
          <div
            style={{
              fontSize: 12,
              color: muted,
              marginTop: 2,
              lineHeight: 1.45,
            }}
          >
            {hint}
          </div>
        </div>
      </label>
    );
  }

  // Per-session action editor. Each session card lists the available
  // resolutions as a radio group, with a contextual room picker when
  // "Move pin" / "Pin to a room" is chosen.
  function SessionActionRow({
    cs,
    hasPin,
  }: {
    cs: { id: number; title: string };
    hasPin: boolean;
  }) {
    const sub = subs.find((s) => s.id === cs.id);
    const currentPin = sub?.pre_assigned_room_id ?? null;
    const currentPinName =
      currentPin === null
        ? null
        : rooms.find((r) => r.id === currentPin)?.name ?? null;
    const a = actions[cs.id] ?? { kind: "keep" };
    const options = roomOptionsFor(currentPin);
    const radioName = `resolve-${cs.id}`;
    return (
      <div
        style={{
          padding: 14,
          borderRadius: 10,
          border:
            "1px solid var(--borderColor-muted, var(--uncon-border-muted, #e5e7eb))",
          background: "var(--bgColor-default, transparent)",
        }}
      >
        <div style={{ marginBottom: 10 }}>
          <div style={{ fontWeight: 600, fontSize: 14, lineHeight: 1.3 }}>
            {cs.title}
          </div>
          {currentPinName && (
            <div style={{ fontSize: 12, color: muted, marginTop: 2 }}>
              Currently pinned to <strong>{currentPinName}</strong>
            </div>
          )}
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <ActionOption
            name={radioName}
            current={a.kind}
            value="skip"
            title="Skip just this run"
            hint="The session drops out for this slot only. The next-most-starred session takes its place. No permanent change."
            onSelect={() => setAction(cs.id, { kind: "skip" })}
          />
          <ActionOption
            name={radioName}
            current={a.kind}
            value="move"
            title={
              hasPin ? "Move the pin to another room" : "Pin to a specific room"
            }
            hint={
              hasPin
                ? "Permanently re-pins this session to a room you pick below."
                : "Permanently pins this session to a room you pick below — overrides required features."
            }
            onSelect={() =>
              setAction(cs.id, {
                kind: "move",
                roomId:
                  options.length > 0
                    ? Number.parseInt(options[0]!.value, 10)
                    : currentPin ?? 0,
              })
            }
          />
          {hasPin && (
            <ActionOption
              name={radioName}
              current={a.kind}
              value="clear"
              title="Clear the pin"
              hint="Removes the pin permanently. The algorithm auto-places the session in any free room."
              onSelect={() => setAction(cs.id, { kind: "clear" })}
            />
          )}
          <ActionOption
            name={radioName}
            current={a.kind}
            value="keep"
            danger
            title={
              hasPin
                ? "Keep the pin (don't resolve)"
                : "Leave unchanged (don't resolve)"
            }
            hint="The conflict will still be there next time you run. Use this if you'll resolve via another session in the same group."
            onSelect={() => setAction(cs.id, { kind: "keep" })}
          />
          {a.kind === "move" && (
            <div style={{ marginTop: 4, paddingLeft: 30 }}>
              <SearchableSelect
                label={hasPin ? "New room" : "Pin to room"}
                value={String(a.roomId)}
                onChange={(value) =>
                  setAction(cs.id, {
                    kind: "move",
                    roomId: Number.parseInt(value, 10),
                  })
                }
                options={options}
                placeholder="Search rooms…"
              />
            </div>
          )}
        </div>
      </div>
    );
  }

  // Headline that adapts to the conflict mix so the mod sees a single
  // sentence describing the situation, instead of having to compose it
  // from the card list below.
  const headline = (() => {
    const dup = conflicts.filter((c) => c.kind === "duplicate_room").length;
    const oos = conflicts.filter((c) => c.kind === "out_of_scope").length;
    const tag = conflicts.filter(
      (c) => c.kind === "unsatisfiable_requirements",
    ).length;
    const parts: string[] = [];
    if (dup > 0)
      parts.push(`${dup} room ${dup === 1 ? "conflict" : "conflicts"}`);
    if (oos > 0) parts.push(`${oos} out-of-slot ${oos === 1 ? "pin" : "pins"}`);
    if (tag > 0)
      parts.push(
        `${tag} unmet-requirements ${tag === 1 ? "session" : "sessions"}`,
      );
    return parts.join(", ");
  })();

  return (
    <div
      style={{
        padding: 18,
        borderRadius: 12,
        border: "1px solid var(--borderColor-danger-emphasis, #cf222e)",
        background: "var(--bgColor-danger-muted, rgba(207, 34, 46, 0.06))",
      }}
    >
      {/* Header — single sentence summarising what's wrong + how the panel works */}
      <div style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 4 }}>
          Assignment blocked: {headline}
        </div>
        <div style={{ fontSize: 13, color: muted, lineHeight: 1.45 }}>
          Pick one option per session below. <strong>Apply and re-run</strong>{" "}
          will persist the permanent changes (move / clear pin), batch the
          one-shot skips, and re-run the assignment in one click.
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {conflicts.map((c, idx) => {
          if (c.kind === "unsatisfiable_requirements") {
            const matched = c.candidate_room_names;
            return (
              <ConflictGroup
                key={`tags:${c.submission.id}:${idx}`}
                badge="Required features can't be met"
                badgeTone="danger"
                description={
                  matched.length === 0
                    ? `No room in this slot has all of the required features (${c.required_tags
                        .map((t) => `"${t}"`)
                        .join(
                          ", ",
                        )}). Skip the session, pin it to a specific room (overrides tags), or add the missing feature to a room from the Rooms tab.`
                    : `Needs ${c.required_tags
                        .map((t) => `"${t}"`)
                        .join(", ")} — matching rooms in this slot (${matched
                        .map((n) => `"${n}"`)
                        .join(
                          ", ",
                        )}) are all claimed by higher-priority sessions.`
                }
              >
                <SessionActionRow cs={c.submission} hasPin={false} />
              </ConflictGroup>
            );
          }
          const isOutOfScope = c.kind === "out_of_scope";
          return (
            <ConflictGroup
              key={`${c.kind}:${c.room_id}`}
              badge={
                isOutOfScope
                  ? "Pinned room isn't in this slot"
                  : "Two pins on the same room"
              }
              badgeTone={isOutOfScope ? "attention" : "primary"}
              description={
                isOutOfScope
                  ? `"${c.room_name}" isn't part of this slot's room set. Move the pin to a room that is in scope, clear it, or add "${c.room_name}" to the slot via Configure.`
                  : `"${c.room_name}" is the only place to put ${c.submissions.length} sessions. Pick one to move/clear/skip — the rest can stay.`
              }
            >
              {c.submissions.map((cs) => (
                <SessionActionRow key={cs.id} cs={cs} hasPin={true} />
              ))}
            </ConflictGroup>
          );
        })}
      </div>

      {/* Footer — primary action, secondary cancel, and a tiny summary */}
      <div
        style={{
          marginTop: 18,
          paddingTop: 16,
          borderTop:
            "1px solid var(--borderColor-muted, var(--uncon-border-muted, #e5e7eb))",
          display: "flex",
          alignItems: "center",
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <Button
          variant="primary"
          onClick={apply}
          disabled={busy || !isResolved}
        >
          {busy ? "Applying…" : "Apply and re-run"}
        </Button>
        <Button onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <div style={{ flex: 1 }} />
        <div style={{ fontSize: 12, color: muted }}>
          {!isResolved
            ? "Pick a non-default option in every group to enable Apply."
            : `${summary.move} move${summary.move === 1 ? "" : "s"} · ${
                summary.clear
              } clear${summary.clear === 1 ? "" : "s"} · ${summary.skip} skip${
                summary.skip === 1 ? "" : "s"
              } · ${summary.keep} unchanged`}
        </div>
      </div>
    </div>
  );
}

// A bordered card for a single conflict group. Header has a tone-colored
// "kicker" pill instead of a generic Badge so the conflict type reads as
// a one-line headline rather than a tag-plus-room blob.
export function ConflictGroup({
  badge,
  badgeTone,
  description,
  children,
}: {
  badge: string;
  badgeTone: "danger" | "attention" | "primary";
  description: string;
  children: React.ReactNode;
}) {
  const muted = "var(--fgColor-muted, var(--uncon-fg-muted, #6e7781))";
  const tone =
    badgeTone === "danger"
      ? {
          fg: "var(--fgColor-danger, #cf222e)",
          bg: "var(--bgColor-danger-muted, rgba(207, 34, 46, 0.12))",
        }
      : badgeTone === "attention"
      ? {
          fg: "var(--fgColor-attention, #9a6700)",
          bg: "var(--bgColor-attention-muted, rgba(255, 200, 0, 0.18))",
        }
      : {
          fg: "var(--fgColor-accent, #2563eb)",
          bg: "var(--bgColor-accent-muted, rgba(37, 99, 235, 0.12))",
        };
  return (
    <div
      style={{
        padding: 14,
        borderRadius: 10,
        border:
          "1px solid var(--borderColor-muted, var(--uncon-border-muted, #d0d7de))",
        background: "var(--bgColor-default, transparent)",
      }}
    >
      <div
        style={{
          display: "inline-block",
          padding: "3px 10px",
          borderRadius: 999,
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: 0.3,
          textTransform: "uppercase",
          color: tone.fg,
          background: tone.bg,
          marginBottom: 8,
        }}
      >
        {badge}
      </div>
      <div
        style={{
          fontSize: 13,
          color: muted,
          marginBottom: 12,
          lineHeight: 1.5,
        }}
      >
        {description}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {children}
      </div>
    </div>
  );
}
