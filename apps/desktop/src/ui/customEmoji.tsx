import { type CSSProperties, useEffect, useState } from "react";

import type { CustomEmojiOut } from "../api/types";
import type { AppController } from "../state/app";
import { Button, cn, Field, Input, Modal } from "./primitives";
import { useRef } from "react";

/** Custom emoji (M12f): `:name:` in text and reactions renders as the uploaded image. */

const EXACT = /^:([a-z0-9][a-z0-9_+-]{1,31}):$/;
const INLINE = /:([a-z0-9][a-z0-9_+-]{1,31}):/g;

/** The custom emoji name when `text` is exactly `:name:` (reactions, picker picks). */
export function customEmojiName(text: string): string | null {
  const match = EXACT.exec(text);
  return match ? match[1]! : null;
}

export type EmojiPiece = string | { name: string };

/** Split text into plain runs and known custom emoji names; unknown `:x:` stay text. */
export function splitCustomEmoji(text: string, known: { has(name: string): boolean }): EmojiPiece[] {
  if (!text.includes(":")) return [text];
  const pieces: EmojiPiece[] = [];
  let last = 0;
  for (const match of text.matchAll(INLINE)) {
    const name = match[1]!;
    if (!known.has(name)) continue;
    const start = match.index ?? 0;
    if (start > last) pieces.push(text.slice(last, start));
    pieces.push({ name });
    last = start + match[0].length;
  }
  if (last < text.length) pieces.push(text.slice(last));
  return pieces;
}

const urls = new Map<string, string>();
const loading = new Map<string, Promise<string | null>>();
/** Emoji whose image could not be fetched: they show as `:name:` (while loading they take their room, blank). */
const failed = new Set<string>();

/** Fetches the image once per emoji id (with the bearer token) and keeps the object URL for the session. */
export function loadCustomEmojiUrl(controller: AppController, emoji: CustomEmojiOut): Promise<string | null> {
  const hit = urls.get(emoji.id);
  if (hit) return Promise.resolve(hit);
  let pending = loading.get(emoji.id);
  if (!pending) {
    pending = (async () => {
      try {
        const blob = await controller.api!.fetchBlob(`/api/v1/emoji/${emoji.id}/image`);
        const url = URL.createObjectURL(blob);
        urls.set(emoji.id, url);
        return url;
      } catch {
        failed.add(emoji.id);
        return null;
      } finally {
        loading.delete(emoji.id);
      }
    })();
    loading.set(emoji.id, pending);
  }
  return pending;
}

/** The image of `emoji`: a component reused for another emoji never shows the previous one (state is keyed by id). */
export function useCustomEmojiUrl(controller: AppController, emoji: CustomEmojiOut): string | null {
  const [loaded, setLoaded] = useState<{ id: string; url: string | null } | null>(null);
  const url = urls.get(emoji.id) ?? (loaded?.id === emoji.id ? loaded.url : null);
  useEffect(() => {
    if (urls.has(emoji.id) || !controller.api) return;
    let live = true;
    void loadCustomEmojiUrl(controller, emoji).then((next) => { if (live) setLoaded({ id: emoji.id, url: next }); });
    return () => { live = false; };
  }, [emoji.id, controller.api]);
  return url;
}

/**
 * A custom emoji's image. `size` in pixels, or a CSS length such as "1.375em" to follow the text around it (a
 * heading's emoji is as large as the heading).
 *
 * Always a fixed square box (2026-10-04, 「高さが違う・ガタつく」): before, the image was `width: auto`, so it had no
 * width until decoded and another one than its loading placeholder; a message's lines could re-wrap and the timeline
 * jump when it loaded (a remount decodes again). Now the placeholder and the image take the same `size`×`size` box
 * and a wide image is fitted into it (`object-fit: contain`). Its middle is where a standard emoji glyph's middle is
 * (Apple Color Emoji: about 0.38em above the baseline).
 *
 * `inline` (a run of text: a message, a status line): the box also counts as exactly 1em tall for the line (negative
 * margins), like a standard emoji glyph, so a larger image never makes its line taller than one without it.
 */
export function CustomEmojiImage({ controller, emoji, size = 20, className, inline = false }: { controller: AppController; emoji: CustomEmojiOut; size?: number | string; className?: string; inline?: boolean }) {
  const url = useCustomEmojiUrl(controller, emoji);
  if (!url && failed.has(emoji.id)) return <span className={cn("text-muted", className)}>:{emoji.name}:</span>;
  const style = customEmojiBoxStyle(size, inline);
  // Loading: its room, blank (the name as text was wider than a picker's cell).
  if (!url) return <span aria-hidden data-custom-emoji={emoji.name} className={cn("inline-block shrink-0", className)} style={style} />;
  const px = typeof size === "number" ? size : undefined;
  return <img src={url} alt={`:${emoji.name}:`} title={`:${emoji.name}:`} width={px} height={px} draggable={false} data-custom-emoji={emoji.name} className={cn("inline-block shrink-0", className)} style={{ ...style, objectFit: "contain" }} />;
}

/** The box of a custom emoji (also for the tests): see CustomEmojiImage. */
export function customEmojiBoxStyle(size: number | string, inline: boolean): CSSProperties {
  const length = typeof size === "number" ? `${size}px` : size;
  const box: CSSProperties = { width: length, height: length, minWidth: length };
  if (!inline) return { ...box, verticalAlign: `calc(0.38em - ${length} / 2)` };
  // The margin box is 1em tall from 0.12em below the baseline: the image's middle at 0.38em, the line box unchanged.
  const margin = `calc((1em - ${length}) / 2)`;
  return { ...box, marginTop: margin, marginBottom: margin, verticalAlign: "-0.12em" };
}

/** Add a custom emoji (M12f): a name and a small image; any member may. */
export function AddEmojiDialog({ controller, onClose }: { controller: AppController; onClose: () => void }) {
  const [name, setName] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const valid = /^[a-z0-9][a-z0-9_+-]{1,31}$/.test(name) && !!file;
  const submit = async () => {
    if (!valid || !file) return;
    setBusy(true);
    const ok = await controller.uploadEmoji(name, file);
    setBusy(false);
    if (ok) onClose();
  };
  return (
    <Modal onClose={onClose} title="絵文字を追加" className="w-[420px]">
      <div className="mt-3 space-y-3">
        <Field label="名前 (a-z 0-9 _ + -、2〜32 文字)">
          <Input value={name} autoFocus placeholder="例: party_parrot" onChange={(e) => setName(e.target.value.trim().toLowerCase())} />
          {name && <div className="mt-1 text-xs text-muted">本文では :{name}: と書きます</div>}
        </Field>
        <Field label="画像 (PNG / GIF / JPEG / WebP、512px・256 KB まで)">
          <input ref={input} type="file" accept="image/png,image/gif,image/jpeg,image/webp" className="text-sm" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        </Field>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>キャンセル</Button>
          <Button disabled={!valid || busy} onClick={() => void submit()}>追加</Button>
        </div>
      </div>
    </Modal>
  );
}

/** The admin dialog's 絵文字 tab (M12f): every custom emoji with its creator, and removal. */
export function EmojiAdminTab({ controller }: { controller: AppController }) {
  const store = controller.store;
  const [adding, setAdding] = useState(false);
  const rows = [...store.customEmoji.values()].sort((a, b) => a.name.localeCompare(b.name));
  return (
    <div className="mt-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs text-muted">{rows.length} 件 · 誰でも追加でき、作成者と管理者が削除できます</span>
        <Button size="sm" onClick={() => setAdding(true)}>絵文字を追加</Button>
      </div>
      <ul className="divide-y divide-line rounded-xl border border-line">
        {rows.map((emoji) => (
          <li key={emoji.id} className="flex items-center gap-3 px-3 py-2 text-sm">
            <CustomEmojiImage controller={controller} emoji={emoji} size={24} />
            <span className="font-mono text-[13px]">:{emoji.name}:</span>
            <span className="flex-1 truncate text-xs text-muted">{store.users.get(emoji.created_by)?.display_name ?? "?"} · {emoji.width}×{emoji.height}</span>
            <Button size="sm" variant="ghost" onClick={() => void controller.deleteEmoji(emoji.id)}>削除</Button>
          </li>
        ))}
        {rows.length === 0 && <li className="px-3 py-6 text-center text-sm text-muted">カスタム絵文字はまだありません</li>}
      </ul>
      {adding && <AddEmojiDialog controller={controller} onClose={() => setAdding(false)} />}
    </div>
  );
}
