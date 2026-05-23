import { MIN_TRACK_SUBCOL_WIDTH } from "./constants";

export function SubEventCard({
  roomName, title, speakers, star, onClick,
}: {
  roomName: string;
  title: string | null;
  speakers: string | null;
  /** Star indicator + toggle. Same shape for static and unconference;
   *  `toggle` is a no-op when the parent didn't pass a callback. */
  star: {
    count: number;
    starredByMe: boolean;
    toggle: () => Promise<void>;
    /** When true, render a non-interactive "Required" badge in place of the
     *  toggle (mandatory static tracks). */
    required?: boolean;
  } | null;
  cardHeight: number; // kept for API compat; layout is now single-line
  onClick: () => void;
}) {
  const muted = "var(--fgColor-muted, var(--uncon-fg-muted, #6e7781))";

  // Everything fits on a single row: title (bold) · speakers (muted) · room
  // (muted) · star (right edge, if it's a starrable static track). Each
  // segment is its own flex child with `min-width: 0` so any of them can
  // ellipsis when the column is narrow — the title gets priority because it
  // grows fastest (`flex: 2 1 …`) while speakers/room shrink first.

  const tip = [title, speakers, roomName].filter(Boolean).join(" · ");

  return (
    <div
      onClick={onClick}
      title={tip}
      style={{
        flex: "1 0 auto",
        minWidth: MIN_TRACK_SUBCOL_WIDTH,
        maxWidth: "100%",
        background: "var(--bgColor-default, var(--uncon-bg, #fff))",
        border: "1px solid var(--borderColor-muted, var(--uncon-border-muted, #e5e7eb))",
        borderRadius: 4,
        padding: "2px 6px",
        display: "flex",
        alignItems: "center",
        gap: 6,
        fontSize: 11,
        lineHeight: "14px",
        overflow: "hidden",
        cursor: "pointer",
        // The card is one line tall regardless of slot height — that keeps
        // multi-track slots compact and avoids the previous overlap problem.
        height: 20,
      }}
    >
      {/* Title — the only element that grows. Anything else takes its own
          content width (and shrinks via ellipsis when the column is narrow),
          which keeps title-speakers-room visually adjacent instead of having
          a big void between the title and the room label. */}
      <strong
        style={{
          flex: "1 1 0", minWidth: 0,
          whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
        }}
      >
        {title && title.length > 0
          ? title
          : <span style={{ color: muted, fontStyle: "italic", fontWeight: 400 }}>(no talk)</span>}
      </strong>

      {/* speakers — muted; content width, shrinkable */}
      {speakers && (
        <span
          style={{
            flex: "0 1 auto", minWidth: 0,
            color: muted, fontSize: 10,
            whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
          }}
        >
          {speakers}
        </span>
      )}

      {/* room — small muted suffix with a dot marker so it reads as metadata */}
      <span
        style={{
          flex: "0 1 auto", minWidth: 0,
          color: muted, fontSize: 10,
          whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
          display: "inline-flex", alignItems: "center", gap: 4,
        }}
      >
        <span style={{
          display: "inline-block", width: 5, height: 5,
          borderRadius: "50%",
          background: "var(--borderColor-neutral-emphasis, var(--uncon-fg-muted, #6e7781))",
          flex: "0 0 auto",
        }} />
        {roomName}
      </span>

      {/* Star — same pill for static tracks and unconference submissions.
          Mandatory tracks render a non-interactive Required badge instead. */}
      {star && star.required && (
        <span
          title="Required — every participant is auto-attending."
          style={{
            flex: "0 0 auto",
            border: "1px solid var(--borderColor-attention-emphasis, #d4a72c)",
            background: "var(--bgColor-attention-muted, rgba(212,167,44,0.18))",
            color: "var(--fgColor-attention, #9a6700)",
            borderRadius: 10,
            padding: "0 6px",
            fontSize: 10,
            lineHeight: "14px",
            fontWeight: 600,
          }}
        >
          ★ Required
        </span>
      )}
      {star && !star.required && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); void star.toggle(); }}
          style={{
            flex: "0 0 auto",
            border: "1px solid var(--borderColor-default, var(--uncon-border, #d0d7de))",
            background: star.starredByMe
              ? "var(--bgColor-accent-muted, var(--uncon-primary, #2563eb))"
              : "transparent",
            color: star.starredByMe
              ? "var(--fgColor-onEmphasis, white)"
              : "var(--fgColor-default, inherit)",
            borderRadius: 10,
            padding: "0 6px",
            fontSize: 10,
            lineHeight: "14px",
            cursor: "pointer",
          }}
          title={
            star.starredByMe
              ? "Starred — on your schedule. Tap to unstar."
              : "Star this session — adds it to your schedule and signals interest for unconference."
          }
        >
          {star.starredByMe ? "★" : "☆"} {star.count}
        </button>
      )}
    </div>
  );
}
