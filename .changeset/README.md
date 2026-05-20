# Changesets

Hi! This folder holds the [changesets](https://github.com/changesets/changesets) used to drive versioning + the GitHub release pipeline for `simple-unconference`.

## Workflow

1. While working on a PR, run `bun run changeset` and describe the user-visible change. A markdown file appears in this folder — commit it with the PR.
2. When the PR merges to `main`, the `Release` workflow opens (or updates) a `Version Packages` PR that consumes pending changesets, bumps `package.json`, and rewrites `CHANGELOG.md`.
3. Merging that PR tags the new version (`v<x.y.z>`) and triggers a Docker image build that is pushed to `ghcr.io/enyineer/simple-unconference`.

## Picking a bump type

- `patch` — bug fixes, docs, internal refactors that do not change the user-facing API or migration shape.
- `minor` — new features, additive schema migrations.
- `major` — breaking changes (config / deployment / DB) that need release notes.

You can omit the changeset for repo-only changes (CI tweaks, README typos) — none of those should ship a new image.
