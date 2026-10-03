import { Eye, UsersRound } from "lucide-react";
import { useEffect, useState } from "react";

import type { AdminWorkspaceSettingsOut, WorkspaceSettingsUpdate } from "../api/types";
import type { AppController } from "../state/app";
import { fullTimestamp } from "./format";
import { cn } from "./primitives";

const CARD = "flex items-center gap-3 rounded-xl border border-line px-3 py-2";

/**
 * Administration → 設定 (M88, docs/MEMBERSHIP.md §3): the workspace-wide switches. Each one saves when flipped (PATCH
 * /admin/workspace-settings); every device follows through workspace.settings_updated. A server before M88 answers 404:
 * the tab says so instead of showing switches that would do nothing.
 */
export function WorkspaceSettingsTab({ controller }: { controller: AppController }) {
  const [settings, setSettings] = useState<AdminWorkspaceSettingsOut | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const api = controller.api;
    if (!api) return;
    let cancelled = false;
    api.adminWorkspaceSettings().then(
      (row) => {
        if (!cancelled) setSettings(row);
      },
      (error: unknown) => {
        if (cancelled) return;
        if ((error as { status?: number }).status === 404) setUnsupported(true);
        else controller.setError(error);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [controller.api]);

  const save = async (patch: WorkspaceSettingsUpdate) => {
    const api = controller.api;
    if (!api || !settings || busy) return;
    const before = settings;
    setSettings({ ...settings, ...patch } as AdminWorkspaceSettingsOut); // at once; put back when refused
    setBusy(true);
    try {
      setSettings(await api.adminUpdateWorkspaceSettings(patch));
    } catch (error) {
      setSettings(before);
      controller.setError(error);
    } finally {
      setBusy(false);
    }
  };

  if (unsupported) return <p className="mt-4 text-sm text-muted">このサーバはワークスペースの設定に対応していません。</p>;
  if (!settings) return <p role="status" className="mt-6 text-center text-sm text-muted">読み込み中…</p>;
  const changedBy = settings.updated_by ? controller.store.users.get(settings.updated_by)?.display_name : null;
  return (
    <div className="mt-4 space-y-3">
      <label className={cn(CARD, "cursor-pointer")}>
        <UsersRound size={18} className="shrink-0 text-muted" />
        <span className="min-w-0 flex-1 text-sm">
          参加・退出の表示
          <span className="block text-xs text-muted">チャンネルに参加・退出・追加・除外したとき「〇〇 が参加しました」のような一言を表示します (公開・非公開チャンネル。DM には出ません)。オフにしても、これまでの表示は残ります。未読や通知にはなりません。</span>
        </span>
        <input
          type="checkbox"
          role="switch"
          aria-label="参加・退出の表示"
          className="h-4 w-4 accent-[var(--accent)]"
          disabled={busy}
          checked={settings.show_membership_messages}
          onChange={(e) => void save({ show_membership_messages: e.target.checked })}
        />
      </label>
      <label className={cn(CARD, "cursor-pointer")}>
        <Eye size={18} className="shrink-0 text-muted" />
        <span className="min-w-0 flex-1 text-sm">
          参加前にチャンネルの中を見られる
          <span className="block text-xs text-muted">オン: 参加していない公開チャンネルのメッセージを読めます (プレビュー)。オフ: 名前・説明・人数だけが見え、メッセージ・スレッド・ファイルは参加してから読めます。検索にも参加しているチャンネルだけが出ます。管理者も同じです。</span>
        </span>
        <input
          type="checkbox"
          role="switch"
          aria-label="参加前にチャンネルの中を見られる"
          className="h-4 w-4 accent-[var(--accent)]"
          disabled={busy}
          checked={settings.preview_before_join}
          onChange={(e) => void save({ preview_before_join: e.target.checked })}
        />
      </label>
      {settings.updated_at && changedBy && (
        <p className="text-xs text-muted">
          最終変更: {changedBy} ({fullTimestamp(settings.updated_at)})
        </p>
      )}
    </div>
  );
}
