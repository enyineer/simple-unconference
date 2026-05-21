// =============================================================================
// AssignmentRulesModal
//
// Single source of truth for the plain-language explanation of how the
// unconference / mixer assignment algorithm works. Surfaced via a "?" link
// next to "Run assignment" in the slot detail, and via a "How assignment
// works" link in the Agenda tab header.
//
// MAINTENANCE: This component MUST stay in sync with the actual algorithm.
// When you change anything in:
//   - src/server/assignment.ts   (pure algorithm)
//   - src/server/rpc.ts          (runAssignmentForSlot / runMixerForSlot —
//                                 the route layer applies pin/tag matching,
//                                 overlap rules, cascade analysis, finished
//                                 filter, manual picks)
// ...update the matching section below. Each `<Rule>` is grouped under the
// stage it belongs to so the document mirrors the algorithm's structure.
// =============================================================================

import { useState } from "react";
import { Badge, Button, Sheet, Stack, Text } from "../../design-system";

export function AssignmentRulesModal({
  open, onClose, isMod,
}: {
  open: boolean;
  onClose: () => void;
  /** Mods see additional sections about conflict resolution, pinning,
   * required features, and finished sessions — controls only they touch. */
  isMod: boolean;
}) {
  return (
    <Sheet open={open} onClose={onClose} title="How assignment works">
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 20,
          maxWidth: 640,
          // Slight horizontal padding for breathing room inside the sheet.
          paddingTop: 4,
        }}
      >
        <Text muted>
          When a moderator runs an unconference or mixer slot, the system
          decides which sessions go where and which participants attend
          which session. Here's exactly what it does, in order.
        </Text>

        <Section index={1} title="Which sessions get a room">
          <Rule>
            Sessions are ranked by <strong>star count</strong> — how many
            attendees have starred them. If there are more sessions than
            rooms, the least-starred drop out for this slot. Ties break
            by submission order (oldest first).
          </Rule>
          {isMod && (
            <Rule modOnly>
              Sessions marked <em>finished</em> (placement cap reached, or
              the manual "mark as finished" toggle) drop out before
              ranking. Re-publishing or bumping the cap brings them back.
            </Rule>
          )}
          <Rule>
            The number of sessions placed is capped at the number of
            available rooms in this slot's scope.
          </Rule>
        </Section>

        <Section index={2} title="Which room each session gets">
          <Rule>
            <strong>By default</strong>, the most-starred session takes
            the biggest available room, the next-most-starred takes the
            next biggest, and so on.
          </Rule>
          <Rule>
            <strong>Required room features</strong> override the default.
            A session can request specific features (projector,
            whiteboard, etc.). Only rooms that have all the requested
            features are considered. When several sessions need the same
            feature, the more-starred one gets the bigger matching room.
          </Rule>
          {isMod && (
            <Rule modOnly>
              <strong>Pins</strong> override everything else. A mod can
              pin a session to a specific room from the Sessions tab; the
              pinned room is reserved regardless of stars or features.
            </Rule>
          )}
          <Rule>
            Pins beat required features. Required features beat default
            star ranking.
          </Rule>
        </Section>

        <Section index={3} title="How participants are placed">
          <Rule>
            Each participant is assigned to one of <strong>their starred
            sessions</strong> that got a room. The system balances
            attendance across rooms — when several of your starred
            sessions are running, you go to the one with the most
            remaining capacity.
          </Rule>
          <Rule>
            The submitter of a session is always assigned to host it (when
            the session is placed). You can't be auto-placed somewhere
            else if you're hosting.
          </Rule>
          <Rule>
            You can override the auto-pick anytime via{" "}
            <strong>Change session</strong> in the slot view. Your manual
            pick is preserved if a mod re-runs the assignment.
          </Rule>
          <Rule>
            If you didn't star any sessions that got a room, you'll be
            listed as <em>unplaced</em> until you pick one.
          </Rule>
        </Section>

        <Section index={4} title="Avoiding double-bookings">
          <Rule>
            <strong>Same room:</strong> a room booked by an overlapping
            slot can't be used twice at the same time.
          </Rule>
          <Rule>
            <strong>Same speaker:</strong> a submitter hosting a session
            in one slot can't host a <em>different</em> session in an
            overlapping slot.
          </Rule>
          <Rule>
            <strong>Same session:</strong> the same session isn't placed
            in two overlapping slots — unless a mod has flagged it as{" "}
            <em>allows overlap</em> (for recurring workshops that run in
            parallel).
          </Rule>
          <Rule>
            <strong>Same participant:</strong> if you're assigned in one
            slot, you won't also be assigned in an overlapping slot.
          </Rule>
          <Rule>
            Excluded rooms, sessions, and participants are reported after
            the run as an informational note — not problems, just things
            the algorithm correctly worked around.
          </Rule>
        </Section>

        <Section index={5} title="Avoiding repeated sessions">
          <Rule>
            When a slot has <em>avoid repeats</em> enabled, the system
            won't put you in a session you've already attended in an
            earlier unconference slot of this conference. Hosts (the
            submitter) are exempt — leading your own session always wins.
          </Rule>
        </Section>

        {isMod && (
          <Section index={6} title="What blocks a run" modOnly>
            <Rule modOnly>
              <strong>Two pinned sessions for the same room.</strong> One
              of the pins has to change. The resolve panel lets you skip
              the session for this run, move the pin to another room, or
              clear the pin.
            </Rule>
            <Rule modOnly>
              <strong>A pinned room that isn't in the slot's room set.</strong>{" "}
              Either add the room to the slot's scope (via Configure) or
              change the pin.
            </Rule>
            <Rule modOnly>
              <strong>A session with unmet required features.</strong>{" "}
              Either every matching room is already taken by a
              higher-priority session, or the room that used to have
              those features lost them. The resolve panel lists every
              such session up front — if you'd fix one only to discover
              another in the next round, both appear in one pass.
            </Rule>
            <Rule modOnly>
              The resolve panel always offers <em>skip this run</em>{" "}
              (one-shot, no DB change) and <em>pin to a specific room</em>{" "}
              (permanent, overrides required features). For pin
              conflicts, you can also move or clear the pin in place.
            </Rule>
          </Section>
        )}

        <Section index={7} title="Mixer slots">
          <Rule>
            Mixers have no sessions — every participant is shuffled into
            a room evenly to meet new people. By default mixers are{" "}
            <em>exclusive</em>: the system tries hard not to put two
            participants in the same room across multiple mixers. Switch
            a mixer to <em>fresh shuffle</em> to ignore prior mixers and
            just randomize.
          </Rule>
          <Rule>
            The same overlap rules apply — a room or participant already
            taken by an overlapping slot is excluded.
          </Rule>
        </Section>

        <Section title="Re-running">
          <Rule>
            A moderator can re-run the assignment at any time. Manual
            picks are preserved. Anyone who wasn't manually pinned might
            be moved around as stars change.
          </Rule>
          <Rule>
            The algorithm is <strong>deterministic</strong>: same stars +
            same sessions + same rooms → same result. No random reshuffle
            on re-run (mixer slots use a stable per-slot seed).
          </Rule>
        </Section>

        <div style={{
          paddingTop: 8,
          display: "flex", justifyContent: "flex-end",
        }}>
          <Button variant="primary" onClick={onClose}>Got it</Button>
        </div>
      </div>
    </Sheet>
  );
}

// Trigger for the assignment-rules modal. Renders as a quiet, inline help
// link — circular `?` glyph plus optional label. Use this everywhere the
// user needs quick access to the rules (slot detail, Agenda header, etc.)
// without it competing visually with primary actions.
export function AssignmentRulesTrigger({
  isMod, label,
}: {
  isMod: boolean;
  /** Optional inline label next to the glyph. Defaults to no label (compact `?` button). */
  label?: string;
}) {
  // Local state is fine — multiple triggers each own their own modal.
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={label ? undefined : "How assignment works"}
        title="How assignment works"
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 6,
          height: 28,
          minWidth: 28,
          padding: label ? "0 12px" : 0,
          borderRadius: 999,
          border: "1px solid var(--borderColor-muted, var(--uncon-border-muted, #d0d7de))",
          background: "transparent",
          color: "var(--fgColor-muted, var(--uncon-fg-muted, #6e7781))",
          fontSize: 12,
          fontWeight: 600,
          lineHeight: 1,
          cursor: "pointer",
          transition: "color .15s ease, border-color .15s ease, background .15s ease",
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.color = "var(--fgColor-default, inherit)";
          e.currentTarget.style.borderColor = "var(--borderColor-default, var(--uncon-border, #afb8c1))";
          e.currentTarget.style.background = "var(--bgColor-muted, var(--uncon-bg-subtle, rgba(0,0,0,0.04)))";
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.color = "var(--fgColor-muted, var(--uncon-fg-muted, #6e7781))";
          e.currentTarget.style.borderColor = "var(--borderColor-muted, var(--uncon-border-muted, #d0d7de))";
          e.currentTarget.style.background = "transparent";
        }}
      >
        <span
          aria-hidden
          style={{
            display: "inline-block",
            fontSize: 14,
            fontWeight: 700,
            lineHeight: 1,
            // Slight optical alignment for the `?` glyph.
            transform: "translateY(-0.5px)",
          }}
        >
          ?
        </span>
        {label && <span>{label}</span>}
      </button>
      <AssignmentRulesModal
        open={open}
        onClose={() => setOpen(false)}
        isMod={isMod}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// Internal layout helpers — kept here so the page-level component file stays
// readable. They render simple cards / lists; no extra primitives needed.
// ---------------------------------------------------------------------------

// Section header: small kicker label ("Step 01") + title + optional Moderator
// pill. Underlined with a thin divider so each block is visually distinct
// without resorting to colored borders or heavy backgrounds.
function Section({
  title, children, modOnly, index,
}: {
  title: string;
  children: React.ReactNode;
  modOnly?: boolean;
  /** Optional step number rendered as a small kicker above the title. */
  index?: number;
}) {
  const muted = "var(--fgColor-muted, var(--uncon-fg-muted, #6e7781))";
  return (
    <div style={{ paddingTop: 4 }}>
      {index !== undefined && (
        <div style={{
          fontSize: 10, letterSpacing: 1.2, textTransform: "uppercase",
          fontWeight: 700, color: muted, marginBottom: 4,
        }}>
          Step {String(index).padStart(2, "0")}
        </div>
      )}
      <Stack direction="row" gap="condensed" align="center">
        <div style={{
          fontSize: 16, fontWeight: 600, lineHeight: 1.3,
          letterSpacing: -0.1,
        }}>
          {title}
        </div>
        {modOnly && <Badge variant="attention">Moderator</Badge>}
      </Stack>
      <div style={{
        marginTop: 10, paddingTop: 10,
        borderTop: "1px solid var(--borderColor-muted, var(--uncon-border-muted, #e5e7eb))",
        display: "flex", flexDirection: "column", gap: 8,
      }}>
        {children}
      </div>
    </div>
  );
}

// Rule: a single sentence (or two) explaining one piece of behavior. Quiet
// styling — small muted bullet + tight body — so a long list still feels
// scannable and not visually noisy.
function Rule({
  children, modOnly,
}: {
  children: React.ReactNode;
  modOnly?: boolean;
}) {
  const muted = "var(--fgColor-muted, var(--uncon-fg-muted, #6e7781))";
  return (
    <div
      style={{
        display: "flex",
        gap: 10,
        fontSize: 13,
        lineHeight: 1.55,
        color: "var(--fgColor-default, inherit)",
      }}
    >
      <span
        aria-hidden
        style={{
          flexShrink: 0,
          width: 4, height: 4, marginTop: 9,
          borderRadius: 999,
          background: modOnly
            ? "var(--borderColor-attention-emphasis, #ffaa00)"
            : "var(--fgColor-muted, var(--uncon-fg-muted, #afb8c1))",
        }}
      />
      <div style={{ flex: 1 }}>{children}</div>
      {modOnly && (
        <span style={{
          flexShrink: 0,
          alignSelf: "flex-start",
          fontSize: 10,
          fontWeight: 600,
          letterSpacing: 0.4,
          textTransform: "uppercase",
          color: muted,
          marginTop: 2,
        }}>
          mod
        </span>
      )}
    </div>
  );
}
