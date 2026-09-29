import { Archive, ArchiveRestore, ArrowLeft, AtSign, Hash, Link2, Lock, LogOut, Megaphone, Pencil, UserPlus } from "lucide-react";
import { type FormEvent, type ReactNode, useState } from "react";

import type { AppController } from "../state/app";
import type { ChannelState, NotificationLevel } from "../sync/types";
import { canEditLinks } from "./ChannelLinks";
import { MemberList, useMembers } from "./Dialogs";
import { formatMuted } from "./format";
import { channelTitle } from "./MainScreen";
import { Badge, Button, cn, IconButton, Input } from "./primitives";

/** What the details page asks MainScreen to open (the existing dialogs). */
export type DetailsDialog = "rename" | "archive" | "leave" | "convert" | "link" | "add-member";

const HEADING = "text-xs font-semibold text-muted";
const ROW = "flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm transition-colors hover:bg-panel";

/**
 * M29: a conversation's details as one full-screen page on a phone (Slack): topic, purpose, notifications, members and
 * the channel's settings, which the wide layout keeps in separate dialogs and the ⋯ menu. The conversation stays
 * mounted under it; 「戻る」 (← or the browser's back) returns to it.
 */
export function ChannelDetails({ controller, channel, onClose, onDialog, membersVersion }: {
  controller: AppController;
  channel: ChannelState;
  onClose: () => void;
  onDialog: (dialog: DetailsDialog) => void;
  /** Bumped when a dialog opened from here may have changed the members (added someone). */
  membersVersion: number;
}) {
  const isChannel = channel.type === "public" || channel.type === "private";
  const canManage = controller.isAdmin || channel.membership?.role === "owner";
  const canEdit = channel.isMember && !channel.archived;
  const [members, setMembers] = useMembers(controller, channel.id, `${membersVersion}:${channel.member_count}`);
  const level: NotificationLevel = channel.notificationLevel ?? (isChannel ? "mentions" : "all");
  const muteLabel = formatMuted(channel.mutedUntil);
  const title = channelTitle(channel, controller);
  return (
    <section aria-label={isChannel ? "チャンネル情報" : "会話の情報"} className="flex min-h-0 w-full min-w-0 flex-col bg-canvas">
      <header className="flex h-[52px] shrink-0 items-center gap-2 border-b border-line px-4">
        <IconButton label="戻る" className="-ml-2 shrink-0" onClick={onClose}>
          <ArrowLeft size={20} />
        </IconButton>
        <span className="text-muted">{isChannel ? (channel.type === "private" ? <Lock size={18} /> : <Hash size={18} />) : <AtSign size={18} />}</span>
        <strong className="min-w-0 truncate text-[15px]">{title.replace(/^#/, "")}</strong>
        {channel.archived && <Badge>アーカイブ済み</Badge>}
      </header>
      <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-4 py-4">
        {isChannel && (
          <TextSetting
            label="トピック"
            value={channel.topic}
            placeholder="例: 週次の進捗共有"
            editable={canEdit}
            onSave={(text) => controller.updateTopic(channel.id, text)}
          />
        )}
        {isChannel && (
          <TextSetting
            label="説明"
            value={channel.purpose}
            placeholder="例: デザインレビューの依頼と結果を共有する"
            editable={canEdit}
            onSave={(text) => controller.updatePurpose(channel.id, text)}
          />
        )}
        {channel.isMember && (
          <section>
            <h3 className={HEADING}>通知</h3>
            <div role="radiogroup" aria-label="通知" className="mt-1">
              {([["all", "すべてのメッセージ"], ["mentions", "メンションのみ"], ["none", "通知しない"]] as const).map(([value, label]) => (
                <label key={value} className="flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2 text-sm hover:bg-panel">
                  <input
                    type="radio"
                    name={`notify-${channel.id}`}
                    className="h-4 w-4 accent-[var(--accent)]"
                    checked={level === value}
                    onChange={() => void controller.setNotification(channel.id, value, null)}
                  />
                  {label}
                </label>
              ))}
            </div>
            {muteLabel ? (
              <button type="button" className={ROW} onClick={() => void controller.setNotification(channel.id, level, null)}>ミュート解除 ({muteLabel})</button>
            ) : (
              <button type="button" className={ROW} onClick={() => void controller.setNotification(channel.id, level, new Date(Date.now() + 8 * 3600_000).toISOString())}>8 時間ミュート</button>
            )}
          </section>
        )}
        <section>
          <div className="mb-2 flex items-center justify-between gap-2">
            <h3 className={HEADING}>メンバー{members ? ` (${members.length})` : ""}</h3>
            {isChannel && canEdit && (
              <Button size="sm" variant="secondary" onClick={() => onDialog("add-member")}>
                <UserPlus size={14} /> メンバーを追加
              </Button>
            )}
          </div>
          <MemberList controller={controller} channel={channel} members={members} onChange={setMembers} />
        </section>
        {isChannel && channel.isMember && (
          <section className="space-y-0.5">
            <h3 className={cn(HEADING, "mb-1")}>設定</h3>
            {canEditLinks(channel, controller) && <Action icon={<Link2 size={16} />} onClick={() => onDialog("link")}>リンクを追加…</Action>}
            {canManage && !channel.archived && (
              <Action icon={<Megaphone size={16} />} onClick={() => void controller.setPostingPolicy(channel.id, channel.posting_policy === "owners" ? "everyone" : "owners")}>
                {channel.posting_policy === "owners" ? "誰でも投稿できるようにする" : channel.times_owner_id ? "他の人はスレッドでだけ返信できるようにする" : "投稿をオーナーと管理者に限る"}
              </Action>
            )}
            {canManage && channel.type === "public" && <Action icon={<Lock size={16} />} onClick={() => onDialog("convert")}>非公開チャンネルに変換…</Action>}
            {controller.isAdmin && channel.type === "private" && <Action icon={<Hash size={16} />} onClick={() => onDialog("convert")}>公開チャンネルに変換…</Action>}
            {canManage && !channel.archived && <Action icon={<Pencil size={16} />} onClick={() => onDialog("rename")}>名前を変更…</Action>}
            {canManage && !channel.archived && <Action icon={<Archive size={16} />} danger onClick={() => onDialog("archive")}>アーカイブ…</Action>}
            {canManage && channel.archived && <Action icon={<ArchiveRestore size={16} />} onClick={() => void controller.unarchiveChannel(channel.id)}>アーカイブを解除</Action>}
            <Action icon={<LogOut size={16} />} danger onClick={() => onDialog("leave")}>チャンネルを退出…</Action>
          </section>
        )}
      </div>
    </section>
  );
}

function Action({ icon, danger = false, onClick, children }: { icon: ReactNode; danger?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" className={cn(ROW, danger && "text-danger")} onClick={onClick}>
      <span className={cn("shrink-0", !danger && "text-muted")}>{icon}</span>
      {children}
    </button>
  );
}

/** A one-line text of the channel (topic, purpose), edited in place. */
function TextSetting({ label, value, placeholder, editable, onSave }: {
  label: string;
  value: string | null | undefined;
  placeholder: string;
  editable: boolean;
  onSave: (text: string) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (draft === null) return;
    setBusy(true);
    const ok = await onSave(draft);
    setBusy(false);
    if (ok) setDraft(null);
  };
  return (
    <section>
      <div className="flex items-center justify-between gap-2">
        <h3 className={HEADING}>{label}</h3>
        {editable && draft === null && (
          <Button variant="link" size="sm" aria-label={`${label}を編集`} onClick={() => setDraft(value ?? "")}>
            編集
          </Button>
        )}
      </div>
      {draft === null ? (
        value ? <p className="mt-1 whitespace-pre-wrap break-words text-sm text-ink">{value}</p> : <p className="mt-1 text-sm text-muted">未設定</p>
      ) : (
        <form className="mt-2" onSubmit={(e) => void save(e)}>
          <Input aria-label={label} value={draft} maxLength={250} autoFocus placeholder={placeholder} onChange={(e) => setDraft(e.target.value)} />
          <div className="mt-2 flex justify-end gap-2">
            <Button type="button" variant="secondary" size="sm" onClick={() => setDraft(null)}>キャンセル</Button>
            <Button type="submit" size="sm" disabled={busy}>保存</Button>
          </div>
        </form>
      )}
    </section>
  );
}
