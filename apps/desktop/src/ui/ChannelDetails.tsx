import { Archive, ArchiveRestore, ArrowLeft, AtSign, Hash, Link2, Lock, LogOut, Megaphone, Pencil, UserPlus, Zap } from "lucide-react";
import { type FormEvent, type ReactNode, useState } from "react";

import type { AppController } from "../state/app";
import type { ChannelState, NotificationLevel } from "../sync/types";
import { AiChannelNotice } from "./ai";
import { canEditLinks } from "./ChannelLinks";
import { canMakePublic, notificationChoices, overallLevel } from "./channels";
import { MemberList, useMembers } from "./Dialogs";
import { FeedList } from "./ChannelFeeds";
import { formatMuted } from "./format";
import { channelTitle } from "./MainScreen";
import { Badge, Button, cn, IconButton, Input } from "./primitives";
import { RecurringPostList } from "./RecurringPosts";
import { ChannelWorkflowsDialog } from "./WorkflowViews";
import { t } from "../i18n";
import { canManageChannelByRight } from "./roles";

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
  const canManage = channel.membership?.role === "owner" || canManageChannelByRight(channel, (capability) => controller.can(capability)); // M142
  const canEdit = channel.isMember && !channel.archived;
  const [members, setMembers] = useMembers(controller, channel.id, `${membersVersion}:${channel.member_count}`);
  const [workflowsOpen, setWorkflowsOpen] = useState(false);
  // M35: the conversation's own level (null = follows my overall setting, 「既定 (…)」).
  const ownLevel: NotificationLevel | null = channel.notificationLevel ?? null;
  const overall = overallLevel(controller.store.me ?? controller.me);
  const muteLabel = formatMuted(channel.mutedUntil);
  const title = channelTitle(channel, controller);
  return (
    <section aria-label={isChannel ? t("main.channelInfo") : t("main.conversationInfo")} className="flex min-h-0 w-full min-w-0 flex-col bg-canvas">
      <header className="flex h-[52px] shrink-0 items-center gap-2 border-b border-line px-4">
        <IconButton label={t("common.back")} className="-ml-2 shrink-0" onClick={onClose}>
          <ArrowLeft size={20} />
        </IconButton>
        <span className="text-muted">{isChannel ? (channel.type === "private" ? <Lock size={18} /> : <Hash size={18} />) : <AtSign size={18} />}</span>
        <strong className="min-w-0 truncate text-[15px]">{title.replace(/^#/, "")}</strong>
        {channel.archived && <Badge>{t("channel.archived")}</Badge>}
      </header>
      <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-4 py-4">
        {isChannel && (
          <TextSetting
            label={t("dialogs.topic")}
            value={channel.topic}
            placeholder={t("dialogs.topicPlaceholder")}
            editable={canEdit}
            onSave={(text) => controller.updateTopic(channel.id, text)}
          />
        )}
        {isChannel && (
          <TextSetting
            label={t("workflow.description")}
            value={channel.purpose}
            placeholder={t("details.purposePlaceholder")}
            editable={canEdit}
            onSave={(text) => controller.updatePurpose(channel.id, text)}
          />
        )}
        {channel.isMember && (
          <section>
            <h3 className={HEADING}>{t("settings.section.notifications")}</h3>
            <div role="radiogroup" aria-label={t("settings.section.notifications")} className="mt-1">
              {notificationChoices(overall).map((choice) => (
                <label key={choice.value} className="flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2 text-sm hover:bg-panel">
                  <input
                    type="radio"
                    name={`notify-${channel.id}`}
                    className="h-4 w-4 accent-[var(--accent)]"
                    checked={ownLevel === choice.level}
                    // M35: a level change keeps both mutes (the timed one is sent back as it is, `muted` is left out).
                    onChange={() => void controller.setNotification(channel.id, choice.level, channel.mutedUntil)}
                  />
                  {choice.label}
                </label>
              ))}
            </div>
            <label className="flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2 text-sm hover:bg-panel">
              <input
                type="checkbox"
                role="switch"
                className="h-4 w-4 accent-[var(--accent)]"
                checked={!!channel.muted}
                onChange={(e) => void controller.setNotification(channel.id, ownLevel, channel.mutedUntil, e.target.checked)}
              />
              <span>
                {t("channel.mute")} <span className="ml-1 text-xs text-muted">{t("details.muteNote")}</span>
              </span>
            </label>
            {muteLabel ? (
              <button type="button" className={ROW} onClick={() => void controller.setNotification(channel.id, ownLevel, null)}>{t("channel.unmuteTimed", { until: muteLabel })}</button>
            ) : (
              <button type="button" className={ROW} onClick={() => void controller.setNotification(channel.id, ownLevel, new Date(Date.now() + 8 * 3600_000).toISOString())}>{t("channel.mute8h")}</button>
            )}
          </section>
        )}
        <section>
          <div className="mb-2 flex items-center justify-between gap-2">
            <h3 className={HEADING}>{members ? t("dialogs.membersCount", { count: members.length }) : t("channel.members")}</h3>
            {isChannel && canEdit && (
              <Button size="sm" variant="secondary" onClick={() => onDialog("add-member")}>
                <UserPlus size={14} /> {t("dialogs.addMembers")}
              </Button>
            )}
          </div>
          {/* M65 (docs/AI.md §4): an AI bot among the members. */}
          <div className="mb-2">
            <AiChannelNotice controller={controller} memberIds={members ? members.map((m) => m.user_id) : null} />
          </div>
          <MemberList controller={controller} channel={channel} members={members} onChange={setMembers} />
        </section>
        {isChannel && channel.isMember && (
          <section aria-label={t("recurring.title")}>
            <h3 className={cn(HEADING, "mb-2")}>{t("recurring.title")}</h3>
            <RecurringPostList controller={controller} channel={channel} />
          </section>
        )}
        {isChannel && (
          <section aria-label={t("feeds.title")}>
            <h3 className={cn(HEADING, "mb-2")}>{t("feeds.title")}</h3>
            <FeedList controller={controller} channel={channel} />
          </section>
        )}
        {isChannel && (
          <section aria-label={t("composer.workflow")} className="space-y-0.5">
            <h3 className={cn(HEADING, "mb-1")}>{t("composer.workflow")}</h3>
            <Action icon={<Zap size={16} />} onClick={() => setWorkflowsOpen(true)}>{t("channel.workflowsMenu")}</Action>
            {workflowsOpen && <ChannelWorkflowsDialog controller={controller} channel={channel} manage onClose={() => setWorkflowsOpen(false)} />}
          </section>
        )}
        {isChannel && channel.isMember && (
          <section className="space-y-0.5">
            <h3 className={cn(HEADING, "mb-1")}>{t("settings.title")}</h3>
            {canEditLinks(channel, controller) && <Action icon={<Link2 size={16} />} onClick={() => onDialog("link")}>{t("channel.addLink")}</Action>}
            {canManage && !channel.archived && (
              <Action icon={<Megaphone size={16} />} onClick={() => void controller.setPostingPolicy(channel.id, channel.posting_policy === "owners" ? "everyone" : "owners")}>
                {channel.posting_policy === "owners" ? t("channel.postingEveryone") : channel.times_owner_id ? t("channel.postingTimesOwner") : t("channel.postingOwners")}
              </Action>
            )}
            {canManage && channel.type === "public" && <Action icon={<Lock size={16} />} onClick={() => onDialog("convert")}>{t("channel.convertToPrivate")}</Action>}
            {canMakePublic(channel, controller.isAdmin) && <Action icon={<Hash size={16} />} onClick={() => onDialog("convert")}>{t("channel.convertToPublic")}</Action>}
            {canManage && !channel.archived && <Action icon={<Pencil size={16} />} onClick={() => onDialog("rename")}>{t("details.renameMenu")}</Action>}
            {canManage && !channel.archived && <Action icon={<Archive size={16} />} danger onClick={() => onDialog("archive")}>{t("details.archiveMenu")}</Action>}
            {canManage && channel.archived && <Action icon={<ArchiveRestore size={16} />} onClick={() => void controller.unarchiveChannel(channel.id)}>{t("channel.unarchive")}</Action>}
            <Action icon={<LogOut size={16} />} danger onClick={() => onDialog("leave")}>{t("details.leaveMenu")}</Action>
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
          <Button variant="link" size="sm" aria-label={t("details.editField", { label })} onClick={() => setDraft(value ?? "")}>
            {t("canvas.edit")}
          </Button>
        )}
      </div>
      {draft === null ? (
        value ? <p className="mt-1 whitespace-pre-wrap break-words text-sm text-ink">{value}</p> : <p className="mt-1 text-sm text-muted">{t("settings.notifications.notSet")}</p>
      ) : (
        <form className="mt-2" onSubmit={(e) => void save(e)}>
          <Input aria-label={label} value={draft} maxLength={250} autoFocus placeholder={placeholder} onChange={(e) => setDraft(e.target.value)} />
          <div className="mt-2 flex justify-end gap-2">
            <Button type="button" variant="secondary" size="sm" onClick={() => setDraft(null)}>{t("common.cancel")}</Button>
            <Button type="submit" size="sm" disabled={busy}>{t("common.save")}</Button>
          </div>
        </form>
      )}
    </section>
  );
}
