// Moderator-only, dismissible "get your agenda working" checklist. Driven
// entirely off data the AgendaTab already loads (rooms, sessions, slots,
// placements/assignments) so it never costs an extra round-trip. The copy
// comes from BUILD_STEPS in agendaGuide.ts so the wording stays in lockstep
// with the help modal and the slot-type chooser.

import { useState } from "react";
import { Button, Card, Heading, Stack } from "../../../design-system";
import { useRoute } from "../../../router";
import { BUILD_STEPS, type BuildStep } from "../../ui/agendaGuide";

const STORAGE_PREFIX = "agenda-onboarding-dismissed:";

// Each step resolves to a checked flag + an action that points the moderator
// at the place to act. `assign` has no target tab — its CTA is the two-step
// "Place sessions / Update seating" panel on this same tab — so it carries no
// action.
interface ChecklistItem extends BuildStep {
  done: boolean;
  /** Tab to switch to when the item is unchecked. `null` = no link (action
   * lives on the Agenda tab itself). */
  targetTab: "rooms" | "sessions" | null;
  /** Override label for the action link/button. */
  actionLabel: string;
}

export function OnboardingChecklist({
  slug,
  roomsCount,
  hasPublishedSession,
  slotsCount,
  hasPlacedSessions,
}: {
  slug: string;
  roomsCount: number;
  hasPublishedSession: boolean;
  slotsCount: number;
  hasPlacedSessions: boolean;
}) {
  const storageKey = STORAGE_PREFIX + slug;
  const { navigate } = useRoute();
  const [dismissed, setDismissed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(storageKey) === "1";
    } catch {
      return false;
    }
  });

  if (dismissed) return null;

  function dismiss() {
    try {
      localStorage.setItem(storageKey, "1");
    } catch {
      // Private mode / storage disabled — degrade to in-memory dismissal.
    }
    setDismissed(true);
  }

  const stepByKey = new Map(BUILD_STEPS.map((s) => [s.key, s]));
  const items: ChecklistItem[] = [
    {
      ...stepByKey.get("rooms")!,
      done: roomsCount > 0,
      targetTab: "rooms",
      actionLabel: "Go to Rooms",
    },
    {
      ...stepByKey.get("sessions")!,
      done: hasPublishedSession,
      targetTab: "sessions",
      actionLabel: "Go to Sessions",
    },
    {
      ...stepByKey.get("slots")!,
      done: slotsCount > 0,
      targetTab: null,
      actionLabel: 'Use "+ Add slot" above',
    },
    {
      ...stepByKey.get("assign")!,
      // "Done" means at least one session is placed — the setup milestone we
      // can detect. Seating attendees is a recurring action (the two-step
      // Assign panel below), not a one-time checklist item.
      done: hasPlacedSessions,
      targetTab: null,
      actionLabel: "Open an unconference slot to place sessions",
    },
  ];

  const doneCount = items.filter((i) => i.done).length;
  // Once everything is checked the card has served its purpose; auto-hide so
  // a fully set-up agenda isn't cluttered. (We don't persist this — re-render
  // simply skips it.)
  if (doneCount === items.length) return null;

  const muted = "var(--fgColor-muted, var(--uncon-fg-muted, #6e7781))";

  return (
    <Card>
      <Stack gap="condensed">
        <Stack direction="row" justify="between" align="center">
          <Heading level={3}>
            Set up your agenda ({doneCount}/{items.length})
          </Heading>
          <Button size="small" variant="invisible" onClick={dismiss}>
            Dismiss
          </Button>
        </Stack>
        <Stack gap="condensed">
          {items.map((item) => (
            <div
              key={item.key}
              style={{
                display: "flex",
                alignItems: "flex-start",
                gap: 10,
                padding: "8px 10px",
                borderRadius: 8,
                border:
                  "1px solid var(--borderColor-muted, var(--uncon-border-muted, #e5e7eb))",
                background: item.done
                  ? "var(--bgColor-success-muted, rgba(26,127,55,0.06))"
                  : "var(--bgColor-muted, var(--uncon-bg-subtle, rgba(0,0,0,0.025)))",
              }}
            >
              <span
                aria-hidden
                style={{
                  flex: "0 0 auto",
                  marginTop: 1,
                  width: 18,
                  height: 18,
                  borderRadius: "50%",
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 12,
                  fontWeight: 700,
                  background: item.done
                    ? "var(--bgColor-success-emphasis, #1a7f37)"
                    : "transparent",
                  color: item.done ? "#fff" : muted,
                  border: item.done
                    ? "none"
                    : "1.5px solid var(--borderColor-muted, var(--uncon-border-muted, #d0d7de))",
                }}
              >
                {item.done ? "✓" : ""}
              </span>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div
                  style={{
                    fontSize: 14,
                    fontWeight: 600,
                    textDecoration: item.done ? "line-through" : "none",
                    color: item.done ? muted : "inherit",
                  }}
                >
                  {item.title}
                </div>
                <div style={{ fontSize: 12, color: muted, lineHeight: "17px" }}>
                  {item.blurb}
                </div>
                {/* Text-only action hints live UNDER the blurb, inside the
                    flexible column — a nowrap span beside it crushed the
                    title/blurb into a skinny column on mobile. Buttons stay
                    on the right (short, and they wrap fine). */}
                {!item.done && !item.targetTab && (
                  <div
                    style={{
                      fontSize: 12,
                      fontWeight: 600,
                      color: muted,
                      marginTop: 4,
                    }}
                  >
                    {item.actionLabel}
                  </div>
                )}
              </div>
              {!item.done && item.targetTab && (
                <Button
                  size="small"
                  variant="default"
                  onClick={() =>
                    navigate(
                      `/conferences/${encodeURIComponent(slug)}/${item.targetTab}`,
                    )
                  }
                >
                  {item.actionLabel}
                </Button>
              )}
            </div>
          ))}
        </Stack>
      </Stack>
    </Card>
  );
}
