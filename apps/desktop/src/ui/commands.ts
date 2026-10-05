/** Slash commands (M13b): a few Slack-style shortcuts that map onto existing actions, client-side only. */

import { replaceShortcodes } from "./emoji";
import { t } from "../i18n";

export interface SlashCommand {
  name: string;
  usage: string;
  description: string;
  /** Not available in a DM. */
  channelOnly?: boolean;
}

export const COMMANDS: readonly SlashCommand[] = [
  { name: "status", get usage() { return t("commands.status.usage"); }, get description() { return t("commands.status.description"); } },
  { name: "dnd", usage: "/dnd 30m | 1h | 2h | 4h | tomorrow | off", get description() { return t("commands.dnd.description"); } },
  { name: "topic", get usage() { return t("commands.topic.usage"); }, get description() { return t("commands.topic.description"); }, channelOnly: true },
  { name: "invite", get usage() { return t("commands.invite.usage"); }, get description() { return t("commands.invite.description"); }, channelOnly: true },
  { name: "leave", usage: "/leave", get description() { return t("commands.leave.description"); }, channelOnly: true },
  { name: "join", get usage() { return t("commands.join.usage"); }, get description() { return t("commands.join.description"); } },
  { name: "dm", get usage() { return t("command.dmUsage"); }, get description() { return t("commands.dm.description"); } },
  { name: "mute", usage: "/mute [1h | 8h | tomorrow]", get description() { return t("commands.mute.description"); } },
  { name: "unmute", usage: "/unmute", get description() { return t("commands.unmute.description"); } },
  { name: "me", get usage() { return t("commands.me.usage"); }, get description() { return t("commands.me.description"); } },
  { name: "shrug", get usage() { return t("commands.shrug.usage"); }, get description() { return t("commands.shrug.description"); } },
  { name: "poll", get usage() { return t("command.pollUsage"); }, get description() { return t("commands.poll.description"); } },
  { name: "日程", get usage() { return t("commands.schedule.usage"); }, get description() { return t("commands.schedule.description"); } },
  { name: "help", usage: "/help", get description() { return t("commands.help.description"); } },
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
