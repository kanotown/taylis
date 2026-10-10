/**
 * M153a (WIKI.md §30.3): the page editor's environment inside the phones' WebView — PageEditorEnv and PageEditorSink
 * (ui/pageEditorEnv.tsx) over the native bridge (apps/shared/mobile-editor/src/bridge.ts). The app's directory (people,
 * pages, custom emoji) is what native provided; images load from native's URL scheme; links, pictures and errors go
 * to native. Nothing here talks to the server.
 */
import { FileText, ImageOff, Search, Table2 } from "lucide-react";
import { type ReactNode, useState, useSyncExternalStore } from "react";

import type { Bridge, BridgeEmoji, BridgePage, BridgePerson } from "../../../shared/mobile-editor/src/bridge";
import type { GroupOut, PageRef, UserPublic } from "../api/types";
import { t } from "../i18n";
import { customEmojiBoxStyle, TextEmojiPill } from "../ui/customEmoji";
import { EMOJI, type EmojiEntry, replaceShortcodes, searchEmoji } from "../ui/emoji";
import type { PageEditorEnv, PageEditorPeople, PageEditorSink } from "../ui/pageEditorEnv";
import { cn } from "../ui/primitives";

/** How long a `needPages` waits for its `providePages` before the menu shows nothing. */
const LOOKUP_TIMEOUT_MS = 15_000;
/** How long after compositionend a held-back `replace` goes in (ProseMirror ends its composition within 20 ms). */
export const COMPOSITION_SETTLE_MS = 50;

/** The people, pages and emoji native provided, and the pictures' URLs. One for the page's lifetime (loads share it). */
export class BridgeDirectory {
  readonly users = new Map<string, UserPublic>();
  readonly groups = new Map<string, GroupOut>();
  aiBotIds: Set<string> | null = null;
  /** Every page seen (chips show its current title and icon). */
  readonly pages = new Map<string, BridgePage>();
  /** The whole tree, when native sent it (`providePages` with query null): lookups are answered here. */
  private allPages: BridgePage[] | null = null;
  private readonly answers = new Map<string, BridgePage[]>();
  private readonly waiting = new Map<string, Array<(pages: PageRef[]) => void>>();
  readonly emoji = new Map<string, BridgeEmoji>();
  private readonly imageUrls = new Map<string, string>();
  /** `load.attachmentUrl`: where images load from, `{id}` for the attachment's id. */
  attachmentUrl: string | null = null;
  version = 0;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly bridge: Bridge) {}

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private bump(): void {
    this.version += 1;
    for (const listener of this.listeners) listener();
  }

  people(): PageEditorPeople {
    return { users: this.users, groups: this.groups, aiBotIds: this.aiBotIds };
  }

  /** `providePeople`: the directory as mentions.ts reads it (the fields it looks at; the rest is blank). */
  setPeople(people: BridgePerson[]): void {
    this.users.clear();
    this.groups.clear();
    const ai = new Set<string>();
    for (const person of people) {
      if (person.kind === "group") {
        this.groups.set(person.id, { id: person.id, name: person.username, description: person.description ?? null, member_ids: Array.from({ length: Math.max(0, person.members ?? 0) }, () => ""), created_at: "", created_by: "" } as unknown as GroupOut);
        continue;
      }
      if (person.ai) ai.add(person.id);
      this.users.set(person.id, { id: person.id, username: person.username, display_name: person.display_name, role: person.ai ? "bot" : "member", bot_kind: person.ai ? "ai" : null, created_at: "", updated_at: "", deactivated_at: null } as UserPublic);
    }
    this.aiBotIds = ai;
    this.bump();
  }

  /** `providePages`: the answer to a query, or the whole tree (query null). */
  setPages(query: string | null, pages: BridgePage[]): void {
    for (const page of pages) this.pages.set(page.id, page);
    if (query === null) {
      this.allPages = pages;
      for (const [key, resolvers] of this.waiting) {
        this.waiting.delete(key);
        const found = this.filter(pages, key);
        resolvers.forEach((resolve) => resolve(found));
      }
    } else {
      const key = query.trim();
      this.answers.set(key, pages);
      const resolvers = this.waiting.get(key) ?? [];
      this.waiting.delete(key);
      const found = pages.map(toPageRef);
      resolvers.forEach((resolve) => resolve(found));
    }
    this.bump();
  }

  private filter(pages: BridgePage[], query: string): PageRef[] {
    const q = query.toLowerCase();
    return pages.filter((page) => !q || page.title.toLowerCase().includes(q)).slice(0, 20).map(toPageRef);
  }

  /** `[[`, `@` and ⌘K: the pages whose title holds `query` — from the tree native sent, else asked of native. */
  lookupPages(query: string): Promise<PageRef[]> {
    const key = query.trim();
    const answered = this.answers.get(key);
    if (answered) return Promise.resolve(answered.map(toPageRef));
    if (this.allPages) return Promise.resolve(this.filter(this.allPages, key));
    this.bridge.send({ type: "needPages", query: key });
    return new Promise((resolve) => {
      const resolvers = this.waiting.get(key) ?? [];
      resolvers.push(resolve);
      this.waiting.set(key, resolvers);
      setTimeout(() => {
        const left = this.waiting.get(key);
        if (!left?.includes(resolve)) return;
        this.waiting.set(key, left.filter((r) => r !== resolve));
        resolve([]);
      }, LOOKUP_TIMEOUT_MS);
    });
  }

  setEmoji(list: BridgeEmoji[]): void {
    this.emoji.clear();
    for (const emoji of list) this.emoji.set(emoji.name, emoji);
    this.bump();
  }

  /** `insertImage` with its own URL. */
  setImageUrl(attachmentId: string, url: string): void {
    this.imageUrls.set(attachmentId, url);
  }

  imageUrl(attachmentId: string): string | null {
    return this.imageUrls.get(attachmentId) ?? (this.attachmentUrl ? this.attachmentUrl.replace("{id}", encodeURIComponent(attachmentId)) : null);
  }
}

function toPageRef(page: BridgePage): PageRef {
  return { id: page.id, title: page.title, icon: page.icon ?? null, kind: page.kind ?? "page" };
}

/**
 * The save loop as the editor sees it, over the bridge: `changed` goes to native when typing pauses (native's own
 * CanvasSaver saves, merges and retries); a `replace` from native goes into the editor at once, or waits while an IME
 * composition is open or an edit is about to be written (the editor's canReplace), as Desktop's loop does.
 *
 * `baseGen` is the `gen` of the last `load` / `replace` the editor took, sent with every `changed` / `bodyRequested`: a
 * replacement that waited and was dropped leaves it where it was, so native knows the text was written on the body
 * before that merge and saves it on the version that body came from (the server merges again, §30.3).
 */
export class BridgeSink implements PageEditorSink {
  text: string;
  textRevision = 0;
  canReplace: () => boolean = () => true;
  /** The `gen` of the body the text is written on (undefined: native sent none). */
  baseGen: number | undefined;
  /** The body as last loaded or replaced: `dirty` is being away from it. */
  private base: string;
  /** A replacement that waited for a composition to end (dropped when an edit goes out first). */
  private pending: { body: string; gen: number | undefined } | null = null;
  private quietDepth = 0;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly bridge: Bridge, body: string, private readonly caretLine: () => number, gen?: number) {
    this.text = body;
    this.base = body;
    this.baseGen = gen;
  }

  /** `baseGen` as a message field (absent when native sent no `gen`). */
  gen(): { baseGen?: number } {
    return this.baseGen === undefined ? {} : { baseGen: this.baseGen };
  }

  get dirty(): boolean {
    return this.text !== this.base;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  edit(text: string): void {
    if (text === this.text) return;
    this.text = text;
    // A merged body held back is stale now: native merges this text (on the version of `baseGen`, which stays where it
    // was) and sends the result again.
    this.pending = null;
    if (this.quietDepth === 0) this.bridge.send({ type: "changed", body: text, dirty: this.dirty, ...this.gen() });
  }

  /** The editor lost the focus, ⌘S, the page hiding: the caret's line for the Markdown editor (the body already went out). */
  flush(): void {
    this.bridge.send({ type: "caret", line: this.caretLine() });
  }

  compositionEnded(): void {
    if (this.pending === null) return;
    // After ProseMirror's own compositionend work (it runs after the editor's handler and finishes a little later):
    // as Desktop's loop, which reads the page again once the composition is over.
    setTimeout(() => {
      if (this.pending !== null && this.canReplace()) this.apply(this.pending.body, this.pending.gen);
    }, COMPOSITION_SETTLE_MS);
  }

  /** `replace` from native. */
  replace(body: string, gen?: number): void {
    if (body === this.text) {
      // The text is that body already (what is still unwritten is typed on it): written on `gen` from now.
      this.base = body;
      this.baseGen = gen;
      this.pending = null;
      return;
    }
    if (!this.canReplace()) {
      this.pending = { body, gen };
      return;
    }
    this.apply(body, gen);
  }

  private apply(body: string, gen: number | undefined): void {
    this.pending = null;
    this.base = body;
    this.baseGen = gen;
    this.text = body;
    this.textRevision += 1;
    for (const listener of this.listeners) listener();
  }

  /** Runs `fn` without a `changed` going out (requestBody writes the editor's text here and answers with it). */
  quiet(fn: () => void): void {
    this.quietDepth += 1;
    try {
      fn();
    } finally {
      this.quietDepth -= 1;
    }
  }
}

export function bridgePageEditorEnv(bridge: Bridge, directory: BridgeDirectory, readOnly: () => boolean): PageEditorEnv {
  const open = (url: string) => bridge.send({ type: "openLink", url });
  return {
    subscribe: (listener) => directory.subscribe(listener),
    version: () => directory.version,
    isCustomEmoji: (name) => directory.emoji.has(name),
    people: () => directory.people(),
    onMentionQuery: (query) => bridge.send({ type: "needPeople", query }),
    render: {
      pageLink: (id, label) => <PageChip directory={directory} id={id} label={label} onOpen={open} />,
      emoji: (md) => <EmojiView directory={directory} name={md.slice(1, -1)} fallback={replaceShortcodes(md)} />,
      image: (attachmentId, alt) => <ImageView directory={directory} attachmentId={attachmentId} alt={alt} onOpen={open} />,
      embed: (pageId) => <EmbedPlaceholder directory={directory} pageId={pageId} onOpen={open} />,
      calloutIcon: (icon) => (icon ? <span aria-hidden="true"><CalloutIcon directory={directory} icon={icon} /></span> : <span className="text-muted" aria-hidden="true">＋</span>),
      pageIcon: (icon, size) => <PageIconView directory={directory} icon={icon} size={size} />,
      emojiPicker: (onPick) => <SimpleEmojiPicker directory={directory} onPick={onPick} />,
    },
    copyText: (text) => {
      const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard;
      if (!clipboard) return bridge.send({ type: "log", level: "warn", message: "copy: no clipboard" });
      clipboard.writeText(text).catch(() => bridge.send({ type: "log", level: "warn", message: "copy: refused" }));
    },
    showError: (error) => bridge.send({ type: "log", level: "error", message: error instanceof Error ? error.message : String(error) }),
    imageLimitError: () => t("docs.wysiwyg.imageLimit"),
    // A file pasted or dropped into the WebView cannot be uploaded from here (no token): the picker goes through native.
    uploadImage: async () => {
      bridge.send({ type: "log", level: "warn", message: "uploadImage: pasted and dropped pictures are not uploaded by the bundle; use the image button (pickImage)" });
      return null;
    },
    pickImage: () => bridge.send({ type: "pickImage" }),
    toolbar: "bottom",
    readOnly,
    autoFocus: false,
  };
}

// --- what the atoms draw --------------------------------------------------------------------------------------------------

function useDirectory(directory: BridgeDirectory): number {
  return useSyncExternalStore((listener) => directory.subscribe(listener), () => directory.version);
}

const CHIP = "inline-flex max-w-full items-center gap-1 rounded-md px-1 align-baseline leading-6";

/** `[label](page:id)`: the page's current title and icon when native told us about it, else the label as typed. */
function PageChip({ directory, id, label, onOpen }: { directory: BridgeDirectory; id: string; label: string; onOpen: (url: string) => void }) {
  useDirectory(directory);
  const page = directory.pages.get(id);
  const title = page ? page.title || t("docs.untitled") : label || t("docs.untitled");
  return (
    <button type="button" data-page-link={id} data-readable={page ? "true" : "unknown"} className={cn(CHIP, "bg-accent-soft/40 font-medium text-accent")} onClick={(event) => { event.stopPropagation(); onOpen(`page:${id}`); }}>
      <PageIconView directory={directory} icon={page?.icon} size={13} className={page?.icon ? undefined : "text-accent"} />
      <span className="truncate">{title}</span>
    </button>
  );
}

const CUSTOM_NAME = /^:([a-z0-9_+-]{1,64}):$/i;

/** A page's icon: an emoji, a custom emoji (`:name:`) or the page glyph. */
function PageIconView({ directory, icon, size, className }: { directory: BridgeDirectory; icon: string | null | undefined; size: number; className?: string }) {
  if (!icon) return <FileText size={size} className={cn("shrink-0 text-muted", className)} aria-hidden="true" />;
  const custom = CUSTOM_NAME.exec(icon);
  return (
    <span aria-hidden="true" className={cn("inline-flex shrink-0 items-center justify-center leading-none", className)} style={{ fontSize: size, width: size + 2, height: size + 2 }}>
      {custom ? <EmojiView directory={directory} name={custom[1]!} fallback={icon} size={size} /> : replaceShortcodes(icon)}
    </span>
  );
}

/** `:name:`: a custom emoji's picture or pill, else the glyph / the text as typed. */
function EmojiView({ directory, name, fallback, size = "1.375em" }: { directory: BridgeDirectory; name: string; fallback: string; size?: number | string }) {
  useDirectory(directory);
  const [broken, setBroken] = useState(false);
  const custom = directory.emoji.get(name);
  if (!custom) return <span>{fallback}</span>;
  if (custom.kind === "text" || !custom.url) return <TextEmojiPill emoji={{ name: custom.name, label: custom.label ?? null, color: (custom.color ?? null) as never }} size={size} inline />;
  if (broken) return <span className="text-muted">:{custom.name}:</span>;
  const aspect = custom.width && custom.height ? Math.min(3, Math.max(1, custom.width / custom.height)) : 1;
  return <img src={custom.url} alt={`:${custom.name}:`} title={custom.label ? `${custom.label} :${custom.name}:` : `:${custom.name}:`} draggable={false} data-custom-emoji={custom.name} className="inline-block shrink-0" style={{ ...customEmojiBoxStyle(size, true, aspect), objectFit: "contain" }} onError={() => setBroken(true)} />;
}

function CalloutIcon({ directory, icon }: { directory: BridgeDirectory; icon: string }) {
  const custom = CUSTOM_NAME.exec(icon);
  return custom ? <EmojiView directory={directory} name={custom[1]!} fallback={icon} /> : <>{replaceShortcodes(icon)}</>;
}

/** `![alt](attachment:id)`: the picture from native's URL (a tap opens it in the app), or a box with the alt text. */
function ImageView({ directory, attachmentId, alt, onOpen }: { directory: BridgeDirectory; attachmentId: string; alt: string; onOpen: (url: string) => void }) {
  const [failed, setFailed] = useState(false);
  const url = directory.imageUrl(attachmentId);
  if (!url || failed) {
    return (
      <span data-attachment-id={attachmentId} className="my-2 inline-flex items-center gap-2 rounded-lg border border-dashed border-line px-3 py-2 text-sm text-muted">
        <ImageOff size={16} /> {failed ? t("canvasImage.unavailable") : t("attach.loadingImage")}{alt ? `: ${alt}` : ""}
      </span>
    );
  }
  return (
    <>
      <button type="button" data-attachment-id={attachmentId} className="my-2 block max-w-full overflow-hidden rounded-lg border border-line bg-panel" onClick={() => onOpen(`attachment:${attachmentId}`)}>
        <img src={url} alt={alt} loading="lazy" decoding="async" className="block max-h-[480px] max-w-full object-contain" onError={() => setFailed(true)} />
      </button>
      {alt && <span className="-mt-1 mb-2 block text-xs text-muted">{alt}</span>}
    </>
  );
}

/** An embedded database stays what it is in the body; on a phone it is a card that opens the database in the app. */
function EmbedPlaceholder({ directory, pageId, onOpen }: { directory: BridgeDirectory; pageId: string; onOpen: (url: string) => void }) {
  useDirectory(directory);
  const page = directory.pages.get(pageId);
  return (
    <button type="button" data-embed={pageId} className="my-1 flex w-full items-center gap-2 rounded-lg border border-line bg-panel px-3 py-2 text-left text-sm" onClick={() => onOpen(`page:${pageId}`)}>
      <Table2 size={16} className="shrink-0 text-muted" aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate">{page?.title || t("docs.untitled")}</span>
      <span className="shrink-0 text-xs text-muted">{t("docs.wysiwyg.embedInApp")}</span>
    </button>
  );
}

/** A callout's icon on a phone: a search field and the emoji (the workspace's image emoji first). */
function SimpleEmojiPicker({ directory, onPick }: { directory: BridgeDirectory; onPick: (entry: EmojiEntry) => void }) {
  useDirectory(directory);
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const custom = [...directory.emoji.values()].filter((emoji) => !q || emoji.name.includes(q) || (emoji.label ?? "").toLowerCase().includes(q));
  const standard = q ? searchEmoji(q) : EMOJI;
  const cell = "grid h-9 w-9 place-items-center rounded-md text-xl hover:bg-panel";
  const rows: ReactNode[] = [];
  for (const emoji of custom) {
    rows.push(
      <button key={`c:${emoji.name}`} type="button" className={cell} title={`:${emoji.name}:`} aria-label={`:${emoji.name}:`} onMouseDown={(event) => event.preventDefault()} onClick={() => onPick({ shortcode: emoji.name, glyph: "", category: "custom", keywords: emoji.label ?? "" })}>
        <EmojiView directory={directory} name={emoji.name} fallback={`:${emoji.name}:`} size={22} />
      </button>,
    );
  }
  for (const entry of standard) {
    rows.push(
      <button key={entry.shortcode} type="button" className={cell} title={`:${entry.shortcode}:`} aria-label={`:${entry.shortcode}:`} onMouseDown={(event) => event.preventDefault()} onClick={() => onPick(entry)}>
        {entry.glyph}
      </button>,
    );
  }
  return (
    <div className="flex flex-col gap-1.5">
      <label className="flex items-center gap-1.5 rounded-md border border-line bg-canvas px-2 py-1 text-sm">
        <Search size={14} className="shrink-0 text-muted" aria-hidden="true" />
        <input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("emojiPicker.search")} aria-label={t("emojiPicker.search")} className="min-w-0 flex-1 bg-transparent outline-none" />
      </label>
      <div role="listbox" aria-label={t("composer.emoji")} className="grid max-h-64 grid-cols-8 overflow-y-auto">
        {rows}
      </div>
    </div>
  );
}
