// A boolean flag persisted in localStorage that also updates REACTIVELY within
// the same tab. `localStorage` writes don't fire the `storage` event in the
// writing tab, so sibling components that read the same key wouldn't re-render
// when one of them flips it. We broadcast a custom event on set and subscribe via
// useSyncExternalStore, so e.g. dismissing the install nudge instantly reveals
// the push nudge that was deferring to it. Cross-tab `storage` events are also
// honored. Values are one-way today (set to "1"); that's all the nudges need.

import { useCallback, useSyncExternalStore } from "react";

const EVENT = "localflag-change";

// In-memory fallback so a dismissal still sticks for the session when
// localStorage is unavailable (private mode / storage disabled).
const memory = new Set<string>();

function read(key: string): boolean {
  if (memory.has(key)) return true;
  try {
    return localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

export function useLocalFlag(key: string): [boolean, () => void] {
  const subscribe = useCallback((onStoreChange: () => void) => {
    // Re-read on any flag broadcast or cross-tab storage change; the snapshot
    // comparison below means unrelated keys never cause a re-render.
    window.addEventListener(EVENT, onStoreChange);
    window.addEventListener("storage", onStoreChange);
    return () => {
      window.removeEventListener(EVENT, onStoreChange);
      window.removeEventListener("storage", onStoreChange);
    };
  }, []);

  const value = useSyncExternalStore(subscribe, () => read(key), () => false);

  const setTrue = useCallback(() => {
    memory.add(key);
    try {
      localStorage.setItem(key, "1");
    } catch {
      // Private mode / storage disabled — the in-memory set above still holds
      // for this session.
    }
    window.dispatchEvent(new Event(EVENT));
  }, [key]);

  return [value, setTrue];
}
