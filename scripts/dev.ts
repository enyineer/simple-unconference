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
const apiEnv = { ...process.env, SERVE_STATIC: "0" };

let api: Subprocess = spawn(apiArgs, {
  stdio: ["inherit", "inherit", "inherit"],
  env: apiEnv,
});
const vite = spawn(["bunx", "vite"], {
  stdio: ["inherit", "inherit", "inherit"],
});

// Restart the API on Prisma client regeneration. We watch the package's
// `index.js` because Prisma rewrites it on every generate; debounce so a
// generate that touches several files only triggers one restart.
let shuttingDown = false;
let restartTimer: ReturnType<typeof setTimeout> | null = null;
const PRISMA_CLIENT = "node_modules/@prisma/client/index.js";
try {
  watch(PRISMA_CLIENT, () => {
    if (shuttingDown) return;
    if (restartTimer) clearTimeout(restartTimer);
    restartTimer = setTimeout(async () => {
      console.log("[dev] Prisma client changed — restarting API");
      api.kill("SIGTERM");
      await api.exited;
      api = spawn(apiArgs, {
        stdio: ["inherit", "inherit", "inherit"],
        env: apiEnv,
      });
    }, 300);
  });
} catch (e) {
  console.warn(`[dev] could not watch ${PRISMA_CLIENT}:`, e);
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
