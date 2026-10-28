/**
 * The public page of a drive share link, `/s/<token>` (M163, docs/DRIVE.md §9.3): what someone outside the workspace
 * sees, without signing in. A file: its name, size, date, 「ダウンロード」 and a preview (images, PDF and Office files
 * with a preview). A folder: breadcrumbs from the shared folder down (never above it), its items (folders first),
 * 「すべてを ZIP でダウンロード」, and each file's download and preview. A password link shows only the password field
 * until it is unlocked. Who shared it, where it lives in the workspace, other links and versions are never shown.
 *
 * Downloads are plain links (the browser's own download, which resumes a broken one); the bytes always come as an
 * attachment. Nothing on the page links away from it (no Referer leaves it either: Referrer-Policy no-referrer).
 */
import { ChevronRight, Download, File, FileArchive, FileAudio, FileImage, FileSpreadsheet, FileText, FileVideo, Folder, KeyRound, Loader2, Presentation, Eye } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { ApiError, describeError } from "../api/errors";
import type { DriveCrumb, ShareInfoOut, SharedAlbumOut, SharedItemOut } from "../api/types";
import { type DriveIconKind, formatBytes, iconKind } from "../drive/listing";
import { t } from "../i18n";
import { PdfViewer } from "../ui/DocumentPreview";
import { sinceLabel } from "../ui/format";
import { VIEWER_BUTTON, ViewerBody, ViewerCloseButton, ViewerFrame } from "../ui/ViewerHeader";
import { ShareApi } from "./api";
import { SaveLink, saveHref, ShareAlbumView } from "./ShareAlbum";

const ICONS: Record<DriveIconKind, typeof File> = {
  folder: Folder, image: FileImage, video: FileVideo, audio: FileAudio, pdf: FileText, document: FileText, sheet: FileSpreadsheet, slides: Presentation, archive: FileArchive, text: FileText, file: File,
};

function ItemIcon({ item, size = 18 }: { item: SharedItemOut; size?: number }) {
  const kind = iconKind(item);
  const Icon = ICONS[kind];
  return <Icon size={size} aria-hidden className={kind === "folder" ? "shrink-0 text-accent" : "shrink-0 text-muted"} />;
}

/** What a file opens in on this page: an image (its thumbnail, or the file when it is not limited), a document's
 *  preview, or nothing (download only). */
export function previewKind(item: SharedItemOut): "image" | "document" | null {
  if (item.kind !== "file") return null;
  if (item.preview?.status === "ready") return "document";
  if (item.has_thumbnail && (item.content_type ?? "").startsWith("image/")) return "image";
  return null;
}

type Phase =
  | { kind: "loading" }
  | { kind: "error"; message: string; gone: boolean }
  | { kind: "password"; info: ShareInfoOut }
  | { kind: "open"; info: ShareInfoOut };

export function SharePage({ api }: { api: ShareApi }) {
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const load = useCallback(async () => {
    try {
      const info = await api.info();
      setPhase(info.password_required && !info.unlocked ? { kind: "password", info } : { kind: "open", info });
    } catch (error) {
      setPhase({ kind: "error", message: describeError(error), gone: error instanceof ApiError && (error.status === 404 || error.status === 410) });
    }
  }, [api]);
  useEffect(() => {
    void load();
  }, [load]);

  const workspace = phase.kind === "password" || phase.kind === "open" ? phase.info.workspace_name : "";
  useEffect(() => {
    const name = phase.kind === "open" ? phase.info.item?.name : null;
    document.title = name ? `${name} – ${workspace || "Taylis"}` : t("share.pageTitle");
  }, [phase, workspace]);

  return (
    <div className="flex min-h-dvh flex-col bg-canvas text-ink">
      <header className="border-b border-line">
        <div className="mx-auto flex h-12 max-w-4xl items-center gap-2 px-4">
          <strong className="truncate text-sm">{workspace || "Taylis"}</strong>
          <span className="text-sm text-muted">{t("share.header")}</span>
        </div>
      </header>
      <main className="mx-auto w-full max-w-4xl flex-1 px-4 py-6">
        {phase.kind === "loading" && <div className="flex justify-center py-16 text-muted"><Loader2 size={22} className="animate-spin" aria-label={t("common.loading")} /></div>}
        {phase.kind === "error" && (
          <div role="alert" data-share-error="" className="mx-auto max-w-md py-16 text-center">
            <p className="text-base font-semibold">{phase.gone ? t("share.goneTitle") : t("share.errorTitle")}</p>
            <p className="mt-2 text-sm text-muted">{phase.message}</p>
            {!phase.gone && <button type="button" className="mt-4 rounded-lg border border-line px-4 py-1.5 text-sm hover:bg-ink/6" onClick={() => void load()}>{t("common.retry")}</button>}
          </div>
        )}
        {phase.kind === "password" && <PasswordForm api={api} onUnlocked={() => void load()} />}
        {phase.kind === "open" && phase.info.item && <SharedContent api={api} info={phase.info} item={phase.info.item} />}
      </main>
      <footer className="border-t border-line">
        <p className="mx-auto max-w-4xl px-4 py-3 text-xs text-muted">{t("share.footer", { workspace: workspace || "Taylis" })}</p>
      </footer>
    </div>
  );
}

function PasswordForm({ api, onUnlocked }: { api: ShareApi; onUnlocked: () => void }) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    if (!password) return;
    setBusy(true);
    setError(null);
    try {
      await api.unlock(password);
      onUnlocked();
    } catch (failure) {
      setError(describeError(failure));
      setPassword("");
    } finally {
      setBusy(false);
    }
  };
  return (
    <form data-share-password="" className="mx-auto max-w-sm space-y-3 py-10" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <p className="flex items-center gap-2 text-base font-semibold"><KeyRound size={18} className="text-muted" /> {t("share.passwordTitle")}</p>
      <p className="text-sm text-muted">{t("share.passwordText")}</p>
      <input
        type="password"
        autoComplete="current-password"
        autoFocus
        aria-label={t("share.password")}
        className="h-10 w-full rounded-lg border border-line bg-canvas px-3 text-sm"
        value={password}
        onChange={(event) => setPassword(event.target.value)}
      />
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      <button type="submit" disabled={busy || !password} className="inline-flex h-9 items-center gap-2 rounded-lg bg-accent px-4 text-sm font-medium text-white disabled:opacity-50">
        {busy && <Loader2 size={14} className="animate-spin" />} {t("share.open")}
      </button>
    </form>
  );
}

function Limits({ info }: { info: ShareInfoOut }) {
  const parts = [
    info.expires_at ? t("share.until", { at: sinceLabel(info.expires_at) }) : null,
    info.downloads_left !== null && info.downloads_left !== undefined ? t("share.downloadsLeft", { count: info.downloads_left }) : null,
  ].filter(Boolean);
  return parts.length ? <p data-share-limits="" className="text-xs text-muted">{parts.join(" · ")}</p> : null;
}

function DownloadLink({ href, label, primary = false }: { href: string; label: string; primary?: boolean }) {
  return (
    <a
      href={href}
      download
      rel="noreferrer"
      className={primary ? "inline-flex h-9 items-center gap-2 rounded-lg bg-accent px-4 text-sm font-medium text-white hover:opacity-90" : "inline-flex h-8 items-center gap-1.5 rounded-lg px-2 text-[13px] text-ink hover:bg-ink/6"}
    >
      <Download size={primary ? 15 : 14} /> {label}
    </a>
  );
}

function SharedContent({ api, info, item }: { api: ShareApi; info: ShareInfoOut; item: SharedItemOut }) {
  const [viewing, setViewing] = useState<SharedItemOut | null>(null);
  const limited = info.downloads_left !== null && info.downloads_left !== undefined;
  // AL2 (docs/ALBUMS.md §7): without the originals, photos are saved at their display size and nothing else is offered.
  const originals = info.originals !== false;
  return (
    <>
      {item.kind === "file" ? (
        <section data-share-file="" className="mx-auto max-w-lg rounded-xl border border-line p-5">
          <div className="flex items-start gap-3">
            <Thumb api={api} item={item} />
            <div className="min-w-0 flex-1">
              <p className="break-words text-base font-semibold">{item.name}</p>
              <p className="mt-0.5 text-sm text-muted">{[formatBytes(item.size_bytes), sinceLabel(item.modified_at)].filter(Boolean).join(" · ")}</p>
            </div>
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <SaveLink api={api} item={item} originals={originals} className="inline-flex h-9 items-center gap-2 rounded-lg bg-accent px-4 text-sm font-medium text-white hover:opacity-90"><Download size={15} /> {t("share.download")}</SaveLink>
            {previewKind(item) && (
              <button type="button" className="inline-flex h-9 items-center gap-2 rounded-lg border border-line px-4 text-sm hover:bg-ink/6" onClick={() => setViewing(item)}>
                <Eye size={15} /> {t("share.preview")}
              </button>
            )}
          </div>
          <div className="mt-3"><Limits info={info} /></div>
        </section>
      ) : (
        <FolderView api={api} info={info} root={item} onView={setViewing} />
      )}
      {viewing && <Viewer api={api} item={viewing} limited={limited} originals={originals} onClose={() => setViewing(null)} />}
    </>
  );
}

function Thumb({ api, item }: { api: ShareApi; item: SharedItemOut }) {
  const [failed, setFailed] = useState(false);
  const src = item.has_thumbnail ? api.thumbnailUrl(item.id) : item.preview?.status === "ready" ? api.previewThumbnailUrl(item.id) : null;
  if (!src || failed) return <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-panel"><ItemIcon item={item} size={22} /></span>;
  return <img src={src} alt="" onError={() => setFailed(true)} className="h-12 w-12 shrink-0 rounded-lg bg-panel object-cover" />;
}

/** The folder shown: `#f=<id>` (a folder under the link), so the browser's back button goes up again. */
function folderFromHash(): string | null {
  const match = /^#f=([0-9a-f-]{36})$/i.exec(window.location.hash);
  return match ? match[1]! : null;
}

function FolderView({ api, info, root, onView }: { api: ShareApi; info: ShareInfoOut; root: SharedItemOut; onView: (item: SharedItemOut) => void }) {
  const [folderId, setFolderId] = useState<string>(() => folderFromHash() ?? root.id);
  const [items, setItems] = useState<SharedItemOut[] | null>(null);
  const [path, setPath] = useState<DriveCrumb[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // AL2: an album folder is shown as the album (the link's own, or a folder under it).
  const [album, setAlbum] = useState<SharedAlbumOut | null>(null);
  const originals = info.originals !== false;

  useEffect(() => {
    const follow = () => setFolderId(folderFromHash() ?? root.id);
    window.addEventListener("hashchange", follow);
    return () => window.removeEventListener("hashchange", follow);
  }, [root.id]);

  const load = useCallback(async (after: string | null) => {
    try {
      const page = await api.children(folderId, after);
      setItems((held) => [...(after ? held ?? [] : []), ...page.items]);
      setPath(page.path);
      if (!after) setAlbum(page.album ?? null);
      setCursor(page.next_cursor ?? null);
      setError(null);
    } catch (failure) {
      setError(describeError(failure));
      if (!after) setItems([]);
    }
  }, [api, folderId]);
  useEffect(() => {
    setItems(null);
    void load(null);
  }, [load]);

  const go = (id: string) => {
    window.location.hash = id === root.id ? "" : `f=${id}`;
    setFolderId(id);
  };
  const folder = path[path.length - 1];
  const loadMore = useCallback(() => {
    if (cursor) void load(cursor);
  }, [cursor, load]);
  if (album && items !== null) {
    const crumbs = path.length > 1 ? path.slice(0, -1) : [];
    return (
      <>
        {crumbs.length > 0 && (
          <nav aria-label={t("share.breadcrumbs")} className="mb-3 flex flex-wrap items-center gap-0.5 text-[13px] text-muted">
            {crumbs.map((crumb, index) => (
              <span key={crumb.id} className="flex items-center gap-0.5">
                {index > 0 && <ChevronRight size={13} className="shrink-0" />}
                <button type="button" className="truncate rounded-md px-1 py-0.5 hover:bg-ink/6" onClick={() => go(crumb.id)}>{crumb.name}</button>
              </span>
            ))}
          </nav>
        )}
        {error && <p role="alert" className="mb-3 text-sm text-danger">{error}</p>}
        <ShareAlbumView
          api={api}
          album={album}
          title={folder?.name ?? root.name}
          items={items}
          originals={originals}
          zipFolderId={folderId === root.id ? null : folderId}
          cursor={cursor}
          onMore={loadMore}
          onFolder={go}
        />
        <div className="mt-3"><Limits info={info} /></div>
      </>
    );
  }
  return (
    <section data-share-folder="" aria-label={folder?.name ?? root.name}>
      <div className="flex flex-wrap items-center gap-3">
        <nav aria-label={t("share.breadcrumbs")} className="flex min-w-0 flex-1 flex-wrap items-center gap-0.5 text-[15px]">
          {(path.length ? path : [{ id: root.id, name: root.name }]).map((crumb, index, all) => (
            <span key={crumb.id} className="flex min-w-0 items-center gap-0.5">
              {index > 0 && <ChevronRight size={14} className="shrink-0 text-muted" />}
              {index === all.length - 1 ? (
                <strong className="truncate px-1">{crumb.name}</strong>
              ) : (
                <button type="button" className="truncate rounded-md px-1 py-0.5 hover:bg-ink/6" onClick={() => go(crumb.id)}>{crumb.name}</button>
              )}
            </span>
          ))}
        </nav>
        <DownloadLink primary href={api.zipUrl(folderId === root.id ? null : folderId, !originals)} label={t("share.downloadZip")} />
      </div>
      <div className="mt-1"><Limits info={info} /></div>
      {error && <p role="alert" className="mt-4 text-sm text-danger">{error}</p>}
      {items === null ? (
        <div className="flex justify-center py-10 text-muted"><Loader2 size={20} className="animate-spin" /></div>
      ) : items.length === 0 && !error ? (
        <p className="py-10 text-center text-sm text-muted">{t("share.empty")}</p>
      ) : (
        <table className="mt-4 w-full table-fixed border-collapse text-[13px]">
          <thead className="text-left text-xs text-muted">
            <tr className="border-b border-line">
              <th className="py-2 pl-2 font-medium">{t("share.column.name")}</th>
              <th className="w-36 px-2 py-2 font-medium max-sm:hidden">{t("share.column.modified")}</th>
              <th className="w-20 px-2 py-2 text-right font-medium">{t("share.column.size")}</th>
              <th className="w-28 py-2" aria-label={t("share.column.actions")} />
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id} data-share-item={item.kind} className="border-b border-line/60">
                <td className="py-1.5 pl-2 pr-2">
                  {item.kind === "folder" ? (
                    <button type="button" className="flex min-w-0 items-center gap-2 text-left hover:underline" onClick={() => go(item.id)}>
                      <ItemIcon item={item} /> <span className="truncate font-medium">{item.name}</span>
                    </button>
                  ) : (
                    <span className="flex min-w-0 items-center gap-2"><ItemIcon item={item} /> <span className="truncate font-medium">{item.name}</span></span>
                  )}
                </td>
                <td className="truncate px-2 text-muted max-sm:hidden">{sinceLabel(item.modified_at)}</td>
                <td className="px-2 text-right tabular-nums text-muted">{item.kind === "file" ? formatBytes(item.size_bytes) : ""}</td>
                <td className="py-1 text-right">
                  {item.kind === "file" && (
                    <span className="inline-flex items-center gap-0.5">
                      {previewKind(item) && (
                        <button type="button" aria-label={t("share.previewOf", { name: item.name })} title={t("share.preview")} className="inline-flex h-8 w-8 items-center justify-center rounded-lg hover:bg-ink/6" onClick={() => onView(item)}>
                          <Eye size={15} />
                        </button>
                      )}
                      <SaveLink api={api} item={item} originals={originals} className="inline-flex h-8 w-8 items-center justify-center rounded-lg hover:bg-ink/6">
                        <Download size={15} />
                      </SaveLink>
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {cursor && (
        <div className="mt-3 flex justify-center">
          <button type="button" className="rounded-lg border border-line px-4 py-1.5 text-sm hover:bg-ink/6" onClick={() => void load(cursor)}>{t("share.more")}</button>
        </div>
      )}
    </section>
  );
}

function Viewer({ api, item, limited, originals, onClose }: { api: ShareApi; item: SharedItemOut; limited: boolean; originals: boolean; onClose: () => void }) {
  const kind = previewKind(item);
  const load = useCallback(() => api.previewPdf(item.id), [api, item.id]);
  const source = useMemo(() => ({ id: item.id, filename: item.name, size_bytes: item.size_bytes ?? 0, preview: item.preview ?? null }), [item]);
  // AL2: what this link lets be saved (the display size, or nothing, when it keeps the originals back).
  const save = saveHref(api, item, originals);
  const download = () => {
    if (!save) return;
    const link = document.createElement("a");
    link.href = save.href;
    link.download = save.name ?? "";
    link.rel = "noreferrer";
    document.body.appendChild(link);
    link.click();
    link.remove();
  };
  const buttons = <SaveLink api={api} item={item} originals={originals} className={VIEWER_BUTTON}><Download size={18} /></SaveLink>;
  if (kind === "document") return <PdfViewer attachment={source} load={load} buttons={buttons} onDownload={download} onClose={onClose} />;
  // An image: the display size when there is one (AL1, never counted); else the full picture when the link has no
  // download limit (viewing it counts as a download) and hands out originals, else the thumbnail (512 px).
  const src = item.has_display ? api.displayUrl(item.id) : limited || !originals ? api.thumbnailUrl(item.id) : api.contentUrl(item.id, true);
  return (
    <ViewerFrame
      title={item.name}
      description={t("share.imageViewer")}
      onClose={onClose}
      header={
        <>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{item.name}</p>
            <p className="text-xs text-white/70">{[formatBytes(item.size_bytes), !item.has_display && (limited || !originals) ? t("share.thumbnailOnly") : null].filter(Boolean).join(" · ")}</p>
          </div>
          {buttons}
          <ViewerCloseButton />
        </>
      }
    >
      <ViewerBody onClose={onClose} fill>
        <img src={src} alt={item.name} data-share-image="" className="m-auto max-h-full max-w-full object-contain" />
      </ViewerBody>
    </ViewerFrame>
  );
}
