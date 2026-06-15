import { useEffect, useMemo, useState } from "react";
import {
  PageLayout, Heading, Stack, Button, TextInput, Form, Sheet, Spinner, Text,
} from "../design-system";
import { useToast } from "../design-system/hooks";
import type { ColorMode } from "../design-system/core/contract";
import { AccountMenu } from "../components/AccountMenu";
import { api, errorCode } from "../api";
import { quotaErrorMessage } from "../quotaErrors";
import { detectLocalTimeZone, listTimeZones } from "../../shared/tz";
import { SearchableSelect } from "../conference/ui/SearchableSelect";
import { LinkedConferencesSection } from "./LinkedConferences";

interface Conf {
  id: number; name: string; slug: string; role: string; owner_id: number;
  timezone: string; created_at: number;
}

interface Me {
  id: number; email: string; name: string | null;
}

interface ConferencesPageProps {
  me: Me;
  onLogout: () => void;
  onOpen: (slug: string) => void;
  colorMode: ColorMode;
  onColorModeChange: (next: ColorMode) => void;
}

export function ConferencesPage({
  me, onLogout, onOpen, colorMode, onColorModeChange,
}: ConferencesPageProps) {
  const [confs, setConfs] = useState<Conf[] | null>(null);
  const [creating, setCreating] = useState(false);
  // null limit = no per-account cap on this instance; null overall = still
  // loading config.get. We hide the quota line in both cases.
  const [maxConferences, setMaxConferences] = useState<number | null | undefined>(undefined);
  // Whether the instance has email configured; gates the account-linking UI.
  const [emailEnabled, setEmailEnabled] = useState(false);

  async function refresh() {
    try { setConfs(await api.conferences.list()); }
    catch { setConfs([]); }
  }
  useEffect(() => {
    let cancelled = false;
    api.conferences.list()
      .then((c) => { if (!cancelled) setConfs(c); })
      .catch(() => { if (!cancelled) setConfs([]); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    api.config.get()
      .then((c) => {
        if (cancelled) return;
        setMaxConferences(c.max_conferences_per_user);
        setEmailEnabled(c.email_enabled);
      })
      .catch(() => { if (!cancelled) setMaxConferences(null); });
    return () => { cancelled = true; };
  }, []);

  async function logout() {
    await api.auth.logout();
    onLogout();
  }

  return (
    <PageLayout>
      <Stack gap="spacious">
        {/* Header. Title on the left, identity controls + primary CTA on the
            right. Matches the header layout used inside conference pages. */}
        <div style={{
          display: "flex", justifyContent: "space-between", alignItems: "center",
          flexWrap: "wrap", gap: 16,
        }}>
          <Heading level={1}>Your conferences</Heading>
          <Stack direction="row" gap="condensed" align="center" wrap>
            <Button variant="primary" onClick={() => setCreating(true)}>+ New conference</Button>
            <AccountMenu
              name={me.name}
              email={me.email}
              colorMode={colorMode}
              onColorModeChange={onColorModeChange}
              onSignOut={logout}
            />
          </Stack>
        </div>

        <Sheet open={creating} onClose={() => setCreating(false)} title="New conference">
          <NewConferenceForm
            onCancel={() => setCreating(false)}
            onCreated={async (slug) => {
              setCreating(false);
              await refresh();
              onOpen(slug);
            }}
          />
        </Sheet>

        {confs === null ? (
          <Spinner label="Loading…" />
        ) : confs.length === 0 ? (
          <EmptyState onCreate={() => setCreating(true)} />
        ) : (
          <Stack gap="condensed">
            {confs.map((c) => (
              <ConferenceCard
                key={c.id}
                conference={c}
                onOpen={() => onOpen(c.slug)}
              />
            ))}
          </Stack>
        )}

        {/* Account-linking: conferences already on this account + ones we can
            offer to link (auto-suggest). Only when the instance has email
            configured; renders nothing when there's nothing to show. */}
        {emailEnabled && <LinkedConferencesSection onOpen={onOpen} />}

        {/* Owner quota hint. Only counts conferences the viewer actually owns
            (not ones they were invited into as moderator/participant). Hidden
            when the instance disables the cap (limit=null) or while config
            is still loading. */}
        {confs !== null && maxConferences !== undefined && maxConferences !== null && (
          <OwnerQuotaHint
            current={confs.filter((c) => c.role === "owner").length}
            limit={maxConferences}
          />
        )}
      </Stack>
    </PageLayout>
  );
}

// ---- one row in the conferences list -------------------------------------

function ConferenceCard({
  conference, onOpen,
}: { conference: Conf; onOpen: () => void }) {
  const muted = "var(--fgColor-muted, var(--uncon-fg-muted, #6e7781))";
  // Role-coloured left accent: owner = accent, moderator = attention,
  // participant = neutral. Mirrors the Badge variants used elsewhere.
  const accent =
    conference.role === "owner"
      ? "var(--borderColor-accent-emphasis, #0969da)"
      : conference.role === "moderator"
        ? "var(--borderColor-attention-emphasis, #9a6700)"
        : "var(--borderColor-neutral-emphasis, #6e7781)";
  const roleLabel =
    conference.role === "owner" ? "Owner"
      : conference.role === "moderator" ? "Moderator"
        : "Participant";

  return (
    <button
      type="button"
      onClick={onOpen}
      style={{
        all: "unset",
        display: "grid",
        gridTemplateColumns: "1fr auto",
        gap: "4px 12px",
        padding: 16,
        borderRadius: 10,
        border: "1px solid var(--borderColor-muted, var(--uncon-border-muted, #e5e7eb))",
        borderLeft: `4px solid ${accent}`,
        background: "var(--bgColor-default, var(--uncon-bg, transparent))",
        cursor: "pointer",
        transition: "border-color 120ms, background 120ms",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.borderColor = "var(--borderColor-default, var(--uncon-border, #d0d7de))";
        e.currentTarget.style.borderLeftColor = accent;
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = "var(--borderColor-muted, var(--uncon-border-muted, #e5e7eb))";
        e.currentTarget.style.borderLeftColor = accent;
      }}
      aria-label={`Open ${conference.name}`}
    >
      <div style={{
        gridColumn: 1, gridRow: 1,
        fontSize: 17, fontWeight: 600, lineHeight: "24px",
        color: "var(--fgColor-default, var(--uncon-fg, inherit))",
      }}>
        {conference.name}
      </div>

      <div style={{
        gridColumn: 2, gridRow: 1,
        display: "inline-flex", alignItems: "center",
        padding: "2px 10px", borderRadius: 999,
        background: roleBgFor(conference.role),
        color: roleFgFor(conference.role),
        fontSize: 11, fontWeight: 600,
        textTransform: "uppercase", letterSpacing: 0.4,
        whiteSpace: "nowrap",
      }}>
        {roleLabel}
      </div>

      <div style={{
        gridColumn: "1 / -1", gridRow: 2,
        display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center",
        color: muted, fontSize: 12,
      }}>
        <span style={{
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        }}>
          {conference.slug}
        </span>
        <span aria-hidden style={{ opacity: 0.5 }}>·</span>
        <span>{conference.timezone}</span>
      </div>
    </button>
  );
}

function roleBgFor(role: string): string {
  if (role === "owner") return "var(--bgColor-accent-muted, rgba(64,132,246,0.12))";
  if (role === "moderator") return "var(--bgColor-attention-muted, rgba(187,128,9,0.12))";
  return "var(--bgColor-muted, var(--uncon-bg-subtle, rgba(0,0,0,0.05)))";
}
function roleFgFor(role: string): string {
  if (role === "owner") return "var(--fgColor-accent, #2563eb)";
  if (role === "moderator") return "var(--fgColor-attention, #9a6700)";
  return "var(--fgColor-muted, var(--uncon-fg-muted, #6e7781))";
}

// ---- empty state ---------------------------------------------------------

function EmptyState({ onCreate }: { onCreate: () => void }) {
  const muted = "var(--fgColor-muted, var(--uncon-fg-muted, #6e7781))";
  return (
    <div style={{
      padding: "48px 24px",
      borderRadius: 10,
      border: "1px dashed var(--borderColor-muted, var(--uncon-border-muted, #d0d7de))",
      textAlign: "center",
      display: "flex", flexDirection: "column", alignItems: "center", gap: 12,
    }}>
      <div style={{
        fontSize: 16, fontWeight: 600,
        color: "var(--fgColor-default, var(--uncon-fg, inherit))",
      }}>
        You&apos;re not in any conferences yet
      </div>
      <div style={{ color: muted, maxWidth: 460, fontSize: 13, lineHeight: "20px" }}>
        Create one to start running an unconference, or wait for an organizer to add you.
      </div>
      <div style={{ marginTop: 4 }}>
        <Button variant="primary" onClick={onCreate}>+ New conference</Button>
      </div>
    </div>
  );
}

// ---- create sheet body ---------------------------------------------------

function NewConferenceForm({
  onCancel, onCreated,
}: {
  onCancel: () => void;
  onCreated: (slug: string) => Promise<void>;
}) {
  const toast = useToast();
  const [name, setName] = useState("");
  const [timezone, setTimezone] = useState<string>(() => detectLocalTimeZone());
  const [busy, setBusy] = useState(false);

  const tzOptions = useMemo(
    () => listTimeZones().map((tz) => ({ value: tz, label: tz })),
    [],
  );

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const conf = await api.conferences.create({ name, timezone });
      await onCreated(conf.slug);
    } catch (e) {
      toast.error(quotaErrorMessage(e) ?? errorCode(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Stack gap="condensed">
      <Form onSubmit={submit}>
        <TextInput
          label="Name"
          required
          placeholder="e.g. Bun Summer Camp"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <SearchableSelect
          label="Timezone"
          value={timezone}
          onChange={setTimezone}
          options={tzOptions}
          placeholder="Search timezones…"
        />
        <Stack direction="row" gap="condensed">
          <Button type="submit" variant="primary" disabled={busy || !name.trim()}>
            Create conference
          </Button>
          <Button onClick={onCancel} disabled={busy}>Cancel</Button>
        </Stack>
      </Form>
    </Stack>
  );
}

// Quota hint shown beneath the conference list. Stays subtle when there's
// headroom; goes warning-coloured at 80% and critical at the cap, mirroring
// the SettingsTab usage bars so the visual language is consistent.
function OwnerQuotaHint({ current, limit }: { current: number; limit: number }) {
  const ratio = current / limit;
  const state: "ok" | "warn" | "full" =
    ratio >= 1 ? "full" : ratio >= 0.8 ? "warn" : "ok";
  const color =
    state === "full" ? "var(--fgColor-danger, #cf222e)"
      : state === "warn" ? "var(--fgColor-attention, #9a6700)"
        : "var(--fgColor-muted, #6e7781)";
  const message =
    state === "full"
      ? `You've reached this instance's cap of ${limit} owned conference${limit === 1 ? "" : "s"}. Delete or transfer one before creating another.`
      : `${current} of ${limit} owned conference${limit === 1 ? "" : "s"} used on this instance.`;
  return (
    <Text>
      <span style={{ color, fontSize: 13 }}>{message}</span>
    </Text>
  );
}
