/**
 * 操作ボタン (M143, docs/ACTIONS.md §9.1): the rules of the buttons, apart from how they look. Pressing calls the relay once
 * through the server; a network failure sends the same request again with the same client_invoke_id (the server then
 * answers with the earlier result and never calls the relay twice).
 */
import type { ActionInvokeOut, ActionListOut, ActionOut, ActionStatusOut } from "../api/types";
import { sinceLabel } from "./format";
import { ApiError, describeError, NetworkError } from "../api/errors";
import { t } from "../i18n";

export interface ActionGroup {
  /** The group's name; null for the buttons without one (drawn last). */
  label: string | null;
  actions: ActionOut[];
}

/** The buttons in the administrator's order, grouped by `group_label` (a group where its first button is; ungrouped last). */
export function groupActions(actions: readonly ActionOut[]): ActionGroup[] {
  const sorted = [...actions].sort((a, b) => a.position - b.position);
  const groups = new Map<string, ActionOut[]>();
  const loose: ActionOut[] = [];
  for (const action of sorted) {
    const label = action.group_label?.trim();
    if (!label) {
      loose.push(action);
      continue;
    }
    const list = groups.get(label);
    if (list) list.push(action);
    else groups.set(label, [action]);
  }
  const out: ActionGroup[] = [...groups.entries()].map(([label, list]) => ({ label, actions: list }));
  if (loose.length) out.push({ label: null, actions: loose });
  return out;
}

/** 「研究室の鍵：開ける」, or the name alone. */
export function actionTitle(action: Pick<ActionOut, "name" | "group_label">): string {
  return action.group_label ? t("actions.title", { group: action.group_label, name: action.name }) : action.name;
}

/** The confirmation's sentence: the administrator's, else 「研究室の鍵：開ける を実行しますか？」. */
export function confirmText(action: ActionOut): string {
  return action.confirm_text?.trim() || t("actions.confirm", { name: actionTitle(action) });
}

/** The buttons to draw (none while off, for guests, or when I may press nothing). */
export function pressable(list: ActionListOut | null | undefined): ActionOut[] {
  return list && list.enabled ? list.actions : [];
}

/** Whether they also go on the 在室状況 page and the attendance pill's menu (the workspace setting). */
export function onAttendance(list: ActionListOut | null | undefined): ActionOut[] {
  return list && list.enabled && list.show_on_attendance ? list.actions : [];
}

/** What to say after a press: the relay's message if it gave one, else a sentence for the outcome. */
export function resultText(out: ActionInvokeOut, action: Pick<ActionOut, "name" | "group_label">): { ok: boolean; text: string } {
  if (out.ok) return { ok: true, text: out.message || t("actions.done", { name: actionTitle(action) }) };
  if (out.message) return { ok: false, text: out.message };
  switch (out.error) {
    case "timeout":
      return { ok: false, text: t("actions.error.timeout") };
    case "network":
      return { ok: false, text: t("actions.error.unreachable") };
    case "interrupted":
      return { ok: false, text: t("actions.error.interrupted") };
    case "secret_missing":
    case "url_not_allowed":
      return { ok: false, text: t("actions.error.setup") };
    case "relay_error":
      return { ok: false, text: t("actions.error.relay", { status: String(out.status_code ?? "?") }) };
    default:
      return { ok: false, text: out.status === "pending" ? t("actions.error.pending") : t("actions.error.failed") };
  }
}

/** The text for a press the server refused (429, permission, off) or that could not reach the server. */
export function refusalText(error: unknown): string {
  if (error instanceof ApiError && error.status === 429) return t("actions.error.tooFast");
  return describeError(error);
}

/** A new id per press (crypto.randomUUID where there is one). */
export function newInvokeId(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c?.randomUUID) return c.randomUUID();
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * One press: the server calls the relay once. A network failure (no answer from our server) is sent again with the same
 * id, up to `attempts` times in all; the server answers a repeat with the first result instead of calling again.
 */
export async function invokeOnce(
  invoke: (actionId: string, clientInvokeId: string) => Promise<ActionInvokeOut>,
  actionId: string,
  options: { attempts?: number; wait?: (ms: number) => Promise<void>; id?: string } = {},
): Promise<ActionInvokeOut> {
  const id = options.id ?? newInvokeId();
  const attempts = options.attempts ?? 3;
  const wait = options.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 1; ; attempt++) {
    try {
      return await invoke(actionId, id);
    } catch (error) {
      if (!(error instanceof NetworkError) || attempt >= attempts) throw error;
      await wait(1000 * attempt);
    }
  }
}

// --- the state of what the buttons operate (docs/ACTIONS.md §12) ---------------------------------------------------------

/** The key a group's state is held by: "g:<label>", or "a:<id>" for a button without a group (its own group). */
export function statusKey(groupLabel: string | null | undefined, actionId: string): string {
  const label = groupLabel?.trim();
  return label ? `g:${label}` : `a:${actionId}`;
}

const STATUS_ERRORS = {
  timeout: "actions.status.error.timeout",
  network: "actions.status.error.unreachable",
  relay_error: "actions.status.error.relay",
  invalid_answer: "actions.status.error.invalid",
  secret_missing: "actions.status.error.setup",
  url_not_allowed: "actions.status.error.setup",
} as const;

/** 「状態を取得できませんでした：…」 with the relay's message, else a sentence for the reason. */
export function statusFailureText(status: Pick<ActionStatusOut, "error" | "message">): string {
  const key = STATUS_ERRORS[status.error as keyof typeof STATUS_ERRORS] ?? "actions.status.error.failed";
  return t("actions.status.failed", { reason: status.message || t(key) });
}

/** 「たった今確認」「3 分前に確認」, or the time (「昨日 10:23 に確認」) an hour or more ago. */
export function checkedLabel(iso: string, now: Date = new Date()): string {
  const at = new Date(iso).getTime();
  if (Number.isNaN(at)) return "";
  const minutes = Math.floor(Math.max(0, now.getTime() - at) / 60_000);
  if (minutes < 1) return t("actions.status.checkedNow");
  if (minutes < 60) return t("actions.status.checkedMinutes", { count: String(minutes) });
  return t("actions.status.checkedAt", { at: sinceLabel(iso, now) });
}

/** The details as one line: 「電池 85% · ドア 閉」. */
export function statusDetails(status: ActionStatusOut): string {
  return (status.status?.details ?? []).map((d) => `${d.label} ${d.value}`).join(" · ");
}
