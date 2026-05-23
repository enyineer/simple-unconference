---
"simple-unconference": minor
---

Ship a starter `PrometheusRule` with the Helm chart for instance health, storage capacity, and moderation backlog alerts.

**Why**

The chart already wires Prometheus to the dedicated metrics Service via `ServiceMonitor`, but operators were left to write their own alerting rules against series like `app_workers_stale_total` and `storage_pvc_free_bytes`. The aggregation contract for those metrics lives in the app, not the consumer — shipping the rules alongside the chart keeps them in sync as metric names evolve.

**What changed**

- New template `templates/prometheusrule.yaml`, gated by `metrics.prometheusRule.enabled` (default `false`). Requires the prometheus-operator CRDs — same prerequisite as `metrics.serviceMonitor.enabled`.
- Three rule groups:
  - **simple-unconference.health**: `SimpleUnconferenceScrapeDown`, `SimpleUnconferenceNoWorkers`, `SimpleUnconferenceWorkerStale`, `SimpleUnconferenceGlobalMetricsStale`.
  - **simple-unconference.storage**: `SimpleUnconferenceStorageLow` (<15% free), `SimpleUnconferenceStorageCritical` (<5% free).
  - **simple-unconference.moderation**: `SimpleUnconferenceChatReportsBacklog`, threshold tunable via `metrics.prometheusRule.chatReportsBacklogThreshold` (default `10`).
- All rules scope to the dedicated metrics Service with `{service="<release>-metrics"}` so multiple releases of the chart in one Prometheus stay isolated.
- Optional `metrics.prometheusRule.labels` lets operators add the discovery label their Prometheus expects (e.g. `release: kube-prometheus-stack`).
