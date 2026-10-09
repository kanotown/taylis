/**
 * M153a (WIKI.md §30.3): the page editor's environment on Desktop / Web — the controller and the store behind the
 * PageEditorEnv interface (ui/pageEditorEnv.tsx). The components that need the controller (page chips, images, embeds,
 * custom emoji, the emoji picker) are drawn here, so PageEditor.tsx itself imports none of them and the same editor can
 * be bundled for the phones without the app.
 */
import { ApiError } from "../api/errors";
import type { AppController } from "../state/app";
import { DatabaseEmbed } from "./CanvasBody";
import { CanvasImage } from "./CanvasImage";
import { CustomEmojiImage } from "./customEmoji";
import { replaceShortcodes } from "./emoji";
import { EmojiPicker } from "./EmojiPicker";
import { aiBotIds } from "./mentions";
import { inline } from "./MessageBody";
import type { PageEditorEnv } from "./pageEditorEnv";
import { PageIcon } from "./PageIcon";
import { PageLinkChip } from "./PageLinkChip";

export function desktopPageEditorEnv(controller: AppController): PageEditorEnv {
  const store = controller.store;
  return {
    subscribe: (listener) => store.subscribe(listener),
    version: () => store.version,
    isCustomEmoji: (name) => store.customEmoji.has(name),
    people: () => ({ users: store.users, groups: store.groups, aiBotIds: aiBotIds(store) }),
    render: {
      pageLink: (id, label) => <PageLinkChip controller={controller} pageId={id} label={label || undefined} />,
      emoji: (md) => {
        const name = md.slice(1, -1);
        const custom = store.customEmoji.get(name);
        if (custom) return <CustomEmojiImage controller={controller} emoji={custom} size="1.375em" inline />;
        return <span>{replaceShortcodes(md)}</span>;
      },
      image: (attachmentId, alt) => <CanvasImage controller={controller} attachmentId={attachmentId} alt={alt} />,
      embed: (pageId, viewId) => <DatabaseEmbed controller={controller} pageId={pageId} viewId={viewId} />,
      calloutIcon: (icon) => (icon ? <span aria-hidden="true">{inline([{ kind: "text", text: icon }], store.users, { customEmoji: store.customEmoji, controller })}</span> : <span className="text-muted" aria-hidden="true">＋</span>),
      pageIcon: (icon, size) => <PageIcon controller={controller} icon={icon} size={size} />,
      emojiPicker: (onPick) => <EmojiPicker controller={controller} custom={[...store.customEmoji.values()]} onPick={onPick} />,
    },
    copyText: (text) => void controller.copyMessageText(text),
    showError: (error) => controller.setError(error),
    imageLimitError: () => new ApiError(400, "too_many_canvas_images", "Too many images"),
    uploadImage: async (file) => {
      const uploaded = await controller.uploadCanvasImage(file);
      return uploaded ? { id: uploaded.id } : null;
    },
    toolbar: "top",
    readOnly: () => false,
  };
}
