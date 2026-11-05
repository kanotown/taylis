/**
 * M185 (docs/LINK_PREVIEWS.md): the cards under a message. A link to another message on this server (`<server>/m/<id>`)
 * is a card with that message as the reader may see it (its author, conversation, time, first lines and a photo): the
 * server answers per reader (POST /messages/previews), so whoever cannot read it sees only 「表示できないメッセージ」
 * and nothing of it. A press opens the message (the app's permalink action). The external link's Open Graph card (M11g)
 * follows. The sender (or an administrator) removes a card for everyone with its ×, with 「元に戻す」 in the toast.
 */
import { Lock, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";

import type { MessagePreviewOut } from "../api/types";
import type { AppController } from "../state/app";
import type { MessageState } from "../sync/types";
import { t } from "../i18n";
import { Avatar } from "./Avatar";
import { useThumbnail } from "./DriveBrowser";
import { dateLabel, fullTimestamp, timeLabel } from "./format";
import { autoLinkPreview, LinkPreviewCard, RemoveCardButton, scrollParent } from "./LinkPreviewCard";
import { cardLinks } from "./links";
import { attachmentText } from "./markdown";
import { cardConversation, cardThumbnail, excerptText } from "./messageCards";
import { cn } from "./primitives";
import { EmojiText } from "./UserPopover";

const SHELL = "rounded-lg border border-line px-3 py-2 text-sm";

/** The cards of one message (timeline, thread pane, previews, the Times feed): message links first, then the external link. */
export function LinkCards({ controller, message, canRemove }: { controller: AppController; message: MessageState; canRemove: boolean }) {
  const store = controller.store;
  const { messages, external } = cardLinks(message.body, controller.api?.baseUrl, { selfId: message.id, hidden: message.hidden_previews, call: !!message.call });
  if (messages.length === 0 && !external) return null;
  const remove = canRemove ? (url: string) => () => void controller.setPreviewHidden(message, url, true) : undefined;
  return (
    <>
      {messages.map((card) => (
        <MessageLinkCard key={card.id} controller={controller} messageId={card.id} url={card.url} onRemove={remove?.(card.url)} />
      ))}
      {external && <LinkPreviewCard controller={controller} url={external} auto={autoLinkPreview(store, message.sender_id)} onRemove={remove?.(external)} />}
    </>
  );
}

export function MessageLinkCard({ controller, messageId, url, onRemove }: { controller: AppController; messageId: string; url: string; onRemove?: () => void }) {
  const store = controller.store;
  // Its own subscriptions (M21): the rows are memoized; a card that arrives re-renders only the cards.
  const subscribe = useCallback((listener: () => void) => controller.subscribeMessagePreviews(listener), [controller]);
  const entry = useSyncExternalStore(subscribe, () => controller.messagePreviews.get(messageId));
  const probe = useRef<HTMLDivElement>(null);
  // Asked for once the row comes within a screen of the view (as the Open Graph cards: a jump can add hundreds of rows),
  // again when the card is drawn after its answer went stale.
  useEffect(() => {
    const element = probe.current;
    if (!element) return;
    if (typeof IntersectionObserver === "undefined") {
      controller.requestMessagePreview(messageId);
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((item) => item.isIntersecting)) return;
      observer.disconnect();
      controller.requestMessagePreview(messageId);
    }, { root: scrollParent(element), rootMargin: "100% 0px" });
    observer.observe(element);
    return () => observer.disconnect();
  }, [controller, messageId]);

  const preview = entry?.preview ?? null;
  // The linked message as this device holds it (its conversation loaded): an edit or a deletion shows at once.
  const subscribeStore = useCallback((listener: () => void) => store.subscribe(listener), [store]);
  const live = useSyncExternalStore(subscribeStore, () => (preview?.state === "ok" && preview.channel_id ? store.getMessage(preview.channel_id, messageId) : undefined));
  const deletedHere = useSyncExternalStore(subscribeStore, () => store.wasDeleted(messageId));

  const state = preview?.state === "ok" && !live && deletedHere ? "deleted" : preview?.state;
  if (entry && !preview) return null; // the request failed: the link in the body still opens it
  return (
    <div ref={probe} data-message-card={messageId} data-state={state ?? "loading"} className="group/card relative mt-1.5 max-w-xl">
      {!preview ? (
        <div className={cn(SHELL, "flex items-center gap-2 text-muted")} aria-busy="true">
          <span className="h-4 w-4 shrink-0 animate-pulse rounded-full bg-panel-2" />
          <span className="text-xs">{t("linkCards.loading")}</span>
        </div>
      ) : state === "ok" ? (
        <ReadableCard controller={controller} preview={preview} live={live} url={url} />
      ) : state === "deleted" ? (
        <div className={cn(SHELL, "flex items-center gap-2 text-muted")}>
          <Trash2 size={15} className="shrink-0" aria-hidden="true" />
          <span>{t("linkCards.deleted")}</span>
        </div>
      ) : (
        <div className={cn(SHELL, "flex items-center gap-2 text-muted")} title={t("linkCards.unavailableNote")}>
          <Lock size={15} className="shrink-0" aria-hidden="true" />
          <span className="min-w-0">
            <span className="block font-medium text-ink">{t("linkCards.unavailable")}</span>
            <span className="block text-xs">{t("linkCards.unavailableNote")}</span>
          </span>
        </div>
      )}
      {onRemove && preview && <RemoveCardButton onRemove={onRemove} />}
    </div>
  );
}

function ReadableCard({ controller, preview, live, url }: { controller: AppController; preview: MessagePreviewOut; live: MessageState | undefined; url: string }) {
  const store = controller.store;
  const senderId = preview.sender_id ?? "";
  const sender = store.users.get(senderId);
  const name = sender?.display_name ?? "unknown";
  const blocked = store.isBlocked(senderId);
  const body = live
    ? excerptText(live.body, false, store.users, store.groups)
    : excerptText(preview.excerpt ?? "", preview.excerpt_truncated ?? false, store.users, store.groups);
  const files = live ? (live.attachments ?? []) : (preview.attachment_types ?? []).map((content_type) => ({ content_type }));
  const text = body || attachmentText(files);
  const thumbnailId = blocked ? null : live ? cardThumbnail(live.attachments) : (preview.thumbnail_attachment_id ?? null);
  const thumbnail = useThumbnail(controller, thumbnailId ? `/api/v1/attachments/${thumbnailId}/thumbnail` : null);
  const where = cardConversation(preview, preview.channel_id ? store.getChannel(preview.channel_id) : undefined, store.users, store.me?.id ?? null);
  const createdAt = preview.created_at ?? live?.created_at ?? "";
  return (
    <button
      type="button"
      title={url}
      aria-label={`${t("linkCards.open")}: ${blocked ? t("timeline.blockedMessage") : `${name} ${where}`}`}
      className={cn(SHELL, "block w-full text-left transition-colors hover:bg-panel")}
      onClick={(event) => {
        event.stopPropagation();
        void controller.openPermalink(preview.id);
      }}
    >
      <span className="flex min-w-0 items-center gap-1.5 pr-6 text-xs text-muted">
        {!blocked && <Avatar id={senderId} name={name} size={18} className="shrink-0" />}
        {!blocked && <span className="truncate font-semibold text-ink">{name}</span>}
        <span className="truncate" data-card-conversation="">{where}</span>
        {createdAt && (
          <time className="shrink-0" title={fullTimestamp(createdAt)}>
            {dateLabel(createdAt)} {timeLabel(createdAt)}
          </time>
        )}
      </span>
      <span className="mt-1 flex gap-3">
        <span data-card-excerpt="" className={cn("line-clamp-4 min-w-0 flex-1 whitespace-pre-line break-words text-[13px] leading-5", blocked ? "text-muted" : "text-ink")}>
          {blocked ? t("timeline.blockedMessage") : <EmojiText controller={controller} text={text} />}
        </span>
        {thumbnail && <img src={thumbnail} alt="" className="h-14 w-14 shrink-0 rounded-md border border-line object-cover" />}
      </span>
    </button>
  );
}
