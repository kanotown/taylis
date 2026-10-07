import { AiChannelNotice } from "./ai";
import { Check, Hash, Lock, NotebookPen } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";

import type { MemberOut, UserPublic } from "../api/types";
import type { AppController } from "../state/app";
import type { ChannelState } from "../sync/types";
import { Avatar, presenceLabel } from "./Avatar";
import { myName, selfNotesHint } from "./channels";
import { pickerPeople } from "./home";
import { StatusEmoji, UserPopover } from "./UserPopover";
import { AttendanceChip } from "./AttendanceChip";
import { compareByRoster, rosterLabel, titleExtra } from "./roster";
import { Badge, Button, cn, Field, Input, Kbd, Modal } from "./primitives";
import { type MessageKey, t } from "../i18n";
import { canManageChannelByRight } from "./roles";

// The settings (M40) are in Settings.tsx: the phone's 「自分」 list and the wide layout's dialog.

interface DialogProps {
  controller: AppController;
  onClose: () => void;
  onOpen: (channelId: string) => void;
}

/** Selectable user rows shared by the DM and add-member dialogs. */
export function UserPicker({ users, selected, onToggle, empty }: { users: UserPublic[]; selected: string[]; onToggle: (id: string) => void; empty: string }) {
  if (users.length === 0) return <p className="py-6 text-center text-sm text-muted">{empty}</p>;
  return (
    <ul className="max-h-72 overflow-y-auto rounded-xl border border-line">
      {users.map((u) => {
        const on = selected.includes(u.id);
        return (
          <li key={u.id}>
            <button
              type="button"
              onClick={() => onToggle(u.id)}
              aria-pressed={on}
              className={cn("flex w-full items-center gap-3 px-3 py-2 text-left text-sm transition-colors hover:bg-panel", on && "bg-accent-soft/60")}
            >
              <Avatar id={u.id} name={u.display_name} size={28} />
              <span className="flex-1 truncate">
                {u.display_name} <span className="text-muted">@{u.username}</span>
              </span>
              <span className={cn("flex h-5 w-5 items-center justify-center rounded-full border", on ? "border-accent bg-accent-solid text-white" : "border-line")}>{on && <Check size={12} />}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function ErrorText({ error }: { error: string | null }) {
  return error ? <p className="rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p> : null;
}

export function NewDmDialog({ controller, onClose, onOpen }: DialogProps) {
  const me = controller.store.me?.id;
  // Bots only when they answer in a DM (AI bots), after the people (apps/shared/jump-match.json `pick`).
  const { people, bots } = pickerPeople("", controller.store.users.values(), me ?? null, new Set(controller.store.aiStatus?.agents.map((a) => a.bot_user_id)));
  const users = [...people, ...bots];
  const [selected, setSelected] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const toggle = (id: string) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));

  const create = () => open(selected);
  const open = async (userIds: string[]) => {
    if (!controller.api || userIds.length === 0) return;
    try {
      const channel = await controller.api.createDm(userIds);
      controller.store.upsertChannel(channel, { isMember: true });
      onOpen(channel.id);
      onClose();
    } catch (err) {
      setError(controller.describe(err));
    }
  };

  return (
    <Modal onClose={onClose} title={t("sidebar.dms")} description={t("dialogs.newDmDescription")}>
      <div className="mt-4 space-y-3">
        {/* A DM with only myself, titled with my name (as in Slack / Mattermost). */}
        {me && (
          <button
            type="button"
            onClick={() => void open([me])}
            className="flex w-full items-center gap-2.5 rounded-lg border border-line px-3 py-2 text-left text-sm hover:bg-panel"
          >
            <NotebookPen size={16} className="shrink-0 text-muted" />
            <span className="shrink-0 font-medium">{myName(controller.store.users, me, controller.store.me)}</span>
            <span className="min-w-0 truncate text-xs text-muted">{selfNotesHint()}</span>
          </button>
        )}
        <UserPicker users={users} selected={selected} onToggle={toggle} empty={t("dialogs.noDmCandidates")} />
        <ErrorText error={error} />
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            {t("common.close")}
          </Button>
          <Button onClick={() => void create()} disabled={selected.length === 0 || selected.length > 8}>
            {t("dialogs.open")}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

export function AddMemberDialog({ controller, channelId, onClose }: { controller: AppController; channelId: string; onClose: () => void }) {
  const me = controller.store.me?.id;
  const [members, setMembers] = useState<Set<string> | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [adding, setAdding] = useState(false);
  const users = [...controller.store.users.values()].filter((u) => u.id !== me && !u.deactivated_at && !members?.has(u.id)).sort((a, b) => a.display_name.localeCompare(b.display_name, "ja"));

  useEffect(() => {
    let cancelled = false;
    setMembers(null);
    setSelected([]);
    setLoadError(null);
    setError(null);
    const api = controller.api;
    void (async () => {
      try {
        if (!api) throw new Error(t("dialogs.checkConnection"));
        const list = await api.members(channelId);
        if (!cancelled) setMembers(new Set(list.map((m) => m.user_id)));
      } catch (error) {
        if (!cancelled) setLoadError(controller.describe(error));
      }
    })();
    return () => { cancelled = true; };
  }, [controller, controller.api, channelId, attempt]);

  const toggle = (id: string) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));

  const add = async () => {
    if (!controller.api || members === null || adding || selected.length === 0) return;
    setAdding(true);
    setError(null);
    try {
      // M88: everyone chosen in one request (one 「追加しました」 line in the channel).
      await controller.api.addMembers(channelId, selected);
      onClose();
    } catch (err) {
      setError(controller.describe(err));
    } finally { setAdding(false); }
  };

  return (
    <Modal onClose={onClose} title={t("dialogs.addMembers")}>
      <div className="mt-4 space-y-3">
        {loadError !== null ? (
          <div className="space-y-2 py-4 text-sm">
            <p role="alert">{t("dialogs.membersLoadFailed")}</p>
            <p className="text-muted">{loadError}</p>
            <Button variant="secondary" onClick={() => setAttempt((value) => value + 1)}>{t("common.retry")}</Button>
          </div>
        ) : members === null ? <p role="status" className="py-6 text-center text-sm text-muted">{t("common.loading")}</p> : <UserPicker users={users} selected={selected} onToggle={toggle} empty={t("dialogs.noOneToAdd")} />}
        <ErrorText error={error} />
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            {t("common.close")}
          </Button>
          <Button onClick={() => void add()} disabled={members === null || adding || selected.length === 0}>
            {t("common.add")}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

export function NewChannelDialog({ controller, onClose, onOpen }: DialogProps) {
  const [name, setName] = useState("");
  const [type, setType] = useState<"public" | "private">("public");
  const [error, setError] = useState<string | null>(null);

  const create = async (event: FormEvent) => {
    event.preventDefault();
    if (!controller.api) return;
    try {
      const channel = await controller.api.createChannel(name.trim(), type);
      controller.store.upsertChannel(channel, { isMember: true });
      onOpen(channel.id);
      onClose();
    } catch (err) {
      setError(controller.describe(err));
    }
  };

  const option = (value: "public" | "private", icon: React.ReactNode, title: string, text: string) => (
    <button
      type="button"
      onClick={() => setType(value)}
      aria-pressed={type === value}
      className={cn("flex flex-1 items-start gap-3 rounded-xl border p-3 text-left transition-colors", type === value ? "border-accent bg-accent-soft/60" : "border-line hover:bg-panel")}
    >
      <span className="mt-0.5 text-muted">{icon}</span>
      <span>
        <span className="block text-sm font-medium">{title}</span>
        <span className="block text-xs text-muted">{text}</span>
      </span>
    </button>
  );

  return (
    <Modal onClose={onClose} title={t("sidebar.createChannel")}>
      <form className="mt-4 space-y-4" onSubmit={create}>
        <Field label={t("reservations.name")} hint={t("dialogs.channelNameHint")}>
          <div className="relative">
            <Hash size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="general" pattern="[^\s#@/]{1,80}" required autoFocus className="pl-8" />
          </div>
        </Field>
        <div className="flex gap-2">
          {option("public", <Hash size={18} />, t("dialogs.public"), t("dialogs.publicNote"))}
          {option("private", <Lock size={18} />, t("dialogs.private"), t("dialogs.privateNote"))}
        </div>
        <ErrorText error={error} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            {t("common.close")}
          </Button>
          <Button type="submit" disabled={!name.trim()}>
            {t("common.create")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/** Members of a channel with the option to add more (channels only). */
export function MembersDialog({ controller, channel, onClose, onAdd }: { controller: AppController; channel: ChannelState; onClose: () => void; onAdd: () => void }) {
  const [members, setMembers] = useMembers(controller, channel.id);
  return (
    <Modal onClose={onClose} title={members ? t("dialogs.membersCount", { count: members.length }) : t("channel.members")}>
      <div className="mt-4 space-y-3">
        {/* M65 (docs/AI.md §4): an AI bot among the members. */}
        <AiChannelNotice controller={controller} memberIds={members ? members.map((m) => m.user_id) : null} />
        <MemberList controller={controller} channel={channel} members={members} onChange={setMembers} className="max-h-80" />
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            {t("common.close")}
          </Button>
          {channel.isMember && !channel.archived && <Button onClick={onAdd}>{t("dialogs.addMembers")}</Button>}
        </div>
      </div>
    </Modal>
  );
}

/**
 * A conversation's members, fetched on open and again when `reload` changes or the members change (added, removed, an
 * owner made or taken back: the store's revision, L4); null while loading.
 */
export function useMembers(controller: AppController, channelId: string, reload: unknown = null) {
  const [members, setMembers] = useState<MemberOut[] | null>(null);
  const revision = controller.store.membersRevision(channelId);
  useEffect(() => {
    if (!controller.api) return;
    let current = true;
    void controller.api.members(channelId).then((list) => { if (current) setMembers(list); }, (error) => controller.setError(error));
    return () => { current = false; };
  }, [controller, channelId, reload, revision]);
  return [members, setMembers] as const;
}

/**
 * The member rows (roster order, badges, and for owners and admins 「オーナーにする」 / 「オーナーから外す」 (L4) and 「外す」);
 * in the dialog and the channel details (M29).
 */
export function MemberList({ controller, channel, members, onChange, className }: {
  controller: AppController;
  channel: ChannelState;
  members: MemberOut[] | null;
  onChange: (update: (members: MemberOut[] | null) => MemberOut[] | null) => void;
  className?: string;
}) {
  // Not in a DM (its members are the conversation itself).
  const canManage = (channel.membership?.role === "owner" || canManageChannelByRight(channel, (capability) => controller.can(capability))) && (channel.type === "public" || channel.type === "private"); // M142
  const users = controller.store.users;
  const roster = controller.store.roster;
  const setMembers = onChange;
  return members === null ? (
          <p className="py-6 text-center text-sm text-muted">{t("common.loading")}</p>
        ) : (
          <ul className={cn("divide-y divide-line overflow-y-auto rounded-xl border border-line", className)}>
            {members
              .map((m) => ({ member: m, user: users.get(m.user_id) }))
              // M23: roster order when either is on the lab roster, else by name.
              .sort((a, b) => (a.user && b.user && (roster.has(a.user.id) || roster.has(b.user.id)) ? compareByRoster(a.user, b.user, roster) : (a.user?.display_name ?? "").localeCompare(b.user?.display_name ?? "", "ja")))
              .map(({ member, user }) => (
                <li key={member.user_id} className="flex items-center gap-3 px-3 py-2 text-sm">
                  <UserPopover controller={controller} userId={member.user_id} className="flex min-w-0 flex-1 items-center gap-3">
                    <Avatar id={member.user_id} name={user?.display_name ?? "?"} size={28} presence={controller.store.presenceOf(member.user_id)} />
                    <span className="flex-1 truncate">
                      {user?.display_name ?? "?"} <span className="text-muted">@{user?.username ?? ""}</span>
                      {/* The roster label is the badge below; the title adds the rest (LAB.md 「肩書と名簿」). */}
                      {titleExtra(user?.title, roster.get(member.user_id)) && <span className="ml-1 text-xs text-muted">· {titleExtra(user?.title, roster.get(member.user_id))}</span>}
                    </span>
                  </UserPopover>
                  <StatusEmoji controller={controller} userId={member.user_id} />
                  <AttendanceChip controller={controller} userId={member.user_id} />
                  {controller.store.presenceOf(member.user_id) !== "offline" && (
                    <span className="text-xs text-muted">{presenceLabel(controller.store.presenceOf(member.user_id))}</span>
                  )}
                  {roster.get(member.user_id) && <Badge>{rosterLabel(roster.get(member.user_id)!)}</Badge>}
                  {member.role === "owner" && <Badge tone="accent">{t("dialogs.owner")}</Badge>}
                  {controller.store.users.get(member.user_id)?.role === "guest" && <Badge>{t("dialogs.guest")}</Badge>}
                  {/* L4: not for guests and bots (403 owner_not_allowed); the last owner is the server's to keep (409 last_owner). */}
                  {canManage && !channel.archived && (member.role === "owner" || (user?.role !== "guest" && user?.role !== "bot")) && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-muted hover:text-ink"
                      onClick={() => {
                        const role = member.role === "owner" ? "member" : "owner";
                        void controller.setMemberRole(channel.id, member.user_id, role).then((updated) => {
                          if (updated) setMembers((list) => list?.map((m) => (m.user_id === updated.user_id ? updated : m)) ?? null);
                        });
                      }}
                    >
                      {member.role === "owner" ? t("dialogs.removeOwner") : t("dialogs.makeOwner")}
                    </Button>
                  )}
                  {canManage && member.user_id !== controller.store.me?.id && member.role !== "owner" && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-muted hover:text-danger"
                      title={t("dialogs.removeFromChannel")}
                      onClick={() => void controller.removeMember(channel.id, member.user_id).then((ok) => { if (ok) setMembers((list) => list?.filter((m) => m.user_id !== member.user_id) ?? null); })}
                    >
                      {t("settings.workspaces.remove")}
                    </Button>
                  )}
                </li>
              ))}
          </ul>
        );
}

export function TopicDialog({ controller, channel, onClose }: { controller: AppController; channel: ChannelState; onClose: () => void }) {
  const [topic, setTopic] = useState(channel.topic ?? "");
  const [busy, setBusy] = useState(false);
  const save = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    const ok = await controller.updateTopic(channel.id, topic);
    setBusy(false);
    if (ok) onClose();
  };
  return (
    <Modal onClose={onClose} title={t("dialogs.topic")} description={t("dialogs.topicDescription")}>
      <form className="mt-4 space-y-4" onSubmit={save}>
        <Input value={topic} maxLength={250} autoFocus onChange={(e) => setTopic(e.target.value)} placeholder={t("dialogs.topicPlaceholder")} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" disabled={busy}>
            {t("common.save")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/** Rename a channel (owner or admin, M11e). */
export function RenameChannelDialog({ controller, channel, onClose }: { controller: AppController; channel: ChannelState; onClose: () => void }) {
  const [name, setName] = useState(channel.name ?? "");
  const [busy, setBusy] = useState(false);
  const save = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    const ok = await controller.renameChannel(channel.id, name);
    setBusy(false);
    if (ok) onClose();
  };
  return (
    <Modal onClose={onClose} title={t("dialogs.renameChannel")} description={t("dialogs.renameChannelDescription")}>
      <form className="mt-4 space-y-4" onSubmit={save}>
        <Input value={name} pattern="[a-z0-9][a-z0-9._-]*" maxLength={80} autoFocus required onChange={(e) => setName(e.target.value.toLowerCase())} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" disabled={busy || !name.trim() || name.trim() === channel.name}>
            {t("common.save")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function shortcuts(): Array<[string, string]> {
  return SHORTCUT_KEYS.map(([keys, what]) => [keys.replace(/\{(\w+)\}/g, (_, k: string) => t(`shortcuts.${k}` as MessageKey)), t(what)]);
}

const SHORTCUT_KEYS: Array<[string, MessageKey]> = [
  ["F6 / Shift + F6", "shortcuts.f6"],
  ["↑ / ↓・Home / End {onMessage}", "shortcuts.arrows"],
  ["Enter / Shift + F10 {onMessage}", "shortcuts.enter"],
  ["→ / T {onMessage}", "shortcuts.openThread"],
  ["Ctrl/⌘ + K", "shortcuts.jump"],
  ["Ctrl/⌘ + Shift + K", "shortcuts.newDm"],
  ["Ctrl/⌘ + F", "shortcuts.search"],
  ["Ctrl/⌘ + 1〜9", "shortcuts.workspace"],
  ["Ctrl/⌘ + Shift + T", "shortcuts.threads"],
  ["Ctrl/⌘ + Shift + E", "shortcuts.browse"],
  ["Alt/⌥ + ↑ / ↓", "shortcuts.prevNext"],
  ["Alt/⌥ + Shift + ↑ / ↓", "shortcuts.prevNextUnread"],
  ["⌘ + [ / ]・Alt + ← / → (Windows)", "shortcuts.history"],
  ["⌘ + ← / → {macOutside}", "shortcuts.historyShort"],
  ["Esc", "shortcuts.esc"],
  ["↑ {emptyBox}", "shortcuts.editLast"],
  ["Shift + ↑ {emptyBox}", "shortcuts.replyLast"],
  ["Shift + Enter / Enter", "shortcuts.send"],
  ["Alt/⌥ + {click}", "shortcuts.markUnread"],
  ["Ctrl/⌘ + B / I", "shortcuts.boldItalic"],
  ["Ctrl/⌘ + Shift + X / C", "shortcuts.strikeCode"],
  ["Ctrl/⌘ + Shift + U", "shortcuts.link"],
  ["Tab / Shift + Tab", "shortcuts.indent"],
  ["Ctrl/⌘ + U", "shortcuts.attach"],
  ["Ctrl/⌘ + Shift + L", "shortcuts.focus"],
  ["Ctrl/⌘ + Shift + Y", "shortcuts.attendance"],
  ["Ctrl/⌘ + /", "shortcuts.this"],
];

export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  return (
    <Modal onClose={onClose} title={t("main.shortcuts")} className="w-[520px]">
      <table className="mt-4 w-full text-sm">
        <tbody className="divide-y divide-line">
          {shortcuts().map(([keys, what]) => (
            <tr key={keys}>
              <td className="whitespace-nowrap py-2 pr-4 align-top">
                <Kbd>{keys}</Kbd>
              </td>
              <td className="py-2 text-ink">{what}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Modal>
  );
}
