/** Slash commands (M13b): a few Slack-style shortcuts that map onto existing actions, client-side only. */

import { replaceShortcodes } from "./emoji";

export interface SlashCommand {
  name: string;
  usage: string;
  description: string;
  /** Not available in a DM. */
  channelOnly?: boolean;
}

export const COMMANDS: readonly SlashCommand[] = [
  { name: "status", usage: "/status [絵文字] 文", description: "ステータスを設定 (/status clear で消す)" },
  { name: "dnd", usage: "/dnd 30m | 1h | 2h | 4h | tomorrow | off", description: "通知を一時停止" },
  { name: "topic", usage: "/topic 文", description: "チャンネルのトピックを変更", channelOnly: true },
  { name: "invite", usage: "/invite @名前 …", description: "メンバーを追加", channelOnly: true },
  { name: "leave", usage: "/leave", description: "チャンネルから退出", channelOnly: true },
  { name: "join", usage: "/join #チャンネル", description: "公開チャンネルに参加" },
  { name: "dm", usage: "/dm @名前", description: "ダイレクトメッセージを開く" },
  { name: "mute", usage: "/mute [1h | 8h | tomorrow]", description: "この会話の通知を止める" },
  { name: "unmute", usage: "/unmute", description: "この会話の通知を再開" },
  { name: "me", usage: "/me 文", description: "動作を斜体で投稿" },
  { name: "shrug", usage: "/shrug [文]", description: "¯\\_(ツ)_/¯ を添えて投稿" },
  { name: "poll", usage: "/poll 質問 | 選択肢 | 選択肢 …", description: "アンケートを作る (/poll だけでフォームを開く)" },
  { name: "日程", usage: "/日程 [題名] 日付 …", description: "日程調整を作る (候補に ○ △ × で答える。日付を続けるとフォームに入る)" },
  { name: "help", usage: "/help", description: "コマンド一覧" },
];

export interface ParsedCommand {
  name: string;
  args: string;
  known: boolean;
}

/** A command's (or a template's, M30) name: letters of any script, digits, `_` and `-` (`/日報`, `/日程`). */
const COMMAND = /^\/([\p{L}\p{N}_-]+)(?:\s+([\s\S]*))?$/u;
const COMMAND_PREFIX = /^\/([\p{L}\p{N}_-]*)$/u;

/** `/name args` at the start of the text; null when the text is not a command at all. */
export function parseSlashCommand(text: string): ParsedCommand | null {
  const match = COMMAND.exec(text.trim());
  if (!match) return null;
  const name = match[1]!.normalize("NFC").toLowerCase();
  return { name, args: (match[2] ?? "").trim(), known: COMMANDS.some((c) => c.name === name) };
}

/** Commands whose name starts with what was typed (`/`, `/st` …); empty once a space follows. */
export function commandCandidates(text: string): SlashCommand[] {
  const match = COMMAND_PREFIX.exec(text);
  if (!match) return [];
  const prefix = match[1]!.normalize("NFC").toLowerCase();
  return COMMANDS.filter((c) => c.name.startsWith(prefix));
}

export function tomorrowMorning(now = new Date()): Date {
  const next = new Date(now);
  next.setDate(next.getDate() + 1);
  next.setHours(8, 0, 0, 0);
  return next;
}

/** `30m`, `1h`, `2d`, `tomorrow` (08:00) → when a pause ends; null for anything else. */
export function parseDuration(arg: string, now = new Date()): Date | null {
  const word = arg.trim().toLowerCase();
  if (word === "tomorrow" || word === "明日") return tomorrowMorning(now);
  const match = /^(\d{1,3})\s*(m|min|h|hour|hours|d|day|days)$/.exec(word);
  if (!match) return null;
  const amount = Number(match[1]);
  const unit = match[2]![0];
  const ms = unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000;
  return new Date(now.getTime() + amount * ms);
}

const LEADING_EMOJI = /^(:[a-z0-9_+-]+:|\p{Extended_Pictographic}(?:️|‍\p{Extended_Pictographic}|[\u{1F3FB}-\u{1F3FF}])*)\s*([\s\S]*)$/u;

/** The optional leading emoji (a glyph or `:shortcode:`) and the text of `/status`. */
export function splitStatus(args: string): { emoji: string | null; text: string } {
  const match = LEADING_EMOJI.exec(args.trim());
  if (!match) return { emoji: null, text: args.trim() };
  const token = match[1]!;
  return { emoji: token.startsWith(":") ? replaceShortcodes(token) : token, text: match[2]!.trim() };
}

/** In a code span, so the underscores do not read as italics (the light markdown has no escapes). */
export const SHRUG = "`¯\\_(ツ)_/¯`";
