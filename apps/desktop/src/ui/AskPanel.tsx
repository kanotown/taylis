/**
 * M70 (docs/AI.md §13.6): 「AI に聞く」 on the search screen. The words in the search box (and the filters picked from the
 * menus, as modifiers) are the question; the server searches as the asker and answers from what it found, citing [n].
 * The bar says where the question goes before asking; the panel follows the run (progress, the Markdown answer with its
 * [n] as links into the conversation, the cited messages, the provider and model) and lists past questions. Only the
 * asker sees it (nothing is posted).
 */
import { History, Loader2, RotateCw, Sparkles, X } from "lucide-react";
import { useEffect, useState } from "react";

import { aiRunCaption, askTargetLine, type AiAskTargetOut, type AiRunOut, type AiSourceOut, describeAiError, linkCitations } from "../api/ai";
import type { AppController } from "../state/app";
import { isFinished } from "../sync/ai";
import { summaryAvailable, useAiHub } from "./ai";
import { fullTimestamp } from "./format";
import { channelTitle } from "./MainScreen";
import { MessageBody } from "./MessageBody";
import { Button, cn, IconButton } from "./primitives";
import { askQuery, type SearchParams } from "./search";

export function AskPanel({ controller, params, onOpenMessage }: {
  controller: AppController;
  params: SearchParams;
  /** A cited message: shown in its conversation (its thread for a reply). */
  onOpenMessage: (messageId: string) => void;
}) {
  const hub = useAiHub(controller);
  const store = controller.store;
  const question = askQuery(params, (id) => store.users.get(id)?.username);
  const channelId = params.channelId;
  const usable = !!hub && hub.canAsk && summaryAvailable(controller);
  const [read, setRead] = useState<{ key: string; target: AiAskTargetOut | null } | null>(null);
  const key = JSON.stringify([question, channelId]);
  useEffect(() => {
    if (!usable || !hub || !question) return;
    let live = true;
    void hub.askTarget(question, channelId).then((target) => {
      if (live) setRead({ key, target });
    });
    return () => {
      live = false;
    };
  }, [hub, usable, key]); // eslint-disable-line react-hooks/exhaustive-deps
  const [history, setHistory] = useState<AiRunOut[] | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);

  const session = hub?.ask ?? null;
  const target = read?.key === key ? read.target : undefined;
  // A server without 「AI に聞く」 (404 on the target): nothing, unless a question is already on screen.
  if (!hub || ((!usable || target === null || !question) && !session)) return null;
  const line = target ? askTargetLine(target) : null;
  const canAsk = usable && !!question && !!target?.available && !session?.sending;

  const toggleHistory = () => {
    const next = !historyOpen;
    setHistoryOpen(next);
    if (next) void hub.askHistory().then(setHistory);
  };

  return (
    <section aria-label="AI に聞く" data-testid="ai-ask" className="mb-3 max-w-3xl rounded-xl border border-accent/30 bg-accent-soft/30 px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <Sparkles size={16} className="shrink-0 text-accent" />
        <Button size="sm" disabled={!canAsk} onClick={() => { setHistoryOpen(false); void hub.startAsk(question, channelId); }}>
          AI に聞く
        </Button>
        {line && (
          <span data-testid="ai-ask-target" className={cn("min-w-0 flex-1 text-xs", target?.available ? "text-muted" : "text-danger")}>
            {line}
          </span>
        )}
        <div className="ml-auto flex items-center gap-1">
          <Button size="sm" variant="ghost" aria-pressed={historyOpen} onClick={toggleHistory}>
            <History size={14} /> 履歴
          </Button>
          {session && (
            <IconButton label="AI の答えを閉じる" onClick={() => hub.closeAsk()}>
              <X size={16} />
            </IconButton>
          )}
        </div>
      </div>
      {historyOpen && (
        <AskHistory
          runs={history}
          onPick={(run) => {
            setHistoryOpen(false);
            hub.showAskRun(run);
          }}
        />
      )}
      {session && (
        <div className="mt-3 border-t border-accent/20 pt-3" aria-live="polite">
          <p className="mb-2 text-sm font-semibold text-ink">「{session.question}」</p>
          {session.error !== null && session.error !== undefined ? (
            <div className="space-y-2">
              <p role="alert" className="rounded-lg bg-rose-500/10 px-3 py-2 text-sm text-danger">{describeAiError(session.error)}</p>
              <Button size="sm" variant="secondary" onClick={() => void hub.retryAsk()}>
                <RotateCw size={14} /> もう一度
              </Button>
            </div>
          ) : !session.run || !isFinished(session.run) ? (
            <div className="flex items-center gap-2 py-3 text-sm text-muted" role="status">
              <Loader2 size={16} className="animate-spin" />
              {!session.run || session.run.status === "pending" ? "メッセージを探しています…" : "答えを書いています…"}
            </div>
          ) : (
            <AskAnswer controller={controller} run={session.run} onOpenMessage={onOpenMessage} />
          )}
        </div>
      )}
    </section>
  );
}

function AskAnswer({ controller, run, onOpenMessage }: { controller: AppController; run: AiRunOut; onOpenMessage: (messageId: string) => void }) {
  const store = controller.store;
  const sources = run.sources ?? [];
  const base = controller.api?.baseUrl ?? null;
  const caption = aiRunCaption(run);
  return (
    <div className="space-y-2">
      {run.status === "failed" ? (
        <p role="alert" className="rounded-lg bg-rose-500/10 px-3 py-2 text-sm text-danger">
          答えられませんでした{run.error ? `: ${run.error}` : ""}
        </p>
      ) : (
        <MessageBody
          body={base ? linkCitations(run.output ?? "", sources, base) : (run.output ?? "")}
          users={store.users}
          groups={store.groups}
          customEmoji={store.customEmoji}
          controller={controller}
          internalBase={base}
          onOpenMessage={onOpenMessage}
          className="text-sm"
        />
      )}
      {run.omitted_count > 0 && (
        <p className="text-xs text-muted">非公開の会話の {run.omitted_count} 件は、このボットに送れないため除きました</p>
      )}
      {sources.length > 0 && <AskSources controller={controller} sources={sources} onOpenMessage={onOpenMessage} />}
      <p className="text-[11px] text-muted">
        この答えはあなたにだけ表示されます。AI が書いた答えです。間違いがあるかもしれません。
        {caption && <span data-testid="ai-run-caption" className="ml-1">({caption})</span>}
      </p>
    </div>
  );
}

function AskSources({ controller, sources, onOpenMessage }: { controller: AppController; sources: AiSourceOut[]; onOpenMessage: (messageId: string) => void }) {
  const store = controller.store;
  return (
    <div>
      <div className="mb-1 text-xs font-semibold text-muted">出典</div>
      <ol className="space-y-1" aria-label="出典">
        {sources.map((source) => {
          const channel = store.getChannel(source.channel_id);
          const sender = store.users.get(source.sender_id)?.display_name ?? "?";
          return (
            <li key={source.n}>
              <button
                type="button"
                className="flex w-full gap-2 rounded-lg px-2 py-1.5 text-left text-xs hover:bg-panel focus-visible:bg-panel focus-visible:outline-none"
                onClick={() => onOpenMessage(source.message_id)}
              >
                <span className="shrink-0 font-semibold text-accent">[{source.n}]</span>
                <span className="min-w-0 flex-1">
                  <span className="text-muted">
                    <span className="font-medium text-ink">{sender}</span>
                    {" · "}
                    {channel ? channelTitle(channel, controller) : "会話"}
                    {source.parent_id ? " · スレッド" : ""}
                    {" · "}
                    {fullTimestamp(source.created_at)}
                  </span>
                  <span className="mt-0.5 block line-clamp-2 break-words text-ink">{source.excerpt}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function AskHistory({ runs, onPick }: { runs: AiRunOut[] | null; onPick: (run: AiRunOut) => void }) {
  return (
    <div className="mt-2 rounded-lg border border-line bg-canvas p-1.5" data-testid="ai-ask-history">
      {runs === null ? (
        <p className="px-2 py-1.5 text-xs text-muted">読み込んでいます…</p>
      ) : runs.length === 0 ? (
        <p className="px-2 py-1.5 text-xs text-muted">まだ質問していません</p>
      ) : (
        <ul aria-label="過去の質問">
          {runs.map((run) => (
            <li key={run.id}>
              <button type="button" className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-accent-soft" onClick={() => onPick(run)}>
                <span className="min-w-0 flex-1 truncate">{run.question ?? "(質問)"}</span>
                <time className="shrink-0 text-xs text-muted">{fullTimestamp(run.created_at)}</time>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
