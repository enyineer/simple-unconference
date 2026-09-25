---
"simple-unconference": patch
---

Keep the Live Board updating when the network kills SSE. The board stream now sends an observable `ping` heartbeat event, and the page watches it: a silently stalled or blocked stream (corporate proxies black-holing long-lived responses) demotes to polling mode — snapshot refetch every 10s — while a background probe keeps retrying SSE and flips back to live automatically. The header indicator shows amber "Polling" so the room knows the wall is no longer streaming.
