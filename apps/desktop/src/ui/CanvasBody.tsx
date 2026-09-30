/**
 * A canvas rendered (CANVAS.md §4.2): the message renderer's blocks plus tasks with boxes that tick (§4.4 「チェックの
 * 切り替え」), images of the canvas (M44 draws them; a placeholder until then) and rules. Headings get anchors for the
 * outline.
 */
import { ImageIcon } from "lucide-react";
import type { AppController } from "../state/app";
import { parseBlocks } from "./markdown";
import { BlockView, inline, type InlineOptions } from "./MessageBody";
import { cn } from "./primitives";

export const headingAnchor = (line: number) => `canvas-h-${line}`;

export function CanvasBody({ body, controller, onToggleTask, className }: {
  body: string;
  controller: AppController;
  /** null: the boxes only show (read only). */
  onToggleTask: ((line: number, done: boolean) => void) | null;
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
  const blocks = parseBlocks(body, { canvas: true });
  return (
    <div className={cn("body canvas-body text-[15px] leading-7", className)}>
      {blocks.map((block, index) => {
        if (block.kind === "task") {
          return (
            <ul key={index} className="my-1 list-none pl-0.5" role="list">
              {block.items.map((item) => (
                <li key={item.line} className={cn("flex items-start gap-2", item.level > 0 && "ml-6")}>
                  <input
                    type="checkbox"
                    checked={item.done}
                    disabled={!onToggleTask}
                    aria-label={item.done ? "完了を取り消す" : "完了にする"}
                    onChange={(event) => onToggleTask?.(item.line, event.target.checked)}
                    className="mt-[7px] h-4 w-4 shrink-0 accent-[var(--accent)]"
                  />
                  <span className={cn("min-w-0", item.done && "text-muted line-through")}>{inline(item.tokens, store.users, options)}</span>
                </li>
              ))}
            </ul>
          );
        }
        if (block.kind === "image") {
          // M44 draws the canvas's images (attachments bound to it); the reference is kept as it is.
          return (
            <div key={index} className="my-2 inline-flex items-center gap-2 rounded-lg border border-dashed border-line px-3 py-2 text-sm text-muted" data-attachment-id={block.attachmentId}>
              <ImageIcon size={16} /> 画像{block.alt ? `: ${block.alt}` : ""}
            </div>
          );
        }
        if (block.kind === "heading" && block.line !== undefined) {
          const size = block.level === 1 ? "text-2xl" : block.level === 2 ? "text-xl" : "text-lg";
          return (
            <div key={index} id={headingAnchor(block.line)} className={cn("mb-1 mt-4 scroll-mt-4 font-bold leading-tight first:mt-0", size)}>
              {inline(block.tokens, store.users, options)}
            </div>
          );
        }
        return <BlockView key={index} block={block} users={store.users} options={options} />;
      })}
    </div>
  );
}
