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

export function canvasLink(baseUrl: string, canvasId: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/c/${canvasId}`;
}

function parseLink(baseUrl: string, url: string, prefix: "/m/" | "/c/" | "/p/"): string | null {
  const base = baseUrl.replace(/\/+$/, "");
  if (url.slice(0, base.length + 3).toLowerCase() !== (base + prefix).toLowerCase()) return null;
  const id = url.slice(base.length + 3).replace(/[/?#].*$/, "");
  return UUID.test(id) ? id.toLowerCase() : null;
}
