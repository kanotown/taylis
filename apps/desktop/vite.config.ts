import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  // In a browser the app talks to its own origin (M12j); in development that is this server, which
  // forwards the API (and the WebSocket) to the backend. Tauri dev uses the URL typed at login.
  server: {
    port: 1420,
    strictPort: true,
    proxy: { "/api": { target: process.env.CHIKUWA_API ?? "http://127.0.0.1:8000", ws: true } },
  },
  build: { target: "es2022" },
  test: { environment: "node", include: ["tests/**/*.test.{ts,tsx}"], setupFiles: ["tests/setup.ts"] },
});
