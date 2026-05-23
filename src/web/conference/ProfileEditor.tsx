// Profile editor sheet. Edits scalar profile fields (bio / pronouns / title /
// company), the publish toggle, the avatar (upload + remove), the structured
// link/contact entry list, and the tag chip list. Used both for self-edit
// (calls `profiles.updateMine`) and mod-edit-other (calls `profiles.updateAny`).
//
// Form state lives in `useForm(ProfileUpdateSchema, ...)`; the avatar lives
// in a sibling local state because its API is binary (multipart upload + a
// separate delete RPC). The avatar URL the preview uses is built from the
// content hash returned by the upload so cache busts come for free.

import { useState, useEffect, useMemo, type ChangeEvent } from "react";
import {
  Button,
  Form,
  Heading,
  Sheet,
  Stack,
  Text,
  TextInput,
  Textarea,
} from "../design-system";
import { useToast } from "../design-system/hooks";
import { TagInput } from "../design-system/core/tag-input";
import { api, errorCode, errorFields, uploadAvatar } from "../api";
import { useForm } from "../useForm";
import {
  ProfileUpdateSchema,
  type ProfileEntryInput,
  type ProfileUpdateInput,
} from "../../shared/schemas";
import type { ProfileOut } from "../../shared/contract";
import { Tip } from "./ui/Tip";

// Kind suggestions surfaced via a <datalist>. They're hints, not constraints —
// the user can type anything (free-form on the server too).
const LINK_KIND_SUGGESTIONS = [
  "Website",
  "GitHub",
  "LinkedIn",
  "Mastodon",
  "Bluesky",
  "X",
  "Instagram",
] as const;

const CONTACT_KIND_SUGGESTIONS = [
  "Email",
  "Phone",
  "Signal",
  "Telegram",
  "WhatsApp",
  "Matrix",
  "Threema",
  "Discord",
] as const;

// Two datalists so each section only suggests its own category's kinds —
// "GitHub" inside the Contact section would just be noise.
const LINK_DATALIST_ID = "profile-link-kind-suggestions";
const CONTACT_DATALIST_ID = "profile-contact-kind-suggestions";

interface ProfileEditorProps {
  open: boolean;
  onClose: () => void;
  slug: string;
  profile: ProfileOut;
  /** Called after a successful save. Parent should refetch the profile. */
  onSaved: () => void;
}

type EntryDraft = ProfileEntryInput;

function avatarUrl(slug: string, identityId: number, hash: string | null): string {
  if (hash) return `/api/avatars/${encodeURIComponent(slug)}/${identityId}/${hash}`;
  return `/api/avatars/${encodeURIComponent(slug)}/${identityId}`;
}

function makeEntryDraft(category: "link" | "contact", position: number): EntryDraft {
  return {
    kind: "",
    value: "",
    href: null,
    category,
    is_public: true,
    position,
  };
}

function initialValues(profile: ProfileOut): Partial<ProfileUpdateInput> {
  const entries: EntryDraft[] = profile.entries.map((e) => ({
    kind: e.kind,
    value: e.value,
    href: e.href,
    category: e.category,
    is_public: e.is_public,
    position: e.position,
  }));
  return {
    profile_published: profile.profile_published,
    bio: profile.bio,
    pronouns: profile.pronouns,
    title: profile.title,
    company: profile.company,
    entries,
    tags: profile.tags,
  };
}

export function ProfileEditor({
  open,
  onClose,
  slug,
  profile,
  onSaved,
}: ProfileEditorProps) {
  const toast = useToast();
  const form = useForm(ProfileUpdateSchema, initialValues(profile));
  const [busy, setBusy] = useState(false);
  const [avatarHash, setAvatarHash] = useState<string | null>(profile.avatar_hash);
  const [avatarBusy, setAvatarBusy] = useState(false);

  const isSelf = profile.is_me;

  // Coerce optional form fields into stable values for binding. Wrapped in
  // useMemo so the empty-fallback `[]` doesn't change identity across
  // renders and break downstream memo dependencies.
  const formEntries = form.values.entries;
  const formTags = form.values.tags;
  const entries: EntryDraft[] = useMemo(
    () => formEntries ?? [],
    [formEntries],
  );
  const tags: string[] = useMemo(() => formTags ?? [], [formTags]);

  function setEntries(next: EntryDraft[]): void {
    // Recompute position from index so the order on screen is canonical.
    const repositioned = next.map((e, i) => ({ ...e, position: i }));
    form.setValue("entries", repositioned);
  }

  function addEntry(category: "link" | "contact"): void {
    setEntries([...entries, makeEntryDraft(category, entries.length)]);
  }

  function updateEntry(idx: number, patch: Partial<EntryDraft>): void {
    setEntries(entries.map((e, i) => (i === idx ? { ...e, ...patch } : e)));
  }

  function removeEntry(idx: number): void {
    setEntries(entries.filter((_, i) => i !== idx));
  }

  function moveEntry(idx: number, dir: -1 | 1): void {
    const next = [...entries];
    const swap = idx + dir;
    if (swap < 0 || swap >= next.length) return;
    const a = next[idx];
    const b = next[swap];
    if (!a || !b) return;
    next[idx] = b;
    next[swap] = a;
    setEntries(next);
  }

  async function onFileChange(e: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = e.target.files?.[0];
    if (!file) return;
    setAvatarBusy(true);
    try {
      const { hash } = await uploadAvatar(
        slug,
        file,
        isSelf ? undefined : profile.identity_id,
      );
      setAvatarHash(hash);
      toast.success("Avatar updated.");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "upload_failed";
      toast.error(humanUploadError(msg));
    } finally {
      setAvatarBusy(false);
      // Reset the input so the same file can be picked again.
      e.target.value = "";
    }
  }

  async function onRemoveAvatar(): Promise<void> {
    setAvatarBusy(true);
    try {
      await api.profiles.deleteAvatar({
        slug,
        identity_id: isSelf ? undefined : profile.identity_id,
      });
      setAvatarHash(null);
      toast.success("Avatar removed.");
    } catch (err) {
      toast.error(errorCode(err));
    } finally {
      setAvatarBusy(false);
    }
  }

  async function onSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    // Drop entries the user added but never filled in. An empty row would
    // otherwise fail the schema's minLength(1) check and silently abort save.
    const trimmedEntries = entries.filter(
      (entry) => entry.kind.trim() !== "" || entry.value.trim() !== "",
    );
    if (trimmedEntries.length !== entries.length) {
      setEntries(trimmedEntries);
    }
    const parsed = form.validate();
    if (parsed == null) {
      toast.error("Please fix the highlighted fields.");
      return;
    }
    setBusy(true);
    try {
      // The schema produces optional fields; we forward only what the form
      // explicitly touches (everything in `form.values` is sent — `useForm`
      // initial includes the loaded profile values so this is a full edit).
      const payload = parsed as ProfileUpdateInput;
      if (isSelf) {
        await api.profiles.updateMine({ slug, ...payload });
      } else {
        await api.profiles.updateAny({
          slug,
          identity_id: profile.identity_id,
          ...payload,
        });
      }
      toast.success("Profile saved.");
      onSaved();
      onClose();
    } catch (err) {
      const fields = errorFields(err);
      if (fields) form.setErrors(fields);
      else toast.error(errorCode(err));
    } finally {
      setBusy(false);
    }
  }

  const linkEntries = useMemo(
    () =>
      entries
        .map((e, idx) => ({ entry: e, idx }))
        .filter(({ entry }) => entry.category === "link"),
    [entries],
  );
  const contactEntries = useMemo(
    () =>
      entries
        .map((e, idx) => ({ entry: e, idx }))
        .filter(({ entry }) => entry.category === "contact"),
    [entries],
  );

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={isSelf ? "Edit your profile" : `Edit profile`}
    >
      <Tip>
        When the publish toggle is off, only moderators (and you) can see this
        profile.
      </Tip>

      <Form onSubmit={onSubmit}>
        <Stack gap="spacious">
          {/* Publish toggle */}
          <Stack gap="condensed">
            <Heading level={3}>Visibility</Heading>
            <ToggleRow
              checked={!!form.values.profile_published}
              onChange={(v) => form.setValue("profile_published", v)}
              label="Published"
              hint="When off, only moderators see your profile."
            />
          </Stack>

          {/* Basic info */}
          <Stack gap="condensed">
            <Heading level={3}>Basic info</Heading>
            <TextInput
              label="Pronouns"
              placeholder="e.g. they/them"
              value={form.values.pronouns ?? ""}
              onChange={(e) =>
                form.setValue("pronouns", e.target.value || null)
              }
              error={form.fieldError("pronouns")}
            />
            <TextInput
              label="Title"
              placeholder="e.g. Senior Engineer"
              value={form.values.title ?? ""}
              onChange={(e) => form.setValue("title", e.target.value || null)}
              error={form.fieldError("title")}
            />
            <TextInput
              label="Company"
              placeholder="e.g. ACME"
              value={form.values.company ?? ""}
              onChange={(e) =>
                form.setValue("company", e.target.value || null)
              }
              error={form.fieldError("company")}
            />
            <Textarea
              label="Bio"
              placeholder="A short intro. Plain text; line breaks are preserved."
              rows={6}
              value={form.values.bio ?? ""}
              onChange={(e) => form.setValue("bio", e.target.value || null)}
              error={form.fieldError("bio")}
            />
          </Stack>

          {/* Avatar */}
          <Stack gap="condensed">
            <Heading level={3}>Avatar</Heading>
            <Stack direction="row" gap="normal" align="center">
              <img
                src={avatarUrl(slug, profile.identity_id, avatarHash)}
                alt=""
                width={96}
                height={96}
                style={{
                  width: 96,
                  height: 96,
                  borderRadius: 12,
                  objectFit: "cover",
                  background:
                    "var(--bgColor-muted, var(--uncon-bg-subtle, rgba(0,0,0,0.05)))",
                  border:
                    "1px solid var(--borderColor-muted, var(--uncon-border-muted, #e5e7eb))",
                }}
              />
              <Stack gap="condensed">
                <label
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                  }}
                >
                  <input
                    type="file"
                    accept="image/*"
                    onChange={onFileChange}
                    disabled={avatarBusy}
                    style={{ fontSize: 13 }}
                  />
                </label>
                {avatarHash && (
                  <div>
                    <Button
                      type="button"
                      variant="danger"
                      size="small"
                      onClick={onRemoveAvatar}
                      disabled={avatarBusy}
                    >
                      Remove avatar
                    </Button>
                  </div>
                )}
                <Text muted>JPG, PNG, GIF, or WebP. Up to 5 MB.</Text>
              </Stack>
            </Stack>
          </Stack>

          {/* Web & socials */}
          <EntrySection
            heading="Web & socials"
            addLabel="Add web / social"
            kindDatalistId={LINK_DATALIST_ID}
            kindPlaceholder="e.g. GitHub"
            entries={linkEntries}
            errors={form.errors}
            onUpdate={updateEntry}
            onRemove={removeEntry}
            onMove={moveEntry}
            onAdd={() => addEntry("link")}
            disabled={busy}
            valuePlaceholder="e.g. @me or My Site"
            hrefPlaceholder="https://…"
          />

          {/* Contact */}
          <EntrySection
            heading="Contact"
            addLabel="Add contact"
            kindDatalistId={CONTACT_DATALIST_ID}
            kindPlaceholder="e.g. Email"
            entries={contactEntries}
            errors={form.errors}
            onUpdate={updateEntry}
            onRemove={removeEntry}
            onMove={moveEntry}
            onAdd={() => addEntry("contact")}
            disabled={busy}
            valuePlaceholder="e.g. +1 555 1234 or @handle"
            hrefPlaceholder="mailto:… / tel:… / link"
          />

          {/* Tags */}
          <Stack gap="condensed">
            <Heading level={3}>Tags</Heading>
            <Text muted>
              Short keywords others can use to find you in the directory.
            </Text>
            <TagInput
              value={tags}
              onChange={(next) => form.setValue("tags", next)}
              placeholder="Type and press Enter"
              error={form.fieldError("tags")}
            />
          </Stack>

          {/* Per-section datalists. */}
          <datalist id={LINK_DATALIST_ID}>
            {LINK_KIND_SUGGESTIONS.map((k) => (
              <option key={k} value={k} />
            ))}
          </datalist>
          <datalist id={CONTACT_DATALIST_ID}>
            {CONTACT_KIND_SUGGESTIONS.map((k) => (
              <option key={k} value={k} />
            ))}
          </datalist>

          {isSelf && <ChatSettingsBlock slug={slug} />}

          <Stack direction="row" gap="condensed">
            <Button type="submit" variant="primary" disabled={busy || avatarBusy}>
              Save
            </Button>
            <Button type="button" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
          </Stack>
        </Stack>
      </Form>
    </Sheet>
  );
}

interface EntrySectionProps {
  heading: string;
  /** Label for the bottom "+ Add …" button. Plain English instead of a
   *  lowercased heading so we don't end up with "Add web & socials". */
  addLabel: string;
  /** Datalist of kind suggestions for this section's rows. */
  kindDatalistId: string;
  kindPlaceholder: string;
  entries: { entry: EntryDraft; idx: number }[];
  /** Full form error map. EntrySection looks up `entries.<idx>.<field>` keys
   *  and forwards inline errors to each row. */
  errors: Record<string, string>;
  onUpdate: (idx: number, patch: Partial<EntryDraft>) => void;
  onRemove: (idx: number) => void;
  onMove: (idx: number, dir: -1 | 1) => void;
  onAdd: () => void;
  disabled: boolean;
  valuePlaceholder: string;
  hrefPlaceholder: string;
}

function EntrySection({
  heading,
  addLabel,
  kindDatalistId,
  kindPlaceholder,
  entries,
  errors,
  onUpdate,
  onRemove,
  onMove,
  onAdd,
  disabled,
  valuePlaceholder,
  hrefPlaceholder,
}: EntrySectionProps) {
  return (
    <Stack gap="condensed">
      <Heading level={3}>{heading}</Heading>
      {entries.length === 0 && (
        <Text muted>No entries yet.</Text>
      )}
      {entries.map(({ entry, idx }, posInSection) => (
        <EntryRow
          key={idx}
          entry={entry}
          kindDatalistId={kindDatalistId}
          kindPlaceholder={kindPlaceholder}
          kindError={errors[`entries.${idx}.kind`]}
          valueError={errors[`entries.${idx}.value`]}
          hrefError={errors[`entries.${idx}.href`]}
          onUpdate={(patch) => onUpdate(idx, patch)}
          onRemove={() => onRemove(idx)}
          onMoveUp={() => onMove(idx, -1)}
          onMoveDown={() => onMove(idx, +1)}
          canMoveUp={posInSection > 0}
          canMoveDown={posInSection < entries.length - 1}
          valuePlaceholder={valuePlaceholder}
          hrefPlaceholder={hrefPlaceholder}
          disabled={disabled}
        />
      ))}
      <div>
        <Button type="button" size="small" onClick={onAdd} disabled={disabled}>
          + {addLabel}
        </Button>
      </div>
    </Stack>
  );
}

interface EntryRowProps {
  entry: EntryDraft;
  kindDatalistId: string;
  kindPlaceholder: string;
  kindError?: string;
  valueError?: string;
  hrefError?: string;
  onUpdate: (patch: Partial<EntryDraft>) => void;
  onRemove: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  canMoveUp: boolean;
  canMoveDown: boolean;
  valuePlaceholder: string;
  hrefPlaceholder: string;
  disabled: boolean;
}

function EntryRow({
  entry,
  kindDatalistId,
  kindPlaceholder,
  kindError,
  valueError,
  hrefError,
  onUpdate,
  onRemove,
  onMoveUp,
  onMoveDown,
  canMoveUp,
  canMoveDown,
  valuePlaceholder,
  hrefPlaceholder,
  disabled,
}: EntryRowProps) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 8,
        padding: 12,
        borderRadius: 8,
        border:
          "1px solid var(--borderColor-muted, var(--uncon-border-muted, #e5e7eb))",
        background: "var(--bgColor-default, var(--uncon-bg, transparent))",
      }}
    >
      <div>
        <label
          style={{
            fontSize: 12,
            fontWeight: 600,
            display: "block",
            marginBottom: 4,
            color: "var(--fgColor-default, var(--uncon-fg, inherit))",
          }}
        >
          Kind
        </label>
        <input
          type="text"
          list={kindDatalistId}
          value={entry.kind}
          onChange={(e) => onUpdate({ kind: e.target.value })}
          placeholder={kindPlaceholder}
          disabled={disabled}
          style={inputStyle(!!kindError)}
        />
        {kindError && <FieldErrorText>{kindError}</FieldErrorText>}
      </div>
      <TextInput
        label="Value"
        value={entry.value}
        onChange={(e) => onUpdate({ value: e.target.value })}
        placeholder={valuePlaceholder}
        disabled={disabled}
        error={valueError}
      />
      <TextInput
        label="Link (optional)"
        type="url"
        value={entry.href ?? ""}
        onChange={(e) => onUpdate({ href: e.target.value || null })}
        placeholder={hrefPlaceholder}
        disabled={disabled}
        error={hrefError}
      />
      <Stack direction="row" gap="condensed" align="center" justify="between" wrap>
        <ToggleRow
          checked={entry.is_public}
          onChange={(v) => onUpdate({ is_public: v })}
          label="Public"
          hint={entry.is_public ? "Visible to all members." : "Only you & mods see this."}
          compact
        />
        <Stack direction="row" gap="condensed">
          <Button
            type="button"
            size="small"
            onClick={onMoveUp}
            disabled={disabled || !canMoveUp}
          >
            ↑
          </Button>
          <Button
            type="button"
            size="small"
            onClick={onMoveDown}
            disabled={disabled || !canMoveDown}
          >
            ↓
          </Button>
          <Button
            type="button"
            size="small"
            variant="danger"
            onClick={onRemove}
            disabled={disabled}
          >
            Remove
          </Button>
        </Stack>
      </Stack>
    </div>
  );
}

function ToggleRow({
  checked,
  onChange,
  label,
  hint,
  compact,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  hint?: string;
  compact?: boolean;
}) {
  return (
    <label
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 10,
        cursor: "pointer",
        fontSize: compact ? 12 : 13,
        color: "var(--fgColor-default, var(--uncon-fg, inherit))",
      }}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        style={{ marginTop: 3, flexShrink: 0 }}
      />
      <span style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
        <span style={{ fontWeight: 500 }}>{label}</span>
        {hint && (
          <span
            style={{
              color: "var(--fgColor-muted, var(--uncon-fg-muted, #6e7781))",
              fontSize: compact ? 11 : 12,
              lineHeight: "16px",
            }}
          >
            {hint}
          </span>
        )}
      </span>
    </label>
  );
}

function inputStyle(hasError = false): React.CSSProperties {
  return {
    width: "100%",
    padding: "6px 10px",
    borderRadius: 6,
    border: hasError
      ? "1px solid var(--borderColor-danger-emphasis, #cf222e)"
      : "1px solid var(--borderColor-default, var(--uncon-border, #d0d7de))",
    background: "var(--bgColor-default, var(--uncon-bg, transparent))",
    color: "var(--fgColor-default, var(--uncon-fg, inherit))",
    fontFamily: "inherit",
    fontSize: 14,
    outline: "none",
  };
}

function FieldErrorText({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        marginTop: 4,
        fontSize: 12,
        color: "var(--fgColor-danger, #cf222e)",
      }}
    >
      {children}
    </div>
  );
}

function humanUploadError(code: string): string {
  return ({
    no_file: "Pick an image to upload.",
    no_target: "Couldn't determine which identity to upload for.",
    forbidden: "You can't edit this profile.",
    bad_mime: "Unsupported file type. Use JPG, PNG, GIF, or WebP.",
    too_large: "That image is too large. Keep it under 5 MB.",
    unauthorized: "Sign in first.",
  } as Record<string, string>)[code] ?? code;
}

// Self-only chat settings block. Loads from chat.getSettings on mount and
// saves each toggle on change via chat.updateSettings. Lives here (not in
// the profile form) because chat settings aren't part of the ProfileUpdate
// schema and saving is intentionally per-toggle so the user gets instant
// feedback without needing to hit the Save button.
function ChatSettingsBlock({ slug }: { slug: string }) {
  const [loaded, setLoaded] = useState(false);
  const [chatEnabled, setChatEnabled] = useState(true);
  const [readReceiptsEnabled, setReadReceiptsEnabled] = useState(true);
  const [bannedReason, setBannedReason] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api.chat.getSettings({ slug })
      .then((s) => {
        if (cancelled) return;
        setChatEnabled(s.chat_enabled);
        setReadReceiptsEnabled(s.read_receipts_enabled);
        setBannedReason(s.chat_banned ? (s.chat_ban_reason ?? "Reason not provided") : null);
        setLoaded(true);
      })
      .catch(() => { if (!cancelled) setLoaded(true); });
    return () => { cancelled = true; };
  }, [slug]);

  async function persist(patch: { chat_enabled?: boolean; read_receipts_enabled?: boolean }) {
    setSaving(true);
    try {
      const s = await api.chat.updateSettings({ slug, ...patch });
      setChatEnabled(s.chat_enabled);
      setReadReceiptsEnabled(s.read_receipts_enabled);
    } catch {
      // No toast here — the block is non-critical; the next reload reconciles.
    } finally {
      setSaving(false);
    }
  }

  if (!loaded) return null;

  return (
    <Stack gap="condensed">
      <Heading level={3}>Chat</Heading>
      {bannedReason !== null && (
        <Tip>
          You&apos;re currently banned from chatting in this conference.
          {" "}Reason: {bannedReason}
        </Tip>
      )}
      <ToggleRow
        checked={chatEnabled}
        onChange={(v) => { setChatEnabled(v); void persist({ chat_enabled: v }); }}
        label="Allow direct messages"
        hint="Other published members can send you 1-on-1 messages."
      />
      <ToggleRow
        checked={readReceiptsEnabled}
        onChange={(v) => { setReadReceiptsEnabled(v); void persist({ read_receipts_enabled: v }); }}
        label="Send read receipts"
        hint="Senders see when you've read their messages."
      />
      {saving && <div style={{ fontSize: 11, color: "var(--fgColor-muted)" }}>Saving…</div>}
    </Stack>
  );
}

