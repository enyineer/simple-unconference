import { useEffect, useState, useCallback, lazy, Suspense } from "react";
import { DesignSystemProvider } from "./design-system";
import { DEFAULT_PLUGIN_ID } from "./design-system/core/registry";
import type { ColorMode } from "./design-system/core/contract";
import { api, ApiError } from "./api";
import { useRoute, matchRoute } from "./router";
import { ErrorBoundary } from "./components/ErrorBoundary";

// Lazy-load each page in its own chunk.
const LoginPage = lazy(() =>
  import("./pages/Login").then((m) => ({ default: m.LoginPage })));
const ConferencesPage = lazy(() =>
  import("./pages/Conferences").then((m) => ({ default: m.ConferencesPage })));
const ConferencePage = lazy(() =>
  import("./pages/Conference").then((m) => ({ default: m.ConferencePage })));
const JoinPage = lazy(() =>
  import("./pages/Join").then((m) => ({ default: m.JoinPage })));
const ConferenceLoginPage = lazy(() =>
  import("./pages/ConferenceLogin").then((m) => ({ default: m.ConferenceLoginPage })));

// Owner identity (global User). Only used by the owner-facing ConferencesPage
// and the global LoginPage. No `color_mode` here — that preference lives on
// ConferenceIdentity (per-conference).
export interface Me {
  id: number;
  email: string;
  name: string | null;
}

// Per-conference identity. The acting identity inside a single conference,
// returned by `conferences.me({ slug })`. Owners get one auto-minted on
// first visit to their own conference; for them `role === "owner"`.
export interface ConfMe {
  id: number;
  email: string;
  name: string | null;
  role: "owner" | "moderator" | "participant";
  color_mode: ColorMode;
}

interface ConferenceSummary { slug: string; design_system: string; }

function MinimalLoading() {
  return (
    <div style={{ padding: 24, fontFamily: "system-ui", color: "var(--fgColor-default, inherit)" }}>
      Loading…
    </div>
  );
}

export function App() {
  const { path, navigate } = useRoute();

  // Routes (parsed up front; some are anonymous, some require auth).
  const joinMatch = matchRoute("/c/:slug/join", path);
  const confLoginMatch = matchRoute("/c/:slug/login", path);
  const confMatch = matchRoute("/conferences/:slug", path);
  const confSlug = confMatch?.slug;

  // Two independent auth states. They can be active simultaneously — the
  // owner cookie + any number of per-conference identity cookies coexist.
  const [owner, setOwner] = useState<Me | null | undefined>(undefined);
  const [confMe, setConfMe] = useState<ConfMe | null | undefined>(undefined);
  // Owner-side color mode lives in memory only (Users have no persisted
  // colorMode in the new identity model). Each conference identity persists
  // its own preference server-side.
  const [ownerColorMode, setOwnerColorMode] = useState<ColorMode>("auto");

  // Brand: when inside a conference, fetch the conference's design system.
  const [confDs, setConfDs] = useState<string | null>(null);

  async function loadOwner() {
    try { setOwner(await api.auth.me()); }
    catch { setOwner(null); }
  }
  useEffect(() => { loadOwner(); }, []);

  // Per-conference identity: fetch whenever the active conference slug changes.
  useEffect(() => {
    if (!confSlug) { setConfMe(undefined); return; }
    let cancelled = false;
    setConfMe(undefined);
    api.conferences.me({ slug: confSlug })
      .then((m) => { if (!cancelled) setConfMe(m); })
      .catch(() => { if (!cancelled) setConfMe(null); });
    return () => { cancelled = true; };
  }, [confSlug]);

  // Design system: fetch per-conference. Anonymous (no auth required for the
  // public conference.get? Actually `get` is participant-only. Fall back to
  // the default plugin if not authorized yet so JoinPage / ConferenceLogin
  // still render with sensible branding).
  useEffect(() => {
    if (!confSlug) { setConfDs(null); return; }
    let cancelled = false;
    api.conferences.get({ slug: confSlug })
      .then((c: ConferenceSummary) => { if (!cancelled) setConfDs(c.design_system || DEFAULT_PLUGIN_ID); })
      .catch(() => { if (!cancelled) setConfDs(DEFAULT_PLUGIN_ID); });
    return () => { cancelled = true; };
  }, [confSlug]);

  const activePluginId = confSlug && confDs ? confDs : DEFAULT_PLUGIN_ID;
  const activeColorMode: ColorMode = confSlug
    ? (confMe?.color_mode ?? "auto")
    : ownerColorMode;

  // Color-mode setter — applies to whichever scope is active.
  const setColorMode = useCallback(async (mode: ColorMode) => {
    if (confSlug && confMe) {
      setConfMe({ ...confMe, color_mode: mode });
      try {
        const updated = await api.conferences.updateConfMe({ slug: confSlug, color_mode: mode });
        setConfMe(updated);
      } catch (e) {
        if (e instanceof ApiError) setConfMe(confMe);
      }
      return;
    }
    setOwnerColorMode(mode);
  }, [confSlug, confMe]);

  function renderPage() {
    // ----- anonymous, conference-scoped routes -----
    if (joinMatch && joinMatch.slug) {
      return (
        <JoinPage
          slug={joinMatch.slug}
          onJoined={() => navigate(`/conferences/${joinMatch.slug}`)}
          onCancel={() => navigate("/")}
        />
      );
    }
    if (confLoginMatch && confLoginMatch.slug) {
      return (
        <ConferenceLoginPage
          slug={confLoginMatch.slug}
          onLoggedIn={() => navigate(`/conferences/${confLoginMatch.slug}`)}
          onCancel={() => navigate("/")}
        />
      );
    }

    // ----- per-conference (requires identity) -----
    if (confMatch && confMatch.slug) {
      if (confMe === undefined) return <MinimalLoading />;
      if (confMe === null) {
        // Bounce to the per-conference login. Use a microtask so the redirect
        // happens after render completes (avoids navigation-during-render).
        queueMicrotask(() => navigate(`/c/${confMatch.slug}/login`));
        return <MinimalLoading />;
      }
      return (
        <ConferencePage
          slug={confMatch.slug}
          confMe={confMe}
          onBack={() => navigate("/")}
          onDesignSystemChange={(id) => setConfDs(id)}
          colorMode={activeColorMode}
          onColorModeChange={setColorMode}
          onLoggedOut={() => {
            setConfMe(null);
            navigate(`/c/${confMatch.slug}/login`);
          }}
        />
      );
    }

    // ----- owner-side default route -----
    if (owner === undefined) return <MinimalLoading />;
    if (owner === null) return <LoginPage onLoggedIn={loadOwner} />;
    return (
      <ConferencesPage
        me={owner}
        onLogout={loadOwner}
        onOpen={(s) => navigate(`/conferences/${s}`)}
        colorMode={activeColorMode}
        onColorModeChange={setColorMode}
      />
    );
  }

  return (
    <DesignSystemProvider
      pluginId={activePluginId}
      colorMode={activeColorMode}
      fallback={<MinimalLoading />}
    >
      <ErrorBoundary resetKey={path}>
        <Suspense fallback={<MinimalLoading />}>
          {renderPage()}
        </Suspense>
      </ErrorBoundary>
    </DesignSystemProvider>
  );
}
