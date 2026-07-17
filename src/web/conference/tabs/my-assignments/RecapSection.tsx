// Post-event "harvest" section on the Me tab (Harvest & Wrap-up, F3). Shown
// only once the conference's last slot has ended — before that, takeaways
// belong on the session detail, not here. Lists the sessions the user
// actually attended (deduped by submission) with the same TakeawaysPanel
// used on SessionCard, so add/delete/list behavior can't drift between the
// two surfaces.

import { Heading, Stack } from "../../../design-system";
import type { MyAssignments, Slot } from "../../types";
import { TakeawaysPanel } from "../../ui/TakeawaysPanel";

type AssignmentRow = MyAssignments["assignments"][number];

export function RecapSection({
  slug, timeZone, isMod, slots, assignments, now,
}: {
  slug: string;
  timeZone: string;
  isMod: boolean;
  slots: Slot[];
  assignments: AssignmentRow[];
  now: number;
}) {
  if (slots.length === 0) return null;
  const lastEndsAt = Math.max(...slots.map((s) => s.ends_at));
  if (now < lastEndsAt) return null;

  // Dedupe by submission — a starred planned track can produce more than one
  // assignment row (siblings), and we only want one takeaways panel per
  // session. `assignments` arrives sorted chronologically, so the first
  // occurrence kept is also the earliest.
  const seen = new Set<number>();
  const sessions: { submissionId: number; title: string }[] = [];
  for (const a of assignments) {
    if (a.submission_id === null || seen.has(a.submission_id)) continue;
    seen.add(a.submission_id);
    sessions.push({ submissionId: a.submission_id, title: a.title ?? "(removed)" });
  }

  if (sessions.length === 0) return null;

  const muted = "var(--fgColor-muted, var(--uncon-fg-muted, #6e7781))";

  return (
    <Stack gap="condensed">
      <Heading level={2}>Your recap</Heading>
      <span style={{ fontSize: 13, color: muted }}>
        The event is over - capture what stuck before it fades.
      </span>
      <Stack gap="condensed">
        {sessions.map((s) => (
          <div
            key={s.submissionId}
            style={{
              padding: 12,
              borderRadius: 8,
              border: "1px solid var(--borderColor-muted, var(--uncon-border-muted, #e5e7eb))",
              background: "var(--bgColor-default, var(--uncon-bg, transparent))",
            }}
          >
            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 8, wordBreak: "break-word" }}>
              {s.title}
            </div>
            <TakeawaysPanel
              slug={slug}
              submissionId={s.submissionId}
              isMod={isMod}
              timeZone={timeZone}
            />
          </div>
        ))}
      </Stack>
    </Stack>
  );
}
