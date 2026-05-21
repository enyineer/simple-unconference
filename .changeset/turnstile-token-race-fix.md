---
"simple-unconference": patch
---

Fix Turnstile race where the form rejected a verified widget with "Please complete the verification challenge before continuing."

The previous flow stored the token in React state via the widget's `callback`, then read that state at submit time. If the user clicked the submit button between Cloudflare painting the green checkmark and the callback landing in React state, the submit handler saw an empty token and short-circuited with the captcha error.

`TurnstileWidget` is now a `forwardRef` exposing a `TurnstileWidgetHandle` with `getResponse()` (delegates to `window.turnstile.getResponse(widgetId)`) and `reset()`. `Login.tsx` and `Join.tsx` read the token straight from the widget at submit time instead of from React state, and call `reset()` on error to mint a fresh single-use token for the retry.