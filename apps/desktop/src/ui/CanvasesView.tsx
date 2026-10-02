/**
 * M44 (CANVAS.md §4.1 / §5): 「キャンバス」 — the canvases of all my conversations, most recently updated first
 * (`GET /canvases`, pages of 50), filtered by title; a row opens the canvas in its conversation. The wide sidebar and the
 * phone home's tile open it, like 「ファイル」.
 */
import { FileText, Search } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";

import type { CanvasMeta } from "../api/types";
import type { AppController } from "../state/app";
import { taskProgress } from "./canvasText";
import { BackButton } from "./compact";
import { sinceLabel } from "./format";
import { channelTitle } from "./MainScreen";
import { Badge, Button, Input } from "./primitives";

function fold(value: string): string {
  return value.normalize("NFKC").toLowerCase();
}

export function CanvasesView({ controller, onOpen, onSearch }: {
  controller: AppController;
  onOpen: (canvas: CanvasMeta) => void;
  /** The words searched in the canvases' bodies (the search's 「キャンバス」 tab). */
  onSearch?: (q: string) => void;
}) {
  const store = controller.store;
  useSyncExternalStore((listener) => store.subscribe(listener), () => store.version);
  const [items, setItems] = useState<CanvasMeta[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const load = async (more: boolean) => {
    const page = await controller.myCanvases(more ? cursor : null);
    if (!page) {
      setItems((current) => current ?? []);
      return;
    }
    setItems((current) => (more && current ? [...current, ...page.items.filter((c) => !current.some((k) => k.id === c.id))] : page.items));
    setCursor(page.next_cursor);
  };
  useEffect(() => {
    void load(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controller.api, controller.engine?.status]);

  // What this device knows newer (events of the conversations opened) wins; canvases moved to the trash leave.
  const rows = (items ?? [])
    .map((c) => {
      const live = store.canvasMeta(c.id);
      return live && live.version >= c.version ? live : c;
    })
    .filter((c) => {
      const list = store.canvasesOf(c.channel_id);
      return !list || list.some((k) => k.id === c.id);
    })
    .filter((c) => store.getChannel(c.channel_id)?.isMember !== false);
  const needle = fold(query.trim());
  const shown = needle ? rows.filter((c) => fold(c.title).includes(needle)) : rows;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-[52px] items-center gap-3 border-b border-line px-4 max-md:h-auto max-md:flex-wrap max-md:gap-x-2 max-md:gap-y-2 max-md:py-2">
        <BackButton />
        <span className="text-muted max-md:hidden"><FileText size={18} /></span>
        <strong className="shrink-0 whitespace-nowrap text-[15px]">キャンバス</strong>
        <div className="relative ml-auto w-64 max-md:ml-0 max-md:w-full">
          <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" />
          <Input
            value={query}
            placeholder="題名で絞り込む"
            aria-label="題名で絞り込む"
            className="h-8 pl-8 text-sm"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && query.trim() && onSearch && !e.nativeEvent.isComposing) onSearch(query.trim());
            }}
          />
        </div>
      </header>
      <div data-scroll-memory className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {items === null ? (
          <div className="py-8 text-center text-sm text-muted">読み込み中…</div>
        ) : shown.length === 0 ? (
          <div className="py-16 text-center text-sm text-muted">
            {needle ? "題名に一致するキャンバスはありません。" : "まだキャンバスはありません。会話の「キャンバス」から作れます。"}
            {needle && onSearch && (
              <div className="mt-3">
                <Button variant="secondary" size="sm" onClick={() => onSearch(query.trim())}><Search size={14} /> 本文も検索する</Button>
              </div>
            )}
          </div>
        ) : (
          <ul aria-label="キャンバス" className="mx-auto max-w-3xl divide-y divide-line rounded-xl border border-line">
            {shown.map((canvas) => {
              const channel = store.getChannel(canvas.channel_id);
              const progress = taskProgress(canvas.task_total, canvas.task_done);
              return (
                <li key={canvas.id} data-row-key={canvas.id}>
                  <button type="button" data-canvas-row={canvas.id} className="flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-panel" onClick={() => onOpen(canvas)}>
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent"><FileText size={17} /></span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5">
                        <span className="truncate text-sm font-semibold">{canvas.title}</span>
                        {canvas.is_channel_tab && <Badge tone="accent">タブ</Badge>}
                      </span>
                      <span className="block truncate text-xs text-muted">
                        {channel ? channelTitle(channel, controller) : "会話"} · {store.users.get(canvas.updated_by)?.display_name ?? "メンバー"} · {sinceLabel(canvas.updated_at)}
                      </span>
                    </span>
                    {progress && <span className="shrink-0 text-xs text-muted" aria-label={`タスク ${progress}`}>{progress}</span>}
                  </button>
                </li>
              );
            })}
            {cursor && !needle && (
              <li className="py-2 text-center">
                <Button variant="secondary" size="sm" onClick={() => void load(true)}>さらに読み込む</Button>
              </li>
            )}
          </ul>
        )}
        {needle && shown.length > 0 && onSearch && (
          <div className="mx-auto mt-3 max-w-3xl text-center">
            <button type="button" className="text-xs text-accent hover:underline" onClick={() => onSearch(query.trim())}>「{query.trim()}」をキャンバスの本文からも検索</button>
          </div>
        )}
      </div>
    </div>
  );
}
