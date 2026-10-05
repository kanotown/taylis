/**
 * M65 (docs/AI.md §2.3, §5): the AI status and the summary on screen.
 *
 * - The status (GET /ai/status) is read after every connection; a 404 (a server before M65) means no AI at all and
 *   every entry point hides. A network failure keeps what was known.
 * - One summary at a time is followed (the dialog): POST /ai/summaries answers `pending`, then ai.run_updated brings
 *   running / done / failed. Events can be lost, so after reconnecting an unfinished run is read again (GET /ai/runs/{id}).
 *   A run never goes back (an older answer that arrives late does not replace a newer state).
 */
import type { AiAskCreate, AiAskTargetOut, AiRunOut, AiRunUpdated, AiStatusOut, AiSummaryCreate, AiSummaryScope, AiSummaryTargetOut } from "../api/ai";
import { ApiError } from "../api/errors";
import { t } from "../i18n";

export interface AiApi {
  aiStatus(): Promise<AiStatusOut>;
  createAiSummary(body: AiSummaryCreate): Promise<AiRunOut>;
  getAiRun(runId: string): Promise<AiRunOut>;
  /** Review v0.1.18 #2 (GET /ai/summaries/target). Optional: older fakes. */
  aiSummaryTarget?(channelId: string): Promise<AiSummaryTargetOut>;
  /** M70 「AI に聞く」 (docs/AI.md §13.5). Optional: older fakes. */
  createAiAsk?(body: AiAskCreate): Promise<AiRunOut>;
  aiAskTarget?(q: string, channelId: string | null): Promise<AiAskTargetOut>;
  aiRuns?(kind: "ask"): Promise<AiRunOut[]>;
}

/** M70: the question followed on the search screen. */
export interface AskSession {
  question: string;
  channelId: string | null;
  /** The server's run; null until POST answers. */
  run: AiRunOut | null;
  sending: boolean;
  /** POST failed (shown with 「もう一度」); null otherwise. */
  error: unknown;
}

/** What a summary is of (the menu's choice). */
export type SummaryTarget =
  | { channelId: string; scope: "unread" }
  | { channelId: string; scope: "recent"; days: 1 | 7 }
  | { channelId: string; scope: "thread"; threadId: string };

export interface SummarySession {
  target: SummaryTarget;
  /** The server's run; null until POST answers. */
  run: AiRunOut | null;
  /** POST is on its way. */
  sending: boolean;
  /** POST failed (shown with 「もう一度」); null otherwise. */
  error: unknown;
}

export function isFinished(run: Pick<AiRunOut, "status">): boolean {
  return run.status === "done" || run.status === "failed";
}

const RANK: Record<AiRunOut["status"], number> = { pending: 0, running: 1, done: 2, failed: 2 };

/** The run that is further along (same id); on a tie the incoming one (the server's latest word). */
export function laterRun(current: AiRunOut | null | undefined, incoming: AiRunOut): AiRunOut {
  if (!current || current.id !== incoming.id) return incoming;
  if (isFinished(current) && !isFinished(incoming)) return current;
  return RANK[incoming.status] >= RANK[current.status] ? incoming : current;
}

/** The body of POST /ai/summaries; the zone makes 「直近 1 日」 and the fallback of 「未読」 the reader's days. */
export function summaryBody(target: SummaryTarget, tzOffsetMinutes: number = -new Date().getTimezoneOffset()): AiSummaryCreate {
  const body: AiSummaryCreate = { channel_id: target.channelId, scope: target.scope, tz_offset_minutes: tzOffsetMinutes };
  if (target.scope === "thread") body.thread_id = target.threadId;
  if (target.scope === "recent") body.days = target.days;
  return body;
}

/** The dialog's title. */
export function summaryTitle(target: { scope: AiSummaryScope; days?: number | null }): string {
  if (target.scope === "thread") return t("ai.summary.titleThread");
  if (target.scope === "unread") return t("ai.summary.titleUnread");
  return t("ai.summary.titleDays", { days: target.days ?? 1 });
}

/** Events that came before POST answered (the worker can be quicker than the response). */
const EARLY_RUNS = 20;

export class AiHub {
  summary: SummarySession | null = null;
  version = 0;
  private readonly listeners = new Set<() => void>();
  /** Bumped by every new summary and by closing: an older answer is dropped. */
  private attempt = 0;
  private readonly early = new Map<string, AiRunOut>();
  private statusRead = 0;

  constructor(
    private readonly deps: {
      api: AiApi | null;
      /** Where the status goes (the store: the rows' 「AI」 badge, the menus, the mention list). */
      setStatus: (status: AiStatusOut | null) => void;
      isOnline?: () => boolean;
    },
  ) {}

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(): void {
    this.version += 1;
    for (const listener of this.listeners) listener();
  }

  /** After every connection (start and reconnect). */
  online(): void {
    void this.loadStatus();
    void this.refreshSummary();
    void this.refreshAsk();
  }

  // --- 「AI に聞く」 (M70, docs/AI.md §13.6): one question at a time, followed like a summary -------------------------

  ask: AskSession | null = null;
  private askAttempt = 0;

  /** Whether this server has 「AI に聞く」 (the client can ask it). */
  get canAsk(): boolean {
    return !!this.deps.api?.createAiAsk;
  }

  /** Where the question would go; null when it cannot be told (a server without the route, or a failure). */
  async askTarget(q: string, channelId: string | null): Promise<AiAskTargetOut | null> {
    const api = this.deps.api;
    if (!api?.aiAskTarget) return null;
    try {
      const target = await api.aiAskTarget(q, channelId);
      return target && typeof target.available === "boolean" ? target : null;
    } catch (err) {
      if (!(err instanceof ApiError && (err.status === 404 || err.status === 422))) console.warn("could not read the ask target", err);
      return null;
    }
  }

  /** My recent questions (GET /ai/runs?kind=ask), newest first; null when they cannot be read. */
  async askHistory(): Promise<AiRunOut[] | null> {
    const api = this.deps.api;
    if (!api?.aiRuns) return null;
    try {
      return (await api.aiRuns("ask")).filter((run) => run.kind === "ask");
    } catch (err) {
      console.warn("could not read the questions", err);
      return null;
    }
  }

  /** 「AI に聞く」: replaces the question followed before. */
  startAsk(question: string, channelId: string | null): Promise<void> {
    this.ask = { question, channelId, run: null, sending: false, error: null };
    return this.sendAsk();
  }

  /** 「もう一度」 after POST failed. */
  retryAsk(): Promise<void> {
    if (!this.ask || this.ask.run || this.ask.sending) return Promise.resolve();
    return this.sendAsk();
  }

  /** A past question from the history: shown (and followed while it is not finished). */
  showAskRun(run: AiRunOut): void {
    this.askAttempt += 1;
    this.ask = { question: run.question ?? "", channelId: run.channel_id, run, sending: false, error: null };
    this.changed();
    if (!isFinished(run)) void this.refreshAsk();
  }

  closeAsk(): void {
    if (!this.ask) return;
    this.askAttempt += 1;
    this.ask = null;
    this.changed();
  }

  private async sendAsk(): Promise<void> {
    const api = this.deps.api;
    const session = this.ask;
    if (!session) return;
    const id = ++this.askAttempt;
    this.ask = { ...session, sending: true, error: null };
    this.changed();
    try {
      if (!api?.createAiAsk) throw new ApiError(409, "ai_unavailable", "AI is not available");
      const run = await api.createAiAsk({ q: session.question, channel_id: session.channelId, tz_offset_minutes: -new Date().getTimezoneOffset() });
      if (id !== this.askAttempt || !this.ask) return;
      this.ask = { ...this.ask, sending: false, run: laterRun(this.early.get(run.id), run) };
      this.early.delete(run.id);
    } catch (err) {
      if (id !== this.askAttempt || !this.ask) return;
      this.ask = { ...this.ask, sending: false, error: err };
    }
    this.changed();
  }

  /** Reconnected (or a past question opened): an unfinished question is read again. */
  async refreshAsk(): Promise<void> {
    const api = this.deps.api;
    const run = this.ask?.run;
    if (!api || !run || isFinished(run)) return;
    const id = this.askAttempt;
    try {
      const fresh = await api.getAiRun(run.id);
      if (id !== this.askAttempt || this.ask?.run?.id !== fresh.id) return;
      const next = laterRun(this.ask.run, fresh);
      if (next === this.ask.run) return;
      this.ask = { ...this.ask, run: next };
      this.changed();
    } catch (err) {
      console.warn("could not read the question again", err);
    }
  }

  private applyAsk(run: AiRunOut): void {
    const current = this.ask?.run;
    if (current && current.id === run.id) {
      const next = laterRun(current, run);
      if (next === current) return;
      this.ask = { ...this.ask!, run: next };
      this.changed();
      return;
    }
    if (this.ask && this.ask.sending) this.keepEarly(run);
  }

  private keepEarly(run: AiRunOut): void {
    this.early.set(run.id, laterRun(this.early.get(run.id), run));
    if (this.early.size > EARLY_RUNS) this.early.delete(this.early.keys().next().value!);
  }

  async loadStatus(): Promise<void> {
    const api = this.deps.api;
    if (!api) {
      this.deps.setStatus(null);
      return;
    }
    const id = ++this.statusRead;
    try {
      const status = await api.aiStatus();
      if (id === this.statusRead) this.deps.setStatus(status);
    } catch (err) {
      if (id !== this.statusRead) return;
      // 404: a server without AI. Any other refusal hides it too; a network or 5xx failure keeps what was known.
      if (err instanceof ApiError && err.status >= 400 && err.status < 500 && err.status !== 429) this.deps.setStatus(null);
      else console.warn("could not load the AI status", err);
    }
  }

  /**
   * Where a summary of the conversation would go (review v0.1.18 #2), read when the 「要約」 choices open. null when it
   * cannot be told — a server without the route (404), or any failure: the choices then stay as before, with no line.
   */
  async summaryTarget(channelId: string): Promise<AiSummaryTargetOut | null> {
    const api = this.deps.api;
    if (!api?.aiSummaryTarget) return null;
    try {
      const target = await api.aiSummaryTarget(channelId);
      return target && typeof target.available === "boolean" ? target : null;
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 404)) console.warn("could not read the summary target", err);
      return null;
    }
  }

  /** 「要約」: replaces the summary followed before. */
  startSummary(target: SummaryTarget): Promise<void> {
    this.summary = { target, run: null, sending: false, error: null };
    return this.send();
  }

  /** 「もう一度」 after POST failed. */
  retry(): Promise<void> {
    if (!this.summary || this.summary.run || this.summary.sending) return Promise.resolve();
    return this.send();
  }

  private async send(): Promise<void> {
    const api = this.deps.api;
    const session = this.summary;
    if (!session) return;
    const id = ++this.attempt;
    this.summary = { ...session, sending: true, error: null };
    this.changed();
    try {
      if (!api) throw new ApiError(409, "ai_unavailable", "AI is not available");
      const run = await api.createAiSummary(summaryBody(session.target));
      if (id !== this.attempt || !this.summary) return;
      this.summary = { ...this.summary, sending: false, run: laterRun(this.early.get(run.id), run) };
      this.early.delete(run.id);
    } catch (err) {
      if (id !== this.attempt || !this.summary) return;
      this.summary = { ...this.summary, sending: false, error: err };
    }
    this.changed();
  }

  /** The dialog closed: nothing is followed any more. */
  closeSummary(): void {
    if (!this.summary) return;
    this.attempt += 1;
    this.summary = null;
    this.changed();
  }

  /** ai.run_updated. */
  applyEvent(data: AiRunUpdated): void {
    const run = data?.run;
    if (run?.kind === "ask") {
      this.applyAsk(run);
      return;
    }
    if (!run || run.kind !== "summary") return;
    const current = this.summary?.run;
    if (current && current.id === run.id) {
      const next = laterRun(current, run);
      if (next === current) return;
      this.summary = { ...this.summary!, run: next };
      this.changed();
      return;
    }
    // Perhaps the answer to the POST on its way.
    if (this.summary && this.summary.sending) this.keepEarly(run);
  }

  /** Reconnected: an unfinished run on screen is read again (its events may have been lost). */
  async refreshSummary(): Promise<void> {
    const api = this.deps.api;
    const run = this.summary?.run;
    if (!api || !run || isFinished(run)) return;
    const id = this.attempt;
    try {
      const fresh = await api.getAiRun(run.id);
      if (id !== this.attempt || this.summary?.run?.id !== fresh.id) return;
      const next = laterRun(this.summary.run, fresh);
      if (next === this.summary.run) return;
      this.summary = { ...this.summary, run: next };
      this.changed();
    } catch (err) {
      console.warn("could not read the summary again", err);
    }
  }
}
