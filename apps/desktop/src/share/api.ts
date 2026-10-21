/**
 * The public side of a drive share link (M163, docs/DRIVE.md §5.4, §9.3): `/api/v1/shares/<token>/…` on this page's own
 * origin, with no session. A password link's unlock cookie (HttpOnly, on the token's path) is the browser's; this page
 * never sees it. Errors come back as the API's ApiError, so the app's texts describe them (errors.json).
 */
import { ApiError, NetworkError } from "../api/errors";
import type { ShareInfoOut, SharedChildrenOut } from "../api/types";

/** The token of `/s/<token>` (nothing else in the path is read). */
export function tokenFromPath(pathname: string): string | null {
  const match = /^\/s\/([A-Za-z0-9_-]{16,100})\/?$/.exec(pathname);
  return match ? match[1]! : null;
}

export class ShareApi {
  constructor(
    readonly token: string,
    private readonly fetchImpl: typeof fetch = (input, init) => fetch(input, init),
  ) {}

  private base(): string {
    return `/api/v1/shares/${encodeURIComponent(this.token)}`;
  }

  private async call(path: string, init?: RequestInit): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.base()}${path}`, { credentials: "same-origin", cache: "no-store", ...init });
    } catch (error) {
      throw new NetworkError(error instanceof Error ? error.message : String(error));
    }
    if (!response.ok) {
      let code = "unknown";
      let message = response.statusText;
      try {
        const body = (await response.json()) as { error?: { code?: string; message?: string } };
        code = body.error?.code ?? code;
        message = body.error?.message ?? message;
      } catch {
        /* not JSON */
      }
      throw new ApiError(response.status, code, message);
    }
    return response;
  }

  async info(): Promise<ShareInfoOut> {
    return (await (await this.call("")).json()) as ShareInfoOut;
  }

  async unlock(password: string): Promise<void> {
    await this.call("/unlock", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password }) });
  }

  async children(folderId: string, cursor: string | null = null): Promise<SharedChildrenOut> {
    const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
    return (await (await this.call(`/folders/${folderId}/children${query}`)).json()) as SharedChildrenOut;
  }

  /** Every page of a document's preview, for PDF.js. */
  async previewPdf(itemId: string): Promise<ArrayBuffer> {
    return (await this.call(`/items/${itemId}/preview/pdf`)).arrayBuffer();
  }

  contentUrl(itemId: string, inline = false): string {
    return `${this.base()}/items/${itemId}/content${inline ? "?inline=1" : ""}`;
  }

  thumbnailUrl(itemId: string): string {
    return `${this.base()}/items/${itemId}/thumbnail`;
  }

  previewThumbnailUrl(itemId: string): string {
    return `${this.base()}/items/${itemId}/preview/thumbnail`;
  }

  zipUrl(folderId: string | null = null): string {
    return `${this.base()}/zip${folderId ? `?folder_id=${folderId}` : ""}`;
  }
}
