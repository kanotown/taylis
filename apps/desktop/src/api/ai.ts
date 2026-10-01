/**
 * M65 (docs/AI.md): the AI bots and private summaries.
 *
 * These types mirror docs/AI.md §5 by hand: the server's routes were written in parallel and were not yet in
 * openapi/openapi.json. Switch them to `components["schemas"][…]` (src/api/schema.d.ts, `npm run gen:api`) once the
 * server lands, and keep the names.
 */
import { ERROR_MESSAGES } from "./errorMessages";
import { ApiError, describeError } from "./errors";

export type AiModel = "claude-opus-5-5" | "claude-sonnet-5-5" | "claude-haiku-4-5";
export type AiEffort = "low" | "medium" | "high";
export type AiRunKind = "mention" | "summary";
export type AiRunStatus = "pending" | "running" | "done" | "failed";
export type AiSummaryScope = "unread" | "thread" | "recent";

export interface AiAgentOut {
  id: string;
  bot_user_id: string;
  username: string;
  name: string;
  character: string;
  model: AiModel;
  effort: AiEffort;
  allow_private: boolean;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

export interface AiAgentPublic {
  id: string;
  bot_user_id: string;
  name: string;
  model: AiModel;
}

export interface AiStatusOut {
  available: boolean;
  summary_available: boolean;
  agents: AiAgentPublic[];
}

export interface AiRunOut {
  id: string;
  kind: AiRunKind;
  status: AiRunStatus;
  channel_id: string;
  thread_id: string | null;
  scope: AiSummaryScope | null;
  days: number | null;
  /** Markdown. */
  output: string | null;
  error: string | null;
  omitted_count: number;
  created_at: string;
  finished_at: string | null;
}

export interface AiUsageByAgent {
  agent_id: string;
  name: string;
  runs: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
}

export interface AiUsageByUser {
  user_id: string;
  runs: number;
  cost_usd: number;
}

export interface AiUsageOut {
  /** "YYYY-MM" */
  month: string;
  budget_usd: number;
  total_cost_usd: number;
  total_runs: number;
  by_agent: AiUsageByAgent[];
  by_user: AiUsageByUser[];
}

export interface AiAgentCreate {
  username: string;
  name: string;
  character: string;
  model: AiModel;
  effort?: AiEffort;
  allow_private?: boolean;
  enabled?: boolean;
}

/** PATCH: only the fields sent change; the username never does. */
export type AiAgentUpdate = Partial<Omit<AiAgentCreate, "username">>;

export interface AiSummaryCreate {
  channel_id: string;
  scope: AiSummaryScope;
  thread_id?: string | null;
  days?: number | null;
  tz_offset_minutes?: number;
}

/** The event `ai.run_updated` (to the one who asked, every device of theirs). */
export interface AiRunUpdated {
  run: AiRunOut;
}

/** The choices of the admin form (§1: Opus 5.5 is the default). */
export const AI_MODELS: ReadonlyArray<{ value: AiModel; label: string }> = [
  { value: "claude-opus-5-5", label: "Claude Opus 5.5" },
  { value: "claude-sonnet-5-5", label: "Claude Sonnet 5.5" },
  { value: "claude-haiku-4-5", label: "Claude Haiku 4.5" },
];
export const DEFAULT_AI_MODEL: AiModel = "claude-opus-5-5";

export const AI_EFFORTS: ReadonlyArray<{ value: AiEffort; label: string }> = [
  { value: "low", label: "少なめ (速い)" },
  { value: "medium", label: "ふつう" },
  { value: "high", label: "多め (じっくり)" },
];

export const AI_CHARACTER_MAX = 4000;

export function aiModelLabel(model: string): string {
  return AI_MODELS.find((m) => m.value === model)?.label ?? model;
}

/**
 * The AI codes in Japanese. They are not in apps/shared/errors.json yet (the server and the phones add them in
 * M65/M66); a code that is there wins.
 */
export const AI_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  ai_unavailable: "AI は今使えません (管理者の設定を確認してください)",
  ai_budget_exceeded: "今月の AI の利用上限に達しました。来月まで要約は使えません",
  ai_daily_limit: "今日の AI の利用回数の上限に達しました。明日またお試しください",
  ai_private_not_allowed: "このボットは非公開チャンネルと DM には参加できません (管理画面の「非公開チャンネルと DM を許す」)",
  ai_run_not_found: "要約が見つかりません",
};

/** What the reader sees for an error of the AI routes: the AI texts above, else the usual ones (describeError). */
export function describeAiError(err: unknown): string {
  if (err instanceof ApiError && !ERROR_MESSAGES[err.code] && AI_ERROR_MESSAGES[err.code]) return AI_ERROR_MESSAGES[err.code]!;
  return describeError(err);
}
