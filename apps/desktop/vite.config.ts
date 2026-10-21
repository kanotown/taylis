import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import type { Plugin } from "vite";
import { defineConfig } from "vitest/config";

/**
 * KaTeX's stylesheet (ui/MathView.tsx, loaded only for a body with math) lists each font as woff2, woff and ttf; every
 * browser the app runs in reads woff2, so the others are left out of the build (about 40 files fewer).
 */
export function katexWoff2Only(): Plugin {
  return {
    name: "katex-woff2-only",
    enforce: "pre",
    transform(code, id) {
      if (!/katex(\.min)?\.css$/.test(id.split("?")[0] ?? "")) return null;
      return { code: code.replace(/,\s*url\([^)]*\.woff\) format\("woff"\)|,\s*url\([^)]*\.ttf\) format\("truetype"\)/g, ""), map: null };
    },
  };
}

/** `/s/<token>` (and `/s/<token>/`, a query) is a share link's page. */
export const SHARE_PATH = /^\/s\/[^/?#]+\/?(\?.*)?$/;

/**
 * M163 (docs/DRIVE.md §9.3): `/s/<token>`, a drive share link's public page, is the bundle's second entry (share.html).
 * Caddy serves it for `/s/*` in production; this does the same for `vite` and `vite preview`.
 */
export function sharePage(): Plugin {
  const rewrite = (req: { url?: string }, _res: unknown, next: () => void) => {
    if (req.url && SHARE_PATH.test(req.url)) req.url = "/share.html";
    next();
  };
  return {
    name: "share-page",
    configureServer(server) {
      server.middlewares.use(rewrite);
    },
    configurePreviewServer(server) {
      server.middlewares.use(rewrite);
    },
  };
}

export default defineConfig({
  plugins: [katexWoff2Only(), sharePage(), react(), tailwindcss()],
  clearScreen: false,
  // In a browser the app talks to its own origin (M12j); in development that is this server, which
  // forwards the API (and the WebSocket) to the backend. Tauri dev uses the URL typed at login.
  server: {
    port: 1420,
    strictPort: true,
    proxy: { "/api": { target: process.env.CHIKUWA_API ?? "http://127.0.0.1:8000", ws: true } },
  },
  build: {
    target: "es2022",
    // The app, and the share links' public page (no session, no sync: an entry of its own).
    rollupOptions: { input: { main: "index.html", share: "share.html" } },
  },
  test: { environment: "node", include: ["tests/**/*.test.{ts,tsx}"], setupFiles: ["tests/setup.ts"] },
});
