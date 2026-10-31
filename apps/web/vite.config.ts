import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev/preview-only proxy to the local Luxora API. Production builds are static
// assets and are unaffected; the browser then talks to the API origin directly.
const apiProxy = {
  "/v1": { target: "http://127.0.0.1:2222", changeOrigin: false },
  "/v2": { target: "http://127.0.0.1:2222", ws: true, changeOrigin: false },
  "/health": { target: "http://127.0.0.1:2222", changeOrigin: false },
};

export default defineConfig({
  plugins: [react()],
  server: {
    host: "0.0.0.0",
    port: 4173,
    proxy: apiProxy,
    // Atomic-write tooling (and OneDrive sync) creates short-lived *.tmpdir
    // folders under src/. Watching those locks the FS on Windows and crashes
    // the dev server with EBUSY, so they are explicitly ignored.
    watch: {
      ignored: ["**/*.tmpdir/**", "**/*.tmp", "**/*.tmpdir"],
    },
  },
  preview: {
    host: "0.0.0.0",
    port: 4173,
    proxy: apiProxy,
  },
});
