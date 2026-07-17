// Session takeaways (Harvest & Wrap-up, F3). One shared panel used both in
// the session detail (SessionCard, collapsed by default) and the Me tab's
// post-event recap — so the list/add/delete UI and its lazy-load behavior
// can't drift between the two surfaces.

import { useState } from "react";
import { Button, Stack, TextInput } from "../../design-system";
import { useToast } from "../../design-system/hooks";
import { api, errorCode } from "../../api";
import type { TakeawayOut } from "../../../shared/contract";
import { fmtDayShort } from "../helpers";
import { Disclosure } from "./Disclosure";

export function TakeawaysPanel({
  slug, submissionId, isMod, timeZone,
}: {
  slug: string;
  submissionId: number;
  isMod: boolean;
  timeZone: string;
}) {
  const toast = useToast();
  // null = never loaded yet. Loading happens on first Disclosure expand, not
  // on mount — a session list can render many of these panels at once and
  // most never get opened.
  const [items, setItems] = useState<TakeawayOut[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [text, setText] = useState("");
  const [linkOpen, setLinkOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [adding, setAdding] = useState(false);

  async function load() {
    if (items !== null || loading) return;
    setLoading(true);
    try {
      setItems(await api.takeaways.list({ slug, submission_id: submissionId }));
    } catch (e) {
      toast.error(errorCode(e));
      setItems([]);
    } finally {
      setLoading(false);
    }
  }

  async function add() {
    const trimmed = text.trim();
    if (!trimmed || adding) return;
    setAdding(true);
    try {
      const created = await api.takeaways.add({
        slug,
        submission_id: submissionId,
        text: trimmed,
        url: linkOpen && url.trim() ? url.trim() : null,
      });
      setItems((prev) => [created, ...(prev ?? [])]);
      setText("");
      setUrl("");
      setLinkOpen(false);
    } catch (e) {
      toast.error(errorCode(e));
    } finally {
      setAdding(false);
    }
  }

  async function remove(id: number) {
    if (!confirm("Delete this takeaway?")) return;
    try {
      await api.takeaways.remove({ slug, id });
      setItems((prev) => (prev ?? []).filter((t) => t.id !== id));
    } catch (e) {
      toast.error(errorCode(e));
    }
  }

  const muted = "var(--fgColor-muted, var(--uncon-fg-muted, #6e7781))";
  const count = items?.length ?? null;

  return (
    <Disclosure
      summary={count === null ? "Takeaways" : `Takeaways (${count})`}
      onToggle={(open) => { if (open) void load(); }}
    >
      <Stack gap="condensed">
        {loading && (
          <span style={{ fontSize: 13, color: muted }}>Loading…</span>
        )}

        {!loading && items !== null && items.length === 0 && (
          <span style={{ fontSize: 13, color: muted }}>
            No takeaways yet. Be the first to share one.
          </span>
        )}

        {!loading && items !== null && items.length > 0 && (
          <Stack gap="condensed">
            {items.map((t) => (
              <div
                key={t.id}
                style={{
                  display: "flex",
                  gap: 8,
                  alignItems: "flex-start",
                  padding: "8px 10px",
                  borderRadius: 8,
                  background: "var(--bgColor-muted, var(--uncon-bg-subtle, rgba(0,0,0,0.025)))",
                }}
              >
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontSize: 12, color: muted }}>
                    <strong>{t.author_name ?? "Someone"}</strong>
                    {" · "}
                    {fmtDayShort(t.created_at, timeZone)}
                  </div>
                  <div style={{ fontSize: 14, lineHeight: "20px", wordBreak: "break-word" }}>
                    {t.text}
                  </div>
                  {t.url && (
                    <a
                      href={t.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{
                        fontSize: 12,
                        color: "var(--fgColor-accent, #2563eb)",
                        wordBreak: "break-all",
                      }}
                    >
                      {t.url}
                    </a>
                  )}
                </div>
                {(t.mine || isMod) && (
                  <Button size="small" variant="invisible" onClick={() => remove(t.id)}>
                    Delete
                  </Button>
                )}
              </div>
            ))}
          </Stack>
        )}

        <Stack gap="condensed">
          <TextInput
            placeholder="Share a takeaway from this session…"
            value={text}
            onChange={(e) => setText(e.target.value)}
            block
          />
          {linkOpen && (
            <TextInput
              type="url"
              placeholder="https://…"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              block
            />
          )}
          <Stack direction="row" gap="condensed" align="center" wrap>
            {!linkOpen && (
              <Button size="small" variant="invisible" onClick={() => setLinkOpen(true)}>
                + link
              </Button>
            )}
            <Button
              size="small"
              variant="primary"
              onClick={() => void add()}
              disabled={adding || text.trim().length === 0}
            >
              Add
            </Button>
          </Stack>
        </Stack>
      </Stack>
    </Disclosure>
  );
}
