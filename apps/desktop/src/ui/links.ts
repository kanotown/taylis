import { parseDriveLink, parsePermalink } from "./permalink";

/** Every http(s) link in a body outside code, in order, trailing punctuation dropped (M11g, M185). */
export function bodyLinks(body: string): string[] {
  const withoutCode = body.replace(/```[\s\S]*?```/g, " ").replace(/`[^`\n]*`/g, " ");
  return [...withoutCode.matchAll(/https?:\/\/[^\s<>)\]]+/g)].map((match) => match[0].replace(/[.,!?;:。、」』）]+$/, ""));
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
