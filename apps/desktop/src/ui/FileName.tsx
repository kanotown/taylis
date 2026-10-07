import type { ReactNode } from "react";

import { splitFileName } from "./fileNameEllipsis";
import { cn } from "./primitives";

/** `white-space: pre` keeps a space at a part's edge (nowrap would drop it); text-overflow still applies. */
const PRE = { whiteSpace: "pre" } as const;

/**
 * An attachment / file name on one line whose extension stays visible: the start of the stem truncates and its last
 * few characters plus the extension never shrink (「研究報告書_最終版_修正…2026年度.pdf」, fileNameEllipsis.ts). A name
 * without an extension truncates at its end. The text is the whole name (screen readers and copy read it all) and
 * `title` shows it on hover. The element is a flex row: a parent flex row must let it shrink (it carries `min-w-0`).
 *
 * `stacked`: for a small tile that had two clamped lines: the stem truncated on the first line, the extension on the
 * second (a name without an extension keeps the two clamped lines). `render` draws each part (search highlights).
 */
export function FileName({ name, className, stacked = false, title = name, render }: {
  name: string;
  className?: string;
  stacked?: boolean;
  title?: string;
  render?: (text: string) => ReactNode;
}) {
  const { head, tail, ext } = splitFileName(name);
  const draw = (text: string) => (render ? render(text) : text);
  if (stacked) {
    if (!ext) return <span data-file-name="" className={cn("line-clamp-2 break-all", className)} title={title}>{draw(name)}</span>;
    return (
      <span data-file-name="" className={cn("flex min-w-0 flex-col", className)} title={title}>
        <span className="block w-full truncate" style={PRE}>{draw(head + tail)}</span>
        <span className="block w-full truncate" style={PRE}>{draw(ext)}</span>
      </span>
    );
  }
  if (!ext) return <span data-file-name="" className={cn("block min-w-0 truncate", className)} style={PRE} title={title}>{draw(name)}</span>;
  return (
    <span data-file-name="" className={cn("flex min-w-0", className)} title={title}>
      <span data-file-name-head="" className="min-w-0 truncate" style={PRE}>{draw(head)}</span>
      <span data-file-name-end="" className="shrink-0" style={PRE}>{draw(tail + ext)}</span>
    </span>
  );
}
