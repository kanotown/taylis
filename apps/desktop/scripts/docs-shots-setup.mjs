// Adds what the demo seed (python -m app.cli seed-demo, infra/demo/README.md) does not have, so the documentation
// screenshots (scripts/docs-shots.mjs) can show it: a few Docs pages and a database, the attendance board, two
// action buttons and two workflows, a post with a table and the screenshot account's quick reactions (custom emoji among
// them); since 2026-11-16 also files and folders in the 研究室ドライブ, a photo album, the equipment ledger (lending
// switched on) with a few loans, a post that links to another message (its card) and a post of the screenshot account
// with two photos (to edit). Fictional content only; run it against a throwaway demo database, never a real workspace.
// Usage: API=http://127.0.0.1:8061 ADMIN_USER=tanaka ADMIN_PASS=... REVIEW_PASS=... [SEED_LOG=…] node scripts/docs-shots-setup.mjs
//   SEED_LOG   seed-demo's output (the lines `  <name>\t<password>`): the loans are made as watanabe and takahashi;
//              without it there are no loans by them
//   LINK_BASE  the address the screenshots' browser client counts as the server (default APP_URL, else
//              http://localhost:1422): the message link is written with it, so the client draws its card
//   CDP_PORT   headless Chrome's DevTools port for painting the photos (default 9444; Google Chrome in /Applications)
// Run again, it refreshes the attendance board and adds what is missing; the Docs pages, the database and the action buttons
// are made only when the Docs page 「研究室マニュアル」 does not exist yet.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const API = (process.env.API ?? "http://127.0.0.1:8061").replace(/\/$/, "") + "/api/v1";
const LINK_BASE = (process.env.LINK_BASE ?? process.env.APP_URL ?? "http://localhost:1422").replace(/\/+$/, "");
const uuid = () => crypto.randomUUID();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function login(username, password) {
  const r = await fetch(`${API}/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password, device: { platform: "web", device_name: "docs-shots" } }) });
  if (!r.ok) throw new Error(`login ${username}: ${r.status} ${await r.text()}`);
  return (await r.json()).access_token;
}

const token = await login(process.env.ADMIN_USER ?? "tanaka", process.env.ADMIN_PASS ?? "");
// One login for the screenshot account (the server limits logins per IP).
const reviewToken = process.env.REVIEW_PASS ? await login("review", process.env.REVIEW_PASS) : null;
/** A JSON request as the account of `as` (a token). */
async function call(as, method, path, body) {
  const r = await fetch(`${API}${path}`, { method, headers: { authorization: `Bearer ${as}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${text}`);
  return text ? JSON.parse(text) : null;
}
const api = (method, path, body) => call(token, method, path, body);

// The screenshot account (review) follows two students' times, so the Times feed has more than its own posts.
if (process.env.REVIEW_PASS) {
  const headers = { authorization: `Bearer ${reviewToken}` };
  const channels = await (await fetch(`${API}/channels?include=public`, { headers })).json();
  for (const c of channels.filter((c) => /^times-(watanabe|takahashi)$/.test(c.name))) {
    const r = await fetch(`${API}/channels/${c.id}/join`, { method: "POST", headers });
    if (!r.ok) throw new Error(`join ${c.name}: ${r.status}`);
  }
}

const users = await api("GET", "/users");
const byName = Object.fromEntries((users.items ?? users).map((u) => [u.username, u]));
const myChannels = await api("GET", "/channels");
const channelId = (name) => myChannels.find((c) => c.name === name)?.id;

// Attendance: on, with the default states; everyone somewhere (run again, it refreshes the 「〜から」 times), and the
// screenshot account itself 在室 (its header badge and the state menu show it).
await api("PATCH", "/admin/attendance/settings", { enabled: true });
const att = await api("GET", "/admin/attendance/settings");
const stateOf = (kind) => (att.states ?? []).find((s) => s.kind === kind && !s.owner_id)?.id;
for (const [who, kind, note] of [["tanaka", "in_room", null], ["watanabe", "in_room", "論文執筆"], ["takahashi", "in_room", "実験中"], ["yamamoto", "in_room", null], ["suzuki", "on_site", "講義"], ["nakamura", "off_site", "学会（〜金）"], ["ito", "gone", null]]) {
  const id = stateOf(kind);
  if (id && byName[who]) await api("PUT", `/admin/attendance/users/${byName[who].id}`, { state_id: id, note });
}
if (process.env.REVIEW_PASS) {
  const r = await fetch(`${API}/attendance/me`, { method: "PUT", headers: { authorization: `Bearer ${reviewToken}`, "content-type": "application/json" }, body: JSON.stringify({ state_id: stateOf("in_room"), note: null }) });
  if (!r.ok) throw new Error(`attendance review: ${r.status}`);
}

// Workflows in #研究ミーティング: an absence report with a form, and a seminar notice that asks for acknowledgement.
const meeting = channelId("研究ミーティング");
const workflows = meeting ? await api("GET", `/channels/${meeting}/workflows`) : [];
if (meeting && !workflows.some((w) => w.name === "ゼミ欠席連絡")) {
  await api("POST", "/workflows", {
    name: "ゼミ欠席連絡",
    emoji: "🙇",
    description: "研究ミーティングを休むときに使います。",
    channel_id: meeting,
    fields: [
      { key: "日付", label: "休む日", type: "date", required: true, default: { kind: "next_weekday", weekday: 0 } },
      { key: "理由", label: "理由", type: "select", required: true, options: ["授業", "体調不良", "就職活動", "学会・出張", "その他"] },
      { key: "進捗", label: "進捗の共有", type: "textarea", help: "今週の進み具合を短く書いてください（任意）" },
      { key: "資料", label: "資料を #週報 に置いた", type: "checkbox" },
    ],
    template: "*【欠席連絡】* {{日付}} の研究ミーティングを休みます。\n*【理由】* {{理由}}\n*【進捗】* {{進捗}}\n*【資料を #週報 に置いた】* {{資料}}",
  });
}
if (meeting && !workflows.some((w) => w.name === "ゼミの案内")) {
  await api("POST", "/workflows", {
    name: "ゼミの案内",
    emoji: "📣",
    description: "次の研究ミーティングの案内を出します。全員に「確認しました」を押してもらいます。",
    channel_id: meeting,
    fields: [
      { key: "日時", label: "日時", type: "datetime", required: true, default: { kind: "next_weekday", weekday: 0, time: "10:00" } },
      { key: "場所", label: "場所", type: "text", required: true, default: { kind: "literal", value: "演習室 2" } },
      { key: "発表者", label: "発表者", type: "user", multiple: true },
    ],
    template: "次の研究ミーティングの案内です。\n*【日時】* {{日時}}\n*【場所】* {{場所}}\n*【発表者】* {{発表者}}",
    request_ack: true,
    priority: "important",
  });
}

// One seminar notice posted with it (a fixed idempotency key: running this again returns the same post).
const notice = (await api("GET", `/channels/${meeting}/workflows`)).find((w) => w.name === "ゼミの案内");
if (notice) {
  const monday = new Date(Date.now() + ((8 - new Date().getDay()) % 7 || 7) * 86400000).toISOString().slice(0, 10);
  await api("POST", `/workflows/${notice.id}/submit`, {
    client_msg_id: "6f1e3c2a-7d1b-4c8e-9a51-2b7d0c9e4f10",
    values: { 日時: `${monday}T10:00`, 場所: "演習室 2", 発表者: [byName.yamamoto.id, byName.ito.id] },
  });
}

// A table pasted from a spreadsheet (the composer turns it into a Markdown table) in #学会準備, as the admin. A fixed
// idempotency key: running this again returns the same post.
const conference = channelId("学会準備");
if (conference) {
  const md = (offset) => { const d = new Date(Date.now() + offset * 86400000); return `${d.getMonth() + 1}/${d.getDate()}`; };
  await api("POST", `/channels/${conference}/messages`, {
    client_msg_id: "3b9d6c41-2f7e-4a0b-8e15-7c2d9a6f0b83",
    body: [
      "発表練習の割り当てです（スプレッドシートから貼り付け）。都合が悪い人は早めに知らせてください。",
      "",
      "| 日付 | 発表者 | 題目 | 持ち時間 |",
      "| --- | --- | --- | --- |",
      `| ${md(6)} | 山本 さくら | 関連研究のサーベイ | 15 分 |`,
      `| ${md(8)} | 中村 大輝 | 大規模モデルの評価 | 20 分 |`,
      `| ${md(13)} | 伊藤 翔 | センサデータのノイズ除去 | 15 分 |`,
    ].join("\n"),
  });
}

// The screenshot account's 「リアクションの候補」 with two custom (text) emoji among them (since 2026-10-13).
if (process.env.REVIEW_PASS) {
  const r = await fetch(`${API}/users/me`, { method: "PATCH", headers: { authorization: `Bearer ${reviewToken}`, "content-type": "application/json" }, body: JSON.stringify({ quick_reactions: ["👍", "❤️", ":thanks:", "🎉", "👀", ":confirmed:"] }) });
  if (!r.ok) throw new Error(`quick reactions: ${r.status} ${await r.text()}`);
  // Today (Asia/Tokyo) for the phones' 「今日の予定・締切」 widget: two events of mine and a task due today. The
  // idempotency keys carry the date, so a run on another day adds that day's.
  const today = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
  const key = (n) => `5e1d0c2b-${today.replaceAll("-", "").slice(0, 4)}-4${today.slice(5, 7)}${n}-8${today.slice(8, 10)}0-0000d0c5${n}00${n}`;
  const as = { authorization: `Bearer ${reviewToken}`, "content-type": "application/json" };
  for (const [n, title, from, to, location] of [[1, "研究ミーティング", "13:00", "14:30", "演習室 2"], [2, "論文紹介の準備", "16:30", "17:30", null]]) {
    const e = await fetch(`${API}/calendar/events`, { method: "POST", headers: as, body: JSON.stringify({ client_event_id: key(n), title, starts_at: `${today}T${from}:00+09:00`, ends_at: `${today}T${to}:00+09:00`, location, tz: "Asia/Tokyo" }) });
    if (!e.ok) throw new Error(`event ${title}: ${e.status} ${await e.text()}`);
  }
  const t = await fetch(`${API}/tasks`, { method: "POST", headers: as, body: JSON.stringify({ client_task_id: key(3), title: "中間発表のスライドを送る", due_on: today, tz: "Asia/Tokyo" }) });
  if (!t.ok) throw new Error(`task: ${t.status} ${await t.text()}`);
}

// ---- the drive, an album, lending, a message link, a post to edit (2026-11-16) --------------------------------------

/**
 * Photo-like pictures (landscapes of a lab retreat; no people), painted on a canvas in headless Chrome: JPEG bytes for
 * each [scene, seed]. Only called when something below needs new photos.
 */
async function paintPhotos(specs) {
  const port = Number(process.env.CDP_PORT ?? 9444);
  const profile = mkdtempSync(join(tmpdir(), "taylis-docs-photos-"));
  const chrome = spawn("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "--no-first-run", "--disable-gpu", "about:blank"], { stdio: "ignore" });
  try {
    let target = null;
    for (let i = 0; i < 60 && !target; i++) {
      try {
        target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === "page");
      } catch {}
      if (!target) await sleep(250);
    }
    if (!target) throw new Error("Chrome did not start");
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((r) => (ws.onopen = r));
    let n = 0;
    const waiting = new Map();
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      waiting.get(m.id)?.(m);
      waiting.delete(m.id);
    };
    const evaluate = (expression) =>
      new Promise((ok, fail) => {
        const id = ++n;
        waiting.set(id, (m) => (m.error || m.result.exceptionDetails ? fail(new Error(JSON.stringify(m.error ?? m.result.exceptionDetails))) : ok(m.result.result.value)));
        ws.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, returnByValue: true } }));
      });
    await evaluate(PAINTER);
    const out = [];
    for (const [scene, seed] of specs) {
      const url = await evaluate(`paint(${JSON.stringify(scene)}, ${seed}, 1800, 1200)`);
      out.push(Buffer.from(url.slice(url.indexOf(",") + 1), "base64"));
    }
    ws.close();
    return out;
  } finally {
    chrome.kill();
    await sleep(300);
    rmSync(profile, { recursive: true, force: true });
  }
}

// The painter (runs in the page). Each scene is a few gradients, ridges, trees or soft lights, then film grain and a
// vignette so it reads as a photo at thumbnail size.
const PAINTER = String.raw`window.paint = (scene, seed, W, H) => {
  const c = document.createElement("canvas"); c.width = W; c.height = H;
  const x = c.getContext("2d");
  let s = seed >>> 0;
  const R = () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const lin = (y0, y1, stops) => { const g = x.createLinearGradient(0, y0, 0, y1); for (const [o, col] of stops) g.addColorStop(o, col); return g; };
  const fill = (style, y = 0, h = H) => { x.fillStyle = style; x.fillRect(0, y, W, h); };
  const glow = (cx, cy, r, col) => { const g = x.createRadialGradient(cx, cy, 0, cx, cy, r); g.addColorStop(0, col); g.addColorStop(1, "rgba(0,0,0,0)"); x.fillStyle = g; x.fillRect(0, 0, W, H); };
  const soft = (px, fn) => { x.save(); x.filter = "blur(" + px + "px)"; fn(); x.restore(); };
  const mist = (y, h, a) => fill(lin(y - h, y + h, [[0, "rgba(255,255,255,0)"], [0.5, "rgba(255,255,255," + a + ")"], [1, "rgba(255,255,255,0)"]]), y - h, 2 * h);
  const ridge = (base, amp, col, rough = 1) => {
    const p = [R() * 6, R() * 6, R() * 6, R() * 6];
    x.beginPath(); x.moveTo(0, H);
    for (let i = 0; i <= 240; i++) {
      const u = i / 240;
      x.lineTo(u * W, base - amp * (0.5 * Math.sin(u * 2.7 + p[0]) + 0.3 * Math.sin(u * 6.1 + p[1]) + rough * (0.14 * Math.sin(u * 17 + p[2]) + 0.06 * Math.sin(u * 41 + p[3]) + 0.03 * (R() - 0.5))));
    }
    x.lineTo(W, H); x.closePath(); x.fillStyle = col; x.fill();
  };
  const trees = (base, size, col, count) => {
    x.fillStyle = col;
    for (let i = 0; i < count; i++) {
      const cx = R() * W, h = size * (0.6 + R() * 0.8), w = h * 0.28, b = base + R() * size * 0.3;
      x.beginPath(); x.moveTo(cx, b - h);
      for (let k = 1; k <= 3; k++) { x.lineTo(cx + (w * k) / 3, b - h + (h * k) / 3); x.lineTo(cx + (w * k) / 7, b - h + (h * k) / 3 - h * 0.06); }
      for (let k = 3; k >= 1; k--) { x.lineTo(cx - (w * k) / 7, b - h + (h * k) / 3 - h * 0.06); x.lineTo(cx - (w * k) / 3, b - h + (h * k) / 3); }
      x.closePath(); x.fill();
      x.fillRect(cx - w * 0.04, b - h * 0.02, w * 0.08, h * 0.1);
    }
  };
  const lights = (n, cols, rMin, rMax, yMin, yMax, aMin, aMax) => {
    for (let i = 0; i < n; i++) {
      x.globalAlpha = aMin + R() * (aMax - aMin); x.fillStyle = cols[Math.floor(R() * cols.length)];
      x.beginPath(); x.arc(R() * W, yMin + R() * (yMax - yMin), rMin + R() * (rMax - rMin), 0, 7); x.fill();
    }
    x.globalAlpha = 1;
  };
  const reflect = (hz, tint) => {
    x.save(); x.translate(0, 2 * hz); x.scale(1, -1); x.globalAlpha = 0.6; x.drawImage(c, 0, 0, W, hz, 0, 0, W, hz); x.restore();
    fill(lin(hz, H, [[0, tint + "0.25)"], [1, tint + "0.7)"]]), hz, H - hz);
    x.fillStyle = "rgba(255,255,255,0.10)";
    for (let i = 0; i < 90; i++) x.fillRect(R() * W, hz + 4 + R() * (H - hz), 40 + R() * 260, 1 + R() * 2);
  };
  const ridges = (list) => { for (const [base, amp, col, m] of list) { ridge(base * H, amp * H, col); if (m) mist(base * H - amp * H * 0.2, H * 0.05, m); } };
  const scenes = {
    mountains() {
      fill(lin(0, H * 0.7, [[0, "#6f99cf"], [0.6, "#e9c3a4"], [1, "#f6dcc0"]]));
      glow(W * (0.55 + R() * 0.3), H * 0.42, H * 0.5, "rgba(255,226,180,0.8)");
      ridges([[0.5, 0.13, "#a6b3c9", 0.3], [0.6, 0.1, "#8193b0", 0.25], [0.72, 0.09, "#5a6a88", 0.2], [0.86, 0.07, "#36425a", 0], [0.97, 0.05, "#20283a", 0]]);
    },
    lake() {
      const hz = H * 0.6;
      fill(lin(0, hz, [[0, "#5d93d1"], [0.7, "#b9d5ee"], [1, "#e4eef5"]]), 0, hz);
      soft(24, () => lights(10, ["#ffffff"], W * 0.04, W * 0.1, H * 0.05, H * 0.3, 0.5, 0.8));
      ridges([[0.48, 0.12, "#8ea7c4", 0.25], [0.55, 0.09, "#5f7f78", 0.15]]);
      trees(hz, H * 0.08, "#2f4a3a", 70);
      reflect(hz, "rgba(28,58,84,");
    },
    sunset() {
      const hz = H * 0.66;
      fill(lin(0, hz, [[0, "#29305e"], [0.4, "#9c517a"], [0.75, "#ef8a4c"], [1, "#ffcf86"]]), 0, hz);
      const sx = W * (0.35 + R() * 0.3);
      glow(sx, hz - H * 0.05, H * 0.45, "rgba(255,200,120,0.75)");
      x.fillStyle = "#fff3d0"; x.beginPath(); x.arc(sx, hz - H * 0.05, H * 0.045, 0, 7); x.fill();
      fill(lin(hz, H, [[0, "#3b3556"], [1, "#11152a"]]), hz, H - hz);
      for (let i = 0; i < 260; i++) { const y = hz + Math.pow(R(), 1.6) * (H - hz); x.fillStyle = "rgba(255," + (150 + Math.floor(R() * 80)) + ",90," + (0.5 - (y - hz) / (H - hz) * 0.4) + ")"; x.fillRect(sx - (y - hz) * 0.6 * R() - 10, y, 20 + R() * 90 * (1 + (y - hz) / 200), 1.5 + R() * 2); }
      x.fillStyle = "#1c1730"; x.beginPath(); x.moveTo(0, hz); x.quadraticCurveTo(W * 0.12, hz - H * 0.07, W * 0.26, hz); x.fill();
    },
    forest() {
      fill(lin(0, H, [[0, "#d7dfda"], [1, "#a5b8ad"]]));
      glow(W * 0.7, H * 0.2, H * 0.6, "rgba(255,248,225,0.6)");
      const layers = [["rgba(120,145,132,0.55)", 0.55, 0.22, 40], ["rgba(84,112,98,0.75)", 0.68, 0.28, 34], ["rgba(52,78,64,0.9)", 0.84, 0.36, 26], ["#1f3326", 1.02, 0.5, 18]];
      for (const [col, base, size, n] of layers) { trees(H * base, H * size, col, n); mist(H * base - H * size * 0.3, H * 0.06, 0.28); }
      fill(lin(H * 0.9, H, [[0, "rgba(31,51,38,0)"], [1, "#1f3326"]]), H * 0.9, H * 0.1);
    },
    stars() {
      fill(lin(0, H, [[0, "#050817"], [0.75, "#18264d"], [1, "#2e3f6b"]]));
      soft(40, () => { x.save(); x.translate(W / 2, H * 0.35); x.rotate(-0.5 + R() * 0.3); x.fillStyle = "rgba(200,210,255,0.16)"; x.fillRect(-W, -H * 0.08, 2 * W, H * 0.16); x.restore(); });
      lights(1400, ["#ffffff", "#dfe6ff", "#fff1d6"], 0.4, 1.6, 0, H * 0.8, 0.3, 1);
      soft(2, () => lights(40, ["#ffffff"], 1.5, 2.6, 0, H * 0.7, 0.7, 1));
      ridge(H * 0.84, H * 0.06, "#070a14");
      const tx = W * (0.35 + R() * 0.35), ty = H * 0.93;
      glow(tx, ty - H * 0.04, H * 0.18, "rgba(255,170,80,0.55)");
      x.fillStyle = "#e89a4a"; x.beginPath(); x.moveTo(tx - H * 0.08, ty); x.lineTo(tx, ty - H * 0.09); x.lineTo(tx + H * 0.08, ty); x.fill();
      x.fillStyle = "#070a14"; x.fillRect(0, ty, W, H - ty);
    },
    campfire() {
      fill(lin(0, H, [[0, "#0f0805"], [1, "#2b150a"]]));
      soft(18, () => lights(46, ["#ff9a3c", "#ffc35a", "#ff6a2a", "#ffd98a"], H * 0.02, H * 0.08, 0, H * 0.75, 0.25, 0.7));
      glow(W * 0.5, H * 1.02, H * 0.65, "rgba(255,120,40,0.85)");
      glow(W * 0.5, H * 0.95, H * 0.25, "rgba(255,220,140,0.9)");
      lights(70, ["#ffd38a", "#ffae5a"], 1, 2.4, H * 0.35, H * 0.9, 0.5, 1);
    },
    meadow() {
      const hz = H * 0.55;
      fill(lin(0, hz, [[0, "#3f86d3"], [1, "#b4d6f2"]]));
      soft(22, () => { x.fillStyle = "rgba(255,255,255,0.9)"; for (let i = 0; i < 7; i++) { const cx = R() * W, cy = H * (0.1 + R() * 0.3), w = W * (0.08 + R() * 0.1); for (let k = 0; k < 5; k++) { x.beginPath(); x.ellipse(cx + (k - 2) * w * 0.45, cy + R() * 20, w * 0.5, w * 0.28, 0, 0, 7); x.fill(); } } });
      ridge(hz + H * 0.03, H * 0.09, "#9fb6c9");
      const hill = (y, col, amp) => { x.beginPath(); x.moveTo(0, H); x.lineTo(0, y); x.bezierCurveTo(W * 0.3, y - amp, W * 0.6, y + amp, W, y - amp * 0.5); x.lineTo(W, H); x.closePath(); x.fillStyle = col; x.fill(); };
      hill(hz + H * 0.02, "#86b45a", H * 0.06); hill(hz + H * 0.12, "#5f9a3c", H * 0.08); hill(hz + H * 0.26, "#3f7a2a", H * 0.07);
      lights(500, ["#fff6a8", "#ffffff", "#f5d24a"], 1, 3, H * 0.84, H, 0.6, 1);
    },
    autumn() {
      fill(lin(0, H, [[0, "#3a2416"], [1, "#6e3f1d"]]));
      soft(26, () => lights(70, ["#d9452b", "#f08a24", "#f6c343", "#b8321f", "#e8642c"], H * 0.04, H * 0.12, -H * 0.05, H * 1.05, 0.45, 0.85));
      soft(3, () => lights(26, ["#e8542a", "#f39a2b", "#f7c544"], H * 0.012, H * 0.03, 0, H, 0.85, 1));
    },
  };
  scenes[scene]();
  const img = x.getImageData(0, 0, W, H), d = img.data;
  for (let i = 0; i < d.length; i += 4) { const n = (R() - 0.5) * 16; d[i] += n; d[i + 1] += n; d[i + 2] += n; }
  x.putImageData(img, 0, 0);
  const v = x.createRadialGradient(W / 2, H / 2, H * 0.45, W / 2, H / 2, H * 1.05); v.addColorStop(0, "rgba(0,0,0,0)"); v.addColorStop(1, "rgba(0,0,0,0.38)");
  x.fillStyle = v; x.fillRect(0, 0, W, H);
  return c.toDataURL("image/jpeg", 0.86);
};`;

/** A one-page PDF (Helvetica, ASCII text) padded with comment lines to about `kb` KB, so its size reads like a real one. */
function pdf(title, lines, kb) {
  const text = [`BT /F1 26 Tf 72 700 Td (${title}) Tj ET`, ...lines.map((l, i) => `BT /F1 13 Tf 72 ${650 - i * 22} Td (${l}) Tj ET`)].join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets = objects.map((o, i) => {
    const at = out.length;
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
    return at;
  });
  while (out.length < kb * 1024) out += `% ${"taylis demo padding ".repeat(4)}\n`;
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

/** Puts `bytes` into the drive folder `parentId` as `name` (the resumable upload, in one part when it fits). */
async function driveUpload(as, parentId, name, bytes, modifiedMs = null) {
  const up = await call(as, "POST", "/drive/uploads", { client_upload_id: uuid(), parent_id: parentId, name, size_bytes: bytes.length, on_conflict: "rename", content_modified_ms: modifiedMs });
  for (let part = 1; part <= up.parts_total; part++) {
    const chunk = bytes.subarray((part - 1) * up.part_size, part * up.part_size);
    const r = await fetch(`${API}/drive/uploads/${up.id}/parts/${part}`, { method: "PUT", headers: { authorization: `Bearer ${as}`, "content-type": "application/octet-stream", "x-content-sha256": createHash("sha256").update(chunk).digest("hex") }, body: chunk });
    if (!r.ok) throw new Error(`upload ${name} part ${part}: ${r.status} ${await r.text()}`);
  }
  let done = await call(as, "POST", `/drive/uploads/${up.id}/complete`);
  for (let i = 0; done.status !== "completed" && i < 60; i++) {
    await sleep(500);
    done = await call(as, "GET", `/drive/uploads/${up.id}`);
  }
  return done;
}

/** An attachment for a message (POST /attachments), as the account of `as`. */
async function attach(as, name, bytes, type) {
  const form = new FormData();
  form.append("file", new Blob([bytes], { type }), name);
  const r = await fetch(`${API}/attachments`, { method: "POST", headers: { authorization: `Bearer ${as}` }, body: form });
  if (!r.ok) throw new Error(`attachment ${name}: ${r.status} ${await r.text()}`);
  return (await r.json()).id;
}

// The 研究室ドライブ: four folders and a few files at the top (the drive list's shot), made when 「論文」 is missing.
const labDrive = (await api("GET", "/drive/locations")).locations.find((l) => l.kind === "workspace");
const labTop = await api("GET", `/drive/folders/${labDrive.root_id}/children`);
if (!(labTop.items ?? []).some((i) => i.name === "論文")) {
  const folders = {};
  for (const name of ["論文", "発表資料", "実験データ", "事務・手続き"]) folders[name] = await api("POST", "/drive/folders", { client_op_id: uuid(), parent_id: labDrive.root_id, name });
  const daysAgo = (n) => Date.now() - n * 86400000;
  const csv = ["date,server,user,gpu_hours", ...Array.from({ length: 420 }, (_, i) => `2026-10-${String((i % 31) + 1).padStart(2, "0")},gpu0${(i % 3) + 1},${["tanaka", "watanabe", "takahashi", "nakamura", "yamamoto", "ito"][i % 6]},${((i * 37) % 90) / 10}`)].join("\n");
  const files = [
    [labDrive.root_id, "研究室ガイド 2026.pdf", pdf("Lab Guide 2026", ["Taylis Demo Lab (fictional)", "Rooms, keys, servers and the weekly schedule."], 240), 40],
    [labDrive.root_id, "学会ポスターの見本.pdf", pdf("Poster template", ["A0 portrait, 3 columns."], 1260), 21],
    [labDrive.root_id, "中間発表の評価シート.pdf", pdf("Mid-term review sheet", ["Motivation / Method / Results / Q&A"], 88), 12],
    [labDrive.root_id, "計算機の利用状況 2026-10.csv", Buffer.from(csv), 9],
    [labDrive.root_id, "GPU サーバの使い方.md", Buffer.from("# GPU サーバの使い方\n\n- `gpu01`〜`gpu03` を使えます。\n- 長いジョブは Taylis の「予約」で枠を取ってから流してください。\n- データは `/data/<名前>` に置きます。\n".repeat(12)), 6],
    [labDrive.root_id, "ゼミの発表順（後期）.txt", Buffer.from("10/5 山本・伊藤\n10/12 中村・高橋\n10/19 渡辺・Review\n10/26 山本・伊藤\n11/2 中村・高橋\n11/9 渡辺・Review\n"), 3],
    [folders["論文"].id, "サーベイ_山本_draft.pdf", pdf("Survey draft", ["Related work (fictional)"], 420), 5],
    [folders["実験データ"].id, "validation_accuracy.csv", Buffer.from("epoch,baseline,cosine_warmup\n" + Array.from({ length: 30 }, (_, i) => `${i + 1},${(0.7 + i * 0.004).toFixed(3)},${(0.7 + i * 0.005).toFixed(3)}`).join("\n")), 7],
  ];
  for (const [parent, name, bytes, age] of files) await driveUpload(token, parent, name, bytes, daysAgo(age));
}

// A photo album in the 研究室ドライブ: twelve photos of a two-day lab retreat (made when it is missing).
const RETREAT = "ゼミ合宿 2026（長野）";
const ALBUM_SHOTS = [
  ["meadow", 11, "2026-11-07T10:12"], ["autumn", 12, "2026-11-07T11:40"], ["lake", 13, "2026-11-07T13:05"], ["forest", 14, "2026-11-07T14:30"],
  ["mountains", 15, "2026-11-07T15:50"], ["sunset", 16, "2026-11-07T16:45"], ["campfire", 17, "2026-11-07T19:20"], ["stars", 18, "2026-11-07T21:10"],
  ["mountains", 21, "2026-11-08T06:05"], ["lake", 22, "2026-11-08T06:40"], ["forest", 23, "2026-11-08T09:15"], ["meadow", 24, "2026-11-08T11:30"],
];
const albums = (await api("GET", "/drive/albums")).items ?? [];
if (!albums.some((a) => JSON.stringify(a).includes(RETREAT))) {
  const created = await api("POST", "/drive/albums", { client_op_id: uuid(), name: RETREAT, location_id: labDrive.id, description: "11/7〜8 のゼミ合宿の写真です。撮った写真はここに追加してください。", starts_on: "2026-11-07", ends_on: "2026-11-08" });
  const photos = await paintPhotos(ALBUM_SHOTS.map(([scene, seed]) => [scene, seed]));
  for (const [i, [, , at]] of ALBUM_SHOTS.entries()) await driveUpload(token, created.folder?.id ?? created.album.folder_id, `IMG_${2041 + i * 3}.jpg`, photos[i], Date.parse(`${at}:00+09:00`));
}

// A post of the screenshot account in #雑談 with two photos (the edit shot takes a file off it and adds emoji).
const chat = channelId("雑談");
const SCOUTING = "合宿の宿の下見に行ってきました。湖のすぐそばで、夜は星がよく見えるそうです。";
if (process.env.REVIEW_PASS && chat) {
  const recent = (await call(reviewToken, "GET", `/channels/${chat}/messages?limit=100`)).messages;
  if (!recent.some((m) => m.body?.startsWith(SCOUTING))) {
    const [lake, stars] = await paintPhotos([["lake", 31], ["stars", 32]]);
    const ids = [await attach(reviewToken, "IMG_1984.jpg", lake, "image/jpeg"), await attach(reviewToken, "IMG_1990.jpg", stars, "image/jpeg")];
    await call(reviewToken, "POST", `/channels/${chat}/messages`, { client_msg_id: "7c4e2b19-5a3d-4f60-8e21-9b0d6a3f1c58", body: SCOUTING, attachment_ids: ids });
  }
}

// A link to 高橋's progress post (its graph) in #論文紹介, as the admin: the client draws it as a message card.
const papers = channelId("論文紹介");
if (meeting && papers) {
  const progress = (await api("GET", `/channels/${meeting}/messages?limit=200`)).messages.find((m) => m.sender_id === byName.takahashi?.id && m.body?.includes("ベースラインの精度") && !m.parent_id);
  if (progress) {
    await api("POST", `/channels/${papers}/messages`, {
      client_msg_id: "2d8f6a40-1b7e-4c93-a5d2-6e0f8b3c9a17",
      body: `来週の論文紹介の前に、高橋さんのこの結果を見ておいてください。cosine と warmup の違いがよく分かります。\n${LINK_BASE}/m/${progress.id}`,
    });
  }
}

// Equipment lending (off by default): on, with 備品係 鈴木, four categories, ten items, three loans and one in repair.
const lending = await api("GET", "/lending/settings");
if (!lending.enabled) await api("PATCH", "/admin/lending/settings", { enabled: true, keeper_ids: [byName.suzuki.id] });
const items = await api("GET", "/lending/items");
if (!items.some((i) => i.code === "CAM-01")) {
  const categories = {};
  for (const [name, max_days, requires_permission] of [["カメラ", 14, false], ["PC", 30, true], ["書籍", 30, false], ["計測機器", 7, true]]) {
    categories[name] = (await api("POST", "/lending/categories", { name, max_days, requires_permission })).id;
  }
  const made = {};
  for (const [name, code, category, location, notes] of [
    ["デジタル一眼カメラ A", "CAM-01", "カメラ", "301 棚 2", "付属品：レンズ 2 本、充電器、SD カード 64 GB"],
    ["デジタル一眼カメラ B", "CAM-02", "カメラ", "301 棚 2", "付属品：レンズ 1 本、充電器"],
    ["三脚", "CAM-05", "カメラ", "301 棚 2", null],
    ["貸出用ノート PC 1", "PC-01", "PC", "301 ロッカー", "充電器と USB-C のハブ付き"],
    ["貸出用ノート PC 2", "PC-02", "PC", "301 ロッカー", "充電器と USB-C のハブ付き"],
    ["ポータブルプロジェクタ", "PRJ-01", null, "302 棚 1", "HDMI ケーブル 2 m 付き"],
    ["パターン認識と機械学習（上）", "BOOK-12", "書籍", "本棚 A-3", null],
    ["深層学習（改訂第 2 版）", "BOOK-18", "書籍", "本棚 A-3", null],
    ["ハンディ電力計", "MES-03", "計測機器", "302 棚 3", "電池は単 3 形 4 本"],
    ["モバイルルータ", "NET-02", null, "事務室", "月 20 GB まで"],
  ]) {
    made[code] = await api("POST", "/lending/items", { name, code, category_id: category ? categories[category] : null, location, notes });
  }
  await api("POST", `/lending/items/${made["PC-02"].id}/status`, { status: "in_repair", note: "バッテリーを交換中" });
  const today = new Date(Date.now() + 9 * 3600000);
  const due = (days) => new Date(today.getTime() + days * 86400000).toISOString().slice(0, 10);
  const borrow = async (as, code, days, purpose) => {
    const approvers = await call(as, "GET", "/lending/approvers");
    const permission = made[code].requires_permission && !approvers.self_approved;
    await call(as, "POST", `/lending/items/${made[code].id}/borrow`, { client_request_id: uuid(), due_on: due(days), purpose, permission_confirmed: permission, approver_id: permission ? byName.tanaka.id : null });
  };
  if (reviewToken) await borrow(reviewToken, "BOOK-12", 14, "論文紹介の準備");
  const seedLog = process.env.SEED_LOG ? readFileSync(process.env.SEED_LOG, "utf8") : "";
  const passwordOf = (who) => seedLog.split("\n").map((l) => l.trim().split(/\s+/)).find((p) => p[0] === who && p.length === 2)?.[1];
  for (const [who, code, days, purpose] of [["watanabe", "CAM-01", 3, "学会発表の撮影"], ["takahashi", "PC-01", 10, "学会でのデモ"]]) {
    if (passwordOf(who)) await borrow(await login(who, passwordOf(who)), code, days, purpose);
  }
}

const tree = await api("GET", "/wiki/tree");
if (JSON.stringify(tree).includes("研究室マニュアル")) {
  console.log("done (the Docs pages were there already)");
  process.exit(0);
}

// Docs: a manual with two child pages, and a database of papers.
const manual = await api("POST", "/wiki/pages", {
  client_save_id: uuid(),
  title: "研究室マニュアル",
  icon: "📘",
  body: [
    "研究室で困ったときに最初に見るページです。分からないことは #雑談 で気軽に聞いてください。",
    "",
    "::: callout 💡",
    "はじめて来た人は、まず「新しく来た人へ」を読んでください。",
    ":::",
    "",
    "## 毎週の予定",
    "",
    "| 曜日 | 内容 | 場所 |",
    "| --- | --- | --- |",
    "| 月 | 研究ミーティング（10:00〜） | 演習室 2 |",
    "| 水 | 論文紹介（16:00〜） | 演習室 2 |",
    "| 金 | 週報の締切（18:00） | Taylis の #週報 |",
    "",
    "## 最初の週にすること",
    "",
    "- [x] Taylis にログインする",
    "- [ ] プロフィールに学年と研究テーマを書く",
    "- [ ] GPU サーバのアカウントを申請する",
    "- [ ] 研究ミーティングで自己紹介する",
    "",
    "::: toggle 研究室の鍵の借り方",
    "平日の 9:00〜18:00 は事務室で借ります。それ以外の時間は、教員か D の学生に連絡してください。",
    ":::",
  ].join("\n"),
});
for (const [title, icon, body] of [
  ["新しく来た人へ", "👋", "ようこそ。最初の 1 週間で、研究室の道具と決まりに慣れてください。\n\n## 連絡\n\n- 全体の連絡は #お知らせ\n- 雑談と質問は #雑談\n- 毎週の進み具合は #週報"],
  ["機材の使い方", "🖥️", "## GPU サーバ\n\n`gpu01`〜`gpu03` を使えます。長時間のジョブは Taylis の「予約」で枠を取ってから流してください。"],
]) {
  await api("POST", "/wiki/pages", { client_save_id: uuid(), parent_id: manual.id, title, icon, body });
}

const db = await api("POST", "/wiki/pages", { client_save_id: uuid(), kind: "database", title: "論文リスト", icon: "📚", tz: "Asia/Tokyo" });
const dbInfo = await api("GET", `/wiki/databases/${db.id}`);
const version = dbInfo.schema_version ?? dbInfo.database?.schema_version ?? 0;
const schema = await api("PATCH", `/wiki/databases/${db.id}/schema`, {
  base_schema_version: version,
  ops: [
    { op: "add", type: "text", name: "著者" },
    { op: "add", type: "number", name: "年", number_format: "integer" },
    { op: "add", type: "select", name: "状態", options: [{ name: "未読", color: "gray" }, { name: "読んでいる", color: "blue" }, { name: "読了", color: "green" }] },
    { op: "add", type: "person", name: "担当" },
    { op: "add", type: "date", name: "紹介する日" },
  ],
});
const props = schema.properties ?? schema.schema?.properties ?? schema.database?.properties ?? [];
const prop = (name) => props.find((p) => p.name === name);
const opt = (name, option) => prop(name).options.find((o) => o.name === option).id;
const day = (offset) => { const d = new Date(Date.now() + offset * 86400000); return d.toISOString().slice(0, 10); };
const rows = [
  ["Attention Is All You Need", "Vaswani et al.", 2017, "読了", "takahashi", -6],
  ["Denoising Diffusion Probabilistic Models", "Ho et al.", 2020, "読んでいる", "yamamoto", 1],
  ["Learning Transferable Visual Models From Natural Language Supervision", "Radford et al.", 2021, "読んでいる", "nakamura", 8],
  ["Deep Residual Learning for Image Recognition", "He et al.", 2016, "読了", "watanabe", -13],
  ["BERT: Pre-training of Deep Bidirectional Transformers", "Devlin et al.", 2019, "未読", "ito", 15],
  ["An Image is Worth 16x16 Words", "Dosovitskiy et al.", 2021, "未読", "review", 22],
];
for (const [title, author, year, state, who, offset] of rows) {
  await api("POST", `/wiki/databases/${db.id}/rows`, {
    client_save_id: uuid(),
    title,
    props: {
      [prop("著者").id]: author,
      [prop("年").id]: year,
      [prop("状態").id]: opt("状態", state),
      [prop("担当").id]: [byName[who].id],
      [prop("紹介する日").id]: { start: day(offset) },
    },
  });
}
await api("PUT", `/wiki/databases/${db.id}/views/board`, { name: "ボード", type: "board", group_by: { prop_id: prop("状態").id } });

// Action buttons (the relay URL is a placeholder: pressing them in the demo only shows an error).
await api("PATCH", "/admin/actions/settings", { enabled: true, show_on_attendance: true });
for (const [name, key, emoji] of [["鍵を開ける", "lab-door.unlock", "🔓"], ["鍵を閉める", "lab-door.lock", "🔒"]]) {
  await api("POST", "/admin/actions", { name, action_key: key, emoji, group_label: "研究室のドア", url: "https://relay.example.com/taylis/actions", secret_name: "demo-relay", allowed_roles: ["admin", "manager", "member"] });
}
console.log("done");
