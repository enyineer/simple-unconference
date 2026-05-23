---
"simple-unconference": minor
---

Ship a starter Grafana dashboard with the Helm chart, auto-imported via the standard Grafana dashboards-sidecar pattern.

**Why**

kube-prometheus-stack's bundled dashboards cover the cluster but know nothing about this app's metric names. Operators were left to either query in Explore or build a dashboard from scratch — and rebuild it whenever the app's metric taxonomy changes. Shipping the dashboard from the chart keeps it in lockstep with the metric definitions in [src/server/metrics/aggregate.ts](src/server/metrics/aggregate.ts) and survives Grafana PVC loss.

**What changed**

- New file `dashboards/simple-unconference.json` — 11 panels in 4 rows:
  - **Health**: fresh workers, stale workers, global-metrics-stale indicator, uptime.
  - **Realtime**: SSE active connections (total + per worker), bus events published rate by kind.
  - **Storage**: data volume % used gauge, SQLite file size over time, submissions by status donut.
  - **Content & Chat**: users, conferences, identities, chat messages, open chat reports, expert bookings.
- New template `templates/dashboard.yaml` wrapping the JSON in a ConfigMap labeled `grafana_dashboard: "1"` so kube-prometheus-stack's Grafana sidecar imports it automatically.
- New `metrics.dashboard.*` values:
  - `enabled` (default `false`) toggle.
  - `namespace` override for when the sidecar is namespace-scoped to Grafana's namespace.
  - `label` / `labelValue` / `extraLabels` for non-default sidecar configurations.
  - `folder` to land the dashboard in a specific Grafana folder.
- Dashboard uses a `${datasource}` variable rather than hard-coding the Prometheus datasource, so it works under any Grafana install that has at least one Prometheus datasource registered.
