/**
 * M65 (docs/AI.md): the AI bots and private summaries.
 *
 * These types mirror docs/AI.md §5 by hand: the server's routes were written in parallel and were not yet in
 * openapi/openapi.json. Switch them to `components["schemas"][…]` (src/api/schema.d.ts, `npm run gen:api`) once the
 * server lands, and keep the names.
 */
import { errorMessageFor } from "./errors";
import { ApiError, describeError } from "./errors";
import { t } from "../i18n";

export type AiModel = "claude-opus-5-5" | "claude-sonnet-5-5" | "claude-haiku-4-5" | "gpt-6.1-sol" | "gpt-6-luna";
/** docs/AI.md §12: the model decides the provider. */
export type AiProviderName = "anthropic" | "openai";
export type AiEffort = "low" | "medium" | "high";
/** M70 (docs/AI.md §13): "ask" = 「AI に聞く」. */
export type AiRunKind = "mention" | "summary" | "ask";
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
  /** null only for a question (ask) not narrowed to one conversation. */
  channel_id: string | null;
  thread_id: string | null;
  scope: AiSummaryScope | null;
  days: number | null;
  /** Markdown. */
  output: string | null;
  error: string | null;
  omitted_count: number;
  created_at: string;
  finished_at: string | null;
  /** Review v0.1.18 #2: where the run is sent (fixed when it was asked for). Absent on an older server. */
  provider?: AiProviderName | null;
  model?: string | null;
  /** M70: the question of an ask run (null for the other kinds). Absent on an older server. */
  question?: string | null;
  /** M70: the messages a done ask run's answer cites as [n] (empty otherwise). Absent on an older server. */
  sources?: AiSourceOut[];
}

/** M70 (docs/AI.md §13.3): a message an answer cites as [n]. */
export interface AiSourceOut {
  n: number;
  message_id: string;
  channel_id: string;
  parent_id: string | null;
  sender_id: string;
  created_at: string;
  /** Plain text around the first matching word. */
  excerpt: string;
}

/** POST /ai/ask (docs/AI.md §13.5): the question with its modifiers (in:# from:@ before: after: …). */
export interface AiAskCreate {
  q: string;
  tz_offset_minutes?: number;
  channel_id?: string | null;
}

/**
 * GET /ai/summaries/target?channel_id= (review v0.1.18 #2, docs/AI.md §5): where a summary of this conversation would
 * go, shown before asking. `reason` (ai_unavailable / ai_private_not_allowed / ai_budget_exceeded) when it cannot be
 * asked now; provider / model / agent_name are given whenever a bot was chosen.
 */
export interface AiSummaryTargetOut {
  available: boolean;
  provider: AiProviderName | null;
  model: string | null;
  agent_name: string | null;
  reason: string | null;
}

/** GET /ai/ask/target?q=&channel_id= (M70): the same shape and reasons as the summary's target. */
export type AiAskTargetOut = AiSummaryTargetOut;

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

/** GET /admin/ai/providers (docs/AI.md §12): whether the server has each provider's API key. */
export interface AiProviderOut {
  name: AiProviderName;
  configured: boolean;
  models: AiModel[];
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

/** The choices of the admin form, grouped by provider (§1: Opus 5.5 is the default; §12: OpenAI). */
export const AI_MODELS: ReadonlyArray<{ value: AiModel; label: string; provider: AiProviderName }> = [
  { value: "claude-opus-5-5", label: "Claude Opus 5.5", provider: "anthropic" },
  { value: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", provider: "anthropic" },
  { value: "claude-haiku-4-5", label: "Claude Haiku 4.5", provider: "anthropic" },
  { value: "gpt-6.1-sol", label: "GPT-6.1 Sol", provider: "openai" },
  { value: "gpt-6-luna", label: "GPT-6 Luna", provider: "openai" },
];
export const AI_PROVIDERS: ReadonlyArray<{ value: AiProviderName; label: string }> = [
  { value: "anthropic", label: "Anthropic" },
  { value: "openai", label: "OpenAI" },
];

/** The provider of a model id (an unknown id counts as Anthropic's, as on the server). */
export function aiProviderOf(model: string): AiProviderName {
  return AI_MODELS.find((m) => m.value === model)?.provider ?? "anthropic";
}

export function aiProviderLabel(name: AiProviderName): string {
  return AI_PROVIDERS.find((p) => p.value === name)?.label ?? name;
}
export const DEFAULT_AI_MODEL: AiModel = "claude-opus-5-5";

export const AI_EFFORTS: ReadonlyArray<{ value: AiEffort; label: string }> = [
  { value: "low", get label() { return t("ai.effort.low"); } },
  { value: "medium", get label() { return t("ai.effort.medium"); } },
  { value: "high", get label() { return t("ai.effort.high"); } },
];

export const AI_CHARACTER_MAX = 4000;

export function aiModelLabel(model: string): string {
  return AI_MODELS.find((m) => m.value === model)?.label ?? model;
}

/**
 * The AI codes' own texts, for a server older than their entries in apps/shared/errors.json (M65/M66); a code that
 * is there wins.
 */
export const AI_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  get ai_unavailable() { return t("ai.error.unavailable"); },
  get ai_budget_exceeded() { return t("ai.error.budgetExceeded"); },
  get ai_daily_limit() { return t("ai.error.dailyLimit"); },
  get ai_private_not_allowed() { return t("ai.error.privateNotAllowed"); },
  get ai_run_not_found() { return t("ai.error.runNotFound"); },
};

/** The line under the 「要約」 choices: where the summary goes, or why it cannot be asked for (null: nothing to say). */
export function summaryTargetLine(target: AiSummaryTargetOut): string | null {
  if (!target.available) {
    const reason = target.reason ?? "";
    return errorMessageFor(reason) ?? AI_ERROR_MESSAGES[reason] ?? t("ai.summary.unavailable");
  }
  if (!target.provider) return null;
  const provider = aiProviderLabel(target.provider);
  return target.agent_name ? t("ai.summary.sentToAgent", { agent: target.agent_name, provider }) : t("ai.summary.sentTo", { provider });
}

/** The caption of a run's result: the provider and model it actually used, e.g. 「OpenAI · gpt-6.1-sol」 (null: unknown). */
export function aiRunCaption(run: Pick<AiRunOut, "provider" | "model">): string | null {
  const provider = run.provider ?? (run.model ? aiProviderOf(run.model) : null);
  if (!provider) return null;
  return run.model ? `${aiProviderLabel(provider)} · ${run.model}` : aiProviderLabel(provider);
}

/** M70: the line before asking: where the question goes, or why it cannot be asked (null: nothing to say). */
export function askTargetLine(target: AiAskTargetOut): string | null {
  if (!target.available) {
    const reason = target.reason ?? "";
    if (reason === "ai_private_not_allowed") return t("ai.ask.privateNotAllowed");
    if (reason === "ai_budget_exceeded") return t("ai.ask.budgetExceeded");
    return errorMessageFor(reason) ?? AI_ERROR_MESSAGES[reason] ?? t("ai.ask.unavailable");
  }
  if (!target.provider) return null;
  const provider = aiProviderLabel(target.provider);
  const where = target.agent_name ? `${target.agent_name} (${provider})` : provider;
  return t("ai.ask.sentTo", { where });
}

/** An answer's citations: [3], [1][4], [1, 4], [1、4]. */
const CITATION = /\[(\d+(?:\s*[,、]\s*\d+)*)\]/g;

/**
 * M70 (docs/AI.md §13.3): the answer's citations as message links on this server (`<base>/m/<id>`, which MessageBody
 * opens in place), one link per number. A group with a number that is not among the sources stays as it was.
 */
export function linkCitations(output: string, sources: readonly AiSourceOut[], baseUrl: string): string {
  const byNumber = new Map(sources.map((s) => [s.n, s]));
  const base = baseUrl.replace(/\/+$/, "");
  return output.replace(CITATION, (whole, group: string) => {
    const numbers = group.split(/\s*[,、]\s*/).map(Number);
    if (!numbers.every((n) => byNumber.has(n))) return whole;
    return numbers.map((n) => `[${n}](${base}/m/${byNumber.get(n)!.message_id})`).join(" ");
  });
}

/** What the reader sees for an error of the AI routes: the AI texts above, else the usual ones (describeError). */
export function describeAiError(err: unknown): string {
  if (err instanceof ApiError && !errorMessageFor(err.code) && AI_ERROR_MESSAGES[err.code]) return AI_ERROR_MESSAGES[err.code]!;
  return describeError(err);
}
