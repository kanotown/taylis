/** Invite links (M12h): `<server>/invite/<token>`; the token is 20-128 URL-safe characters. */

import { ApiError, describeError } from "../api/errors";
import type { InviteOut } from "../api/types";

const TOKEN = /^[A-Za-z0-9_-]{20,128}$/;

export function inviteLink(baseUrl: string, token: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/invite/${token}`;
}

/** The server and the token from a pasted link (trailing path, query and fragment ignored). */
export function parseInviteLink(text: string): { server: string; token: string } | null {
  const match = /^\s*(https?:\/\/[^\s/?#]+)\/invite\/([^\s/?#]+)/i.exec(text);
  if (!match) return null;
  const token = match[2]!;
  return TOKEN.test(token) ? { server: match[1]!, token } : null;
}

export const INVITE_STATUS_LABELS: Record<InviteOut["status"], string> = {
  active: "有効",
  expired: "期限切れ",
  exhausted: "使用済み",
  revoked: "取消済み",
};

export function inviteUsesLabel(invite: InviteOut): string {
  return invite.max_uses === null ? `${invite.use_count} 回使用 (回数無制限)` : `${invite.use_count} / ${invite.max_uses} 回`;
}

const ERROR_TEXT: Record<string, string> = {
  invite_not_found: "この招待リンクは無効です",
  invite_expired: "この招待リンクは期限切れです",
  invite_exhausted: "この招待リンクはすでに使われています",
  invite_revoked: "この招待リンクは取り消されています",
  username_taken: "このユーザー名はすでに使われています",
  password_too_short: "パスワードが短すぎます",
  validation_error: "入力内容を確認してください",
  rate_limited: "しばらく待ってからやり直してください",
};

/** Invite failures in words; anything else gets the shared Japanese error text (ARCHITECTURE.md §9). */
export function inviteErrorText(error: unknown): string {
  return (error instanceof ApiError ? ERROR_TEXT[error.code] : undefined) ?? describeError(error);
}
