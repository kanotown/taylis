// Adds what the demo seed (python -m app.cli seed-demo, infra/demo/README.md) does not have, so the documentation
// screenshots (scripts/docs-shots.mjs) can show it: a few Docs pages and a database, the attendance board, two
// action buttons and two workflows, a post with a table and the screenshot account's quick reactions (custom emoji among
// them). Fictional content only; run it against a throwaway demo database, never a real workspace.
// Usage: API=http://127.0.0.1:8061 ADMIN_USER=tanaka ADMIN_PASS=... REVIEW_PASS=... node scripts/docs-shots-setup.mjs
// Run again, it refreshes the attendance board and adds what is missing; the Docs pages, the database and the action buttons
// are made only when the Docs page 「研究室マニュアル」 does not exist yet.
const API = (process.env.API ?? "http://127.0.0.1:8061").replace(/\/$/, "") + "/api/v1";
const uuid = () => crypto.randomUUID();

async function login(username, password) {
  const r = await fetch(`${API}/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password, device: { platform: "web", device_name: "docs-shots" } }) });
  if (!r.ok) throw new Error(`login ${username}: ${r.status} ${await r.text()}`);
  return (await r.json()).access_token;
}

const token = await login(process.env.ADMIN_USER ?? "tanaka", process.env.ADMIN_PASS ?? "");
// One login for the screenshot account (the server limits logins per IP).
const reviewToken = process.env.REVIEW_PASS ? await login("review", process.env.REVIEW_PASS) : null;
async function api(method, path, body) {
  const r = await fetch(`${API}${path}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

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
