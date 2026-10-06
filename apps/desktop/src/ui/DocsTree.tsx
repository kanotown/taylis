/**
 * M121 (WIKI.md §3.1, §9.1): the 「ドキュメント」 tree — 「共有」 (pages others can read too) and 「プライベート」 (only me),
 * branches opened and closed (remembered on this device), ＋ for a new page at the top or below a page, ⋯ for a page's
 * actions, and pages dragged to another place (between two pages, or onto one to go inside it). A drop asks the server
 * first who would gain or lose access (DocsView's move dialog); only pages I have full access to can be dragged.
 */
import { ChevronRight, Copy, FilePlus2, FolderInput, Lock, MoreHorizontal, Pencil, Plus, Trash2, Users } from "lucide-react";
import { type DragEvent, type ReactNode, useEffect, useMemo, useState, useSyncExternalStore } from "react";

import type { PageItem } from "../api/types";
import type { AppController } from "../state/app";
import type { WikiHub } from "../sync/wiki";
import { ancestorIds, dropTarget, type DropZone, type MoveTarget, readExpanded, rootTarget, writeExpanded } from "../sync/wikiTree";
import { levelRank } from "./docsAccess";
import { pageTitle, updatePage } from "./docsActions";
import { PageIcon } from "./PageIcon";
import { Button, cn, Input, Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger, Modal } from "./primitives";
import { t } from "../i18n";

const DRAG_TYPE = "application/x-taylis-page";

type Over = { id: string; zone: DropZone } | { section: "shared" | "private" } | null;

export function useWikiHub(controller: AppController): WikiHub | null {
  const hub = controller.engine?.wiki ?? null;
  useSyncExternalStore((listener) => hub?.subscribe(listener) ?? (() => {}), () => hub?.version ?? 0);
  return hub;
}

export function DocsTree({ controller, selectedId, onOpen, onCreate, onMove, onTrash, onOpenTrash, className }: {
  controller: AppController;
  selectedId: string | null;
  onOpen: (pageId: string) => void;
  /** ＋: at the top of a section, or below a page. */
  onCreate: (where: { parentId: string | null; access: "workspace" | "private" }) => void;
  /** A drop: DocsView asks the server who would gain or lose access, then moves. */
  onMove: (pageId: string, target: MoveTarget) => void;
  onTrash: (page: PageItem) => void;
  onOpenTrash: () => void;
  className?: string;
}) {
  const hub = useWikiHub(controller);
  const tree = hub?.tree() ?? null;
  const pages = hub?.pages ?? new Map<string, PageItem>();
  const accountKey = controller.accountKey;
  const [expanded, setExpanded] = useState<Set<string>>(() => readExpanded(accountKey));
  const [drag, setDrag] = useState<string | null>(null);
  const [over, setOver] = useState<Over>(null);
  const [renaming, setRenaming] = useState<PageItem | null>(null);
  const guest = controller.isGuest;

  // The open page's branches open (a link or a notification may open a page deep inside).
  const path = useMemo(() => (selectedId ? ancestorIds(pages, selectedId) : []), [pages, selectedId]);
  useEffect(() => {
    if (path.length === 0 || path.every((id) => expanded.has(id))) return;
    setExpanded((current) => {
      const next = new Set(current);
      for (const id of path) next.add(id);
      writeExpanded(accountKey, next);
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path.join(",")]);

  const toggle = (id: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      writeExpanded(accountKey, next);
      return next;
    });

  if (!tree) return null;

  const endDrag = () => {
    setDrag(null);
    setOver(null);
  };
  const zoneOf = (event: DragEvent<HTMLElement>, page: PageItem): DropZone => {
    const box = event.currentTarget.getBoundingClientRect();
    const y = event.clientY - box.top;
    const inside = levelRank(page.my_level) >= 2;
    if (!inside) return y < box.height / 2 ? "before" : "after";
    return y < box.height * 0.28 ? "before" : y > box.height * 0.72 ? "after" : "inside";
  };
  const dragOverRow = (event: DragEvent<HTMLElement>, page: PageItem) => {
    if (!drag) return;
    const zone = zoneOf(event, page);
    if (!dropTarget(pages, drag, page.id, zone)) {
      if (over) setOver(null);
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    if (!over || !("id" in over) || over.id !== page.id || over.zone !== zone) setOver({ id: page.id, zone });
  };
  const dropOnRow = (event: DragEvent<HTMLElement>, page: PageItem) => {
    const dragged = drag ?? event.dataTransfer.getData(DRAG_TYPE);
    if (!dragged) return;
    event.preventDefault();
    const target = dropTarget(pages, dragged, page.id, zoneOf(event, page));
    endDrag();
    if (target) onMove(dragged, target);
  };
  const sectionDrop = (section: "shared" | "private") => ({
    onDragOver: (event: DragEvent<HTMLElement>) => {
      if (!drag || guest) return;
      event.preventDefault();
      if (!over || !("section" in over) || over.section !== section) setOver({ section });
    },
    onDragLeave: () => setOver(null),
    onDrop: (event: DragEvent<HTMLElement>) => {
      const dragged = drag ?? event.dataTransfer.getData(DRAG_TYPE);
      event.preventDefault();
      endDrag();
      const target = dragged ? rootTarget(pages, dragged, section) : null;
      if (target && dragged) onMove(dragged, target);
    },
  });

  const row = (page: PageItem, depth: number): ReactNode => {
    const kids = tree.children.get(page.id) ?? [];
    const open = expanded.has(page.id);
    const selected = page.id === selectedId;
    const canDrag = page.my_level === "full";
    const hovering = over && "id" in over && over.id === page.id ? over.zone : null;
    return (
      <li key={page.id} role="treeitem" aria-expanded={kids.length > 0 ? open : undefined} aria-selected={selected} data-page-row={page.id}>
        <div
          className={cn(
            "group/row relative flex h-8 items-center gap-1 rounded-lg pr-1 text-[13.5px] transition-colors",
            selected ? "bg-sidebar-active text-sidebar-active-fg" : "hover:bg-panel-2",
            drag === page.id && "opacity-50",
            hovering === "inside" && "bg-accent-soft ring-1 ring-accent",
          )}
          style={{ paddingLeft: 4 + depth * 14 }}
          draggable={canDrag}
          onDragStart={(event) => {
            if (!canDrag) {
              event.preventDefault();
              return;
            }
            event.dataTransfer.setData(DRAG_TYPE, page.id);
            event.dataTransfer.effectAllowed = "move";
            setDrag(page.id);
          }}
          onDragEnd={endDrag}
          onDragOver={(event) => dragOverRow(event, page)}
          onDragLeave={() => { if (hovering) setOver(null); }}
          onDrop={(event) => dropOnRow(event, page)}
        >
          {hovering === "before" && <span aria-hidden className="pointer-events-none absolute inset-x-1 top-0 h-0.5 rounded bg-accent" />}
          {hovering === "after" && <span aria-hidden className="pointer-events-none absolute inset-x-1 bottom-0 h-0.5 rounded bg-accent" />}
          <button
            type="button"
            aria-label={open ? t("docs.collapse") : t("docs.expand")}
            className={cn("flex h-6 w-5 shrink-0 items-center justify-center rounded text-muted hover:bg-ink/8", kids.length === 0 && "invisible")}
            onClick={() => toggle(page.id)}
            tabIndex={kids.length === 0 ? -1 : 0}
          >
            <ChevronRight size={14} className={cn("transition-transform", open && "rotate-90")} />
          </button>
          <button type="button" className="flex min-w-0 flex-1 items-center gap-1.5 text-left" onClick={() => onOpen(page.id)} aria-current={selected ? "page" : undefined}>
            <PageIcon controller={controller} icon={page.icon} size={15} />
            <span className="truncate">{pageTitle(page, t("docs.untitled"))}</span>
          </button>
          <span className="flex shrink-0 items-center opacity-0 transition-opacity focus-within:opacity-100 group-hover/row:opacity-100 pointer-coarse:opacity-100">
            {levelRank(page.my_level) >= 2 && (
              <button type="button" aria-label={t("docs.addChild")} title={t("docs.addChild")} className="flex h-6 w-6 items-center justify-center rounded text-muted hover:bg-ink/8 hover:text-ink" onClick={() => onCreate({ parentId: page.id, access: "workspace" })}>
                <Plus size={14} />
              </button>
            )}
            <RowMenu controller={controller} page={page} onOpen={() => onOpen(page.id)} onAddChild={() => onCreate({ parentId: page.id, access: "workspace" })} onRename={() => setRenaming(page)} onTrash={() => onTrash(page)} onTopLevel={page.parent_id && pages.has(page.parent_id) ? () => { const target = rootTarget(pages, page.id, page.private ? "private" : "shared"); if (target) onMove(page.id, target); } : null} />
          </span>
        </div>
        {kids.length > 0 && open && <ul role="group">{kids.map((kid) => row(kid, depth + 1))}</ul>}
      </li>
    );
  };

  const section = (key: "shared" | "private", label: string, icon: ReactNode, roots: readonly PageItem[], empty: string) => (
    <section aria-label={label} className="mb-3">
      <div
        className={cn("group/section flex h-7 items-center gap-1.5 rounded-md px-2 text-[11px] font-semibold uppercase tracking-wide text-muted", over && "section" in over && over.section === key && "bg-accent-soft text-accent")}
        {...sectionDrop(key)}
      >
        {icon}
        <span className="flex-1">{label}</span>
        {!guest && (
          <button type="button" aria-label={key === "shared" ? t("docs.newShared") : t("docs.newPrivate")} title={key === "shared" ? t("docs.newShared") : t("docs.newPrivate")} className="flex h-6 w-6 items-center justify-center rounded text-muted hover:bg-ink/8 hover:text-ink" onClick={() => onCreate({ parentId: null, access: key === "private" ? "private" : "workspace" })}>
            <Plus size={14} />
          </button>
        )}
      </div>
      {roots.length === 0 ? (
        <p className="px-3 py-1 text-xs text-muted">{empty}</p>
      ) : (
        <ul role="tree" aria-label={label}>{roots.map((page) => row(page, 0))}</ul>
      )}
    </section>
  );

  return (
    <nav aria-label={t("docs.tree")} className={cn("flex min-h-0 flex-col", className)}>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-3">
        {section("shared", t("docs.shared"), <Users size={12} />, tree.shared, guest ? t("docs.sharedEmptyGuest") : t("docs.sharedEmpty"))}
        {section("private", t("docs.private"), <Lock size={12} />, tree.private, t("docs.privateEmpty"))}
      </div>
      <div className="shrink-0 border-t border-line px-2 py-2">
        <button type="button" className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm text-muted hover:bg-panel-2 hover:text-ink" onClick={onOpenTrash}>
          <Trash2 size={15} /> {t("docs.trash")}
        </button>
      </div>
      {renaming && <RenameDialog controller={controller} page={renaming} onClose={() => setRenaming(null)} />}
    </nav>
  );
}

function RowMenu({ controller, page, onOpen, onAddChild, onRename, onTrash, onTopLevel }: {
  controller: AppController;
  page: PageItem;
  onOpen: () => void;
  onAddChild: () => void;
  onRename: () => void;
  onTrash: () => void;
  onTopLevel: (() => void) | null;
}) {
  const edit = levelRank(page.my_level) >= 2;
  const full = page.my_level === "full";
  return (
    <Menu>
      <MenuTrigger asChild>
        <button type="button" aria-label={t("docs.pageActions", { title: pageTitle(page, t("docs.untitled")) })} className="flex h-6 w-6 items-center justify-center rounded text-muted hover:bg-ink/8 hover:text-ink">
          <MoreHorizontal size={15} />
        </button>
      </MenuTrigger>
      <MenuContent align="start">
        <MenuLabel>{pageTitle(page, t("docs.untitled"))}</MenuLabel>
        <MenuItem onSelect={onOpen}>{t("docs.open")}</MenuItem>
        {edit && <MenuItem onSelect={onAddChild}><FilePlus2 size={14} /> {t("docs.addChild")}</MenuItem>}
        {edit && <MenuItem onSelect={onRename}><Pencil size={14} /> {t("docs.rename")}</MenuItem>}
        <MenuItem onSelect={() => void controller.copyPageLink(page.id)}><Copy size={14} /> {t("canvas.copyLink")}</MenuItem>
        {full && onTopLevel && <MenuItem onSelect={onTopLevel}><FolderInput size={14} /> {t("docs.moveToTop")}</MenuItem>}
        {full && (
          <>
            <MenuSeparator />
            <MenuItem className="text-danger" onSelect={onTrash}><Trash2 size={14} /> {t("canvas.moveToTrash")}</MenuItem>
          </>
        )}
      </MenuContent>
    </Menu>
  );
}

export function RenameDialog({ controller, page, onClose }: { controller: AppController; page: Pick<PageItem, "id" | "title">; onClose: () => void }) {
  const [title, setTitle] = useState(page.title);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    const trimmed = title.trim();
    if (!trimmed || trimmed === page.title) {
      onClose();
      return;
    }
    setBusy(true);
    const done = await updatePage(controller, page.id, { title: trimmed });
    setBusy(false);
    if (done) onClose();
  };
  return (
    <Modal title={t("docs.rename")} onClose={onClose}>
      <form className="mt-4 space-y-4" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        <Input aria-label={t("docs.titleLabel")} value={title} maxLength={200} autoFocus onChange={(event) => setTitle(event.target.value)} />
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>{t("common.cancel")}</Button>
          <Button type="submit" disabled={busy || title.trim() === ""}>{t("common.change")}</Button>
        </div>
      </form>
    </Modal>
  );
}
