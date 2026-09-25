// Avatar dropdown that owns the per-user controls: color-mode picker + sign
// out. Shared across the conferences listing page and the inner conference
// page so the affordance lives in the same spot regardless of route.

import { useEffect, useRef, useState } from "react";
import type { ColorMode } from "../design-system/core/contract";
import { useNavLink } from "../router";

interface AccountMenuProps {
  name: string | null;
  email: string;
  colorMode: ColorMode;
  onColorModeChange: (next: ColorMode) => void;
  onSignOut: () => void | Promise<void>;
  /** When provided, the identity block grows an inline display-name editor.
   *  The callback performs the API call (and the parent's state refresh);
   *  an explicit empty string means "clear the name". Errors keep the
   *  editor open with the message shown under the field. */
  onRename?: (name: string | null) => Promise<void>;
  /** When set, the menu grows a "My profile" item linking to the signed-in
   *  identity's profile page — the place where display name, email, avatar
   *  and the rest of the profile are edited. The conferences-listing page
   *  omits it: there is no conference identity to link to there. */
  profileHref?: string;
}

export function AccountMenu({
  name, email, colorMode, onColorModeChange, onSignOut, onRename, profileHref,
}: AccountMenuProps) {
  const [open, setOpen] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState(name ?? "");
  const [renaming, setRenaming] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // Close on outside click + Escape — standard popover plumbing.
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

  const initial = (name ?? email).trim().charAt(0).toUpperCase() || "?";
  const displayName = name?.trim() || email;

  function startNameEdit(): void {
    setNameDraft(name ?? "");
    setRenameError(null);
    setEditingName(true);
  }

  async function saveName(): Promise<void> {
    if (!onRename) return;
    setRenaming(true);
    setRenameError(null);
    try {
      await onRename(nameDraft.trim() || null);
      setEditingName(false);
    } catch (e) {
      setRenameError(e instanceof Error ? e.message : "rename_failed");
    } finally {
      setRenaming(false);
    }
  }

  return (
    <div ref={rootRef} style={{ position: "relative", display: "inline-block" }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Account menu for ${displayName}`}
        title={displayName}
        style={{
          appearance: "none",
          width: 32, height: 32,
          padding: 0,
          display: "inline-flex", alignItems: "center", justifyContent: "center",
          borderRadius: "50%",
          border: `1px solid ${open
            ? "var(--borderColor-default, var(--uncon-border, #d0d7de))"
            : "var(--borderColor-muted, var(--uncon-border-muted, #e5e7eb))"}`,
          background: "var(--bgColor-muted, var(--uncon-bg-subtle, rgba(0,0,0,0.05)))",
          color: "var(--fgColor-default, var(--uncon-fg, inherit))",
          fontFamily: "inherit", fontWeight: 600, fontSize: 13,
          cursor: "pointer",
          transition: "border-color 120ms, background 120ms",
        }}
      >
        {initial}
      </button>

      {open && (
        <div
          role="menu"
          style={{
            position: "absolute",
            top: "calc(100% + 6px)",
            right: 0,
            minWidth: 240,
            padding: 4,
            borderRadius: 10,
            border: "1px solid var(--borderColor-default, var(--uncon-border, #d0d7de))",
            background: "var(--bgColor-default, var(--uncon-bg, #fff))",
            boxShadow: "0 8px 24px rgba(0, 0, 0, 0.18)",
            zIndex: 100,
          }}
        >
          {/* identity block */}
          <div style={{ padding: "8px 12px 10px" }}>
            {editingName && onRename ? (
              <form
                onSubmit={(e) => { e.preventDefault(); void saveName(); }}
                style={{ display: "flex", flexDirection: "column", gap: 6 }}
              >
                <input
                  type="text"
                  value={nameDraft}
                  maxLength={80}
                  autoFocus
                  disabled={renaming}
                  onChange={(e) => setNameDraft(e.target.value)}
                  aria-label="Display name"
                  placeholder="Display name"
                  style={{
                    width: "100%",
                    padding: "6px 10px",
                    borderRadius: 6,
                    border: renameError
                      ? "1px solid var(--borderColor-danger-emphasis, #cf222e)"
                      : "1px solid var(--borderColor-default, var(--uncon-border, #d0d7de))",
                    background: "var(--bgColor-default, var(--uncon-bg, #fff))",
                    color: "var(--fgColor-default, var(--uncon-fg, inherit))",
                    fontFamily: "inherit",
                    fontSize: 13,
                    outline: "none",
                  }}
                />
                {renameError && (
                  <div style={{
                    fontSize: 12,
                    color: "var(--fgColor-danger, #cf222e)",
                  }}>
                    {renameError}
                  </div>
                )}
                <div style={{ display: "flex", gap: 6 }}>
                  <button
                    type="submit"
                    disabled={renaming || nameDraft.trim() === (name ?? "")}
                    style={{
                      appearance: "none",
                      padding: "5px 12px",
                      borderRadius: 6,
                      border: "1px solid var(--borderColor-default, var(--uncon-border, #d0d7de))",
                      background: "var(--bgColor-default, var(--uncon-bg, #fff))",
                      color: "var(--fgColor-default, var(--uncon-fg, inherit))",
                      fontFamily: "inherit", fontSize: 12, fontWeight: 600,
                      cursor: "pointer",
                    }}
                  >
                    {renaming ? "Saving…" : "Save"}
                  </button>
                  <button
                    type="button"
                    onClick={() => setEditingName(false)}
                    disabled={renaming}
                    style={{
                      appearance: "none",
                      padding: "5px 12px",
                      borderRadius: 6,
                      border: "none",
                      background: "transparent",
                      color: "var(--fgColor-muted, var(--uncon-fg-muted, #6e7781))",
                      fontFamily: "inherit", fontSize: 12, fontWeight: 600,
                      cursor: "pointer",
                    }}
                  >
                    Cancel
                  </button>
                </div>
              </form>
            ) : (
              <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{
                    fontSize: 13, fontWeight: 600, lineHeight: "18px",
                    whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                  }}>
                    {displayName}
                  </div>
                  {name && (
                    <div style={{
                      fontSize: 12, lineHeight: "16px",
                      color: "var(--fgColor-muted, var(--uncon-fg-muted, #6e7781))",
                      whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                    }}>
                      {email}
                    </div>
                  )}
                </div>
                {onRename && (
                  <button
                    type="button"
                    onClick={startNameEdit}
                    aria-label="Edit display name"
                    title="Edit display name"
                    style={{
                      appearance: "none",
                      flexShrink: 0,
                      width: 24, height: 24,
                      display: "inline-flex", alignItems: "center", justifyContent: "center",
                      padding: 0,
                      borderRadius: 6,
                      border: "none",
                      background: "transparent",
                      color: "var(--fgColor-muted, var(--uncon-fg-muted, #6e7781))",
                      cursor: "pointer",
                      fontSize: 13,
                    }}
                  >
                    ✎
                  </button>
                )}
              </div>
            )}
          </div>

          <Divider />

          {profileHref && (
            <>
              <div style={{ padding: 4 }}>
                <MenuItem href={profileHref} onClick={() => setOpen(false)}>
                  My profile
                </MenuItem>
              </div>
              <Divider />
            </>
          )}

          {/* theme picker — segmented control style, full-width inside the menu */}
          <div style={{ padding: "8px 12px" }}>
            <div style={{
              fontSize: 11, fontWeight: 600, letterSpacing: 0.4, textTransform: "uppercase",
              color: "var(--fgColor-muted, var(--uncon-fg-muted, #6e7781))",
              marginBottom: 6,
            }}>
              Theme
            </div>
            <div style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr 1fr",
              gap: 4,
              padding: 3,
              borderRadius: 8,
              background: "var(--bgColor-muted, var(--uncon-bg-subtle, rgba(0,0,0,0.05)))",
            }}>
              <ThemePill label="Auto"  active={colorMode === "auto"}  onClick={() => onColorModeChange("auto")} />
              <ThemePill label="Light" active={colorMode === "light"} onClick={() => onColorModeChange("light")} />
              <ThemePill label="Dark"  active={colorMode === "dark"}  onClick={() => onColorModeChange("dark")} />
            </div>
          </div>

          <Divider />

          <div style={{ padding: 4 }}>
            <MenuItem
              destructive
              onClick={async () => { setOpen(false); await onSignOut(); }}
            >
              Sign out
            </MenuItem>
          </div>
        </div>
      )}

    </div>
  );
}

function Divider() {
  return (
    <div
      role="separator"
      style={{
        height: 1, margin: "2px 0",
        background: "var(--borderColor-muted, var(--uncon-border-muted, #e5e7eb))",
      }}
    />
  );
}

function ThemePill({
  label, active, onClick,
}: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      style={{
        appearance: "none",
        padding: "5px 10px",
        borderRadius: 6,
        border: "none",
        background: active
          ? "var(--bgColor-default, var(--uncon-bg, #fff))"
          : "transparent",
        color: active
          ? "var(--fgColor-default, var(--uncon-fg, inherit))"
          : "var(--fgColor-muted, var(--uncon-fg-muted, #6e7781))",
        fontFamily: "inherit", fontSize: 12, fontWeight: 600,
        cursor: "pointer",
        boxShadow: active ? "0 1px 2px rgba(0,0,0,0.10)" : "none",
        transition: "background 120ms, color 120ms",
      }}
    >
      {label}
    </button>
  );
}

function MenuItem({
  children, onClick, destructive, href,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  destructive?: boolean;
  /** When set, the item renders as a real anchor so middle-click /
   *  open-in-new-tab work; useNavLink still routes plain left-clicks
   *  through the client-side router. */
  href?: string;
}) {
  const navLink = useNavLink();
  const link = href ? navLink(href) : null;
  const style: React.CSSProperties = {
    appearance: "none",
    display: "block", width: "100%",
    textAlign: "left",
    padding: "8px 12px",
    borderRadius: 6, border: "none",
    background: "transparent",
    color: destructive
      ? "var(--fgColor-danger, #cf222e)"
      : "var(--fgColor-default, var(--uncon-fg, inherit))",
    fontFamily: "inherit", fontSize: 13, fontWeight: 500,
    cursor: "pointer",
    textDecoration: "none",
    transition: "background 120ms",
  };
  const hoverHandlers = {
    onMouseEnter: (e: React.MouseEvent<HTMLElement>) => {
      e.currentTarget.style.background = destructive
        ? "var(--bgColor-danger-muted, rgba(207, 34, 46, 0.12))"
        : "var(--bgColor-muted, var(--uncon-bg-subtle, rgba(0,0,0,0.05)))";
    },
    onMouseLeave: (e: React.MouseEvent<HTMLElement>) => {
      e.currentTarget.style.background = "transparent";
    },
  };
  if (link) {
    return (
      <a
        role="menuitem"
        href={link.href}
        onClick={(e) => { link.onClick(e); onClick?.(); }}
        style={style}
        {...hoverHandlers}
      >
        {children}
      </a>
    );
  }
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      style={style}
      {...hoverHandlers}
    >
      {children}
    </button>
  );
}
