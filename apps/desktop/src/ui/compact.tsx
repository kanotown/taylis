import { ArrowLeft, X } from "lucide-react";
import { createContext, useContext } from "react";

import { useMediaQuery } from "./hooks";
import { IconButton } from "./primitives";

/** Phones: below Tailwind's md breakpoint (48rem, as in the `max-md:` classes) one column shows at a time. */
export const COMPACT_QUERY = "(max-width: 47.99rem)";

export function useCompact(): boolean {
  return useMediaQuery(COMPACT_QUERY);
}

/** In the one-column layout, the way from a centre view back to the conversation list; null otherwise. */
export const BackToList = createContext<(() => void) | null>(null);

/** The back arrow that starts a centre view's header, only in the one-column layout. */
export function BackButton() {
  const back = useContext(BackToList);
  if (!back) return null;
  return (
    <IconButton label="戻る" className="-ml-2 shrink-0" onClick={back}>
      <ArrowLeft size={20} />
    </IconButton>
  );
}

/** M29: a side pane (the thread) is a page on a phone: 「戻る」 (←) starts its header there, instead of ✕ at its end. */
export function PaneBackButton({ onClick }: { onClick: () => void }) {
  if (!useCompact()) return null;
  return (
    <IconButton label="戻る" className="-ml-2 shrink-0" onClick={onClick}>
      <ArrowLeft size={20} />
    </IconButton>
  );
}

/** The ✕ that ends a side pane's header in the wide layout (none on a phone, see PaneBackButton). */
export function PaneCloseButton({ onClick }: { onClick: () => void }) {
  if (useCompact()) return null;
  return (
    <IconButton label="閉じる (Esc)" onClick={onClick}>
      <X size={18} />
    </IconButton>
  );
}
