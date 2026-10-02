/**
 * M65 (docs/AI.md §2.3, §5): the AI status and the summary on screen.
 *
 * - The status (GET /ai/status) is read after every connection; a 404 (a server before M65) means no AI at all and
 *   every entry point hides. A network failure keeps what was known.
 * - One summary at a time is followed (the dialog): POST /ai/summaries answers `pending`, then ai.run_updated brings
 *   running / done / failed. Events can be lost, so after reconnecting an unfinished run is read again (GET /ai/runs/{id}).
 *   A run never goes back (an older answer that arrives late does not replace a newer state).
 */
import type { AiRunOut, AiRunUpdated, AiStatusOut, AiSummaryCreate, AiSummaryScope, AiSummaryTargetOut } from "../api/ai";
import { ApiError } from "../api/errors";

export interface AiApi {
  aiStatus(): Promise<AiStatusOut>;
  createAiSummary(body: AiSummaryCreate): Promise<AiRunOut>;
  getAiRun(runId: string): Promise<AiRunOut>;
  /** Review v0.1.18 #2 (GET /ai/summaries/target). Optional: older fakes. */
  aiSummaryTarget?(channelId: string): Promise<AiSummaryTargetOut>;
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
  if (target.scope === "thread") return "スレッドの要約";
  if (target.scope === "unread") return "未読の要約";
  return `直近 ${target.days ?? 1} 日の要約`;
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
    if (!run || run.kind !== "summary") return;
    const current = this.summary?.run;
    if (current && current.id === run.id) {
      const next = laterRun(current, run);
      if (next === current) return;
      this.summary = { ...this.summary!, run: next };
      this.changed();
      return;
    }
    if (this.summary && this.summary.sending) {
      // Perhaps the answer to the POST on its way.
      this.early.set(run.id, laterRun(this.early.get(run.id), run));
      if (this.early.size > EARLY_RUNS) this.early.delete(this.early.keys().next().value!);
    }
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
