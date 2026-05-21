---
"simple-unconference": minor
---

Prometheus-compatible `/api/metrics` endpoint + larger default PVC.

- **`GET /api/metrics`** exposes instance-wide gauges: row counts (`users_total`, `conferences_total`, `conference_identities_total`, `submissions_total` plus `submissions_by_status_total{status="…"}`, `stars_total`, `notifications_total`, `rooms_total`, `invites_total`/`invites_unclaimed_total`, `experts_total`, `expert_bookings_total`), storage (`storage_pvc_total_bytes`, `_free_bytes`, `_used_bytes` from `statfs`, plus `storage_db_file_bytes` from the SQLite file), and runtime (`app_uptime_seconds`, `app_worker_id`). Cheap to scrape — Prisma counts + one `statfs` call, computed on demand. Mounted before the oRPC catch-all so it owns `/api/metrics` and never reaches the RPC handler.
- **`METRICS_TOKEN` env var** (chart: `metrics.token`) optionally gates the endpoint with `Authorization: Bearer <token>`. Unset = open, for in-cluster scrape via the Service.
- **ServiceMonitor template** rendered when `metrics.serviceMonitor.enabled: true` for prometheus-operator users. Auto-emits a matching `Secret` carrying the token and references it via `spec.endpoints[].authorization` so no manual wiring is needed.
- **Smart `DATA_DIR` resolution** for local dev: falls back through `/app/data` → `./data` → CWD when not explicitly set, and logs a one-time `[metrics] data dir resolved to …` line at startup so the zeros in `storage_*` gauges never mystify someone running `bun dev`. `statfs` failures also warn once instead of silently zeroing.
- **PVC default bumped 2Gi → 5Gi** in the chart. Per the row-size math in `docs/loadtest-results.md`, 5Gi gives a public instance ~150 fully-saturated 2000-attendee events of headroom; the previous 2Gi was reasonable but tight for hosted use.
- **README**: new "Metrics" section with the full table of gauges and a manual scrape-config example for non-operator setups.
- **Tests**: 4 new cases cover open access, missing Bearer (401), wrong token (401), and valid token (200) plus the Prometheus exposition-format shape. Full suite 259/259.
