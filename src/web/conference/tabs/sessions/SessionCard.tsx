import { useState } from "react";
import { Badge, Button } from "../../../design-system";
import type { Submission } from "../../types";
import {
  fmtTimeMaybeDay,
  spansMultipleDays,
  speakerLabel,
} from "../../helpers";
import { SpeakerList } from "../../SpeakerList";
import { Pill } from "../../ui/Pill";
import { TakeawaysPanel } from "../../ui/TakeawaysPanel";

export function SessionCard({
  slug,
  s,
  canEdit,
  canDelete,
  isMod,
  timeZone,
  roomName,
  highlight = false,
  onStar,
  onEdit,
  onDelete,
  onStatus,
}: {
  slug: string;
  s: Submission;
  canEdit: boolean;
  canDelete: boolean;
  isMod: boolean;
  timeZone: string;
  /** Pre-assigned room name when set, used to render the pinned badge.
   * Null when the submission isn't pinned or the room isn't loaded. */
  roomName: string | null;
  /** Deep-link highlight (?highlight=<id> share links, board spotlight QR).
   * Accent ring + tint so the targeted card pops out of the list. */
  highlight?: boolean;
  onStar: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onStatus: (action: "publish" | "unpublish" | "reject") => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const muted = "var(--fgColor-muted, var(--uncon-fg-muted, #6e7781))";
  const statusVariant =
    s.status === "published"
      ? "success"
      : s.status === "rejected"
        ? "danger"
        : "default";
  const multiDay = spansMultipleDays(
    s.scheduled_in.map((sch) => sch.starts_at),
    timeZone,
  );
  // Long descriptions get line-clamped with a Show more toggle so the list
  // stays scannable; short ones render in full with no toggle.
  const longDescription = (s.description?.length ?? 0) > 240;

  // Quiet "label · label" meta fragments. Everything placement-logistical
  // (status, room requirements, overlap allowance) is mod-only — participants
  // only ever see published sessions, so those badges were pure noise for
  // them (see sessions/types.ts on the participant filter).
  const metaBits: React.ReactNode[] = [];
  if (isMod) {
    metaBits.push(
      <Badge key="status" variant={statusVariant}>{s.status}</Badge>,
    );
  }
  if (speakerLabel(s)) {
    metaBits.push(
      <span key="by">
        by{" "}
        <span style={{ fontWeight: 500 }}>
          <SpeakerList slug={slug} speakers={s.speakers} isMod={isMod} />
        </span>
      </span>,
    );
  }
  if (isMod && roomName) metaBits.push(<span key="pin">pinned: {roomName}</span>);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 10,
        padding: 16,
        borderRadius: 8,
        border: highlight
          ? "2px solid var(--borderColor-accent-emphasis, var(--uncon-accent, #0969da))"
          : "1px solid var(--borderColor-muted, var(--uncon-border-muted, #e5e7eb))",
        background: highlight
          ? "var(--bgColor-accent-muted, var(--uncon-badge-primary-bg, rgba(64,132,246,0.08)))"
          : "var(--bgColor-default, var(--uncon-bg, transparent))",
      }}
    >
      {/* Title — the visual anchor of the card. */}
      <div
        style={{
          fontSize: 17,
          fontWeight: 600,
          lineHeight: "24px",
          wordBreak: "break-word",
        }}
      >
        {s.title}
      </div>

      {/* Meta line: quiet fragments + the few badges that earn attention. */}
      {(metaBits.length > 0 || s.priority !== "normal" || s.is_finished) && (
        <div
          style={{
            display: "flex",
            gap: 8,
            flexWrap: "wrap",
            alignItems: "center",
            fontSize: 12,
            color: muted,
          }}
        >
          {metaBits.map((bit, i) => (
            <span key={i} style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
              {i > 0 && <span aria-hidden style={{ opacity: 0.6 }}>·</span>}
              {bit}
            </span>
          ))}
          {s.priority !== "normal" && (
            <Badge variant={s.priority === "high" ? "attention" : "default"}>
              {s.priority === "high" ? "High priority" : "Low priority"}
            </Badge>
          )}
          {s.is_finished && (
            // Informational only under Path C: the badge tells everyone the
            // session is excluded from future unconference placement, but
            // doesn't gate stars or visibility.
            <Badge variant="default">
              {s.manually_finished ? "Marked complete" : "Fully scheduled"}
            </Badge>
          )}
        </div>
      )}

      {/* Scheduled offerings as chips — the "you star this, it shows up here"
          cause-and-effect surface (Path C). */}
      {s.scheduled_in.length > 0 && (
        <div
          style={{
            display: "flex",
            gap: 6,
            flexWrap: "wrap",
            alignItems: "center",
            fontSize: 12,
            color: muted,
          }}
        >
          <span
            style={{
              fontWeight: 600,
              textTransform: "uppercase",
              letterSpacing: 0.4,
            }}
          >
            Scheduled
          </span>
          {s.scheduled_in.map((sch) => (
            <span
              key={sch.slot_id}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                padding: "2px 8px",
                borderRadius: 999,
                background:
                  "var(--bgColor-accent-muted, rgba(64,132,246,0.12))",
                color: "var(--fgColor-accent, #2563eb)",
                fontSize: 11,
                fontWeight: 600,
                whiteSpace: "nowrap",
              }}
            >
              <span style={{ fontVariantNumeric: "tabular-nums" }}>
                {fmtTimeMaybeDay(sch.starts_at, timeZone, multiDay)}
              </span>
              <span aria-hidden style={{ opacity: 0.6 }}>·</span>
              <span>{sch.room_name}</span>
            </span>
          ))}
        </div>
      )}

      {s.description && (
        <>
          <div
            style={{
              fontSize: 14,
              lineHeight: "20px",
              color: "var(--fgColor-default, var(--uncon-fg, inherit))",
              whiteSpace: "pre-wrap",
              ...(longDescription && !expanded
                ? {
                    display: "-webkit-box",
                    WebkitBoxOrient: "vertical",
                    WebkitLineClamp: 4,
                    overflow: "hidden",
                  }
                : {}),
            }}
          >
            {s.description}
          </div>
          {longDescription && (
            <button
              type="button"
              onClick={() => setExpanded(!expanded)}
              style={{
                alignSelf: "flex-start",
                border: "none",
                background: "none",
                padding: 0,
                cursor: "pointer",
                fontSize: 12,
                fontWeight: 600,
                color: "var(--fgColor-accent, #2563eb)",
              }}
            >
              {expanded ? "Show less" : "Show more"}
            </button>
          )}
        </>
      )}

      {s.tags.length > 0 && (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {s.tags.map((t) => (
            <Pill key={t} variant="primary">
              {t}
            </Pill>
          ))}
        </div>
      )}

      {s.requirements.length > 0 && (
        <div
          style={{
            fontSize: 12,
            color: muted,
            display: "flex",
            gap: 6,
            flexWrap: "wrap",
            alignItems: "center",
          }}
        >
          <span
            style={{
              fontWeight: 600,
              textTransform: "uppercase",
              letterSpacing: 0.4,
            }}
          >
            Requires
          </span>
          {s.requirements.map((r) => (
            <Pill key={r}>{r}</Pill>
          ))}
        </div>
      )}

      {isMod && (s.room_requirements.length > 0 || s.allow_overlapping_placements) && (
        <div
          style={{
            fontSize: 12,
            color: muted,
            display: "flex",
            gap: 6,
            flexWrap: "wrap",
            alignItems: "center",
          }}
        >
          {s.room_requirements.length > 0 && (
            <Pill>needs: {s.room_requirements.join(", ")}</Pill>
          )}
          {s.allow_overlapping_placements && <Pill>allows overlap</Pill>}
        </div>
      )}

      {/* Action row. Two clusters separated by an auto-margin gap:
            • Left: engage / author / workflow (Star, Edit, Publish/Unpublish).
            • Right: destructive (Reject, then Delete — most-final last).
          Destructive cluster is visually offset so accidental taps land on a
          safer button, and when the row wraps on narrow screens the cluster
          stays together and right-aligns to its own line. */}
      <div
        style={{
          display: "flex",
          gap: 6,
          flexWrap: "wrap",
          alignItems: "center",
          paddingTop: 10,
          borderTop:
            "1px solid var(--borderColor-muted, var(--uncon-border-muted, #eef0f3))",
        }}
      >
        {s.status === "published" && (
          <Button
            size="small"
            onClick={onStar}
            variant={s.starred_by_me ? "primary" : "default"}
          >
            {s.starred_by_me ? "★ Starred" : "☆ Star"} · {s.star_count}
          </Button>
        )}
        {/* Share: copies a ?highlight=<id> deep link so recipients land on
            this session highlighted, wherever list pagination currently
            sits. Published-only — drafts aren't visible to recipients. */}
        {s.status === "published" && (
          <Button
            size="small"
            onClick={() => {
              const url = `${window.location.origin}/conferences/${encodeURIComponent(slug)}/?highlight=${s.id}`;
              void navigator.clipboard?.writeText(url).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }).catch(() => { /* clipboard unavailable — no-op */ });
            }}
          >
            {copied ? "Copied ✓" : "Copy link"}
          </Button>
        )}
        {/* Star count for sessions without a Star button (drafts — mod view). */}
        {s.status !== "published" && <Pill>★ {s.star_count}</Pill>}
        {canEdit && (
          <Button size="small" onClick={onEdit}>
            Edit
          </Button>
        )}
        {isMod && s.status !== "published" && (
          <Button
            size="small"
            variant="primary"
            onClick={() => onStatus("publish")}
          >
            Publish
          </Button>
        )}
        {isMod && s.status === "published" && (
          <Button size="small" onClick={() => onStatus("unpublish")}>
            Unpublish
          </Button>
        )}

        {(canDelete || (isMod && s.status !== "rejected")) && (
          <div
            role="group"
            aria-label="Destructive actions"
            style={{
              display: "flex",
              gap: 6,
              flexWrap: "wrap",
              marginLeft: "auto",
            }}
          >
            {isMod && s.status !== "rejected" && (
              <Button
                size="small"
                variant="danger"
                onClick={() => onStatus("reject")}
              >
                Reject
              </Button>
            )}
            {canDelete && (
              <Button size="small" variant="danger" onClick={onDelete}>
                {isMod ? "Delete" : "Withdraw"}
              </Button>
            )}
          </div>
        )}
      </div>

      {s.status === "published" && (
        <TakeawaysPanel
          slug={slug}
          submissionId={s.id}
          isMod={isMod}
          timeZone={timeZone}
        />
      )}
    </div>
  );
}
