/**
 * M121 (WIKI.md §3, §7, §9.1): one Docs page — breadcrumbs (an ancestor I cannot read is 「…」 and leads nowhere), the
 * icon and title, 「閲覧 | 編集」, the body drawn as a canvas is (`page:` links with their current titles, files, images,
 * tables, math), the outline on the right, then its child pages and 「このページへのリンク」. Editing is the canvas
 * editor (Markdown, the toolbar, the preview beside it scrolling with it) plus `[[` and the `/` menu; it saves itself
 * like a canvas (merge, conflict choices, retries) on the wiki endpoints. A page someone else edits comes in while
 * nothing is typed here. Offline, the page as last read shows read only.
 * M150 (WIKI.md §22.6, §27): 「編集」 is the 見たまま editor (PageEditor.tsx, loaded lazily) unless I chose Markdown
 * (users.docs_editor_mode); the page's 「見たまま / Markdown」 switch changes the setting, the caret kept on its line.
 * M154 (WIKI.md §30.1): Enter in the title puts the caret at the start of the body (from the reading view it opens
 * the editor there); ↑ on the body's first line (← at its very start) goes back to the end of the title.
 */
import { ChevronRight, CloudOff, Copy, CopyPlus, Download, FilePlus2, History, LayoutTemplate, Link2, ListTree, Loader2, MoreHorizontal, Share2, SmilePlus, Table2, Trash2 } from "lucide-react";
import { lazy, type MutableRefObject, type ReactNode, Suspense, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { describeError } from "../api/errors";
import type { PageContent, PageItem, PageOut } from "../api/types";
import type { AppController } from "../state/app";
import { saveDownload } from "../platform/download";
import type { PageSaver } from "../sync/wiki";
import { isPlainEnter } from "./ime";
import { CanvasBody, headingAnchor } from "./CanvasBody";
import { CanvasEditor } from "./CanvasEditor";
import { DocHistoryDialog, type HistorySource } from "./CanvasHistory";
import { ConflictDialog, ExpiredDialog, SaveState } from "./CanvasPane";
import { stripTaskMarkers } from "./canvasMarkers";
import { outline, toggleTaskLine } from "./canvasText";
import { useCompact } from "./compact";
import { pageRights } from "./docsAccess";
import { DatabaseView } from "./DatabaseView";
import { applyTemplate, createChildRef, createPage, firstViewId, lookupDatabases, lookupPages, pageTitle, trashPage, updatePage, wikiCall } from "./docsActions";
import { DuplicateDialog, type DuplicateMode, TemplateBanner, TemplateGallery } from "./DocsTemplates";
import { RowProperties } from "./RowProperties";
import { PageRow } from "./DocsDialogs";
import { useWikiHub } from "./DocsTree";
import { EmojiPicker } from "./EmojiPicker";
import { sinceLabel } from "./format";
import { PageIcon } from "./PageIcon";
import type { PageEditorHandle } from "./PageEditor";
import { PageFindBar, type PageFindHandle, usePageFindKeys } from "./PageFind";
import { CANVAS_SPLIT_DEFAULT, CANVAS_SPLIT_MAX, CANVAS_SPLIT_MIN, clampCanvasSplit, type DocsEditorMode, docsEditorModeOf, readCanvasSplit, writeCanvasSplit } from "./prefs";
import { Button, cn, Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger, PopoverContent, PopoverRoot, PopoverTrigger } from "./primitives";
import { useCanvasScrollSync } from "./useCanvasScrollSync";
import { t } from "../i18n";

type Mode = "view" | "edit";

/** M150: the 見たまま editor, its own chunk (TipTap with it): loaded the first time a page is edited that way. */
const LazyPageEditor = lazy(() => import("./PageEditor"));

export function DocPage({ controller, pageId, onOpenPage, onBack, startEditing = false, onShare, onTrash, onAddChild, embedded = false, onClosed, onUseTemplate }: {
  controller: AppController;
  pageId: string;
  onOpenPage: (pageId: string) => void;
  /** A phone's ← (the tree). */
  onBack?: (() => void) | null;
  /** A page just made here opens in the editor. */
  startEditing?: boolean;
  onShare: (page: Pick<PageItem, "id" | "title" | "icon">) => void;
  onTrash: (page: PageItem) => void;
  onAddChild: (parentId: string) => void;
  /** M123: a database row beside its table (narrower, no outline). */
  embedded?: boolean;
  /** M123: the row went to the trash from here. */
  onClosed?: () => void;
  /** M145: 「このテンプレートでページを作成」 on a page template (DocsView opens its gallery's choice). */
  onUseTemplate?: (templateId: string) => void;
}) {
  const hub = useWikiHub(controller);
  const [saver, setSaver] = useState<PageSaver | null>(null);
  useEffect(() => {
    if (!hub) return;
    const held = hub.hold(pageId);
    setSaver(held.saver);
    return held.release;
  }, [hub, pageId]);
  if (!hub || !saver) return <Centre><Loader2 size={22} className="animate-spin text-muted" /></Centre>;
  return <PageView key={pageId} controller={controller} saver={saver} pageId={pageId} onOpenPage={onOpenPage} onBack={onBack ?? null} startEditing={startEditing} onShare={onShare} onTrash={onTrash} onAddChild={onAddChild} embedded={embedded} onClosed={onClosed} onUseTemplate={onUseTemplate} />;
}

function Centre({ children }: { children: ReactNode }) {
  return <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 py-10 text-center text-sm text-muted">{children}</div>;
}

function PageView({ controller, saver, pageId, onOpenPage, onBack, startEditing, onShare, onTrash, onAddChild, embedded, onClosed, onUseTemplate }: {
  controller: AppController;
  saver: PageSaver;
  pageId: string;
  onOpenPage: (pageId: string) => void;
  onBack: (() => void) | null;
  startEditing: boolean;
  onShare: (page: Pick<PageItem, "id" | "title" | "icon">) => void;
  onTrash: (page: PageItem) => void;
  onAddChild: (parentId: string) => void;
  embedded: boolean;
  onClosed?: () => void;
  onUseTemplate?: (templateId: string) => void;
}) {
  const hub = useWikiHub(controller)!;
  const compact = useCompact() || embedded;
  useSyncExternalStore((listener) => saver.subscribe(listener), () => saver.revision);
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === "hidden") void saver.flush();
    };
    document.addEventListener("visibilitychange", onHide);
    return () => document.removeEventListener("visibilitychange", onHide);
  }, [saver]);
  // WIKI.md §29.3: ⌘F / Ctrl+F finds in this page (the app has no other find for it).
  const sectionRef = useRef<HTMLElement>(null);
  const [finding, setFinding] = useState(false);
  const find = useRef<PageFindHandle | null>(null);
  usePageFindKeys(sectionRef, embedded, finding, () => {
    if (finding) find.current?.focus();
    else setFinding(true);
  }, (step) => find.current?.step(step));

  const cached: PageOut | null = hub.cachedPage(pageId);
  const listed = hub.page(pageId);
  const loaded = saver.canvas;
  // The newest of the tree's metadata, the loop's answer and the page as last read.
  const meta: PageItem | PageContent | PageOut | null = [listed, loaded, cached].filter((p): p is PageItem => !!p).sort((a, b) => b.version - a.version)[0] ?? null;
  const rights = pageRights(meta, controller.isGuest);
  const offlineCopy = !loaded && cached && (saver.status === "offline" || saver.status === "loading");
  const text = loaded ? saver.text : offlineCopy ? cached!.body : "";
  const [mode, setMode] = useState<Mode>(startEditing ? "edit" : "view");
  const editing = rights.edit && mode === "edit" && !!loaded && saver.status !== "gone";
  const [historyOpen, setHistoryOpen] = useState(false);
  const [conflictOpen, setConflictOpen] = useState(true);
  // M150: 見たまま or Markdown (mine, users.docs_editor_mode); switching keeps the caret's line.
  const me = useSyncExternalStore((listener) => controller.store.subscribe(listener), () => controller.store.me);
  const editorMode = docsEditorModeOf(me);
  const pageEditor = useRef<PageEditorHandle | null>(null);
  const markdownCaret = useRef<(() => number) | null>(null);
  const [caretLine, setCaretLine] = useState<number | null>(null);
  const switchEditor = (next: DocsEditorMode) => {
    if (next === editorMode) return;
    if (editorMode === "wysiwyg") {
      pageEditor.current?.commit();
      setCaretLine(pageEditor.current?.caretLine() ?? null);
    } else setCaretLine(markdownCaret.current?.() ?? null);
    void controller.setDocsEditorMode(next);
  };
  // M154: Enter in the title → the start of the body (the editor opened there from the reading view); ↑ at the body's
  // first line → the end of the title.
  const titleRow = useRef<TitleHandle | null>(null);
  const focusTitle = () => titleRow.current?.focus();
  const enterBody = () => {
    if (editing) {
      if (editorMode === "wysiwyg") pageEditor.current?.focusStart();
      else if (editorArea) {
        editorArea.focus();
        editorArea.setSelectionRange(0, 0);
      }
      return;
    }
    if (!rights.edit || !loaded || saver.status === "gone") return;
    setCaretLine(0);
    setMode("edit");
  };
  // M145 (WIKI.md §22.3): 「複製」 / 「テンプレートとして保存」 and an empty page's 「テンプレートから始める」.
  const [duplicating, setDuplicating] = useState<DuplicateMode | null>(null);
  const [applying, setApplying] = useState(false);
  useEffect(() => {
    if (saver.status === "conflict" || saver.status === "expired") setConflictOpen(true);
  }, [saver.status]);

  const onToggleTask = rights.edit && loaded && saver.status !== "gone"
    ? (line: number, done: boolean) => {
        const next = toggleTaskLine(saver.text, line, done);
        if (next === null) return;
        saver.edit(next, true);
        void saver.flush();
      }
    : null;

  const headings = useMemo(() => outline(text), [text]);
  const [editorArea, setEditorArea] = useState<HTMLTextAreaElement | null>(null);
  const [previewBox, setPreviewBox] = useState<HTMLDivElement | null>(null);
  const markdownEditing = editing && editorMode === "markdown";
  useCanvasScrollSync(markdownEditing && !compact ? editorArea : null, markdownEditing && !compact ? previewBox : null, saver.text);
  const showOutline = !compact && !editing && headings.length >= 3 && meta?.kind !== "database";

  const children = hub.tree().children.get(pageId) ?? (hub.hasTree ? [] : cached?.children ?? []);
  const crumbs = cached?.breadcrumbs ?? [];
  const title = pageTitle(meta, t("docs.untitled"));

  const docLinks = useMemo(() => ({
    lookup: (q: string) => lookupPages(controller, q),
    createChild: () => createChildRef(controller, pageId),
    createDatabase: () => createChildRef(controller, pageId, "database"),
    lookupDatabases: (q: string) => lookupDatabases(controller, q),
    embedView: (databaseId: string) => firstViewId(controller, databaseId),
  }), [controller, pageId]);
  const kind = meta?.kind ?? "page";
  const isTemplate = !!meta?.is_template;
  // A template is not in the tree: the page as read is what the trash and the dialogs take.
  const item: PageItem | null = listed ?? (meta && "my_level" in meta ? meta : null);
  const setTemplate = async (on: boolean) => {
    const page = await updatePage(controller, pageId, { is_template: on });
    if (page) controller.setNotice(on ? t("docs.tpl.madeRow", { title: pageTitle(page, t("docs.untitled")) }) : t("docs.tpl.unsetDone", { title: pageTitle(page, t("docs.untitled")) }));
  };
  const useTemplate = async () => {
    if (onUseTemplate) {
      onUseTemplate(pageId);
      return;
    }
    const page = await createPage(controller, { parentId: null, access: "workspace", template: { kind: "page", id: pageId } });
    if (page) onOpenPage(page.id);
  };
  const databaseId = kind === "row" ? [...crumbs].reverse().find((c) => c.readable)?.id ?? null : null;
  const trashRow = async () => {
    if (!(await trashPage(controller, pageId))) return;
    controller.setNotice(t("docs.db.rowTrashed"));
    if (onClosed) onClosed();
    else if (databaseId) onOpenPage(databaseId);
  };
  const addDatabase = async () => {
    const siblings = hub.tree().children.get(pageId) ?? [];
    const page = await createPage(controller, { parentId: pageId, kind: "database", afterId: siblings[siblings.length - 1]?.id ?? null });
    if (page) onOpenPage(page.id);
  };

  const history: HistorySource | null = meta ? {
    id: pageId,
    title,
    headRevId: meta.head_rev_id,
    list: (cursor) => wikiCall(controller, (api) => api.wikiRevisions(pageId, cursor)),
    get: (revisionId) => wikiCall(controller, (api) => api.wikiRevision(pageId, revisionId)),
    restore: async (revisionId) => {
      const page = await wikiCall(controller, (api) => api.restoreWikiRevision(pageId, revisionId, crypto.randomUUID()));
      if (!page) return null;
      hub.upsert(page);
      saver.remoteVersion(page.version);
      return page.head_rev_id;
    },
    label: (revisionId, label) => wikiCall(controller, (api) => api.labelWikiRevision(pageId, revisionId, label)),
    erase: (revisionId) => wikiCall(controller, (api) => api.eraseWikiRevision(pageId, revisionId)),
  } : null;

  const exportMarkdown = async () => {
    const markdown = await wikiCall(controller, (api) => api.exportWikiPage(pageId));
    if (markdown === null) return;
    await saveDownload(`${title.replace(/[\\/:*?"<>|]+/g, "_") || "page"}.md`, new Blob([markdown], { type: "text/markdown" }));
  };

  const notice = saver.status === "gone"
    ? { text: t("docs.goneNote"), tone: "warn" as const }
    : saver.status === "blocked"
      ? { text: t("canvas.blockedNote", { error: describeError(saver.error) }), tone: "warn" as const }
      : offlineCopy
        ? { text: t("docs.offlineCopy"), tone: "info" as const }
        : loaded && !rights.edit
          ? { text: t("docs.readOnlyNote"), tone: "info" as const }
          : null;

  if (!loaded && !offlineCopy) {
    if (saver.status === "gone" || saver.status === "blocked") {
      return (
        <section className="flex min-h-0 flex-1 flex-col" aria-label={t("docs.page")}>
          {onBack && <div className="flex h-11 items-center border-b border-line px-2"><Button variant="ghost" size="sm" onClick={onBack}>{t("common.back")}</Button></div>}
          <Centre>
            <strong className="text-base text-ink">{t("docs.notFound")}</strong>
            <span>{t("docs.notFoundText")}</span>
          </Centre>
        </section>
      );
    }
    return <Centre>{saver.status === "offline" ? <><CloudOff size={22} /> {t("docs.offlineNoCopy")}</> : <Loader2 size={22} className="animate-spin" />}</Centre>;
  }

  return (
    <section ref={sectionRef} aria-label={t("docs.pageWithTitle", { title })} className="relative flex min-h-0 flex-1 flex-col" data-doc-page={pageId}>
      {finding && <PageFindBar section={sectionRef} handle={find} onClose={() => setFinding(false)} className="absolute right-3 top-12 z-20" />}
      <div className="flex h-11 shrink-0 items-center gap-1.5 border-b border-line px-2">
        {onBack && (
          <button type="button" aria-label={t("common.back")} className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg hover:bg-ink/6" onClick={onBack}>
            <ChevronRight size={18} className="rotate-180" />
          </button>
        )}
        <Breadcrumbs controller={controller} crumbs={crumbs} title={title} icon={meta?.icon ?? null} onOpenPage={onOpenPage} />
        <div className="min-w-0 flex-1" />
        {loaded && <SaveState saver={saver} onOpenConflict={() => setConflictOpen(true)} />}
        {meta && (
          <button type="button" title={t("canvas.history")} aria-label={t("canvas.history")} onClick={() => setHistoryOpen(true)} className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-ink transition-colors hover:bg-ink/6 max-md:hidden">
            <History size={16} />
          </button>
        )}
        {rights.edit && loaded && saver.status !== "gone" && (
          <div role="tablist" aria-label={t("canvas.mode")} className="flex shrink-0 rounded-lg bg-panel-2 p-0.5 text-xs font-medium">
            {(["view", "edit"] as const).map((value) => (
              <button key={value} type="button" role="tab" aria-selected={mode === value} onClick={() => { setCaretLine(null); setMode(value); }} className={cn("rounded-md px-2.5 py-1 transition-colors", mode === value ? "bg-canvas text-ink shadow-sm" : "text-muted hover:text-ink")}>
                {value === "edit" ? t("canvas.edit") : t("canvas.view")}
              </button>
            ))}
          </div>
        )}
        {editing && (
          <div role="group" aria-label={t("docs.editorMode.label")} className="flex shrink-0 rounded-lg border border-line p-0.5 text-xs font-medium" data-editor-mode={editorMode}>
            {(["wysiwyg", "markdown"] as const).map((value) => (
              <button key={value} type="button" aria-pressed={editorMode === value} title={value === "wysiwyg" ? t("docs.editorMode.wysiwygTitle") : t("docs.editorMode.markdownTitle")} onClick={() => switchEditor(value)} className={cn("rounded-md px-2 py-0.5 transition-colors", editorMode === value ? "bg-accent-soft text-ink" : "text-muted hover:text-ink")}>
                {value === "wysiwyg" ? t("docs.editorMode.wysiwyg") : t("docs.editorMode.markdown")}
              </button>
            ))}
          </div>
        )}
        {meta && saver.status !== "gone" && kind !== "row" && (
          <button type="button" onClick={() => onShare({ id: pageId, title, icon: meta.icon })} className="inline-flex h-8 shrink-0 items-center gap-1 rounded-lg px-2 text-xs font-medium text-ink transition-colors hover:bg-ink/6" title={rights.share ? t("docs.share.button") : t("docs.share.see")}>
            <Share2 size={15} />
            <span className="max-md:sr-only">{t("docs.share.button")}</span>
          </button>
        )}
        {meta && (
          <Menu>
            <MenuTrigger asChild>
              <button type="button" aria-label={t("docs.actions")} title={t("docs.actions")} className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-ink transition-colors hover:bg-ink/6">
                <MoreHorizontal size={18} />
              </button>
            </MenuTrigger>
            <MenuContent align="end">
              <MenuItem onSelect={() => void controller.copyPageLink(pageId)}><Link2 size={14} /> {t("canvas.copyLink")}</MenuItem>
              <MenuItem onSelect={() => setHistoryOpen(true)}><History size={14} /> {t("canvas.historyMenu")}</MenuItem>
              <MenuItem onSelect={() => void exportMarkdown()}><Download size={14} /> {t("docs.exportMarkdown")}</MenuItem>
              {rights.edit && kind === "page" && !isTemplate && <MenuItem onSelect={() => onAddChild(pageId)}><FilePlus2 size={14} /> {t("docs.addChild")}</MenuItem>}
              {rights.edit && kind === "page" && !isTemplate && <MenuItem onSelect={() => void addDatabase()}><Table2 size={14} /> {t("docs.db.addDatabase")}</MenuItem>}
              {item && kind !== "database" && saver.status !== "gone" && <MenuItem onSelect={() => setDuplicating("copy")}><CopyPlus size={14} /> {t("docs.tpl.duplicate")}</MenuItem>}
              {item && kind === "page" && !isTemplate && !controller.isGuest && saver.status !== "gone" && <MenuItem onSelect={() => setDuplicating("template")}><LayoutTemplate size={14} /> {t("docs.tpl.saveAs")}</MenuItem>}
              {isTemplate && kind === "page" && <MenuItem onSelect={() => void useTemplate()}><FilePlus2 size={14} /> {t("docs.tpl.use")}</MenuItem>}
              {rights.edit && kind === "row" && !isTemplate && <MenuItem onSelect={() => void setTemplate(true)}><LayoutTemplate size={14} /> {t("docs.tpl.makeRow")}</MenuItem>}
              {rights.edit && isTemplate && <MenuItem onSelect={() => void setTemplate(false)}><LayoutTemplate size={14} /> {t("docs.tpl.unset")}</MenuItem>}
              {rights.edit && kind === "row" && (
                <>
                  <MenuSeparator />
                  <MenuItem className="text-danger" onSelect={() => void trashRow()}><Trash2 size={14} /> {t("docs.db.trashRow")}</MenuItem>
                </>
              )}
              {rights.manage && item && kind !== "row" && (
                <>
                  <MenuSeparator />
                  <MenuItem className="text-danger" onSelect={() => onTrash(item)}><Trash2 size={14} /> {t("canvas.moveToTrash")}</MenuItem>
                </>
              )}
            </MenuContent>
          </Menu>
        )}
      </div>
      {notice && (
        <div className={cn("flex shrink-0 items-center gap-2 border-b border-line px-4 py-1.5 text-xs", notice.tone === "warn" ? "bg-warning/10 text-ink" : "bg-panel text-muted")}>
          {notice.text}
          {(saver.status === "gone" || saver.status === "blocked") && (
            <button type="button" className="ml-auto inline-flex shrink-0 items-center gap-1 text-accent hover:underline" onClick={() => void controller.copyMessageText(stripTaskMarkers(saver.text))}>
              <Copy size={12} /> {t("canvas.copyBody")}
            </button>
          )}
        </div>
      )}
      {isTemplate && kind === "page" && (
        <TemplateBanner kind="page" canEdit={rights.edit} isDefault={null} onUse={() => void useTemplate()} onUnset={() => void setTemplate(false)} onDefault={null} />
      )}
      {editing && editorMode === "wysiwyg" ? (
        <div className="min-h-0 flex-1 overflow-y-auto" aria-label={t("docs.content")} data-wysiwyg-page="" data-find-root="">
          <article className={cn("mx-auto max-w-3xl px-6 pb-16 pt-6 max-md:px-4 max-md:pt-4", embedded && "px-4 pt-4")}>
            <TitleRow controller={controller} pageId={pageId} title={meta?.title ?? ""} icon={meta?.icon ?? null} editable onEnter={enterBody} handle={titleRow} />
            {kind === "row" && <RowProperties controller={controller} rowId={pageId} version={meta?.version ?? 0} onOpenPage={onOpenPage} template={isTemplate} />}
            <Suspense fallback={(
              <div className="mt-4" role="status" aria-label={t("docs.wysiwyg.loading")}>
                <CanvasBody body={saver.text} controller={controller} onToggleTask={null} />
              </div>
            )}>
              {/* M155: the formatting row takes the byline's place, so the body starts where the reading view's does. */}
              <LazyPageEditor key={pageId} controller={controller} saver={saver} links={docLinks} initialLine={caretLine} handle={pageEditor} onTitle={focusTitle} className="mt-[3px]" />
            </Suspense>
          </article>
        </div>
      ) : editing ? (
        <>
          <TitleRow controller={controller} pageId={pageId} title={meta?.title ?? ""} icon={meta?.icon ?? null} editable compact onEnter={enterBody} handle={titleRow} />
          <EditorSplit compact={compact} editor={<CanvasEditor controller={controller} saver={saver} onTextArea={setEditorArea} doc={docLinks} initialCaretLine={caretLine} caretLineRef={markdownCaret} className="h-full min-w-0" />} preview={(
            <div ref={setPreviewBox} className="min-h-0 min-w-0 flex-1 overflow-y-auto" aria-label={t("canvas.previewLabel")} data-find-root="">
              <div className="mx-auto max-w-3xl px-6 py-4">
                <div className="mb-3 text-[11px] font-semibold uppercase tracking-wide text-muted">{t("composer.preview")}</div>
                <CanvasBody body={saver.text} controller={controller} onToggleTask={onToggleTask} />
              </div>
            </div>
          )} />
        </>
      ) : (
        <div className="flex min-h-0 flex-1">
          <div className="min-h-0 flex-1 overflow-y-auto" aria-label={t("docs.content")} data-find-root="">
            <article className={cn("mx-auto px-6 py-6 max-md:px-4 max-md:py-4", kind === "database" ? "max-w-none" : "max-w-3xl", embedded && "px-4 py-4")}>
              <TitleRow controller={controller} pageId={pageId} title={meta?.title ?? ""} icon={meta?.icon ?? null} editable={rights.edit && !!loaded} onEnter={enterBody} handle={titleRow} />
              {meta && <Byline controller={controller} page={meta} />}
              {kind === "row" && <RowProperties controller={controller} rowId={pageId} version={meta?.version ?? 0} onOpenPage={onOpenPage} template={isTemplate} />}
              {text.trim() === "" ? (kind === "database" ? null : (
                <div className="mt-6 text-sm text-muted">
                  <p>{t("canvas.emptyBody")}{rights.edit && loaded && <button type="button" className="text-accent hover:underline" onClick={() => setMode("edit")}>{t("canvas.startWriting")}</button>}</p>
                  {rights.edit && loaded && kind === "page" && (
                    <Button size="sm" variant="secondary" className="mt-3" onClick={() => setApplying(true)}><LayoutTemplate size={14} /> {t("docs.tpl.applyTitle")}</Button>
                  )}
                </div>
              )) : (
                <CanvasBody body={text} controller={controller} onToggleTask={offlineCopy ? null : onToggleTask} className="mt-5" />
              )}
              {kind === "database" && (
                <DatabaseView controller={controller} databaseId={pageId} compact={compact} onOpenRowPage={onOpenPage}
                  renderPeek={(rowId, close) => (
                    <DocPage key={rowId} controller={controller} pageId={rowId} onOpenPage={onOpenPage} onShare={onShare} onTrash={onTrash} onAddChild={onAddChild} embedded onClosed={close} />
                  )}
                />
              )}
              {kind === "page" && !isTemplate && <ChildList controller={controller} pages={children} canAdd={rights.edit && !!loaded} onOpen={onOpenPage} onAdd={() => onAddChild(pageId)} />}
              <Backlinks controller={controller} pageId={pageId} version={meta?.version ?? 0} onOpen={onOpenPage} />
            </article>
          </div>
          {showOutline && (
            <nav aria-label={t("canvas.toc")} className="w-52 shrink-0 overflow-y-auto border-l border-line px-3 py-5 text-sm">
              <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted"><ListTree size={13} /> {t("canvas.toc")}</div>
              {headings.map((entry) => (
                <button
                  key={entry.line}
                  type="button"
                  className={cn("block w-full truncate rounded px-2 py-1 text-left text-muted hover:bg-panel hover:text-ink", entry.level === 2 && "pl-4", entry.level === 3 && "pl-6")}
                  onClick={() => document.getElementById(headingAnchor(entry.line))?.scrollIntoView({ block: "start", behavior: "smooth" })}
                >
                  {entry.text}
                </button>
              ))}
            </nav>
          )}
        </div>
      )}
      {duplicating && item && (
        <DuplicateDialog controller={controller} page={item} mode={duplicating} onClose={() => setDuplicating(null)} onDone={(copy) => onOpenPage(copy.id)} />
      )}
      {applying && (
        <TemplateGallery controller={controller} title={t("docs.tpl.applyTitle")} description={t("docs.tpl.applyDescription")} blank={false} onClose={() => setApplying(false)}
          onPick={(choice) => { if (choice.kind !== "blank") void applyTemplate(controller, pageId, choice); }}
        />
      )}
      {historyOpen && history && <DocHistoryDialog controller={controller} source={history} rights={{ edit: rights.edit, erase: rights.manage }} onClose={() => setHistoryOpen(false)} />}
      {conflictOpen && saver.status === "conflict" && saver.conflict && (
        <ConflictDialog controller={controller} saver={saver} tickOnly={!rights.edit} conflicts={saver.conflict.details.conflicts ?? []} timedOut={saver.conflict.details.timed_out ?? false} onClose={() => setConflictOpen(false)} />
      )}
      {conflictOpen && saver.status === "expired" && saver.expired && (
        <ExpiredDialog controller={controller} saver={saver} head={saver.expired} canOverwrite={rights.edit} onClose={() => setConflictOpen(false)} />
      )}
    </section>
  );
}

/** Root first; an ancestor I cannot read is 「…」 (no title, no link: WIKI.md §4.6). */
function Breadcrumbs({ controller, crumbs, title, icon, onOpenPage }: { controller: AppController; crumbs: PageOut["breadcrumbs"]; title: string; icon: string | null; onOpenPage: (id: string) => void }) {
  return (
    <nav aria-label={t("docs.breadcrumbs")} className="flex min-w-0 items-center gap-0.5 overflow-hidden text-sm">
      {crumbs.map((crumb, index) => (
        <span key={crumb.id ?? `hidden-${index}`} className="flex min-w-0 shrink items-center gap-0.5">
          {crumb.readable && crumb.id ? (
            <button type="button" className="flex min-w-0 items-center gap-1 truncate rounded px-1.5 py-0.5 text-muted hover:bg-ink/6 hover:text-ink" onClick={() => onOpenPage(crumb.id!)} data-crumb={crumb.id}>
              <PageIcon controller={controller} icon={crumb.icon} size={13} />
              <span className="truncate">{crumb.title || t("docs.untitled")}</span>
            </button>
          ) : (
            <span className="px-1.5 text-muted" data-crumb="hidden" title={t("docs.hiddenAncestor")}>…</span>
          )}
          <ChevronRight size={13} className="shrink-0 text-muted/70" />
        </span>
      ))}
      <span className="flex min-w-0 items-center gap-1 px-1 font-semibold">
        <PageIcon controller={controller} icon={icon} size={14} />
        <span className="truncate">{title}</span>
      </span>
    </nav>
  );
}

/** M154: what the body asks of the title row (↑ on the body's first line). */
interface TitleHandle {
  /** The caret at the end of the title's field. */
  focus(): void;
}

/** The icon (a picker for an editor) and the title (edited in place: saved on Enter or when leaving it; M154: Enter then goes to the body). */
function TitleRow({ controller, pageId, title, icon, editable, compact = false, onEnter, handle }: { controller: AppController; pageId: string; title: string; icon: string | null; editable: boolean; compact?: boolean; onEnter?: () => void; handle?: MutableRefObject<TitleHandle | null> }) {
  const [value, setValue] = useState(title);
  const focused = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!focused.current) setValue(title);
  }, [title]);
  useEffect(() => {
    if (!handle) return;
    handle.current = {
      focus: () => {
        const el = input.current;
        if (!el) return;
        el.focus();
        el.setSelectionRange(el.value.length, el.value.length);
      },
    };
    return () => {
      handle.current = null;
    };
  }, [handle]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const save = async () => {
    const trimmed = value.trim();
    if (!trimmed || trimmed === title) {
      setValue(title);
      return;
    }
    const page = await updatePage(controller, pageId, { title: trimmed });
    if (!page) setValue(title);
  };
  const setIcon = async (next: string) => {
    setPickerOpen(false);
    await updatePage(controller, pageId, { icon: next });
  };
  const size = compact ? 20 : 30;
  return (
    <div className={cn("flex items-center gap-2", compact ? "shrink-0 border-b border-line px-4 py-1.5" : "mb-1")}>
      {editable ? (
        <PopoverRoot open={pickerOpen} onOpenChange={setPickerOpen}>
          <PopoverTrigger asChild>
            <button type="button" aria-label={icon ? t("docs.changeIcon") : t("docs.addIcon")} title={icon ? t("docs.changeIcon") : t("docs.addIcon")} className="flex shrink-0 items-center justify-center rounded-lg p-1 hover:bg-ink/6">
              {icon ? <PageIcon controller={controller} icon={icon} size={size} /> : <SmilePlus size={compact ? 18 : 22} className="text-muted" />}
            </button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-[340px] p-2">
            <EmojiPicker controller={controller} custom={[...controller.store.customEmoji.values()]} onPick={(entry) => void setIcon(entry.category === "custom" || !entry.glyph ? `:${entry.shortcode}:` : entry.glyph)} />
            {icon && (
              <div className="mt-2 border-t border-line pt-2 text-right">
                <Button size="sm" variant="secondary" onClick={() => void setIcon("")}>{t("docs.removeIcon")}</Button>
              </div>
            )}
          </PopoverContent>
        </PopoverRoot>
      ) : (
        icon && <PageIcon controller={controller} icon={icon} size={size} />
      )}
      {editable ? (
        <input
          ref={input}
          aria-label={t("docs.titleLabel")}
          value={value}
          maxLength={200}
          placeholder={t("docs.untitled")}
          onFocus={() => { focused.current = true; }}
          onBlur={() => { focused.current = false; void save(); }}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (isPlainEnter(event)) {
              // Saved by the blur; M154: then the body.
              event.preventDefault();
              (event.target as HTMLInputElement).blur();
              onEnter?.();
            } else if (event.key === "Escape") {
              setValue(title);
              event.stopPropagation();
            }
          }}
          className={cn("min-w-0 flex-1 rounded-md bg-transparent font-bold leading-tight outline-none placeholder:text-muted/60 focus:bg-panel/60", compact ? "py-1 text-lg" : "py-0.5 text-[26px] max-md:text-[22px]")}
        />
      ) : (
        <h1 className={cn("min-w-0 flex-1 font-bold leading-tight", compact ? "text-lg" : "text-[26px] max-md:text-[22px]")}>{title || t("docs.untitled")}</h1>
      )}
    </div>
  );
}

function Byline({ controller, page }: { controller: AppController; page: PageItem | PageContent }) {
  const who = controller.store.users.get(page.updated_by)?.display_name ?? t("common.member");
  return <div className="text-xs text-muted">{t("canvas.lastUpdated", { who, when: sinceLabel(page.updated_at) })}</div>;
}

function ChildList({ controller, pages, canAdd, onOpen, onAdd }: { controller: AppController; pages: readonly PageItem[]; canAdd: boolean; onOpen: (id: string) => void; onAdd: () => void }) {
  if (pages.length === 0 && !canAdd) return null;
  return (
    <section aria-label={t("docs.children")} className="mt-10 border-t border-line pt-4">
      <h2 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">{t("docs.children")}</h2>
      <ul>
        {pages.map((page) => <li key={page.id}><PageRow controller={controller} page={page} onOpen={onOpen} /></li>)}
      </ul>
      {canAdd && (
        <button type="button" className="mt-1 flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-muted hover:bg-panel hover:text-ink" onClick={onAdd}>
          <FilePlus2 size={15} /> {t("docs.addChild")}
        </button>
      )}
    </section>
  );
}

/** 「このページへのリンク」: pages I can read that link here (§3.3). Read again when the page changes. */
function Backlinks({ controller, pageId, version, onOpen }: { controller: AppController; pageId: string; version: number; onOpen: (id: string) => void }) {
  const [pages, setPages] = useState<PageItem[] | null>(null);
  useEffect(() => {
    let live = true;
    const api = controller.api;
    if (!api) return;
    api.wikiBacklinks(pageId).then((found) => { if (live) setPages(found); }, () => { if (live) setPages((current) => current ?? []); });
    return () => { live = false; };
  }, [controller, pageId, version]);
  if (!pages || pages.length === 0) return null;
  return (
    <section aria-label={t("docs.backlinks")} className="mt-6 border-t border-line pt-4">
      <h2 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">{t("docs.backlinks")}</h2>
      <ul>{pages.map((page) => <li key={page.id}><PageRow controller={controller} page={page} onOpen={onOpen} /></li>)}</ul>
    </section>
  );
}

/** The editor and the preview side by side (a phone: the editor alone), the line between them dragged to resize. */
function EditorSplit({ compact, editor, preview }: { compact: boolean; editor: ReactNode; preview: ReactNode }) {
  const [split, setSplit] = useState(readCanvasSplit);
  const splitBox = useRef<HTMLDivElement>(null);
  const change = (value: number) => {
    setSplit(value);
    writeCanvasSplit(value);
  };
  const startResize = (event: React.PointerEvent<HTMLDivElement>) => {
    const box = splitBox.current?.getBoundingClientRect();
    if (!box || box.width <= 0) return;
    event.preventDefault();
    let value = split;
    const move = (e: PointerEvent) => {
      value = clampCanvasSplit((e.clientX - box.left) / box.width);
      setSplit(value);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      writeCanvasSplit(value);
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  if (compact) return <div className="flex min-h-0 flex-1 flex-col">{editor}</div>;
  return (
    <div ref={splitBox} className="flex min-h-0 flex-1 flex-row">
      <div className="min-w-0 shrink-0" style={{ width: `${split * 100}%` }}>{editor}</div>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={t("canvas.splitWidth")}
        aria-valuemin={CANVAS_SPLIT_MIN * 100}
        aria-valuemax={CANVAS_SPLIT_MAX * 100}
        aria-valuenow={Math.round(split * 100)}
        tabIndex={0}
        title={t("main.resizeHint")}
        onPointerDown={startResize}
        onDoubleClick={() => change(CANVAS_SPLIT_DEFAULT)}
        onKeyDown={(event) => {
          if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
            event.preventDefault();
            change(clampCanvasSplit(split + (event.key === "ArrowLeft" ? -0.05 : 0.05)));
          }
        }}
        className="relative w-px shrink-0 cursor-col-resize bg-line outline-none before:absolute before:inset-y-0 before:-left-1 before:w-2 before:content-[''] hover:bg-accent/60 focus-visible:bg-accent"
      />
      {preview}
    </div>
  );
}
