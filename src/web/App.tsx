import { useEffect, useState, useCallback, lazy, Suspense } from "react";
import { DesignSystemProvider, ToastProvider } from "./design-system";
import { DEFAULT_PLUGIN_ID } from "./design-system/core/registry";
import type { ColorMode } from "./design-system/core/contract";
import { api, ApiError } from "./api";
import { useRoute, matchRoute } from "./router";
import { ErrorBoundary } from "./components/ErrorBoundary";

// Lazy-load each page in its own chunk.
const LoginPage = lazy(() =>
  import("./pages/Login").then((m) => ({ default: m.LoginPage })),
);
const ConferencesPage = lazy(() =>
  import("./pages/Conferences").then((m) => ({ default: m.ConferencesPage })),
);
const ConferencePage = lazy(() =>
  import("./pages/Conference").then((m) => ({ default: m.ConferencePage })),
);
const JoinPage = lazy(() =>
  import("./pages/Join").then((m) => ({ default: m.JoinPage })),
);
const ConferenceLoginPage = lazy(() =>
  import("./pages/ConferenceLogin").then((m) => ({
    default: m.ConferenceLoginPage,
  })),
);

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

interface ConferenceSummary {
  slug: string;
  design_system: string;
}

function MinimalLoading() {
  return (
    <div
      style={{
        padding: 24,
        fontFamily: "system-ui",
        color: "var(--fgColor-default, inherit)",
      }}
    >
      Loading…
    </div>
  );
}

// Footer is intentionally NOT wired through the design-system wrappers — we
// want plain inheritable colors so links can match the muted foreground.
// Primer exposes it as `--fgColor-muted`; the minimal plugin uses
// `--uncon-fg-muted`. Both border vars get the same treatment.
function FooterIconLink({
  href,
  label,
  children,
}: {
  href: string;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={label}
      title={label}
      className="app-footer-link"
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: 36,
        height: 36,
        borderRadius: 999,
        color: "inherit",
        textDecoration: "none",
        transition:
          "color 120ms ease, background 120ms ease, transform 120ms ease",
      }}
    >
      {children}
    </a>
  );
}

const FOOTER_HOVER_STYLE = `
.app-footer-link:hover {
  color: var(--fgColor-default, var(--uncon-fg, inherit));
  background: var(--bgColor-muted, var(--uncon-bg-subtle, rgba(127,127,127,0.08)));
  transform: translateY(-1px);
}
.app-footer-link:focus-visible {
  outline: 2px solid var(--fgColor-accent, var(--uncon-primary, #2563eb));
  outline-offset: 2px;
}
`;

function Footer() {
  return (
    <footer
      style={{
        marginTop: 32,
        padding: "20px 24px 28px",
        borderTop:
          "1px solid var(--borderColor-muted, var(--uncon-border-muted, rgba(127,127,127,0.18)))",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 8,
        color: "var(--fgColor-muted, var(--uncon-fg-muted, #6b7280))",
        fontSize: 12,
        letterSpacing: 0.2,
      }}
    >
      <style>{FOOTER_HOVER_STYLE}</style>
      <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
        <FooterIconLink
          href="https://github.com/enyineer/simple-unconference"
          label="GitHub repository"
        >
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="currentColor"
            aria-hidden="true"
          >
            <path d="M12 .5C5.73.5.75 5.48.75 11.75c0 4.96 3.22 9.16 7.69 10.65.56.1.77-.24.77-.54v-2.1c-3.13.68-3.79-1.32-3.79-1.32-.51-1.3-1.25-1.65-1.25-1.65-1.02-.7.08-.69.08-.69 1.13.08 1.72 1.16 1.72 1.16 1 1.72 2.63 1.22 3.27.93.1-.73.39-1.22.71-1.5-2.5-.29-5.13-1.25-5.13-5.56 0-1.23.44-2.23 1.16-3.02-.12-.29-.5-1.44.11-3 0 0 .95-.3 3.1 1.15a10.7 10.7 0 0 1 5.64 0c2.15-1.45 3.1-1.15 3.1-1.15.61 1.56.23 2.71.11 3 .72.79 1.16 1.79 1.16 3.02 0 4.32-2.63 5.27-5.14 5.55.4.35.76 1.03.76 2.08v3.08c0 .3.2.65.78.54 4.46-1.49 7.68-5.69 7.68-10.65C23.25 5.48 18.27.5 12 .5z" />
          </svg>
        </FooterIconLink>
        <FooterIconLink href="https://enking.dev" label="enking.dev">
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <circle cx="12" cy="12" r="9" />
            <path d="M3 12h18" />
            <path d="M12 3a13.5 13.5 0 0 1 0 18a13.5 13.5 0 0 1 0-18z" />
          </svg>
        </FooterIconLink>
      </div>
      <div style={{ opacity: 0.75 }}>
        Crafted by{" "}
        <a
          href="https://enking.dev"
          target="_blank"
          rel="noopener noreferrer"
          className="app-footer-link"
          style={{
            color: "inherit",
            textDecoration: "none",
            fontWeight: 500,
            padding: "0 4px",
            borderRadius: 4,
          }}
        >
          enking.dev
        </a>
      </div>
    </footer>
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
  // Per-conference identity / design system. `fetchedX` is what the most
  // recent fetch (or event handler) wrote; `loadedXSlug` is which slug that
  // value belongs to. The derived `confMe` / `confDs` collapse back to their
  // "no conference active" defaults whenever those don't match, so we don't
  // need a synchronous reset-in-effect on confSlug change.
  const [fetchedConfMe, setFetchedConfMe] = useState<ConfMe | null | undefined>(undefined);
  const [loadedConfMeSlug, setLoadedConfMeSlug] = useState<string | undefined>(undefined);
  const [fetchedConfDs, setFetchedConfDs] = useState<string | null>(null);
  const [loadedConfDsSlug, setLoadedConfDsSlug] = useState<string | undefined>(undefined);
  // Owner-side color mode lives in memory only (Users have no persisted
  // colorMode in the new identity model). Each conference identity persists
  // its own preference server-side.
  const [ownerColorMode, setOwnerColorMode] = useState<ColorMode>("auto");

  // Used both on mount (via the effect below) and as the post-login /
  // post-logout refresh handed to LoginPage / ConferencesPage.
  async function loadOwner() {
    try {
      setOwner(await api.auth.me());
    } catch {
      setOwner(null);
    }
  }
  useEffect(() => {
    let cancelled = false;
    api.auth.me()
      .then((m) => { if (!cancelled) setOwner(m); })
      .catch(() => { if (!cancelled) setOwner(null); });
    return () => { cancelled = true; };
  }, []);

  // Per-conference identity: fetch whenever the active conference slug changes.
  useEffect(() => {
    if (!confSlug) return;
    let cancelled = false;
    api.conferences
      .me({ slug: confSlug })
      .then((m) => {
        if (cancelled) return;
        setFetchedConfMe(m);
        setLoadedConfMeSlug(confSlug);
      })
      .catch(() => {
        if (cancelled) return;
        setFetchedConfMe(null);
        setLoadedConfMeSlug(confSlug);
      });
    return () => {
      cancelled = true;
    };
  }, [confSlug]);

  // Design system: fetch per-conference. Anonymous (no auth required for the
  // public conference.get? Actually `get` is participant-only. Fall back to
  // the default plugin if not authorized yet so JoinPage / ConferenceLogin
  // still render with sensible branding).
  useEffect(() => {
    if (!confSlug) return;
    let cancelled = false;
    api.conferences
      .get({ slug: confSlug })
      .then((c: ConferenceSummary) => {
        if (cancelled) return;
        setFetchedConfDs(c.design_system || DEFAULT_PLUGIN_ID);
        setLoadedConfDsSlug(confSlug);
      })
      .catch(() => {
        if (cancelled) return;
        setFetchedConfDs(DEFAULT_PLUGIN_ID);
        setLoadedConfDsSlug(confSlug);
      });
    return () => {
      cancelled = true;
    };
  }, [confSlug]);

  // Hide stale data while a new slug is in flight (or there's no active
  // conference). The settled-slug tracking above guarantees these flip back
  // to defaults without a synchronous setState in the effect.
  const confMe = confSlug && loadedConfMeSlug === confSlug ? fetchedConfMe : undefined;
  const confDs = confSlug && loadedConfDsSlug === confSlug ? fetchedConfDs : null;
  const setConfMe = setFetchedConfMe;
  const setConfDs = setFetchedConfDs;

  const activePluginId = confSlug && confDs ? confDs : DEFAULT_PLUGIN_ID;
  const activeColorMode: ColorMode = confSlug
    ? confMe?.color_mode ?? "auto"
    : ownerColorMode;

  // Color-mode setter — applies to whichever scope is active.
  const setColorMode = useCallback(
    async (mode: ColorMode) => {
      if (confSlug && confMe) {
        setConfMe({ ...confMe, color_mode: mode });
        try {
          const updated = await api.conferences.updateConfMe({
            slug: confSlug,
            color_mode: mode,
          });
          setConfMe(updated);
        } catch (e) {
          if (e instanceof ApiError) setConfMe(confMe);
        }
        return;
      }
      setOwnerColorMode(mode);
    },
    [confSlug, confMe, setConfMe],
  );

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
      <ToastProvider>
        <ErrorBoundary resetKey={path}>
          <Suspense fallback={<MinimalLoading />}>{renderPage()}</Suspense>
        </ErrorBoundary>
        <Footer />
      </ToastProvider>
    </DesignSystemProvider>
  );
}
