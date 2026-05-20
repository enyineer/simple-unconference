# syntax=docker/dockerfile:1.7

FROM oven/bun:1-alpine AS base
WORKDIR /app

# Install all dependencies (incl. dev — Prisma CLI is invoked at container
# startup to apply migrations against the mounted SQLite volume).
FROM base AS deps
COPY package.json bun.lock prisma.config.ts ./
COPY prisma ./prisma
RUN bun install --frozen-lockfile
RUN bunx prisma generate

# Build the Vite frontend.
FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN bun run build

# Runtime image: Bun + the built dist/ + source for the API server.
FROM base AS runner
ENV NODE_ENV=production
ENV PORT=3000
ENV DATABASE_URL="file:/app/data/prod.sqlite"

COPY --from=deps /app/node_modules ./node_modules
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
