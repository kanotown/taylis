import { tokenize } from "./markdown";
import { parseDriveLink, parsePermalink } from "./permalink";

/**
 * Every link a body shows, in order (M11g, M185): the links its tokenizer reads (2026-11-05, apps/shared/link-cards.json
 * body_keys): a `[label](url)` link's URL and the bare URLs as far as they go (apps/shared/inline-format.json: not the
 * closing mark or the Japanese after them, so 「…/m/<id>」を見て is a message card, not a card of a broken URL); none
 * in code or in emphasis.
 */
export function bodyLinks(body: string): string[] {
  return tokenize(body).flatMap((token) => (token.kind === "link" ? [token.url] : []));
}

/** The first http(s) link in a body, outside code (M11g); null when there is none. */
export function firstLink(body: string): string | null {
  return bodyLinks(body)[0] ?? null;
}

const LINK_KEY = /^(https?):\/\/([^/?#\s]+)([^#\s]*)(?:#\S*)?$/i;

/**
 * M185 (docs/LINK_PREVIEWS.md §4.1): the key a removed card is kept under (`MessageOut.hidden_previews`): scheme and host
 * in lower case, the fragment dropped, "/" for an empty path, the rest as written. Plain string work, the same on the
 * server (link_cards.preview_key) and the phones. Null for anything but an http(s) URL.
 */
export function previewKey(url: string): string | null {
  const match = LINK_KEY.exec(url.trim());
  if (!match) return null;
  const rest = match[3]!.startsWith("/") ? match[3]! : `/${match[3]!}`;
  return `${match[1]!.toLowerCase()}://${match[2]!.toLowerCase()}${rest}`;
}

/** M185 (docs/LINK_PREVIEWS.md §2): at most this many message cards under one message. */
export const MESSAGE_CARDS_MAX = 3;

export interface CardLinks {
  /** The linked messages, each once, in the body's order (the URL of its first link, for removing the card). */
  messages: { id: string; url: string }[];
  /** The external link whose Open Graph card shows (M11g), or null. */
  external: string | null;
}

/**
 * M185 (docs/LINK_PREVIEWS.md §2): which cards a message shows under its body. A link to a message on this server
 * (`<base>/m/<id>`) is a message card: up to MESSAGE_CARDS_MAX distinct messages, not the message itself. The first
 * other link that is not a drive link (its own card in the body, M165) gets the Open Graph card, unless the message
 * announces a call (M117: its card stands for the link). A card whose link's key the sender removed (`hidden`) is left
 * out; nothing takes its place.
 */
export function cardLinks(body: string, baseUrl: string | null | undefined, options: { selfId?: string; hidden?: readonly string[] | null; call?: boolean } = {}): CardLinks {
  const hidden = new Set(options.hidden ?? []);
  const shown = (url: string) => !hidden.has(previewKey(url) ?? url);
  const seen = new Set<string>();
  const messages: CardLinks["messages"] = [];
  let external: string | null = null;
  for (const url of bodyLinks(body)) {
    const id = baseUrl ? parsePermalink(baseUrl, url) : null;
    if (id) {
      if (id === options.selfId?.toLowerCase() || seen.has(id)) continue;
      seen.add(id);
      if (seen.size <= MESSAGE_CARDS_MAX) messages.push({ id, url });
      continue;
    }
    if (external === null && !(baseUrl && parseDriveLink(baseUrl, url))) external = url;
  }
  return {
    messages: messages.filter((card) => shown(card.url)),
    external: external && !options.call && shown(external) ? external : null,
  };
}
