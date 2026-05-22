---
"simple-unconference": patch
---

Mobile layout polish, safe-area handling, and consistent muted-text sizing.

- **Settings page on mobile.** Settings cards now collapse to a single column under 640px (description above the controls) so inputs aren't crushed by the 280px description column on a narrow viewport.
- **Sheets on mobile.** Sheets switch from full-height right-drawer to a content-sized bottom sheet (max-height 92dvh, rounded top corners) on `max-width: 640px`, eliminating the empty void below short forms that the user could scroll into. Header and body honor `env(safe-area-inset-*)` for left/right/bottom insets.
- **Safe-area / gray bar.** Added `viewport-fit=cover` and painted `<html>`/`<body>` with the theme background in both design-system plugins, so the strip under the Android URL bar / iOS gesture area picks up the theme color instead of showing a default gray bar. `PageLayout` padding also picks up the safe-area insets.
- **"Open in calendar app" on Firefox Android.** Now renders as a real `<a href="webcal://…">` instead of `window.location.assign(...)`, which Firefox Android silently drops for unknown schemes. A real link click dispatches to the OS intent resolver so an installed calendar app can claim it.
- **Stacked checkbox layout.** Session-edit checkboxes (`Mark as finished`, `Allow placement in overlapping slots`) and the agenda-track `Required for all participants` checkbox now put the muted description on its own line below the bold label, instead of trailing it inline (where it crowded into a tiny column and wrapped awkwardly on narrow viewports).
- **Consistent muted text size.** `<Text muted>` in both design-system plugins now renders at the hint size (12px / 16px line-height) instead of inheriting Primer's body default. Brings the 25 callsites (loading states, empty states, field-level explanations) in line with the inline `fontSize: 12` hints used throughout forms.
