import { AlarmClock, Bookmark, BookmarkCheck, ClipboardCheck, Copy, Forward, Link, ListTodo, type LucideIcon, Mail, MessageSquare, Pencil, Pin, PinOff, Trash2, Users } from "lucide-react";

import type { MessageState } from "../sync/types";

/**
 * The actions on one message, shared by the hover bar with its 「その他」 menu (Timeline.tsx) and the long-press sheet
 * (MessageActionsSheet.tsx), so both offer the same things under the same conditions. Each surface runs them itself.
 */
export type MessageActionKey =
  | "reactions" | "thread" | "edit" | "copyText" | "save" | "remind" | "task" | "review" | "unread" | "copyLink" | "share" | "pin" | "delete";

export interface MessageActionContext {
  message: MessageState;
  /** The message is mine. */
  mine: boolean;
  isAdmin: boolean;
  saved: boolean;
  /** Threads are offered for the row (an onOpenThread). */
  thread: boolean;
  /** Editing in place: my own message, with the conversation open (not a row of the Times feed). */
  editable: boolean;
  /** 「リアクションした人」 is offered (while the message has reactions). */
  showReactions: boolean;
  canMakeTask: boolean;
  canRequestReview: boolean;
  unreadOffered: boolean;
}

export interface MessageAction {
  key: MessageActionKey;
  label: string;
  icon: LucideIcon;
  danger?: boolean;
}

/** Every action the message offers, in the phone sheet's order (iOS MessageActions.swift, Android MessageActions.kt). */
export function messageActions(ctx: MessageActionContext): MessageAction[] {
  const { message } = ctx;
  const all: Array<MessageAction | false> = [
    ctx.showReactions && (message.reactions ?? []).length > 0 && { key: "reactions", label: "リアクションした人", icon: Users },
    ctx.thread && { key: "thread", label: "スレッドで返信", icon: MessageSquare },
    ctx.editable && { key: "edit", label: "編集", icon: Pencil },
    !!message.body && { key: "copyText", label: "テキストをコピー", icon: Copy },
    { key: "save", label: ctx.saved ? "保存を解除" : "あとで見る (保存)", icon: ctx.saved ? BookmarkCheck : Bookmark },
    { key: "remind", label: "リマインド…", icon: AlarmClock },
    ctx.canMakeTask && { key: "task", label: "タスクにする", icon: ListTodo },
    ctx.canRequestReview && { key: "review", label: "レビューを依頼", icon: ClipboardCheck },
    ctx.unreadOffered && { key: "unread", label: "ここから未読にする", icon: Mail },
    { key: "copyLink", label: "リンクをコピー", icon: Link },
    { key: "share", label: "別のチャンネルに共有…", icon: Forward },
    { key: "pin", label: message.pinned_at ? "ピン留めを外す" : "チャンネルにピン留め", icon: message.pinned_at ? PinOff : Pin },
    (ctx.mine || ctx.isAdmin) && { key: "delete", label: "削除", icon: Trash2, danger: true },
  ];
  return all.filter((action): action is MessageAction => !!action);
}

/** The hover bar's own buttons after the quick reactions and 「リアクションを追加」 (Slack); the rest are in ⋯. */
export const HOVER_BAR_ACTIONS: readonly MessageActionKey[] = ["thread", "save", "edit"];

/** The hover bar's 「その他」 menu, in groups (a separator between them); 「削除」 last. */
export const HOVER_MENU_GROUPS: readonly (readonly MessageActionKey[])[] = [
  ["copyLink", "share", "remind"],
  ["task", "review"],
  ["reactions", "pin", "unread"],
  ["delete"],
];

/** The hover menu's groups, each holding only what the message offers; empty groups left out. */
export function hoverMenuGroups(actions: readonly MessageAction[]): MessageAction[][] {
  const byKey = new Map(actions.map((action) => [action.key, action]));
  return HOVER_MENU_GROUPS.map((group) => group.flatMap((key) => byKey.get(key) ?? [])).filter((group) => group.length > 0);
}

/**
 * Below this row width (px) the hover bar leaves out its quick reactions (they stay a click away in 「リアクションを追加」),
 * so it never runs past the row (the thread pane, a narrow window). 0 (not laid out yet, a test's DOM) counts as wide.
 */
export const ROW_ACTIONS_QUICK_MIN = 420;

export function rowFitsQuickReactions(width: number): boolean {
  return !(width > 0) || width >= ROW_ACTIONS_QUICK_MIN;
}
