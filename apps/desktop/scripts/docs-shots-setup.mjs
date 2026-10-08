// Adds what the demo seed (python -m app.cli seed-demo, infra/demo/README.md) does not have, so the documentation
// screenshots (scripts/docs-shots.mjs) can show it: a few Docs pages and a database, the attendance board and two
// action buttons. Fictional content only; run it against a throwaway demo database, never a real workspace.
// Usage: API=http://127.0.0.1:8061 ADMIN_USER=tanaka ADMIN_PASS=... REVIEW_PASS=... node scripts/docs-shots-setup.mjs
// Stops (does nothing) when the Docs page 「研究室マニュアル」 already exists.
const API = (process.env.API ?? "http://127.0.0.1:8061").replace(/\/$/, "") + "/api/v1";
const uuid = () => crypto.randomUUID();

async function login(username, password) {
  const r = await fetch(`${API}/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password, device: { platform: "web", device_name: "docs-shots" } }) });
  if (!r.ok) throw new Error(`login ${username}: ${r.status} ${await r.text()}`);
  return (await r.json()).access_token;
}

const token = await login(process.env.ADMIN_USER ?? "tanaka", process.env.ADMIN_PASS ?? "");
async function api(method, path, body) {
  const r = await fetch(`${API}${path}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

// The screenshot account (review) follows two students' times, so the Times feed has more than its own posts.
if (process.env.REVIEW_PASS) {
  const reviewToken = await login("review", process.env.REVIEW_PASS);
  const headers = { authorization: `Bearer ${reviewToken}` };
  const channels = await (await fetch(`${API}/channels?include=public`, { headers })).json();
  for (const c of channels.filter((c) => /^times-(watanabe|takahashi)$/.test(c.name))) {
    const r = await fetch(`${API}/channels/${c.id}/join`, { method: "POST", headers });
    if (!r.ok) throw new Error(`join ${c.name}: ${r.status}`);
  }
}

const tree = await api("GET", "/wiki/tree");
if (JSON.stringify(tree).includes("研究室マニュアル")) {
  console.log("already set up");
  process.exit(0);
}

const users = await api("GET", "/users");
const byName = Object.fromEntries((users.items ?? users).map((u) => [u.username, u]));

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
    "- [ ] GPU サーバーのアカウントを申請する",
    "- [ ] 研究ミーティングで自己紹介する",
    "",
    "::: toggle 研究室の鍵の借り方",
    "平日の 9:00〜18:00 は事務室で借ります。それ以外の時間は、教員か D の学生に連絡してください。",
    ":::",
  ].join("\n"),
});
for (const [title, icon, body] of [
  ["新しく来た人へ", "👋", "ようこそ。最初の 1 週間で、研究室の道具と決まりに慣れてください。\n\n## 連絡\n\n- 全体の連絡は #お知らせ\n- 雑談と質問は #雑談\n- 毎週の進み具合は #週報"],
  ["機材の使い方", "🖥️", "## GPU サーバー\n\n`gpu01`〜`gpu03` を使えます。長時間のジョブは Taylis の「予約」で枠を取ってから流してください。"],
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

// Attendance: on, with the default states; a few people somewhere.
await api("PATCH", "/admin/attendance/settings", { enabled: true });
const att = await api("GET", "/admin/attendance/settings");
const states = att.states ?? [];
const stateOf = (kind) => states.find((s) => s.kind === kind)?.id;
for (const [who, kind, note] of [["tanaka", "in_room", null], ["suzuki", "on_site", "講義"], ["watanabe", "in_room", null], ["takahashi", "in_room", "実験中"], ["nakamura", "off_site", "学会"], ["yamamoto", "gone", null]]) {
  const id = stateOf(kind);
  if (id) await api("PUT", `/admin/attendance/users/${byName[who].id}`, { state_id: id, note });
}

// Action buttons (the relay URL is a placeholder: pressing them in the demo only shows an error).
await api("PATCH", "/admin/actions/settings", { enabled: true, show_on_attendance: true });
for (const [name, key, emoji] of [["鍵を開ける", "lab-door.unlock", "🔓"], ["鍵を閉める", "lab-door.lock", "🔒"]]) {
  await api("POST", "/admin/actions", { name, action_key: key, emoji, group_label: "研究室のドア", url: "https://relay.example.com/taylis/actions", secret_name: "demo-relay", allowed_roles: ["admin", "manager", "member"] });
}
console.log("done");
