import { Badge, Button } from "../../../design-system";
import type { Submission } from "../../types";
import {
  fmtTimeMaybeDay,
  spansMultipleDays,
  submitterLabel,
} from "../../helpers";
import { ProfileLink } from "../../ProfileLink";
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
  onStar: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onStatus: (action: "publish" | "unpublish" | "reject") => void;
}) {
  const muted = "var(--fgColor-muted, var(--uncon-fg-muted, #6e7781))";
  const statusVariant =
    s.status === "published"
      ? "success"
      : s.status === "rejected"
        ? "danger"
        : "default";

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "1fr auto",
        gap: "8px 12px",
        padding: 16,
        borderRadius: 8,
        border:
          "1px solid var(--borderColor-muted, var(--uncon-border-muted, #e5e7eb))",
        background: "var(--bgColor-default, var(--uncon-bg, transparent))",
      }}
    >
      <div
        style={{
          gridColumn: 1,
          gridRow: 1,
          display: "flex",
          gap: 6,
          flexWrap: "wrap",
          alignItems: "center",
        }}
      >
        <Badge variant={statusVariant}>{s.status}</Badge>
        {s.is_finished && (
          // Informational only under Path C: the badge tells everyone the
          // session is excluded from future unconference placement, but
          // doesn't gate stars or visibility.
          <Badge variant="default">
            {s.manually_finished ? "Marked complete" : "Fully scheduled"}
          </Badge>
        )}
        {roomName && (
          <Badge variant="attention">pinned: {roomName}</Badge>
        )}
        {s.priority !== "normal" && (
          <Badge variant={s.priority === "high" ? "attention" : "default"}>
            {s.priority === "high" ? "High priority" : "Low priority"}
          </Badge>
        )}
        {s.room_requirements.length > 0 && (
          <Badge variant="default">
            needs: {s.room_requirements.join(", ")}
          </Badge>
        )}
        {s.allow_overlapping_placements && (
          <Badge variant="default">allows overlap</Badge>
        )}
        <Pill>★ {s.star_count}</Pill>
        {submitterLabel(s) && (
          <span style={{ color: muted, fontSize: 12 }}>
            by{" "}
            <ProfileLink
              slug={slug}
              identityId={s.submitter_id ?? null}
              linkable={isMod || s.submitter_profile_published}
            >
              <span style={{ fontWeight: 500 }}>{submitterLabel(s)}</span>
            </ProfileLink>
          </span>
        )}
      </div>

      {s.scheduled_in.length > 0 && (() => {
        // Path C cause-and-effect surface: "you star this session, it
        // shows up on your schedule at these times." Listing every linked
        // TrackAssignment with its time + room makes the connection
        // explicit at the moment the user is deciding whether to star.
        //
        // When the scheduled offerings span more than one conference-local
        // day, prefix every time with the short day so users can tell
        // "20:07" tomorrow from "20:07" today — same rule the My schedule
        // tab uses for repeat-offering alternates.
        const multiDay = spansMultipleDays(
          s.scheduled_in.map((sch) => sch.starts_at),
          timeZone,
        );
        return (
          <div
            style={{
              gridColumn: "1 / -1",
              gridRow: 4,
              fontSize: 12,
              color: muted,
            }}
          >
            Scheduled at:{" "}
            {s.scheduled_in.map((sch, i) => (
              <span key={sch.slot_id}>
                {i > 0 ? " · " : ""}
                <span style={{ fontVariantNumeric: "tabular-nums", fontWeight: 500 }}>
                  {fmtTimeMaybeDay(sch.starts_at, timeZone, multiDay)}
                </span>{" "}
                <span>{sch.room_name}</span>
              </span>
            ))}
          </div>
        );
      })()}

      <div
        style={{
          gridColumn: "1 / -1",
          gridRow: 2,
          fontSize: 18,
          fontWeight: 600,
          lineHeight: "24px",
          wordBreak: "break-word",
        }}
      >
        {s.title}
      </div>

      {s.description && (
        <div
          style={{
            gridColumn: "1 / -1",
            gridRow: 3,
            fontSize: 14,
            lineHeight: "20px",
            color: "var(--fgColor-default, var(--uncon-fg, inherit))",
            whiteSpace: "pre-wrap",
          }}
        >
          {s.description}
        </div>
      )}

      {s.tags.length > 0 && (
        <div
          style={{
            gridColumn: "1 / -1",
            gridRow: 5,
            display: "flex",
            gap: 6,
            flexWrap: "wrap",
          }}
        >
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
            gridColumn: "1 / -1",
            gridRow: 6,
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

      {/* Action row. Two clusters separated by an auto-margin gap:
            • Left: engage / author / workflow (Star, Edit, Publish/Unpublish).
            • Right: destructive (Reject, then Delete — most-final last).
          Destructive cluster is visually offset so accidental taps land on a
          safer button, and when the row wraps on narrow screens the cluster
          stays together and right-aligns to its own line. */}
      <div
        style={{
          gridColumn: "1 / -1",
          gridRow: 7,
          display: "flex",
          gap: 6,
          flexWrap: "wrap",
          alignItems: "center",
          marginTop: 4,
          paddingTop: 8,
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
            {s.starred_by_me ? "★ Starred" : "☆ Star"}
          </Button>
        )}
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
        <div style={{ gridColumn: "1 / -1", gridRow: 8 }}>
          <TakeawaysPanel
            slug={slug}
            submissionId={s.id}
            isMod={isMod}
            timeZone={timeZone}
          />
        </div>
      )}
    </div>
  );
}
