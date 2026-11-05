/** Message permalinks (M12b): `<server>/m/<message_id>`, recognised only for the server we are logged into. */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function messagePermalink(baseUrl: string, messageId: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/m/${messageId}`;
}

/** The message id when `url` is a permalink on `baseUrl` (case-insensitive host, query / fragment ignored). */
export function parsePermalink(baseUrl: string, url: string): string | null {
  return parseLink(baseUrl, url, "/m/");
}

/** M44 (CANVAS.md §4.13): the canvas id when `url` is a canvas link `<server>/c/<id>` on `baseUrl`. */
export function parseCanvasLink(baseUrl: string, url: string): string | null {
  return parseLink(baseUrl, url, "/c/");
}

/** M121 (WIKI.md §9.3): the page id when `url` is a Docs permalink `<server>/p/<id>` on `baseUrl`. */
export function parsePageLink(baseUrl: string, url: string): string | null {
  return parseLink(baseUrl, url, "/p/");
}

export function pageLink(baseUrl: string, pageId: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/p/${pageId}`;
}

/** M121: the page id of a `page:<uuid>` link (WIKI.md §2.3), else null. */
export function pageRefId(url: string): string | null {
  const match = /^page:([0-9a-f-]{36})$/i.exec(url);
  return match && UUID.test(match[1]!) ? match[1]!.toLowerCase() : null;
}

/** M121: the attachment id of an `attachment:<uuid>` link (a page's file), else null. */
export function attachmentRefId(url: string): string | null {
  const match = /^attachment:([0-9a-f-]{36})$/i.exec(url);
  return match && UUID.test(match[1]!) ? match[1]!.toLowerCase() : null;
}

/** CALENDAR.md §11: the event id when `url` is an event link `<server>/e/<id>` on `baseUrl` (the 「予定」 bot's line). */
export function parseEventLink(baseUrl: string, url: string): string | null {
  return parseLink(baseUrl, url, "/e/");
}

export function eventLink(baseUrl: string, eventId: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/e/${eventId}`;
}

export function canvasLink(baseUrl: string, canvasId: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/c/${canvasId}`;
}

/** M165 (docs/DRIVE.md §13.1): the item id when `url` is a drive link `<server>/d/<id>` (a file or a folder) on `baseUrl`. */
export function parseDriveLink(baseUrl: string, url: string): string | null {
  return parseLink(baseUrl, url, "/d/");
}

export function driveLink(baseUrl: string, itemId: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/d/${itemId}`;
}

/** M165: every drive item linked on `baseUrl` in a text (a draft), each once, in order. */
export function driveLinksIn(baseUrl: string, text: string): string[] {
  const prefix = `${baseUrl.replace(/\/+$/, "")}/d/`.toLowerCase();
  const lower = text.toLowerCase();
  const found = new Set<string>();
  for (let at = lower.indexOf(prefix); at >= 0; at = lower.indexOf(prefix, at + prefix.length)) {
    const id = lower.slice(at + prefix.length, at + prefix.length + 36);
    if (UUID.test(id)) found.add(id);
  }
  return [...found];
}

/** M173 (docs/LENDING.md §13.5): an equipment item's link `<server>/eq/<id>`, the QR code on its label (`/e/` is an event's). */
export function equipmentLink(baseUrl: string, itemId: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/eq/${itemId}`;
}

export function parseEquipmentLink(baseUrl: string, url: string): string | null {
  return parseLink(baseUrl, url, "/eq/");
}

/**
 * The id when `url` is `<server><prefix><uuid>` on `baseUrl` (apps/shared/message-links.json): the same host (any case)
 * and port (the default one written out or not) and the server's path, http or https alike (2026-11-05: a link written
 * with the other scheme opened in the browser), then the UUID (any case), ending there or with `/` `?` `#`.
 */
function parseLink(baseUrl: string, url: string, prefix: "/m/" | "/c/" | "/p/" | "/e/" | "/d/" | "/eq/"): string | null {
  const base = serverPart(baseUrl);
  const link = serverPart(url);
  if (!base || !link || link.authority !== base.authority) return null;
  const head = base.path.replace(/\/+$/, "") + prefix;
  if (link.path.slice(0, head.length).toLowerCase() !== head.toLowerCase()) return null;
  const id = link.path.slice(head.length, head.length + 36);
  const after = link.path.slice(head.length + 36);
  return UUID.test(id) && (after === "" || "/?#".includes(after[0]!)) ? id.toLowerCase() : null;
}

/** An http(s) URL's host and port (lower case, without the scheme's default port) and the rest; null for anything else. */
function serverPart(url: string): { authority: string; path: string } | null {
  const match = /^(https?):\/\/([^/?#]*)(.*)$/i.exec(url);
  if (!match) return null;
  const authority = match[2]!.toLowerCase();
  if (authority === "" || authority.includes("@")) return null; // user info: someone else's host after it
  const port = match[1]!.toLowerCase() === "https" ? ":443" : ":80";
  return { authority: authority.endsWith(port) ? authority.slice(0, -port.length) : authority, path: match[3]! };
}
