/**
 * M121 (WIKI.md §3.2): a Docs page's icon — one emoji or a custom emoji (`:name:`), else the page glyph.
 */
import { FileText } from "lucide-react";

import type { AppController } from "../state/app";
import { cn } from "./primitives";
import { EmojiText } from "./UserPopover";

export function PageIcon({ controller, icon, size = 16, className }: { controller: AppController; icon: string | null | undefined; size?: number; className?: string }) {
  if (!icon) return <FileText size={size} className={cn("shrink-0 text-muted", className)} aria-hidden="true" />;
  return (
    <span aria-hidden="true" className={cn("inline-flex shrink-0 items-center justify-center leading-none", className)} style={{ fontSize: size, width: size + 2, height: size + 2 }}>
      <EmojiText controller={controller} text={icon} size={size} />
    </span>
  );
}
