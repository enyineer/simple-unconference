import { useEffect, useState, useCallback, lazy, Suspense } from "react";
import { DesignSystemProvider, ToastProvider } from "./design-system";
import { RealtimeProvider } from "./realtime/RealtimeProvider";
import { DEFAULT_PLUGIN_ID } from "./design-system/core/registry";
import type { ColorMode } from "./design-system/core/contract";
import { api, ApiError } from "./api";
import { useRoute, matchRoute } from "./router";
import type { Tab } from "./conference/types";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { OfflineBanner } from "./components/OfflineBanner";
import { updateInstallLinks } from "./pwa/links";

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
const BoardPage = lazy(() =>
  import("./pages/Board").then((m) => ({ default: m.BoardPage })),
);
const ConferenceLoginPage = lazy(() =>
  import("./pages/ConferenceLogin").then((m) => ({
    default: m.ConferenceLoginPage,
  })),
);
const ProfilePage = lazy(() =>
  import("./conference/ProfilePage").then((m) => ({ default: m.ProfilePage })),
);
const ResetPasswordPage = lazy(() =>
  import("./pages/ResetPassword").then((m) => ({ default: m.ResetPasswordPage })),
);
const VerifyEmailWall = lazy(() =>
  import("./pages/VerifyEmail").then((m) => ({ default: m.VerifyEmailWall })),
);
const VerifyEmailTokenPage = lazy(() =>
  import("./pages/VerifyEmail").then((m) => ({ default: m.VerifyEmailTokenPage })),
);

// Pull `?token=...` out of the hash-router path (which keeps the query tail).
function resetTokenFromPath(p: string): string {
  const q = p.indexOf("?");
  if (q === -1) return "";
  return new URLSearchParams(p.slice(q + 1)).get("token") ?? "";
}

// Owner identity (global User). Only used by the owner-facing ConferencesPage
// and the global LoginPage. No `color_mode` here — that preference lives on
// ConferenceIdentity (per-conference).
export interface Me {
  id: number;
  email: string;
  name: string | null;
  // False while a global account awaits email verification (only when the
  // instance has email configured). Drives the "verify before entering" wall.
  email_verified: boolean;
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
  // Profile state carried alongside the standard identity payload so the
  // first-login completion nudge can render without a second round-trip.
  profile_published: boolean;
  profile_completion_dismissed: boolean;
}

interface ConferenceSummary {
  slug: string;
  name?: string;
  design_system: string;
  /** Content hash of the owner's custom PWA icon, or null for the default.
   *  Drives the per-conference apple-touch-icon link. */
  icon_hash?: string | null;
}

// The default document title (set in index.html). Snapshotted at load so we can
// restore it when leaving a conference. While inside a conference we set the
// title to the conference name — it's the browser-tab label AND what Firefox
// Android uses for an "Add to Home screen" shortcut (Firefox reads the title,
// not the manifest name).
const BASE_DOCUMENT_TITLE =
  typeof document !== "undefined" ? document.title : "Unconf";

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
  const boardMatch = matchRoute("/board/:slug", path);
  const joinMatch = matchRoute("/c/:slug/join", path);
  const confLoginMatch = matchRoute("/c/:slug/login", path);
  const confResetMatch = matchRoute("/c/:slug/reset", path);
  const ownerResetMatch = matchRoute("/auth/reset", path);
  const ownerVerifyMatch = matchRoute("/auth/verify", path);
  const confMatch = matchRoute("/conferences/:slug", path);
  const profileMatch = matchRoute("/conferences/:slug/p/:identityId", path);
  // Per-tab routes. ConferencePage reads the tab segment to decide which
  // panel to render, so deep links + the back/forward buttons line up
  // with the visible tab. Sub-paths (e.g. chat conversations) match the
  // 3-segment variants.
  const tabMatch =
    matchRoute("/conferences/:slug/:tab", path)
    ?? matchRoute("/conferences/:slug/:tab/:rest", path);
  // Either /conferences/:slug, its profile sub-route, or one of its
  // tab sub-routes shares the same per-conference identity + design-system
  // state, so pick the slug from whichever matched.
  const confSlug = confMatch?.slug ?? profileMatch?.slug ?? tabMatch?.slug;

  // Two independent auth states. They can be active simultaneously — the
  // owner cookie + any number of per-conference identity cookies coexist.
  const [owner, setOwner] = useState<Me | null | undefined>(undefined);
  // Per-conference identity / design system. `fetchedX` is what the most
  // recent fetch (or event handler) wrote; `loadedXSlug` is which slug that
  // value belongs to. The derived `confMe` / `confDs` collapse back to their
  // "no conference active" defaults whenever those don't match.
  const [fetchedConfMe, setFetchedConfMe] = useState<ConfMe | null | undefined>(undefined);
  const [loadedConfMeSlug, setLoadedConfMeSlug] = useState<string | undefined>(undefined);
  const [fetchedConfDs, setFetchedConfDs] = useState<string | null>(null);
  const [loadedConfDsSlug, setLoadedConfDsSlug] = useState<string | undefined>(undefined);
  // Custom PWA icon hash for the active conference. Drives the dynamic
  // apple-touch-icon link; null = the default icon. Undefined while unknown.
  const [confIconHash, setConfIconHash] = useState<string | null | undefined>(undefined);
  // Active conference display name, for the document title (browser tab +
  // Firefox Android home-screen shortcut label). Null when unknown / outside.
  const [confName, setConfName] = useState<string | null>(null);

  // Drop the cached identity result the moment the active conference changes,
  // so a stale value — especially a `null` cached from an earlier
  // *unauthenticated* visit to the same slug (deep link → bounced to the
  // conference login → sign in → land back on this slug) — can never be read
  // as authoritative before the fetch below settles. Without this, that stale
  // `null` makes `confMe` resolve to `null` synchronously and fires an instant,
  // incorrect redirect back to login that ALSO cancels the in-flight refetch,
  // stranding the user in a loop only a hard reload escapes. This render-time
  // reset (React's "adjust state while rendering" pattern) is preferred over a
  // setState-in-effect, which would cascade an extra render.
  const [confMeSlugTracked, setConfMeSlugTracked] = useState<string | undefined>(confSlug);
  if (confSlug !== confMeSlugTracked) {
    setConfMeSlugTracked(confSlug);
    setFetchedConfMe(undefined);
    setLoadedConfMeSlug(undefined);
  }
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
        setConfIconHash(c.icon_hash ?? null);
        setConfName(c.name ?? null);
        setLoadedConfDsSlug(confSlug);
      })
      .catch(() => {
        if (cancelled) return;
        setFetchedConfDs(DEFAULT_PLUGIN_ID);
        setConfIconHash(null);
        setConfName(null);
        setLoadedConfDsSlug(confSlug);
      });
    return () => {
      cancelled = true;
    };
  }, [confSlug]);

  // Point the document's manifest + apple-touch-icon links at the active
  // conference (its own installable app + home-screen icon), removing them when
  // leaving. The manifest link is set as soon as the slug is known — it needs
  // only the slug (the server route resolves the name/icon itself), and adding
  // it EARLY (not waiting for the conferences.get fetch) is what lets Chrome's
  // installability check see it and fire `beforeinstallprompt`. The icon hash
  // arrives with that fetch; until it settles for THIS slug we pass null (the
  // default icon) rather than a stale previous-conference hash.
  useEffect(() => {
    const slug = confSlug ?? null;
    const iconHash = slug && loadedConfDsSlug === confSlug ? confIconHash ?? null : null;
    updateInstallLinks(slug, iconHash);
  }, [confSlug, loadedConfDsSlug, confIconHash]);

  // Reflect the active conference in the document title: the browser-tab label
  // and, importantly, the name Firefox Android puts on an "Add to Home screen"
  // shortcut (it uses document.title, not the manifest). Restore the default
  // title when leaving the conference.
  useEffect(() => {
    const name = confSlug && loadedConfDsSlug === confSlug ? confName : null;
    document.title = name ?? BASE_DOCUMENT_TITLE;
  }, [confSlug, loadedConfDsSlug, confName]);

  // Canonicalize the conference home to a trailing slash (/conferences/<slug>/).
  // The manifest scope is slash-terminated (so one conference can't capture
  // another whose slug it prefixes), and Chrome only offers to install when the
  // current page is INSIDE that scope — the bare `/conferences/<slug>` sits just
  // outside it. matchRoute treats both forms identically, so this only rewrites
  // the address bar; it doesn't change routing. replaceState (no popstate) keeps
  // wouter's state untouched.
  useEffect(() => {
    if (/^\/conferences\/[^/]+$/.test(window.location.pathname)) {
      history.replaceState(
        null, "",
        window.location.pathname + "/" + window.location.search + window.location.hash,
      );
    }
  }, [path]);

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
    // ----- public Live Board — full-screen, no conference chrome -----
    if (boardMatch && boardMatch.slug) {
      return <BoardPage slug={boardMatch.slug} />;
    }
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
    // ----- password reset (anonymous; token comes from the email link) -----
    if (ownerResetMatch) {
      return (
        <ResetPasswordPage
          scope={{ kind: "owner" }}
          token={resetTokenFromPath(path)}
          // Reset logs the caller in server-side; refresh owner state so the
          // home route renders the authed view instead of the login screen.
          onDone={() => { loadOwner(); navigate("/"); }}
          onCancel={() => navigate("/")}
        />
      );
    }
    // Magic-link email confirmation. Confirms server-side (logging the caller
    // in), then refreshes owner state and lands on the dashboard.
    if (ownerVerifyMatch) {
      return (
        <VerifyEmailTokenPage
          token={resetTokenFromPath(path)}
          onDone={() => { loadOwner(); navigate("/"); }}
        />
      );
    }
    if (confResetMatch && confResetMatch.slug) {
      const resetSlug = confResetMatch.slug;
      return (
        <ResetPasswordPage
          scope={{ kind: "conference", slug: resetSlug }}
          token={resetTokenFromPath(path)}
          // Navigating to the conference re-runs the confMe fetch with the
          // freshly-set identity cookie.
          onDone={() => navigate(`/conferences/${resetSlug}`)}
          onCancel={() => navigate(`/c/${resetSlug}/login`)}
        />
      );
    }

    // ----- per-conference profile page (requires identity) -----
    if (profileMatch && profileMatch.slug && profileMatch.identityId) {
      const profileSlug = profileMatch.slug;
      const identityIdNum = Number(profileMatch.identityId);
      if (!Number.isFinite(identityIdNum)) {
        // Bad route segment — bounce back to the conference shell.
        queueMicrotask(() => navigate(`/conferences/${profileSlug}`));
        return <MinimalLoading />;
      }
      if (confMe === undefined) return <MinimalLoading />;
      if (confMe === null) {
        queueMicrotask(() => navigate(`/c/${profileSlug}/login`));
        return <MinimalLoading />;
      }
      const profileSlugForRefresh = profileSlug;
      return (
        <ProfilePage
          slug={profileSlug}
          identityId={identityIdNum}
          onConfMeRefresh={() => {
            api.conferences
              .me({ slug: profileSlugForRefresh })
              .then((m) => setConfMe(m))
              .catch(() => { /* keep current view */ });
          }}
        />
      );
    }

    // ----- per-conference (requires identity) -----
    // Both /conferences/:slug and /conferences/:slug/:tab[/...] render the
    // same shell — ConferencePage reads `routeTab` and switches its inner
    // panel. We resolve to a single render path so tab navigation doesn't
    // remount the page (which would refetch everything).
    const slugForConf = confMatch?.slug ?? tabMatch?.slug;
    const routeTab = (tabMatch?.tab as Tab | undefined);
    if (slugForConf) {
      if (confMe === undefined) return <MinimalLoading />;
      if (confMe === null) {
        queueMicrotask(() => navigate(`/c/${slugForConf}/login`));
        return <MinimalLoading />;
      }
      const slugForRefresh = slugForConf;
      return (
        <ConferencePage
          slug={slugForConf}
          confMe={confMe}
          onBack={() => navigate("/")}
          onDesignSystemChange={(id) => setConfDs(id)}
          colorMode={activeColorMode}
          onColorModeChange={setColorMode}
          onLoggedOut={() => {
            setConfMe(null);
            navigate(`/c/${slugForConf}/login`);
          }}
          onConfMeRefresh={() => {
            api.conferences
              .me({ slug: slugForRefresh })
              .then((m) => setConfMe(m))
              .catch(() => { /* keep current view */ });
          }}
          routeTab={routeTab}
        />
      );
    }

    // ----- owner-side default route -----
    if (owner === undefined) return <MinimalLoading />;
    if (owner === null) return <LoginPage onLoggedIn={loadOwner} />;
    // Verify-before-entering: a logged-in but unverified owner can do nothing
    // in the owner area until they confirm their email. (Only reachable when
    // the instance has email configured; otherwise signup auto-verifies.)
    if (!owner.email_verified) {
      return (
        <VerifyEmailWall
          email={owner.email}
          onVerified={loadOwner}
          onLogout={async () => { await api.auth.logout(); loadOwner(); }}
        />
      );
    }
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
        <OfflineBanner />
        <ErrorBoundary resetKey={path}>
          {/* Single tab-wide SSE stream. Mounted once the initial
              loadOwner call has settled (owner is no longer `undefined`)
              so we don't open a transient connection during startup.
              When the user is unauthenticated the server returns 401 and
              EventSource backs off to 30s — minimal cost on the login
              screen. Mounted ABOVE the route subtree so navigation doesn't
              churn the connection. */}
          {owner === undefined ? (
            <Suspense fallback={<MinimalLoading />}>{renderPage()}</Suspense>
          ) : (
            <RealtimeProvider>
              <Suspense fallback={<MinimalLoading />}>{renderPage()}</Suspense>
            </RealtimeProvider>
          )}
        </ErrorBoundary>
        {/* The public Live Board is a full-screen surface with its own chrome
            (and its own understated credit footnote). The app footer would
            otherwise sit at the top of the empty document flow behind the
            fixed board and bleed into its header. */}
        {!boardMatch && <Footer />}
      </ToastProvider>
    </DesignSystemProvider>
  );
}
