import { useEffect, useMemo, useState } from "react";
import {
  Button, Heading, Select, Stack, Text, TextInput,
} from "../../design-system";
import { useToast } from "../../design-system/hooks";
import type { ChangeEvent, FocusEvent } from "react";
import { plugins as designPlugins } from "../../design-system/core/registry";
import { listTimeZones } from "../../../shared/tz";
import { api, errorCode } from "../../api";
import { CopyButton } from "../ui/CopyButton";
import { SettingsSection } from "../ui/SettingsSection";
import { SearchableSelect } from "../ui/SearchableSelect";

// One-shot memoization for the IANA timezone list inside SettingsTab.
function useMemoTimezones() {
  return useMemo(() => listTimeZones().map((tz) => ({ value: tz, label: tz })), []);
}

// Keys identify which SettingsSection just saved successfully, so its
// checkmark animation runs (and adjacent sections stay quiet).
type SavedKey =
  | "name"
  | "timezone"
  | "design"
  | "mixer"
  | "participant_submissions"
  | "session_reuse";

// Mod-only quota counters surfaced by the server in `conferences.get`. Each
// resource carries `limit: null` when the corresponding cap is disabled
// (env var = 0); the UsageCard hides those rows.
interface UsageCounters {
  participants:    { current: number; limit: number | null };
  pending_invites: { current: number; limit: number | null };
  rooms:           { current: number; limit: number | null };
  total_sessions:  { current: number; limit: null };
}

export function SettingsTab({
  slug, currentName, currentDs, currentTz, currentMixerAvoidRepeats,
  currentSubmissionMaxPlacements, currentParticipantSubmissionsEnabled,
  usage,
  onNameChange, onDsChange, onTzChange, onMixerAvoidRepeatsChange,
  onSubmissionMaxPlacementsChange, onParticipantSubmissionsEnabledChange,
  onDeleted, onTransferred,
}: {
  slug: string;
  currentName: string;
  currentDs: string;
  currentTz: string;
  currentMixerAvoidRepeats: boolean;
  currentSubmissionMaxPlacements: number | null;
  currentParticipantSubmissionsEnabled: boolean;
  /** Live mod-only quota snapshot from conferences.get. `null` for non-mods. */
  usage: UsageCounters | null;
  onNameChange: (name: string) => void;
  onDsChange: (id: string) => void;
  onTzChange: (tz: string) => void;
  onMixerAvoidRepeatsChange: (v: boolean) => void;
  onSubmissionMaxPlacementsChange: (v: number | null) => void;
  onParticipantSubmissionsEnabledChange: (v: boolean) => void;
  /** Called after the owner confirms and the server deletes the conference.
   *  The parent should navigate away — every subsequent request scoped to
   *  this slug 404s. */
  onDeleted: () => void;
  /** Called after the owner successfully transfers the conference to another
   *  user. The parent should navigate away — the caller has just dropped
   *  themselves from owner to no role, so subsequent owner-only requests
   *  will 403. */
  onTransferred: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  // Which section just successfully saved. Drives the per-section checkmark
  // animation; cleared automatically after 1.5s so the pulse is brief.
  const [savedKey, setSavedKey] = useState<SavedKey | null>(null);
  useEffect(() => {
    if (!savedKey) return;
    const t = setTimeout(() => setSavedKey(null), 1500);
    return () => clearTimeout(t);
  }, [savedKey]);
  function flashSaved(k: SavedKey) { setSavedKey(k); }
  // Two-field model: a mode dropdown ("once" | "limited" | "unlimited") plus
  // a number input only visible in "limited" mode. Keeps the UI obvious while
  // letting moderators pick any positive cap. The mode select auto-saves on
  // change; the typed cap commits on blur (so partial typing like "1" → "10"
  // doesn't fire a save mid-edit).
  const initialCapMode: "once" | "limited" | "unlimited" =
    currentSubmissionMaxPlacements === null
      ? "unlimited"
      : currentSubmissionMaxPlacements === 1
        ? "once"
        : "limited";
  const [capMode, setCapMode] = useState<"once" | "limited" | "unlimited">(initialCapMode);
  const [capValue, setCapValue] = useState<string>(
    currentSubmissionMaxPlacements !== null && currentSubmissionMaxPlacements > 1
      ? String(currentSubmissionMaxPlacements)
      : "2",
  );
  const tzOptions = useMemoTimezones();

  // Locally-edited name; commits on blur (mirroring the "limited" cap input).
  // Kept in sync with `currentName` when the parent's value changes (e.g. an
  // optimistic save round-trip or a name update from elsewhere). Uses the
  // "adjust state during render" pattern so we don't trigger an extra effect
  // pass — React reconciles the resulting setState before painting.
  const [nameDraft, setNameDraft] = useState(currentName);
  const [lastSyncedName, setLastSyncedName] = useState(currentName);
  if (lastSyncedName !== currentName) {
    setLastSyncedName(currentName);
    setNameDraft(currentName);
  }

  async function updateName(next: string) {
    const trimmed = next.trim();
    if (trimmed.length === 0) {
      setNameDraft(currentName);
      toast.error("Conference name cannot be empty.");
      return;
    }
    if (trimmed === currentName) return;
    setBusy(true);
    try {
      await api.conferences.update({ slug, name: trimmed });
      onNameChange(trimmed);
      flashSaved("name");
    } catch (e) {
      toast.error(errorCode(e));
    } finally {
      setBusy(false);
    }
  }

  async function updateDs(id: string) {
    if (id === currentDs) return;
    setBusy(true);
    try {
      await api.conferences.update({ slug, design_system: id });
      onDsChange(id);
      flashSaved("design");
    } catch (e) {
      toast.error(errorCode(e));
    } finally {
      setBusy(false);
    }
  }

  async function updateTz(next: string) {
    if (next === currentTz) return;
    setBusy(true);
    try {
      await api.conferences.update({ slug, timezone: next });
      onTzChange(next);
      flashSaved("timezone");
    } catch (e) {
      toast.error(errorCode(e));
    } finally {
      setBusy(false);
    }
  }

  async function updateParticipantSubmissions(next: boolean) {
    if (next === currentParticipantSubmissionsEnabled) return;
    setBusy(true);
    try {
      await api.conferences.update({ slug, participant_submissions_enabled: next });
      onParticipantSubmissionsEnabledChange(next);
      flashSaved("participant_submissions");
    } catch (e) {
      toast.error(errorCode(e));
    } finally {
      setBusy(false);
    }
  }

  async function updateMixerAvoidRepeats(next: boolean) {
    if (next === currentMixerAvoidRepeats) return;
    setBusy(true);
    try {
      await api.conferences.update({ slug, mixer_avoid_repeats_default: next });
      onMixerAvoidRepeatsChange(next);
      flashSaved("mixer");
    } catch (e) {
      toast.error(errorCode(e));
    } finally {
      setBusy(false);
    }
  }

  async function saveCap(next: number | null) {
    if (next === currentSubmissionMaxPlacements) return;
    setBusy(true);
    try {
      await api.conferences.update({ slug, submission_max_placements_default: next });
      onSubmissionMaxPlacementsChange(next);
      flashSaved("session_reuse");
    } catch (e) {
      toast.error(errorCode(e));
    } finally {
      setBusy(false);
    }
  }

  function onCapModeChange(e: ChangeEvent<HTMLSelectElement>) {
    const mode = e.target.value as "once" | "limited" | "unlimited";
    setCapMode(mode);
    if (mode === "once") {
      saveCap(1);
    } else if (mode === "unlimited") {
      saveCap(null);
    } else {
      // "limited": save the currently-typed value if it's already a valid
      // positive integer. Otherwise wait for the user to fix it and blur.
      const parsed = Number.parseInt(capValue, 10);
      if (Number.isFinite(parsed) && parsed >= 1) saveCap(parsed);
    }
  }

  function onCapValueBlur(_e: FocusEvent<HTMLInputElement>) {
    if (capMode !== "limited") return;
    const parsed = Number.parseInt(capValue, 10);
    if (!Number.isFinite(parsed) || parsed < 1) {
      toast.error("Limit must be a positive whole number.");
      return;
    }
    saveCap(parsed);
  }

  return (
    <Stack gap="spacious">
      <Heading level={2}>Settings</Heading>

      {/* Errors surface as bottom-anchored toasts (via useToast) instead of
          a top-of-tab banner, so they remain visible no matter where in the
          form the user is when an action fails. Successful saves still use
          the per-section checkmark animation — no notice needed. */}

      {usage && <UsageCard usage={usage} />}

      <SettingsSection
        title="Conference name"
        description="The display name shown to participants in the header and on the conferences list. The URL slug does not change."
        saved={savedKey === "name"}
      >
        <TextInput
          label="Name"
          value={nameDraft}
          disabled={busy}
          onChange={(e) => setNameDraft(e.target.value)}
          onBlur={(e) => updateName(e.target.value)}
        />
      </SettingsSection>

      <SettingsSection
        title="Timezone"
        description="All slot times in this conference are interpreted in the selected timezone — regardless of where the organizer or attendees are located."
        saved={savedKey === "timezone"}
      >
        <SearchableSelect
          label="Conference timezone"
          value={currentTz}
          disabled={busy}
          onChange={updateTz}
          options={tzOptions}
          placeholder="Search timezones…"
        />
      </SettingsSection>

      <SettingsSection
        title="Design system"
        description="Choose which design system your conference uses. The change applies to everyone immediately."
        saved={savedKey === "design"}
      >
        <Select
          label="Theme"
          value={currentDs}
          disabled={busy}
          onChange={(e) => updateDs(e.target.value)}
          options={designPlugins.map((p) => ({ value: p.id, label: p.label }))}
        />
      </SettingsSection>

      <SettingsSection
        title="Mixer default"
        description={
          "Default mode for new mixer slots in this conference. Exclusive mix tries to "
          + "avoid putting the same participants in the same room across mixers — useful "
          + "for repeated \"meet each other\" slots. Fresh shuffle ignores prior mixers and "
          + "splits everyone evenly each time. Moderators can override this per slot."
        }
        saved={savedKey === "mixer"}
      >
        <Select
          label="When assigning a mixer"
          value={currentMixerAvoidRepeats ? "exclusive" : "fresh"}
          disabled={busy}
          onChange={(e) => updateMixerAvoidRepeats(e.target.value === "exclusive")}
          options={[
            { value: "exclusive", label: "Exclusive mix (avoid re-pairing participants)" },
            { value: "fresh", label: "Fresh shuffle (ignore prior mixers)" },
          ]}
        />
      </SettingsSection>

      <SettingsSection
        title="Participant submissions"
        description={
          "When enabled, every member of this conference can submit a session "
          + "for moderator review. When disabled, only owners + moderators can "
          + "create sessions; the participant-facing submit button is hidden."
        }
        saved={savedKey === "participant_submissions"}
      >
        <Select
          label="Who can submit sessions"
          value={currentParticipantSubmissionsEnabled ? "everyone" : "mods_only"}
          disabled={busy}
          onChange={(e) => updateParticipantSubmissions(e.target.value === "everyone")}
          options={[
            { value: "everyone", label: "Everyone (default)" },
            { value: "mods_only", label: "Only owners + moderators" },
          ]}
        />
      </SettingsSection>

      <SettingsSection
        title="Session reuse"
        saved={savedKey === "session_reuse"}
        description={
          "How many times a published session can be placed in this conference. "
          + "Counts both planned-slot tracks and unconference placements. The "
          + "default is \"assign once\" — once a session hits its cap it's "
          + "tagged \"Fully scheduled\" and excluded from future unconference "
          + "ranking. Participants still see the session and can still star it "
          + "(starring derives any linked planned tracks onto their schedule); "
          + "the cap only gates the algorithm. Mods can override per session, "
          + "or use the manual \"mark as finished\" toggle on a submission."
        }
      >
        <Select
          label="Default for new sessions"
          value={capMode}
          disabled={busy}
          onChange={onCapModeChange}
          options={[
            { value: "once", label: "Assign once (default)" },
            { value: "limited", label: "Limit to N placements" },
            { value: "unlimited", label: "Unlimited (allow re-use)" },
          ]}
        />
        {capMode === "limited" && (
          <TextInput
            label="Max placements"
            type="number"
            value={capValue}
            onChange={(e) => setCapValue(e.target.value)}
            onBlur={onCapValueBlur}
          />
        )}
      </SettingsSection>

      <JoinLinkSection slug={slug} />

      <DangerZone
        slug={slug}
        confName={currentName}
        busy={busy}
        onBusy={setBusy}
        onDeleted={onDeleted}
        onTransferred={onTransferred}
      />
    </Stack>
  );
}

// ---------------------------------------------------------------------------
// Danger zone — owner-only. Hosts two irreversible actions side by side:
//
//   1. Transfer ownership to another existing global user. The current
//      owner loses owner-level access immediately; the new owner gets an
//      auto-minted ConferenceIdentity on their next visit.
//   2. Delete the conference and every related row (identities, submissions,
//      slots, experts, notifications, ...) via the schema's onDelete: Cascade
//      rules.
//
// Both actions require an explicit confirm step — the transfer asks for the
// new owner's email; the delete asks the owner to retype the conference
// name. After either succeeds the parent navigates the user away (`onBack`
// in Conference.tsx) since neither principal still has owner-level access
// to render the Settings tab on the next reload.

function DangerZone({
  slug, confName, busy, onBusy, onDeleted, onTransferred,
}: {
  slug: string;
  confName: string;
  busy: boolean;
  onBusy: (b: boolean) => void;
  onDeleted: () => void;
  onTransferred: () => void;
}) {
  return (
    <SettingsSection
      title="Danger zone"
      description="These actions are irreversible. Transferring drops you from owner to no role on this conference. Deleting removes every participant, session, slot, and booking."
    >
      <TransferOwnershipAction
        slug={slug}
        busy={busy}
        onBusy={onBusy}
        onTransferred={onTransferred}
      />
      <Divider />
      <DeleteAction
        slug={slug}
        confName={confName}
        busy={busy}
        onBusy={onBusy}
        onDeleted={onDeleted}
      />
    </SettingsSection>
  );
}

function TransferOwnershipAction({
  slug, busy, onBusy, onTransferred,
}: {
  slug: string;
  busy: boolean;
  onBusy: (b: boolean) => void;
  onTransferred: () => void;
}) {
  const toast = useToast();
  const [confirming, setConfirming] = useState(false);
  const [email, setEmail] = useState("");

  async function doTransfer() {
    const trimmed = email.trim();
    if (trimmed.length === 0) {
      toast.error("Enter the new owner's email.");
      return;
    }
    onBusy(true);
    try {
      await api.conferences.transferOwnership({ slug, new_owner_email: trimmed });
      onTransferred();
    } catch (e) {
      // Server domain codes carried via ORPCError.message; surface the
      // friendly variant rather than the raw token.
      const code = errorCode(e);
      toast.error(
        code === "user_not_found" ? "No registered account uses that email."
          : code === "same_user" ? "That email is already the owner."
            : code,
      );
      onBusy(false);
    }
  }

  return (
    <div>
      <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 4 }}>Transfer ownership</div>
      <Text muted>
        Hand this conference over to another registered user. You lose
        owner-level access immediately.
      </Text>
      <div style={{ marginTop: 12 }}>
        {!confirming ? (
          <Button
            variant="danger"
            onClick={() => { setConfirming(true); setEmail(""); }}
            disabled={busy}
          >
            Transfer ownership…
          </Button>
        ) : (
          <Stack gap="condensed">
            <Text>
              Enter the email of the user who should become the new owner.
              They must already have an account on this instance.
            </Text>
            <TextInput
              label="New owner email"
              type="email"
              value={email}
              disabled={busy}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="someone@example.com"
            />
            <Stack direction="row" gap="condensed">
              <Button
                variant="danger"
                onClick={doTransfer}
                disabled={busy || email.trim().length === 0}
              >
                Transfer ownership
              </Button>
              <Button
                onClick={() => { setConfirming(false); setEmail(""); }}
                disabled={busy}
              >
                Cancel
              </Button>
            </Stack>
          </Stack>
        )}
      </div>
    </div>
  );
}

function DeleteAction({
  slug, confName, busy, onBusy, onDeleted,
}: {
  slug: string;
  confName: string;
  busy: boolean;
  onBusy: (b: boolean) => void;
  onDeleted: () => void;
}) {
  const toast = useToast();
  const [confirming, setConfirming] = useState(false);
  const [typed, setTyped] = useState("");

  async function doDelete() {
    if (typed.trim() !== confName) {
      toast.error("Type the conference name exactly to confirm.");
      return;
    }
    onBusy(true);
    try {
      await api.conferences.delete({ slug });
      onDeleted();
    } catch (e) {
      toast.error(errorCode(e));
      onBusy(false);
    }
  }

  return (
    <div>
      <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 4 }}>Delete conference</div>
      <Text muted>
        Permanently remove this conference and everything inside it.
      </Text>
      <div style={{ marginTop: 12 }}>
        {!confirming ? (
          <Button
            variant="danger"
            onClick={() => { setConfirming(true); setTyped(""); }}
            disabled={busy}
          >
            Delete conference…
          </Button>
        ) : (
          <Stack gap="condensed">
            <Text>
              Type <strong>{confName}</strong> to confirm. Every participant,
              session, slot, and booking will be removed immediately.
            </Text>
            <TextInput
              label="Conference name"
              value={typed}
              disabled={busy}
              onChange={(e) => setTyped(e.target.value)}
            />
            <Stack direction="row" gap="condensed">
              <Button
                variant="danger"
                onClick={doDelete}
                disabled={busy || typed.trim() !== confName}
              >
                I understand, delete it
              </Button>
              <Button
                onClick={() => { setConfirming(false); setTyped(""); }}
                disabled={busy}
              >
                Cancel
              </Button>
            </Stack>
          </Stack>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Join link — owner-only. A single secret URL anyone can use to self-sign-up
// for this conference. Disabled by default; the owner can enable, set
// optional expiry / max-uses, copy the link, or rotate the token to
// invalidate any previously-shared URL.

interface JoinLink {
  enabled: boolean;
  token: string | null;
  url: string | null;
  expires_at: number | null;
  max_uses: number | null;
  used_count: number;
}

function absoluteUrl(relative: string): string {
  return `${window.location.origin}/#${relative}`;
}

function JoinLinkSection({ slug }: { slug: string }) {
  const toast = useToast();
  const [link, setLink] = useState<JoinLink | null>(null);
  const [busy, setBusy] = useState(false);
  const [maxUsesInput, setMaxUsesInput] = useState<string>("");
  const [expiryInput, setExpiryInput] = useState<string>("");

  useEffect(() => {
    let cancelled = false;
    api.conferences.getJoinLink({ slug })
      .then((l) => {
        if (cancelled) return;
        setLink(l);
        setMaxUsesInput(l.max_uses !== null ? String(l.max_uses) : "");
        setExpiryInput(l.expires_at !== null ? toDatetimeLocal(l.expires_at) : "");
      })
      .catch((e) => { if (!cancelled) toast.error(errorCode(e)); });
    return () => { cancelled = true; };
  }, [slug, toast]);

  async function setEnabled(next: boolean) {
    setBusy(true);
    try {
      const expires_at = expiryInput ? fromDatetimeLocal(expiryInput) : null;
      const max_uses = maxUsesInput ? parsePositiveInt(maxUsesInput) : null;
      const l = await api.conferences.setJoinLink({ slug, enabled: next, expires_at, max_uses });
      setLink(l);
      toast.success(next ? "Join link enabled." : "Join link disabled.");
    } catch (e) { toast.error(errorCode(e)); }
    finally { setBusy(false); }
  }

  async function saveLimits() {
    if (!link) return;
    setBusy(true);
    try {
      const expires_at = expiryInput ? fromDatetimeLocal(expiryInput) : null;
      const max_uses = maxUsesInput ? parsePositiveInt(maxUsesInput) : null;
      const l = await api.conferences.setJoinLink({ slug, enabled: link.enabled, expires_at, max_uses });
      setLink(l);
      toast.success("Limits updated.");
    } catch (e) { toast.error(errorCode(e)); }
    finally { setBusy(false); }
  }

  async function rotate() {
    if (!confirm("Rotate the join link? The current URL stops working immediately.")) return;
    setBusy(true);
    try {
      const l = await api.conferences.rotateJoinLink({ slug });
      setLink(l);
      toast.success("Token rotated. The previous URL no longer works.");
    } catch (e) { toast.error(errorCode(e)); }
    finally { setBusy(false); }
  }

  return (
    <SettingsSection
      title="Join link"
      description="A shared URL anyone can use to sign up for this conference. Each participant supplies their own email and password. Off by default."
    >
      {!link ? (
        <Text muted>Loading…</Text>
      ) : !link.enabled ? (
        <Stack gap="condensed">
          <Stack direction="row" gap="condensed" align="center">
            <StatusDot on={false} />
            <Text muted>Off. People can&apos;t sign themselves up.</Text>
          </Stack>
          <div>
            <Button variant="primary" onClick={() => setEnabled(true)} disabled={busy}>
              Enable join link
            </Button>
          </div>
        </Stack>
      ) : (
        <Stack gap="spacious">
          <Stack direction="row" gap="condensed" align="center">
            <StatusDot on />
            <Text>On. Anyone with the link can sign up.</Text>
          </Stack>

          <FieldGroup label="Join URL">
            <Stack direction="row" gap="condensed" align="center">
              <ReadonlyUrlInput value={absoluteUrl(link.url ?? "")} />
              <CopyButton
                value={absoluteUrl(link.url ?? "")}
                successMessage="Join link copied to clipboard."
                fallbackPromptLabel="Copy this join link:"
              />
            </Stack>
          </FieldGroup>

          <Stack direction="row" gap="condensed" wrap>
            <FieldGroup label="Expires at (optional)">
              <NativeInput
                type="datetime-local"
                value={expiryInput}
                onChange={(e) => setExpiryInput(e.target.value)}
              />
            </FieldGroup>
            <FieldGroup label="Max uses (optional)">
              <NativeInput
                type="number"
                min={1}
                value={maxUsesInput}
                onChange={(e) => setMaxUsesInput(e.target.value)}
                placeholder="unlimited"
              />
            </FieldGroup>
          </Stack>

          <Stack direction="row" gap="condensed" align="center" wrap>
            <Button onClick={saveLimits} disabled={busy}>Save limits</Button>
            <Text muted>
              Used {link.used_count} {link.used_count === 1 ? "time" : "times"}.
            </Text>
          </Stack>

          <Divider />

          <Stack direction="row" gap="condensed" align="center" wrap>
            <Button onClick={() => setEnabled(false)} disabled={busy}>
              Disable join link
            </Button>
            <Button onClick={rotate} disabled={busy}>
              Rotate token
            </Button>
          </Stack>
        </Stack>
      )}
    </SettingsSection>
  );
}

// ---------------------------------------------------------------------------
// Small presentational helpers, scoped to this tab so they don't pollute the
// design system. They mirror the look + token usage of the design system's
// own primitives.

function StatusDot({ on }: { on: boolean }) {
  return (
    <span
      aria-hidden
      style={{
        width: 8, height: 8, borderRadius: "50%",
        background: on
          ? "var(--fgColor-success, var(--bgColor-success-emphasis, #1a7f37))"
          : "var(--fgColor-muted, var(--uncon-fg-muted, #6e7781))",
        boxShadow: on ? "0 0 0 3px var(--bgColor-success-muted, rgba(26,127,55,0.15))" : "none",
        display: "inline-block",
      }}
    />
  );
}

function FieldGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{
      display: "flex", flexDirection: "column", gap: 4,
      fontSize: 13, minWidth: 0, flex: "0 1 auto",
    }}>
      <span style={{
        fontWeight: 600,
        color: "var(--fgColor-muted, var(--uncon-fg-muted, #6e7781))",
        fontSize: 12,
      }}>
        {label}
      </span>
      {children}
    </label>
  );
}

const nativeInputBaseStyle: React.CSSProperties = {
  padding: "6px 10px",
  border: "1px solid var(--borderColor-default, var(--uncon-border, #d0d7de))",
  borderRadius: 6,
  background: "var(--bgColor-default, var(--uncon-bg, #fff))",
  color: "var(--fgColor-default, var(--uncon-fg, inherit))",
  font: "inherit",
  fontSize: 13,
  lineHeight: "20px",
  minHeight: 32,
  boxSizing: "border-box",
};

function NativeInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  const { style, ...rest } = props;
  return <input {...rest} style={{ ...nativeInputBaseStyle, ...style }} />;
}

function ReadonlyUrlInput({ value }: { value: string }) {
  return (
    <input
      readOnly
      value={value}
      onFocus={(e) => e.currentTarget.select()}
      style={{
        ...nativeInputBaseStyle,
        flex: 1,
        minWidth: 0,
        width: "100%",
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        fontSize: 12,
        color: "var(--fgColor-muted, var(--uncon-fg-muted, #6e7781))",
        cursor: "text",
      }}
    />
  );
}

function Divider() {
  return (
    <div
      aria-hidden
      style={{
        height: 1, width: "100%",
        background: "var(--borderColor-muted, var(--uncon-border-muted, #e5e7eb))",
      }}
    />
  );
}

function toDatetimeLocal(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate())
    + "T" + pad(d.getHours()) + ":" + pad(d.getMinutes())
  );
}

function fromDatetimeLocal(s: string): number {
  return new Date(s).getTime();
}

function parsePositiveInt(s: string): number | null {
  const n = Number.parseInt(s, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// ----- usage card ----------------------------------------------------------

// Mod-only "how full is this conference" surface. Reads the snapshot baked
// into `conferences.get` (refreshed on tab focus via the parent). Bars go
// yellow at >=80% (matching the server's quota_threshold notification
// trigger) and red at the cap.
function UsageCard({ usage }: { usage: UsageCounters }) {
  const rows: Array<{ label: string; current: number; limit: number | null }> = [
    { label: "Participants",    current: usage.participants.current,    limit: usage.participants.limit },
    { label: "Pending invites", current: usage.pending_invites.current, limit: usage.pending_invites.limit },
    { label: "Rooms",           current: usage.rooms.current,           limit: usage.rooms.limit },
    { label: "Total sessions",  current: usage.total_sessions.current,  limit: usage.total_sessions.limit },
  ];

  return (
    <SettingsSection
      title="Usage"
      description="How close this conference is to the instance's per-conference caps. Bars highlight at 80% and turn red at the cap; mods get a notification at the same thresholds."
      saved={false}
    >
      <Stack gap="condensed">
        {rows.map((r) => (
          <UsageRow key={r.label} {...r} />
        ))}
      </Stack>
    </SettingsSection>
  );
}

function UsageRow({ label, current, limit }: { label: string; current: number; limit: number | null }) {
  // When limit is null we still show the count (useful situational signal)
  // but skip the bar — there's no scale to draw against.
  const ratio = limit && limit > 0 ? Math.min(1, current / limit) : null;
  const pct = ratio === null ? null : Math.round(ratio * 100);
  const state: "ok" | "warn" | "full" =
    ratio === null
      ? "ok"
      : ratio >= 1
        ? "full"
        : ratio >= 0.8
          ? "warn"
          : "ok";
  const barColor =
    state === "full" ? "var(--fgColor-danger, #cf222e)"
      : state === "warn" ? "var(--fgColor-attention, #9a6700)"
        : "var(--fgColor-accent, #2563eb)";
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
        <Text>{label}</Text>
        <Text muted>
          {limit === null ? `${current} (no cap)` : `${current} / ${limit}${pct !== null ? ` · ${pct}%` : ""}`}
        </Text>
      </div>
      {ratio !== null && (
        <div
          style={{
            marginTop: 4,
            height: 6,
            borderRadius: 3,
            background: "var(--bgColor-muted, rgba(127,127,127,0.18))",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              width: `${ratio * 100}%`,
              height: "100%",
              background: barColor,
              transition: "width 200ms ease",
            }}
          />
        </div>
      )}
    </div>
  );
}
