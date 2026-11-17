import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Port + API proxy target are env-overridable so the same client can serve both the
// live dev instance (defaults: 5173 -> :4000) and the isolated QA instance
// (CLIENT_PORT=5174, API_PROXY_TARGET=http://localhost:4001). Defaults are unchanged.
const port = Number(process.env.CLIENT_PORT || 5173);
const apiTarget = process.env.API_PROXY_TARGET || "http://localhost:4000";

export default defineConfig({
  plugins: [react()],
  server: {
    port,
    proxy: {
      "/api": apiTarget,
    },
  },
});
