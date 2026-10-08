/**
 * A canvas rendered (CANVAS.md §4.2): the message renderer's blocks plus tasks with boxes that tick (§4.4 「チェックの
 * 切り替え」), images of the canvas (M44: ui/CanvasImage.tsx) and rules. Headings get anchors for the outline.
 * §23: each top-level block sits in a box-less wrapper (`display: contents`, so no layout changes) with `data-line`,
 * the source line it starts on, for the editor's scroll sync (canvasScrollSync.ts).
 * M149 (WIKI.md §22.5): callouts (an icon and a tinted box), toggles (closed until opened; the state is this screen's,
 * never the body's) and embedded databases (the view itself, ui/DatabaseView.tsx), their content drawn by the same
 * function (a task inside ticks its own line of the body).
 */
import { ChevronRight, FileLock2, ListTodo } from "lucide-react";
import { type ReactNode, useSyncExternalStore } from "react";

import type { AppController } from "../state/app";
import { CanvasImage } from "./CanvasImage";
import { anchorLineOf } from "./canvasScrollSync";
import { useCompact } from "./compact";
import { DatabaseView } from "./DatabaseView";
import { type Block, parseBlocksWithLines } from "./markdown";
import { BlockView, inline, type InlineOptions } from "./MessageBody";
import { PageLinkChip } from "./PageLinkChip";
import { cn } from "./primitives";
import { t } from "../i18n";

export const headingAnchor = (line: number) => `canvas-h-${line}`;

export function CanvasBody({ body, controller, onToggleTask, onMakeTask = null, className }: {
  body: string;
  controller: AppController;
  /** null: the boxes only show (read only). */
  onToggleTask: ((line: number, done: boolean) => void) | null;
  /** M72 (CANVAS.md §18.3): 「タスクにする」 on an open item (its line in the body); null: not offered. */
  onMakeTask?: ((line: number) => void) | null;
  className?: string;
}) {
  const store = controller.store;
  const options: InlineOptions = {
    internalBase: controller.api?.baseUrl,
    onOpenMessage: (id) => void controller.openPermalink(id),
    customEmoji: store.customEmoji,
    controller,
    groups: store.groups,
  };
  const { blocks, lines: ranges } = parseBlocksWithLines(body, { canvas: true });
  const sourceLines = body.replace(/\r\n?/g, "\n").split("\n");
  // An image keeps its element (and its fetched picture) while text above it changes: keyed by its id, not its place.
  const seen = new Map<string, number>();
  const imageKey = (id: string) => {
    const n = (seen.get(id) ?? 0) + 1;
    seen.set(id, n);
    return `img:${id}:${n}`;
  };
  /** A block's key among its siblings: images by their picture, embeds by what they show (their rows stay loaded). */
  const keyOf = (block: Block, index: number): string | number =>
    block.kind === "image" ? imageKey(block.attachmentId) : block.kind === "embed" ? imageKey(`embed:${block.pageId}:${block.viewId ?? ""}`) : index;
  const children = (inner: Block[]) => inner.map((child, i) => <div key={keyOf(child, i)} className="contents">{renderBlock(child, i)}</div>);

  const renderBlock = (block: Block, index: number): ReactNode => {
    if (block.kind === "task") {
      return (
        <ul className="my-1 list-none pl-0.5" role="list">
          {block.items.map((item) => (
            <li key={item.line} className={cn("group/task flex items-start gap-2", item.level > 0 && "ml-6")}>
              <input
                type="checkbox"
                checked={item.done}
                disabled={!onToggleTask}
                aria-label={item.done ? t("canvasBody.undone") : t("tasks.dialog.complete")}
                onChange={(event) => onToggleTask?.(item.line, event.target.checked)}
                className="mt-[7px] h-4 w-4 shrink-0 accent-[var(--accent)]"
              />
              <span className={cn("min-w-0", item.done && "text-muted line-through")}>{inline(item.tokens, store.users, options)}</span>
              {onMakeTask && !item.done && (
                <button
                  type="button"
                  title={t("canvasBody.makeTaskTitle")}
                  aria-label={t("actions.task")}
                  data-make-task={item.line}
                  onClick={() => onMakeTask(item.line)}
                  className="ml-auto mt-1 inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-xs text-muted opacity-0 transition-opacity hover:bg-ink/6 hover:text-ink focus-visible:opacity-100 group-hover/task:opacity-100 pointer-coarse:opacity-70"
                >
                  <ListTodo size={14} />
                  <span className="max-md:sr-only">{t("actions.task")}</span>
                </button>
              )}
            </li>
          ))}
        </ul>
      );
    }
    if (block.kind === "image") {
      // M44: the canvas's images (attachments bound to it), fetched with the token like a message's photos.
      return <CanvasImage controller={controller} attachmentId={block.attachmentId} alt={block.alt} />;
    }
    if (block.kind === "heading" && block.line !== undefined) {
      const size = block.level === 1 ? "text-2xl" : block.level === 2 ? "text-xl" : "text-lg";
      // The first block gets no space above (`first:` would match every wrapped block).
      return (
        <div id={headingAnchor(block.line)} className={cn("mb-1 scroll-mt-4 font-bold leading-tight", index === 0 ? "mt-0" : "mt-4", size)}>
          {inline(block.tokens, store.users, options)}
        </div>
      );
    }
    if (block.kind === "callout") {
      return (
        <div className="callout my-2 flex gap-2.5 rounded-lg px-3.5 py-2" data-tone={block.tone} data-callout={block.line}>
          {block.icon && (
            <span className="shrink-0 select-none text-[1.15em] leading-7" aria-hidden="true">
              {inline([{ kind: "text", text: block.icon }], store.users, options)}
            </span>
          )}
          <div className="min-w-0 flex-1">{children(block.blocks)}</div>
        </div>
      );
    }
    if (block.kind === "toggle") {
      // <details>: closed at first, opened and closed by the reader (the keyboard too); nothing is written to the body.
      return (
        <details className="canvas-toggle group/toggle my-1" data-toggle={block.line}>
          <summary className="flex cursor-pointer list-none items-start gap-1 rounded-md py-0.5 pr-1 hover:bg-ink/4 [&::-webkit-details-marker]:hidden">
            <ChevronRight size={16} className="mt-1.5 shrink-0 text-muted transition-transform group-open/toggle:rotate-90" aria-hidden="true" />
            <span className="min-w-0 font-medium">{block.title.length > 0 ? inline(block.title, store.users, options) : <span className="text-muted">{t("canvasBody.toggleUntitled")}</span>}</span>
          </summary>
          <div className="pl-5">{children(block.blocks)}</div>
        </details>
      );
    }
    if (block.kind === "embed") return <DatabaseEmbed controller={controller} pageId={block.pageId} viewId={block.viewId} />;
    return <BlockView block={block} users={store.users} options={options} />;
  };

  return (
    <div className={cn("body canvas-body text-[15px] leading-7", className)}>
      {blocks.map((block, index) => {
        const range = ranges[index]!;
        return (
          <div key={keyOf(block, index)} className="contents" data-line={anchorLineOf(sourceLines, range.from, range.to)}>
            {renderBlock(block, index)}
          </div>
        );
      })}
    </div>
  );
}

/** M149: what an embed shows when its database cannot be read (gone, not shared, not a database): never its name. */
function EmbedUnavailable({ pageId }: { pageId: string }) {
  return (
    <div data-embed-unavailable={pageId} className="my-3 flex items-center gap-2 rounded-xl border border-dashed border-line px-3 py-3 text-sm text-muted" title={t("docs.unreadablePageHint")}>
      <FileLock2 size={15} className="shrink-0" aria-hidden="true" />
      {t("docs.unreadablePage")}
    </div>
  );
}

/**
 * M149 (WIKI.md §22.5): an embedded database — its view as on its own page (at most EMBED_ROWS rows, 「すべて表示」
 * opens it), editable with my rights there. A page I cannot read is a placeholder; a page that is not a database, its
 * link.
 */
export function DatabaseEmbed({ controller, pageId, viewId }: { controller: AppController; pageId: string; viewId: string | null }) {
  const hub = controller.engine?.wiki ?? null;
  useSyncExternalStore((listener) => hub?.subscribe(listener) ?? (() => {}), () => hub?.version ?? 0);
  const compact = useCompact();
  const ref = hub ? hub.resolve(pageId) : undefined;
  if (ref === null) return <EmbedUnavailable pageId={pageId} />;
  if (ref && ref.kind !== "database") return <div className="my-1"><PageLinkChip controller={controller} pageId={pageId} /></div>;
  return (
    <DatabaseView
      key={`${pageId}:${viewId ?? ""}`}
      controller={controller}
      databaseId={pageId}
      compact={compact}
      renderPeek={() => null}
      onOpenRowPage={(rowId) => controller.requestOpenPage(rowId)}
      embed={{
        viewId,
        header: <PageLinkChip controller={controller} pageId={pageId} />,
        onOpenAll: () => controller.requestOpenPage(pageId),
        unavailable: <EmbedUnavailable pageId={pageId} />,
      }}
    />
  );
}
