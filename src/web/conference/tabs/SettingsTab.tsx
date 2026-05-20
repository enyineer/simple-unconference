import { useEffect, useMemo, useState } from "react";
import {
  Banner, Button, Heading, Select, Stack, Text, TextInput,
} from "../../design-system";
import type { ChangeEvent, FocusEvent } from "react";
import { plugins as designPlugins } from "../../design-system/core/registry";
import { listTimeZones } from "../../../shared/tz";
import { api, errorCode } from "../../api";
import { SettingsSection } from "../ui/SettingsSection";

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

export function SettingsTab({
  slug, currentName, currentDs, currentTz, currentMixerAvoidRepeats,
  currentSubmissionMaxPlacements, currentParticipantSubmissionsEnabled,
  onNameChange, onDsChange, onTzChange, onMixerAvoidRepeatsChange,
  onSubmissionMaxPlacementsChange, onParticipantSubmissionsEnabledChange,
  onDeleted,
}: {
  slug: string;
  currentName: string;
  currentDs: string;
  currentTz: string;
  currentMixerAvoidRepeats: boolean;
  currentSubmissionMaxPlacements: number | null;
  currentParticipantSubmissionsEnabled: boolean;
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
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
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
  // optimistic save round-trip or a name update from elsewhere).
  const [nameDraft, setNameDraft] = useState(currentName);
  useEffect(() => { setNameDraft(currentName); }, [currentName]);

  async function updateName(next: string) {
    const trimmed = next.trim();
    if (trimmed.length === 0) {
      setNameDraft(currentName);
      setMessage("Conference name cannot be empty.");
      return;
    }
    if (trimmed === currentName) return;
    setBusy(true);
    setMessage(null);
    try {
      await api.conferences.update({ slug, name: trimmed });
      onNameChange(trimmed);
      flashSaved("name");
    } catch (e) {
      setMessage(errorCode(e));
    } finally {
      setBusy(false);
    }
  }

  async function updateDs(id: string) {
    if (id === currentDs) return;
    setBusy(true);
    setMessage(null);
    try {
      await api.conferences.update({ slug, design_system: id });
      onDsChange(id);
      flashSaved("design");
    } catch (e) {
      setMessage(errorCode(e));
    } finally {
      setBusy(false);
    }
  }

  async function updateTz(next: string) {
    if (next === currentTz) return;
    setBusy(true);
    setMessage(null);
    try {
      await api.conferences.update({ slug, timezone: next });
      onTzChange(next);
      flashSaved("timezone");
    } catch (e) {
      setMessage(errorCode(e));
    } finally {
      setBusy(false);
    }
  }

  async function updateParticipantSubmissions(next: boolean) {
    if (next === currentParticipantSubmissionsEnabled) return;
    setBusy(true);
    setMessage(null);
    try {
      await api.conferences.update({ slug, participant_submissions_enabled: next });
      onParticipantSubmissionsEnabledChange(next);
      flashSaved("participant_submissions");
    } catch (e) {
      setMessage(errorCode(e));
    } finally {
      setBusy(false);
    }
  }

  async function updateMixerAvoidRepeats(next: boolean) {
    if (next === currentMixerAvoidRepeats) return;
    setBusy(true);
    setMessage(null);
    try {
      await api.conferences.update({ slug, mixer_avoid_repeats_default: next });
      onMixerAvoidRepeatsChange(next);
      flashSaved("mixer");
    } catch (e) {
      setMessage(errorCode(e));
    } finally {
      setBusy(false);
    }
  }

  async function saveCap(next: number | null) {
    if (next === currentSubmissionMaxPlacements) return;
    setBusy(true);
    setMessage(null);
    try {
      await api.conferences.update({ slug, submission_max_placements_default: next });
      onSubmissionMaxPlacementsChange(next);
      flashSaved("session_reuse");
    } catch (e) {
      setMessage(errorCode(e));
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
      setMessage("Limit must be a positive whole number.");
      return;
    }
    saveCap(parsed);
  }

  return (
    <Stack gap="spacious">
      <Heading level={2}>Settings</Heading>

      {/* Only error messages get a banner — successful saves use the
          per-section checkmark animation, no big notice needed. */}
      {message && (
        <Banner variant="critical">{message}</Banner>
      )}

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
        <Select
          label="Conference timezone"
          value={currentTz}
          disabled={busy}
          onChange={(e) => updateTz(e.target.value)}
          options={tzOptions}
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
          + "Counts both static tracks and unconference placements. The default "
          + "is \"assign once\" — once a session has run, it drops out of the "
          + "unconference assignment pool and stops showing on the participant "
          + "Sessions overview. Mods can override per session, or use the manual "
          + "\"mark finished\" toggle."
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
        onError={setMessage}
        onDeleted={onDeleted}
      />
    </Stack>
  );
}

// ---------------------------------------------------------------------------
// Danger zone — owner-only. Deletes the conference and every related row
// (identities, submissions, slots, experts, notifications, ...) via the
// schema's onDelete: Cascade rules. The owner is asked to type the
// conference name as a guard against accidental clicks.

function DangerZone({
  slug, confName, busy, onBusy, onError, onDeleted,
}: {
  slug: string;
  confName: string;
  busy: boolean;
  onBusy: (b: boolean) => void;
  onError: (msg: string | null) => void;
  onDeleted: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [typed, setTyped] = useState("");

  async function doDelete() {
    if (typed.trim() !== confName) {
      onError("Type the conference name exactly to confirm.");
      return;
    }
    onBusy(true);
    onError(null);
    try {
      await api.conferences.delete({ slug });
      onDeleted();
    } catch (e) {
      onError(errorCode(e));
      onBusy(false);
    }
  }

  return (
    <SettingsSection
      title="Danger zone"
      description="Permanently delete this conference and everything inside it: participants, sessions, agenda slots, expert bookings, and notifications. This cannot be undone."
    >
      {!confirming ? (
        <div>
          <Button
            variant="danger"
            onClick={() => { onError(null); setConfirming(true); setTyped(""); }}
            disabled={busy}
          >
            Delete conference
          </Button>
        </div>
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
            <Button onClick={() => { setConfirming(false); setTyped(""); onError(null); }} disabled={busy}>
              Cancel
            </Button>
          </Stack>
        </Stack>
      )}
    </SettingsSection>
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
  const [link, setLink] = useState<JoinLink | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [maxUsesInput, setMaxUsesInput] = useState<string>("");
  const [expiryInput, setExpiryInput] = useState<string>("");

  async function refresh() {
    try {
      const l = await api.conferences.getJoinLink({ slug });
      setLink(l);
      setMaxUsesInput(l.max_uses !== null ? String(l.max_uses) : "");
      setExpiryInput(l.expires_at !== null ? toDatetimeLocal(l.expires_at) : "");
    } catch (e) {
      setError(errorCode(e));
    }
  }
  useEffect(() => { refresh(); }, [slug]);

  async function setEnabled(next: boolean) {
    setBusy(true); setError(null); setInfo(null);
    try {
      const expires_at = expiryInput ? fromDatetimeLocal(expiryInput) : null;
      const max_uses = maxUsesInput ? parsePositiveInt(maxUsesInput) : null;
      const l = await api.conferences.setJoinLink({ slug, enabled: next, expires_at, max_uses });
      setLink(l);
      setInfo(next ? "Join link enabled." : "Join link disabled.");
    } catch (e) { setError(errorCode(e)); }
    finally { setBusy(false); }
  }

  async function saveLimits() {
    if (!link) return;
    setBusy(true); setError(null); setInfo(null);
    try {
      const expires_at = expiryInput ? fromDatetimeLocal(expiryInput) : null;
      const max_uses = maxUsesInput ? parsePositiveInt(maxUsesInput) : null;
      const l = await api.conferences.setJoinLink({ slug, enabled: link.enabled, expires_at, max_uses });
      setLink(l);
      setInfo("Limits updated.");
    } catch (e) { setError(errorCode(e)); }
    finally { setBusy(false); }
  }

  async function rotate() {
    if (!confirm("Rotate the join link? The current URL stops working immediately.")) return;
    setBusy(true); setError(null); setInfo(null);
    try {
      const l = await api.conferences.rotateJoinLink({ slug });
      setLink(l);
      setInfo("Token rotated. The previous URL no longer works.");
    } catch (e) { setError(errorCode(e)); }
    finally { setBusy(false); }
  }

  async function copyLink() {
    if (!link?.url) return;
    const full = absoluteUrl(link.url);
    try { await navigator.clipboard.writeText(full); }
    catch { window.prompt("Copy this join link:", full); }
  }

  return (
    <SettingsSection
      title="Join link"
      description="A shared URL anyone can use to sign up for this conference. Each participant supplies their own email and password. Off by default."
    >
      {error && <Banner variant="critical">{error}</Banner>}
      {info && <Banner variant="success">{info}</Banner>}

      {!link ? (
        <Text muted>Loading…</Text>
      ) : !link.enabled ? (
        <Stack gap="condensed">
          <Stack direction="row" gap="condensed" align="center">
            <StatusDot on={false} />
            <Text muted>Off. People can't sign themselves up.</Text>
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
              <Button onClick={copyLink}>Copy</Button>
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
