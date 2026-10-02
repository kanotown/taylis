/**
 * M72 (CANVAS.md §18.3): 「タスクにする」 on a canvas's checklist item — what the task dialog starts with. Pure: the
 * canvas pane and the tests use it, and the phones port it (M73).
 *
 * - title: the item's text (the box gone, mentions as names, a `📅 YYYY-MM-DD` taken out), 200 characters at most
 * - due date: the item's `📅 YYYY-MM-DD` (the minutes template's way, §4.12)
 * - assignees: the people the item mentions (groups not expanded); offered where the task is shared
 * - where it goes: the rule of a message's 「タスクにする」 (the channel's board when I may add to it; a DM's canvas: mine,
 *   shared in the DM once someone is assigned)
 */
import type { GroupOut, UserPublic } from "../api/types";
import type { ChannelState } from "../sync/types";
import { TASK_LINE, plainText } from "./markdown";
import { mentionsToNames } from "./mentions";
import { canEditBoard, canEditConversationTasks, hasBoard, MAX_TASK_TITLE, type TaskCreateInit } from "./tasks";

const DUE = /📅\s*(\d{4}-\d{2}-\d{2})/u;
const USER_TOKEN = /<@([0-9a-f-]{36})>/g;

export interface ChecklistItem {
  /** The line as it is in the body (`- [ ] …`): the server finds it there (§18.3). */
  line: string;
  /** The text after the box. */
  text: string;
  done: boolean;
}

/** Line `index` of the body, when it is a checklist item. */
export function checklistItem(body: string, index: number): ChecklistItem | null {
  const line = body.split("\n")[index];
  if (line === undefined) return null;
  const match = TASK_LINE.exec(line);
  if (!match) return null;
  return { line, text: (match[3] ?? "").trim(), done: match[2] !== " " };
}

/** A real calendar date in `YYYY-MM-DD` (not 2026-02-30). */
function validDay(value: string): boolean {
  const [y, m, d] = value.split("-").map(Number);
  const date = new Date(Date.UTC(y!, m! - 1, d!));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m! - 1 && date.getUTCDate() === d;
}

/** What the task dialog starts with for checklist item `index` of the canvas `canvasId` in `channel`. */
export function canvasTaskInit(
  canvas: { id: string; body: string },
  index: number,
  channel: ChannelState | undefined,
  users: Map<string, UserPublic>,
  groups: ReadonlyMap<string, GroupOut>,
  isAdmin: boolean,
): TaskCreateInit | null {
  const item = checklistItem(canvas.body, index);
  if (!item) return null;
  const dueMatch = DUE.exec(item.text);
  const dueOn = dueMatch && validDay(dueMatch[1]!) ? dueMatch[1]! : "";
  const title = plainText(mentionsToNames(item.text.replace(DUE, " "), users, groups), MAX_TASK_TITLE);
  const assigneeIds = [...new Set([...item.text.matchAll(USER_TOKEN)].map((m) => m[1]!))].filter((id) => users.has(id));
  const board = channel && canEditBoard(channel, isAdmin) ? channel.id : null;
  const share = channel && !hasBoard(channel) && canEditConversationTasks(channel, isAdmin) ? channel.id : null;
  return {
    channelId: board,
    status: "todo",
    title,
    dueOn,
    assigneeIds: board || share ? assigneeIds : [],
    boardChoices: board ? [board] : [],
    shareChannelId: share,
    sourceCanvasId: canvas.id,
    sourceCanvasLine: item.line,
    sourceCanvasExcerpt: plainText(mentionsToNames(item.text, users, groups), MAX_TASK_TITLE) || null,
  };
}
