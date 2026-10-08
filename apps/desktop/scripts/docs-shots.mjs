// Screenshots of the browser client for the documentation site (website/docs/assets/screens/web-*.webp).
//
// Run against a LOCAL throwaway server that holds only the demo workspace (never a real one):
//   1. an empty database + `python -m app.cli seed-demo` (infra/demo/README.md), then
//      `node scripts/docs-shots-setup.mjs` for the Docs pages, the attendance board and the action buttons;
//   2. `CHIKUWA_API=http://127.0.0.1:<port> npx vite --port 1422 --strictPort` in apps/desktop;
//   3. APP_PASS=<review's password> [ADMIN_PASS=<tanaka's password>] node scripts/docs-shots.mjs [outDir]
//
//   APP_URL   the Vite dev server (default http://localhost:1422/)
//   APP_USER  the account the shots are taken as (default review, the demo's ordinary member)
//   ADMIN_USER / ADMIN_PASS  optional: also the admin screen, as that account (default user tanaka)
//   CDP_PORT  headless Chrome's DevTools port (default 9444)
//   ONLY      comma-separated shot names to take (default: all)
//
// The page is shown at 120 % (a 1080×680 CSS-pixel window, like 1296×816 at the app's 120 % text size) with 2.4 device
// pixels per CSS pixel, light theme unless the shot says dark, so the text stays readable when the image is shown at
// the documentation's content width. Shots of one area are cropped to it. With cwebp installed the PNGs become WebP
// (quality 82); otherwise they stay PNG. Requires Google Chrome in /Applications.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const OUT = resolve(process.argv[2] ?? new URL("../../../website/docs/assets/screens", import.meta.url).pathname);
mkdirSync(OUT, { recursive: true });
const APP_URL = process.env.APP_URL ?? "http://localhost:1422/";
const PORT = Number(process.env.CDP_PORT ?? 9444);
const ONLY = process.env.ONLY ? new Set(process.env.ONLY.split(",")) : null;
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const WIDE = { width: 1280, height: 760, scale: 2 };
const NORMAL = { width: 1080, height: 680, scale: 2.4 };

const profile = mkdtempSync(join(tmpdir(), "taylis-docs-shots-"));
const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, "--no-first-run", "--disable-gpu", "--hide-scrollbars", "--lang=ja-JP", "about:blank"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function pageSocket() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
      const page = list.find((t) => t.type === "page");
      if (page) return page.webSocketDebuggerUrl;
    } catch {}
    await sleep(250);
  }
  throw new Error("Chrome did not start");
}

const ws = new WebSocket(await pageSocket());
await new Promise((r) => (ws.onopen = r));
let seq = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
  }
};
const send = (method, params = {}) =>
  new Promise((ok, fail) => {
    const n = ++seq;
    pending.set(n, (m) => (m.error ? fail(new Error(`${method}: ${JSON.stringify(m.error)}`)) : ok(m.result)));
    ws.send(JSON.stringify({ id: n, method, params }));
  });
const run = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
  return r.result.value;
};
const waitFor = async (expression, timeout = 15000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await run(expression)) return;
    await sleep(200);
  }
  throw new Error(`timeout: ${expression}`);
};
const key = async (k, code = k, vk = { Escape: 27, Enter: 13 }[k] ?? 0) => {
  for (const type of ["keyDown", "keyUp"]) await send("Input.dispatchKeyEvent", { type, key: k, code, windowsVirtualKeyCode: vk });
  await sleep(250);
};
const mouse = async (x, y, click = true) => {
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  if (!click) return;
  for (const type of ["mousePressed", "mouseReleased"]) await send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
};

/** Clicks (with the mouse) the visible control whose label or text is `label`, else starts with it, else contains it. */
async function click(label, { nth = 0, within = "body", wait = 900 } = {}) {
  const at = await run(`(() => {
    const want = ${JSON.stringify(label)};
    const text = (e) => (e.getAttribute("aria-label") || e.textContent || "").trim();
    const rank = (e) => (text(e) === want ? 0 : text(e).startsWith(want) ? 1 : 2);
    const found = [...document.querySelector(${JSON.stringify(within)}).querySelectorAll("button, a, [role=button], [role=tab], [role=menuitem], [role=option]")]
      .filter((e) => text(e).includes(want) && e.getClientRects().length)
      .sort((a, b) => rank(a) - rank(b));
    const el = found[${nth}];
    if (!el) return null;
    el.scrollIntoView({ block: "center" });
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  if (!at) throw new Error(`no control "${label}"`);
  await mouse(at.x, at.y);
  await sleep(wait);
}

/** The rectangle (CSS px) of the first element matching `selector` (optionally the closest ancestor `up` of it). */
async function rectOf(selector, up = null, pad = 0) {
  return run(`(() => {
    let el = document.querySelector(${JSON.stringify(selector)});
    if (el && ${JSON.stringify(up)}) el = el.closest(${JSON.stringify(up)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.max(0, r.left - ${pad}), y: Math.max(0, r.top - ${pad}), width: Math.min(innerWidth, r.width + 2 * ${pad}), height: Math.min(innerHeight - Math.max(0, r.top - ${pad}), r.height + 2 * ${pad}) };
  })()`);
}

async function viewport(v) {
  await send("Emulation.setDeviceMetricsOverride", { width: v.width, height: v.height, deviceScaleFactor: v.scale, mobile: false });
  await sleep(400);
}

const sizes = [];
async function shot(name, clip = null) {
  const params = { format: "png" };
  if (clip) params.clip = { ...clip, scale: 1 };
  const png = Buffer.from((await send("Page.captureScreenshot", params)).data, "base64");
  const pngPath = join(OUT, `${name}.png`);
  writeFileSync(pngPath, png);
  const webp = join(OUT, `${name}.webp`);
  const conv = spawnSync("cwebp", ["-quiet", "-q", "82", "-m", "6", pngPath, "-o", webp]);
  if (conv.status === 0) rmSync(pngPath);
  console.log("shot", conv.status === 0 ? webp : pngPath);
  sizes.push(name);
}

async function openDoc(title) {
  await key("Escape");
  await click("ドキュメント", { within: "nav[aria-label='チャンネルとDM']", wait: 800 });
  await waitFor(`[...document.querySelectorAll("main [role=treeitem] button")].some((b) => b.textContent.includes(${JSON.stringify(title)}))`);
  await run(`([...document.querySelectorAll("main [role=treeitem] button")].find((b) => b.textContent.includes(${JSON.stringify(title)})).click(), true)`);
  await sleep(1500);
}

async function openChannel(name) {
  await key("Escape");
  await click(name, { within: "nav[aria-label='チャンネルとDM']", wait: 1500 });
}

async function login(user, pass) {
  await send("Page.navigate", { url: APP_URL });
  await waitFor(`document.querySelector("form input[type=password]") !== null`);
  await sleep(500);
  await run(`(() => {
    const set = (el, v) => { Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value").set.call(el, v); el.dispatchEvent(new Event("input", { bubbles: true })); };
    const inputs = [...document.querySelectorAll("form input")].filter((i) => i.type !== "hidden");
    set(inputs[inputs.length - 2], ${JSON.stringify(user)});
    set(inputs[inputs.length - 1], ${JSON.stringify(pass)});
    document.querySelector("form button[type=submit]").click();
    return true;
  })()`);
  await waitFor(`document.querySelector("nav[aria-label='チャンネルとDM']") !== null`, 30000);
  await sleep(2500);
}

async function logout() {
  await send("Network.clearBrowserCookies");
  await run(`(async () => {
    localStorage.clear();
    sessionStorage.clear();
    for (const d of (await indexedDB.databases?.()) ?? []) await new Promise((r) => { const q = indexedDB.deleteDatabase(d.name); q.onsuccess = q.onerror = q.onblocked = r; });
    return true;
  })()`);
}

const shots = [];
const def = (name, fn) => shots.push({ name, fn });

def("web-login", async () => {
  await viewport(NORMAL);
  await send("Page.navigate", { url: APP_URL });
  await waitFor(`document.querySelector("form input[type=password]") !== null`);
  await sleep(800);
  await shot("web-login", await rectOf("form", "div.rounded-2xl, div[class*=rounded]", 24));
});

def("web-overview", async () => {
  await viewport(WIDE);
  await openChannel("研究ミーティング");
  await run(`(() => { const b = [...document.querySelectorAll("main button")].find((b) => /5 件の返信/.test(b.textContent)); b.scrollIntoView({ block: "center" }); return true; })()`);
  await click("5 件の返信", { within: "main", wait: 1800 });
  await run(`(document.querySelectorAll("nav[aria-label='チャンネルとDM'] *").forEach((e) => { if (e.scrollTop) e.scrollTop = 0; }), true)`);
  await mouse(5, 5, false);
  await sleep(400);
  await shot("web-overview");
});

def("web-messages", async () => {
  await viewport(NORMAL);
  await openChannel("研究ミーティング");
  await key("Escape");
  await click("最新のメッセージへ", { within: "main", wait: 1200 }).catch(() => {});
  const row = await run(`(() => { const rows = [...document.querySelectorAll("main article")]; const r = rows.find((a) => a.textContent.includes("サーベイの進み具合")); if (!r) return null; const b = r.getBoundingClientRect(); return { x: b.left + 420, y: b.top + 20 }; })()`);
  if (row) await mouse(row.x, row.y, false);
  await sleep(500);
  await shot("web-messages", await rectOf("main"));
});

def("web-thread", async () => {
  await viewport(NORMAL);
  await openChannel("研究ミーティング");
  await run(`(() => { const b = [...document.querySelectorAll("main button")].find((b) => /5 件の返信/.test(b.textContent)); b.scrollIntoView({ block: "center" }); return true; })()`);
  await click("5 件の返信", { within: "main", wait: 1800 });
  await mouse(5, 5, false);
  const main = await rectOf("main");
  await shot("web-thread", { x: main.x, y: 0, width: 1080 - main.x, height: 680 });
  await key("Escape");
});

def("web-schedule", async () => {
  await viewport(NORMAL);
  await openChannel("研究ミーティング");
  const find = `[...document.querySelectorAll("main button")].find((b) => b.textContent.trim() === "表で見る")`;
  if (!(await run(`!!${find}`))) throw new Error("no schedule poll");
  // The poll's card: from the message's top to just below 「表で見る」.
  await run(`(${find}.closest("article").scrollIntoView({ block: "start" }), true)`);
  await sleep(800);
  const r = await run(`(() => { const b = ${find}; const a = b.closest("article").getBoundingClientRect(); const end = b.getBoundingClientRect().bottom + 16; const top = Math.max(92, a.top); return { x: a.left, y: top, width: a.width, height: Math.min(680, end) - top }; })()`);
  await shot("web-schedule", r);
});

def("web-search", async () => {
  await viewport(NORMAL);
  await key("Escape");
  await click("を検索", { wait: 400 });
  await send("Input.insertText", { text: "GPU" });
  await key("Enter");
  await sleep(1800);
  await shot("web-search", await rectOf("main"));
  await key("Escape");
});

def("web-activity", async () => {
  await viewport(NORMAL);
  await key("Escape");
  await click("アクティビティ", { within: "nav[aria-label='チャンネルとDM']", wait: 1500 });
  await shot("web-activity", await rectOf("main"));
});

def("web-docs-page", async () => {
  await viewport(NORMAL);
  await openDoc("研究室マニュアル");
  await click("閲覧", { within: "main", wait: 800 }).catch(() => {});
  await mouse(5, 5, false);
  await shot("web-docs-page", await rectOf("main"));
});

def("web-docs-editor", async () => {
  await viewport(NORMAL);
  await openDoc("研究室マニュアル");
  await click("編集", { within: "main", wait: 1500 });
  await mouse(5, 5, false);
  const main = await rectOf("main");
  await shot("web-docs-editor", { x: main.x + 264, y: main.y, width: main.width - 264, height: main.height });
  await click("閲覧", { within: "main", wait: 800 });
});

def("web-docs-database", async () => {
  await viewport(WIDE);
  await openDoc("論文リスト");
  await click("ボード", { within: "main", wait: 1500 });
  await mouse(5, 5, false);
  const main = await rectOf("main");
  await shot("web-docs-database", { x: main.x + 264, y: main.y, width: main.width - 264, height: main.height });
  await click("表", { within: "main", wait: 600 });
});

def("web-canvas", async () => {
  await viewport(NORMAL);
  await openChannel("学会準備");
  await click("キャンバス", { within: "main", wait: 2000 });
  await mouse(5, 5, false);
  await shot("web-canvas", await rectOf("main"));
  await click("メッセージ", { within: "main", wait: 600 });
});

def("web-tasks", async () => {
  await viewport(NORMAL);
  await openChannel("研究ミーティング");
  await click("タスク", { within: "main", wait: 1800 });
  await mouse(5, 5, false);
  await shot("web-tasks", await rectOf("main"));
  await click("メッセージ", { within: "main", wait: 600 });
});

def("web-calendar", async () => {
  await viewport(NORMAL);
  await key("Escape");
  await click("カレンダー", { within: "nav[aria-label='チャンネルとDM']", wait: 1800 });
  await shot("web-calendar", await rectOf("main"));
});

def("web-times", async () => {
  await viewport(NORMAL);
  await key("Escape");
  await click("フィード", { within: "nav[aria-label='チャンネルとDM']", wait: 1800 });
  await shot("web-times", await rectOf("main"));
});

def("web-reservations", async () => {
  await viewport(NORMAL);
  await click("予約", { within: "nav[aria-label='チャンネルとDM']", wait: 1800 });
  const main = await rectOf("main");
  await shot("web-reservations", { ...main, height: 470 });
});

def("web-attendance", async () => {
  await viewport(NORMAL);
  await click("在室状況", { within: "nav[aria-label='チャンネルとDM']", wait: 1800 });
  await shot("web-attendance", await rectOf("main"));
});

def("web-settings-notifications", async () => {
  await viewport(NORMAL);
  await key("Escape");
  await click("設定", { within: "nav[aria-label='チャンネルとDM']", wait: 1000 });
  await click("通知", { within: "[role=dialog]", wait: 800 });
  await shot("web-settings-notifications", await rectOf("[role=dialog]"));
  await key("Escape");
});

def("web-settings-display", async () => {
  await viewport(NORMAL);
  await key("Escape");
  await click("設定", { within: "nav[aria-label='チャンネルとDM']", wait: 1000 });
  await click("表示", { within: "[role=dialog]", wait: 800 });
  await shot("web-settings-display", await rectOf("[role=dialog]"));
  await key("Escape");
});

def("web-dark", async () => {
  await viewport(NORMAL);
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
  await openChannel("研究ミーティング");
  await key("Escape");
  await mouse(5, 5, false);
  await sleep(800);
  await shot("web-dark");
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });
});

def("web-admin", async () => {
  if (!process.env.ADMIN_PASS) return console.log("skip web-admin (no ADMIN_PASS)");
  await logout();
  await login(process.env.ADMIN_USER ?? "tanaka", process.env.ADMIN_PASS);
  await viewport(NORMAL);
  await click("設定", { within: "nav[aria-label='チャンネルとDM']", wait: 1000 });
  await click("管理", { within: "[role=dialog]", wait: 1500 });
  await shot("web-admin", await rectOf("[role=dialog]"));
  await key("Escape");
});

try {
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Network.enable");
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });
  await viewport(NORMAL);
  const wanted = shots.filter((s) => !ONLY || ONLY.has(s.name));
  if (wanted.some((s) => s.name === "web-login")) await wanted.find((s) => s.name === "web-login").fn();
  await login(process.env.APP_USER ?? "review", process.env.APP_PASS ?? "");
  for (const s of wanted) if (s.name !== "web-login") await s.fn();
} finally {
  ws.close();
  chrome.kill();
  await sleep(300);
  rmSync(profile, { recursive: true, force: true });
}
