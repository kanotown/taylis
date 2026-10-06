/**
 * A canvas rendered (CANVAS.md §4.2): the message renderer's blocks plus tasks with boxes that tick (§4.4 「チェックの
 * 切り替え」), images of the canvas (M44: ui/CanvasImage.tsx) and rules. Headings get anchors for the outline.
 * §23: each top-level block sits in a box-less wrapper (`display: contents`, so no layout changes) with `data-line`,
 * the source line it starts on, for the editor's scroll sync (canvasScrollSync.ts).
 */
import { ListTodo } from "lucide-react";

import type { AppController } from "../state/app";
import { CanvasImage } from "./CanvasImage";
import { anchorLineOf } from "./canvasScrollSync";
import { type Block, parseBlocksWithLines } from "./markdown";
import { BlockView, inline, type InlineOptions } from "./MessageBody";
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

  const renderBlock = (block: Block, index: number) => {
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
    return <BlockView block={block} users={store.users} options={options} />;
  };

  return (
    <div className={cn("body canvas-body text-[15px] leading-7", className)}>
      {blocks.map((block, index) => {
        const range = ranges[index]!;
        return (
          <div key={block.kind === "image" ? imageKey(block.attachmentId) : index} className="contents" data-line={anchorLineOf(sourceLines, range.from, range.to)}>
            {renderBlock(block, index)}
          </div>
        );
      })}
    </div>
  );
}
