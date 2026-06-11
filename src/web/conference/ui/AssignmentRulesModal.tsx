// =============================================================================
// AssignmentRulesModal
//
// Single source of truth for the plain-language explanation of how the
// unconference / mixer assignment algorithm works. Surfaced via a help link
// next to "Auto-fill this slot from stars" in the slot detail, and via a
// "How it works" link in the Agenda tab header.
//
// LAYOUT: The modal leads with a non-technical "Start here" summary (the 4
// BUILD_STEPS + the two-step ASSIGN_STEPS framing, imported from
// `agendaGuide.ts`). Everything below it is the deep mechanics, tucked into
// collapsible `<Disclosure>` sections so power users keep every rule but a
// first-time moderator isn't buried. A `<Glossary>` disclosure sits at the
// end. The plain-language copy (BUILD_STEPS / ASSIGN_STEPS / GLOSSARY) lives
// in `agendaGuide.ts` — never duplicate those strings here.
//
// MAINTENANCE: This component MUST stay in sync with the actual algorithm.
// When you change anything in:
//   - src/server/assignment.ts   (pure algorithm)
//   - src/server/rpc.ts          (runAssignmentForSlot / runMixerForSlot —
//                                 the route layer applies pin/tag matching,
//                                 overlap rules, cascade analysis, finished
//                                 filter, manual picks)
// ...update the matching disclosure below. Each `<Rule>` is grouped under the
// stage it belongs to so the document mirrors the algorithm's structure.
// Disclosure order (mirrors the algorithm): star meaning → which sessions get
// a room (01) → which room (02) → placing people (03) → overlap (04) →
// repeats (05) → planned tracks → what blocks a run (06, mod) → mixers (07) →
// authoring (mod) → whole-agenda assign → re-running → glossary.
// =============================================================================

import { useState } from "react";
import { Badge, Button, Sheet, Text } from "../../design-system";
import { ASSIGN_STEPS, BUILD_STEPS, GLOSSARY } from "./agendaGuide";

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
        <StartHere />

        <div style={{ fontSize: 13 }}>
          <Text muted>
            The rest is the detail. Open a section when you want to know exactly
            what the app does, in order — you don&apos;t need to read it to get
            started.
          </Text>
        </div>

        <Disclosure summary="What does “star” mean?" defaultOpen>
        <Section title="What does “star” mean?">
          <Rule>
            <strong>Star = “I want this on my schedule.”</strong> One
            action, two effects: the unconference algorithm uses your
            stars to decide which sessions get a room and which one to
            assign you to, AND every planned-slot track linked to a
            session you starred lands on your schedule automatically.
          </Rule>
          <Rule>
            <strong>Where you star matters less than what you star.</strong>{" "}
            The Sessions tab and the Agenda calendar both expose a star on
            each session — they hit the same underlying record. Star in
            either place and your schedule updates everywhere.
          </Rule>
          <Rule>
            <strong>Repeated offerings.</strong> When a mod duplicates a
            slot or schedules the same session in multiple slots, your
            single star yields a schedule entry per offering. The
            schedule view groups them with a “same session also at HH:MM”
            caption so you know they&apos;re the same content and can pick
            which one(s) to actually attend.
          </Rule>
          <Rule>
            <strong>“Required” tracks</strong> (mod-flagged keynotes /
            opening / closing) and sessions where you&apos;re the submitter
            land on your schedule whether you star them or not.
          </Rule>
          <Rule>
            Stars are public — counts drive the unconference ranking and
            are visible to everyone. The only private bit is{" "}
            <em>which</em> sessions <em>you</em> personally starred.
          </Rule>
        </Section>
        </Disclosure>

        <Disclosure summary="Which sessions get a room">
        <Section index={1} title="Which sessions get a room">
          <Rule>
            Sessions are ranked by <strong>star count</strong> — how many
            attendees have starred them. If there are more sessions than
            rooms, the least-starred drop out for this slot. Ties break
            by submission order (oldest first).
          </Rule>
          {isMod && (
            <Rule modOnly>
              Sessions tagged <em>Fully scheduled</em> (placement cap reached)
              or <em>Marked complete</em> (manual toggle) drop out of the
              ranking pool. Participants can still see and star them; bumping
              the cap or clearing the manual flag brings them back into
              future runs.
            </Rule>
          )}
          <Rule>
            The number of sessions placed is capped at the number of
            available rooms in this slot&apos;s scope.
          </Rule>
        </Section>
        </Disclosure>

        <Disclosure summary="Which room each session gets">
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
              <strong>Reserving a room</strong> overrides everything else. A
              mod can reserve a specific room for a session from the Sessions
              tab (also called pinning); that room is held for it regardless
              of stars or features.
            </Rule>
          )}
          <Rule>
            A reserved room beats required features. Required features beat
            default star ranking.
          </Rule>
        </Section>
        </Disclosure>

        <Disclosure summary="How participants are placed">
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
            the session is placed). You can&apos;t be auto-placed somewhere
            else if you&apos;re hosting.
          </Rule>
          <Rule>
            You can override the auto-pick anytime via{" "}
            <strong>Change session</strong> in the slot view. Your manual
            pick is preserved if a mod re-runs the assignment.
          </Rule>
          <Rule>
            If you didn&apos;t star any sessions that got a room, you&apos;ll be
            listed as <em>unplaced</em> until you pick one.
          </Rule>
        </Section>
        </Disclosure>

        <Disclosure summary="Avoiding double-bookings">
        <Section index={4} title="Avoiding double-bookings">
          <Rule>
            <strong>Same room:</strong> a room booked by an overlapping
            slot can&apos;t be used twice at the same time.
          </Rule>
          <Rule>
            <strong>Same speaker:</strong> a submitter hosting a session
            in one slot can&apos;t host a <em>different</em> session in an
            overlapping slot.
          </Rule>
          <Rule>
            <strong>Same session:</strong> the same session isn&apos;t placed
            in two overlapping slots — unless a mod has flagged it as{" "}
            <em>allows overlap</em> (for recurring workshops that run in
            parallel).
          </Rule>
          <Rule>
            <strong>Same participant:</strong> if you&apos;re assigned in one
            slot, you won&apos;t also be assigned in an overlapping slot.
            This includes <em>derived</em> attendance: starring a session
            that&apos;s scheduled in an overlapping planned slot counts as
            attending it, so the unconference algorithm leaves you alone
            for that time. The same goes for required tracks (everyone is
            busy then) and for sessions you submitted (you&apos;re speaking).
          </Rule>
          <Rule>
            Excluded rooms, sessions, and participants are reported after
            the run as an informational note — not problems, just things
            the algorithm correctly worked around.
          </Rule>
        </Section>
        </Disclosure>

        <Disclosure summary="Avoiding repeated sessions">
        <Section index={5} title="Avoiding repeated sessions">
          <Rule>
            When a slot has <em>avoid repeats</em> enabled, the system
            won&apos;t put you in a session you&apos;ve already attended in an
            earlier slot of this conference. That includes derived
            planned-track attendance — if you starred a session that ran
            earlier as a planned track, it counts as already attended.
            Hosts (the submitter) are exempt — leading your own session
            always wins.
          </Rule>
        </Section>
        </Disclosure>

        <Disclosure summary="Planned tracks &amp; soft capacity">
        <Section title="Planned tracks &amp; soft capacity">
          <Rule>
            Planned tracks come from the moderator-built schedule rather
            than the unconference algorithm. One star covers both: if you
            star a session that&apos;s also scheduled as a planned track,
            that planned offering lands on your schedule too.
          </Rule>
          <Rule>
            Stars don&apos;t enforce a hard room cap. When more people star a
            planned track than the room holds, the row shows a{" "}
            <em>room may be crowded</em> badge — advisory only. Not
            everyone who stars necessarily shows up, but it&apos;s a hint to
            arrive early or watch for an upgrade.
          </Rule>
          {isMod && (
            <Rule modOnly>
              The track editor surfaces the same warning to you (
              <em>Room may be full</em>) when stars exceed capacity.
              Consider moving the session to a bigger room or duplicating
              the slot as a sibling offering.
            </Rule>
          )}
          {isMod && (
            <Rule modOnly>
              When adding a track, you can pick <em>Auto-assign room</em>{" "}
              instead of choosing a specific room: the server picks the
              best match using the session&apos;s pinned room (if any), its
              required features, and the largest free room in scope.
              Conflicts surface as a readable error so you know what to
              clear or repin.
            </Rule>
          )}
        </Section>
        </Disclosure>

        {isMod && (
          <Disclosure summary="What blocks a run" modOnly>
          <Section index={6} title="What blocks a run" modOnly>
            <Rule modOnly>
              <strong>Two pinned sessions for the same room.</strong> One
              of the pins has to change. The resolve panel lets you skip
              the session for this run, move the pin to another room, or
              clear the pin.
            </Rule>
            <Rule modOnly>
              <strong>A pinned room that isn&apos;t in the slot&apos;s room set.</strong>{" "}
              Either add the room to the slot&apos;s scope (via Configure) or
              change the pin.
            </Rule>
            <Rule modOnly>
              <strong>A session with unmet required features.</strong>{" "}
              Either every matching room is already taken by a
              higher-priority session, or the room that used to have
              those features lost them. The resolve panel lists every
              such session up front — if you&apos;d fix one only to discover
              another in the next round, both appear in one pass.
            </Rule>
            <Rule modOnly>
              The resolve panel always offers <em>skip this run</em>{" "}
              (one-shot, no DB change) and <em>pin to a specific room</em>{" "}
              (permanent, overrides required features). For pin
              conflicts, you can also move or clear the pin in place.
            </Rule>
          </Section>
          </Disclosure>
        )}

        <Disclosure summary="Mixer slots">
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
        </Disclosure>

        {isMod && (
          <Disclosure summary="Authoring sessions onto the agenda" modOnly>
          <Section title="Authoring sessions onto the agenda" modOnly>
            <Rule modOnly>
              On an unconference slot you can <strong>place a session into a
              specific room</strong> yourself (or let the server auto-pick the
              largest free room). Placing the same session on several slots is
              how you build a <em>recurring</em> session that runs more than
              once.
            </Rule>
            <Rule modOnly>
              Placements you author are kept — re-running a single slot&apos;s
              auto-assignment won&apos;t wipe them. <em>Remove</em> a placement to
              take that session out of the slot.
            </Rule>
          </Section>
          </Disclosure>
        )}

        <Disclosure summary="Assigning attendees across the whole agenda">
        <Section title="Assigning attendees across the whole agenda">
          <Rule>
            <strong>Assign attendees</strong> (in the Agenda header) routes
            everyone across <em>all</em> unconference sessions at once, rather
            than one slot at a time. Because it sees the whole agenda, it can
            make smarter choices a single-slot run can&apos;t.
          </Rule>
          <Rule>
            <strong>Split across repeats.</strong> When a session runs more
            than once, its starrers are spread evenly across the occurrences
            instead of everyone piling into the first one.
          </Rule>
          <Rule>
            <strong>Look-ahead.</strong> If you starred two sessions in the
            same time and one of them also runs later, you&apos;ll be sent to the
            one that <em>doesn&apos;t</em> repeat now and caught up with the
            other one at its later showing — so you don&apos;t miss either.
          </Rule>
          <Rule>
            The hard rules still hold: never two sessions at once, never over a
            room&apos;s capacity, never the same session twice, and your manual
            picks and hosting duties are always respected.
          </Rule>
        </Section>
        </Disclosure>

        <Disclosure summary="Re-running">
        <Section title="Re-running">
          <Rule>
            A moderator can re-run the assignment at any time. Manual
            picks are preserved. Anyone who wasn&apos;t manually pinned might
            be moved around as stars change.
          </Rule>
          <Rule>
            The algorithm is <strong>deterministic</strong>: same stars +
            same sessions + same rooms → same result. No random reshuffle
            on re-run (mixer slots use a stable per-slot seed).
          </Rule>
        </Section>
        </Disclosure>

        <Disclosure summary="Glossary">
          <Glossary />
        </Disclosure>

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

// Trigger for the assignment-rules modal. Two shapes share one component:
//   - Compact (no `label`): a quiet circular `?` button, for sitting next to a
//     primary action (slot detail) where it must not compete.
//   - Labeled (`label` passed): a clearly discoverable help affordance — an
//     accent-colored "? <label>" link/pill — for headers and empty states
//     where the moderator should actually notice "How assignment works".
// Both open the same modal.
export function AssignmentRulesTrigger({
  isMod, label,
}: {
  isMod: boolean;
  /** Optional inline label next to the glyph. Defaults to no label (compact `?` button). */
  label?: string;
}) {
  // Local state is fine — multiple triggers each own their own modal.
  const [open, setOpen] = useState(false);

  // Accent tokens for the labeled (discoverable) variant; muted tokens for the
  // compact one. Centralized so hover handlers and base style stay in sync.
  const baseColor = label
    ? "var(--fgColor-accent, var(--uncon-primary, #2563eb))"
    : "var(--fgColor-muted, var(--uncon-fg-muted, #6e7781))";
  const baseBorder = label
    ? "var(--borderColor-accent-muted, var(--uncon-primary, #2563eb))"
    : "var(--borderColor-muted, var(--uncon-border-muted, #d0d7de))";
  const hoverColor = label
    ? "var(--fgColor-accent, var(--uncon-primary, #2563eb))"
    : "var(--fgColor-default, inherit)";
  const hoverBorder = label
    ? "var(--borderColor-accent-emphasis, var(--uncon-primary, #2563eb))"
    : "var(--borderColor-default, var(--uncon-border, #afb8c1))";
  const hoverBg = label
    ? "var(--bgColor-accent-muted, var(--uncon-bg-subtle, rgba(37,99,235,0.08)))"
    : "var(--bgColor-muted, var(--uncon-bg-subtle, rgba(0,0,0,0.04)))";

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
          border: `1px solid ${baseBorder}`,
          background: "transparent",
          color: baseColor,
          fontSize: 12,
          fontWeight: 600,
          lineHeight: 1,
          cursor: "pointer",
          transition: "color .15s ease, border-color .15s ease, background .15s ease",
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.color = hoverColor;
          e.currentTarget.style.borderColor = hoverBorder;
          e.currentTarget.style.background = hoverBg;
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.color = baseColor;
          e.currentTarget.style.borderColor = baseBorder;
          e.currentTarget.style.background = "transparent";
        }}
      >
        <span
          aria-hidden
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: 14,
            height: 14,
            borderRadius: 999,
            border: label ? "1.25px solid currentColor" : "none",
            fontSize: label ? 10 : 14,
            fontWeight: 700,
            lineHeight: 1,
            // Slight optical alignment for the bare `?` glyph.
            transform: label ? undefined : "translateY(-0.5px)",
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
// Content wrapper for the rules inside a Disclosure. The enclosing
// `<Disclosure summary=… modOnly=…>` owns the heading + Moderator badge (and,
// for the legacy non-collapsible callers, supplied the step kicker) — so this
// just lays the `<Rule>` list out. `title`/`index`/`modOnly` are accepted for
// call-site compatibility but intentionally not rendered here, to avoid
// duplicating the heading the Disclosure already shows.
function Section({
  children,
}: {
  title: string;
  children: React.ReactNode;
  modOnly?: boolean;
  index?: number;
}) {
  return (
    <div style={{
      paddingTop: 2,
      display: "flex", flexDirection: "column", gap: 8,
    }}>
      {children}
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

// ---------------------------------------------------------------------------
// "Start here" — the first thing a non-technical moderator reads. A boxed
// summary that pairs the 4-step build path (BUILD_STEPS) with the two-step
// assignment framing (ASSIGN_STEPS). Copy is owned by agendaGuide.ts; this
// only lays it out.
// ---------------------------------------------------------------------------
function StartHere() {
  const muted = "var(--fgColor-muted, var(--uncon-fg-muted, #6e7781))";
  return (
    <div
      style={{
        borderRadius: 8,
        border: "1px solid var(--borderColor-muted, var(--uncon-border-muted, #d0d7de))",
        background: "var(--bgColor-muted, var(--uncon-bg-subtle, rgba(0,0,0,0.025)))",
        padding: 16,
        display: "flex",
        flexDirection: "column",
        gap: 14,
      }}
    >
      <div>
        <div style={{
          fontSize: 10, letterSpacing: 1.2, textTransform: "uppercase",
          fontWeight: 700, color: "var(--fgColor-accent, var(--uncon-primary, #2563eb))",
          marginBottom: 4,
        }}>
          Start here
        </div>
        <div style={{ fontSize: 15, fontWeight: 600, lineHeight: 1.3 }}>
          From an empty conference to a running agenda
        </div>
        <div style={{ marginTop: 4, fontSize: 13, color: muted, lineHeight: 1.5 }}>
          Four steps, in order. Each one unlocks the next.
        </div>
      </div>

      <ol style={{
        listStyle: "none", margin: 0, padding: 0,
        display: "flex", flexDirection: "column", gap: 10,
      }}>
        {BUILD_STEPS.map((step, i) => (
          <li key={step.key} style={{ display: "flex", gap: 10 }}>
            <span
              aria-hidden
              style={{
                flexShrink: 0,
                width: 22, height: 22,
                borderRadius: 999,
                display: "inline-flex",
                alignItems: "center", justifyContent: "center",
                fontSize: 12, fontWeight: 700,
                background: "var(--bgColor-accent-muted, var(--uncon-bg-subtle, rgba(37,99,235,0.1)))",
                color: "var(--fgColor-accent, var(--uncon-primary, #2563eb))",
              }}
            >
              {i + 1}
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 600, lineHeight: 1.4 }}>
                {step.title}
              </div>
              <div style={{ fontSize: 12, color: muted, lineHeight: 1.5 }}>
                {step.blurb}
              </div>
            </div>
          </li>
        ))}
      </ol>

      <div style={{
        paddingTop: 12,
        borderTop: "1px solid var(--borderColor-muted, var(--uncon-border-muted, #e5e7eb))",
        display: "flex", flexDirection: "column", gap: 10,
      }}>
        <div style={{ fontSize: 13, fontWeight: 600 }}>
          That last step is two moves
        </div>
        {[ASSIGN_STEPS.place, ASSIGN_STEPS.assign].map((s) => (
          <div key={s.title} style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            <div style={{ fontSize: 12, fontWeight: 600 }}>{s.title}</div>
            <div style={{ fontSize: 12, color: muted, lineHeight: 1.5 }}>{s.blurb}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Disclosure — a styled native <details>/<summary>. Keeps every deep rule in
// the document but collapsed by default so the modal isn't a wall of text.
// `modOnly` adds the same "Moderator" pill the Section header uses.
// ---------------------------------------------------------------------------
function Disclosure({
  summary, children, modOnly, defaultOpen,
}: {
  summary: string;
  children: React.ReactNode;
  modOnly?: boolean;
  defaultOpen?: boolean;
}) {
  const muted = "var(--fgColor-muted, var(--uncon-fg-muted, #6e7781))";
  // Track open state so the chevron can rotate — native <details> doesn't let
  // us style the marker from inline styles alone. `defaultOpen` still seeds the
  // element's own `open` attribute so it works even before any toggle event.
  const [open, setOpen] = useState(defaultOpen ?? false);
  return (
    <details
      open={defaultOpen}
      onToggle={(e) => setOpen(e.currentTarget.open)}
      style={{
        borderRadius: 8,
        border: "1px solid var(--borderColor-muted, var(--uncon-border-muted, #e5e7eb))",
        background: "var(--bgColor-default, var(--uncon-bg, transparent))",
      }}
    >
      <summary
        style={{
          listStyle: "none",
          cursor: "pointer",
          padding: "12px 14px",
          display: "flex",
          alignItems: "center",
          gap: 8,
          fontSize: 14,
          fontWeight: 600,
          lineHeight: 1.3,
          userSelect: "none",
        }}
      >
        <span
          aria-hidden
          style={{
            flexShrink: 0,
            color: muted,
            fontSize: 11,
            transition: "transform .15s ease",
            transform: open ? "rotate(90deg)" : "rotate(0deg)",
          }}
        >
          ▸
        </span>
        {/* dangerouslySetInnerHTML avoided — the summary strings here may carry
            an HTML entity ("&amp;"); decode it for plain text rendering. */}
        <span style={{ flex: 1 }}>{summary.replace(/&amp;/g, "&")}</span>
        {modOnly && <Badge variant="attention">Moderator</Badge>}
      </summary>
      <div style={{ padding: "0 14px 14px" }}>
        {children}
      </div>
    </details>
  );
}

// ---------------------------------------------------------------------------
// Glossary — renders the shared GLOSSARY term/definition list. Plain dl so the
// term/definition relationship is semantic.
// ---------------------------------------------------------------------------
function Glossary() {
  const muted = "var(--fgColor-muted, var(--uncon-fg-muted, #6e7781))";
  return (
    <dl style={{
      margin: 0,
      display: "flex",
      flexDirection: "column",
      gap: 10,
    }}>
      {GLOSSARY.map((g) => (
        <div key={g.term} style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <dt style={{ fontSize: 13, fontWeight: 600, lineHeight: 1.4 }}>{g.term}</dt>
          <dd style={{ margin: 0, fontSize: 13, color: muted, lineHeight: 1.5 }}>
            {g.definition}
          </dd>
        </div>
      ))}
    </dl>
  );
}
