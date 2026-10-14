// Screenshots of the browser client for the documentation site (website/docs/assets/screens/web-*.webp), and the
// README's docs/images/desktop.png.
//
// Run against a LOCAL throwaway server that holds only the demo workspace (never a real one):
//   1. an empty database + `python -m app.cli seed-demo` (infra/demo/README.md), then
//      `node scripts/docs-shots-setup.mjs` for the Docs pages, the attendance board, the action buttons and the
//      workflows (run it again right before the shots: it refreshes everyone's attendance state);
//   2. `CHIKUWA_API=http://127.0.0.1:<port> npx vite --port 1422 --strictPort` in apps/desktop;
//   3. APP_PASS=<review's password> [ADMIN_PASS=<tanaka's password>] [README_PASS=<yamamoto's password>]
//      node scripts/docs-shots.mjs [outDir]
//
//   APP_URL   the Vite dev server (default http://localhost:1422/)
//   APP_USER  the account the shots are taken as (default review, the demo's ordinary member)
//   ADMIN_USER / ADMIN_PASS  optional: also the admin screens, as that account (default user tanaka)
//   README_USER / README_PASS  optional: also docs/images/desktop.png (1600×1000 PNG), as that account (default yamamoto)
//   CDP_PORT  headless Chrome's DevTools port (default 9444)
//   ONLY      comma-separated shot names to take (default: all)
//
// Online dots and 取り込み中 come from the server: keep a few demo members connected (a WebSocket each, `ping` with
// active: true) while the shots are taken if the pictures should show them; the script itself only logs in as APP_USER.
// web-presence wants all three kinds of dot in the thread of #研究ミーティング: tanaka and takahashi connected, watanabe in
// 取り込み中 (as watanabe, PUT /users/me/presence {"status": "dnd", "duration": "4h"}) and yamamoto offline (so take the
// app's shots before README_USER, yamamoto, logs in; the script does).
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
const README_IMAGE = new URL("../../../docs/images/desktop.png", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const APP_URL = process.env.APP_URL ?? "http://localhost:1422/";
const PORT = Number(process.env.CDP_PORT ?? 9444);
const ONLY = process.env.ONLY ? new Set(process.env.ONLY.split(",")) : null;
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const WIDE = { width: 1280, height: 760, scale: 2 };
const NORMAL = { width: 1080, height: 680, scale: 2.4 };
const TALL = { width: 1080, height: 860, scale: 2.4 };
const TALLER = { width: 1080, height: 960, scale: 2.4 };
const README = { width: 1600, height: 1000, scale: 1 };
const SIDEBAR = "nav[aria-label='チャンネルとDM']";
const RAIL = "nav[aria-label='場所']";

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
const mouse = async (x, y, click = true, button = "left") => {
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  if (!click) return;
  for (const type of ["mousePressed", "mouseReleased"]) await send("Input.dispatchMouseEvent", { type, x, y, button, clickCount: 1 });
};
/** Closes whatever is open (menus, dialogs, the viewer) and moves the pointer out of the way. */
const settle = async () => {
  await key("Escape");
  await key("Escape");
  await mouse(1, 400, false);
};

/** Clicks (with the mouse) the visible control whose label or text is `label`, else starts with it, else contains it. */
async function click(label, { nth = 0, within = "body", wait = 900, button = "left" } = {}) {
  const at = await run(`(() => {
    const want = ${JSON.stringify(label)};
    const text = (e) => (e.getAttribute("aria-label") || e.textContent || "").trim();
    const rank = (e) => (text(e) === want ? 0 : text(e).startsWith(want) ? 1 : 2);
    const root = document.querySelector(${JSON.stringify(within)});
    if (!root) return null;
    const found = [...root.querySelectorAll("button, a, [role=button], [role=tab], [role=menuitem], [role=menuitemradio], [role=menuitemcheckbox], [role=option], [role=treeitem]")]
      .filter((e) => text(e).includes(want) && e.getClientRects().length)
      .sort((a, b) => rank(a) - rank(b));
    const el = found[${nth}];
    if (!el) return null;
    el.scrollIntoView({ block: "nearest" });
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  if (!at) throw new Error(`no control "${label}"`);
  await mouse(at.x, at.y, true, button);
  await sleep(wait);
}

/** Opens a place (アクティビティ, カレンダー…): its icon in the rail, its sidebar row, or 「その他」 in the rail. */
async function place(label, wait = 1800) {
  await settle();
  const where = await run(`(() => {
    const has = (sel) => [...(document.querySelector(sel)?.querySelectorAll("button, a") ?? [])].some((b) => (b.getAttribute("aria-label") || b.textContent || "").trim().startsWith(${JSON.stringify(label)}));
    return has(${JSON.stringify(RAIL)}) ? ${JSON.stringify(RAIL)} : has(${JSON.stringify(SIDEBAR)}) ? ${JSON.stringify(SIDEBAR)} : null;
  })()`);
  if (where) return click(label, { within: where, wait });
  await click("その他", { within: RAIL, wait: 600 });
  await click(label, { within: "[role=menu]", wait });
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

/** The smallest rectangle holding every element matching the selectors, plus `pad`, inside the window. */
async function around(selectors, pad = 16) {
  return run(`(() => {
    const rs = ${JSON.stringify(selectors)}.flatMap((s) => [...document.querySelectorAll(s)]).map((e) => e.getBoundingClientRect()).filter((r) => r.width && r.height);
    if (!rs.length) return null;
    const x = Math.max(0, Math.min(...rs.map((r) => r.left)) - ${pad}), y = Math.max(0, Math.min(...rs.map((r) => r.top)) - ${pad});
    const right = Math.min(innerWidth, Math.max(...rs.map((r) => r.right)) + ${pad}), bottom = Math.min(innerHeight, Math.max(...rs.map((r) => r.bottom)) + ${pad});
    return { x, y, width: right - x, height: bottom - y };
  })()`);
}

/** The message (article) in the open conversation whose text includes `text`, scrolled into the middle. */
async function message(text) {
  return run(`(() => {
    const a = [...document.querySelectorAll("main article")].reverse().find((a) => a.textContent.includes(${JSON.stringify(text)}));
    if (!a) return null;
    a.scrollIntoView({ block: "center" });
    const r = a.getBoundingClientRect();
    return { x: r.left, y: r.top, width: r.width, height: r.height };
  })()`);
}

async function viewport(v) {
  await send("Emulation.setDeviceMetricsOverride", { width: v.width, height: v.height, deviceScaleFactor: v.scale, mobile: false });
  await sleep(400);
}

const sizes = [];
async function shot(name, clip = null, { png = null } = {}) {
  const params = { format: "png" };
  if (clip) params.clip = { ...clip, scale: 1 };
  const data = Buffer.from((await send("Page.captureScreenshot", params)).data, "base64");
  if (png) {
    writeFileSync(png, data);
    console.log("shot", png);
    return;
  }
  const pngPath = join(OUT, `${name}.png`);
  writeFileSync(pngPath, data);
  const webp = join(OUT, `${name}.webp`);
  const conv = spawnSync("cwebp", ["-quiet", "-q", "82", "-m", "6", pngPath, "-o", webp]);
  if (conv.status === 0) rmSync(pngPath);
  console.log("shot", conv.status === 0 ? webp : pngPath);
  sizes.push(name);
}

/**
 * The topmost dialog alone, with transparent corners (2026-10-13): everything else is hidden and the page's background is
 * transparent while it is taken, so the rounded corners and the shadow are not cut out of the dark overlay. A dialog
 * opened from another one is the last [role=dialog] (the first is the one under it).
 */
async function dialogShot(name, pad = 16) {
  const clip = await run(`(() => {
    const all = [...document.querySelectorAll("[role=dialog]")];
    const el = all[all.length - 1];
    if (!el) return null;
    el.setAttribute("data-shot-dialog", "");
    const style = document.createElement("style");
    style.id = "shot-dialog-style";
    style.textContent = "html, body { background: transparent !important; } * { visibility: hidden !important; } [data-shot-dialog], [data-shot-dialog] * { visibility: visible !important; }";
    document.head.append(style);
    const r = el.getBoundingClientRect();
    const x = Math.max(0, r.left - ${pad}), y = Math.max(0, r.top - ${pad});
    return { x, y, width: Math.min(innerWidth - x, r.width + 2 * ${pad}), height: Math.min(innerHeight - y, r.height + 2 * ${pad}) };
  })()`);
  await send("Emulation.setDefaultBackgroundColorOverride", { color: { r: 0, g: 0, b: 0, a: 0 } });
  await sleep(200);
  try {
    await shot(name, clip);
  } finally {
    await send("Emulation.setDefaultBackgroundColorOverride", {});
    await run(`(() => { document.getElementById("shot-dialog-style")?.remove(); document.querySelector("[data-shot-dialog]")?.removeAttribute("data-shot-dialog"); return true; })()`);
  }
}

async function openDoc(title) {
  await place("ドキュメント", 800);
  await waitFor(`[...document.querySelectorAll("main [role=treeitem] button")].some((b) => b.textContent.includes(${JSON.stringify(title)}))`);
  await run(`([...document.querySelectorAll("main [role=treeitem] button")].find((b) => b.textContent.includes(${JSON.stringify(title)})).click(), true)`);
  await sleep(1500);
}

async function openChannel(name) {
  await settle();
  await click(name, { within: SIDEBAR, wait: 1500 });
}

async function openThread(channel, replies) {
  await openChannel(channel);
  await run(`(() => { const b = [...document.querySelectorAll("main button")].find((b) => b.textContent.includes(${JSON.stringify(replies)})); b.scrollIntoView({ block: "center" }); return true; })()`);
  await click(replies, { within: "main", wait: 1800 });
  // The thread's root message whole, at the top of the conversation.
  await run(`(() => { const b = [...document.querySelectorAll("main button")].find((b) => b.textContent.includes(${JSON.stringify(replies)})); b.closest("article")?.scrollIntoView({ block: "start" }); return true; })()`);
  await sleep(600);
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
  await waitFor(`document.querySelector(${JSON.stringify(SIDEBAR)}) !== null`, 30000);
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
/** A shot; `as` is "app" (APP_USER, the default), "admin" (ADMIN_USER) or "readme" (README_USER). */
const def = (name, fn, as = "app") => shots.push({ name, fn, as });

def("web-login", async () => {
  await viewport(NORMAL);
  await send("Page.navigate", { url: APP_URL });
  await waitFor(`document.querySelector("form input[type=password]") !== null`);
  await sleep(800);
  await shot("web-login", await rectOf("form", "div.rounded-2xl, div[class*=rounded]", 24));
});

// Activity and threads first, before the shots below open (and so read) the conversations.
def("web-activity", async () => {
  await viewport(NORMAL);
  await place("アクティビティ");
  await shot("web-activity", await rectOf("main"));
});

def("web-threads", async () => {
  await viewport(NORMAL);
  await place("スレッド");
  await shot("web-threads", await rectOf("main"));
});

// ---- the screen as a whole ----------------------------------------------------------------------------------------

def("web-overview", async () => {
  await viewport(WIDE);
  await openThread("研究ミーティング", "5 件の返信");
  await run(`(document.querySelectorAll(${JSON.stringify(SIDEBAR)} + " *").forEach((e) => { if (e.scrollTop) e.scrollTop = 0; }), true)`);
  await mouse(5, 5, false);
  await sleep(400);
  await shot("web-overview");
});

/** The rail and the sidebar, with the name of a rail icon in its tooltip. */
def("web-rail", async () => {
  await viewport(NORMAL);
  await openChannel("研究ミーティング");
  const icon = await rectOf(`${RAIL} [aria-label^='カレンダー']`);
  await mouse(icon.x + icon.width / 2, icon.y + icon.height / 2, false);
  await sleep(1200);
  const side = await rectOf(SIDEBAR);
  await shot("web-rail", { x: 0, y: 0, width: side.x + side.width + 1, height: 680 });
  await mouse(600, 400, false);
});

/** 「項目の配置」 under the rail: where each place stands (icon rail / sidebar / hidden). */
def("web-rail-placement", async () => {
  await viewport(TALLER);
  await openChannel("研究ミーティング");
  await click("項目の配置", { within: RAIL, wait: 600 });
  await click("カレンダー", { within: "[role=menu]", wait: 700 });
  const box = await around(["[data-radix-popper-content-wrapper]"], 12);
  await shot("web-rail-placement", { x: 0, y: box.y, width: box.x + box.width, height: box.height });
  await settle();
});

/** Browser-like tabs: three conversations open, one of them unread. */
def("web-tabs", async () => {
  await viewport(NORMAL);
  await openChannel("研究ミーティング");
  for (const name of ["学会準備", "鈴木 花子"]) {
    await click(name, { within: SIDEBAR, button: "right", wait: 600 });
    await click("新しいタブで開く", { within: "[role=menu]", wait: 900 });
  }
  await click("研究ミーティング", { within: "[role=tablist]", wait: 1200 });
  await run(`(document.querySelectorAll(${JSON.stringify(SIDEBAR)} + " *").forEach((e) => { if (e.scrollTop) e.scrollTop = 0; }), true)`);
  await click("雑談", { within: SIDEBAR, button: "right", wait: 700 });
  await shot("web-tabs");
  await settle();
  // Back to one tab for the shots after this one.
  for (let i = 0; i < 3; i++) {
    const closed = await run(`(() => { const x = [...document.querySelectorAll("[role=tablist] [aria-label*='閉じる']")].pop(); if (!x) return false; x.click(); return true; })()`);
    if (!closed) break;
    await sleep(500);
  }
});

/** My status menu: オンライン / 離席中 / 取り込み中 / オフライン表示, the status, attendance. */
def("web-status-menu", async () => {
  await viewport(NORMAL);
  await openChannel("研究ミーティング");
  await click("自分のステータスを変える", { within: SIDEBAR, wait: 800 });
  await click("取り込み中", { within: "[role=menu]", wait: 800 });
  await shot("web-status-menu", await around(["[role=menu]", `${SIDEBAR} [aria-label^='自分のステータスを変える']`], 12));
  await settle();
});

// ---- messages -----------------------------------------------------------------------------------------------------

def("web-messages", async () => {
  await viewport(NORMAL);
  await openChannel("研究ミーティング");
  await click("最新のメッセージへ", { within: "main", wait: 1200 }).catch(() => {});
  const row = await message("実験用の GPU");
  if (row) await mouse(row.x + 420, row.y + 20, false);
  await sleep(500);
  await shot("web-messages", await rectOf("main"));
});

/** A message's ⋯ menu. */
def("web-message-menu", async () => {
  await viewport(NORMAL);
  await openChannel("研究ミーティング");
  const row = await message("実験用の GPU");
  await mouse(row.x + 420, row.y + 20, false);
  await sleep(500);
  const more = await run(`(() => { const a = [...document.querySelectorAll("main article")].reverse().find((a) => a.textContent.includes("実験用の GPU")); const b = [...a.querySelectorAll("button[aria-label='その他']")].pop(); const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  await mouse(more.x, more.y);
  await sleep(800);
  const main = await rectOf("main");
  await shot("web-message-menu", main);
  await settle();
});

/** The composer's ＋ menu. */
def("web-composer-menu", async () => {
  await viewport(NORMAL);
  await openChannel("研究ミーティング");
  await click("ファイルを添付・その他", { within: "main", wait: 700 });
  const main = await rectOf("main");
  const menu = await rectOf("[role=menu]");
  const y = Math.max(main.y, menu.y - 24);
  await shot("web-composer-menu", { x: main.x, y, width: main.width, height: 680 - y });
  await settle();
});

/** A post that asks for acknowledgement (sent with the workflow 「ゼミの案内」). */
def("web-ack", async () => {
  await viewport(NORMAL);
  await openChannel("研究ミーティング");
  const r = await message("次の研究ミーティングの案内");
  if (!r) throw new Error("no acknowledgement post (run docs-shots-setup.mjs)");
  await mouse(1, 400, false);
  await sleep(500);
  const again = await message("次の研究ミーティングの案内");
  await shot("web-ack", { x: again.x, y: again.y - 8, width: again.width, height: again.height + 16 });
});

/** Dragging a file over the conversation. */
def("web-drop", async () => {
  await viewport(NORMAL);
  await openChannel("研究ミーティング");
  await run(`(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(["x"], "results.csv", { type: "text/csv" }));
    const el = document.querySelector("main article") ?? document.querySelector("main");
    const r = el.getBoundingClientRect();
    for (const t of ["dragenter", "dragover"]) el.dispatchEvent(new DragEvent(t, { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.left + 200, clientY: r.top + 20 }));
    return true;
  })()`);
  await sleep(500);
  await shot("web-drop", await rectOf("main"));
  await sleep(1500);
});

/**
 * The document viewer on a PDF: a modal over the dimmed app (2026-10-14), the page zoomed out a step so it sits in the
 * middle of the card.
 */
def("web-pdf-viewer", async () => {
  await viewport(NORMAL);
  await openChannel("学会準備");
  await click("proceedings-draft-nakamura.pdf のプレビューを開く", { within: "main", wait: 2500 });
  await click("縮小", { wait: 600 });
  await click("縮小", { wait: 1200 });
  await mouse(1, 400, false);
  await shot("web-pdf-viewer");
  await settle();
});

/**
 * The senders' presence dots (2026-10-13): online green, 取り込み中 red (keep watanabe in 取り込み中 for it), offline a
 * hollow grey ring. The replies of the thread in #研究ミーティング (tanaka, takahashi, watanabe and yamamoto).
 */
def("web-presence", async () => {
  await viewport(TALL);
  await openThread("研究ミーティング", "5 件の返信");
  await mouse(5, 5, false);
  await sleep(600);
  // The thread panel's replies: the articles right of the conversation, without the root message.
  const r = await run(`(() => {
    const main = document.querySelector("main").getBoundingClientRect();
    const replies = [...document.querySelectorAll("article")].filter((a) => !a.textContent.includes("今週の進捗です")).map((a) => a.getBoundingClientRect()).filter((r) => r.left >= main.right - 1 && r.height);
    const top = Math.min(...replies.map((r) => r.top)) - 6, bottom = Math.max(...replies.map((r) => r.bottom)) + 6;
    return { x: replies[0].left, y: top, width: replies[0].width, height: bottom - top };
  })()`);
  await shot("web-presence", r);
  await settle();
});

/** A table pasted from a spreadsheet, as it reads once sent (the post comes from docs-shots-setup.mjs). */
def("web-table", async () => {
  await viewport(NORMAL);
  await openChannel("学会準備");
  await click("最新のメッセージへ", { within: "main", wait: 1200 }).catch(() => {});
  const r = await message("発表練習の割り当て");
  if (!r) throw new Error("no table post (run docs-shots-setup.mjs)");
  await mouse(1, 400, false);
  await sleep(500);
  const again = await message("発表練習の割り当て");
  await shot("web-table", { x: again.x, y: again.y - 8, width: again.width, height: again.height + 16 });
});

def("web-thread", async () => {
  await viewport(NORMAL);
  await openThread("研究ミーティング", "5 件の返信");
  await mouse(5, 5, false);
  const main = await rectOf("main");
  await shot("web-thread", { x: main.x, y: 0, width: 1080 - main.x, height: 680 });
  await settle();
});

/** The reaction picker. */
def("web-emoji-picker", async () => {
  await viewport(NORMAL);
  await openChannel("研究ミーティング");
  const row = await message("実験用の GPU");
  await mouse(row.x + 420, row.y + 20, false);
  await sleep(500);
  const add = await run(`(() => { const a = [...document.querySelectorAll("main article")].reverse().find((a) => a.textContent.includes("実験用の GPU")); const b = [...a.querySelectorAll("button[aria-label='リアクションを追加']")].pop(); const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  await mouse(add.x, add.y);
  await sleep(1200);
  await shot("web-emoji-picker", await rectOf("main"));
  await settle();
});

// ---- search, activity, threads ----------------------------------------------------------------------------------

def("web-search", async () => {
  await viewport(NORMAL);
  await settle();
  await click("を検索", { wait: 400 });
  await send("Input.insertText", { text: "GPU" });
  await key("Enter");
  await sleep(1800);
  await shot("web-search", await rectOf("main"));
  await settle();
});

/** The search box's live results while typing. */
def("web-search-live", async () => {
  await viewport(NORMAL);
  await openChannel("研究ミーティング");
  await click("を検索", { wait: 400 });
  await send("Input.insertText", { text: "GPU" });
  await sleep(1800);
  await shot("web-search-live", await around(["[role=dialog]", "[role=listbox]"], 12).then((r) => r ?? { x: 380, y: 0, width: 700, height: 380 }));
  await settle();
});

// ---- Docs, canvas, tasks, calendar, Times, reservations ---------------------------------------------------------------

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

/** 「タスク」 in the rail: my tasks across channels. */
def("web-my-tasks", async () => {
  await viewport(NORMAL);
  await place("タスク");
  await shot("web-my-tasks", await rectOf("main"));
});

def("web-calendar", async () => {
  await viewport(NORMAL);
  await place("カレンダー");
  await shot("web-calendar", await rectOf("main"));
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

def("web-times", async () => {
  await viewport(NORMAL);
  await settle();
  await click("フィード", { within: SIDEBAR, wait: 1800 });
  await shot("web-times", await rectOf("main"));
});

def("web-reservations", async () => {
  await viewport(NORMAL);
  await place("予約");
  const main = await rectOf("main");
  await shot("web-reservations", { ...main, height: 470 });
});

// ---- workflows ----------------------------------------------------------------------------------------------------

/** ＋ →「ワークフロー…」: the channel's workflows to choose from. */
def("web-workflow-list", async () => {
  await viewport(NORMAL);
  await openChannel("研究ミーティング");
  await click("ファイルを添付・その他", { within: "main", wait: 700 });
  await click("ワークフロー…", { within: "[role=menu]", wait: 900 });
  await dialogShot("web-workflow-list", 16);
  await settle();
});

/** A workflow's form, with the preview and the acknowledgement note. */
def("web-workflow-form", async () => {
  await viewport(NORMAL);
  await openChannel("研究ミーティング");
  await click("ファイルを添付・その他", { within: "main", wait: 700 });
  await click("ワークフロー…", { within: "[role=menu]", wait: 900 });
  await click("ゼミの案内", { within: "[role=dialog]", wait: 1000 });
  // The focus off the first field (its selection would show): a click on the dialog's description.
  const text = await rectOf("[role=dialog] p");
  if (text) await mouse(text.x + 4, text.y + text.height / 2);
  await sleep(300);
  await dialogShot("web-workflow-form", 16);
  await settle();
});

// ---- attendance -------------------------------------------------------------------------------------------------

def("web-attendance", async () => {
  await viewport(TALL);
  await place("在室状況");
  await shot("web-attendance", await rectOf("main"));
});

/** The header's attendance badge (「在室」) and its menu. */
def("web-attendance-menu", async () => {
  await viewport(NORMAL);
  await openChannel("研究ミーティング");
  await click("在室状況：", { wait: 800 });
  await shot("web-attendance-menu", await around(["[data-radix-popper-content-wrapper]", "button[aria-label^='在室状況：']"], 12));
  await settle();
});

// ---- settings ---------------------------------------------------------------------------------------------------

async function settings(section, wait = 800) {
  await settle();
  await click("設定", { within: SIDEBAR, wait: 1000 });
  await click(section, { within: "[role=dialog]", wait });
}

def("web-settings-notifications", async () => {
  await viewport(NORMAL);
  await settings("通知");
  await dialogShot("web-settings-notifications");
  await settle();
});

def("web-settings-quiet", async () => {
  await viewport(NORMAL);
  await settings("おやすみ時間");
  await dialogShot("web-settings-quiet");
  await settle();
});

/** 設定 → 入力 →「リアクションの候補」: six slots, custom emoji among them (docs-shots-setup.mjs chooses them). */
def("web-settings-reactions", async () => {
  await viewport(NORMAL);
  await settings("入力");
  await run(`([...document.querySelectorAll("[role=dialog] h2, [role=dialog] h3, [role=dialog] h4")].find((e) => e.textContent.includes("リアクションの候補")).scrollIntoView({ block: "start" }), true)`);
  await sleep(500);
  await dialogShot("web-settings-reactions");
  await settle();
});

def("web-settings-display", async () => {
  await viewport(NORMAL);
  await settings("表示");
  await dialogShot("web-settings-display");
  await settle();
});

/** 設定 → 表示 →「サイドバーの項目」: the icon rail switch, each place's spot and the order. */
def("web-settings-places", async () => {
  await viewport(NORMAL);
  await settings("表示");
  await run(`([...document.querySelectorAll("[role=dialog] h2, [role=dialog] h3, [role=dialog] h4")].find((e) => e.textContent.includes("サイドバーの項目")).scrollIntoView({ block: "start" }), true)`);
  await sleep(500);
  await dialogShot("web-settings-places");
  await settle();
});

def("web-dark", async () => {
  await viewport(NORMAL);
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
  await openChannel("研究ミーティング");
  await settle();
  await run(`(document.querySelectorAll(${JSON.stringify(SIDEBAR)} + " *").forEach((e) => { if (e.scrollTop) e.scrollTop = 0; }), true)`);
  await mouse(5, 5, false);
  await sleep(800);
  await shot("web-dark");
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });
});

// ---- as the admin -----------------------------------------------------------------------------------------------

def(
  "web-admin",
  async () => {
    await viewport(NORMAL);
    await settings("管理", 1500);
    await dialogShot("web-admin");
    await settle();
  },
  "admin",
);

/** The workflow editor (the channel's ⋯ →「ワークフロー…」→「管理」→「編集」), at its switches. */
def(
  "web-workflow-editor",
  async () => {
    await viewport(TALL);
    await openChannel("研究ミーティング");
    await click("チャンネルの操作", { within: "main", wait: 700 });
    await click("ワークフロー…", { within: "[role=menu]", wait: 1000 });
    await click("管理", { within: "[role=dialog]", wait: 800 });
    await click("編集", { within: "[role=dialog]", wait: 1000 });
    await run(`([...document.querySelectorAll("[role=dialog] label")].find((e) => e.textContent.includes("実行するときに確認する")).scrollIntoView({ block: "center" }), true)`);
    await sleep(400);
    await dialogShot("web-workflow-editor", 16);
    await settle();
  },
  "admin",
);

/** 管理 →「在室状況」. */
def(
  "web-admin-attendance",
  async () => {
    await viewport(TALL);
    await settings("管理", 1500);
    await click("在室状況", { within: "[role=dialog]", wait: 1200 });
    await dialogShot("web-admin-attendance");
    await settle();
  },
  "admin",
);

// ---- the README's picture ---------------------------------------------------------------------------------------

def(
  "readme-desktop",
  async () => {
    await viewport(README);
    await openThread("研究ミーティング", "5 件の返信");
    await run(`(document.querySelectorAll(${JSON.stringify(SIDEBAR)} + " *").forEach((e) => { if (e.scrollTop) e.scrollTop = 0; }), true)`);
    await mouse(5, 5, false);
    await sleep(600);
    await shot("readme-desktop", null, { png: README_IMAGE });
  },
  "readme",
);

const accounts = {
  app: [process.env.APP_USER ?? "review", process.env.APP_PASS ?? ""],
  admin: [process.env.ADMIN_USER ?? "tanaka", process.env.ADMIN_PASS],
  readme: [process.env.README_USER ?? "yamamoto", process.env.README_PASS],
};

try {
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Network.enable");
  // As if the window had the focus: the app counts me as active (オンライン, not 離席中).
  await send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });
  await viewport(NORMAL);
  const wanted = shots.filter((s) => !ONLY || ONLY.has(s.name));
  if (wanted.some((s) => s.name === "web-login")) await wanted.find((s) => s.name === "web-login").fn();
  let current = null;
  for (const as of ["app", "admin", "readme"]) {
    const group = wanted.filter((s) => s.as === as && s.name !== "web-login");
    if (!group.length) continue;
    const [user, pass] = accounts[as];
    if (!pass && as !== "app") {
      console.log(`skip ${group.map((s) => s.name).join(", ")} (no ${as.toUpperCase()}_PASS)`);
      continue;
    }
    if (current) await logout();
    await login(user, pass);
    current = as;
    for (const s of group) await s.fn();
  }
} finally {
  ws.close();
  chrome.kill();
  await sleep(300);
  rmSync(profile, { recursive: true, force: true });
}
