import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

// Vite is the frontend bundler. The Bun process runs the Hono API on
// port 3000; Vite's dev server runs on port 5173 and proxies /api/* to Hono.
// In production, `bun run build` outputs to /dist and Bun.serve serves it.
export default defineConfig({
  root: "src/web",
  // `public/` (relative to root, i.e. src/web/public) holds the service
  // worker, PWA manifest, and icons — anything that must land at a fixed
  // top-level URL in dist/ untouched by the bundler.
  publicDir: "public",
  build: {
    outDir: fileURLToPath(new URL("./dist", import.meta.url)),
    emptyOutDir: true,
    sourcemap: true,
    target: "es2022",
    rollupOptions: {
      // Encourage clean chunk names; Rollup's content-hash makes them unique.
      output: {
        chunkFileNames: "assets/[name]-[hash].js",
        entryFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash].[ext]",
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      // Regex anchored to "/api/" so it only proxies actual API routes —
      // NOT the source file at /api.ts (the path-prefix string form would
      // match both, leaving Vite unable to serve the module).
      "^/api/.*": {
        target: "http://localhost:3000",
        changeOrigin: false,
      },
    },
  },
  plugins: [react()],
});
