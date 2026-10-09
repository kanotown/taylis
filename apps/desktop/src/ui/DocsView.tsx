/**
 * M121 「ドキュメント」 (WIKI.md §9.1): the tree on the left, the page on the right. On a narrow screen (a phone's
 * browser) the tree is a list screen and a page covers it, with ← back to the tree. Pages are created, moved, shared and
 * put in the trash from here (moving and sharing work on the narrow screen too, in dialogs).
 */
import { CircleAlert, FileText, Loader2, Plus } from "lucide-react";
import { useState } from "react";

import type { PageItem, WikiMoveOut } from "../api/types";
import type { AppController } from "../state/app";
import type { MoveTarget } from "../sync/wikiTree";
import { BackButton } from "./compact";
import { DocPage } from "./DocPage";
import { createPage, moveDryRun, movePage, pageTitle, type TemplateChoice, trashPage } from "./docsActions";
import { DocsTrashDialog, MoveDialog, ShareDialog } from "./DocsDialogs";
import { DocsSidebarSearch } from "./DocsSidebarSearch";
import { TemplateGallery } from "./DocsTemplates";
import { DocsTree, useWikiHub } from "./DocsTree";
import { Button, cn, Modal } from "./primitives";
import { t } from "../i18n";

export function DocsView({ controller, pageId, onOpenPage, compact, onSearchAll }: {
  controller: AppController;
  /** The page on screen (null: the tree alone on a phone, a prompt on a wide screen). */
  pageId: string | null;
  onOpenPage: (pageId: string | null) => void;
  compact: boolean;
  /** WIKI.md §29.2: the sidebar box's 「すべて見る」 (the search's 「ドキュメント」 tab with these words). */
  onSearchAll?: (q: string) => void;
}) {
  const hub = useWikiHub(controller);
  const [fresh, setFresh] = useState<string | null>(null);
  const [moving, setMoving] = useState<{ page: PageItem; target: MoveTarget; dry: WikiMoveOut } | null>(null);
  const [sharing, setSharing] = useState<Pick<PageItem, "id" | "title" | "icon"> | null>(null);
  const [trashing, setTrashing] = useState<PageItem | null>(null);
  const [trashOpen, setTrashOpen] = useState(false);
  /** M145 (WIKI.md §22.3): a new page starts in the gallery (白紙, built-in templates, everyone's templates). */
  const [gallery, setGallery] = useState<{ parentId: string | null; access: "workspace" | "private" } | null>(null);
  /** The sidebar's search words (kept here so they stay while a result is open, and on a phone's way back). */
  const [find, setFind] = useState("");

  const open = (id: string | null) => {
    setFresh(null);
    onOpenPage(id);
  };
  const create = (where: { parentId: string | null; access: "workspace" | "private" }) => setGallery(where);
  const createFrom = async (where: { parentId: string | null; access: "workspace" | "private" }, template: TemplateChoice) => {
    const siblings = where.parentId ? hub?.tree().children.get(where.parentId) ?? [] : [];
    const page = await createPage(controller, { parentId: where.parentId, access: where.access, afterId: siblings[siblings.length - 1]?.id ?? null, template });
    if (!page) return;
    if (template.kind === "blank") setFresh(page.id);
    onOpenPage(page.id);
  };
  /** 「＋ 新しいテンプレート」: a page template (shared: everyone can use it), opened to be written. */
  const createTemplate = async () => {
    const page = await createPage(controller, { parentId: null, access: "workspace", isTemplate: true });
    if (!page) return;
    setFresh(page.id);
    onOpenPage(page.id);
  };
  /** A drop (or 「最上位へ移動」): moved at once when nobody's access changes, else the dialog says who. */
  const move = async (dragId: string, target: MoveTarget) => {
    const page = hub?.page(dragId);
    if (!page) return;
    const dry = await moveDryRun(controller, dragId, target);
    if (!dry) return;
    if (dry.changes.length === 0 && !dry.manager_lost) {
      await movePage(controller, dragId, target, false);
      return;
    }
    setMoving({ page, target, dry });
  };
  const confirmTrash = async (page: PageItem) => {
    setTrashing(null);
    const done = await trashPage(controller, page.id);
    if (!done) return;
    controller.setNotice(t("docs.trashed", { title: pageTitle(page, t("docs.untitled")) }));
    if (pageId === page.id || (pageId && !hub?.page(pageId))) open(null);
  };

  const dialogs = (
    <>
      {moving && <MoveDialog controller={controller} page={moving.page} target={moving.target} dry={moving.dry} onClose={() => setMoving(null)} onMoved={() => controller.setNotice(t("docs.moved"))} />}
      {sharing && <ShareDialog controller={controller} page={sharing} onClose={() => setSharing(null)} />}
      {trashing && (
        <Modal title={t("docs.trashConfirm.title")} description={t("docs.trashConfirm.text", { title: pageTitle(trashing, t("docs.untitled")) })} onClose={() => setTrashing(null)}>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setTrashing(null)}>{t("common.cancel")}</Button>
            <Button variant="danger" onClick={() => void confirmTrash(trashing)}>{t("canvas.moveToTrash")}</Button>
          </div>
        </Modal>
      )}
      {gallery && (
        <TemplateGallery controller={controller} title={t("docs.tpl.galleryTitle")} description={t("docs.tpl.galleryDescription")} onClose={() => setGallery(null)}
          onPick={(choice) => void createFrom(gallery, choice)}
        />
      )}
      {trashOpen && <DocsTrashDialog controller={controller} onClose={() => setTrashOpen(false)} onRestored={(id) => { setTrashOpen(false); open(id); }} />}
    </>
  );

  if (!hub || hub.state === "unsupported") {
    return (
      <Empty icon={<CircleAlert size={22} />} title={t("docs.unsupported")} text={t("docs.unsupportedText")} />
    );
  }
  if (!hub.hasTree) {
    return hub.state === "failed" ? (
      <Empty icon={<CircleAlert size={22} />} title={t("docs.loadFailed")} action={<Button variant="secondary" size="sm" onClick={() => void hub.loadTree()}>{t("common.reload")}</Button>} />
    ) : (
      <Empty icon={<Loader2 size={22} className="animate-spin" />} title={t("common.loading")} />
    );
  }

  const tree = (
    <DocsTree
      controller={controller}
      selectedId={pageId}
      onOpen={open}
      onCreate={(where) => create(where)}
      onNewTemplate={controller.isGuest ? null : () => void createTemplate()}
      onMove={(id, target) => void move(id, target)}
      onTrash={(page) => setTrashing(page)}
      onOpenTrash={() => setTrashOpen(true)}
      className="flex-1"
    />
  );
  const sidebar = (
    <DocsSidebarSearch controller={controller} text={find} onText={setFind} selectedId={pageId} onOpen={open} onSearchAll={onSearchAll}>
      {tree}
    </DocsSidebarSearch>
  );
  const page = pageId ? (
    <DocPage
      key={pageId}
      controller={controller}
      pageId={pageId}
      onOpenPage={open}
      onBack={compact ? () => open(null) : null}
      startEditing={fresh === pageId}
      onShare={setSharing}
      onTrash={(item) => setTrashing(item)}
      onAddChild={(parentId) => create({ parentId, access: "workspace" })}
      onUseTemplate={(templateId) => void createFrom({ parentId: null, access: "workspace" }, { kind: "page", id: templateId })}
    />
  ) : null;

  if (compact) {
    return (
      <div className="flex min-h-0 flex-1 flex-col" data-docs-view="compact">
        {page ?? (
          <>
            <header className="flex h-[52px] shrink-0 items-center gap-2 border-b border-line px-3">
              <BackButton />
              <FileText size={18} className="text-muted" />
              <strong className="flex-1 text-[15px]">{t("nav.docs")}</strong>
            </header>
            {sidebar}
          </>
        )}
        {dialogs}
      </div>
    );
  }
  const isEmpty = hub.tree().shared.length === 0 && hub.tree().private.length === 0;
  return (
    <div className="flex min-h-0 flex-1" data-docs-view="wide">
      <aside aria-label={t("nav.docs")} className="flex w-[264px] shrink-0 flex-col border-r border-line bg-panel/40">
        <header className="flex h-11 shrink-0 items-center gap-2 border-b border-line px-3">
          <FileText size={16} className="text-muted" />
          <strong className="flex-1 text-sm">{t("nav.docs")}</strong>
        </header>
        {sidebar}
      </aside>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {page ?? (
          <Empty
            icon={<FileText size={24} />}
            title={isEmpty ? t("docs.emptyTitle") : t("docs.pickTitle")}
            text={isEmpty ? t("docs.emptyText") : t("docs.pickText")}
            action={!controller.isGuest ? (
              <div className="flex flex-wrap justify-center gap-2">
                <Button onClick={() => create({ parentId: null, access: "workspace" })}><Plus size={16} /> {t("docs.newShared")}</Button>
                <Button variant="secondary" onClick={() => create({ parentId: null, access: "private" })}><Plus size={16} /> {t("docs.newPrivate")}</Button>
              </div>
            ) : undefined}
          />
        )}
      </div>
      {dialogs}
    </div>
  );
}

function Empty({ icon, title, text, action }: { icon: React.ReactNode; title: string; text?: string; action?: React.ReactNode }) {
  return (
    <div className={cn("flex flex-1 flex-col items-center justify-center gap-2 px-6 py-10 text-center")}>
      <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-accent-soft text-accent">{icon}</span>
      <strong className="text-base">{title}</strong>
      {text && <span className="max-w-sm text-sm text-muted">{text}</span>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
