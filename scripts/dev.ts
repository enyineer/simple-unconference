// Boots the Hono API on port 3000 (with --hot) AND the Vite dev server on
// port 5173 in parallel. Open http://localhost:5173 in the browser; Vite
// proxies /api/* to the Bun API.
//
// Also watches the generated Prisma client and full-restarts the API when it
// changes. Bun's `--hot` deliberately ignores node_modules (would reload-storm
// on installs), so a `prisma generate` / `prisma migrate dev` run wouldn't
// otherwise be picked up — the server would keep using the stale client and
// strip newly-added fields from responses.

import { spawn, type Subprocess } from "bun";
import { watch } from "node:fs";

const apiArgs = ["bun", "--hot", "src/server/index.ts"];
const apiEnv = {
  ...process.env,
  SERVE_STATIC: "0",
  // Default the metrics server on in dev so /metrics is reachable at
  // http://localhost:9090/metrics without extra env wiring. Respect an
  // explicit override if the developer set one.
  METRICS_PORT: process.env.METRICS_PORT ?? "9090",
};

let api: Subprocess = spawn(apiArgs, {
  stdio: ["inherit", "inherit", "inherit"],
  env: apiEnv,
});
const vite = spawn(["bunx", "vite"], {
  stdio: ["inherit", "inherit", "inherit"],
});

// Restart the API on:
//   1. Prisma client regeneration. We watch the package's `index.js` because
//      Prisma rewrites it on every generate.
//   2. Changes under src/server/rpc/** or src/shared/contract*.
//      bun --hot reloads file bodies in place, but the oRPC router is built
//      once at import time via `implement(contract)` and each
//      `requireConf(...).foo.list.handler(...)` call captures references to
//      the contract object then. After that, reshaping the contract or
//      adding a procedure doesn't propagate to the running router — the API
//      keeps serving the old wire shape while the SPA recompiles against the
//      new types, and you get "x.items is undefined"-style mismatches.
//      Restart is the only reliable fix.
// All watches share a single debounced timer so a multi-file edit only
// restarts once.
let shuttingDown = false;
let restartTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleApiRestart(reason: string) {
  if (shuttingDown) return;
  if (restartTimer) clearTimeout(restartTimer);
  restartTimer = setTimeout(async () => {
    console.log(`[dev] ${reason} — restarting API`);
    api.kill("SIGTERM");
    await api.exited;
    api = spawn(apiArgs, {
      stdio: ["inherit", "inherit", "inherit"],
      env: apiEnv,
    });
  }, 300);
}

const PRISMA_CLIENT = "node_modules/@prisma/client/index.js";
try {
  watch(PRISMA_CLIENT, () => scheduleApiRestart("Prisma client changed"));
} catch (e) {
  console.warn(`[dev] could not watch ${PRISMA_CLIENT}:`, e);
}

// Contract / router surface watcher. `recursive: true` follows nested files
// in src/server/rpc/**. The shared contract sits in src/shared/contract.ts +
// src/shared/contract/types.ts; watching the parent src/shared (recursive)
// catches both without false positives — only contract-adjacent code lives
// directly under there. We filter on filename inside the callback so edits
// to unrelated shared modules (schemas, tz, etc) don't trigger a restart.
const ROUTER_DIR = "src/server/rpc";
const SHARED_DIR = "src/shared";
const SHARED_FILE = /^contract(\.ts|\/.*)$/;
try {
  watch(ROUTER_DIR, { recursive: true }, (_event, filename) => {
    if (!filename || !filename.endsWith(".ts")) return;
    scheduleApiRestart(`router file changed (${filename})`);
  });
  watch(SHARED_DIR, { recursive: true }, (_event, filename) => {
    if (!filename) return;
    if (!SHARED_FILE.test(filename)) return;
    scheduleApiRestart(`contract file changed (${filename})`);
  });
} catch (e) {
  console.warn(`[dev] could not watch router/contract sources:`, e);
}

function shutdown() {
  shuttingDown = true;
  if (restartTimer) clearTimeout(restartTimer);
  api.kill("SIGTERM");
  vite.kill("SIGTERM");
  setTimeout(() => process.exit(0), 200);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// `api` is reassigned on Prisma regen, so we can't bind to a single
// `api.exited`. Poll the current handle instead.
(async () => {
  while (!shuttingDown) {
    await api.exited;
    if (!shuttingDown) await Bun.sleep(50);
  }
})();
await vite.exited;
shutdown();
