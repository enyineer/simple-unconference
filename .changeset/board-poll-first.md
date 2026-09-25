---
"simple-unconference": patch
---

The Live Board now starts in polling mode immediately (snapshot refetch every 5s) instead of waiting on SSE. The SSE stream opens in parallel as a probe and only takes over once its first heartbeat proves the response body actually streams — on networks where a proxy accepts the connection but black-holes it, the wall now updates from the first seconds instead of sitting on "Connecting" for 45s. The header indicator shows amber "Polling" until the stream is promoted to live.
