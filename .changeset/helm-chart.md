---
"simple-unconference": minor
---

Helm chart + GHCR publish workflow

- New `charts/simple-unconference` Helm chart supporting both sqlite (with a PVC for persistence) and postgres backends. The chart wires `DATABASE_URL` from a managed Secret; postgres mode can also reference an `existingSecret`.
- Sensible defaults: `Recreate` rollout strategy (required for the RWO PVC under sqlite), `/api/health` probes, non-root securityContext, optional Ingress.
- `Release` workflow now packages the chart and pushes it to `oci://ghcr.io/<owner>/charts` after each app release, with `chart.version` and `chart.appVersion` auto-synced to `package.json` so every release ships a matching chart.
- New `Helm CI` workflow lints and renders the chart on PRs, and fails the PR if `charts/` was modified without a changeset, so chart changes can't ship without a version bump.
