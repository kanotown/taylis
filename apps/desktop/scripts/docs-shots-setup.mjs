// Adds what the demo seed (python -m app.cli seed-demo, infra/demo/README.md) does not have, so the documentation
// screenshots (scripts/docs-shots.mjs) can show it: a few Docs pages and a database, the attendance board, two
// action buttons and two workflows, a post with a table and the screenshot account's quick reactions (custom emoji among
// them); since 2026-11-16 also files and folders in the 研究室ドライブ, a photo album, the equipment ledger (lending
// switched on) with a few loans, a post that links to another message (its card) and a post of the screenshot account
// with two photos (to edit), with reactions and two replies; three members acknowledge the seminar notice.
// The photos are real photographs (CC0, Wikimedia Commons, since 2026-11-17), listed with their sources in
// scripts/demo-photos.json: downloaded once into PHOTO_CACHE and checked against their SHA-256 (not in the repository).
// Fictional content otherwise; run it against a throwaway demo database, never a real workspace.
// Usage: API=http://127.0.0.1:8061 ADMIN_USER=tanaka ADMIN_PASS=... REVIEW_PASS=... [SEED_LOG=…] node scripts/docs-shots-setup.mjs
//   SEED_LOG     seed-demo's output (the lines `  <name>\t<password>`): the loans (watanabe, takahashi), the reactions and
//                replies on the screenshot account's photo post and the acknowledgements are made as those members;
//                without it there are none of them
//   LINK_BASE    the address the screenshots' browser client counts as the server (default APP_URL, else
//                http://localhost:1422): the message link is written with it, so the client draws its card
//   PHOTO_CACHE  where the photos are kept between runs (default: taylis-demo-photos in the OS temp directory)
// Run again, it refreshes the attendance board and adds what is missing; the Docs pages, the database and the action buttons
// are made only when the Docs page 「研究室マニュアル」 does not exist yet.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const API = (process.env.API ?? "http://127.0.0.1:8061").replace(/\/$/, "") + "/api/v1";
const LINK_BASE = (process.env.LINK_BASE ?? process.env.APP_URL ?? "http://localhost:1422").replace(/\/+$/, "");
const uuid = () => crypto.randomUUID();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function login(username, password) {
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(`${API}/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password, device: { platform: "web", device_name: "docs-shots" } }) });
    // The server allows a few logins a minute per address: wait for the next minute.
    if (r.status === 429 && attempt < 3) {
      await sleep(20000);
      continue;
    }
    if (!r.ok) throw new Error(`login ${username}: ${r.status} ${await r.text()}`);
    return (await r.json()).access_token;
  }
}

const token = await login(process.env.ADMIN_USER ?? "tanaka", process.env.ADMIN_PASS ?? "");
// One login for the screenshot account (the server limits logins per IP).
const reviewToken = process.env.REVIEW_PASS ? await login("review", process.env.REVIEW_PASS) : null;
// The other demo members, from seed-demo's output (SEED_LOG): a token each, logged in once; null without a password.
const seedLog = process.env.SEED_LOG ? readFileSync(process.env.SEED_LOG, "utf8") : "";
const passwordOf = (who) => seedLog.split("\n").map((l) => l.trim().split(/\s+/)).find((p) => p[0] === who && p.length === 2)?.[1];
const members = new Map();
async function member(who) {
  if (!members.has(who)) members.set(who, passwordOf(who) ? await login(who, passwordOf(who)) : null);
  return members.get(who);
}
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

// One seminar notice posted with it (a fixed idempotency key: running this again returns the same post), acknowledged
// by three members (with SEED_LOG), so its bar reads 「3/7 人が確認」.
const notice = (await api("GET", `/channels/${meeting}/workflows`)).find((w) => w.name === "ゼミの案内");
if (notice) {
  const monday = new Date(Date.now() + ((8 - new Date().getDay()) % 7 || 7) * 86400000).toISOString().slice(0, 10);
  const posted = await api("POST", `/workflows/${notice.id}/submit`, {
    client_msg_id: "6f1e3c2a-7d1b-4c8e-9a51-2b7d0c9e4f10",
    values: { 日時: `${monday}T10:00`, 場所: "演習室 2", 発表者: [byName.yamamoto.id, byName.ito.id] },
  });
  for (const who of ["watanabe", "takahashi", "ito"]) {
    if (await member(who)) await call(await member(who), "PUT", `/messages/${posted.id}/ack`);
  }
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

// The real photographs (scripts/demo-photos.json): fetched once into PHOTO_CACHE, checked against their SHA-256.
const PHOTOS = JSON.parse(readFileSync(new URL("./demo-photos.json", import.meta.url), "utf8")).photos;
const PHOTO_CACHE = process.env.PHOTO_CACHE ?? join(tmpdir(), "taylis-demo-photos");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** The JPEG bytes of the photo `id`, from the cache or (once) from its source. */
async function photo(id) {
  const entry = PHOTOS.find((p) => p.id === id);
  if (!entry) throw new Error(`no photo "${id}" in demo-photos.json`);
  const file = join(PHOTO_CACHE, `${id}.jpg`);
  if (existsSync(file) && sha256(readFileSync(file)) === entry.sha256) return readFileSync(file);
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(entry.url, { headers: { "user-agent": "docs-shots-setup/1.0 (demo screenshots)" } });
    // Wikimedia answers 429 to quick runs of thumbnail requests: wait and try again.
    if (r.status === 429 && attempt < 6) {
      await sleep(15000 * (attempt + 1));
      continue;
    }
    if (!r.ok) throw new Error(`photo ${id}: ${r.status} from ${entry.url}`);
    const bytes = Buffer.from(await r.arrayBuffer());
    if (sha256(bytes) !== entry.sha256) throw new Error(`photo ${id}: the download's SHA-256 is ${sha256(bytes)}, not demo-photos.json's (the source changed: choose again or update the entry)`);
    mkdirSync(PHOTO_CACHE, { recursive: true });
    writeFileSync(file, bytes);
    await sleep(2000);
    return bytes;
  }
}

/**
 * `jpeg` without its own EXIF, XMP, IPTC and comment segments, and with a small EXIF block that says only when it was
 * taken: DateTimeOriginal `at` ("YYYY-MM-DDTHH:MM:SS", Japan time) with OffsetTimeOriginal +09:00. The album groups the
 * photos by that day.
 */
function withCaptureTime(jpeg, at) {
  if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) throw new Error("not a JPEG");
  const date = Buffer.from(`${at.replaceAll("-", ":").replace("T", " ")}\0`, "latin1");
  const offset = Buffer.from("+09:00\0", "latin1");
  // TIFF, little endian: IFD0 (one entry: where the Exif IFD is) at 8, the Exif IFD (two entries) at 26, the values at 56.
  const tiff = Buffer.alloc(56 + date.length + offset.length);
  const entry = (at, tag, type, count, value) => {
    tiff.writeUInt16LE(tag, at);
    tiff.writeUInt16LE(type, at + 2);
    tiff.writeUInt32LE(count, at + 4);
    tiff.writeUInt32LE(value, at + 8);
  };
  tiff.write("II", 0, "latin1");
  tiff.writeUInt16LE(42, 2);
  tiff.writeUInt32LE(8, 4);
  tiff.writeUInt16LE(1, 8);
  entry(10, 0x8769, 4, 1, 26);
  tiff.writeUInt16LE(2, 26);
  entry(28, 0x9003, 2, date.length, 56);
  entry(40, 0x9011, 2, offset.length, 56 + date.length);
  date.copy(tiff, 56);
  offset.copy(tiff, 56 + date.length);
  const header = Buffer.alloc(4);
  header.writeUInt16BE(0xffe1, 0);
  header.writeUInt16BE(2 + 6 + tiff.length, 2);
  const exif = Buffer.concat([header, Buffer.from("Exif\0\0", "latin1"), tiff]);
  // The segments up to the image data, without APP1 (EXIF, XMP), APP13 (IPTC) and COM; the EXIF block after APP0 (JFIF).
  const kept = [];
  let i = 2;
  while (jpeg[i] === 0xff && jpeg[i + 1] !== 0xda) {
    const end = i + 2 + jpeg.readUInt16BE(i + 2);
    if (![0xe1, 0xed, 0xfe].includes(jpeg[i + 1])) kept.push(jpeg.subarray(i, end));
    i = end;
  }
  if (jpeg[i] !== 0xff) throw new Error("unexpected JPEG layout");
  const jfif = kept[0]?.[1] === 0xe0 ? [kept.shift()] : [];
  return Buffer.concat([jpeg.subarray(0, 2), ...jfif, exif, ...kept, jpeg.subarray(i)]);
}

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

// A photo album in the 研究室ドライブ: twelve photos of a two-day lab retreat (made when it is missing), each with the
// time it was taken (in its EXIF, so the album groups them by day).
const RETREAT = "ゼミ合宿 2026（長野）";
const ALBUM_SHOTS = [
  ["river", "2026-11-07T10:12:31"], ["larch-forest", "2026-11-07T11:03:48"], ["soba", "2026-11-07T12:31:05"], ["seminar-room", "2026-11-07T14:02:17"],
  ["nozawana", "2026-11-07T18:47:52"], ["campfire", "2026-11-07T20:05:09"], ["stars-tent", "2026-11-07T21:18:44"], ["ryokan-room", "2026-11-07T22:40:13"],
  ["morning-mist", "2026-11-08T06:24:36"], ["pond", "2026-11-08T08:55:02"], ["waterfall", "2026-11-08T10:10:27"], ["maples", "2026-11-08T11:20:58"],
];
const albums = (await api("GET", "/drive/albums")).items ?? [];
if (!albums.some((a) => JSON.stringify(a).includes(RETREAT))) {
  const created = await api("POST", "/drive/albums", { client_op_id: uuid(), name: RETREAT, location_id: labDrive.id, description: "11/7〜8 のゼミ合宿の写真です。撮った写真はここに追加してください。", starts_on: "2026-11-07", ends_on: "2026-11-08" });
  for (const [i, [id, at]] of ALBUM_SHOTS.entries()) {
    await driveUpload(token, created.folder?.id ?? created.album.folder_id, `IMG_${2041 + i * 3}.jpg`, withCaptureTime(await photo(id), at), Date.parse(`${at}+09:00`));
  }
}

// A post of the screenshot account in #雑談 with two photos (the edit shot takes a file off it and adds emoji): the lake
// by the lodge and its starry sky. Reactions and two replies from the members (with SEED_LOG; fixed idempotency keys).
const chat = channelId("雑談");
const SCOUTING = "合宿の宿の下見に行ってきました。湖のすぐそばで、夜は星がよく見えるそうです。";
if (process.env.REVIEW_PASS && chat) {
  const recent = (await call(reviewToken, "GET", `/channels/${chat}/messages?limit=100`)).messages;
  let scouting = recent.find((m) => m.body?.startsWith(SCOUTING) && !m.parent_id);
  if (!scouting) {
    const ids = [
      await attach(reviewToken, "IMG_1984.jpg", withCaptureTime(await photo("lake"), "2026-10-24T15:42:10"), "image/jpeg"),
      await attach(reviewToken, "IMG_1990.jpg", withCaptureTime(await photo("stars-lake"), "2026-10-24T21:06:33"), "image/jpeg"),
    ];
    scouting = await call(reviewToken, "POST", `/channels/${chat}/messages`, { client_msg_id: "7c4e2b19-5a3d-4f60-8e21-9b0d6a3f1c58", body: SCOUTING, attachment_ids: ids });
  }
  for (const [who, emoji] of [["yamamoto", "😍"], ["ito", "😍"], ["nakamura", "😍"], ["tanaka", "✨"], ["watanabe", "✨"], ["suzuki", ":thanks:"]]) {
    const as = who === "tanaka" ? token : await member(who);
    if (as) await call(as, "PUT", `/messages/${scouting.id}/reactions/${encodeURIComponent(emoji)}`);
  }
  for (const [who, key, body] of [
    ["yamamoto", "3d6a9e42-8b1c-4f07-a5e3-6c2b8d0f9a71", "星空すごい…！夜に外に出られるのが楽しみです ✨"],
    ["tanaka", "b5f20c7e-4d93-4a6b-8e1f-0a7c3d9b2e54", "いいところですね。予約はこのまま進めてください。"],
  ]) {
    const as = who === "tanaka" ? token : await member(who);
    if (as) await call(as, "POST", `/channels/${chat}/messages`, { client_msg_id: key, body, parent_id: scouting.id });
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
  for (const [who, code, days, purpose] of [["watanabe", "CAM-01", 3, "学会発表の撮影"], ["takahashi", "PC-01", 10, "学会でのデモ"]]) {
    if (await member(who)) await borrow(await member(who), code, days, purpose);
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
