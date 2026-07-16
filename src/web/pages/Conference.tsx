// Conference page shell. Owns the sticky header (breadcrumb + title + tabs +
// avatar menu) and routes between tabs. The header collapses on scroll to a
// thin strip with just breadcrumb + tabs + avatar so navigation stays in
// reach on long pages.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Banner, Button, Heading, PageLayout, Spinner,
} from "../design-system";
import type { ColorMode } from "../design-system/core/contract";
import { api, ApiError, errorCode } from "../api";
import { useRoute } from "../router";

import type { ConferenceDetail, Role, Tab } from "../conference/types";
import { isTab } from "../conference/types";
import { TabBar } from "../conference/ui/TabBar";
import { AccountMenu } from "../components/AccountMenu";
import { NotificationBell } from "../components/NotificationBell";
import { BroadcastButton } from "../components/BroadcastButton";
import { AgendaTab } from "../conference/tabs/AgendaTab";
import { DirectoryTab } from "../conference/tabs/DirectoryTab";
import { ExpertsTab } from "../conference/tabs/ExpertsTab";
import { MyAssignmentsTab } from "../conference/tabs/MyAssignmentsTab";
import { PeopleTab } from "../conference/tabs/PeopleTab";
import { RoomsTab } from "../conference/tabs/RoomsTab";
import { SessionsTab } from "../conference/tabs/SessionsTab";
import { SettingsTab } from "../conference/tabs/SettingsTab";
import { ChatTab } from "../conference/tabs/ChatTab";
import type { ConfMe } from "../App";

interface ConferencePageProps {
  slug: string;
  /** Per-conference identity payload from `conferences.me({ slug })`. */
  confMe: ConfMe;
  onBack: () => void;
  /** Called when the owner changes the conference's design system, so the
   * App can swap the active plugin without a full reload. */
  onDesignSystemChange?: (pluginId: string) => void;
  /** Current identity's color-mode preference + setter (persisted per
   *  conference identity). */
  colorMode: ColorMode;
  onColorModeChange: (next: ColorMode) => void;
  /** Called after a successful per-conference sign-out so App.tsx can
   *  bounce to the per-conference login page. */
  onLoggedOut: () => void;
  /** Ask the App to refetch `conferences.me`. The Me tab uses this after a
   *  profile save/dismiss so the first-login nudge state stays accurate. */
  onConfMeRefresh: () => void;
  /** Tab segment from the URL (e.g. `/conferences/<slug>/chat` → "chat").
   *  Drives which inner panel renders. Switching tabs navigates the URL
   *  rather than mutating local state, so back/forward and deep links
   *  always agree with the rendered tab. */
  routeTab?: Tab;
}

export function ConferencePage({
  slug, confMe, onBack, onDesignSystemChange,
  colorMode, onColorModeChange, onLoggedOut, onConfMeRefresh,
  routeTab,
}: ConferencePageProps) {
  const [fetchedConf, setFetchedConf] = useState<ConferenceDetail | null>(null);
  const [fetchedError, setFetchedError] = useState<string | null>(null);

  // Tab is driven by the URL — App.tsx parses it from /:tab segment and
  // hands it down. Default to "sessions" for the bare /conferences/<slug>
  // URL. Unknown values (typos in the URL) fall back to the default rather
  // than rendering nothing.
  const tab: Tab = isTab(routeTab) ? routeTab : "sessions";
  const { navigate } = useRoute();
  const setTab = useCallback((next: Tab) => {
    if (next === "sessions") {
      navigate(`/conferences/${encodeURIComponent(slug)}`);
    } else {
      navigate(`/conferences/${encodeURIComponent(slug)}/${next}`);
    }
  }, [navigate, slug]);

  // Track which slug `fetchedConf` / `fetchedError` were last set for.
  // Deriving `conf` / `error` from this lets us reset on slug change without
  // a synchronous setState in the effect.
  const [loadedSlug, setLoadedSlug] = useState<string | null>(null);
  // Instance-wide per-user submission cap, surfaced via the public config
  // endpoint so SessionsTab can render an "X / N" hint. null = cap disabled
  // on this instance; undefined = still loading.
  const [maxSessionsPerUser, setMaxSessionsPerUser] = useState<number | null | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    api.conferences.get({ slug })
      .then((c) => {
        if (cancelled) return;
        setFetchedConf(c);
        setFetchedError(null);
        setLoadedSlug(slug);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setFetchedError(e instanceof ApiError ? errorCode(e) : "error");
        setLoadedSlug(slug);
      });
    return () => { cancelled = true; };
  }, [slug]);

  // Hide stale data + error while a new slug is in flight.
  const conf = loadedSlug === slug ? fetchedConf : null;
  const error = loadedSlug === slug ? fetchedError : null;

  useEffect(() => {
    let cancelled = false;
    api.config.get()
      .then((c) => { if (!cancelled) setMaxSessionsPerUser(c.max_sessions_per_user_per_conference); })
      .catch(() => { if (!cancelled) setMaxSessionsPerUser(null); });
    return () => { cancelled = true; };
  }, []);

  async function handleSignOut() {
    await api.conferences.logout({ slug });
    onLoggedOut();
  }

  if (error) {
    return (
      <PageLayout>
        <Banner variant="critical">Could not load conference: {error}</Banner>
        <Button onClick={onBack}>Back</Button>
      </PageLayout>
    );
  }
  if (!conf) return <PageLayout><Spinner label="Loading…" /></PageLayout>;

  const isMod = conf.my_role === "owner" || conf.my_role === "moderator";
  const isOwner = conf.my_role === "owner";

  // People + Rooms management are mod-only — they expose member emails and
  // the room roster, which we don't surface to attendees. Directory is the
  // members-visible counterpart to People: profiles, no admin actions, no
  // emails. Order keeps user-facing tabs first, admin extras after.
  const tabs: Tab[] = ["sessions", "agenda", "experts", "directory", "chat", "me"];
  if (isMod) tabs.push("people", "rooms");
  if (isOwner) tabs.push("settings");

  return (
    <PageLayout>
      <ConferenceHeader
        conf={conf}
        tabs={tabs}
        activeTab={tab}
        onTabChange={setTab}
        onBack={onBack}
        me={confMe}
        colorMode={colorMode}
        onColorModeChange={onColorModeChange}
        onSignOut={handleSignOut}
        slug={slug}
      />

      <div style={{ marginTop: 20 }}>
        {tab === "people"   && <PeopleTab slug={slug} role={conf.my_role} />}
        {tab === "rooms"    && <RoomsTab slug={slug} isMod={isMod} timeZone={conf.timezone} />}
        {tab === "sessions" && (
          <SessionsTab
            slug={slug}
            role={conf.my_role}
            timeZone={conf.timezone}
            submissionMaxPlacementsDefault={conf.submission_max_placements_default}
            participantSubmissionsEnabled={conf.participant_submissions_enabled}
            mySessionCount={conf.my_session_count}
            maxSessionsPerUser={maxSessionsPerUser ?? null}
            onSessionMutated={() => {
              // refetch the conference so my_session_count stays accurate.
              api.conferences.get({ slug }).then(setFetchedConf).catch(() => { /* keep current */ });
            }}
          />
        )}
        {tab === "agenda"   && <AgendaTab slug={slug} isMod={isMod} timeZone={conf.timezone} mixerAvoidRepeatsDefault={conf.mixer_avoid_repeats_default} myIdentityId={confMe.id} />}
        {tab === "experts"  && <ExpertsTab slug={slug} role={conf.my_role} timeZone={conf.timezone} />}
        {tab === "directory" && (
          <DirectoryTab
            slug={slug}
            confMe={confMe}
            onConfMeRefresh={onConfMeRefresh}
          />
        )}
        {tab === "chat" && (
          <ChatTab
            slug={slug}
            confMe={confMe}
            isMod={isMod}
            onBrowseDirectory={() => setTab("directory")}
          />
        )}
        {tab === "me"       && (
          <MyAssignmentsTab
            slug={slug}
            timeZone={conf.timezone}
            isMod={isMod}
          />
        )}
        {tab === "settings" && isOwner && (
          <SettingsTab
            slug={slug}
            currentName={conf.name}
            currentDs={conf.design_system}
            currentTz={conf.timezone}
            currentMixerAvoidRepeats={conf.mixer_avoid_repeats_default}
            currentSubmissionMaxPlacements={conf.submission_max_placements_default}
            currentParticipantSubmissionsEnabled={conf.participant_submissions_enabled}
            usage={conf.usage}
            onNameChange={(name) => setFetchedConf({ ...conf, name })}
            onDsChange={(id) => {
              setFetchedConf({ ...conf, design_system: id });
              onDesignSystemChange?.(id);
            }}
            onTzChange={(tz) => setFetchedConf({ ...conf, timezone: tz })}
            onMixerAvoidRepeatsChange={(v) =>
              setFetchedConf({ ...conf, mixer_avoid_repeats_default: v })
            }
            onSubmissionMaxPlacementsChange={(v) =>
              setFetchedConf({ ...conf, submission_max_placements_default: v })
            }
            onParticipantSubmissionsEnabledChange={(v) =>
              setFetchedConf({ ...conf, participant_submissions_enabled: v })
            }
            onDeleted={onBack}
            onTransferred={onBack}
          />
        )}
      </div>
    </PageLayout>
  );
}

// ---------------------------------------------------------------------------
// Header.
//
// Architecture: the expanded header lives in normal document flow so it
// scrolls away with the page. A separate compact bar mounts as a
// `position: fixed` overlay once the expanded header is fully off-screen.
// This keeps document height constant — switching between the two never
// reflows the page, never clamps scroll position, never makes the
// scrollbar flicker on barely-overflowing pages.
//
// We watch a 1px sentinel placed at the bottom of the expanded header with
// an IntersectionObserver: when it leaves the viewport, the compact bar
// appears; when it returns, the compact bar hides. No scroll-position
// math, no thresholds, no hysteresis required.

function ConferenceHeader({
  conf, tabs, activeTab, onTabChange,
  onBack, me, colorMode, onColorModeChange, onSignOut, slug,
}: {
  conf: ConferenceDetail;
  tabs: Tab[];
  activeTab: Tab;
  onTabChange: (t: Tab) => void;
  onBack: () => void;
  me: ConfMe;
  colorMode: ColorMode;
  onColorModeChange: (next: ColorMode) => void;
  onSignOut: () => void | Promise<void>;
  slug: string;
}) {
  // CTA-driven tab switch from the notification bell. Each notification carries
  // a `tab:<key>` href; we accept only keys that are actually rendered for this
  // viewer's role (so a stale "go to Settings" notif on a participant inbox
  // can't crash the page).
  const navigateTab = (tabKey: string) => {
    if ((tabs as string[]).includes(tabKey)) onTabChange(tabKey as Tab);
  };
  const isMod = conf.my_role === "owner" || conf.my_role === "moderator";
  const [showCompact, setShowCompact] = useState(false);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel) return;
    const obs = new IntersectionObserver((entries) => {
      const entry = entries[0];
      if (entry) setShowCompact(!entry.isIntersecting);
    }, { threshold: 0 });
    obs.observe(sentinel);
    return () => obs.disconnect();
  }, []);

  const tabBarOptions = tabs.map((t) => ({ value: t, label: tabLabel(t) }));

  return (
    <>
      {/* Expanded header — normal flow. Negative side margins + matching
          padding extend the background to the edges of PageLayout's 960px
          content frame so it reads as one continuous strip. */}
      <div style={{
        margin: "-24px -24px 0",
        padding: "20px 24px 0",
        background: "var(--bgColor-default, var(--uncon-bg, #fff))",
      }}>
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          gap: 12, minHeight: 32,
        }}>
          <Breadcrumb
            parent="Your conferences"
            onParentClick={onBack}
            current={conf.name}
          />
          <div style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
            {isMod && <BroadcastButton slug={slug} />}
            <NotificationBell slug={slug} onNavigateTab={navigateTab} />
            <AccountMenu
              name={me.name}
              email={me.email}
              colorMode={colorMode}
              onColorModeChange={onColorModeChange}
              onSignOut={onSignOut}
            />
          </div>
        </div>

        <div style={{
          marginTop: 8,
          display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap",
        }}>
          <Heading level={1}>{conf.name}</Heading>
          <RolePill role={conf.my_role} />
          <InfoPopover slug={conf.slug} timezone={conf.timezone} />
        </div>

        <div style={{ marginTop: 16 }}>
          <TabBar value={activeTab} onChange={onTabChange} options={tabBarOptions} />
        </div>

        {/* Sentinel — sits just below the tab bar. The compact bar shows
            iff this element is out of the viewport. */}
        <div ref={sentinelRef} style={{ height: 1, marginTop: 0 }} aria-hidden />
      </div>

      {/* Compact bar — fixed overlay. Only mounted while the expanded
          header is fully off-screen, so the two never overlap visually. */}
      {showCompact && (
        <div style={{
          position: "fixed",
          top: 0, left: 0, right: 0,
          zIndex: 50,
          background: "var(--bgColor-default, var(--uncon-bg, #fff))",
          borderBottom: "1px solid var(--borderColor-muted, var(--uncon-border-muted, #e5e7eb))",
          boxShadow: "0 2px 8px rgba(0, 0, 0, 0.04)",
        }}>
          <div style={{
            maxWidth: 960,
            margin: "0 auto",
            padding: "10px 24px",
            display: "flex", flexDirection: "column", gap: 8,
          }}>
            <div style={{
              display: "flex", alignItems: "center", justifyContent: "space-between",
              gap: 12, minHeight: 32,
            }}>
              <Breadcrumb
                parent="Your conferences"
                onParentClick={onBack}
                current={conf.name}
                inlineRole={conf.my_role}
              />
              <div style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                {isMod && <BroadcastButton slug={slug} />}
                <NotificationBell slug={slug} onNavigateTab={navigateTab} />
                <AccountMenu
                  name={me.name}
                  email={me.email}
                  colorMode={colorMode}
                  onColorModeChange={onColorModeChange}
                  onSignOut={onSignOut}
                />
              </div>
            </div>
            <TabBar value={activeTab} onChange={onTabChange} options={tabBarOptions} />
          </div>
        </div>
      )}
    </>
  );
}

// ---- breadcrumb ----------------------------------------------------------

function Breadcrumb({
  parent, onParentClick, current, inlineRole,
}: {
  parent: string;
  onParentClick: () => void;
  current: string;
  /** When set, renders a small role chip after the current item. Used in
   *  the scrolled/compact state to keep the identity hint visible. */
  inlineRole?: Role;
}) {
  const muted = "var(--fgColor-muted, var(--uncon-fg-muted, #6e7781))";
  return (
    <nav aria-label="Breadcrumb" style={{ minWidth: 0, display: "flex", alignItems: "center", gap: 6 }}>
      <button
        type="button"
        onClick={onParentClick}
        style={{
          appearance: "none", border: "none", background: "transparent",
          padding: 0, margin: 0,
          color: muted, fontFamily: "inherit", fontSize: 13,
          cursor: "pointer",
          textDecoration: "none",
        }}
        onMouseEnter={(e) => { e.currentTarget.style.textDecoration = "underline"; }}
        onMouseLeave={(e) => { e.currentTarget.style.textDecoration = "none"; }}
      >
        {parent}
      </button>
      <span aria-hidden style={{ color: muted, fontSize: 13 }}>›</span>
      <span style={{
        fontSize: 13, fontWeight: 600,
        color: "var(--fgColor-default, var(--uncon-fg, inherit))",
        whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
        minWidth: 0,
      }}>
        {current}
      </span>
      {inlineRole && (
        <span style={{ marginLeft: 4 }}>
          <RolePill role={inlineRole} compact />
        </span>
      )}
    </nav>
  );
}

// ---- role pill -----------------------------------------------------------

function RolePill({ role, compact }: { role: Role; compact?: boolean }) {
  const bg = role === "owner"
    ? "var(--bgColor-accent-muted, rgba(64,132,246,0.12))"
    : role === "moderator"
      ? "var(--bgColor-attention-muted, rgba(187,128,9,0.12))"
      : "var(--bgColor-muted, var(--uncon-bg-subtle, rgba(0,0,0,0.05)))";
  const fg = role === "owner"
    ? "var(--fgColor-accent, #2563eb)"
    : role === "moderator"
      ? "var(--fgColor-attention, #9a6700)"
      : "var(--fgColor-muted, var(--uncon-fg-muted, #6e7781))";
  const label = role === "owner" ? "Owner" : role === "moderator" ? "Moderator" : "Participant";
  return (
    <span style={{
      display: "inline-flex", alignItems: "center",
      padding: compact ? "1px 7px" : "2px 10px",
      borderRadius: 999,
      background: bg, color: fg,
      fontSize: compact ? 10 : 11, fontWeight: 600,
      textTransform: "uppercase", letterSpacing: 0.4,
      whiteSpace: "nowrap",
    }}>
      {label}
    </span>
  );
}

// ---- info popover (slug + timezone) -------------------------------------

function InfoPopover({ slug, timezone }: { slug: string; timezone: string }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const muted = "var(--fgColor-muted, var(--uncon-fg-muted, #6e7781))";

  return (
    <span ref={rootRef} style={{ position: "relative", display: "inline-flex" }}>
      <button
        type="button"
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onClick={() => setOpen((v) => !v)}
        aria-label="Conference details"
        title="Conference details"
        style={{
          appearance: "none",
          width: 22, height: 22,
          padding: 0,
          display: "inline-flex", alignItems: "center", justifyContent: "center",
          border: "none", background: "transparent",
          color: muted,
          cursor: "pointer", borderRadius: "50%",
          transition: "color 120ms, background 120ms",
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
          <circle cx="8" cy="8" r="6.75" fill="none" stroke="currentColor" strokeWidth="1.3" />
          <path d="M8 7.25 V11.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          <circle cx="8" cy="5" r="0.9" fill="currentColor" />
        </svg>
      </button>

      {open && (
        <div
          role="tooltip"
          style={{
            position: "absolute",
            top: "calc(100% + 6px)",
            left: 0,
            minWidth: 220,
            padding: "8px 12px",
            borderRadius: 8,
            border: "1px solid var(--borderColor-default, var(--uncon-border, #d0d7de))",
            background: "var(--bgColor-default, var(--uncon-bg, #fff))",
            boxShadow: "0 4px 12px rgba(0, 0, 0, 0.12)",
            zIndex: 60,
            display: "grid",
            gridTemplateColumns: "auto 1fr",
            columnGap: 12, rowGap: 4,
            fontSize: 12,
          }}
        >
          <span style={{ color: muted, textTransform: "uppercase", letterSpacing: 0.4, fontWeight: 600, fontSize: 10 }}>
            Slug
          </span>
          <span style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}>{slug}</span>
          <span style={{ color: muted, textTransform: "uppercase", letterSpacing: 0.4, fontWeight: 600, fontSize: 10 }}>
            Timezone
          </span>
          <span>{timezone}</span>
        </div>
      )}
    </span>
  );
}

// --------------------------------------------------------------------------

function tabLabel(t: Tab): string {
  return ({
    people: "People", rooms: "Rooms", sessions: "Sessions",
    agenda: "Agenda", experts: "Experts", directory: "Directory",
    chat: "Chat",
    me: "My schedule", settings: "Settings",
  } as Record<Tab, string>)[t];
}

// Re-export Role for callers that imported it from this module previously.
export type { Role };
