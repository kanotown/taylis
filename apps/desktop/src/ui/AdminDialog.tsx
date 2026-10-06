import { Archive, ArchiveRestore, NotebookPen, Pencil } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";

import type { AppController } from "../state/app";
import type { ChannelState } from "../sync/types";
import { AiTab } from "./AiTab";
import { AnalyticsTab } from "./AnalyticsTab";
import { UsersTab } from "./AdminUsersTab";
import { ReportsTab } from "./AdminReportsTab";
import { CanvasTemplatesTab } from "./CanvasTemplatesTab";
import { AdminDocsTab } from "./AdminDocsTab";
import { EmojiAdminTab } from "./customEmoji";
import { GroupsTab } from "./GroupsTab";
import { InvitesTab } from "./InvitesTab";
import { RosterTab } from "./RosterTab";
import { WebhooksTab } from "./WebhooksTab";
import { WorkflowManager } from "./WorkflowViews";
import { WorkspaceSettingsTab } from "./WorkspaceSettingsTab";
import { Badge, Button, cn, Field, Input, Modal, UNDERLINE_TAB, UnderlineTabRow } from "./primitives";
import { t } from "../i18n";

type Tab = "users" | "analytics" |"reports" | "roster" | "groups" | "invites" | "webhooks" | "workflows" | "ai" | "workspace" | "channels" | "emoji" | "canvas-templates" | "docs";

/** Administration (M11e): users (create, role, deactivate, reset password, sessions, anonymize) and channels (rename, archive). */
export function AdminDialog({ controller, onClose }: { controller: AppController; onClose: () => void }) {
  return (
    // One height for every tab (the body scrolls): sized to its content, the dialog jumped and re-centred on each switch.
    <Modal onClose={onClose} title={t("settings.section.admin")} focusDialog className="flex h-[80dvh] w-[760px] flex-col overflow-hidden">
      <AdminBody controller={controller} className="mt-3" />
    </Modal>
  );
}

/**
 * The administration tabs: in the dialog above, and as 「管理」 in the settings (M40: the phone's 「自分」 → 管理 and the
 * wide settings dialog's section), every item as it was.
 */
export function AdminBody({ controller, className }: { controller: AppController; className?: string }) {
  const [tab, setTab] = useState<Tab>("users");
  // M65: 「AI」 only on a server that has the AI routes (GET /ai/status answered; docs/AI.md §5).
  const ai = controller.store.aiStatus !== null;
  // M121: 「ドキュメント」 only on a server with Docs (bootstrap's `wiki`).
  const docs = !!controller.engine?.wiki?.available;
  const shown: Tab = (tab === "ai" && !ai) || (tab === "docs" && !docs) ? "users" : tab;
  return (
    <div className={cn("flex min-h-0 flex-1 flex-col", className)}>
      <UnderlineTabRow role="tablist" aria-label={t("settings.section.admin")} className="gap-1">
        {(
          [
            ["users", t("admin.tab.users")],
            ["analytics", t("admin.tab.analytics")],
            ["reports", t("admin.tab.reports")],
            ["roster", t("admin.tab.roster")],
            ["groups", t("admin.tab.groups")],
            ["invites", t("admin.tab.invites")],
            ["webhooks", "Webhook"],
            ["workflows", t("admin.tab.workflows")],
            ...(ai ? [["ai", "AI"]] : []),
            ["workspace", t("admin.tab.workspace")],
            ["channels", t("admin.tab.channels")],
            ["emoji", t("admin.tab.emoji")],
            ["canvas-templates", t("admin.tab.canvasTemplates")],
            ...(docs ? [["docs", t("nav.docs")]] : []),
          ] as Array<[Tab, string]>
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={shown === value}
            onClick={() => setTab(value)}
            className={cn(UNDERLINE_TAB, "px-3 py-2 max-md:px-2.5", shown === value ? "border-accent text-ink" : "border-transparent text-muted hover:text-ink")}
          >
            {label}
          </button>
        ))}
      </UnderlineTabRow>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {shown === "ai" ? <AiTab controller={controller} /> : shown === "analytics" ? <AnalyticsTab controller={controller} /> : shown === "workspace" ? <WorkspaceSettingsTab controller={controller} /> : shown === "users" ? <UsersTab controller={controller} /> : shown === "reports" ? <ReportsTab controller={controller} /> : shown === "roster" ? <RosterTab controller={controller} /> : shown === "groups" ? <GroupsTab controller={controller} /> : shown === "invites" ? <InvitesTab controller={controller} /> : shown === "webhooks" ? <WebhooksTab controller={controller} /> : shown === "workflows" ? <WorkflowManager controller={controller} /> :shown === "channels" ? <ChannelsTab controller={controller} /> : shown === "canvas-templates" ? <CanvasTemplatesTab controller={controller} /> : shown === "docs" ? <AdminDocsTab controller={controller} /> : <EmojiAdminTab controller={controller} />}
      </div>
    </div>
  );
}

function ChannelsTab({ controller }: { controller: AppController }) {
  const store = controller.store;
  const channels = [...store.channels.values()].filter((c) => c.type === "public" || c.type === "private").sort((a, b) => (a.name ?? "").localeCompare(b.name ?? "", "ja"));
  const [renaming, setRenaming] = useState<ChannelState | null>(null);
  const [name, setName] = useState("");
  const [archiving, setArchiving] = useState<ChannelState | null>(null);
  // M24: whose times a channel is (for channels made before times existed, e.g. a Mattermost import).
  const [marking, setMarking] = useState<ChannelState | null>(null);
  const [timesOwner, setTimesOwner] = useState("");
  const people = [...store.users.values()].filter((u) => !u.deactivated_at && u.role !== "guest" && u.role !== "bot").sort((a, b) => a.display_name.localeCompare(b.display_name, "ja"));
  const [busy, setBusy] = useState(false);

  const rename = async (event: FormEvent) => {
    event.preventDefault();
    if (!renaming) return;
    setBusy(true);
    const ok = await controller.renameChannel(renaming.id, name);
    setBusy(false);
    if (ok) setRenaming(null);
  };

  return (
    <div className="mt-4 space-y-3">
      <p className="text-xs text-muted">{t("admin.channels.note")}</p>
      <ul className="divide-y divide-line rounded-xl border border-line">
        {channels.map((channel) => (
          <li key={channel.id} className={cn("flex items-center gap-3 px-3 py-2 text-sm", channel.archived && "opacity-60")}>
            <span className="text-muted">{channel.type === "private" ? "🔒" : "#"}</span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="truncate font-medium">{channel.name}</span>
                {channel.archived && <Badge>{t("channel.archived")}</Badge>}
                {!channel.isMember && <Badge>{t("admin.channels.notJoined")}</Badge>}
                {channel.times_owner_id && <Badge tone="accent">{t("admin.channels.timesOf", { name: store.users.get(channel.times_owner_id)?.display_name ?? "?" })}</Badge>}
              </div>
              {channel.topic && <div className="truncate text-xs text-muted">{channel.topic}</div>}
            </div>
            {channel.archived && (
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => { setBusy(true); void controller.unarchiveChannel(channel.id).then(() => setBusy(false)); }}>
                <ArchiveRestore size={14} /> {t("channel.unarchive")}
              </Button>
            )}
            {!channel.archived && (
              <div className="flex items-center gap-1">
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => { setRenaming(channel); setName(channel.name ?? ""); }}>
                  <Pencil size={14} /> {t("channel.rename")}
                </Button>
                <Button size="sm" variant="ghost" disabled={busy} title={t("admin.channels.timesTitle")} onClick={() => { setMarking(channel); setTimesOwner(channel.times_owner_id ?? ""); }}>
                  <NotebookPen size={14} /> {channel.times_owner_id ? t("admin.channels.changeTimes") : t("admin.channels.makeTimes")}
                </Button>
                <Button size="sm" variant="ghost" className="text-danger" disabled={busy} onClick={() => setArchiving(channel)}>
                  <Archive size={14} /> {t("channel.archive")}
                </Button>
              </div>
            )}
          </li>
        ))}
        {channels.length === 0 && <li className="px-3 py-6 text-center text-sm text-muted">{t("invites.noChannels")}</li>}
      </ul>
      {marking && (
        <Modal onClose={() => setMarking(null)} title={t("admin.channels.makeTimesTitle", { name: marking.name ?? "" })} className="w-[420px]">
          <form
            className="mt-3 space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              setBusy(true);
              void controller.setTimesOwner(marking.id, timesOwner || null).then((ok) => { setBusy(false); if (ok) setMarking(null); });
            }}
          >
            <p className="text-xs text-muted">{t("admin.channels.timesNote")}</p>
            <Field label={t("admin.channels.timesOwner")}>
              <select value={timesOwner} onChange={(e) => setTimesOwner(e.target.value)} className="h-9 w-full rounded-lg border border-line bg-canvas px-3 text-sm">
                <option value="">{t("admin.channels.notTimes")}</option>
                {people.map((u) => <option key={u.id} value={u.id}>{u.display_name} (@{u.username})</option>)}
              </select>
            </Field>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="secondary" onClick={() => setMarking(null)}>{t("common.cancel")}</Button>
              <Button type="submit" disabled={busy || timesOwner === (marking.times_owner_id ?? "")}>{t("common.save")}</Button>
            </div>
          </form>
        </Modal>
      )}
      {renaming && (
        <Modal onClose={() => setRenaming(null)} title={t("dialogs.renameChannel")} className="w-[440px]">
          <form className="mt-4 space-y-4" onSubmit={rename}>
            <Input value={name} pattern="[a-z0-9][a-z0-9._-]*" maxLength={80} autoFocus required onChange={(e) => setName(e.target.value.toLowerCase())} />
            <div className="flex justify-end gap-2">
              <Button type="button" variant="secondary" onClick={() => setRenaming(null)}>{t("common.cancel")}</Button>
              <Button type="submit" disabled={busy || !name.trim() || name.trim() === renaming.name}>{t("common.save")}</Button>
            </div>
          </form>
        </Modal>
      )}
      {archiving && (
        <ArchiveConfirm channel={archiving} busy={busy} onClose={() => setArchiving(null)} onConfirm={() => { setBusy(true); void controller.archiveChannel(archiving.id).then((ok) => { setBusy(false); if (ok) setArchiving(null); }); }} />
      )}
    </div>
  );
}

export function ArchiveConfirm({ channel, busy, onClose, onConfirm }: { channel: ChannelState; busy: boolean; onClose: () => void; onConfirm: () => void }) {
  return (
    <Modal onClose={onClose} title={t("admin.channels.archiveTitle", { name: channel.name ?? "" })} className="w-[440px]">
      <p className="mt-3 text-sm text-muted">{t("admin.channels.archiveNote")}</p>
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>{t("common.cancel")}</Button>
        <Button variant="danger" disabled={busy} onClick={onConfirm}>{t("admin.channels.archiveConfirm")}</Button>
      </div>
    </Modal>
  );
}
