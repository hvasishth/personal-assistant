import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The dev server proxies API calls to the Express server (port 8787) so the
// browser talks to a single origin — no CORS setup needed during development.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:8787",
      "/auth": "http://localhost:8787",
    },
  },
});
