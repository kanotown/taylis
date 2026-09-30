import { Bell, BellOff, Building2, ChevronRight, EyeOff, ImagePlus, Keyboard, Laptop, Lock, LogOut, Monitor, Moon, Palette, Plus, Rows3, ShieldCheck, Smartphone, SmilePlus, UserRound } from "lucide-react";
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from "react";

import type { SessionOut, TotpStatusOut } from "../api/types";
import { isTauri } from "../platform/env";
import { notificationPermission, type NotificationPermissionState, requestNotificationPermission } from "../platform/notify";
import type { AppController } from "../state/app";
import { hostLabel, type WorkspaceEntry, workspaceColor, workspaceInitials } from "../state/workspaces";
import { AdminBody } from "./AdminDialog";
import { AvatarCropDialog } from "./AvatarCropDialog";
import { Avatar } from "./Avatar";
import { OVERALL_LEVEL_LABELS, OVERALL_LEVEL_NOTE, overallLevel } from "./channels";
import { customPauseAt, DAY_LABELS, DND_OPTIONS, deviceTimeZone, dndUntilAt, inQuietHours, localInputValue, pausedUntil, pauseValue, type QuietHours, quietHoursLabel, quietHoursValue } from "./dnd";
import { fullTimestamp, sinceLabel } from "./format";
import { useNow, useStoreUpdates } from "./hooks";
import { modKeyName, type SendKey } from "./prefs";
import { Badge, Button, cn, Field, Input, Modal } from "./primitives";
import { StatusForm } from "./StatusDialog";
import { TemplatesSettings } from "./TemplatesSettings";
import { THEME_OPTIONS, themeLabel, useTheme, writeTheme } from "./theme";
import { TotpDisableDialog, TotpSetupDialog } from "./TotpDialog";
import { activeStatus, expiryLabel } from "./users";

/**
 * M40 (MOBILE_UI.md §6.5): the settings as a list of screens. The phone's 「自分」 tab shows the list and pushes a
 * section's screen (YouView); the wide layout's settings dialog keeps the same list on the left and the chosen section
 * on the right. Same items, same order, everywhere.
 */
export type SettingsSection = "status" | "pause" | "quiet" | "notifications" | "appearance" | "input" | "profile" | "account" | "workspaces" | "admin";

export const SECTION_TITLES: Record<SettingsSection, string> = {
  status: "ステータスを更新",
  pause: "通知を一時停止",
  quiet: "おやすみ時間",
  notifications: "通知",
  appearance: "表示",
  input: "入力",
  profile: "プロフィールを編集",
  account: "アカウント",
  workspaces: "ワークスペース",
  admin: "管理",
};

/** The pushed screens after the two quick ones, in the list's order (管理 only for admins). */
export function menuSections(isAdmin: boolean): SettingsSection[] {
  return ["notifications", "appearance", "input", "profile", "account", "workspaces", ...(isAdmin ? (["admin"] as const) : [])];
}

const SECTION_ICONS: Record<SettingsSection, ReactNode> = {
  status: <SmilePlus size={18} />,
  pause: <BellOff size={18} />,
  quiet: <Moon size={18} />,
  notifications: <Bell size={18} />,
  appearance: <Palette size={18} />,
  input: <Keyboard size={18} />,
  profile: <UserRound size={18} />,
  account: <Lock size={18} />,
  workspaces: <Building2 size={18} />,
  admin: <ShieldCheck size={18} />,
};

const HEADING = "text-xs font-semibold text-muted";
const CARD = "flex items-center gap-3 rounded-xl border border-line px-3 py-2";

/**
 * Me: my own fields (keywords, notification setting …) from `me`; the public ones (status, pause, quiet hours) from the
 * users map when that is newer (user.updated from another of my devices).
 */
function meOf(controller: AppController) {
  const me = controller.store.me ?? controller.me;
  if (!me) return null;
  const shared = controller.store.users.get(me.id);
  return shared && Date.parse(shared.updated_at) > Date.parse(me.updated_at) ? { ...me, ...shared } : me;
}

/** The value shown on a row's right (「オフ」, 「22:00〜07:00」, 「ダーク」 …). */
function sectionValue(controller: AppController, section: SettingsSection, now: Date, theme: string): string | null {
  const me = meOf(controller);
  switch (section) {
    case "pause":
      return pauseValue(pausedUntil(me, now), now);
    case "quiet":
      return quietHoursValue(me?.quiet_hours ?? null);
    case "appearance":
      return theme;
    case "workspaces":
      return controller.workspaces.length > 1 ? `${controller.workspaces.length} 件` : null;
    default:
      return null;
  }
}

// --- the list -----------------------------------------------------------------------------

/**
 * The list: me (picture, name, @username · 肩書), 「ステータスを更新」, 「通知を一時停止」 and 「おやすみ時間」, the screens,
 * and a red 「ログアウト」. `variant` "page" is the phone's 「自分」 (large rows); "nav" is the settings dialog's left
 * column, with the chosen one marked.
 */
export function SettingsList({ controller, variant, selected = null, onSelect, onLogout }: {
  controller: AppController;
  variant: "page" | "nav";
  selected?: SettingsSection | null;
  onSelect: (section: SettingsSection) => void;
  onLogout: () => void;
}) {
  const now = useNow(30_000);
  const theme = useTheme();
  const me = meOf(controller);
  const status = activeStatus(me);
  const page = variant === "page";
  const row = (section: SettingsSection, subtitle?: ReactNode) => {
    const value = sectionValue(controller, section, now, themeLabel(theme));
    return (
      <li key={section}>
        <button
          type="button"
          data-section={section}
          aria-label={value ? `${SECTION_TITLES[section]} ${value}` : SECTION_TITLES[section]}
          aria-current={selected === section ? "page" : undefined}
          onClick={() => onSelect(section)}
          className={cn(
            "flex w-full items-center gap-3 text-left transition-colors",
            page ? "min-h-[48px] px-4 py-2.5 text-[15px] hover:bg-panel" : "rounded-lg px-2.5 py-1.5 text-sm hover:bg-panel",
            selected === section && "bg-accent-soft text-ink hover:bg-accent-soft",
          )}
        >
          <span className="shrink-0 text-muted">{SECTION_ICONS[section]}</span>
          <span className="min-w-0 flex-1">
            <span className="block truncate">{SECTION_TITLES[section]}</span>
            {subtitle && <span className="block truncate text-xs text-muted">{subtitle}</span>}
          </span>
          {value && <span className={cn("shrink-0 truncate text-muted", page ? "max-w-[45%] text-sm" : "max-w-[40%] text-xs")}>{value}</span>}
          {page && <ChevronRight size={16} className="shrink-0 text-muted" />}
        </button>
      </li>
    );
  };
  const group = (children: ReactNode, label: string) => (
    <ul aria-label={label} className={cn(page ? "divide-y divide-line border-y border-line bg-canvas" : "space-y-0.5")}>{children}</ul>
  );
  return (
    <div className={cn(page ? "space-y-5 pb-6" : "space-y-3")}>
      {me && (
        <div className={cn("flex items-center gap-3", page ? "px-4 pt-5" : "px-1.5 pt-1")}>
          <Avatar id={me.id} name={me.display_name} size={page ? 64 : 40} className="rounded-2xl" />
          <div className="min-w-0 flex-1">
            <div className={cn("truncate font-semibold", page ? "text-lg" : "text-sm")}>{me.display_name}</div>
            <div className={cn("truncate text-muted", page ? "text-sm" : "text-xs")}>@{me.username}{me.title ? ` · ${me.title}` : ""}</div>
          </div>
        </div>
      )}
      <div className={cn(page ? "px-4" : "")}>
        <button
          type="button"
          data-section="status"
          aria-label={status ? `ステータスを更新 (現在: ${status.emoji} ${status.text})`.trim() : "ステータスを更新"}
          aria-current={selected === "status" ? "page" : undefined}
          onClick={() => onSelect("status")}
          className={cn(
            "flex w-full items-center gap-2 rounded-xl border border-line text-left transition-colors hover:bg-panel",
            page ? "min-h-[44px] px-3 py-2 text-[15px]" : "px-2.5 py-1.5 text-sm",
            selected === "status" && "border-accent bg-accent-soft hover:bg-accent-soft",
          )}
        >
          <span className="shrink-0 text-lg leading-none">{status?.emoji || "😀"}</span>
          <span className="min-w-0 flex-1">
            <span className={cn("block truncate", !status && "text-muted")}>{status ? status.text || "ステータス" : "ステータスを更新"}</span>
            {status && expiryLabel(me?.status_expires_at) && <span className="block truncate text-xs text-muted">{expiryLabel(me?.status_expires_at)}</span>}
          </span>
        </button>
      </div>
      {group([row("pause"), row("quiet")], "すぐ使う設定")}
      {group(menuSections(controller.isAdmin).map((section) => row(section, page ? sectionSubtitle(section) : undefined)), "設定の項目")}
      <div className={cn(page ? "border-y border-line" : "border-t border-line pt-2")}>
        <button
          type="button"
          onClick={onLogout}
          className={cn("flex w-full items-center gap-3 text-left text-danger transition-colors hover:bg-danger/10", page ? "min-h-[48px] px-4 py-2.5 text-[15px] font-medium" : "rounded-lg px-2.5 py-1.5 text-sm")}
        >
          <LogOut size={18} className="shrink-0" />
          {logoutLabel(controller)}
        </button>
      </div>
    </div>
  );
}

function sectionSubtitle(section: SettingsSection): string | undefined {
  switch (section) {
    case "notifications":
      return "全体の設定・キーワード・端末の通知";
    case "appearance":
      return "端末に合わせる / ライト / ダーク";
    case "input":
      return "送信キー・テンプレート";
    case "profile":
      return "写真・表示名・肩書";
    case "account":
      return "パスワード・2 要素認証・ログイン中の端末";
    default:
      return undefined;
  }
}

function logoutLabel(controller: AppController): string {
  return controller.workspaces.length > 1 ? `${controller.workspaceName} からログアウト` : "ログアウト";
}

/** 「ログアウト」's confirmation (the red row at the bottom of the list). */
export function LogoutConfirm({ controller, onClose }: { controller: AppController; onClose: () => void }) {
  return (
    <Modal onClose={onClose} title="ログアウトしますか？" description={controller.activeEntry ? `${controller.activeEntry.username} @ ${hostLabel(controller.activeEntry.serverUrl)}` : undefined}>
      <p className="mt-3 text-sm text-muted">この端末に保存したこのワークスペースのメッセージと下書きを消します。サーバ上のデータは消えません。</p>
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>キャンセル</Button>
        <Button variant="danger" onClick={() => { onClose(); void controller.logout(); }}>
          ログアウト
        </Button>
      </div>
    </Modal>
  );
}

// --- one section --------------------------------------------------------------------------

/**
 * A section's content. `onDone` (the phone's pushed screens) returns to the list after a one-shot choice (a status
 * saved, a pause chosen, the quiet hours saved); without it the section stays (the dialog).
 */
export function SettingsSectionBody({ controller, section, onDone }: { controller: AppController; section: SettingsSection; onDone?: () => void }) {
  switch (section) {
    case "status":
      return <StatusForm controller={controller} onDone={onDone} />;
    case "pause":
      return <PauseSection controller={controller} onDone={onDone} />;
    case "quiet":
      return <QuietHoursSection controller={controller} onDone={onDone} />;
    case "notifications":
      return <NotificationsSection controller={controller} />;
    case "appearance":
      return <AppearanceSection controller={controller} />;
    case "input":
      return <InputSection controller={controller} />;
    case "profile":
      return <ProfileSection controller={controller} />;
    case "account":
      return <AccountSection controller={controller} />;
    case "workspaces":
      return <WorkspacesSection controller={controller} />;
    case "admin":
      return <AdminBody controller={controller} />;
  }
}

/** 「通知を一時停止」: 30 分 / 1 時間 / 2 時間 / 明日 8:00 / 日時を指定, and 「再開」 while paused (users.dnd_until). */
function PauseSection({ controller, onDone }: { controller: AppController; onDone?: () => void }) {
  const now = useNow(30_000);
  const me = meOf(controller);
  const until = pausedUntil(me, now);
  const [busy, setBusy] = useState(false);
  const [custom, setCustom] = useState(() => localInputValue(new Date(Date.now() + 3_600_000)));
  const customAt = customPauseAt(custom, now);
  const quietNow = me?.quiet_hours ? inQuietHours(me.quiet_hours, now) : false;
  const pause = async (value: string | null) => {
    setBusy(true);
    const ok = await controller.updateProfile({ dnd_until: value });
    setBusy(false);
    if (ok) onDone?.();
  };
  const option = "flex min-h-[44px] w-full items-center px-3 text-left text-sm transition-colors hover:bg-panel disabled:opacity-50";
  return (
    <div className="space-y-4">
      <p className="text-sm">
        {until ? <>🔕 通知を止めています <span className="text-muted">{pauseValue(until, now)}</span></> : <span className="text-muted">通知は止まっていません (オフ)</span>}
      </p>
      {quietNow && me?.quiet_hours && <p className="text-xs text-muted">いまはおやすみ時間です ({quietHoursLabel(me.quiet_hours)})</p>}
      <div role="group" aria-label="止める長さ" className="divide-y divide-line overflow-hidden rounded-xl border border-line">
        {DND_OPTIONS.map(([choice, label]) => (
          <button key={choice} type="button" disabled={busy} className={option} onClick={() => void pause(dndUntilAt(choice))}>
            {label}
          </button>
        ))}
        <div className="flex flex-wrap items-center gap-2 px-3 py-2">
          <label className="flex min-w-0 flex-1 items-center gap-2 text-sm">
            <span className="shrink-0">日時を指定</span>
            <Input type="datetime-local" value={custom} aria-label="日時を指定" className="min-w-0 flex-1" onChange={(e) => setCustom(e.target.value)} />
          </label>
          <Button size="sm" disabled={busy || !customAt} onClick={() => customAt && void pause(customAt)}>
            止める
          </Button>
        </div>
      </div>
      {custom && !customAt && <p className="text-xs text-danger">今より後の日時を選んでください</p>}
      {until && (
        <Button variant="secondary" disabled={busy} onClick={() => void pause(null)}>
          再開
        </Button>
      )}
    </div>
  );
}

const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6];
const sameHours = (a: QuietHours, b: QuietHours) => JSON.stringify({ ...a, days: [...(a.days ?? EVERY_DAY)].sort() }) === JSON.stringify({ ...b, days: [...(b.days ?? EVERY_DAY)].sort() });

/** 「おやすみ時間」: on / off, start, end, days (users.quiet_hours, evaluated in `tz`). */
function QuietHoursSection({ controller, onDone }: { controller: AppController; onDone?: () => void }) {
  const me = meOf(controller);
  const existing = (me?.quiet_hours ?? null) as QuietHours | null;
  const [on, setOn] = useState(existing !== null);
  const [quiet, setQuiet] = useState<QuietHours>(existing ?? { start: "22:00", end: "07:00", days: EVERY_DAY, tz: deviceTimeZone() });
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const changed = on !== (existing !== null) || (on && existing !== null && !sameHours(quiet, existing));
  const toggleDay = (day: number) => {
    const days = new Set(quiet.days ?? []);
    if (days.has(day)) days.delete(day);
    else days.add(day);
    setQuiet({ ...quiet, days: [...days].sort() });
    setSaved(false);
  };
  const save = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    const ok = await controller.updateProfile({ quiet_hours: on ? { ...quiet, days: quiet.days && quiet.days.length > 0 ? quiet.days : EVERY_DAY } : null });
    setBusy(false);
    setSaved(ok);
    if (ok) onDone?.();
  };
  return (
    <form className="space-y-4" onSubmit={save}>
      <label className={cn(CARD, "cursor-pointer")}>
        <Moon size={18} className="text-muted" />
        <span className="min-w-0 flex-1 text-sm">毎日この時間帯は通知を止める</span>
        <input type="checkbox" role="switch" className="h-4 w-4 accent-[var(--accent)]" checked={on} onChange={(e) => { setOn(e.target.checked); setSaved(false); }} />
      </label>
      {on && (
        <div className="space-y-3">
          <div className="flex items-center gap-2 text-sm">
            <Input type="time" value={quiet.start} aria-label="開始" className="w-32" onChange={(e) => { setQuiet({ ...quiet, start: e.target.value }); setSaved(false); }} />
            <span>〜</span>
            <Input type="time" value={quiet.end} aria-label="終了" className="w-32" onChange={(e) => { setQuiet({ ...quiet, end: e.target.value }); setSaved(false); }} />
          </div>
          <div role="group" aria-label="曜日" className="flex flex-wrap gap-1.5">
            {DAY_LABELS.map((label, day) => (
              <button key={label} type="button" aria-pressed={quiet.days?.includes(day) ?? false} onClick={() => toggleDay(day)} className={cn("h-9 w-9 rounded-full border text-sm", quiet.days?.includes(day) ? "border-accent bg-accent-soft" : "border-line text-muted")}>
                {label}
              </button>
            ))}
          </div>
          <div className="text-xs text-muted">タイムゾーン: {quiet.tz}</div>
        </div>
      )}
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={busy || !changed}>保存</Button>
        {saved && !onDone && <span className="text-xs text-muted">保存しました</span>}
      </div>
    </form>
  );
}

/** 「通知」: the overall setting (M35), reaction banners (M39), keywords (M12g), and whether the OS may show them. */
function NotificationsSection({ controller }: { controller: AppController }) {
  const me = meOf(controller);
  const [busy, setBusy] = useState(false);
  const [keywords, setKeywords] = useState((me?.notify_keywords ?? []).join(", "));
  const [savedKeywords, setSavedKeywords] = useState(false);
  const parsedKeywords = keywords.split(/[,、\n]/).map((k) => k.trim()).filter(Boolean).slice(0, 20);
  const keywordsChanged = JSON.stringify(parsedKeywords) !== JSON.stringify(me?.notify_keywords ?? []);
  // Whether the OS may show our notifications. A browser grants that only on the reader's own click (「通知を許可」
  // below), never for a request made when a message arrived (platform/notify.ts).
  const [permission, setPermission] = useState<NotificationPermissionState | null>(null);
  useEffect(() => {
    let current = true;
    void notificationPermission().then((state) => { if (current) setPermission(state); });
    return () => { current = false; };
  }, []);
  const saveKeywords = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    const ok = await controller.updateProfile({ notify_keywords: parsedKeywords });
    setBusy(false);
    setSavedKeywords(ok);
  };
  return (
    <div className="space-y-6">
      <section className="space-y-2">
        <h3 className={HEADING}>全体の設定</h3>
        {/* M35: the overall setting; a conversation with a level of its own follows that instead (PUSH_NOTIFICATIONS.md §4). */}
        <div role="radiogroup" aria-label="通知" className="rounded-xl border border-line p-1">
          {(["all", "mentions", "none"] as const).map((level) => (
            <label key={level} className="flex min-h-[40px] cursor-pointer items-center gap-3 rounded-lg px-2 py-1.5 text-sm hover:bg-panel">
              <input
                type="radio"
                name="notification-default"
                className="h-4 w-4 accent-[var(--accent)]"
                checked={overallLevel(me) === level}
                disabled={busy}
                onChange={() => { setBusy(true); void controller.setNotificationDefault(level).finally(() => setBusy(false)); }}
              />
              {OVERALL_LEVEL_LABELS[level]}
            </label>
          ))}
        </div>
        <p className="text-xs text-muted">{OVERALL_LEVEL_NOTE}</p>
      </section>
      {/* M39: reactions to my messages as banners (and pushes); a server before M39 has no such setting. */}
      {typeof me?.notify_reactions === "boolean" && (
        <label className={cn(CARD, "cursor-pointer")}>
          <SmilePlus size={18} className="text-muted" />
          <span className="min-w-0 flex-1 text-sm">
            リアクションのバナー <span className="ml-1 text-xs text-muted">オフでもアクティビティに表示されます</span>
          </span>
          <input
            type="checkbox"
            role="switch"
            className="h-4 w-4 accent-[var(--accent)]"
            checked={me.notify_reactions}
            disabled={busy}
            onChange={(e) => { const on = e.target.checked; setBusy(true); void controller.setNotifyReactions(on).finally(() => setBusy(false)); }}
          />
        </label>
      )}
      <form className="space-y-2" onSubmit={saveKeywords}>
        <Field label="通知キーワード (任意、コンマ区切り・20 個まで)">
          <Input value={keywords} placeholder="例: 加納, kano, リリース" onChange={(e) => { setKeywords(e.target.value); setSavedKeywords(false); }} />
          <span className="mt-1 block text-xs text-muted">本文に含まれると @メンションと同じように知らせます (大文字小文字は区別しません)</span>
        </Field>
        <div className="flex items-center gap-3">
          <Button type="submit" size="sm" disabled={busy || !keywordsChanged}>キーワードを保存</Button>
          {savedKeywords && <span className="text-xs text-muted">保存しました</span>}
        </div>
      </form>
      <section className="space-y-2">
        <h3 className={HEADING}>{isTauri() ? "この端末の通知" : "このブラウザの通知"}</h3>
        <div className={CARD}>
          <Bell size={18} className={permission === "granted" ? "text-success" : "text-muted"} />
          <div className="min-w-0 flex-1 text-sm">
            {permission === null ? (
              <span className="text-muted">確認中…</span>
            ) : permission === "granted" ? (
              <span>
                許可済み <span className="ml-1 text-xs text-muted">新しいメッセージを OS の通知で知らせます</span>
              </span>
            ) : permission === "denied" ? (
              <span>
                ブロック中 <span className="ml-1 text-xs text-muted">{isTauri() ? "OS の設定" : "ブラウザのサイト設定"}で許可してください</span>
              </span>
            ) : permission === "unsupported" ? (
              <span className="text-muted">このブラウザでは使えません</span>
            ) : (
              <span>
                未設定 <span className="ml-1 text-xs text-muted">許可すると新しいメッセージを OS の通知で知らせます</span>
              </span>
            )}
          </div>
          {permission === "default" && (
            <Button size="sm" variant="secondary" onClick={() => void requestNotificationPermission().then(setPermission)}>
              通知を許可
            </Button>
          )}
        </div>
        {permission === "granted" && (
          <p className="text-xs text-muted">止めたいときは {isTauri() ? "OS の設定 (通知)" : "ブラウザのサイト設定"}で変えられます。一時的に止めるなら「通知を一時停止」を使ってください。</p>
        )}
      </section>
    </div>
  );
}

/** 「表示」: 端末に合わせる / ライト / ダーク and 「連続した投稿をまとめる」 (M47), on this device only. */
function AppearanceSection({ controller }: { controller: AppController }) {
  const theme = useTheme();
  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <div role="radiogroup" aria-label="表示" className="rounded-xl border border-line p-1">
          {THEME_OPTIONS.map(([value, label]) => (
            <label key={value} className="flex min-h-[40px] cursor-pointer items-center gap-3 rounded-lg px-2 py-1.5 text-sm hover:bg-panel">
              <input type="radio" name="theme" className="h-4 w-4 accent-[var(--accent)]" checked={theme === value} onChange={() => { writeTheme(value); }} />
              {label}
            </label>
          ))}
        </div>
        <p className="text-xs text-muted">この端末だけの設定です。「端末に合わせる」は OS のライト / ダークに従います。</p>
      </div>
      {/* M47: the open timelines and threads follow a change at once (AppController.groupPosts). */}
      <label className={cn(CARD, "cursor-pointer")}>
        <Rows3 size={18} className="text-muted" />
        <span className="min-w-0 flex-1 text-sm">
          連続した投稿をまとめる
          <span className="block text-xs text-muted">オフ: 投稿ごとにアイコンと名前を表示 / オン: 同じ人の続けての投稿をまとめる (チャンネル・DM・スレッド)</span>
        </span>
        <input type="checkbox" role="switch" className="h-4 w-4 accent-[var(--accent)]" checked={controller.groupPosts} onChange={(e) => controller.setGroupPosts(e.target.checked)} />
      </label>
    </div>
  );
}

/** 「入力」: the send key (this device) and the templates (mine, and the workspace's for an admin). */
function InputSection({ controller }: { controller: AppController }) {
  return (
    <div className="space-y-6">
      <section className="space-y-2">
        <h3 className="text-sm font-semibold">送信キー</h3>
        <div className="flex gap-2 max-sm:flex-col">
          {(
            [
              ["mod-enter", `${modKeyName()}+Enter で送信`, "Enter は改行"],
              ["shift-enter", "Shift+Enter で送信", "Enter は改行"],
              ["enter", "Enter で送信", "Shift+Enter は改行"],
            ] as Array<[SendKey, string, string]>
          ).map(([value, title, text]) => (
            <button
              key={value}
              type="button"
              aria-pressed={controller.sendKey === value}
              onClick={() => controller.setSendKey(value)}
              className={cn("flex-1 rounded-xl border p-3 text-left transition-colors", controller.sendKey === value ? "border-accent bg-accent-soft/60" : "border-line hover:bg-panel")}
            >
              <span className="block text-sm font-medium">{title}</span>
              <span className="block text-xs text-muted">{text}</span>
            </button>
          ))}
        </div>
      </section>
      <TemplatesSettings controller={controller} />
    </div>
  );
}

/** 「プロフィールを編集」: photo, name, title, my roster line (M23), 在席を隠す (L4). */
function ProfileSection({ controller }: { controller: AppController }) {
  const me = meOf(controller);
  const [displayName, setDisplayName] = useState(me?.display_name ?? "");
  const [title, setTitle] = useState(me?.title ?? "");
  // M23: my research topic and reading, when an administrator has put me on the lab roster.
  const line = me ? controller.store.roster.get(me.id) : undefined;
  const [topic, setTopic] = useState(line?.research_topic ?? "");
  const [reading, setReading] = useState(line?.reading ?? "");
  const lineChanged = !!line && ((topic.trim() || null) !== (line.research_topic ?? null) || (reading.trim() || null) !== (line.reading ?? null));
  const nameChanged = displayName.trim() !== me?.display_name;
  const titleChanged = (title.trim() || null) !== (me?.title ?? null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const avatarInput = useRef<HTMLInputElement>(null);
  const [cropping, setCropping] = useState<File | null>(null);
  const edit = (set: (value: string) => void) => (event: React.ChangeEvent<HTMLInputElement>) => { set(event.target.value); setSaved(false); };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    const ok = (nameChanged ? await controller.updateDisplayName(displayName) : true)
      && (titleChanged ? await controller.updateProfile({ title: title.trim() || null }) : true)
      && (lineChanged ? await controller.updateMyRosterLine({ research_topic: topic.trim() || null, reading: reading.trim() || null }) : true);
    setBusy(false);
    setSaved(ok);
  };

  return (
    <div className="space-y-6">
      {cropping && (
        <AvatarCropDialog
          file={cropping}
          onCancel={() => setCropping(null)}
          onDone={(picture) => {
            setCropping(null);
            void controller.uploadAvatar(new File([picture], "avatar.jpg", { type: "image/jpeg" }));
          }}
        />
      )}
      {me && (
        <div className="flex items-center gap-3">
          <Avatar id={me.id} name={me.display_name} size={64} className="rounded-2xl" />
          {/* M16g: any photo; the crop dialog turns the chosen square into a small JPEG before it is sent. */}
          <input ref={avatarInput} type="file" accept="image/*" className="hidden" onChange={(e) => { const file = e.target.files?.[0]; e.target.value = ""; if (file) setCropping(file); }} />
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="secondary" onClick={() => avatarInput.current?.click()} title="プロフィール画像: 写真を選んで、使う範囲を決めます">
              <ImagePlus size={14} /> 写真を選ぶ
            </Button>
            {me.avatar_updated_at && (
              <Button size="sm" variant="ghost" className="text-danger" onClick={() => void controller.deleteAvatar()}>
                写真を削除
              </Button>
            )}
          </div>
        </div>
      )}
      <form className="space-y-3" onSubmit={save}>
        <Field label="表示名">
          <Input value={displayName} maxLength={80} onChange={edit(setDisplayName)} required />
        </Field>
        <Field label="肩書 (任意)">
          <Input value={title} maxLength={80} placeholder="例: 開発 / 営業" onChange={edit(setTitle)} />
        </Field>
        {line && (
          <>
            <Field label="研究テーマ (任意)">
              <Input value={topic} maxLength={200} placeholder="例: 拡散モデルによる音声合成" onChange={edit(setTopic)} />
            </Field>
            <Field label="よみ (任意、名簿の並び順に使います)">
              <Input value={reading} maxLength={80} placeholder="例: かのう とおる" onChange={edit(setReading)} />
            </Field>
          </>
        )}
        <div className="flex items-center gap-3">
          <Button type="submit" size="sm" disabled={busy || !displayName.trim() || (!nameChanged && !titleChanged && !lineChanged)}>
            プロフィールを保存
          </Button>
          {saved && <span className="text-xs text-muted">保存しました</span>}
        </div>
      </form>
      <section className="space-y-2">
        <h3 className={HEADING}>プライバシー</h3>
        {/* L4 (M31): the server shows me as offline to everyone (me included) while this is on. */}
        <label className={cn(CARD, "cursor-pointer")}>
          <EyeOff size={18} className="text-muted" />
          <span className="min-w-0 flex-1 text-sm">
            在席を隠す <span className="ml-1 text-xs text-muted">ほかの人からは常にオフラインに見えます</span>
          </span>
          <input
            type="checkbox"
            role="switch"
            className="h-4 w-4 accent-[var(--accent)]"
            checked={me?.presence_hidden ?? false}
            disabled={busy}
            onChange={(e) => { const hidden = e.target.checked; setBusy(true); void controller.updateProfile({ presence_hidden: hidden }).finally(() => setBusy(false)); }}
          />
        </label>
      </section>
    </div>
  );
}

/** 「アカウント」: password (other sessions end on the server), two-factor (M12i), and the signed-in devices. */
function AccountSection({ controller }: { controller: AppController }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [repeat, setRepeat] = useState("");
  const [passwordMessage, setPasswordMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // M12i: whether my account asks for an authenticator code, and the setup / disable flows.
  const [totp, setTotp] = useState<TotpStatusOut | null>(null);
  const [totpDialog, setTotpDialog] = useState<"setup" | "disable" | null>(null);
  const [sessionsVersion, setSessionsVersion] = useState(0);
  // M48: an account made by Google sign-in has no password (nothing to change, and 2FA is Google's).
  const hasPassword = (controller.store.me ?? controller.me)?.has_password !== false;
  useEffect(() => {
    if (hasPassword) void controller.totpStatus().then(setTotp);
  }, [controller, hasPassword]);

  const savePassword = async (event: FormEvent) => {
    event.preventDefault();
    if (next !== repeat) {
      setPasswordMessage("新しいパスワードが一致しません");
      return;
    }
    setBusy(true);
    const error = await controller.changePasswordInSession(current, next);
    setBusy(false);
    setPasswordMessage(error ?? "パスワードを変更しました (ほかの端末はログアウトしました)");
    if (!error) {
      setCurrent("");
      setNext("");
      setRepeat("");
      setSessionsVersion((value) => value + 1);
    }
  };

  return (
    <div className="space-y-6">
      {!hasPassword && (
        <p className="text-sm text-muted">このアカウントは Google でログインします (パスワードはありません。2 段階認証は Google のアカウントで設定します)</p>
      )}
      {hasPassword && (
        <>
          <form className="space-y-3" onSubmit={savePassword}>
            <h3 className="text-sm font-semibold">パスワードの変更</h3>
            <Field label="現在のパスワード">
              <Input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" required />
            </Field>
            <Field label="新しいパスワード (8 文字以上)">
              <Input type="password" value={next} minLength={8} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" required />
            </Field>
            <Field label="新しいパスワード (確認)">
              <Input type="password" value={repeat} onChange={(e) => setRepeat(e.target.value)} autoComplete="new-password" required />
            </Field>
            {passwordMessage && <p className={cn("text-sm", passwordMessage.includes("しました") ? "text-muted" : "text-danger")}>{passwordMessage}</p>}
            <Button type="submit" size="sm" disabled={busy}>
              変更する
            </Button>
          </form>
          <section className="space-y-2">
            <h3 className="text-sm font-semibold">2 要素認証</h3>
            <div className={CARD}>
              <ShieldCheck size={18} className={totp?.enabled ? "text-success" : "text-muted"} />
              <div className="min-w-0 flex-1 text-sm">
                {totp === null ? (
                  <span className="text-muted">確認中…</span>
                ) : totp.enabled ? (
                  <span>
                    有効 <span className="ml-1 text-xs text-muted">ログイン時に認証アプリのコードが必要です · 回復コード残り {totp.recovery_codes_left}</span>
                  </span>
                ) : (
                  <span className="text-muted">無効 (パスワードだけでログインできます)</span>
                )}
              </div>
              {totp && (
                <Button size="sm" variant="secondary" onClick={() => setTotpDialog(totp.enabled ? "disable" : "setup")}>
                  {totp.enabled ? "無効にする" : "有効にする"}
                </Button>
              )}
            </div>
          </section>
        </>
      )}
      <SessionsList controller={controller} version={sessionsVersion} />
      {totpDialog === "setup" && <TotpSetupDialog controller={controller} onClose={() => setTotpDialog(null)} onEnabled={() => { setTotpDialog(null); void controller.totpStatus().then(setTotp); }} />}
      {totpDialog === "disable" && <TotpDisableDialog controller={controller} onClose={() => setTotpDialog(null)} onDisabled={() => { setTotpDialog(null); void controller.totpStatus().then(setTotp); }} />}
    </div>
  );
}

const PLATFORM_LABELS: Record<string, string> = { ios: "iPhone / iPad", android: "Android", desktop: "デスクトップ", web: "ブラウザ" };

export function sessionName(session: SessionOut): string {
  return session.device.device_name?.trim() || PLATFORM_LABELS[session.device.platform] || session.device.platform;
}

/** 「iPhone / iPad · 」 before the time, unless the name already says it (「ブラウザ」). */
function platformLine(session: SessionOut): string {
  const platform = PLATFORM_LABELS[session.device.platform] ?? session.device.platform;
  return platform === sessionName(session) ? "" : `${platform} · `;
}

/** This device first, then the most recently used. */
export function orderSessions(sessions: readonly SessionOut[]): SessionOut[] {
  return [...sessions].sort((a, b) => (a.current === b.current ? Date.parse(b.last_used_at) - Date.parse(a.last_used_at) : a.current ? -1 : 1));
}

/** 「ログイン中の端末」: GET /auth/sessions; another device is signed out with DELETE /auth/sessions/{id} after a confirmation. */
function SessionsList({ controller, version }: { controller: AppController; version: number }) {
  const [sessions, setSessions] = useState<SessionOut[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [revoking, setRevoking] = useState<SessionOut | null>(null);
  useEffect(() => {
    let current = true;
    setError(null);
    controller.listSessions().then(
      (list) => { if (current) setSessions(orderSessions(list)); },
      (err: unknown) => { if (current) setError(controller.describe(err)); },
    );
    return () => { current = false; };
  }, [controller, version, attempt]);
  const revoke = async (session: SessionOut) => {
    setRevoking(null);
    if (await controller.revokeSession(session.id)) setSessions((list) => list?.filter((s) => s.id !== session.id) ?? null);
  };
  return (
    <section className="space-y-2">
      <h3 className="text-sm font-semibold">ログイン中の端末</h3>
      {error !== null ? (
        <div className="space-y-2 text-sm">
          <p role="alert">端末の一覧を読み込めませんでした</p>
          <p className="text-muted">{error}</p>
          <Button size="sm" variant="secondary" onClick={() => setAttempt((value) => value + 1)}>再試行</Button>
        </div>
      ) : sessions === null ? (
        <p role="status" className="text-sm text-muted">読み込み中…</p>
      ) : (
        <ul aria-label="ログイン中の端末" className="divide-y divide-line rounded-xl border border-line">
          {sessions.map((session) => (
            <li key={session.id} data-session={session.id} className="flex items-center gap-3 px-3 py-2.5">
              <span className="shrink-0 text-muted">{session.device.platform === "ios" || session.device.platform === "android" ? <Smartphone size={18} /> : session.device.platform === "web" ? <Monitor size={18} /> : <Laptop size={18} />}</span>
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-center gap-2 text-sm">
                  <span className="truncate font-medium">{sessionName(session)}</span>
                  {session.current && <Badge tone="accent" className="shrink-0">この端末</Badge>}
                </div>
                <div className="text-xs text-muted" title={fullTimestamp(session.last_used_at)}>
                  {platformLine(session)}最後に使った時刻 <span className="whitespace-nowrap">{sinceLabel(session.last_used_at)}</span>
                </div>
              </div>
              {!session.current && (
                <Button size="sm" variant="secondary" className="shrink-0 text-danger" onClick={() => setRevoking(session)}>
                  ログアウト
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {revoking && (
        <Modal title={`「${sessionName(revoking)}」をログアウトしますか？`} onClose={() => setRevoking(null)}>
          <p className="mt-3 text-sm text-muted">その端末ではもう一度ログインするまで使えなくなります。</p>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setRevoking(null)}>キャンセル</Button>
            <Button variant="danger" onClick={() => void revoke(revoking)}>ログアウト</Button>
          </div>
        </Modal>
      )}
    </section>
  );
}

/** 「ワークスペース」 (M16c): the list, switching, adding and signing out (desktop app); a browser serves its own only. */
function WorkspacesSection({ controller }: { controller: AppController }) {
  const [leaving, setLeaving] = useState<WorkspaceEntry | null>(null);
  const entries = controller.multiWorkspace ? controller.workspaces : controller.workspaces.filter((entry) => entry.serverUrl === controller.activeServer);
  return (
    <div className="space-y-4">
      <ul aria-label="ワークスペース" className="divide-y divide-line rounded-xl border border-line">
        {entries.map((entry) => {
          const active = entry.serverUrl === controller.activeServer;
          const signedIn = active || controller.isSignedIn(entry.serverUrl);
          return (
            <li key={entry.serverUrl} className="flex items-center gap-3 px-3 py-2.5">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-sm font-bold text-white" style={{ background: workspaceColor(entry.workspaceId ?? entry.serverUrl) }}>
                {workspaceInitials(entry.name)}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-center gap-2 text-sm">
                  <span className="truncate font-medium">{entry.name}</span>
                  {active && <Badge tone="accent" className="shrink-0">表示中</Badge>}
                </div>
                <div className="truncate text-xs text-muted">{entry.username} @ {hostLabel(entry.serverUrl)}{signedIn ? "" : " · サインインが必要です"}</div>
              </div>
              {!active && controller.multiWorkspace && (
                <Button size="sm" variant="secondary" onClick={() => void controller.switchWorkspace(entry.serverUrl)}>
                  切り替え
                </Button>
              )}
              {controller.multiWorkspace && (
                <Button size="sm" variant="ghost" className="text-danger" onClick={() => (signedIn ? setLeaving(entry) : void controller.signOutWorkspace(entry.serverUrl))}>
                  {signedIn ? "サインアウト" : "外す"}
                </Button>
              )}
            </li>
          );
        })}
      </ul>
      {controller.multiWorkspace ? (
        <Button variant="secondary" onClick={() => controller.beginAddWorkspace()}>
          <Plus size={15} /> ワークスペースを追加
        </Button>
      ) : (
        <p className="text-xs text-muted">ブラウザではこのサーバのワークスペースだけを開きます。複数のワークスペースはデスクトップ版で使えます。</p>
      )}
      {leaving && (
        <Modal title={`${leaving.name} からサインアウトしますか？`} description={`${leaving.username} @ ${hostLabel(leaving.serverUrl)}`} onClose={() => setLeaving(null)}>
          <p className="mt-3 text-sm text-muted">この端末に保存したこのワークスペースのメッセージと下書きを消し、一覧から外します。サーバ上のデータは消えません。</p>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setLeaving(null)}>キャンセル</Button>
            <Button variant="danger" onClick={() => { const target = leaving; setLeaving(null); void controller.signOutWorkspace(target.serverUrl); }}>
              サインアウト
            </Button>
          </div>
        </Modal>
      )}
    </div>
  );
}

// --- the wide layout's dialog ---------------------------------------------------------------

/**
 * The wide layout's settings (M40): the list on the left, the chosen section on the right (not one long page).
 * Opens on 「通知」 unless told otherwise.
 */
export function SettingsDialog({ controller, onClose, initialSection = "notifications" }: { controller: AppController; onClose: () => void; initialSection?: SettingsSection }) {
  const [section, setSection] = useState<SettingsSection>(initialSection === "admin" && !controller.isAdmin ? "notifications" : initialSection);
  const [confirmLogout, setConfirmLogout] = useState(false);
  useStoreUpdates(controller);
  return (
    <Modal onClose={onClose} title="設定" className="flex h-[min(86dvh,760px)] w-[960px] max-w-[94vw] flex-col overflow-hidden">
      <div className="mt-4 flex min-h-0 flex-1 overflow-hidden rounded-xl border border-line">
        <nav aria-label="設定の項目" className="w-[248px] shrink-0 overflow-y-auto border-r border-line bg-panel/60 p-2">
          <SettingsList controller={controller} variant="nav" selected={section} onSelect={setSection} onLogout={() => setConfirmLogout(true)} />
        </nav>
        <section aria-label={SECTION_TITLES[section]} className="flex min-w-0 flex-1 flex-col">
          <h3 className="shrink-0 px-6 pb-2 pt-5 text-base font-semibold">{SECTION_TITLES[section]}</h3>
          {section === "admin" ? (
            <div className="flex min-h-0 flex-1 flex-col px-6 pb-4">
              <SettingsSectionBody key={section} controller={controller} section={section} />
            </div>
          ) : (
            <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6">
              <SettingsSectionBody key={section} controller={controller} section={section} />
            </div>
          )}
        </section>
      </div>
      {confirmLogout && <LogoutConfirm controller={controller} onClose={() => setConfirmLogout(false)} />}
    </Modal>
  );
}
