# Load test results

A reference sweep of the [`bun run loadtest:sweep`](../scripts/loadtest-sweep.ts) runner against a freshly built container image, to give a feel for how `workers.count` and `resources.limits` interact for this app. **Treat these numbers as shape, not absolutes.**

> [!IMPORTANT]
> These results are **not representative of production**. They were collected on a developer laptop running Docker Desktop's Linux VM on top of macOS, with no persistent volume, no ingress controller in the path, and the test client on the same host as the server (zero network latency). Your numbers will be different — sometimes by 5x, sometimes by 0.5x — depending on:
> - The node's actual CPU model and clock speed
> - Whether you're CPU-pinned vs. sharing with other workloads on the node
> - Storage class for the SQLite PVC (`local-path` on SSD vs. networked PV)
> - Ingress and TLS termination overhead (Traefik + Let's Encrypt added ~5–15ms in real K3s tests)
> - Whether the client lives on the same host (these results) or hits the app over the cluster network (production)
>
> Use this table to understand **which config shape gets you which class of throughput**. To get your actual numbers, run the sweep against your own infrastructure: `bun run loadtest:sweep` — that's the value of the tool.

## Setup

| | |
| --- | --- |
| **Date** | 2026-05-21 |
| **App** | `simple-unconference` @ commit `1997e14` (multi-worker + sweep tooling) |
| **Host** | Apple M2 Max · macOS 26.3.1 · Darwin 25.3.0 arm64 |
| **Docker** | Engine 29.2.1 · Desktop VM 6.12.72-linuxkit · 12 vCPUs / 8 GiB allocated |
| **Image** | `simple-unconference:loadtest` built locally |
| **Tool** | `bun run loadtest:sweep -- --duration 20s --users 50` |
| **Load shape** | 50 concurrent VUs, 20s each, weighted read mix (notifications.list 36%, submissions.list 28%, conferences.get 18%, agenda.get 11%, auth.me 7%) |
| **DB** | Ephemeral SQLite (`/app/data/prod.sqlite`) inside each container, no persistent volume — fresh state per config |

## Results

`*` marks the highest-throughput configuration not classified as overloaded.

| Config | Workers | CPU | Memory | Throughput | P50 | P95 | P99 | Errors | State | Est. active users |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1w / 0.5c / 512Mi (chart default) | 1 | 0.5 | 512Mi | 301 req/s | 114ms | 380ms | 607ms | 0.0% | STRESSED | ~601 |
| 1w / 1.0c / 512Mi | 1 | 1.0 | 512Mi | 1111 req/s | 38ms | 83ms | 108ms | 0.0% | HEALTHY | ~2223 |
| 2w / 1.0c / 1Gi | 2 | 1.0 | 1Gi | 481 req/s | 95ms | 206ms | 300ms | 0.0% | STRESSED | ~962 |
| 2w / 2.0c / 1Gi | 2 | 2.0 | 1Gi | 1637 req/s | 22ms | 67ms | 85ms | 0.0% | HEALTHY | ~3274 |
| 4w / 2.0c / 1Gi | 4 | 2.0 | 1Gi | 1012 req/s | 19ms | 100ms | 184ms | 0.0% | STRESSED | ~2023 |
| **\* 4w / 4.0c / 2Gi** | 4 | 4.0 | 2Gi | **2995 req/s** | 13ms | 44ms | 69ms | 0.0% | HEALTHY | ~5991 |

Verdict thresholds: HEALTHY = P95 < 100ms and errors < 1%. STRESSED = P95 100–500ms. OVERLOADED = P95 > 500ms or errors > 1%. Estimated active users assumes ~0.5 req/s per attendee (`NotificationBell` polls every 30s + light interactive traffic).

## What the shape tells you

These three takeaways generalize beyond this one machine.

1. **Workers without proportional CPU make things worse, not better.** `2w/1c` (481 r/s) is significantly worse than `1w/1c` (1111 r/s). `4w/2c` (1012 r/s) is worse than `2w/2c` (1637 r/s). When workers compete for the same CPU budget, you pay for the context-switching and lose the parallelism. Rule of thumb: each worker beyond the first wants its own core.

2. **CPU dominates memory for this workload.** Going from 512Mi to 1Gi on the same CPU made no measurable difference; going from 0.5c to 1c on the same memory **tripled** throughput. Bun's per-process memory baseline is small (~100Mi) and SQLite's WAL cache fits comfortably in the OS page cache at any of these limits. Don't waste memory upgrades trying to fix what's actually a CPU shortage.

3. **Scaling is roughly linear when you match workers to cores.** `1w/1c` → 1111 r/s. `2w/2c` → 1637 r/s (1.5×). `4w/4c` → 2995 r/s (2.7×). The diminishing return past 2 workers is partly SQLite write-lock contention and partly real bookkeeping overhead. For most events `2w/2c` or `4w/4c` is the sweet spot.

## Mapping back to chart values

The configurations above translate directly to Helm values:

```yaml
# "1w / 1c / 512Mi" — comfortable for events up to a few hundred attendees
workers:
  count: "1"
resources:
  limits:   { cpu: 1000m, memory: 512Mi }
  requests: { cpu: 200m,  memory: 256Mi }

# "2w / 2c / 1Gi" — typical mid-size unconference
workers:
  count: "auto"     # auto-resolves to 2 with these limits
resources:
  limits:   { cpu: 2000m, memory: 1Gi }
  requests: { cpu: 400m,  memory: 384Mi }

# "4w / 4c / 2Gi" — large event headroom
workers:
  count: "auto"     # auto-resolves to 4
resources:
  limits:   { cpu: 4000m, memory: 2Gi }
  requests: { cpu: 800m,  memory: 768Mi }
```

The auto-sizer for `workers.count: "auto"` follows `min(round(cores), floor(mem_MiB / 192), 8)` — see [the `WORKERS` row in the README env-var table](../README.md) for the full rule.

## Reproducing

```bash
# from the repo root, with Docker running:
bun run loadtest:sweep -- --duration 20s --users 50
```

To sweep different configs (e.g. testing a Postgres-backed install once that path is supported, or other custom resource shapes):

```bash
bun run loadtest:sweep -- --configs "2@1/512m 2@2/1g 4@4/2g 8@8/4g"
```

For a single-config deep dive against an already-running instance (local or remote):

```bash
bun run loadtest -- --base http://localhost:3000 --users 200 --duration 60s
```

The single-shot variant prints a per-endpoint latency breakdown that the sweep summary omits.
