import { defineConfig } from "vite";

// Served by services/inbox-relay from the site root.
export default defineConfig({
  base: "/",
  clearScreen: false,
  build: { target: "es2022", sourcemap: false },
  server: {
    strictPort: true,
    proxy: { "/v1": "http://127.0.0.1:8114", "/api": "http://127.0.0.1:8114" },
  },
});
