# simple-unconference

## 0.2.1

### Patch Changes

- [`785ecd0`](https://github.com/enyineer/simple-unconference/commit/785ecd0b0442eeaf73825a496fafce83e421fbad) Thanks [@enyineer](https://github.com/enyineer)! - Prune the production Docker image: install only `dependencies` (no `vite`, `@types/*`, or changesets tooling) in the runtime stage. `prisma` is now a regular dependency so `prisma migrate deploy` still runs at boot.

## 0.2.0

### Minor Changes

- [`8974c61`](https://github.com/enyineer/simple-unconference/commit/8974c61d42406048feb6504d304e37df24868030) Thanks [@enyineer](https://github.com/enyineer)! - Initial release. Adds a multi-stage Bun Dockerfile, GitHub Actions release pipeline that publishes images to `ghcr.io/enyineer/simple-unconference`, and a changesets-driven versioning workflow.
