---
"simple-unconference": minor
---

Move Prometheus metrics from `/api/metrics` on the main app port to a dedicated `/metrics` endpoint on `METRICS_PORT` (default `9090`), and aggregate them across workers in the cluster launcher.

**Why**

With `WORKERS > 1`, every worker behind `SO_REUSEPORT` kept its own in-memory counters. Prometheus scrapes landed on whichever worker the kernel picked that round, so `realtime_sse_active_connections`, `bus_*`, etc. oscillated between workers' local snapshots — dashboards showed ~1/Nth of reality. Moving the endpoint to a launcher-owned port also lets ops keep it off the main `Service` (and Ingress) entirely.

**What changed**

- New port `METRICS_PORT` (default `9090`) served by the cluster launcher when `WORKERS > 1`, or by the app process in single-worker mode. Path is `/metrics` (no `/api/` prefix).
- Workers push per-process snapshots to the launcher over Bun IPC every 5 s. Worker 0 additionally pushes DB row counts + storage stats — single source for the global numbers, no N-way Prisma fan-out.
- Aggregation produces per-worker series with a `worker="N"` label for per-process metrics (active connections, bus counters, IPC counters) plus unlabeled global metrics for DB + storage counts. Aggregate with PromQL `sum()`.
- New observability metrics: `app_workers_total`, `app_workers_stale_total`, `app_metrics_global_stale`, `worker_uptime_seconds{worker}`. Removed `app_worker_id` (no longer meaningful at the cluster level).

**Helm chart**

- New `metrics.enabled` (default `true`) and `metrics.port` (default `9090`) values.
- New `ClusterIP` Service `<release>-simple-unconference-metrics` exposing only the metrics port. The main app Service no longer carries a metrics port.
- `ServiceMonitor` now targets the metrics Service, `port: metrics`, `path: /metrics`.

**Breaking changes**

- `/api/metrics` is removed. External scrape configs must move to the new path + port + Service.
- `app_worker_id` is removed; use `app_workers_total` for cluster size or filter per-worker series via the `worker` label.
- Per-worker metrics (`realtime_sse_*`, `bus_*`) now carry a `worker` label; dashboards that previously read the raw series will need `sum()` to recover the cluster total.
