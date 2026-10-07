import { type CSSProperties, useEffect, useState } from "react";

import type { CustomEmojiOut, EmojiPackImportOut, EmojiPackOut, TextEmojiColor } from "../api/types";
import { TEXT_EMOJI_COLOR_NAMES, TEXT_EMOJI_COLORS, TEXT_EMOJI_LABEL_MAX, textEmojiColors } from "./textEmoji";
import type { AppController } from "../state/app";
import { Button, cn, Field, Input, Modal } from "./primitives";
import { useRef } from "react";
import { packFromDrop, readZipPackFiles } from "./emojiPackSource";
import { t } from "../i18n";

/** Custom emoji (M12f): `:name:` in text and reactions renders as the uploaded image. */

const EXACT = /^:([a-z0-9][a-z0-9_+-]{1,31}):$/;
const INLINE = /:([a-z0-9][a-z0-9_+-]{1,31}):/g;

/** The custom emoji name when `text` is exactly `:name:` (reactions, picker picks). */
export function customEmojiName(text: string): string | null {
  const match = EXACT.exec(text);
  return match ? match[1]! : null;
}

/**
 * A reaction as plain text (a notification banner cannot draw the image): a workspace emoji with a label as 【label】,
 * like the server's reaction push (planner.reaction_text); a standard one, or one without a label, as it is.
 */
export function reactionText(emoji: string, custom: ReadonlyMap<string, Pick<CustomEmojiOut, "label">>): string {
  const name = customEmojiName(emoji);
  const label = name ? custom.get(name)?.label?.trim() : "";
  return label ? `【${label}】` : emoji;
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

/** Fetches `path` once per `key` (with the bearer token) and keeps the object URL for the session. */
function loadBlobUrl(controller: AppController, key: string, path: string): Promise<string | null> {
  const hit = urls.get(key);
  if (hit) return Promise.resolve(hit);
  let pending = loading.get(key);
  if (!pending) {
    pending = (async () => {
      try {
        const blob = await controller.api!.fetchBlob(path);
        const url = URL.createObjectURL(blob);
        urls.set(key, url);
        return url;
      } catch {
        failed.add(key);
        return null;
      } finally {
        loading.delete(key);
      }
    })();
    loading.set(key, pending);
  }
  return pending;
}

/** Fetches the image once per emoji id (with the bearer token) and keeps the object URL for the session. */
export function loadCustomEmojiUrl(controller: AppController, emoji: CustomEmojiOut): Promise<string | null> {
  return loadBlobUrl(controller, emoji.id, `/api/v1/emoji/${emoji.id}/image`);
}

/** An object URL for `key` (fetched from `path` once): state is keyed, so a reused component never shows another's. */
function useBlobUrl(controller: AppController, key: string | null, path: string): string | null {
  const [loaded, setLoaded] = useState<{ key: string; url: string | null } | null>(null);
  const url = key ? urls.get(key) ?? (loaded?.key === key ? loaded.url : null) : null;
  useEffect(() => {
    if (!key || urls.has(key) || !controller.api) return;
    let live = true;
    void loadBlobUrl(controller, key, path).then((next) => { if (live) setLoaded({ key, url: next }); });
    return () => { live = false; };
  }, [key, controller.api]);
  return url;
}

/** The image of `emoji`: a component reused for another emoji never shows the previous one (state is keyed by id). */
export function useCustomEmojiUrl(controller: AppController, emoji: CustomEmojiOut): string | null {
  return useBlobUrl(controller, emoji.id, `/api/v1/emoji/${emoji.id}/image`);
}

/** M100: a pack's tab icon (GET /emoji/packs/{id}/tab), cached per `tab_version`. */
export function usePackTabUrl(controller: AppController, pack: EmojiPackOut): string | null {
  return useBlobUrl(controller, pack.tab_version ? `pack:${pack.id}:${pack.tab_version}` : null, `/api/v1/emoji/packs/${pack.id}/tab`);
}

/** M100 (docs/EMOJI.md §2): a wide image emoji is drawn wider at the same height, at most 3:1; never narrower than square. */
export const WIDE_EMOJI_MAX = 3;

export function customEmojiAspect(emoji: Pick<CustomEmojiOut, "width" | "height"> & { kind?: string }): number {
  if (emoji.kind === "text" || !emoji.width || !emoji.height) return 1;
  return Math.min(WIDE_EMOJI_MAX, Math.max(1, emoji.width / emoji.height));
}

/**
 * A custom emoji: the image, or (kind "text", M100) its label as a pill. `size` in pixels, or a CSS length such as
 * "1.375em" to follow the text around it (a heading's emoji is as large as the heading).
 *
 * Always a fixed box (2026-10-04, 「高さが違う・ガタつく」): before, the image was `width: auto`, so it had no
 * width until decoded and another one than its loading placeholder; a message's lines could re-wrap and the timeline
 * jump when it loaded (a remount decodes again). Now the placeholder and the image take the same box: `size` high and
 * `size` × the stored aspect ratio wide (M100: a wide emoji keeps its shape, at most 3:1; the ratio is known before the
 * image loads), the image fitted into it (`object-fit: contain`). Its middle is where a standard emoji glyph's middle
 * is (Apple Color Emoji: about 0.38em above the baseline). `square` (picker cells) keeps the box square, a wide image
 * fitted into it.
 *
 * `inline` (a run of text: a message, a status line): the box also counts as exactly 1em tall for the line (negative
 * margins), like a standard emoji glyph, so a larger image never makes its line taller than one without it.
 */
export function CustomEmojiImage(props: { controller: AppController; emoji: CustomEmojiOut; size?: number | string; className?: string; inline?: boolean; square?: boolean }) {
  if (props.emoji.kind === "text") return <TextEmojiPill emoji={props.emoji} size={props.size} className={props.className} inline={props.inline} square={props.square} />;
  return <CustomEmojiPicture {...props} />;
}

function CustomEmojiPicture({ controller, emoji, size = 20, className, inline = false, square = false }: { controller: AppController; emoji: CustomEmojiOut; size?: number | string; className?: string; inline?: boolean; square?: boolean }) {
  const url = useCustomEmojiUrl(controller, emoji);
  if (!url && failed.has(emoji.id)) return <span className={cn("text-muted", className)}>:{emoji.name}:</span>;
  const aspect = square ? 1 : customEmojiAspect(emoji);
  const style = customEmojiBoxStyle(size, inline, aspect);
  // Loading: its room, blank (the name as text was wider than a picker's cell).
  if (!url) return <span aria-hidden data-custom-emoji={emoji.name} className={cn("inline-block shrink-0", className)} style={style} />;
  const px = typeof size === "number" ? size : undefined;
  const title = emoji.label ? `${emoji.label} :${emoji.name}:` : `:${emoji.name}:`;
  return <img src={url} alt={`:${emoji.name}:`} title={title} width={px === undefined ? undefined : Math.round(px * aspect)} height={px} draggable={false} data-custom-emoji={emoji.name} className={cn("inline-block shrink-0", className)} style={{ ...style, objectFit: "contain" }} />;
}

/** The box of a custom emoji (also for the tests): see CustomEmojiImage. `aspect` = width / height (1 to 3). */
export function customEmojiBoxStyle(size: number | string, inline: boolean, aspect = 1): CSSProperties {
  const length = typeof size === "number" ? `${size}px` : size;
  const width = aspect === 1 ? length : typeof size === "number" ? `${Math.round(size * aspect)}px` : `calc(${length} * ${Number(aspect.toFixed(3))})`;
  const box: CSSProperties = { width, height: length, minWidth: width };
  if (!inline) return { ...box, verticalAlign: `calc(0.38em - ${length} / 2)` };
  // The margin box is 1em tall from 0.12em below the baseline: the image's middle at 0.38em, the line box unchanged.
  const margin = `calc((1em - ${length}) / 2)`;
  return { ...box, marginTop: margin, marginBottom: margin, verticalAlign: "-0.12em" };
}

/**
 * A text emoji (M100, docs/EMOJI.md §1): its label as a pill, as high as an image emoji of the same `size` (the same
 * box rules, the width follows the text), in its palette colour (apps/shared/text-emoji.json; light and dark).
 * Drawn at once (no image to load), so it never shifts the line. `square` (picker cells) caps the width at 3 × size.
 */
export function TextEmojiPill({ emoji, size = 20, className, inline = false, square = false }: { emoji: Pick<CustomEmojiOut, "name" | "label" | "color">; size?: number | string; className?: string; inline?: boolean; square?: boolean }) {
  const length = typeof size === "number" ? `${size}px` : size;
  const box = customEmojiBoxStyle(size, inline);
  const colors = textEmojiColors(emoji.color);
  const style = {
    ...box,
    width: "auto",
    minWidth: length,
    maxWidth: square ? `calc(${length} * 3)` : undefined,
    fontSize: `calc(${length} * 0.68)`,
    lineHeight: length,
    padding: `0 calc(${length} * 0.28)`,
    borderRadius: `calc(${length} * 0.3)`,
    "--te-bg": colors.light.bg,
    "--te-fg": colors.light.fg,
    "--te-bg-dark": colors.dark.bg,
    "--te-fg-dark": colors.dark.fg,
  } as CSSProperties;
  const label = emoji.label || emoji.name;
  return (
    <span role="img" aria-label={label} title={`${label} :${emoji.name}:`} data-custom-emoji={emoji.name} data-text-emoji="" className={cn("text-emoji inline-block shrink-0 overflow-hidden text-ellipsis whitespace-nowrap text-center font-semibold", className)} style={style}>
      {label}
    </span>
  );
}

/** Keywords typed as one line: 、 , and spaces separate them. */
export function splitKeywords(text: string): string[] {
  return [...new Set(text.split(/[,、，\s]+/u).map((k) => k.trim()).filter(Boolean))];
}

const NAME_RE = /^[a-z0-9][a-z0-9_+-]{1,31}$/;

/** Add a custom emoji (M12f): a name and a small image, or (M100) a text emoji (a short label as a pill); any member may. */
export function AddEmojiDialog({ controller, onClose }: { controller: AppController; onClose: () => void }) {
  const [kind, setKind] = useState<"image" | "text">("image");
  const [name, setName] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [label, setLabel] = useState("");
  const [color, setColor] = useState<TextEmojiColor>("gray");
  const [keywords, setKeywords] = useState("");
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const labelLength = [...label.trim()].length;
  const valid = NAME_RE.test(name) && (kind === "image" ? !!file : labelLength > 0 && labelLength <= TEXT_EMOJI_LABEL_MAX);
  const submit = async () => {
    if (!valid) return;
    setBusy(true);
    const words = splitKeywords(keywords);
    const ok = kind === "image"
      ? await controller.uploadEmoji(name, file!, { label: label.trim() || null, keywords: words })
      : await controller.createTextEmoji({ name, label: label.trim(), color, keywords: words });
    setBusy(false);
    if (ok) onClose();
  };
  return (
    <Modal onClose={onClose} title={t("emoji.add")} className="w-[440px]">
      <div className="mt-3 space-y-3">
        <div className="flex gap-1" role="radiogroup" aria-label={t("tasks.kind")}>
          {(["image", "text"] as const).map((k) => (
            <button key={k} type="button" role="radio" aria-checked={kind === k} onClick={() => setKind(k)} className={cn("rounded-md px-3 py-1 text-sm", kind === k ? "bg-accent-soft text-accent" : "text-muted hover:bg-panel")}>
              {k === "image" ? t("emoji.kindImage") : t("emoji.kindText")}
            </button>
          ))}
        </div>
        <Field label={t("emoji.nameLabel")}>
          <Input value={name} autoFocus placeholder={kind === "image" ? t("emoji.namePlaceholderImage") : t("emoji.namePlaceholderText")} onChange={(e) => setName(e.target.value.trim().toLowerCase())} />
          {name && <div className="mt-1 text-xs text-muted">{t("emoji.writeAs", { name })}</div>}
        </Field>
        {kind === "image" ? (
          <Field label={t("emoji.imageLabel")}>
            <input ref={input} type="file" accept="image/png,image/gif,image/jpeg,image/webp" className="text-sm" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          </Field>
        ) : (
          <>
            <Field label={t("emoji.textLabel", { max: TEXT_EMOJI_LABEL_MAX })}>
              <Input value={label} placeholder={t("emoji.textPlaceholder")} onChange={(e) => setLabel(e.target.value)} />
              {labelLength > TEXT_EMOJI_LABEL_MAX && <div className="mt-1 text-xs text-danger">{t("emoji.textTooLong", { max: TEXT_EMOJI_LABEL_MAX })}</div>}
            </Field>
            <Field label={t("emoji.color")}>
              <div className="flex flex-wrap gap-1.5">
                {(Object.keys(TEXT_EMOJI_COLORS) as TextEmojiColor[]).map((key) => (
                  <button key={key} type="button" aria-pressed={color === key} title={TEXT_EMOJI_COLOR_NAMES[key]} onClick={() => setColor(key)} className={cn("rounded-md p-0.5", color === key ? "ring-2 ring-accent" : "")}>
                    <TextEmojiPill emoji={{ name: key, label: label.trim() || TEXT_EMOJI_COLOR_NAMES[key], color: key }} size={22} />
                  </button>
                ))}
              </div>
            </Field>
          </>
        )}
        {kind === "image" && (
          <Field label={t("emoji.labelLabel")}>
            <Input value={label} placeholder={t("emoji.labelPlaceholder")} onChange={(e) => setLabel(e.target.value)} />
          </Field>
        )}
        <Field label={t("emoji.keywordsOptional")}>
          <Input value={keywords} placeholder={t("emoji.keywordsPlaceholder")} onChange={(e) => setKeywords(e.target.value)} />
        </Field>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>{t("common.cancel")}</Button>
          <Button disabled={!valid || busy} onClick={() => void submit()}>{t("common.add")}</Button>
        </div>
      </div>
    </Modal>
  );
}

/** M100: change a custom emoji's label, colour (text) and keywords; an admin also its pack. */
export function EditEmojiDialog({ controller, emoji, onClose }: { controller: AppController; emoji: CustomEmojiOut; onClose: () => void }) {
  const [label, setLabel] = useState(emoji.label ?? "");
  const [color, setColor] = useState<TextEmojiColor>((emoji.color ?? "gray") as TextEmojiColor);
  const [keywords, setKeywords] = useState((emoji.keywords ?? []).join(" "));
  const [packId, setPackId] = useState(emoji.pack_id ?? "");
  const [busy, setBusy] = useState(false);
  const admin = controller.can("emoji.manage"); // M142: administrators and managers
  const packs = controller.store.sortedEmojiPacks();
  const text = emoji.kind === "text";
  const labelLength = [...label.trim()].length;
  const valid = !text || (labelLength > 0 && labelLength <= TEXT_EMOJI_LABEL_MAX);
  const submit = async () => {
    setBusy(true);
    const ok = await controller.updateEmoji(emoji.id, {
      label: label.trim() || null,
      keywords: splitKeywords(keywords),
      ...(text ? { color } : {}),
      ...(admin && (packId || null) !== (emoji.pack_id ?? null) ? { pack_id: packId || null } : {}),
    });
    setBusy(false);
    if (ok) onClose();
  };
  return (
    <Modal onClose={onClose} title={t("emoji.editTitle", { name: emoji.name })} className="w-[440px]">
      <div className="mt-3 space-y-3">
        <Field label={text ? t("emoji.textLabel", { max: TEXT_EMOJI_LABEL_MAX }) : t("emoji.labelOptional")}>
          <Input value={label} autoFocus onChange={(e) => setLabel(e.target.value)} />
        </Field>
        {text && (
          <Field label={t("emoji.color")}>
            <div className="flex flex-wrap gap-1.5">
              {(Object.keys(TEXT_EMOJI_COLORS) as TextEmojiColor[]).map((key) => (
                <button key={key} type="button" aria-pressed={color === key} title={TEXT_EMOJI_COLOR_NAMES[key]} onClick={() => setColor(key)} className={cn("rounded-md p-0.5", color === key ? "ring-2 ring-accent" : "")}>
                  <TextEmojiPill emoji={{ name: key, label: label.trim() || TEXT_EMOJI_COLOR_NAMES[key], color: key }} size={22} />
                </button>
              ))}
            </div>
          </Field>
        )}
        <Field label={t("emoji.keywords")}>
          <Input value={keywords} onChange={(e) => setKeywords(e.target.value)} />
        </Field>
        {admin && (
          <Field label={t("emoji.pack")}>
            <select value={packId} onChange={(e) => setPackId(e.target.value)} className="h-9 w-full rounded-lg border border-line bg-canvas px-2 text-sm">
              <option value="">{t("emoji.noPack")}</option>
              {packs.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </Field>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>{t("common.cancel")}</Button>
          <Button disabled={!valid || busy} onClick={() => void submit()}>{t("common.save")}</Button>
        </div>
      </div>
    </Modal>
  );
}

type PackManifestPreview = { name: string; items: number; missing: string[]; thumbnails: string[] };

const THUMBNAILS = 6;

/** What a folder's pack.json says, before uploading (the server checks everything again). */
export async function previewPackFolder(files: File[]): Promise<PackManifestPreview | string> {
  const manifest = files.find((f) => f.name === "pack.json");
  if (!manifest) return t("emoji.packNoManifest");
  let parsed: { name?: unknown; items?: Array<{ file?: unknown }>; tab?: unknown };
  try {
    parsed = JSON.parse(await manifest.text());
  } catch {
    return t("emoji.packBadJson");
  }
  const names = new Set(files.map((f) => f.name.normalize("NFC")));
  const items = Array.isArray(parsed.items) ? parsed.items.map((i) => String(i?.file ?? "")) : [];
  const wanted = [...items, ...(typeof parsed.tab === "string" ? [parsed.tab] : [])];
  return {
    name: typeof parsed.name === "string" ? parsed.name : t("emoji.packNoName"),
    items: items.length,
    missing: wanted.filter((f) => !names.has(f.normalize("NFC"))),
    thumbnails: items.filter((f) => names.has(f.normalize("NFC"))).slice(0, THUMBNAILS),
  };
}

/** Image and manifest files of a chosen folder (notes such as タグ案.md stay behind). */
export function packFiles(files: File[]): File[] {
  return files.filter((f) => f.name === "pack.json" || /\.(png|gif|jpe?g|webp)$/i.test(f.name));
}

type PackSource = { archive: File } | { files: File[] };
type Picked = {
  source: PackSource;
  /** The folder's or the ZIP's name, as the admin knows it. */
  label: string;
  /** null: a ZIP this app cannot look into (the server still reads it). */
  preview: PackManifestPreview | string | null;
  files: File[];
};

/** Read what was picked or dropped into the preview the dialog shows. */
export async function pickPack(source: PackSource): Promise<Picked> {
  if ("archive" in source) {
    const inside = await readZipPackFiles(source.archive);
    const files = inside ? packFiles(inside) : [];
    return { source, label: source.archive.name, preview: inside ? await previewPackFolder(files) : null, files };
  }
  const files = packFiles(source.files);
  const label = (source.files[0] as (File & { webkitRelativePath?: string }) | undefined)?.webkitRelativePath?.split("/")[0] || t("emoji.folder");
  return {
    source: { files },
    label,
    preview: files.length ? await previewPackFolder(files) : t("emoji.packNothingFound"),
    files,
  };
}

function PackThumbnails({ files, names }: { files: File[]; names: string[] }) {
  const [urls, setUrls] = useState<string[]>([]);
  useEffect(() => {
    const byName = new Map(files.map((f) => [f.name.normalize("NFC"), f]));
    const made = names.flatMap((n) => { const f = byName.get(n.normalize("NFC")); return f ? [URL.createObjectURL(f)] : []; });
    setUrls(made);
    return () => made.forEach((u) => URL.revokeObjectURL(u));
  }, [files, names]);
  if (!urls.length) return null;
  return (
    <div className="mt-2 flex gap-1.5" aria-label={t("emoji.samples")}>
      {urls.map((u) => <img key={u} src={u} alt="" className="h-10 w-10 rounded object-contain" />)}
    </div>
  );
}

/** M100 (admin): 「セットを追加」: a folder or a ZIP with pack.json; importing again updates labels and keywords. */
export function ImportPackDialog({ controller, onClose }: { controller: AppController; onClose: () => void }) {
  const [picked, setPicked] = useState<Picked | null>(null);
  const [result, setResult] = useState<EmojiPackImportOut | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const folderInput = useRef<HTMLInputElement>(null);
  const zipInput = useRef<HTMLInputElement>(null);
  const choose = async (source: PackSource | null, hint?: string) => {
    setResult(null);
    setError(source ? null : hint ?? null);
    setPicked(source ? await pickPack(source) : null);
  };
  const reset = () => {
    setPicked(null);
    setResult(null);
    setError(null);
    if (folderInput.current) folderInput.current.value = "";
    if (zipInput.current) zipInput.current.value = "";
  };
  const submit = async () => {
    if (!picked) return;
    setBusy(true);
    setError(null);
    const done = await controller.importEmojiPack(picked.source);
    setBusy(false);
    if (typeof done === "string") setError(done);
    else setResult(done);
  };
  const preview = picked?.preview;
  const blocked = typeof preview === "string" || (!!preview && preview.missing.length > 0);
  return (
    <Modal onClose={onClose} title={t("emoji.addPack")} className="w-[480px]">
      <div
        className={cn("mt-3 space-y-3 rounded-lg text-sm", dragging && "ring-2 ring-accent")}
        onDragOver={(e) => { if (e.dataTransfer?.types.includes("Files")) { e.preventDefault(); setDragging(true); } }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          if (busy) return;
          void packFromDrop(e.dataTransfer).then((source) => choose(source, t("emoji.dropHint")));
        }}
      >
        {!picked ? (
          <>
            <p>{t("emoji.packChoose")}</p>
            <div className="grid grid-cols-2 gap-2">
              <Button variant="secondary" className="h-16" onClick={() => folderInput.current?.click()}>{t("emoji.chooseFolder")}</Button>
              <Button variant="secondary" className="h-16" onClick={() => zipInput.current?.click()}>{t("emoji.chooseZip")}</Button>
            </div>
            {/* webkitdirectory: the whole folder (WebView2, WKWebView, browsers). */}
            <input ref={folderInput} type="file" multiple hidden data-testid="pack-folder" {...({ webkitdirectory: "", directory: "" } as Record<string, string>)} onChange={(e) => void choose(e.target.files?.length ? { files: [...e.target.files] } : null)} />
            <input ref={zipInput} type="file" hidden data-testid="pack-zip" accept=".zip,application/zip" onChange={(e) => { const f = e.target.files?.[0]; void choose(f ? { archive: f } : null); }} />
            <details className="text-xs text-muted">
              <summary className="cursor-pointer">{t("emoji.packHowTo")}</summary>
              <p className="mt-1">
                {t("emoji.packHelp")}
              </p>
            </details>
          </>
        ) : (
          <div className="rounded-lg border border-line p-3" aria-label={t("emoji.importContents")}>
            <div className="truncate text-xs text-muted">{picked.label}</div>
            {preview === null && <div className="mt-1">{t("emoji.zipUnchecked")}</div>}
            {typeof preview === "string" && <div className="mt-1 text-danger">{preview}</div>}
            {preview && typeof preview !== "string" && (
              <>
                <div className="mt-1 font-semibold">{t("emoji.packPreview", { name: preview.name, count: preview.items })}</div>
                {preview.missing.length > 0 && <div className="mt-1 text-xs text-danger">{t("emoji.missingFiles", { files: preview.missing.join(t("common.listSeparator")) })}</div>}
                <PackThumbnails files={picked.files} names={preview.thumbnails} />
              </>
            )}
          </div>
        )}
        {error && <div className="text-xs text-danger" role="alert">{error}</div>}
        {result && (
          <div className="rounded-lg border border-line bg-panel p-2 text-xs" role="status">
            {t("emoji.imported", { name: result.pack.name, created: result.created.length, updated: result.updated.length, unchanged: result.unchanged.length })}
          </div>
        )}
        <div className="flex justify-end gap-2">
          {picked && !result && <Button variant="ghost" disabled={busy} onClick={reset}>{t("emoji.chooseAgain")}</Button>}
          <Button variant="secondary" onClick={onClose}>{result ? t("common.close") : t("common.cancel")}</Button>
          {!result && <Button disabled={!picked || blocked || busy} onClick={() => void submit()}>{busy ? t("emoji.importing") : t("emoji.import")}</Button>}
        </div>
      </div>
    </Modal>
  );
}

/** The admin dialog's 絵文字 tab (M12f): every custom emoji with its creator, and removal; M100: packs and editing. */
export function EmojiAdminTab({ controller }: { controller: AppController }) {
  const store = controller.store;
  const [adding, setAdding] = useState(false);
  const [importing, setImporting] = useState(false);
  const [editing, setEditing] = useState<CustomEmojiOut | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const packs = store.sortedEmojiPacks();
  const rows = [...store.customEmoji.values()].sort((a, b) => a.name.localeCompare(b.name));
  const ungrouped = rows.filter((e) => !e.pack_id || !store.emojiPacks.has(e.pack_id));
  const move = (index: number, delta: number) => {
    const order = [...packs];
    const [item] = order.splice(index, 1);
    order.splice(index + delta, 0, item!);
    void Promise.all(order.map((p, i) => (p.position === i ? null : controller.updateEmojiPack(p.id, { position: i }))));
  };
  const row = (emoji: CustomEmojiOut) => (
    <li key={emoji.id} className="flex items-center gap-3 px-3 py-2 text-sm">
      <span className="flex w-20 shrink-0 justify-center overflow-hidden"><CustomEmojiImage controller={controller} emoji={emoji} size={24} square /></span>
      <span className="font-mono text-[13px]">:{emoji.name}:</span>
      <span className="flex-1 truncate text-xs text-muted">
        {emoji.label ? `${emoji.label} · ` : ""}
        {(emoji.keywords ?? []).length ? `${(emoji.keywords ?? []).join("、")} · ` : ""}
        {store.users.get(emoji.created_by)?.display_name ?? "?"}{emoji.kind === "text" ? ` · ${t("emoji.kindText")}` : ` · ${emoji.width}×${emoji.height}`}
      </span>
      <Button size="sm" variant="ghost" onClick={() => setEditing(emoji)}>{t("canvas.edit")}</Button>
      <Button size="sm" variant="ghost" onClick={() => void controller.deleteEmoji(emoji.id)}>{t("common.delete")}</Button>
    </li>
  );
  return (
    <div className="mt-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-xs text-muted">{t("emoji.listNote", { count: rows.length })}</span>
        <div className="flex gap-2">
          <Button size="sm" variant="secondary" onClick={() => setImporting(true)}>{t("emoji.addPackShort")}</Button>
          <Button size="sm" onClick={() => setAdding(true)}>{t("emoji.add")}</Button>
        </div>
      </div>
      {packs.map((pack, index) => {
        const members = rows.filter((e) => e.pack_id === pack.id).sort((a, b) => (a.position ?? 0) - (b.position ?? 0) || a.name.localeCompare(b.name));
        return (
          <section key={pack.id} className="mb-3" aria-label={t("emoji.packLabel", { name: pack.name })}>
            <div className="mb-1 flex items-center gap-2">
              {renaming?.id === pack.id ? (
                <>
                  <Input value={renaming.name} autoFocus className="h-7 w-48 text-sm" onChange={(e) => setRenaming({ id: pack.id, name: e.target.value })} />
                  <Button size="sm" onClick={() => { void controller.updateEmojiPack(pack.id, { name: renaming.name }).then((ok) => { if (ok) setRenaming(null); }); }}>{t("common.save")}</Button>
                  <Button size="sm" variant="ghost" onClick={() => setRenaming(null)}>{t("common.cancel")}</Button>
                </>
              ) : (
                <>
                  <span className="text-sm font-semibold">{pack.name}</span>
                  <span className="text-xs text-muted">{t("emoji.packCount", { count: members.length })}</span>
                  <span className="flex-1" />
                  <Button size="sm" variant="ghost" disabled={index === 0} onClick={() => move(index, -1)} aria-label={t("emoji.earlier")}>↑</Button>
                  <Button size="sm" variant="ghost" disabled={index === packs.length - 1} onClick={() => move(index, 1)} aria-label={t("emoji.later")}>↓</Button>
                  <Button size="sm" variant="ghost" onClick={() => setRenaming({ id: pack.id, name: pack.name })}>{t("channel.rename")}</Button>
                  <Button size="sm" variant="ghost" onClick={() => { if (window.confirm(t("emoji.deletePackConfirm", { name: pack.name }))) void controller.deleteEmojiPack(pack.id); }}>{t("emoji.deletePack")}</Button>
                </>
              )}
            </div>
            <ul className="divide-y divide-line rounded-xl border border-line">{members.map(row)}</ul>
          </section>
        );
      })}
      {packs.length > 0 && <div className="mb-1 text-sm font-semibold">{t("emoji.noPackHeading")}</div>}
      <ul className="divide-y divide-line rounded-xl border border-line">
        {ungrouped.map(row)}
        {rows.length === 0 && <li className="px-3 py-6 text-center text-sm text-muted">{t("emoji.none")}</li>}
      </ul>
      {adding && <AddEmojiDialog controller={controller} onClose={() => setAdding(false)} />}
      {importing && <ImportPackDialog controller={controller} onClose={() => setImporting(false)} />}
      {editing && <EditEmojiDialog controller={controller} emoji={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}
