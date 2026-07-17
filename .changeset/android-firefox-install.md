---
"simple-unconference": patch
---

Fixed the per-conference install affordance on Android, where neither the header install button nor the one-time nudge appeared:

- **Capture `beforeinstallprompt` early.** Chrome fires it once, shortly after load - often before React mounted and the hook could attach its listener, so the event (and the native install button) was lost. An inline script in `index.html` now stashes it immediately and the hook seeds from it.
- **Android fallback affordance.** When no native prompt is available (Chrome's is heuristic; Firefox and other Android browsers never fire it), the button and nudge now show "install from your browser menu" steps instead of nothing. Previously Android fell through to no affordance at all.
- **Conference name in the document title.** While inside a conference the tab title is now the conference name, which is also what Firefox Android puts on an "Add to Home screen" shortcut (Firefox uses the title, not the manifest name, so it previously showed the generic site title).
