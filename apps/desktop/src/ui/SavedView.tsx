import { Bookmark } from "lucide-react";
import { useEffect, useState } from "react";

import type { BookmarkItem, MessageOut } from "../api/types";
import type { AppController } from "../state/app";
import { BackButton } from "./compact";
import { Button } from "./primitives";
import { MessageCard } from "./PinsPane";

/** The centre column 「保存済み」 (M11c): my bookmarked messages, newest saved first; a row reveals it. */
export function SavedView({ controller, onOpen }: { controller: AppController; onOpen: (message: MessageOut) => void }) {
  const store = controller.store;
  const [items, setItems] = useState<BookmarkItem[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const signature = [...store.bookmarks].join(","); // bookmark.updated (any device) re-reads the list

  const load = async (more = false) => {
    if (!controller.api) return;
    try {
      const page = await controller.api.listBookmarks({ cursor: more ? cursor : null, limit: 50 });
      setItems((current) => (more && current ? [...current, ...page.items] : page.items));
      setCursor(page.next_cursor ?? null);
      setHasMore(page.items.length >= 50);
    } catch (error) {
      controller.setError(error);
    }
  };
  useEffect(() => {
    void load();
  }, [controller.api, signature]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-[52px] items-center gap-3 border-b border-line px-4">
        <BackButton />
        <span className="text-muted max-md:hidden">
          <Bookmark size={18} />
        </span>
        <strong className="shrink-0 whitespace-nowrap text-[15px]">保存済み</strong>
        <span className="min-w-0 truncate text-xs text-muted">{items ? `${store.bookmarks.size} 件` : ""}</span>
      </header>
      <div data-scroll-memory className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {items === null ? (
          <div className="py-8 text-center text-sm text-muted">読み込み中…</div>
        ) : items.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
            <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-accent-soft text-accent">
              <Bookmark size={22} />
            </span>
            <strong className="text-sm">保存したメッセージはありません</strong>
            <span className="text-xs text-muted">メッセージのしおりアイコンで、あとで見返したいものをここに集められます。</span>
          </div>
        ) : (
          <div className="mx-auto max-w-3xl space-y-1">
            {items.map((item) => (
              <MessageCard key={item.message.id} message={item.message} controller={controller} onOpen={() => onOpen(item.message)} removeLabel="保存を解除" onRemove={() => void controller.toggleBookmark({ ...item.message, seq: item.message.seq })} />
            ))}
            {hasMore && (
              <div className="py-2 text-center">
                <Button variant="secondary" size="sm" onClick={() => void load(true)}>
                  さらに読み込む
                </Button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
