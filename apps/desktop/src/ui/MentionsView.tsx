import { AtSign } from "lucide-react";
import { useEffect, useState } from "react";

import type { MessageOut } from "../api/types";
import type { AppController } from "../state/app";
import { BackButton } from "./compact";
import { Button } from "./primitives";
import { MessageCard } from "./PinsPane";

/** The centre column 「メンション」 (M11h): messages that mention me or everyone, newest first. */
export function MentionsView({ controller, onOpen }: { controller: AppController; onOpen: (message: MessageOut) => void }) {
  const [items, setItems] = useState<MessageOut[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const load = async (more = false) => {
    if (!controller.api) return;
    try {
      const page = await controller.api.listMentions({ cursor: more ? cursor : null, limit: 50 });
      setItems((current) => (more && current ? [...current, ...page.items] : page.items));
      setCursor(page.next_cursor ?? null);
      setHasMore(page.items.length >= 50);
    } catch (error) {
      controller.setError(error);
    }
  };
  useEffect(() => {
    void load();
  }, [controller.api, controller.engine?.status]);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-[52px] items-center gap-3 border-b border-line px-4">
        <BackButton />
        <span className="text-muted max-md:hidden"><AtSign size={18} /></span>
        <strong className="shrink-0 whitespace-nowrap text-[15px]">メンション</strong>
        <span className="min-w-0 truncate text-xs text-muted">自分宛てと @channel</span>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {items === null ? (
          <div className="py-8 text-center text-sm text-muted">読み込み中…</div>
        ) : items.length === 0 ? (
          <div className="py-16 text-center text-sm text-muted">まだメンションはありません</div>
        ) : (
          <div className="mx-auto max-w-3xl space-y-1">
            {items.map((message) => <MessageCard key={message.id} message={message} controller={controller} onOpen={() => onOpen(message)} />)}
            {hasMore && (
              <div className="py-2 text-center">
                <Button variant="secondary" size="sm" onClick={() => void load(true)}>さらに読み込む</Button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
