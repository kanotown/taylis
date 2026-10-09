/**
 * M153a (WIKI.md §30.3): the second build target — the 見たまま page editor alone, for the phones' WebView.
 *
 *   npm run build:mobile-editor     → apps/shared/mobile-editor/dist: index.html, editor.js, editor.css, fonts/ (KaTeX)
 *   npm run preview:mobile-editor   → http://127.0.0.1:1422/?dev=1 (the dev harness stands in for native)
 *
 * One classic script (no module, no preload: a WKURLSchemeHandler / WebViewAssetLoader and file:// all take it), one
 * stylesheet, relative paths, a CSP that lets the page talk to no one (connect-src 'none'). KaTeX is in the script
 * and its fonts (woff2 only) beside it. The i18n dictionaries are cut down to the keys the bundled modules name
 * (prunedDictionaries: 3,200 texts × 3 languages would be most of the bundle).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

import { katexWoff2Only } from "./vite.config.ts";

/** The URL scheme the iOS app serves the bundle and its pictures from (WKURLSchemeHandler); Android serves https://appassets.androidplatform.net, which is 'self'. */
const IOS_SCHEME = "taylis-editor:";

const CSP = [
  "default-src 'none'",
  `script-src 'self' ${IOS_SCHEME}`,
  `style-src 'self' ${IOS_SCHEME} 'unsafe-inline'`,
  `img-src 'self' ${IOS_SCHEME} data:`,
  `font-src 'self' ${IOS_SCHEME}`,
  "connect-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

/** The built page: a classic script tag (Vite writes a module one), the CSP (not in the source: the dev server needs its inline scripts). */
function classicPage(): Plugin {
  return {
    name: "taylis-classic-page",
    apply: "build",
    transformIndexHtml: {
      order: "post",
      handler: (html) =>
        html
          .replace(/<script type="module" crossorigin src="([^"]+)"><\/script>/, '<script defer src="$1"></script>')
          .replace(/<link rel="stylesheet" crossorigin href=/g, '<link rel="stylesheet" href=')
          .replace("<meta charset=\"UTF-8\" />", `<meta charset="UTF-8" />\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`),
    },
  };
}

/** A dotted string literal: an i18n key where it is one. */
const KEY_LITERAL = /"([A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z0-9_]+)+)"/g;

/**
 * src/i18n/{ja,en,zhHans}.ts hold every text of the app. In this bundle each becomes the entries whose keys appear as
 * string literals in the modules of the chunk (the editor names its keys literally: `t("docs.wysiwyg.raw")`,
 * `label: "docs.slash.h1"`). Unknown keys fall back to the key itself (i18n/index.ts), which never happens for a key
 * the editor names.
 */
function prunedDictionaries(): Plugin {
  const dictionaries = new Map<string, string>();
  return {
    name: "taylis-pruned-dictionaries",
    apply: "build",
    transform(_code, id) {
      const match = /\/src\/i18n\/(ja|en|zhHans)\.ts$/.exec(id);
      if (!match) return null;
      dictionaries.set(id, match[1]!);
      return { code: `export const ${match[1]} = __TAYLIS_DICT_${match[1]}__;\n`, map: null };
    },
    renderChunk(code, chunk) {
      if (!code.includes("__TAYLIS_DICT_")) return null;
      const used = new Set<string>();
      for (const id of chunk.moduleIds) {
        if (id.includes("/node_modules/") || dictionaries.has(id) || !/\.(ts|tsx)$/.test(id)) continue;
        for (const found of readFileSync(id, "utf8").matchAll(KEY_LITERAL)) used.add(found[1]!);
      }
      let out = code;
      for (const [id, name] of dictionaries) {
        const source = readFileSync(id, "utf8");
        const start = source.indexOf("= {") + 2;
        const end = source.lastIndexOf("}") + 1;
        const all = new Function(`return ${source.slice(start, end)}`)() as Record<string, string>;
        const kept = Object.fromEntries(Object.entries(all).filter(([key]) => used.has(key)));
        out = out.replace(`__TAYLIS_DICT_${name}__`, JSON.stringify(kept));
      }
      return { code: out, map: null };
    },
  };
}

export default defineConfig({
  root: resolve(import.meta.dirname, "mobile-editor"),
  base: "./",
  plugins: [katexWoff2Only(), react(), tailwindcss(), prunedDictionaries(), classicPage()],
  clearScreen: false,
  server: { port: 1422, strictPort: true },
  preview: { port: 1422, strictPort: true },
  build: {
    outDir: resolve(import.meta.dirname, "../shared/mobile-editor/dist"),
    emptyOutDir: true,
    target: "es2022",
    // One script: no preload helper (its import.meta has no meaning in a classic script) and no polyfill.
    modulePreload: false,
    cssCodeSplit: false,
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 2000,
    rollupOptions: {
      output: {
        // One classic script: the IIFE format inlines the dynamic imports (KaTeX). The build still names Vite's preload
        // helper's `import.meta` once (EMPTY_IMPORT_META); the output holds none (it is replaced by `{}`, and the helper
        // has no dependencies to preload).
        format: "iife",
        entryFileNames: "editor.js",
        assetFileNames: (asset) => ((asset.names?.[0] ?? asset.name ?? "").endsWith(".css") ? "editor.css" : "fonts/[name][extname]"),
      },
    },
  },
});
