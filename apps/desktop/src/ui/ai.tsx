/**
 * M65 (docs/AI.md §6, Desktop / Web): the AI pieces the screens share — the 「AI」 badge, the channel notice (§4), the
 * 「要約」 menu items and the summary dialog.
 */
import { Loader2, RotateCw, Sparkles } from "lucide-react";
import { useSyncExternalStore } from "react";

import { AI_PROVIDERS, aiProviderOf, type AiProviderName, describeAiError } from "../api/ai";
import type { AppController } from "../state/app";
import { type AiHub, isFinished, type SummaryTarget, summaryTitle } from "../sync/ai";
import type { Store } from "../sync/store";
import type { ChannelState } from "../sync/types";
import { MessageBody } from "./MessageBody";
import { Button, cn, MenuItem, MenuLabel, MenuSeparator, Modal } from "./primitives";

/** The 「AI」 mark where the BOT mark is shown for other bots. */
export function AiBadge({ className }: { className?: string }) {
  return (
    <span className={cn("rounded bg-accent-soft px-1 text-[10px] font-bold text-accent", className)} title="AI のボット (メンションすると返事をします)">
      AI
    </span>
  );
}

/** The §4 notice for a conversation whose members include AI bots; null when none does. */
export function aiNoticeText(store: Pick<Store, "aiAgentOf">, memberIds: Iterable<string>): string | null {
  const names: string[] = [];
  const providers = new Set<AiProviderName>();
  for (const id of memberIds) {
    const agent = store.aiAgentOf(id);
    if (agent) {
      names.push(agent.name);
      providers.add(aiProviderOf(agent.model));
    }
  }
  if (names.length === 0) return null;
  // §12: each bot's model decides where its part goes (Anthropic, OpenAI or both).
  const where = AI_PROVIDERS.filter((p) => providers.has(p.value)).map((p) => p.label).join(" と ");
  return `AI (${names.join("、")}) が参加しています。メンションしたときと要約のときに、会話の一部が ${where} の API に送られます`;
}

export function AiChannelNotice({ controller, memberIds }: { controller: AppController; memberIds: string[] | null }) {
  const text = memberIds ? aiNoticeText(controller.store, memberIds) : null;
  if (!text) return null;
  return (
    <p role="note" aria-label="AI について" className="flex items-start gap-2 rounded-lg border border-accent/30 bg-accent-soft/40 px-3 py-2 text-xs text-ink">
      <Sparkles size={14} className="mt-0.5 shrink-0 text-accent" />
      <span>{text}</span>
    </p>
  );
}

/** Summaries can be asked for (docs/AI.md §5 summary_available). */
export function summaryAvailable(controller: AppController): boolean {
  return !!controller.store.aiStatus?.summary_available && !!controller.engine;
}

/** The conversation's ⋯ menu: 「要約」 (未読 / 直近 1 日 / 直近 7 日). Nothing when summaries are not available. */
export function SummaryMenuItems({ controller, channel, onSummary, separator = true }: {
  controller: AppController;
  channel: ChannelState;
  onSummary: (target: SummaryTarget) => void;
  separator?: boolean;
}) {
  if (!summaryAvailable(controller) || !channel.isMember) return null;
  return (
    <>
      {separator && <MenuSeparator />}
      <MenuLabel>要約 (自分にだけ見えます)</MenuLabel>
      <MenuItem onSelect={() => onSummary({ channelId: channel.id, scope: "unread" })}>未読を要約</MenuItem>
      <MenuItem onSelect={() => onSummary({ channelId: channel.id, scope: "recent", days: 1 })}>直近 1 日を要約</MenuItem>
      <MenuItem onSelect={() => onSummary({ channelId: channel.id, scope: "recent", days: 7 })}>直近 7 日を要約</MenuItem>
    </>
  );
}

function useAiHub(controller: AppController): AiHub | null {
  const hub = controller.engine?.ai ?? null;
  useSyncExternalStore(
    (listener) => (hub ? hub.subscribe(listener) : () => {}),
    () => hub?.version ?? 0,
  );
  return hub;
}

/** Starts a summary (the engine's hub posts it); the dialog below follows it. */
export function startSummary(controller: AppController, target: SummaryTarget): void {
  void controller.engine?.ai.startSummary(target);
}

/**
 * The summary on screen, mounted once by the main screen and shown while the hub follows one (startSummary): progress
 * while pending / running, then the Markdown (the message renderer), the omitted rows note, or the error in Japanese.
 * Only the one who asked sees it (nothing is posted). Closing it stops following it.
 */
export function SummaryDialog({ controller }: { controller: AppController }) {
  const hub = useAiHub(controller);
  const session = hub?.summary ?? null;
  const close = () => hub?.closeSummary();
  if (!session) return null;
  const store = controller.store;
  const channel = store.getChannel(session.target.channelId);
  const where = channel ? (channel.type === "public" || channel.type === "private" ? `#${channel.name}` : "この会話") : "";
  const run = session.run;
  const title = summaryTitle(session.target.scope === "recent" ? { scope: "recent", days: session.target.days } : { scope: session.target.scope });
  return (
    <Modal onClose={close} title={title} description={`${where}${where ? " · " : ""}自分にだけ見えます`} className="flex w-[640px] flex-col">
      <div className="mt-4 min-h-[120px]" aria-live="polite" data-testid="ai-summary">
        {session.error !== null && session.error !== undefined ? (
          <div className="space-y-3">
            <p role="alert" className="rounded-lg bg-rose-500/10 px-3 py-2 text-sm text-danger">{describeAiError(session.error)}</p>
            <Button size="sm" variant="secondary" onClick={() => void hub?.retry()}>
              <RotateCw size={14} /> もう一度
            </Button>
          </div>
        ) : !run || !isFinished(run) ? (
          <div className="flex items-center gap-2 py-6 text-sm text-muted" role="status">
            <Loader2 size={16} className="animate-spin" />
            {!run || run.status === "pending" ? "要約を準備しています…" : "要約を書いています…"}
          </div>
        ) : run.status === "failed" ? (
          <p role="alert" className="rounded-lg bg-rose-500/10 px-3 py-2 text-sm text-danger">
            要約できませんでした{run.error ? `: ${run.error}` : ""}
          </p>
        ) : (
          <div className="space-y-2">
            {run.omitted_count > 0 && <p className="text-xs text-muted">長すぎるため、古い {run.omitted_count} 件は省きました</p>}
            {run.output?.trim() ? (
              <MessageBody body={run.output} users={store.users} groups={store.groups} customEmoji={store.customEmoji} controller={controller} className="text-sm" />
            ) : (
              <p className="text-sm text-muted">要約する投稿がありませんでした</p>
            )}
          </div>
        )}
      </div>
      {run?.status === "done" && <p className="mt-4 text-[11px] text-muted">AI が書いた要約です。間違いがあるかもしれません。</p>}
      <div className="mt-3 flex justify-end">
        <Button variant="secondary" onClick={close}>閉じる</Button>
      </div>
    </Modal>
  );
}
