/**
 * M44 (CANVAS.md §4.9): a canvas's history. The versions newest first (who, when, lines added / removed, the name given
 * to it); one of them compared with the version before it or with the current one (lines added and removed, and the
 * words of a line only touched up), or shown as it was. A version can be made the current one again (a new version:
 * nothing is lost), named (「提出版」), and — by the conversation's owners and administrators, in a DM its creator — have
 * its body erased (a secret pasted by mistake; the server audits it). Everyone who reads the canvas reads its history.
 */
import { ArrowLeft, Eraser, History, Loader2, RotateCcw, Tag } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import type { CanvasMeta, CanvasRevisionMeta } from "../api/types";
import type { AppController } from "../state/app";
import { Avatar } from "./Avatar";
import { CanvasBody } from "./CanvasBody";
import type { CanvasRights } from "./canvasAccess";
import { stripTaskMarkers } from "./canvasMarkers";
import { type DiffLine, type DiffRow, diffCounts, diffLines, diffRows } from "./canvasDiff";
import { useCompact } from "./compact";
import { fullTimestamp } from "./format";
import { mentionsToNames } from "./mentions";
import { Badge, Button, cn, Input, Modal } from "./primitives";

const KIND_LABELS: Record<CanvasRevisionMeta["kind"], string> = {
  create: "作成",
  save: "編集",
  merge: "同時編集をまとめた版",
  side: "送信した版",
  restore: "復元",
  erased: "本文を消去",
  task: "タスクと連動", // M80 (§22): the server ticked an item, or tied it to a task
};

type View = "previous" | "current" | "body";

export function CanvasHistoryDialog({ controller, canvas, rights, onClose }: {
  controller: AppController;
  canvas: CanvasMeta;
  rights: CanvasRights;
  onClose: () => void;
}) {
  const compact = useCompact();
  const [items, setItems] = useState<CanvasRevisionMeta[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [view, setView] = useState<View>("previous");
  const [bodies, setBodies] = useState<Record<string, string>>({});
  const [confirm, setConfirm] = useState<{ kind: "restore" | "erase"; revision: CanvasRevisionMeta } | null>(null);
  const [labelling, setLabelling] = useState<CanvasRevisionMeta | null>(null);
  const [busy, setBusy] = useState(false);
  const headId = canvas.head_rev_id;

  const load = async (more: boolean) => {
    const page = await controller.canvasRevisions(canvas.id, more ? cursor : null);
    if (!page) return;
    setItems((current) => (more && current ? [...current, ...page.items] : page.items));
    setCursor(page.next_cursor);
    if (!more && !compact) setSelectedId((id) => id ?? page.items[0]?.id ?? null);
  };
  // Read again when the canvas gets a new version (a restore here, someone's save meanwhile).
  useEffect(() => {
    void load(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controller, canvas.id, headId]);

  const list = items ?? [];
  const index = list.findIndex((r) => r.id === selectedId);
  const selected = index >= 0 ? list[index]! : null;
  // "The version before": the next older one listed (its parent for the oldest loaded one; none for the first).
  const previousId = selected ? (list[index + 1]?.id ?? (selected.kind === "create" ? null : selected.parent_rev_id)) : null;
  const otherId = view === "current" ? headId : view === "previous" ? previousId : null;

  const body = async (revisionId: string): Promise<void> => {
    if (bodies[revisionId] !== undefined) return;
    const revision = await controller.canvasRevision(canvas.id, revisionId);
    if (revision) setBodies((current) => ({ ...current, [revisionId]: revision.body }));
  };
  useEffect(() => {
    if (!selected || selected.kind === "erased") return;
    void body(selected.id);
    if (otherId) void body(otherId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id, selected?.kind, otherId]);

  const names = (text: string) => mentionsToNames(stripTaskMarkers(text), controller.store.users, controller.store.groups); // M80: markers hidden
  const selectedBody = selected ? bodies[selected.id] : undefined;
  const otherBody = otherId ? bodies[otherId] : view === "previous" ? "" : undefined;
  const rows = useMemo<DiffRow[] | null>(() => {
    if (view === "body" || selectedBody === undefined || otherBody === undefined) return null;
    // Previous → this version; this version → the current one.
    const [from, to] = view === "previous" ? [otherBody, selectedBody] : [selectedBody, otherBody];
    return diffRows(diffLines(names(from), names(to)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, selectedBody, otherBody]);

  const restore = async (revision: CanvasRevisionMeta) => {
    setBusy(true);
    const restored = await controller.restoreCanvasRevision(canvas.id, revision.id);
    setBusy(false);
    setConfirm(null);
    if (!restored) return;
    controller.setNotice("この版を復元しました");
    setSelectedId(restored.head_rev_id);
    setView("previous");
  };
  const erase = async (revision: CanvasRevisionMeta) => {
    setBusy(true);
    const erased = await controller.eraseCanvasRevision(canvas.id, revision.id);
    setBusy(false);
    setConfirm(null);
    if (!erased) return;
    setItems((current) => current?.map((r) => (r.id === erased.id ? erased : r)) ?? null);
    setBodies(({ [revision.id]: _gone, ...rest }) => rest);
  };
  const saveLabel = async (revision: CanvasRevisionMeta, label: string | null) => {
    setBusy(true);
    const named = await controller.labelCanvasRevision(canvas.id, revision.id, label);
    setBusy(false);
    if (!named) return;
    setLabelling(null);
    setItems((current) => current?.map((r) => (r.id === named.id ? named : r)) ?? null);
  };

  const showList = !compact || !selected;
  const showDetail = !compact || !!selected;
  return (
    <Modal title={`履歴: ${canvas.title}`} description="版を選ぶと、前の版や現在の版との違いを見られます。" onClose={onClose} className="flex h-[85dvh] w-[1000px] flex-col overflow-hidden max-md:h-[92dvh]">
      <div className="mt-3 flex min-h-0 flex-1 gap-3 max-md:flex-col">
        {showList && (
          <ul aria-label="版の一覧" className="min-h-0 w-72 shrink-0 space-y-0.5 overflow-y-auto border-r border-line pr-2 max-md:w-full max-md:border-r-0 max-md:pr-0">
            {items === null && <li className="py-6 text-center text-sm text-muted"><Loader2 size={16} className="mx-auto animate-spin" /></li>}
            {list.map((revision) => (
              <li key={revision.id}>
                <RevisionRow controller={controller} revision={revision} head={revision.id === headId} selected={revision.id === selectedId} onSelect={() => setSelectedId(revision.id)} />
              </li>
            ))}
            {cursor && (
              <li className="py-2 text-center">
                <Button size="sm" variant="secondary" onClick={() => void load(true)}>さらに読み込む</Button>
              </li>
            )}
          </ul>
        )}
        {showDetail && (
          <section aria-label="版の内容" className="flex min-h-0 min-w-0 flex-1 flex-col">
            {!selected ? (
              <div className="flex flex-1 items-center justify-center text-sm text-muted"><History size={16} className="mr-2" /> 版を選んでください</div>
            ) : (
              <>
                <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line pb-2">
                  {compact && (
                    <Button size="sm" variant="ghost" onClick={() => setSelectedId(null)} aria-label="版の一覧に戻る"><ArrowLeft size={15} /></Button>
                  )}
                  <div role="tablist" aria-label="表示" className="flex rounded-lg bg-panel-2 p-0.5 text-xs font-medium">
                    {([["previous", "前の版との差分"], ["current", "現在の版との差分"], ["body", "この版の本文"]] as Array<[View, string]>).map(([value, label]) => (
                      <button key={value} type="button" role="tab" aria-selected={view === value} onClick={() => setView(value)} className={cn("rounded-md px-2.5 py-1 transition-colors", view === value ? "bg-canvas text-ink shadow-sm" : "text-muted hover:text-ink")}>
                        {label}
                      </button>
                    ))}
                  </div>
                  <div className="flex-1" />
                  {selected.kind !== "erased" && rights.edit && (
                    <Button size="sm" variant="secondary" onClick={() => setLabelling(selected)}><Tag size={13} /> {selected.label ? "名前を変更" : "名前を付ける"}</Button>
                  )}
                  {selected.kind !== "erased" && rights.erase && selected.id !== headId && (
                    <Button size="sm" variant="secondary" className="text-danger" onClick={() => setConfirm({ kind: "erase", revision: selected })}><Eraser size={13} /> 本文を消去</Button>
                  )}
                  {selected.kind !== "erased" && rights.edit && selected.id !== headId && (
                    <Button size="sm" onClick={() => setConfirm({ kind: "restore", revision: selected })}><RotateCcw size={13} /> この版に戻す</Button>
                  )}
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto pt-3" aria-label={view === "body" ? "この版の本文" : "差分"}>
                  {selected.kind === "erased" ? (
                    <p className="text-sm text-muted">この版の本文は消去されています。</p>
                  ) : view === "current" && selected.id === headId ? (
                    <p className="text-sm text-muted">これが現在の版です。</p>
                  ) : view === "body" ? (
                    selectedBody === undefined ? <Loader2 size={16} className="animate-spin text-muted" /> : <CanvasBody body={selectedBody} controller={controller} onToggleTask={null} />
                  ) : rows === null ? (
                    otherId && list.find((r) => r.id === otherId)?.kind === "erased" ? <p className="text-sm text-muted">比べる版の本文は消去されています。</p> : <Loader2 size={16} className="animate-spin text-muted" />
                  ) : (
                    <DiffView rows={rows} />
                  )}
                </div>
              </>
            )}
          </section>
        )}
      </div>
      {confirm?.kind === "restore" && (
        <Modal title="この版に戻しますか？" description={`${fullTimestamp(confirm.revision.created_at)} の版の本文を、新しい版として保存します。今の本文も履歴に残ります。`} onClose={() => setConfirm(null)}>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setConfirm(null)}>キャンセル</Button>
            <Button disabled={busy} onClick={() => void restore(confirm.revision)}>この版に戻す</Button>
          </div>
        </Modal>
      )}
      {confirm?.kind === "erase" && (
        <Modal title="この版の本文を消去しますか？" description="誤って書いた秘密などを履歴から消します。消した本文は戻せません。消去したことは監査ログに残ります。" onClose={() => setConfirm(null)}>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setConfirm(null)}>キャンセル</Button>
            <Button variant="danger" disabled={busy} onClick={() => void erase(confirm.revision)}>消去する</Button>
          </div>
        </Modal>
      )}
      {labelling && <LabelDialog revision={labelling} busy={busy} onClose={() => setLabelling(null)} onSave={(label) => void saveLabel(labelling, label)} />}
    </Modal>
  );
}

function RevisionRow({ controller, revision, head, selected, onSelect }: {
  controller: AppController;
  revision: CanvasRevisionMeta;
  head: boolean;
  selected: boolean;
  onSelect: () => void;
}) {
  const author = controller.store.users.get(revision.author_id)?.display_name ?? "メンバー";
  return (
    <button
      type="button"
      aria-current={selected ? "true" : undefined}
      data-revision={revision.id}
      onClick={onSelect}
      className={cn("flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left text-sm", selected ? "bg-accent-soft" : "hover:bg-panel")}
    >
      <Avatar id={revision.author_id} name={author} size={24} className="mt-0.5 rounded-md text-[10px]" />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="truncate font-medium">{author}</span>
          {head && <Badge tone="accent">現在の版</Badge>}
        </span>
        <span className="block text-[11px] text-muted">{fullTimestamp(revision.created_at)} · {KIND_LABELS[revision.kind]}</span>
        <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px]">
          {revision.kind !== "erased" && (revision.lines_added > 0 || revision.lines_removed > 0) && (
            <span aria-label={`${revision.lines_added} 行追加、${revision.lines_removed} 行削除`}>
              <span className="text-success">+{revision.lines_added}</span> <span className="text-danger">−{revision.lines_removed}</span>
            </span>
          )}
          {revision.label && <span className="inline-flex items-center gap-0.5 rounded bg-warning/20 px-1.5 py-px font-medium text-ink"><Tag size={10} /> {revision.label}</span>}
        </span>
      </span>
    </button>
  );
}

/** The comparison: removed lines red, added green, the changed words of a touched-up line marked; kept stretches folded. */
export function DiffView({ rows }: { rows: readonly DiffRow[] }) {
  const counts = diffCounts(rows.filter((r): r is DiffLine => r.kind !== "skip"));
  if (counts.added === 0 && counts.removed === 0) return <p className="text-sm text-muted">違いはありません。</p>;
  return (
    <div className="font-[inherit] text-[13px] leading-6" data-diff="">
      <div className="mb-2 text-xs text-muted">
        <span className="text-success">+{counts.added} 行</span> · <span className="text-danger">−{counts.removed} 行</span>
      </div>
      <div className="overflow-hidden rounded-lg border border-line">
        {rows.map((row, i) =>
          row.kind === "skip" ? (
            <div key={i} className="bg-panel px-3 py-0.5 text-[11px] text-muted">… {row.count} 行 …</div>
          ) : (
            <div
              key={i}
              data-diff-line={row.kind}
              className={cn("flex gap-2 px-2", row.kind === "add" ? "bg-success/12" : row.kind === "del" ? "bg-danger/10" : "")}
            >
              <span aria-hidden className={cn("w-3 shrink-0 select-none text-center", row.kind === "add" ? "text-success" : row.kind === "del" ? "text-danger" : "text-muted")}>
                {row.kind === "add" ? "+" : row.kind === "del" ? "−" : ""}
              </span>
              <span className={cn("min-w-0 flex-1 whitespace-pre-wrap break-words", row.kind === "del" && !row.words && "text-muted line-through decoration-danger/40")}>
                {row.words
                  ? row.words.map((piece, j) =>
                      piece.changed ? (
                        // Not <mark>: its global style (the search highlight) would paint both sides alike.
                        <span key={j} data-changed="" className={cn("rounded-sm px-px text-ink", row.kind === "add" ? "bg-success/35" : "bg-danger/30 line-through")}>{piece.text}</span>
                      ) : (
                        <span key={j}>{piece.text}</span>
                      ),
                    )
                  : row.text || " "}
              </span>
            </div>
          ),
        )}
      </div>
    </div>
  );
}

function LabelDialog({ revision, busy, onClose, onSave }: { revision: CanvasRevisionMeta; busy: boolean; onClose: () => void; onSave: (label: string | null) => void }) {
  const [label, setLabel] = useState(revision.label ?? "");
  return (
    <Modal title="版に名前を付ける" description="「提出版」「ゼミ発表前」のように名前を付けた版は、古くなっても整理されずに残ります。" onClose={onClose}>
      <form className="mt-4 space-y-4" onSubmit={(event) => { event.preventDefault(); onSave(label.trim() || null); }}>
        <Input aria-label="版の名前" value={label} maxLength={80} autoFocus placeholder="提出版" onChange={(event) => setLabel(event.target.value)} />
        <div className="flex justify-end gap-2">
          {revision.label && <Button variant="secondary" disabled={busy} onClick={() => onSave(null)}>名前を外す</Button>}
          <Button variant="secondary" onClick={onClose}>キャンセル</Button>
          <Button type="submit" disabled={busy || label.trim() === ""}>保存</Button>
        </div>
      </form>
    </Modal>
  );
}
