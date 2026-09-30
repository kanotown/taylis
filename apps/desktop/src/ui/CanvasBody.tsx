/**
 * A canvas rendered (CANVAS.md §4.2): the message renderer's blocks plus tasks with boxes that tick (§4.4 「チェックの
 * 切り替え」), images of the canvas (M44: ui/CanvasImage.tsx) and rules. Headings get anchors for the outline.
 */
import type { AppController } from "../state/app";
import { CanvasImage } from "./CanvasImage";
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
  // An image keeps its element (and its fetched picture) while text above it changes: keyed by its id, not its place.
  const seen = new Map<string, number>();
  const imageKey = (id: string) => {
    const n = (seen.get(id) ?? 0) + 1;
    seen.set(id, n);
    return `img:${id}:${n}`;
  };
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
          // M44: the canvas's images (attachments bound to it), fetched with the token like a message's photos.
          return <CanvasImage key={imageKey(block.attachmentId)} controller={controller} attachmentId={block.attachmentId} alt={block.alt} />;
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
