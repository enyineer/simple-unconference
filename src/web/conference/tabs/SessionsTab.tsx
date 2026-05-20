import { useEffect, useState } from "react";
import {
  Badge,
  Banner,
  Button,
  Form,
  Heading,
  Select,
  Sheet,
  Spinner,
  Stack,
  TextInput,
  Textarea,
} from "../../design-system";
import { api, ApiError, errorCode } from "../../api";
import type { Role, Submission } from "../types";
import { parseLabels, submitterLabel } from "../helpers";
import { EmptyState } from "../ui/EmptyState";
import { Pill } from "../ui/Pill";
import { Tip } from "../ui/Tip";
import { useRequirementsConfirm } from "../ui/RequirementsConfirm";

// Status filter values used by the Sessions tab. Participants only ever see
// `published`, so the filter chips are mod-only.
type SessionFilter = "all" | "submitted" | "published" | "rejected";

export function SessionsTab({
  slug,
  role,
  submissionMaxPlacementsDefault,
  participantSubmissionsEnabled,
}: {
  slug: string;
  role: Role;
  /** Conference-wide default cap. Used by the mod edit form to label the
   * "inherit" option (e.g. "Use conference default (once)"). */
  submissionMaxPlacementsDefault: number | null;
  /** When false, participants can't submit sessions: the "+ Submit a session"
   * button is hidden for them and a short notice explains why. Mods + owners
   * always see the button. */
  participantSubmissionsEnabled: boolean;
}) {
  const isMod = role === "owner" || role === "moderator";
  const [subs, setSubs] = useState<Submission[] | null>(null);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [tags, setTags] = useState("");
  const [requirements, setRequirements] = useState("");
  const [adding, setAdding] = useState(false);
  const [filter, setFilter] = useState<SessionFilter>(
    isMod ? "all" : "published",
  );
  const [editingId, setEditingId] = useState<number | null>(null);
  // One-shot banner after a successful submit. Cleared next time the user
  // opens the submit sheet (so it doesn't linger forever).
  const [submitNotice, setSubmitNotice] = useState<string | null>(null);

  // `submitter_id` on a Submission is a ConferenceIdentity.id, not a global
  // User.id, so we must read the per-conference "me" — `auth.me()` would
  // return the wrong id (or 401 for a participant who only has a conference
  // session). Without this, non-mods never see their own edit/delete buttons.
  const [myUserId, setMyUserId] = useState<number | null>(null);
  useEffect(() => {
    api.conferences
      .me({ slug })
      .then((u) => setMyUserId(u.id))
      .catch(() => {});
  }, [slug]);

  async function refresh() {
    // For participants the server already restricts to published, so we
    // don't need a status param; for mods we fetch everything and filter
    // client-side via the chips so toggling is instant.
    setSubs(await api.submissions.list({ slug }));
  }
  useEffect(() => {
    refresh().catch(() => setSubs([]));
  }, [slug]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    try {
      await api.submissions.create({
        slug,
        title,
        description,
        tags: parseLabels(tags),
        requirements: parseLabels(requirements),
      });
      setTitle("");
      setDescription("");
      setTags("");
      setRequirements("");
      setAdding(false);
      setSubmitNotice(
        isMod
          ? "Session created."
          : "Submitted. A moderator will review it before others can see it. You can edit and delete it from this page until then.",
      );
      await refresh();
    } catch (e) {
      alert(errorCode(e));
    }
  }

  async function deleteSubmission(s: Submission) {
    const msg = isMod
      ? `Delete "${s.title}"? This cannot be undone.`
      : `Withdraw "${s.title}"? It will be removed from the conference.`;
    if (!confirm(msg)) return;
    try {
      await api.submissions.delete({ slug, id: s.id });
      await refresh();
    } catch (e) {
      alert(errorCode(e));
    }
  }
  const requirementsConfirm = useRequirementsConfirm();
  async function toggleStar(s: Submission) {
    if (s.starred_by_me) {
      await api.submissions.unstar({ slug, id: s.id });
      await refresh();
      return;
    }
    requirementsConfirm.request({
      title: s.title,
      requirements: s.requirements,
      onConfirm: async () => {
        await api.submissions.star({ slug, id: s.id });
        await refresh();
      },
    });
  }
  async function setStatus(
    s: Submission,
    action: "publish" | "unpublish" | "reject",
  ) {
    if (action === "publish") await api.submissions.publish({ slug, id: s.id });
    else if (action === "unpublish")
      await api.submissions.unpublish({ slug, id: s.id });
    else await api.submissions.reject({ slug, id: s.id });
    await refresh();
  }

  function canEdit(s: Submission): boolean {
    if (isMod) return true;
    return s.submitter_id === myUserId && s.status === "submitted";
  }

  // The chip filter is mod-only. For non-mods the server already restricted
  // the list to published + own, so we show every row that came back.
  const filtered =
    subs &&
    (!isMod || filter === "all"
      ? subs
      : subs.filter((s) => s.status === filter));
  const editingSub = editingId
    ? (subs?.find((s) => s.id === editingId) ?? null)
    : null;

  const filterCounts = subs
    ? {
        all: subs.length,
        submitted: subs.filter((s) => s.status === "submitted").length,
        published: subs.filter((s) => s.status === "published").length,
        rejected: subs.filter((s) => s.status === "rejected").length,
      }
    : null;

  return (
    <Stack gap="spacious">
      {requirementsConfirm.modal}

      <Stack direction="row" justify="between" align="center" wrap>
        <Heading level={2}>Sessions</Heading>
        {(isMod || participantSubmissionsEnabled) && (
          <Button
            variant="primary"
            onClick={() => {
              setSubmitNotice(null);
              setAdding(true);
            }}
          >
            + Submit a session
          </Button>
        )}
      </Stack>

      {!isMod && !participantSubmissionsEnabled && (
        <Banner variant="info">
          Session submissions are currently closed. Only moderators can add new
          sessions to this conference.
        </Banner>
      )}

      {submitNotice && <Banner variant="success">{submitNotice}</Banner>}

      <Sheet
        open={adding}
        onClose={() => setAdding(false)}
        title="Submit a session"
      >
        <Tip>A moderator publishes your session before others can star it.</Tip>
        <Form onSubmit={submit}>
          <TextInput
            label="Title"
            required
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
          <Textarea
            label="Description"
            rows={4}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
          <TextInput
            label="Tags (comma-separated)"
            placeholder="e.g. workshop, discussion, lightning"
            value={tags}
            onChange={(e) => setTags(e.target.value)}
          />
          <TextInput
            label="Requirements (comma-separated)"
            placeholder="e.g. laptop, github account"
            value={requirements}
            onChange={(e) => setRequirements(e.target.value)}
          />
          <Stack direction="row" gap="condensed">
            <Button type="submit" variant="primary">
              Submit
            </Button>
            <Button onClick={() => setAdding(false)}>Cancel</Button>
          </Stack>
        </Form>
      </Sheet>

      {/* Mod-only status filter as chips with counts — easier to scan than
          a single toggle button. Participants always see published. */}
      {isMod && filterCounts && (
        <Stack direction="row" gap="condensed" wrap>
          {(
            ["all", "submitted", "published", "rejected"] as SessionFilter[]
          ).map((k) => (
            <Button
              key={k}
              size="small"
              variant={filter === k ? "primary" : "default"}
              onClick={() => setFilter(k)}
            >
              {filterLabel(k)}{" "}
              <span style={{ opacity: 0.7, marginLeft: 4 }}>
                {filterCounts[k]}
              </span>
            </Button>
          ))}
        </Stack>
      )}

      {!filtered ? (
        <Spinner label="Loading…" />
      ) : filtered.length === 0 ? (
        <EmptyState
          message={
            isMod && filter !== "all" && subs && subs.length > 0
              ? `No sessions with status "${filter}".`
              : "No sessions yet. Be the first to submit one."
          }
        />
      ) : (
        <Stack gap="condensed">
          {filtered.map((s) => (
            <SessionCard
              key={s.id}
              s={s}
              canEdit={canEdit(s)}
              canDelete={canEdit(s)}
              isMod={isMod}
              onStar={() => toggleStar(s)}
              onEdit={() => setEditingId(s.id)}
              onDelete={() => deleteSubmission(s)}
              onStatus={(action) => setStatus(s, action)}
            />
          ))}
        </Stack>
      )}

      {/* Edit form opens in a Sheet — keeps the list still while you edit. */}
      <Sheet
        open={!!editingSub}
        onClose={() => setEditingId(null)}
        title={editingSub ? `Edit: ${editingSub.title}` : ""}
      >
        {editingSub && (
          <SessionEditForm
            slug={slug}
            submission={editingSub}
            isMod={isMod}
            conferenceDefaultMaxPlacements={submissionMaxPlacementsDefault}
            onCancel={() => setEditingId(null)}
            onSaved={async () => {
              setEditingId(null);
              await refresh();
            }}
          />
        )}
      </Sheet>
    </Stack>
  );
}

function filterLabel(k: SessionFilter): string {
  return (
    {
      all: "All",
      submitted: "Submitted",
      published: "Published",
      rejected: "Rejected",
    } as const
  )[k];
}

function SessionCard({
  s,
  canEdit,
  canDelete,
  isMod,
  onStar,
  onEdit,
  onDelete,
  onStatus,
}: {
  s: Submission;
  canEdit: boolean;
  canDelete: boolean;
  isMod: boolean;
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
          <Badge variant="default">
            {s.manually_finished ? "finished (manual)" : "finished"}
          </Badge>
        )}
        <Pill>★ {s.star_count}</Pill>
        {submitterLabel(s) && (
          <span style={{ color: muted, fontSize: 12 }}>
            by <span style={{ fontWeight: 500 }}>{submitterLabel(s)}</span>
          </span>
        )}
      </div>

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
            gridRow: 4,
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
            gridRow: 5,
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
          gridRow: 6,
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
    </div>
  );
}

// Edit form for a submission — rendered inside a Sheet, so we drop the
// outer Card chrome the previous inline version used.
function SessionEditForm({
  slug,
  submission,
  isMod,
  conferenceDefaultMaxPlacements,
  onCancel,
  onSaved,
}: {
  slug: string;
  submission: Submission;
  isMod: boolean;
  conferenceDefaultMaxPlacements: number | null;
  onCancel: () => void;
  onSaved: () => Promise<void> | void;
}) {
  const [title, setTitle] = useState(submission.title);
  const [description, setDescription] = useState(submission.description);
  const [tags, setTags] = useState(submission.tags.join(", "));
  const [requirements, setRequirements] = useState(
    submission.requirements.join(", "),
  );
  // Mod-only state. `inherit` means "use the conference default" (stored as
  // null on the row); `once` and `limited` set an explicit per-submission cap.
  const [capMode, setCapMode] = useState<"inherit" | "once" | "limited">(() => {
    if (submission.max_placements === null) return "inherit";
    if (submission.max_placements === 1) return "once";
    return "limited";
  });
  const [capValue, setCapValue] = useState<string>(
    submission.max_placements !== null && submission.max_placements > 1
      ? String(submission.max_placements)
      : "2",
  );
  const [manuallyFinished, setManuallyFinished] = useState(
    submission.manually_finished,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const patch: {
        slug: string;
        id: number;
        title: string;
        description: string;
        tags: string[];
        requirements: string[];
        max_placements?: number | null;
        manually_finished?: boolean;
      } = {
        slug,
        id: submission.id,
        title,
        description,
        tags: parseLabels(tags),
        requirements: parseLabels(requirements),
      };
      if (isMod) {
        let next: number | null;
        if (capMode === "inherit") next = null;
        else if (capMode === "once") next = 1;
        else {
          const parsed = Number.parseInt(capValue, 10);
          if (!Number.isFinite(parsed) || parsed < 1) {
            setError("Limit must be a positive whole number.");
            setBusy(false);
            return;
          }
          next = parsed;
        }
        patch.max_placements = next;
        patch.manually_finished = manuallyFinished;
      }
      await api.submissions.update(patch);
      await onSaved();
    } catch (e) {
      setError(errorCode(e));
    } finally {
      setBusy(false);
    }
  }

  function inheritLabel(): string {
    if (conferenceDefaultMaxPlacements === null)
      return "Use conference default (unlimited)";
    if (conferenceDefaultMaxPlacements === 1)
      return "Use conference default (assign once)";
    return `Use conference default (${conferenceDefaultMaxPlacements} placements)`;
  }

  return (
    <Stack gap="condensed">
      {error && <Banner variant="critical">{error}</Banner>}
      <Form onSubmit={save}>
        <TextInput
          label="Title"
          required
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
        <Textarea
          label="Description"
          rows={4}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
        <TextInput
          label="Tags (comma-separated)"
          value={tags}
          onChange={(e) => setTags(e.target.value)}
        />
        <TextInput
          label="Requirements (comma-separated)"
          value={requirements}
          onChange={(e) => setRequirements(e.target.value)}
        />
        {isMod && (
          <>
            <Select
              label="How many times can this session be assigned?"
              value={capMode}
              onChange={(e) =>
                setCapMode(e.target.value as "inherit" | "once" | "limited")
              }
              options={[
                { value: "inherit", label: inheritLabel() },
                { value: "once", label: "Assign once" },
                { value: "limited", label: "Limit to N placements" },
              ]}
            />
            {capMode === "limited" && (
              <TextInput
                label="Max placements"
                type="number"
                value={capValue}
                onChange={(e) => setCapValue(e.target.value)}
              />
            )}
            <label
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                fontSize: 13,
                color: "var(--fgColor-default, var(--uncon-fg, inherit))",
              }}
            >
              <input
                type="checkbox"
                checked={manuallyFinished}
                onChange={(e) => setManuallyFinished(e.target.checked)}
              />
              Mark as finished
              <span
                style={{
                  color: "var(--fgColor-muted, var(--uncon-fg-muted, #6e7781))",
                  fontSize: 12,
                }}
              >
                — hides from participants and excludes from assignment,
                regardless of count
              </span>
            </label>
            <div
              style={{
                fontSize: 12,
                color: "var(--fgColor-muted, var(--uncon-fg-muted, #6e7781))",
              }}
            >
              Currently placed {submission.placement_count}{" "}
              {submission.placement_count === 1 ? "time" : "times"}.
            </div>
          </>
        )}
        <Stack direction="row" gap="condensed">
          <Button type="submit" variant="primary" disabled={busy}>
            Save
          </Button>
          <Button onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
        </Stack>
      </Form>
    </Stack>
  );
}
