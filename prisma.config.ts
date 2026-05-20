// Prisma 7 config. The datasource URL no longer lives in schema.prisma.
// `bunx prisma migrate dev` / `db push` read connection info from here.

import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "./prisma/schema.prisma",
  migrations: { path: "./prisma/migrations" },
  datasource: {
    url: process.env.DATABASE_URL ?? "file:./data/dev.sqlite",
  },
});
