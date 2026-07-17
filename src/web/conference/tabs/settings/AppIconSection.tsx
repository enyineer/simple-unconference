// Owner-only "App icon" settings card. Uploads / removes the per-conference
// PWA install icon — the picture people see on their home screen when they
// install this conference as an app. Mirrors the avatar upload control in
// ProfileEditor (a plain file input POSTing multipart, plus a Remove button
// hitting the clearIcon RPC). On success it refreshes the parent's conference
// detail AND repoints the live manifest/apple-touch-icon links so the preview
// and an already-open install affordance both reflect the change immediately.

import { useState, type ChangeEvent } from "react";
import { Button, Stack, Text } from "../../../design-system";
import { useToast } from "../../../design-system/hooks";
import { api, errorCode, uploadConferenceIcon } from "../../../api";
import { SettingsSection } from "../../ui/SettingsSection";
import { confIconHref } from "../../../pwa/install";
import { updateInstallLinks } from "../../../pwa/links";

// Preview uses the 192px icon; a hash cache-busts it, else the default bytes.
function previewSrc(slug: string, hash: string | null): string {
  return hash ? confIconHref(slug, 192, hash) : "/icon-192.png";
}

function humanUploadError(code: string): string {
  return ({
    no_file: "Pick an image to upload.",
    forbidden: "Only the owner can change the app icon.",
    unauthorized: "Sign in first.",
    bad_mime: "Unsupported file type. Use JPG, PNG, GIF, or WebP.",
    too_large: "That image is too large. Keep it under 5 MB.",
    bad_image: "That file isn't a readable image.",
    bad_form: "Upload failed. Try a different image.",
  } as Record<string, string>)[code] ?? code;
}

export function AppIconSection({
  slug,
  iconHash,
  onIconHashChange,
}: {
  slug: string;
  iconHash: string | null;
  /** Notifies the parent so the loaded conference detail (and anything derived
   *  from icon_hash) stays in sync after an upload/clear. */
  onIconHashChange: (next: string | null) => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  async function onFileChange(e: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = e.target.files?.[0];
    if (!file) return;
    setBusy(true);
    try {
      const { hash } = await uploadConferenceIcon(slug, file);
      onIconHashChange(hash);
      // Repoint the live home-screen icon link so an install started right now
      // picks up the new icon without a reload.
      updateInstallLinks(slug, hash);
      toast.success("App icon updated.");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "upload_failed";
      toast.error(humanUploadError(msg));
    } finally {
      setBusy(false);
      // Reset so the same file can be re-picked.
      e.target.value = "";
    }
  }

  async function onRemove(): Promise<void> {
    setBusy(true);
    try {
      await api.conferences.clearIcon({ slug });
      onIconHashChange(null);
      updateInstallLinks(slug, null);
      toast.success("App icon removed. Using the default.");
    } catch (err) {
      toast.error(errorCode(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <SettingsSection
      title="App icon"
      description="The icon people see on their home screen when they install this conference as an app. Uploaded images are resized to a square, centered on a dark background. Leave it unset to use the default icon."
    >
      <Stack direction="row" gap="normal" align="center" wrap>
        <img
          src={previewSrc(slug, iconHash)}
          alt=""
          width={72}
          height={72}
          style={{
            width: 72,
            height: 72,
            borderRadius: 14,
            objectFit: "cover",
            flex: "0 0 auto",
            background: "var(--bgColor-muted, var(--uncon-bg-subtle, rgba(0,0,0,0.05)))",
            border: "1px solid var(--borderColor-muted, var(--uncon-border-muted, #e5e7eb))",
          }}
        />
        <Stack gap="condensed">
          <label style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              onChange={onFileChange}
              disabled={busy}
              style={{ fontSize: 13, maxWidth: "100%" }}
            />
          </label>
          {iconHash && (
            <div>
              <Button
                type="button"
                variant="danger"
                size="small"
                onClick={onRemove}
                disabled={busy}
              >
                Remove icon
              </Button>
            </div>
          )}
          <Text muted>PNG, JPG, GIF, or WebP. Up to 5 MB. Square works best.</Text>
        </Stack>
      </Stack>
    </SettingsSection>
  );
}
