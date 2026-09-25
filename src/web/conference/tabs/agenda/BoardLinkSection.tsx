import { useEffect, useMemo, useRef, useState } from "react";
import { Button, Select, Stack, Text } from "../../../design-system";
import { useToast } from "../../../design-system/hooks";
import { api, errorCode } from "../../../api";
import type { BoardLinkOut } from "../../../../shared/contract/types";
import { instantToWallClock, formatInTz } from "../../../../shared/tz";
import { CopyButton } from "../../ui/CopyButton";
import { SettingsSection } from "../../ui/SettingsSection";
import { Divider, FieldGroup, ReadonlyUrlInput, StatusDot } from "../settings/Primitives";
import { absoluteUrl } from "../settings/helpers";

// ---------------------------------------------------------------------------
// Live Board link — moderator+ (owners pass too). A single secret URL that
// opens the full-screen, read-only projector board, plus the shown-days
// filter. Rendered inside the Pitch Mode sheet (the day-of control surface);
// link shape mirrors JoinLinkSection (a deliberate sibling, not an
// abstraction) but with no expiry / usage limits — the board is a display
// surface, not a signup path. Every change writes through `setBoardLink`,
// which fans out `agenda.changed` so open walls refetch and apply it live.

const CHECKBOX_LABEL: React.CSSProperties = {
  display: "flex", alignItems: "flex-start", gap: 8, fontSize: 13, minWidth: 0,
};
const MUTED_CSS = "var(--fgColor-muted, var(--uncon-fg-muted, #6e7781))";

export function BoardLinkSection({
  slug,
  slotStarts,
  timeZone,
}: {
  slug: string;
  /** Start instants (ms) of the conference's agenda slots — the candidate
   *  days. Days without slots never render on the board, so they're not
   *  offered. */
  slotStarts: number[];
  timeZone: string;
}) {
  const toast = useToast();
  const [link, setLink] = useState<BoardLinkOut | null>(null);
  const [busy, setBusy] = useState(false);
  // Brief checkmark next to the title after a day-filter save (mirrors the
  // settings tab's auto-save feedback).
  const [saved, setSaved] = useState(false);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.conferences.getBoardLink({ slug })
      .then((l) => { if (!cancelled) setLink(l); })
      .catch((e) => { if (!cancelled) toast.error(errorCode(e)); });
    return () => { cancelled = true; };
  }, [slug, toast]);

  useEffect(() => () => {
    if (savedTimer.current) clearTimeout(savedTimer.current);
  }, []);

  function flashSaved() {
    setSaved(true);
    if (savedTimer.current) clearTimeout(savedTimer.current);
    savedTimer.current = setTimeout(() => setSaved(false), 1500);
  }

  // Distinct slot days (YYYY-MM-DD in the conference timezone), labeled for
  // the checkboxes. Sorted ascending so the picker reads chronologically.
  const dayOptions = useMemo(() => {
    const map = new Map<string, string>();
    for (const ts of slotStarts) {
      const key = instantToWallClock(ts, timeZone).slice(0, 10);
      if (!map.has(key)) {
        map.set(key, formatInTz(ts, timeZone, { weekday: "short", day: "numeric", month: "short" }));
      }
    }
    return [...map.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, label]) => ({ key, label }));
  }, [slotStarts, timeZone]);

  async function setEnabled(next: boolean) {
    setBusy(true);
    try {
      const l = await api.conferences.setBoardLink({ slug, enabled: next });
      setLink(l);
      toast.success(next ? "Live Board enabled." : "Live Board disabled.");
    } catch (e) { toast.error(errorCode(e)); }
    finally { setBusy(false); }
  }

  async function rotate() {
    if (!confirm("Rotate the board link? The current URL stops working immediately.")) return;
    setBusy(true);
    try {
      const l = await api.conferences.rotateBoardLink({ slug });
      setLink(l);
      toast.success("Token rotated. The previous URL no longer works.");
    } catch (e) { toast.error(errorCode(e)); }
    finally { setBusy(false); }
  }

  // Auto-save the day filter. `null` = all days. Open walls pick the change
  // up live via the agenda.changed fan-out.
  async function saveDays(next: string[] | null) {
    if (!link) return;
    setBusy(true);
    try {
      const l = await api.conferences.setBoardLink({ slug, enabled: link.enabled, days: next });
      setLink(l);
      flashSaved();
    } catch (e) { toast.error(errorCode(e)); }
    finally { setBusy(false); }
  }

  async function saveSkipEmpty(next: boolean) {
    if (!link) return;
    setBusy(true);
    try {
      const l = await api.conferences.setBoardLink({ slug, enabled: link.enabled, skip_empty: next });
      setLink(l);
      flashSaved();
    } catch (e) { toast.error(errorCode(e)); }
    finally { setBusy(false); }
  }

  function toggleDay(key: string) {
    if (!link) return;
    const current = link.days ?? [];
    if (current.includes(key)) {
      // Never save an empty selection (the server rejects it too) — keep the
      // wall showing something; the mod can switch back to "All days".
      if (current.length === 1) return;
      void saveDays(current.filter((k) => k !== key));
    } else {
      void saveDays([...current, key].sort());
    }
  }

  const selectedDays = link?.days ?? null;
  const mode = selectedDays === null ? "all" : "selected";
  // Stored selections whose slots were deleted since — still saved on the
  // server, so list them (key as label) instead of silently dropping them.
  const extraStored = (selectedDays ?? [])
    .filter((k) => !dayOptions.some((o) => o.key === k))
    .map((key) => ({ key, label: key }));
  const checkboxes = [...dayOptions, ...extraStored];

  return (
    <SettingsSection
      title="Live Board"
      description="A full-screen, read-only schedule board for a projector or hallway screen. Anyone with the link can view it - no sign-in."
      stacked
      saved={saved}
    >
      {!link ? (
        <Text muted>Loading…</Text>
      ) : !link.enabled ? (
        <Stack gap="condensed">
          <Stack direction="row" gap="condensed" align="center">
            <StatusDot on={false} />
            <Text muted>Off. The board link doesn&apos;t work.</Text>
          </Stack>
          <div>
            <Button variant="primary" onClick={() => setEnabled(true)} disabled={busy}>
              Enable Live Board
            </Button>
          </div>
        </Stack>
      ) : (
        <Stack gap="spacious">
          <Stack direction="row" gap="condensed" align="center">
            <StatusDot on />
            <Text>On. Anyone with the link can view the board.</Text>
          </Stack>

          <FieldGroup label="Board URL">
            <Stack direction="row" gap="condensed" align="center">
              <ReadonlyUrlInput value={absoluteUrl(link.url ?? "")} />
              <CopyButton
                value={absoluteUrl(link.url ?? "")}
                successMessage="Board link copied to clipboard."
                fallbackPromptLabel="Copy this board link:"
              />
            </Stack>
          </FieldGroup>

          {checkboxes.length > 1 && (
            <FieldGroup label="Days shown">
              <Stack gap="condensed">
                <Select
                  label="Which days"
                  value={mode}
                  disabled={busy}
                  onChange={(e) => {
                    if (e.target.value === mode) return;
                    saveDays(e.target.value === "all"
                      ? null
                      : (selectedDays ?? checkboxes.map((o) => o.key)));
                  }}
                  options={[
                    { value: "all", label: "All days" },
                    { value: "selected", label: "Selected days" },
                  ]}
                />
                {mode === "selected" && (
                  <Stack gap="condensed">
                    {checkboxes.map((o) => {
                      const checked = selectedDays?.includes(o.key) ?? false;
                      return (
                        <label key={o.key} style={CHECKBOX_LABEL}>
                          <input
                            type="checkbox"
                            checked={checked}
                            // The last checked day can't be unchecked (that
                            // would save an empty selection).
                            disabled={busy || (checked && selectedDays?.length === 1)}
                            onChange={() => toggleDay(o.key)}
                          />
                          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {o.label}
                          </span>
                        </label>
                      );
                    })}
                  </Stack>
                )}
              </Stack>
            </FieldGroup>
          )}

          <FieldGroup label="Density">
            <label style={CHECKBOX_LABEL}>
              <input
                type="checkbox"
                checked={link.skip_empty}
                disabled={busy}
                onChange={(e) => saveSkipEmpty(e.target.checked)}
              />
              <span>
                Skip empty rooms and time slots
                <span style={{ display: "block", color: MUTED_CSS, fontSize: 12 }}>
                  Pages drop room columns and time rows with nothing placed in
                  them, so the wall stays readable on sparse schedules.
                </span>
              </span>
            </label>
          </FieldGroup>

          <Divider />

          <Stack direction="row" gap="condensed" align="center" wrap>
            <Button onClick={() => setEnabled(false)} disabled={busy}>
              Disable Live Board
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
