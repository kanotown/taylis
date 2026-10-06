/**
 * M43: a conversation's 「キャンバス」 (CANVAS.md §4.1 / §5): its canvases (the conversation's tab canvas first), one of
 * them open — rendered, or in the editor with the preview beside it on a wide screen — with the save state
 * (保存中… / 保存済み / オフライン / 競合), the conflict choice (自分の版 / 相手の版 / 両方残す), a new canvas from a template,
 * the settings (title, who edits, the tab) and the trash. The history, search, images and sharing come in M44.
 */
import { Check, ChevronDown, CircleAlert, Cloud, CloudOff, Copy, FileText, History, ListTree, Loader2, MessageSquare, MoreHorizontal, Pencil, Plus, RotateCcw, Share2, Trash2 } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import type { CanvasConflict, CanvasMeta, CanvasOut, CanvasTemplateOut } from "../api/types";
import { describeError } from "../api/errors";
import type { AppController } from "../state/app";
import type { CanvasSaver, CanvasSaveStatus, SavedDoc } from "../sync/canvasSave";
import type { ChannelState } from "../sync/types";
import { CanvasBody, headingAnchor } from "./CanvasBody";
import { Avatar } from "./Avatar";
import { stripTaskMarkers } from "./canvasMarkers";
import { canvasTaskInit } from "./canvasTasks";
import { TaskDialog } from "./TaskDialog";
import type { TaskCreateInit } from "./tasks";
import { editingLabel } from "../sync/canvasPresence";
import { CanvasEditor } from "./CanvasEditor";
import { useCanvasScrollSync } from "./useCanvasScrollSync";
import { canvasRights, type CanvasRights, isDmConversation, NO_CANVAS_RIGHTS } from "./canvasAccess";
import { CanvasHistoryDialog } from "./CanvasHistory";
import { outline, taskProgress, toggleTaskLine } from "./canvasText";
import { useCompact } from "./compact";
import { CANVAS_SPLIT_DEFAULT, CANVAS_SPLIT_MAX, CANVAS_SPLIT_MIN, clampCanvasSplit, readCanvasSplit, writeCanvasSplit } from "./prefs";
import { sinceLabel } from "./format";
import { mentionsToNames } from "./mentions";
import { Badge, Button, cn, Input, Menu, MenuContent, MenuItem, MenuLabel, MenuRadioGroup, MenuRadioItem, MenuSeparator, MenuTrigger, Modal, PopoverContent, PopoverRoot, PopoverTrigger } from "./primitives";
import { t } from "../i18n";

/** The canvas the tab opens on: the conversation's tab canvas, else the most recently updated one. */
export function defaultCanvasId(list: readonly CanvasMeta[]): string | null {
  return (list.find((c) => c.is_channel_tab) ?? list[0])?.id ?? null;
}

function actorOf(controller: AppController) {
  return { id: controller.store.me?.id ?? null, isAdmin: controller.isAdmin, isGuest: controller.isGuest };
}

/** The pane of the conversation's 「キャンバス」 tab. `canvasId` null: the default one (or the empty state). */
export function CanvasPane({ controller, channel, canvasId, onSelect, onOpenThread }: {
  controller: AppController;
  channel: ChannelState;
  canvasId: string | null;
  onSelect: (canvasId: string | null) => void;
  /** M44: 「コメント」 opens the shared message's thread (CANVAS.md §4.13). */
  onOpenThread?: (channelId: string, messageId: string) => void;
}) {
  const store = controller.store;
  const list = store.canvasesOf(channel.id);
  const hub = controller.engine?.canvases ?? null;
  const [dialog, setDialog] = useState<"new" | "trash" | null>(null);
  const selectedId = canvasId ?? (list ? defaultCanvasId(list) : null);
  const createRights = canvasRights(channel, actorOf(controller), null);

  // The list arrives with the conversation (engine.openChannel); a pane shown before that asks once more.
  useEffect(() => {
    if (list === null) void hub?.loadList(channel.id);
  }, [hub, channel.id, list === null]); // eslint-disable-line react-hooks/exhaustive-deps

  const created = (canvas: CanvasOut) => {
    setDialog(null);
    onSelect(canvas.id);
  };
  const dialogs = (
    <>
      {dialog === "new" && <NewCanvasDialog controller={controller} channel={channel} list={list ?? []} onClose={() => setDialog(null)} onCreated={created} />}
      {dialog === "trash" && <TrashDialog controller={controller} channel={channel} onClose={() => setDialog(null)} onRestored={(canvas) => { setDialog(null); onSelect(canvas.id); }} />}
    </>
  );

  if (!hub || !hub.available) {
    return <Empty icon={<CircleAlert size={22} />} title={t("canvas.unavailable")} text={t("canvas.unavailableText")} />;
  }
  if (list === null && !selectedId) {
    const failure = store.canvasListFailure(channel.id);
    if (failure === "unsupported") {
      return <Empty icon={<CircleAlert size={22} />} title={t("canvas.serverTooOld")} text={t("canvas.serverTooOldText")} />;
    }
    if (failure === "failed") {
      return (
        <Empty
          icon={<CircleAlert size={22} />}
          title={t("canvas.loadFailed")}
          action={<Button variant="secondary" size="sm" onClick={() => void hub.loadList(channel.id)}>{t("common.reload")}</Button>}
        />
      );
    }
    return <Empty icon={<Loader2 size={22} className="animate-spin" />} title={t("common.loading")} />;
  }
  if (!selectedId) {
    return (
      <section aria-label={t("main.tab.canvas")} className="flex min-h-0 flex-1 flex-col">
        <Empty
          icon={<FileText size={24} />}
          title={t("canvas.none")}
          text={t("canvas.noneText")}
          action={
            <div className="flex flex-wrap justify-center gap-2">
              {createRights.create && <Button onClick={() => setDialog("new")}><Plus size={16} /> {t("canvas.create")}</Button>}
              <Button variant="secondary" onClick={() => setDialog("trash")}><Trash2 size={15} /> {t("canvas.trash")}</Button>
            </div>
          }
        />
        {dialogs}
      </section>
    );
  }
  return (
    <>
      <OpenCanvas
        key={selectedId}
        controller={controller}
        channel={channel}
        canvasId={selectedId}
        list={list ?? []}
        onSelect={onSelect}
        onNew={createRights.create ? () => setDialog("new") : null}
        onTrash={() => setDialog("trash")}
        onOpenThread={onOpenThread}
      />
      {dialogs}
    </>
  );
}

function Empty({ icon, title, text, action }: { icon: ReactNode; title: string; text?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 py-10 text-center">
      <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-accent-soft text-accent">{icon}</span>
      <strong className="text-base">{title}</strong>
      {text && <span className="max-w-sm text-sm text-muted">{text}</span>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

type Mode = "edit" | "view";

interface OpenCanvasProps {
  controller: AppController;
  channel: ChannelState;
  canvasId: string;
  list: readonly CanvasMeta[];
  onSelect: (canvasId: string | null) => void;
  onNew: (() => void) | null;
  onTrash: () => void;
  onOpenThread?: (channelId: string, messageId: string) => void;
}

/** Holds the canvas's save loop while it is on screen; letting go saves what is typed (§4.4 「画面を閉じるとき」). */
function OpenCanvas(props: OpenCanvasProps) {
  const hub = props.controller.engine!.canvases;
  const [saver, setSaver] = useState<CanvasSaver | null>(null);
  useEffect(() => {
    const held = hub.hold(props.canvasId, props.channel.id);
    setSaver(held.saver);
    return held.release;
  }, [hub, props.canvasId, props.channel.id]);
  if (!saver) return <Empty icon={<Loader2 size={22} className="animate-spin" />} title={t("common.loading")} />;
  return <CanvasView {...props} saver={saver} />;
}

/** One canvas on screen: its bar, the document (and the editor), the choices a save may ask for. */
function CanvasView({ controller, channel, canvasId, list, onSelect, onNew, onTrash, onOpenThread, saver }: OpenCanvasProps & { saver: CanvasSaver }) {
  const compact = useCompact();
  useSyncExternalStore((listener) => saver.subscribe(listener), () => saver.revision);
  // The window going to the background saves what is typed now (§4.4).
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === "hidden") void saver.flush();
    };
    document.addEventListener("visibilitychange", onHide);
    return () => document.removeEventListener("visibilitychange", onHide);
  }, [saver]);

  const listed = list.find((c) => c.id === canvasId);
  // The newer of the list's metadata (events) and the saver's (answers).
  const meta: CanvasMeta | null = listed && (!saver.canvas || listed.version >= saver.canvas.version) ? listed : saver.canvas;
  const rights = meta ? canvasRights(channel, actorOf(controller), meta) : NO_CANVAS_RIGHTS;
  const [mode, setMode] = useState<Mode>(() => (compact ? "view" : "edit"));
  // The editor's share of the width beside the preview: dragged by the line between them, kept on this device.
  const [split, setSplit] = useState(readCanvasSplit);
  const splitBox = useRef<HTMLDivElement>(null);
  const changeSplit = (value: number) => {
    setSplit(value);
    writeCanvasSplit(value);
  };
  const startSplitResize = (event: React.PointerEvent<HTMLDivElement>) => {
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
  const [renaming, setRenaming] = useState(false);
  const [conflictOpen, setConflictOpen] = useState(true);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [opening, setOpening] = useState(false);
  const shared = !!meta?.share_message_id;
  // §4.13: the comments are the shared message's thread; a canvas never shared is shared first (a message is posted).
  const openComments = async () => {
    if (!meta || !onOpenThread || opening) return;
    setOpening(true);
    const messageId = await controller.canvasCommentsMessage(meta);
    setOpening(false);
    if (messageId) onOpenThread(meta.channel_id, messageId);
  };
  const share = async () => {
    if (!meta) return;
    const done = await controller.shareCanvas(meta.id);
    if (done) controller.setNotice(t("canvas.sharedToConversation"));
  };
  const editing = rights.edit && mode === "edit" && saver.status !== "loading" && saver.status !== "gone";
  const onToggleTask = rights.tick && saver.status !== "gone" && saver.status !== "loading"
    ? (line: number, done: boolean) => {
        const next = toggleTaskLine(saver.text, line, done);
        if (next === null) return;
        saver.edit(next, true);
        void saver.flush(); // §4.4: a tick is saved at once
      }
    : null;
  useEffect(() => {
    if (saver.status === "conflict" || saver.status === "expired") setConflictOpen(true);
  }, [saver.status]);

  // M72 (CANVAS.md §18.3): 「タスクにする」 on an open checklist item, when this server has tasks and the conversation is
  // not archived. What is typed is saved first: the server looks for the item in the saved body.
  const [taskInit, setTaskInit] = useState<TaskCreateInit | null>(null);
  const taskHub = controller.engine?.tasks ?? null;
  const onMakeTask = taskHub?.available && !channel.archived && saver.status !== "gone" && saver.status !== "loading"
    ? (line: number) => {
        const init = canvasTaskInit({ id: canvasId, body: saver.text }, line, controller.store.getChannel(channel.id) ?? channel, controller.store.users, controller.store.groups, controller.isAdmin);
        if (!init) return;
        void saver.flush().then(() => setTaskInit(init));
      }
    : null;

  const headings = useMemo(() => outline(saver.text), [saver.text]);
  // §23: in the two columns the editor and the preview scroll together (always on; the single column has one side).
  const [editorArea, setEditorArea] = useState<HTMLTextAreaElement | null>(null);
  const [previewBox, setPreviewBox] = useState<HTMLDivElement | null>(null);
  useCanvasScrollSync(editing && !compact ? editorArea : null, editing && !compact ? previewBox : null, saver.text);
  const showOutline = !compact && !editing && headings.length >= 3;
  const title = meta?.title ?? t("main.tab.canvas");
  const notice = noticeFor(channel, rights, saver, controller);

  return (
    <section aria-label={t("canvas.labelWithTitle", { title })} className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-11 shrink-0 items-center gap-1.5 border-b border-line px-2">
        <CanvasPicker controller={controller} list={list} currentId={canvasId} title={title} onSelect={onSelect} onNew={onNew} onTrash={onTrash} />
        <div className="min-w-0 flex-1" />
        <CanvasEditing controller={controller} canvasId={canvasId} />
        <SaveState saver={saver} onOpenConflict={() => setConflictOpen(true)} />
        {meta && saver.status !== "gone" && onOpenThread && (shared || rights.share) && (
          <button
            type="button"
            title={shared ? t("canvas.commentsShared") : t("canvas.commentsShare")}
            aria-label={t("canvas.comments")}
            disabled={opening}
            onClick={() => void openComments()}
            className="inline-flex h-8 shrink-0 items-center gap-1 rounded-lg px-2 text-xs font-medium text-ink transition-colors hover:bg-ink/6 disabled:opacity-50"
          >
            {opening ? <Loader2 size={15} className="animate-spin" /> : <MessageSquare size={15} />}
            <span className="max-md:sr-only">{t("canvas.comments")}</span>
          </button>
        )}
        {meta && saver.status !== "gone" && (
          <button type="button" title={t("canvas.history")} aria-label={t("canvas.history")} onClick={() => setHistoryOpen(true)} className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-ink transition-colors hover:bg-ink/6 max-md:hidden">
            <History size={16} />
          </button>
        )}
        {rights.edit && saver.status !== "gone" && (
          <div role="tablist" aria-label={t("canvas.mode")} className="flex shrink-0 rounded-lg bg-panel-2 p-0.5 text-xs font-medium">
            {(["edit", "view"] as const).map((value) => (
              <button
                key={value}
                type="button"
                role="tab"
                aria-selected={mode === value}
                onClick={() => setMode(value)}
                className={cn("rounded-md px-2.5 py-1 transition-colors", mode === value ? "bg-canvas text-ink shadow-sm" : "text-muted hover:text-ink")}
              >
                {value === "edit" ? t("canvas.edit") : t("canvas.view")}
              </button>
            ))}
          </div>
        )}
        {meta && saver.status !== "gone" && (
          <CanvasMenu controller={controller} channel={channel} canvas={meta} rights={rights} onRename={() => setRenaming(true)} onTrashed={() => onSelect(null)} onShare={shared || !rights.share ? null : () => void share()} onHistory={() => setHistoryOpen(true)} />
        )}
      </div>
      {notice && <div className={cn("flex shrink-0 items-center gap-2 border-b border-line px-4 py-1.5 text-xs", notice.tone === "warn" ? "bg-warning/10 text-ink" : "bg-panel text-muted")}>{notice.text}{notice.action}</div>}
      {saver.status === "loading" ? (
        <Empty icon={<Loader2 size={22} className="animate-spin" />} title={t("common.loading")} />
      ) : editing ? (
        <div ref={splitBox} className={cn("flex min-h-0 flex-1", compact ? "flex-col" : "flex-row")}>
          <CanvasEditor controller={controller} saver={saver} onTextArea={setEditorArea} className={cn("min-w-0", compact ? "flex-1" : "shrink-0")} style={compact ? undefined : { width: `${split * 100}%` }} />
          {!compact && (
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label={t("canvas.splitWidth")}
              aria-valuemin={CANVAS_SPLIT_MIN * 100}
              aria-valuemax={CANVAS_SPLIT_MAX * 100}
              aria-valuenow={Math.round(split * 100)}
              tabIndex={0}
              title={t("main.resizeHint")}
              onPointerDown={startSplitResize}
              onDoubleClick={() => changeSplit(CANVAS_SPLIT_DEFAULT)}
              onKeyDown={(event) => {
                if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
                  event.preventDefault();
                  changeSplit(clampCanvasSplit(split + (event.key === "ArrowLeft" ? -0.05 : 0.05)));
                }
              }}
              className="relative w-px shrink-0 cursor-col-resize bg-line outline-none before:absolute before:inset-y-0 before:-left-1 before:w-2 before:content-[''] hover:bg-accent/60 focus-visible:bg-accent"
            />
          )}
          {!compact && (
            <div ref={setPreviewBox} className="min-h-0 min-w-0 flex-1 overflow-y-auto" aria-label={t("canvas.previewLabel")}>
              <div className="mx-auto max-w-3xl px-6 py-4">
                <div className="mb-3 text-[11px] font-semibold uppercase tracking-wide text-muted">{t("composer.preview")}</div>
                <CanvasBody body={saver.text} controller={controller} onToggleTask={onToggleTask} onMakeTask={onMakeTask} />
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          <div className="min-h-0 flex-1 overflow-y-auto" aria-label={t("canvas.content")}>
            <article className="mx-auto max-w-3xl px-6 py-6 max-md:px-4 max-md:py-4">
              <h1 className="mb-1 text-[26px] font-bold leading-tight max-md:text-[22px]">{title}</h1>
              {meta && <Byline controller={controller} canvas={meta} />}
              {saver.text.trim() === "" ? (
                <p className="mt-6 text-sm text-muted">
                  {t("canvas.emptyBody")}{rights.edit && <button type="button" className="text-accent hover:underline" onClick={() => setMode("edit")}>{t("canvas.startWriting")}</button>}
                </p>
              ) : (
                <CanvasBody body={saver.text} controller={controller} onToggleTask={onToggleTask} onMakeTask={onMakeTask} className="mt-5" />
              )}
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
      {renaming && meta && <RenameDialog controller={controller} canvas={meta} onClose={() => setRenaming(false)} />}
      {taskInit && <TaskDialog controller={controller} task={null} init={taskInit} onClose={() => setTaskInit(null)} />}
      {historyOpen && meta && <CanvasHistoryDialog controller={controller} canvas={meta} rights={rights} onClose={() => setHistoryOpen(false)} />}
      {conflictOpen && saver.status === "conflict" && saver.conflict && (
        <ConflictDialog controller={controller} saver={saver} tickOnly={!rights.edit} conflicts={saver.conflict.details.conflicts ?? []} timedOut={saver.conflict.details.timed_out ?? false} onClose={() => setConflictOpen(false)} />
      )}
      {conflictOpen && saver.status === "expired" && saver.expired && (
        <ExpiredDialog controller={controller} saver={saver} head={saver.expired} canOverwrite={rights.edit} onClose={() => setConflictOpen(false)} />
      )}
    </section>
  );
}

/**
 * M72 (CANVAS.md §18.2): who else edits this canvas now — their pictures (three, then 「+N」) and 「〇〇 が編集中」, each
 * one's heading in the tooltip. Volatile: an entry goes 45 s after its last refresh (re-checked every second).
 */
function CanvasEditing({ controller, canvasId }: { controller: AppController; canvasId: string }) {
  const store = controller.store;
  const [now, setNow] = useState(() => Date.now());
  const editors = store.canvasEditors(canvasId, now);
  useEffect(() => {
    if (editors.length === 0) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [editors.length]);
  if (editors.length === 0) return null;
  const nameOf = (id: string) => store.users.get(id)?.display_name ?? t("common.member");
  const label = editingLabel(editors.map((e) => nameOf(e.userId)));
  const detail = editors.map((e) => (e.section ? `${nameOf(e.userId)}: ${e.section}` : nameOf(e.userId))).join("\n");
  const shown = editors.slice(0, 3);
  return (
    <div className="flex min-w-0 shrink items-center gap-1.5 px-1 text-xs text-muted" title={detail} aria-live="polite" data-canvas-editing={editors.length}>
      <span className="flex shrink-0 items-center -space-x-1.5" aria-hidden="true">
        {shown.map((e) => (
          <Avatar key={e.userId} id={e.userId} name={nameOf(e.userId)} size={20} className="rounded-full ring-2 ring-canvas" />
        ))}
        {editors.length > shown.length && (
          <span className="relative inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-panel-2 px-1 text-[10px] font-semibold ring-2 ring-canvas">+{editors.length - shown.length}</span>
        )}
      </span>
      <span className="truncate max-md:sr-only">{label}</span>
    </div>
  );
}

/** A line under the bar: why this canvas cannot be changed here, or what happened to it. */
function noticeFor(channel: ChannelState, rights: CanvasRights, saver: CanvasSaver, controller: AppController): { text: string; tone: "info" | "warn"; action?: ReactNode } | null {
  const copy = (
    <button type="button" className="ml-auto inline-flex shrink-0 items-center gap-1 text-accent hover:underline" onClick={() => void controller.copyMessageText(stripTaskMarkers(saver.text))}>
      <Copy size={12} /> {t("canvas.copyBody")}
    </button>
  );
  if (saver.status === "gone") return { text: t("canvas.goneNote"), tone: "warn", action: copy };
  if (saver.status === "blocked") return { text: t("canvas.blockedNote", { error: describeError(saver.error) }), tone: "warn", action: copy };
  if (channel.archived) return { text: t("canvas.archivedNote"), tone: "info" };
  if (saver.status === "loading") return null;
  if (!rights.edit && rights.tick) return { text: t("canvas.tickOnlyNote"), tone: "info" };
  if (!rights.tick) return { text: t("canvas.readOnlyNote"), tone: "info" };
  return null;
}

/** 「更新: 名前 · 10:23」 and the task progress. */
function Byline({ controller, canvas }: { controller: AppController; canvas: CanvasMeta }) {
  const who = controller.store.users.get(canvas.updated_by)?.display_name ?? t("common.member");
  const progress = taskProgress(canvas.task_total, canvas.task_done);
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
      <span>{t("canvas.lastUpdated", { who, when: sinceLabel(canvas.updated_at) })}</span>
      {progress && <span className="inline-flex items-center gap-1"><Check size={12} /> {progress}</span>}
      {canvas.is_channel_tab && <Badge tone="accent">{t("canvas.conversationCanvas")}</Badge>}
      {canvas.edit_policy === "owners" && <span>{t("canvas.editOwnersOnly")}</span>}
    </div>
  );
}

const STATUS: Record<CanvasSaveStatus, { label: string; icon: ReactNode; tone: string }> = {
  loading: { get label() { return t("common.loading"); }, icon: <Loader2 size={13} className="animate-spin" />, tone: "text-muted" },
  saved: { get label() { return t("canvas.status.saved"); }, icon: <Cloud size={13} />, tone: "text-muted" },
  editing: { get label() { return t("canvas.status.editing"); }, icon: <Pencil size={13} />, tone: "text-muted" },
  saving: { get label() { return t("common.saving"); }, icon: <Loader2 size={13} className="animate-spin" />, tone: "text-muted" },
  offline: { get label() { return t("connection.offline"); }, icon: <CloudOff size={13} />, tone: "text-warning" },
  retrying: { get label() { return t("canvas.status.retrying"); }, icon: <Loader2 size={13} className="animate-spin" />, tone: "text-warning" },
  conflict: { get label() { return t("canvas.status.conflict"); }, icon: <CircleAlert size={13} />, tone: "text-danger" },
  expired: { get label() { return t("canvas.status.conflict"); }, icon: <CircleAlert size={13} />, tone: "text-danger" },
  blocked: { get label() { return t("canvas.status.blocked"); }, icon: <CircleAlert size={13} />, tone: "text-danger" },
  gone: { get label() { return t("canvas.trash"); }, icon: <Trash2 size={13} />, tone: "text-muted" },
};

/** The save state beside the canvas's name; a conflict reopens its choice. */
export function SaveState({ saver, onOpenConflict }: { saver: CanvasSaver<SavedDoc>; onOpenConflict: () => void }) {
  const state = STATUS[saver.status];
  const hint = saver.status === "offline" ? t("canvas.offlineHint") : saver.status === "retrying" ? t("canvas.retryingHint") : undefined;
  const content = (
    <>
      {state.icon}
      <span className="max-md:sr-only">{state.label}</span>
    </>
  );
  if (saver.status === "conflict" || saver.status === "expired") {
    return (
      <button type="button" data-save-state={saver.status} onClick={onOpenConflict} className={cn("inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs font-medium hover:bg-danger/10", state.tone)}>
        {content}
      </button>
    );
  }
  return (
    <span role="status" data-save-state={saver.status} title={hint ?? state.label} className={cn("inline-flex shrink-0 items-center gap-1 px-1.5 text-xs", state.tone)}>
      {content}
    </span>
  );
}

/** The canvas's name as a button: the conversation's canvases, a new one, the trash. */
function CanvasPicker({ controller, list, currentId, title, onSelect, onNew, onTrash }: {
  controller: AppController;
  list: readonly CanvasMeta[];
  currentId: string;
  title: string;
  onSelect: (canvasId: string | null) => void;
  onNew: (() => void) | null;
  onTrash: () => void;
  onOpenThread?: (channelId: string, messageId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const choose = (run: () => void) => {
    setOpen(false);
    run();
  };
  return (
    <PopoverRoot open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" aria-label={t("canvas.list")} className="flex min-w-0 items-center gap-1.5 rounded-lg px-2 py-1 text-sm font-semibold hover:bg-ink/6">
          <FileText size={16} className="shrink-0 text-accent" />
          <span className="truncate">{title}</span>
          <ChevronDown size={14} className="shrink-0 text-muted" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 p-1">
        <div className="px-2.5 pb-1 pt-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted">{t("canvas.inThisConversation")}</div>
        <ul className="max-h-80 overflow-y-auto" aria-label={t("nav.canvases")}>
          {list.map((canvas) => (
            <li key={canvas.id}>
              <button
                type="button"
                aria-current={canvas.id === currentId ? "true" : undefined}
                onClick={() => choose(() => onSelect(canvas.id))}
                className={cn("flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm hover:bg-accent-soft", canvas.id === currentId && "bg-panel")}
              >
                <FileText size={14} className="shrink-0 text-muted" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{canvas.title}</span>
                  <span className="block truncate text-[11px] text-muted">{controller.store.users.get(canvas.updated_by)?.display_name ?? t("common.member")} · {sinceLabel(canvas.updated_at)}</span>
                </span>
                {canvas.is_channel_tab && <Badge tone="accent">{t("canvas.tab")}</Badge>}
                {taskProgress(canvas.task_total, canvas.task_done) && <span className="shrink-0 text-[11px] text-muted">{taskProgress(canvas.task_total, canvas.task_done)}</span>}
              </button>
            </li>
          ))}
        </ul>
        <div className="mt-1 border-t border-line pt-1">
          {onNew && (
            <button type="button" className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm hover:bg-accent-soft" onClick={() => choose(onNew)}>
              <Plus size={14} /> {t("canvas.new")}
            </button>
          )}
          <button type="button" className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm hover:bg-accent-soft" onClick={() => choose(onTrash)}>
            <Trash2 size={14} /> {t("canvas.trash")}
          </button>
        </div>
      </PopoverContent>
    </PopoverRoot>
  );
}

/** ⋯: title, who edits (not in a DM), the conversation's tab, the trash (CANVAS.md §4.7). */
function CanvasMenu({ controller, channel, canvas, rights, onRename, onTrashed, onShare, onHistory }: {
  controller: AppController;
  channel: ChannelState;
  canvas: CanvasMeta;
  rights: CanvasRights;
  onRename: () => void;
  onTrashed: () => void;
  /** M44: 「会話に共有」 (null: shared already, or not allowed here). */
  onShare: (() => void) | null;
  onHistory: () => void;
}) {
  const dm = isDmConversation(channel);
  const tabTaken = (controller.store.canvasesOf(channel.id) ?? []).some((c) => c.is_channel_tab && c.id !== canvas.id);
  return (
    <Menu>
      <MenuTrigger asChild>
        <button type="button" aria-label={t("canvas.actions")} title={t("canvas.actions")} className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-ink transition-colors hover:bg-ink/6">
          <MoreHorizontal size={18} />
        </button>
      </MenuTrigger>
      <MenuContent align="end">
        <MenuLabel>{canvas.title}</MenuLabel>
        {onShare && <MenuItem onSelect={onShare}><Share2 size={14} /> {t("canvas.shareToConversation")}</MenuItem>}
        <MenuItem onSelect={() => void controller.copyCanvasLink(canvas.id)}>
          <Copy size={14} /> {t("canvas.copyLink")}
        </MenuItem>
        <MenuItem onSelect={onHistory}><History size={14} /> {t("canvas.historyMenu")}</MenuItem>
        {rights.manage && <MenuSeparator />}
        {rights.manage && <MenuItem onSelect={onRename}>{t("canvas.renameMenu")}</MenuItem>}
        {rights.manage && !tabTaken && (
          <MenuItem onSelect={() => void controller.updateCanvas(canvas.id, { is_channel_tab: !canvas.is_channel_tab })}>
            {canvas.is_channel_tab ? t("canvas.unsetTab") : t("canvas.setTab")}
          </MenuItem>
        )}
        {rights.manage && !dm && (
          <>
            <MenuSeparator />
            <MenuLabel>{t("canvas.whoCanEdit")}</MenuLabel>
            <MenuRadioGroup value={canvas.edit_policy} onValueChange={(value) => void controller.updateCanvas(canvas.id, { edit_policy: value as "members" | "owners" })}>
              <MenuRadioItem value="members">{t("canvas.editMembers")}</MenuRadioItem>
              <MenuRadioItem value="owners">{t("canvas.editOwners")}</MenuRadioItem>
            </MenuRadioGroup>
          </>
        )}
        {rights.trash && (
          <>
            <MenuSeparator />
            <MenuItem className="text-danger" onSelect={() => void controller.trashCanvas(canvas.id, channel.id).then((ok) => { if (ok) onTrashed(); })}>
              <Trash2 size={14} /> {t("canvas.moveToTrash")}
            </MenuItem>
          </>
        )}
      </MenuContent>
    </Menu>
  );
}

function RenameDialog({ controller, canvas, onClose }: { controller: AppController; canvas: CanvasMeta; onClose: () => void }) {
  const [title, setTitle] = useState(canvas.title);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    const trimmed = title.trim();
    if (!trimmed || trimmed === canvas.title) {
      onClose();
      return;
    }
    setBusy(true);
    const ok = await controller.updateCanvas(canvas.id, { title: trimmed });
    setBusy(false);
    if (ok) onClose();
  };
  return (
    <Modal title={t("canvas.rename")} onClose={onClose}>
      <form className="mt-4 space-y-4" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        <Input aria-label={t("canvas.titleLabel")} value={title} maxLength={200} autoFocus onChange={(event) => setTitle(event.target.value)} />
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>{t("common.cancel")}</Button>
          <Button type="submit" disabled={busy || title.trim() === ""}>{t("common.change")}</Button>
        </div>
      </form>
    </Modal>
  );
}

/** A new canvas: empty or from a template (§4.12); the conversation's tab when it has none. */
function NewCanvasDialog({ controller, channel, list, onClose, onCreated }: {
  controller: AppController;
  channel: ChannelState;
  list: readonly CanvasMeta[];
  onClose: () => void;
  onCreated: (canvas: CanvasOut) => void;
}) {
  const [templates, setTemplates] = useState<CanvasTemplateOut[] | null>(null);
  const [choice, setChoice] = useState<string>("");
  const [title, setTitle] = useState("");
  const hasTab = list.some((c) => c.is_channel_tab);
  const [asTab, setAsTab] = useState(!hasTab);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void controller.canvasTemplates().then((rows) => setTemplates(rows ?? []));
  }, [controller]);
  const create = async () => {
    setBusy(true);
    const canvas = await controller.createCanvas(channel.id, { templateKey: choice || null, title: title.trim() || null, asTab: asTab && !hasTab });
    setBusy(false);
    if (canvas) onCreated(canvas);
  };
  const option = (key: string, name: string, description: string | null) => (
    <label key={key || "blank"} className={cn("flex cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2", choice === key ? "border-accent bg-accent-soft/50" : "border-line hover:bg-panel")}>
      <input type="radio" name="canvas-template" className="mt-1" checked={choice === key} onChange={() => setChoice(key)} />
      <span className="min-w-0">
        <span className="block text-sm font-medium">{name}</span>
        {description && <span className="block text-xs text-muted">{description}</span>}
      </span>
    </label>
  );
  return (
    <Modal title={t("canvas.new")} description={t("canvas.newDescription")} onClose={onClose} className="w-[520px]">
      <form className="mt-4 space-y-3" onSubmit={(event) => { event.preventDefault(); void create(); }}>
        <div className="max-h-[42dvh] space-y-1.5 overflow-y-auto pr-1" role="radiogroup" aria-label={t("composer.templates")}>
          {option("", t("canvas.blank"), null)}
          {templates === null ? <div className="py-2 text-sm text-muted">{t("canvas.loadingTemplates")}</div> : templates.map((t) => option(t.key, t.name, t.description))}
        </div>
        <Input aria-label={t("canvas.titleLabel")} placeholder={choice ? t("canvas.titlePlaceholderTemplate") : t("canvas.titlePlaceholderBlank")} value={title} maxLength={200} onChange={(event) => setTitle(event.target.value)} />
        {!hasTab && (
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={asTab} onChange={(event) => setAsTab(event.target.checked)} />
            {t("canvas.setTabNote")}
          </label>
        )}
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="secondary" onClick={onClose}>{t("common.cancel")}</Button>
          <Button type="submit" disabled={busy}>{t("common.create")}</Button>
        </div>
      </form>
    </Modal>
  );
}

/** The conversation's trash: canvases moved there (restorable; the server purges them after 30 days). */
function TrashDialog({ controller, channel, onClose, onRestored }: {
  controller: AppController;
  channel: ChannelState;
  onClose: () => void;
  onRestored: (canvas: CanvasOut) => void;
}) {
  const [rows, setRows] = useState<CanvasMeta[] | null>(null);
  useEffect(() => {
    void controller.trashedCanvases(channel.id).then((list) => setRows(list ?? []));
  }, [controller, channel.id]);
  const actor = actorOf(controller);
  return (
    <Modal title={t("canvas.trashTitle")} description={t("canvas.trashDescription")} onClose={onClose}>
      <div className="mt-4 max-h-[50dvh] space-y-1 overflow-y-auto">
        {rows === null ? (
          <div className="py-4 text-center text-sm text-muted">{t("common.loading")}</div>
        ) : rows.length === 0 ? (
          <div className="py-4 text-center text-sm text-muted">{t("canvas.trashEmpty")}</div>
        ) : (
          rows.map((canvas) => (
            <div key={canvas.id} className="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-panel">
              <FileText size={15} className="shrink-0 text-muted" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm">{canvas.title}</span>
                <span className="block text-[11px] text-muted">{t("canvas.deletedAt", { when: canvas.deleted_at ? sinceLabel(canvas.deleted_at) : "" })}</span>
              </span>
              {canvasRights(channel, actor, canvas).trash && (
                <Button size="sm" variant="secondary" onClick={() => void controller.restoreCanvas(canvas.id).then((restored) => { if (restored) onRestored(restored); })}>
                  <RotateCcw size={13} /> {t("canvas.restore")}
                </Button>
              )}
            </div>
          ))
        )}
      </div>
    </Modal>
  );
}

/** §4.4 409 canvas_conflict: where both changed the same words, and the three choices. */
export function ConflictDialog({ controller, saver, tickOnly, conflicts, timedOut, onClose }: {
  controller: AppController;
  saver: CanvasSaver<SavedDoc>;
  tickOnly: boolean;
  conflicts: readonly CanvasConflict[];
  timedOut: boolean;
  onClose: () => void;
}) {
  const store = controller.store;
  const names = (text: string) => mentionsToNames(stripTaskMarkers(text), store.users, store.groups);
  const shown = conflicts.slice(0, 5);
  return (
    <Modal
      title={t("canvas.conflictTitle")}
      description={tickOnly ? t("canvas.conflictTickOnly") : t("canvas.conflictDescription")}
      onClose={onClose}
      className="w-[680px]"
    >
      <div className="mt-4 max-h-[50dvh] space-y-3 overflow-y-auto" aria-label={t("canvas.conflictParts")}>
        {timedOut && <p className="text-sm text-muted">{t("canvas.conflictTimedOut")}</p>}
        {shown.map((conflict, index) => (
          <div key={index} className="grid gap-2 rounded-lg border border-line p-2 text-[13px] md:grid-cols-2">
            <ConflictSide label={t("canvas.mine")} text={names(conflict.ours)} tone="accent" />
            <ConflictSide label={t("canvas.theirs")} text={names(conflict.theirs)} tone="neutral" />
            {conflict.base.trim() !== "" && <div className="text-[11px] text-muted md:col-span-2">{t("canvas.base", { text: names(conflict.base).slice(0, 200) })}</div>}
          </div>
        ))}
        {conflicts.length > shown.length && <p className="text-xs text-muted">{t("canvas.moreParts", { count: conflicts.length - shown.length })}</p>}
      </div>
      <div className="mt-4 flex flex-wrap justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>{t("common.later")}</Button>
        {!tickOnly && <Button variant="secondary" onClick={() => { onClose(); void saver.resolveConflict("both"); }}>{t("canvas.keepBoth")}</Button>}
        <Button variant="secondary" onClick={() => { onClose(); void saver.resolveConflict("theirs"); }}>{t("canvas.theirs")}</Button>
        {!tickOnly && <Button onClick={() => { onClose(); void saver.resolveConflict("ours"); }}>{t("canvas.mine")}</Button>}
      </div>
    </Modal>
  );
}

function ConflictSide({ label, text, tone }: { label: string; text: string; tone: "accent" | "neutral" }) {
  return (
    <div className={cn("min-w-0 rounded-md px-2.5 py-2", tone === "accent" ? "bg-accent-soft/60" : "bg-panel")}>
      <div className="mb-1 text-[11px] font-semibold text-muted">{label}</div>
      <div className="whitespace-pre-wrap break-words">{text || <span className="text-muted">{t("canvas.deletedText")}</span>}</div>
    </div>
  );
}

/** §4.4 409 canvas_base_expired: mine and the current body side by side. */
export function ExpiredDialog({ controller, saver, head, canOverwrite, onClose }: {
  controller: AppController;
  saver: CanvasSaver<SavedDoc>;
  head: SavedDoc;
  canOverwrite: boolean;
  onClose: () => void;
}) {
  const store = controller.store;
  const names = (text: string) => mentionsToNames(stripTaskMarkers(text), store.users, store.groups);
  return (
    <Modal title={t("canvas.expiredTitle")} description={t("canvas.expiredDescription")} onClose={onClose} className="w-[760px]">
      <div className="mt-4 grid max-h-[50dvh] gap-2 overflow-y-auto text-[13px] md:grid-cols-2">
        <ConflictSide label={t("canvas.myText")} text={names(saver.text)} tone="accent" />
        <ConflictSide label={t("canvas.currentText")} text={names(head.body)} tone="neutral" />
      </div>
      <div className="mt-4 flex flex-wrap justify-end gap-2">
        <Button variant="secondary" onClick={() => void controller.copyMessageText(stripTaskMarkers(saver.text))}><Copy size={14} /> {t("canvas.copyMyText")}</Button>
        <Button variant="secondary" onClick={() => { onClose(); void saver.resolveExpired("theirs"); }}>{t("canvas.useCurrent")}</Button>
        {canOverwrite && <Button onClick={() => { onClose(); void saver.resolveExpired("mine"); }}>{t("canvas.overwriteMine")}</Button>}
      </div>
    </Modal>
  );
}
