import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  // Relative asset URLs keep the production build loadable from file:// in
  // the packaged Electron shell (loadFile), not just from the dev server.
  base: "./",
  plugins: [react()],
  server: {
    proxy: {
      // The web client calls relative /api paths; in dev they are forwarded
      // to the local Fastify service so no CORS setup is needed.
      "/api": {
        target: process.env.VITE_API_PROXY_TARGET ?? "http://127.0.0.1:3001",
        changeOrigin: true,
      },
    },
  },
});
