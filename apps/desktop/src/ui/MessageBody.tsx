import type { ReactNode } from "react";
import { MessageSquareText } from "lucide-react";
import type { CustomEmojiOut, GroupOut, UserPublic } from "../api/types";
import type { AppController } from "../state/app";
import { type Block, type ListItem, paragraphLayout, parseBlocks, type Token } from "./markdown";
import { replaceShortcodes } from "./emoji";
import { CustomEmojiImage, splitCustomEmoji } from "./customEmoji";
import { splitKeywords } from "./keywords";
import { CanvasLinkCard } from "./CanvasLinkCard";
import { attachmentRefId, pageRefId, parseCanvasLink, parsePageLink, parsePermalink } from "./permalink";
import { FileLinkChip, PageLinkChip } from "./PageLinkChip";
import { openExternalLink } from "../platform/external";
import { cn } from "./primitives";
import { type EmojiOnly, emojiOnly, JUMBO } from "./emojiOnly";
import { t } from "../i18n";
import { MathView } from "./MathView";
import { MentionCard } from "./UserPopover";

const NO_CUSTOM: ReadonlyMap<string, CustomEmojiOut> = new Map();

/**
 * M101 (docs/EMOJI.md §7): an emoji-only body, large. Standard emoji at JUMBO.font, image emoji JUMBO.image high (wide
 * ones wider, at most 3:1), text emoji as JUMBO.pill pills, pack emoji JUMBO.pack high, a single one as a stamp
 * (JUMBO.stamp). Every box has its size before the image loads (customEmoji.tsx), so nothing moves when it comes; the
 * boxes are not `inline` here: the line grows to hold them. Line breaks are kept, runs of spaces collapse.
 */
function JumboEmoji({ body, only, customEmoji, controller, className }: { body: string; only: EmojiOnly; customEmoji: ReadonlyMap<string, CustomEmojiOut>; controller?: AppController; className?: string }) {
  const pieces = splitCustomEmoji(replaceShortcodes(body.trim()), customEmoji);
  return (
    <div data-jumbo={only.stamp ? "stamp" : ""} className={cn("body whitespace-pre-line py-0.5", className)} style={{ fontSize: JUMBO.font, lineHeight: `${JUMBO.lineHeight}px` }}>
      {pieces.map((piece, index) => {
        if (typeof piece === "string") return <span key={index}>{piece}</span>;
        const emoji = customEmoji.get(piece.name)!;
        if (!controller) return <span key={index}>:{piece.name}:</span>;
        const size = emoji.kind === "text" ? JUMBO.pill : emoji.pack_id ? (only.stamp ? JUMBO.stamp : JUMBO.pack) : JUMBO.image;
        return <CustomEmojiImage key={index} controller={controller} emoji={emoji} size={size} />;
      })}
    </div>
  );
}

/** Renders the light markdown subset (DATA_MODEL.md "本文の形式"); mentions resolve to display names. */
export function MessageBody({ body, users, className, internalBase, onOpenMessage, customEmoji, controller, keywords, groups, jumbo = false }: {
  body: string;
  users: Map<string, UserPublic>;
  className?: string;
  /** M12b: links on this server (`<base>/m/<id>`) open the message in place instead of a browser. */
  internalBase?: string | null;
  onOpenMessage?: (messageId: string) => void;
  /** M12f: known custom emoji (by name) and the controller that fetches their images. */
  customEmoji?: ReadonlyMap<string, CustomEmojiOut>;
  controller?: AppController;
  keywords?: readonly string[];
  /** M12k: user groups by id, for `<@group:id>`. */
  groups?: ReadonlyMap<string, GroupOut>;
  /** M101 (docs/EMOJI.md §7): an emoji-only body is shown large (the timeline and threads only, not previews). */
  jumbo?: boolean;
}) {
  const only = jumbo ? emojiOnly(body, customEmoji ?? NO_CUSTOM) : null;
  if (only) return <JumboEmoji body={body} only={only} customEmoji={customEmoji ?? NO_CUSTOM} controller={controller} className={className} />;
  const options: InlineOptions = { internalBase, onOpenMessage, customEmoji, controller, keywords, groups };
  return (
    <div className={cn("body text-[14.5px] leading-6", className)}>
      {parseBlocks(body).map((block, i) => (
        <BlockView key={i} block={block} users={users} options={options} />
      ))}
    </div>
  );
}

export function BlockView({ block, users, options }: { block: Block; users: Map<string, UserPublic>; options?: InlineOptions }) {
  switch (block.kind) {
    case "heading": {
      // Larger than they were (testers, 2026-09-29); custom emoji in them grow with the text (em).
      const size = block.level === 1 ? "text-2xl font-bold" : block.level === 2 ? "text-xl font-bold" : "text-lg font-bold";
      return <div className={cn("mt-1 leading-tight", size)}>{inline(block.tokens, users, options)}</div>;
    }
    // The canvas dialect (only parsed with `canvas: true`; ui/CanvasBody.tsx renders them with working boxes).
    case "task":
      return (
        <ul className="my-0.5 list-none pl-1">
          {block.items.map((item, i) => (
            <li key={i} className={cn("flex items-start gap-2", item.level > 0 && "ml-6")}>
              <input type="checkbox" checked={item.done} disabled readOnly className="mt-1.5" />
              <span className={cn(item.done && "text-muted line-through")}>{inline(item.tokens, users, options)}</span>
            </li>
          ))}
        </ul>
      );
    case "image":
      return <div className="my-1 text-muted">{block.alt ? t("canvasSearch.imageAlt", { alt: block.alt }) : t("canvasSearch.image")}</div>;
    case "hr":
      return <hr className="my-3 border-line" />;
    case "paragraph": {
      // Blank lines at a paragraph's ends separate it from the block before / after (a heading, a list …): a gap
      // there, the same in the timeline and the composer's preview. A trailing blank line drew nothing before (a <br>
      // at a block's end shows no line) while a leading one drew a whole empty line, so "text\n\n# 見出し\n\ntext" put
      // the heading straight under the text and a full line under it (2026-10-04). 2026-10-05: blank lines inside are
      // the same gap (one <p> per run of lines, several blank lines one gap) instead of a whole empty line.
      const layout = paragraphLayout(block.lines);
      if (layout.groups.length === 0) return <div aria-hidden className="h-2.5" />;
      const last = layout.groups.length - 1;
      return (
        <>
          {layout.groups.map((rows, g) => (
            <p key={g} className={cn("m-0", (g > 0 || layout.gapBefore) && "mt-2.5", g === last && layout.gapAfter && "mb-2.5")}>
              {lines(rows, users, options)}
            </p>
          ))}
        </>
      );
    }
    case "quote":
      return <blockquote className="my-1 border-l-[3px] border-line pl-3 text-muted">{lines(block.lines, users, options)}</blockquote>;
    case "list":
      return <ListView groups={listGroups(block.items)} users={users} options={options} top />;
    case "table":
      return (
        <div className="my-1 max-w-full overflow-x-auto">
          <table className="border-collapse text-[13.5px] leading-5">
            <thead>
              <tr>
                {block.header.map((cell, c) => (
                  <th key={c} className="min-w-[4em] border border-line bg-panel px-2.5 py-1 font-semibold" style={{ textAlign: block.align[c] ?? "left" }}>{inline(cell, users, options)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, r) => (
                <tr key={r}>
                  {row.map((cell, c) => (
                    <td key={c} className="min-w-[4em] border border-line px-2.5 py-1 align-top" style={{ textAlign: block.align[c] ?? "left" }}>{inline(cell, users, options)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "math":
      return <MathView tex={block.tex} display />;
    case "codeblock":
      return (
        <pre className="relative my-1">
          {block.lang && <span className="absolute right-2 top-1 text-[10px] uppercase tracking-wide text-muted">{block.lang}</span>}
          {block.text}
        </pre>
      );
  }
}

/** A list of one kind at one level, its items each with the lists nested under it (apps/shared/lists.json). */
export interface ListGroup {
  ordered: boolean;
  level: number;
  start: number;
  entries: Array<{ item: ListItem; children: ListGroup[] }>;
}

/**
 * The flat items of a list block as nested lists: a run of items of one kind at one level under one parent is one list
 * (`<ol start>` from its first item's number), so each nested list counts from its own start (the counter of an item
 * at a deeper level is never the outer list's, 2026-10-06).
 */
export function listGroups(items: readonly ListItem[]): ListGroup[] {
  const top: ListGroup[] = [];
  // The open groups by level; an item closes the deeper ones.
  const open: ListGroup[] = [];
  for (const item of items) {
    open.length = Math.min(open.length, item.level + 1);
    let group = open[item.level];
    if (!group || group.ordered !== item.ordered) {
      group = { ordered: item.ordered, level: item.level, start: item.ordered ? item.number : 1, entries: [] };
      const parent = item.level > 0 ? open[item.level - 1]?.entries.at(-1) : undefined;
      if (parent) parent.children.push(group);
      else top.push(group);
      open[item.level] = group;
      open.length = item.level + 1;
    }
    group.entries.push({ item, children: [] });
  }
  return top;
}

const ORDERED_STYLES = ["decimal", "lower-alpha", "lower-roman"] as const;
/** Bullets are drawn by styles.css (`.md-ul`, 2026-10-08): a dot, a ring, a small square by level. */
const BULLET_STYLES = ["disc", "circle", "square"] as const;

function ListView({ groups, users, options, top = false }: { groups: ListGroup[]; users: Map<string, UserPublic>; options?: InlineOptions; top?: boolean }) {
  return (
    <>
      {groups.map((group, g) => {
        const level = Math.min(group.level, 2);
        const children = group.entries.map((entry, i) => (
          <li key={i}>
            {inline(entry.item.tokens, users, options)}
            {entry.children.length > 0 && <ListView groups={entry.children} users={users} options={options} />}
          </li>
        ));
        const className = cn("pl-6", top && "my-0.5");
        return group.ordered ? (
          <ol key={g} start={group.start} className={cn("md-ol", className)} style={{ listStyleType: ORDERED_STYLES[level] }}>{children}</ol>
        ) : (
          <ul key={g} className={cn("md-ul", className)} data-marker={BULLET_STYLES[level]}>{children}</ul>
        );
      })}
    </>
  );
}

/** M12b: how links on our own server are rendered (a chip that reveals the message); M12f: custom emoji images. */
export interface InlineOptions {
  internalBase?: string | null;
  onOpenMessage?: (messageId: string) => void;
  customEmoji?: ReadonlyMap<string, CustomEmojiOut>;
  controller?: AppController;
  /** M12g: my notification keywords, highlighted where they occur. */
  keywords?: readonly string[];
  groups?: ReadonlyMap<string, GroupOut>;
}

function lines(rows: Token[][], users: Map<string, UserPublic>, options: InlineOptions = {}) {
  return rows.map((tokens, i) => (
    <span key={i}>
      {i > 0 && <br />}
      {inline(tokens, users, options)}
    </span>
  ));
}

export function inline(tokens: Token[], users: Map<string, UserPublic>, options: InlineOptions = {}) {
  const { internalBase, onOpenMessage, customEmoji, controller, keywords, groups } = options;
  /** Keyword hits (M12g) get a soft highlight, like a mention would. */
  const keywordNodes = (text: string, keyPrefix: string): ReactNode => {
    if (!keywords || keywords.length === 0 || !text) return text;
    const pieces = splitKeywords(text, keywords);
    if (pieces.length === 1 && typeof pieces[0] === "string") return text;
    return pieces.map((piece, index) => (typeof piece === "string" ? piece : <mark key={`${keyPrefix}${index}`} className="rounded bg-warning/25 px-0.5 text-inherit">{piece.hit}</mark>));
  };
  /** Shortcodes become glyphs; known custom names become images (M12f). */
  const emojiNodes = (text: string): ReactNode => {
    const replaced = replaceShortcodes(text);
    if (!customEmoji || !controller || customEmoji.size === 0) return keywordNodes(replaced, "k");
    const pieces = splitCustomEmoji(replaced, customEmoji);
    if (pieces.length === 1 && typeof pieces[0] === "string") return keywordNodes(replaced, "k");
    return pieces.map((piece, index) =>
      typeof piece === "string" ? <span key={index}>{keywordNodes(piece, `k${index}-`)}</span> : <CustomEmojiImage key={index} controller={controller} emoji={customEmoji.get(piece.name)!} size="1.375em" inline />,
    );
  };
  return tokens.map((token, i) => {
    switch (token.kind) {
      case "text":
        return <span key={i}>{emojiNodes(token.text)}</span>;
      case "bold":
        return <strong key={i}>{emojiNodes(token.text)}</strong>;
      case "italic":
        return <em key={i}>{emojiNodes(token.text)}</em>;
      case "strike":
        return <del key={i}>{emojiNodes(token.text)}</del>;
      case "code":
        return <code key={i}>{token.text}</code>;
      case "codeblock":
        return <pre key={i}>{token.text}</pre>;
      case "link": {
        // M121: a Docs page (`page:<id>` in a page or canvas, `<server>/p/<id>` anywhere) and a page's file.
        const pageId = controller ? (pageRefId(token.url) ?? (internalBase ? parsePageLink(internalBase, token.url) : null)) : null;
        if (pageId && controller) return <PageLinkChip key={i} controller={controller} pageId={pageId} label={token.label && token.label !== token.url ? token.label : undefined} />;
        const fileId = controller ? attachmentRefId(token.url) : null;
        if (fileId && controller) return <FileLinkChip key={i} controller={controller} attachmentId={fileId} label={token.label} />;
        // M44: a canvas link on this server is a card (title, conversation, progress) that opens the canvas.
        const canvasId = internalBase && controller ? parseCanvasLink(internalBase, token.url) : null;
        if (canvasId && controller) return <CanvasLinkCard key={i} controller={controller} canvasId={canvasId} url={token.url} />;
        const open = onOpenMessage;
        const internal = internalBase && open ? parsePermalink(internalBase, token.url) : null;
        if (internal && open) {
          return (
            <button
              key={i}
              type="button"
              className="inline-flex items-center gap-1 rounded-md border border-line bg-panel px-1.5 py-0.5 align-baseline text-[13px] leading-5 text-accent hover:bg-accent-soft/40"
              title={token.url}
              onClick={() => open(internal)}
            >
              <MessageSquareText size={13} /> {token.label && token.label !== token.url ? token.label : t("files.showMessage")}
            </button>
          );
        }
        return (
          <a key={i} href={token.url} target="_blank" rel="noreferrer noopener" title={token.label ? token.url : undefined} onClick={(event) => openExternalLink(event, token.url)}>
            {token.label ?? token.url}
          </a>
        );
      }
      case "mention": {
        const user = users.get(token.userId);
        // 2026-10-06: someone this device knows shows their card (hover or click); an unknown id stays plain.
        if (user && controller) {
          return (
            <MentionCard key={i} controller={controller} userId={token.userId}>
              @{user.display_name}
            </MentionCard>
          );
        }
        return (
          <span key={i} className="mention">
            @{user?.display_name ?? "unknown"}
          </span>
        );
      }
      case "mention_group":
        return (
          <span key={i} className="mention" title={t("composer.group")}>
            @{groups?.get(token.groupId)?.name ?? t("composer.group")}
          </span>
        );
      case "mention_all":
        return (
          <span key={i} className="mention">
            @{token.target}
          </span>
        );
      case "math":
        return <MathView key={i} tex={token.text} display={false} inlineDisplay={token.display} />;
      case "newline":
        return <br key={i} />;
    }
  });
}
