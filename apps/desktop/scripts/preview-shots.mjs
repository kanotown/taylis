// Screenshots of the browser preview (npm run dev) via headless Chrome and the DevTools protocol.
// Usage: APP_USER=alice APP_PASS=secret node scripts/preview-shots.mjs [outDir]
//   APP_URL    dev server (default http://localhost:1420/)
//   APP_SERVER backend the login form points at (default http://127.0.0.1:8000)
// Requires Google Chrome in /Applications; writes 01-login … 06-dark PNGs.
import { spawn } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const OUT = process.argv[2] ?? "screenshots";
import { mkdirSync } from "node:fs";
mkdirSync(OUT, { recursive: true });
const URL = process.env.APP_URL ?? "http://localhost:1420/";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9333;
const profile = mkdtempSync(join(tmpdir(), "chikuwa-chrome-"));
const chrome = spawn(CHROME, [`--headless=new`, `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, "--window-size=1400,900", "--no-first-run", "--disable-gpu", "about:blank"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function target() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
      const page = list.find((t) => t.type === "page");
      if (page) return page.webSocketDebuggerUrl;
    } catch {}
    await sleep(250);
  }
  throw new Error("chrome did not start");
}

const ws = new WebSocket(await target());
await new Promise((r) => (ws.onopen = r));
let id = 0;
const pending = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (method, params = {}) => new Promise((resolve, reject) => { const n = ++id; pending.set(n, (m) => (m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result))); ws.send(JSON.stringify({ id: n, method, params })); });
const evaluate = async (expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails)); return r.result.value; };
const shot = async (name) => { const r = await send("Page.captureScreenshot", { format: "png" }); writeFileSync(join(OUT, name), Buffer.from(r.data, "base64")); console.log("shot", name); };
const waitFor = async (expr, timeout = 15000) => { const end = Date.now() + timeout; while (Date.now() < end) { if (await evaluate(expr)) return; await sleep(200); } throw new Error("timeout: " + expr); };

await send("Page.enable");
await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
await send("Page.navigate", { url: URL });
await waitFor(`document.querySelector("form input") !== null`);
await sleep(300);
await shot("01-login.png");
await evaluate(`(() => {
  const set = (el, v) => { Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value").set.call(el, v); el.dispatchEvent(new Event("input", { bubbles: true })); };
  const inputs = [...document.querySelectorAll("form input")];
  set(inputs[0], ${JSON.stringify(process.env.APP_SERVER ?? "http://127.0.0.1:8000")});
  set(inputs[1], ${JSON.stringify(process.env.APP_USER ?? "android1")});
  set(inputs[2], ${JSON.stringify(process.env.APP_PASS ?? "androidpass1")});
  document.querySelector("form button[type=submit]").click();
  return true;
})()`);
await waitFor(`document.querySelector(".composer textarea") !== null`, 20000);
await sleep(1500);
await shot("02-main.png");
// quick switcher
await evaluate(`(window.dispatchEvent(new CustomEvent("chikuwa:quick-switch")), true)`);
await sleep(400);
await shot("03-switcher.png");
await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
await sleep(300);
// settings dialog
await evaluate(`(document.querySelector('[aria-label="設定"]')?.click(), true)`);
await sleep(400);
await shot("04-settings.png");
await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
await sleep(300);
// hover a message to show the action bar
await evaluate(`(() => { const rows = document.querySelectorAll("article.message"); const row = rows[rows.length - 1]; if (!row) return false; const r = row.getBoundingClientRect(); window.__hover = { x: r.left + 200, y: r.top + r.height / 2 }; return true; })()`);
const hover = await evaluate(`window.__hover`);
if (hover) { await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: hover.x, y: hover.y }); await sleep(300); await shot("05-hover.png"); }
// dark mode
await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
await sleep(400);
await shot("06-dark.png");
ws.close();
chrome.kill();
console.log("done");
