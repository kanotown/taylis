import { useEffect, useState } from "react";

import type { MessageRevisionOut } from "../api/types";
import type { AppController } from "../state/app";
import type { MessageState } from "../sync/types";
import { fullTimestamp } from "./format";
import { MessageBody } from "./MessageBody";
import { Modal } from "./primitives";

/** 「編集履歴」(M14c): the bodies my edits replaced, oldest first, then the current one. Author only. */
export function RevisionsDialog({ controller, message, onClose }: { controller: AppController; message: MessageState; onClose: () => void }) {
  const store = controller.store;
  const [rows, setRows] = useState<MessageRevisionOut[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    controller.api
      ?.messageRevisions(message.id)
      .then((list) => { if (live) setRows(list); })
      .catch((err: unknown) => { if (live) setError(controller.describe(err)); });
    return () => {
      live = false;
    };
  }, [controller, message.id, message.edited_at]);

  const body = (text: string) => (
    <MessageBody body={text} users={store.users} groups={store.groups} customEmoji={store.customEmoji} controller={controller} className="text-sm" />
  );

  return (
    <Modal onClose={onClose} title="編集履歴" description="以前の版は自分にだけ表示されます。メッセージを削除すると履歴も消えます。" className="w-[560px]">
      <div className="mt-3 max-h-[60vh] space-y-3 overflow-y-auto">
        {error && <p className="rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p>}
        {rows === null && !error && <p className="text-sm text-muted">読み込み中…</p>}
        {rows?.length === 0 && <p className="text-sm text-muted">以前の版は記録されていません (履歴の記録を始める前の編集です)。</p>}
        {rows?.map((row, index) => (
          <div key={`${row.replaced_at}-${index}`} className="rounded-xl border border-line p-3">
            <div className="mb-1 text-xs text-muted">
              {fullTimestamp(row.written_at)} の版 · {fullTimestamp(row.replaced_at)} に編集
            </div>
            {body(row.body)}
          </div>
        ))}
        {rows !== null && (
          <div className="rounded-xl border border-accent/40 bg-accent-soft/40 p-3">
            <div className="mb-1 text-xs text-muted">現在の版{message.edited_at ? ` · ${fullTimestamp(message.edited_at)}` : ""}</div>
            {body(message.body)}
          </div>
        )}
      </div>
    </Modal>
  );
}
