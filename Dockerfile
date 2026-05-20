# syntax=docker/dockerfile:1.7

FROM oven/bun:1-alpine AS base
WORKDIR /app

# Full install (incl. devDeps) so Vite + plugins are available for the
# frontend build.
FROM base AS build
COPY package.json bun.lock prisma.config.ts ./
COPY prisma ./prisma
RUN bun install --frozen-lockfile
RUN bunx prisma generate
COPY . .
RUN bun run build

# Production-only install. Prisma is a runtime dep (we invoke
# `prisma migrate deploy` on container boot), so it's included here;
# dev-only tooling (vite, @types/*, changesets) is not.
FROM base AS deps-prod
COPY package.json bun.lock prisma.config.ts ./
COPY prisma ./prisma
RUN bun install --frozen-lockfile --production
RUN bunx prisma generate

# Runtime image: prod node_modules + built dist + server source + Prisma
# schema/migrations. No build tools, no @types, no changesets.
FROM base AS runner
ENV NODE_ENV=production
ENV PORT=3000
ENV DATABASE_URL="file:/app/data/prod.sqlite"

COPY --from=deps-prod /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/src ./src
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/prisma.config.ts /app/package.json /app/tsconfig.json /app/bun.lock ./

RUN mkdir -p /app/data
VOLUME ["/app/data"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/api/health" || exit 1

CMD ["sh", "-c", "bunx prisma migrate deploy && exec bun src/server/index.ts"]
