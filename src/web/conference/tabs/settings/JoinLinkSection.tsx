import { useEffect, useState } from "react";
import { Button, Stack, Text } from "../../../design-system";
import { useToast } from "../../../design-system/hooks";
import { api, errorCode } from "../../../api";
import { CopyButton } from "../../ui/CopyButton";
import { SettingsSection } from "../../ui/SettingsSection";
import { Divider, FieldGroup, NativeInput, ReadonlyUrlInput, StatusDot } from "./Primitives";
import { absoluteUrl, fromDatetimeLocal, parsePositiveInt, toDatetimeLocal } from "./helpers";
import type { JoinLink } from "./types";

// ---------------------------------------------------------------------------
// Join link — owner-only. A single secret URL anyone can use to self-sign-up
// for this conference. Disabled by default; the owner can enable, set
// optional expiry / max-uses, copy the link, or rotate the token to
// invalidate any previously-shared URL.

export function JoinLinkSection({ slug }: { slug: string }) {
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
