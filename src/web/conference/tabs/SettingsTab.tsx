import { useEffect, useState } from "react";
import {
  Heading, Select, Stack, TextInput,
} from "../../design-system";
import { useToast } from "../../design-system/hooks";
import type { ChangeEvent, FocusEvent } from "react";
import { plugins as designPlugins } from "../../design-system/core/registry";
import { api, errorCode } from "../../api";
import { SettingsSection } from "../ui/SettingsSection";
import { SearchableSelect } from "../ui/SearchableSelect";
import { DangerZone } from "./settings/DangerZone";
import { JoinLinkSection } from "./settings/JoinLinkSection";
import { UsageCard } from "./settings/UsageCard";
import { useMemoTimezones } from "./settings/helpers";
import type { SavedKey, UsageCounters } from "./settings/types";

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
