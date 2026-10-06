import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import type { Plugin } from "vite";
import { defineConfig } from "vitest/config";

/**
 * KaTeX's stylesheet (ui/MathView.tsx, loaded only for a body with math) lists each font as woff2, woff and ttf; every
 * browser the app runs in reads woff2, so the others are left out of the build (about 40 files fewer).
 */
function katexWoff2Only(): Plugin {
  return {
    name: "katex-woff2-only",
    enforce: "pre",
    transform(code, id) {
      if (!/katex(\.min)?\.css$/.test(id.split("?")[0] ?? "")) return null;
      return { code: code.replace(/,\s*url\([^)]*\.woff\) format\("woff"\)|,\s*url\([^)]*\.ttf\) format\("truetype"\)/g, ""), map: null };
    },
  };
}

export default defineConfig({
  plugins: [katexWoff2Only(), react(), tailwindcss()],
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
