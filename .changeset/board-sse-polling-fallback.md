---
"simple-unconference": patch
---

Keep the Live Board updating when the network kills SSE. The board stream now sends an observable `ping` heartbeat event, and the page watches it: a silently stalled or blocked stream (corporate proxies black-holing long-lived responses) demotes to polling mode — snapshot refetch every 5s — while a background probe keeps retrying SSE. Promotion back to live requires the first heartbeat over the fresh stream (`onopen` fires on headers alone, which is exactly what a black-holing proxy delivers), so polling continues until data is proven to flow. The header indicator shows amber "Polling" so the room knows the wall is no longer streaming.
