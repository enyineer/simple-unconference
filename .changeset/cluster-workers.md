---
"simple-unconference": minor
---

Add multi-worker mode for the container. New `WORKERS` env var (default `1`, byte-identical to previous behavior) spawns N Bun worker processes inside a single pod that share the listening port via `SO_REUSEPORT`. Set `WORKERS=auto` to derive the count from cgroup-reported CPU + memory limits (rule: `min(round(cores), floor(mem_MiB / 192), 8)`; cgroup v1 + v2 supported), or a specific integer to force it. Exposed in the Helm chart as `workers.count`. The launcher supervises children (restart on crash with crash-loop bailout to surface CrashLoopBackOff after 5 failures in 30s) and propagates SIGTERM/SIGINT for graceful shutdown. Each worker's stdout/stderr is piped through the launcher and prefixed with `[wN]` so interleaved log lines stay attributable.
