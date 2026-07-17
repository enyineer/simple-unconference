import { useEffect, useState } from "react";
import { Button, Stack, Text } from "../../../design-system";
import { useToast } from "../../../design-system/hooks";
import { api, errorCode } from "../../../api";
import type { BoardLinkOut } from "../../../../shared/contract/types";
import { CopyButton } from "../../ui/CopyButton";
import { SettingsSection } from "../../ui/SettingsSection";
import { Divider, FieldGroup, ReadonlyUrlInput, StatusDot } from "./Primitives";
import { absoluteUrl } from "./helpers";

// ---------------------------------------------------------------------------
// Live Board link — owner-only. A single secret URL that opens the full-screen,
// read-only projector board. Mirrors JoinLinkSection's shape (a deliberate
// sibling, not an abstraction) but with no expiry / usage limits — the board is
// a display surface, not a signup path.

export function BoardLinkSection({ slug }: { slug: string }) {
  const toast = useToast();
  const [link, setLink] = useState<BoardLinkOut | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api.conferences.getBoardLink({ slug })
      .then((l) => { if (!cancelled) setLink(l); })
      .catch((e) => { if (!cancelled) toast.error(errorCode(e)); });
    return () => { cancelled = true; };
  }, [slug, toast]);

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

  return (
    <SettingsSection
      title="Live Board"
      description="A full-screen, read-only schedule board for a projector or hallway screen. Anyone with the link can view it - no sign-in."
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
