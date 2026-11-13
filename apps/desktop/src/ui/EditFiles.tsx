/**
 * M186 (docs/CHANNEL_FILES.md §7.6): the files in the inline edit box. The message's files with × (taken off on save,
 * a 「削除されたファイル」 too), 「ファイルを追加」 (the composer's file picker), and pasted or dropped files. A new file is
 * uploaded at once as the composer does (the count and each size checked before any byte is read, then one at a time);
 * while one is going up 保存 waits. A failed upload stays as a tile: × takes it away, 「もう一度」 uploads it again.
 * Cancelling leaves the uploads to the server's GC (24 hours).
 */
import { FileText, Loader2, Paperclip, Trash2, TriangleAlert, Upload, X } from "lucide-react";
import { type DragEvent, useRef, useState } from "react";

import type { AttachmentOut } from "../api/types";
import { describeError, NetworkError } from "../api/errors";
import type { AppController } from "../state/app";
import { postedView } from "../drive/channelFiles";
import { ATTACHMENT_MAX_BYTES, forEachPicked, isPickBusy, refusePicked, takePicked } from "../platform/pickedFiles";
import { isFileDrag } from "../platform/fileDrops";
import { PendingTile } from "./Attachments";
import { type EditFile, editFileRoom, editFilesUploading, startEditFiles } from "./editFileList";
import { useFileDropZone } from "./FileDropZone";
import { FileName } from "./FileName";
import { Button } from "./primitives";
import { t } from "../i18n";

export interface EditFiles {
  files: readonly EditFile[];
  /** Picked (`picked`: the input's files, released after the last copy), pasted or dropped files. */
  add: (files: File[], picked?: { release: () => void }) => Promise<void>;
  remove: (key: string) => void;
  retry: (key: string) => void;
}

let lastKey = 0;
const newKey = () => `new:${++lastKey}`;

export function useEditFiles(controller: AppController, attachments: readonly AttachmentOut[] | undefined): EditFiles {
  const [files, setFiles] = useState<EditFile[]>(() => startEditFiles(attachments));
  // The list as it is now, between renders too: two picks in a row count each other's files against the limit.
  const list = useRef(files);
  const update = (change: (items: EditFile[]) => EditFile[]) => {
    list.current = change(list.current);
    setFiles(list.current);
  };
  const settle = (key: string, next: EditFile) => update((items) => items.map((item) => (item.key === key ? next : item)));
  const upload = async (key: string, file: File) => {
    const api = controller.api;
    try {
      if (!api) throw new NetworkError("signed out");
      settle(key, { key, state: "added", attachment: await api.uploadAttachment(file, file.name) });
    } catch (error) {
      settle(key, { key, state: "failed", file, error: describeError(error) });
      controller.setError(error);
    }
  };
  const add = async (all: File[], picked?: { release: () => void }) => {
    const release = picked?.release ?? (() => {});
    if (!controller.api || all.length === 0) { release(); return; }
    // The composer's limits and wording (「添付は10件までです」, 「〈名前〉は大きすぎます」); the message's own files count.
    const refusal = refusePicked(all, { maxFiles: editFileRoom(list.current), maxBytes: controller.store.attachmentMaxBytes ?? ATTACHMENT_MAX_BYTES });
    if (refusal) { release(); controller.setError(refusal); return; }
    const tiles = all.map((file) => ({ key: newKey(), state: "uploading" as const, file }));
    update((items) => [...items, ...tiles]);
    if (!picked) {
      for (const tile of tiles) await upload(tile.key, tile.file);
      return;
    }
    // A picked file is copied into memory before it goes up (platform/pickedFiles.ts); the copy is what a retry sends.
    let next = 0;
    await forEachPicked(all, (copy) => upload(tiles[next++]!.key, copy), release, (error, file) => {
      const tile = tiles[next++]!;
      settle(tile.key, { key: tile.key, state: "failed", file, error: describeError(error) });
      controller.setError(error);
    });
  };
  const remove = (key: string) => update((items) => items.filter((item) => item.key !== key || item.state === "uploading"));
  const retry = (key: string) => {
    const item = list.current.find((candidate) => candidate.key === key);
    if (item?.state !== "failed") return;
    settle(key, { key, state: "uploading", file: item.file });
    void upload(key, item.file);
  };
  return { files, add, remove, retry };
}

/** The tiles under the text (nothing when the message has no files and none was added). */
export function EditFileTiles({ controller, state }: { controller: AppController; state: EditFiles }) {
  if (state.files.length === 0) return null;
  return (
    <div className="pt-2">
      <ul data-edit-files="" aria-label={t("timeline.editFiles")} className="flex flex-wrap gap-2.5 px-1 pb-1 pt-1.5">
        {state.files.map((file) => (
          <li key={file.key} data-edit-file={file.state}>
            <EditFileTile controller={controller} file={file} onRemove={() => state.remove(file.key)} onRetry={() => state.retry(file.key)} />
          </li>
        ))}
      </ul>
      {editFilesUploading(state.files) && (
        <div role="status" className="flex items-center gap-2 px-1 pt-1 text-xs text-muted">
          <Loader2 size={12} className="animate-spin" /> {t("timeline.editUploading")}
        </div>
      )}
    </div>
  );
}

const TILE = "flex h-16 w-16 flex-col items-center justify-center gap-0.5 overflow-hidden rounded-lg border text-muted";
const TILE_NAME = "w-full px-1 text-center text-[9px] leading-tight";

function EditFileTile({ controller, file, onRemove, onRetry }: { controller: AppController; file: EditFile; onRemove: () => void; onRetry: () => void }) {
  if (file.state === "uploading") {
    return (
      <span role="status" aria-label={`${t("attach.uploading")}: ${file.file.name}`} className={`${TILE} border-line bg-panel`}>
        <Loader2 size={18} className="shrink-0 animate-spin" />
        <FileName name={file.file.name} stacked className={TILE_NAME} />
      </span>
    );
  }
  if (file.state === "failed") {
    return (
      <div className="relative">
        <button
          type="button"
          title={`${file.file.name}: ${file.error}`}
          aria-label={t("timeline.editRetryName", { name: file.file.name })}
          className={`${TILE} border-danger/60 bg-danger/5 text-danger hover:border-danger`}
          onClick={onRetry}
        >
          <TriangleAlert size={15} className="shrink-0" />
          <FileName name={file.file.name} className={`${TILE_NAME} truncate`} />
          <span className="text-[10px] font-medium underline">{t("timeline.editRetry")}</span>
        </button>
        <RemoveButton name={file.file.name} onClick={onRemove} />
      </div>
    );
  }
  const attachment = file.attachment;
  const view = postedView(attachment);
  if (view === "gone") {
    // CF2: a posted file in the drive's trash or deleted for good shows nothing of itself.
    return (
      <div className="relative">
        <div title={t("channelFiles.removed")} className={`${TILE} border-dashed border-line`}>
          <Trash2 size={16} className="shrink-0" aria-hidden />
          {/* Its own line break (「削除された / ファイル」): the tile is narrower than the words. */}
          <span className={`${TILE_NAME} whitespace-pre-line`}>{t("timeline.editRemovedTile")}</span>
        </div>
        <RemoveButton name={t("channelFiles.removed")} onClick={onRemove} />
      </div>
    );
  }
  if (view === "moved") {
    // Moved to another place in the drive: its name only (its picture is read from there, which may not be allowed).
    return (
      <div className="relative">
        <div title={attachment.filename} className={`${TILE} border-line bg-panel`}>
          <FileText size={18} className="shrink-0" aria-hidden />
          <FileName name={attachment.filename} stacked className={TILE_NAME} />
        </div>
        <RemoveButton name={attachment.filename} onClick={onRemove} />
      </div>
    );
  }
  return <PendingTile item={attachment} controller={controller} onRemove={onRemove} removeLabel={t("timeline.editRemoveName", { name: attachment.filename })} removeTitle={t("timeline.editRemove")} />;
}

function RemoveButton({ name, onClick }: { name: string; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={t("timeline.editRemoveName", { name })}
      title={t("timeline.editRemove")}
      className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-ink/80 text-canvas shadow hover:bg-danger"
      onClick={onClick}
    >
      <X size={12} />
    </button>
  );
}

/** 「ファイルを追加」: the composer's file picker (any file; photos too). */
export function EditAddFilesButton({ controller, state }: { controller: AppController; state: EditFiles }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        className="shrink-0 gap-1 text-muted hover:text-ink"
        onClick={() => {
          // The files picked on it last are still being read: a new pick would replace them.
          if (isPickBusy(input.current)) { controller.setError(t("composer.stillReading")); return; }
          input.current?.click();
        }}
      >
        <Paperclip size={14} /> {t("timeline.editAddFiles")}
      </Button>
      <input
        ref={input}
        type="file"
        multiple
        hidden
        aria-label={t("timeline.editAddFiles")}
        onChange={(event) => {
          const picked = takePicked(event.target);
          void state.add(picked.files, picked);
        }}
      />
    </>
  );
}

/**
 * Files dropped on the edit box go to it, not to the composer: its drag events stop here, so the pane's frame
 * (「#general に添付」) goes away while the pointer is over the box and the box shows its own.
 */
export function useEditFileDrop(state: EditFiles) {
  const { active, handlers } = useFileDropZone({ enabled: true, blocked: null, onFiles: (files) => void state.add(files) });
  const own = (handler: (event: DragEvent) => void) => (event: DragEvent) => {
    handler(event);
    if (isFileDrag(event)) event.stopPropagation();
  };
  return {
    active,
    handlers: { onDragEnter: own(handlers.onDragEnter), onDragOver: own(handlers.onDragOver), onDragLeave: own(handlers.onDragLeave), onDrop: own(handlers.onDrop) },
  };
}

export function EditDropOverlay({ active }: { active: boolean }) {
  if (!active) return null;
  return (
    <div data-edit-drop="" aria-hidden className="pointer-events-none absolute inset-0 z-[3] flex items-center justify-center rounded-lg border-2 border-dashed border-accent bg-accent-soft/80 text-sm font-medium text-accent">
      <Upload size={16} className="mr-1.5" /> {t("timeline.editDropHere")}
    </div>
  );
}
