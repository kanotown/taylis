import { Bell, BellOff, Building2, ChevronDown, ChevronRight, ChevronUp, GripVertical, EyeOff, Flag, ImagePlus, Info, Keyboard, Laptop, ListTodo, Lock, LogOut, Monitor, Moon, Palette, Plus, Rows3, ShieldCheck, Smartphone, SmilePlus, UserRound } from "lucide-react";
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from "react";

import type { SessionOut, TotpStatusOut } from "../api/types";
import { isTauri } from "../platform/env";
import { DEFAULT_ZOOM, stepZoom, useZoom, writeZoom, ZOOM_STEPS, zoomLabel } from "../platform/zoom";
import { notificationPermission, type NotificationPermissionState, requestNotificationPermission } from "../platform/notify";
import type { AppController } from "../state/app";
import { hostLabel, signInName, type WorkspaceEntry } from "../state/workspaces";
import { WorkspaceIcon } from "./workspaceIcons";
import { AdminBody } from "./AdminDialog";
import { AvatarCropDialog } from "./AvatarCropDialog";
import { Avatar } from "./Avatar";
import { OVERALL_LEVEL_LABELS, overallLevel, overallLevelNote } from "./channels";
import { deviceLocale, getLocalePreference, tIn, type UiLocale, t } from "../i18n";
import { EmojiPicker, useRecentEmoji } from "./EmojiPicker";
import { MAX_QUICK_REACTIONS, quickReactions } from "./MessageActionsSheet";
import { fullNavItems, moveNavItem, navLabel, reorderNavItems, setNavItemVisible, shownNavItems } from "./navItems";
import { customPauseAt, dayLabels, DND_OPTIONS, deviceTimeZone, dndUntilAt, inQuietHours, localInputValue, pausedUntil, pauseValue, type QuietHours, quietHoursLabel, quietHoursValue } from "./dnd";
import { fullTimestamp, sinceLabel } from "./format";
import { useNow, useStoreUpdates } from "./hooks";
import { type ComposerMode, composerModeOf, modKeyName, type SendKey } from "./prefs";
import { Badge, Button, cn, Field, Input, Modal } from "./primitives";
import { StatusForm } from "./StatusDialog";
import { TemplatesSettings } from "./TemplatesSettings";
import { TestNotificationCard } from "./TestNotification";
import { displayTitle } from "./roster";
import { applyThemeToAllWorkspaces, FONT_OPTIONS, PALETTES, SIDEBAR_TONES, THEME_OPTIONS, type ThemeScope, themeLabel, useFont, usePalette, useSidebarTone, useTheme, useWorkspaceThemesDiffer, writeFont, writePalette, writeSidebarTone, writeTheme } from "./theme";
import { TotpDisableDialog, TotpSetupDialog } from "./TotpDialog";
import { DeleteAccountDialog, ProblemReportDialog } from "./ModerationDialogs";
import { UsernameEditor } from "./UsernameEditor";
import { StatusGlyph } from "./UserPopover";
import { activeStatus, expiryLabel } from "./users";
import { useUpdates } from "./UpdateBanner";
import { versionLabel } from "../state/updates";

/**
 * M40 (MOBILE_UI.md §6.5): the settings as a list of screens. The phone's 「自分」 tab shows the list and pushes a
 * section's screen (YouView); the wide layout's settings dialog keeps the same list on the left and the chosen section
 * on the right. Same items, same order, everywhere.
 */
export type SettingsSection = "status" | "pause" | "quiet" | "notifications" | "appearance" | "input" | "profile" | "account" | "workspaces" | "about" | "admin";

export const SECTION_TITLES: Record<SettingsSection, string> = {
  get status() { return t("settings.section.status"); },
  get pause() { return t("settings.section.pause"); },
  get quiet() { return t("settings.section.quiet"); },
  get notifications() { return t("settings.section.notifications"); },
  get appearance() { return t("settings.section.appearance"); },
  get input() { return t("settings.section.input"); },
  get profile() { return t("settings.section.profile"); },
  get account() { return t("settings.section.account"); },
  get workspaces() { return t("settings.section.workspaces"); },
  get about() { return t("settings.section.about"); },
  get admin() { return t("settings.section.admin"); },
};

/** The pushed screens after the two quick ones, in the list's order (このアプリについて in the desktop app, 管理 only for admins). */
export function menuSections(isAdmin: boolean, desktop: boolean = isTauri()): SettingsSection[] {
  return ["notifications", "appearance", "input", "profile", "account", "workspaces", ...(desktop ? (["about"] as const) : []), ...(isAdmin ? (["admin"] as const) : [])];
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
  about: <Info size={18} />,
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
      return controller.workspaces.length > 1 ? t("common.count", { count: controller.workspaces.length }) : null;
    case "about":
      return controller.updates.currentVersion ? versionLabel(controller.updates.currentVersion) : null;
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
  const [reporting, setReporting] = useState(false);
  // The roster label is the title too (LAB.md 「肩書と名簿」).
  const myTitle = me ? displayTitle(me.title, controller.store.roster.get(me.id)) : null;
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
            <div className={cn("truncate text-muted", page ? "text-sm" : "text-xs")}>@{me.username}{myTitle ? ` · ${myTitle}` : ""}</div>
          </div>
        </div>
      )}
      <div className={cn(page ? "px-4" : "")}>
        <button
          type="button"
          data-section="status"
          aria-label={status ? t("settings.status.currentLabel", { emoji: status.emoji, text: status.text }).trim() : t("settings.section.status")}
          aria-current={selected === "status" ? "page" : undefined}
          onClick={() => onSelect("status")}
          className={cn(
            "flex w-full items-center gap-2 rounded-xl border border-line text-left transition-colors hover:bg-panel",
            page ? "min-h-[44px] px-3 py-2 text-[15px]" : "px-2.5 py-1.5 text-sm",
            selected === "status" && "border-accent bg-accent-soft hover:bg-accent-soft",
          )}
        >
          <span className="shrink-0 text-lg leading-none">{status?.emoji ? <StatusGlyph controller={controller} emoji={status.emoji} size={20} /> : "😀"}</span>
          <span className="min-w-0 flex-1">
            <span className={cn("block truncate", !status && "text-muted")}>{status ? status.text || t("settings.status.label") : t("settings.section.status")}</span>
            {status && expiryLabel(me?.status_expires_at) && <span className="block truncate text-xs text-muted">{expiryLabel(me?.status_expires_at)}</span>}
          </span>
        </button>
      </div>
      {group([row("pause"), row("quiet")], t("settings.list.quick"))}
      {group(menuSections(controller.isAdmin).map((section) => row(section, page ? sectionSubtitle(section) : undefined)), t("settings.list.items"))}
      {/* M119 (docs/MODERATION.md §3.1): always visible, guests too (Google Play's child safety standards). */}
      {group(
        <li>
          <button
            type="button"
            data-action="problem-report"
            onClick={() => setReporting(true)}
            className={cn("flex w-full items-center gap-3 text-left transition-colors", page ? "min-h-[48px] px-4 py-2.5 text-[15px] hover:bg-panel" : "rounded-lg px-2.5 py-1.5 text-sm hover:bg-panel")}
          >
            <span className="shrink-0 text-muted"><Flag size={18} /></span>
            <span className="min-w-0 flex-1 truncate">{t("problemReport.entry")}</span>
            {page && <ChevronRight size={16} className="shrink-0 text-muted" />}
          </button>
        </li>,
        t("problemReport.entry"),
      )}
      {reporting && <ProblemReportDialog controller={controller} onClose={() => setReporting(false)} />}
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
      return t("settings.subtitle.notifications");
    case "appearance":
      return isTauri() ? t("settings.subtitle.appearanceDesktop") : t("settings.subtitle.appearance");
    case "input":
      return t("settings.subtitle.input");
    case "profile":
      return t("settings.subtitle.profile");
    case "account":
      return t("settings.subtitle.account");
    case "about":
      return t("settings.subtitle.about");
    default:
      return undefined;
  }
}

function logoutLabel(controller: AppController): string {
  return controller.workspaces.length > 1 ? t("settings.logoutFrom", { workspace: controller.workspaceName }) : t("common.logout");
}

/** 「ログアウト」's confirmation (the red row at the bottom of the list). */
export function LogoutConfirm({ controller, onClose }: { controller: AppController; onClose: () => void }) {
  return (
    <Modal onClose={onClose} title={t("settings.logout.title")} description={controller.activeEntry ? `${signInName(controller.activeEntry)} @ ${hostLabel(controller.activeEntry.serverUrl)}` : undefined}>
      <p className="mt-3 text-sm text-muted">{t("settings.logout.body")}</p>
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>{t("common.cancel")}</Button>
        <Button variant="danger" onClick={() => { onClose(); void controller.logout(); }}>
          {t("common.logout")}
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
    case "about":
      return <AboutSection controller={controller} />;
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
        {until ? <>🔕 {t("settings.pause.paused")} <span className="text-muted">{pauseValue(until, now)}</span></> : <span className="text-muted">{t("settings.pause.notPaused")}</span>}
      </p>
      {quietNow && me?.quiet_hours && <p className="text-xs text-muted">{t("settings.pause.quietNow", { hours: quietHoursLabel(me.quiet_hours) })}</p>}
      <div role="group" aria-label={t("settings.pause.length")} className="divide-y divide-line overflow-hidden rounded-xl border border-line">
        {DND_OPTIONS.map(([choice, label]) => (
          <button key={choice} type="button" disabled={busy} className={option} onClick={() => void pause(dndUntilAt(choice))}>
            {label}
          </button>
        ))}
        <div className="flex flex-wrap items-center gap-2 px-3 py-2">
          <label className="flex min-w-0 flex-1 items-center gap-2 text-sm">
            <span className="shrink-0">{t("settings.pause.custom")}</span>
            <Input type="datetime-local" value={custom} aria-label={t("settings.pause.custom")} className="min-w-0 flex-1" onChange={(e) => setCustom(e.target.value)} />
          </label>
          <Button size="sm" disabled={busy || !customAt} onClick={() => customAt && void pause(customAt)}>
            {t("settings.pause.pause")}
          </Button>
        </div>
      </div>
      {custom && !customAt && <p className="text-xs text-danger">{t("settings.pause.pickFuture")}</p>}
      {until && (
        <Button variant="secondary" disabled={busy} onClick={() => void pause(null)}>
          {t("settings.pause.resume")}
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
        <span className="min-w-0 flex-1 text-sm">{t("settings.quiet.daily")}</span>
        <input type="checkbox" role="switch" className="h-4 w-4 accent-[var(--accent)]" checked={on} onChange={(e) => { setOn(e.target.checked); setSaved(false); }} />
      </label>
      {on && (
        <div className="space-y-3">
          <div className="flex items-center gap-2 text-sm">
            <Input type="time" value={quiet.start} aria-label={t("common.start")} className="w-32" onChange={(e) => { setQuiet({ ...quiet, start: e.target.value }); setSaved(false); }} />
            <span>{t("common.rangeTo")}</span>
            <Input type="time" value={quiet.end} aria-label={t("common.end")} className="w-32" onChange={(e) => { setQuiet({ ...quiet, end: e.target.value }); setSaved(false); }} />
          </div>
          <div role="group" aria-label={t("settings.quiet.weekdays")} className="flex flex-wrap gap-1.5">
            {dayLabels().map((label, day) => (
              <button key={label} type="button" aria-pressed={quiet.days?.includes(day) ?? false} onClick={() => toggleDay(day)} className={cn("h-9 w-9 rounded-full border text-sm", quiet.days?.includes(day) ? "border-accent bg-accent-soft" : "border-line text-muted")}>
                {label}
              </button>
            ))}
          </div>
          <div className="text-xs text-muted">{t("settings.quiet.timeZone", { tz: quiet.tz })}</div>
        </div>
      )}
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={busy || !changed}>{t("common.save")}</Button>
        {saved && !onDone && <span className="text-xs text-muted">{t("common.saved")}</span>}
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
    const read = () => void notificationPermission().then((state) => { if (current) setPermission(state); });
    read();
    // Back from System Settings (the reader turned Taylis' notifications on or off there): read it again.
    window.addEventListener("focus", read);
    return () => {
      current = false;
      window.removeEventListener("focus", read);
    };
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
        <h3 className={HEADING}>{t("settings.notifications.overall")}</h3>
        {/* M35: the overall setting; a conversation with a level of its own follows that instead (PUSH_NOTIFICATIONS.md §4). */}
        <div role="radiogroup" aria-label={t("settings.section.notifications")} className="rounded-xl border border-line p-1">
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
        <p className="text-xs text-muted">{overallLevelNote()}</p>
      </section>
      {/* M39: reactions to my messages as banners (and pushes); a server before M39 has no such setting. */}
      {typeof me?.notify_reactions === "boolean" && (
        <label className={cn(CARD, "cursor-pointer")}>
          <SmilePlus size={18} className="text-muted" />
          <span className="min-w-0 flex-1 text-sm">
            {t("settings.notifications.reactions")} <span className="ml-1 text-xs text-muted">{t("settings.notifications.reactionsNote")}</span>
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
      {/* M55: a task assigned to me and the morning of its due date; a server before M55 has no such setting. */}
      {typeof me?.notify_tasks === "boolean" && (
        <label className={cn(CARD, "cursor-pointer")}>
          <ListTodo size={18} className="text-muted" />
          <span className="min-w-0 flex-1 text-sm">
            {t("settings.notifications.tasks")} <span className="ml-1 text-xs text-muted">{t("settings.notifications.tasksNote")}</span>
          </span>
          <input
            type="checkbox"
            role="switch"
            className="h-4 w-4 accent-[var(--accent)]"
            checked={me.notify_tasks}
            disabled={busy}
            onChange={(e) => { const on = e.target.checked; setBusy(true); void controller.setNotifyTasks(on).finally(() => setBusy(false)); }}
          />
        </label>
      )}
      <form className="space-y-2" onSubmit={saveKeywords}>
        <Field label={t("settings.notifications.keywords")}>
          <Input value={keywords} placeholder={t("settings.notifications.keywordsPlaceholder")} onChange={(e) => { setKeywords(e.target.value); setSavedKeywords(false); }} />
          <span className="mt-1 block text-xs text-muted">{t("settings.notifications.keywordsNote")}</span>
        </Field>
        <div className="flex items-center gap-3">
          <Button type="submit" size="sm" disabled={busy || !keywordsChanged}>{t("settings.notifications.saveKeywords")}</Button>
          {savedKeywords && <span className="text-xs text-muted">{t("common.saved")}</span>}
        </div>
      </form>
      <section className="space-y-2">
        <h3 className={HEADING}>{isTauri() ? t("settings.notifications.thisDevice") : t("settings.notifications.thisBrowser")}</h3>
        <div className={CARD}>
          <Bell size={18} className={permission === "granted" ? "text-success" : "text-muted"} />
          <div className="min-w-0 flex-1 text-sm">
            {permission === null ? (
              <span className="text-muted">{t("common.checking")}</span>
            ) : permission === "granted" ? (
              <span>
                {t("settings.notifications.granted")} <span className="ml-1 text-xs text-muted">{t("settings.notifications.grantedNote")}</span>
              </span>
            ) : permission === "denied" ? (
              <span>
                {t("settings.notifications.denied")} <span className="ml-1 text-xs text-muted">{isTauri() ? t("settings.notifications.deniedNoteOs") : t("settings.notifications.deniedNoteBrowser")}</span>
              </span>
            ) : permission === "unsupported" ? (
              <span className="text-muted">{t("settings.notifications.unsupported")}</span>
            ) : (
              <span>
                {t("settings.notifications.notSet")} <span className="ml-1 text-xs text-muted">{t("settings.notifications.notSetNote")}</span>
              </span>
            )}
          </div>
          {permission === "default" && (
            <Button size="sm" variant="secondary" onClick={() => void requestNotificationPermission().then(setPermission)}>
              {t("settings.notifications.allow")}
            </Button>
          )}
        </div>
        {permission === "granted" && (
          <p className="text-xs text-muted">{isTauri() ? t("settings.notifications.stopNoteOs") : t("settings.notifications.stopNoteBrowser")}</p>
        )}
        {/* PUSH_NOTIFICATIONS.md §15: does a notification reach this device and my phones? */}
        <TestNotificationCard controller={controller} permission={permission} />
      </section>
    </div>
  );
}

/**
 * 「表示」: 端末に合わせる / ライト / ダーク, 「テーマの色」, 「サイドバー」 (濃い色 / 明るい色), 「フォント」, 「文字の大きさ」 (the desktop app; a browser zooms by itself) and
 * 「連続した投稿をまとめる」 (M47), on this device only. With two or more workspaces (the rail), 「テーマの色」 and
 * 「サイドバー」 are the workspace on screen's own, and 「すべてのワークスペースに使う」 makes them every workspace's.
 */
function AppearanceSection({ controller, desktop = isTauri() }: { controller: AppController; desktop?: boolean }) {
  const theme = useTheme();
  const palette = usePalette();
  const sidebarTone = useSidebarTone();
  const perWorkspace = controller.showsRail;
  const scope: ThemeScope = perWorkspace ? "workspace" : "all";
  const themesDiffer = useWorkspaceThemesDiffer();
  const font = useFont();
  const zoom = useZoom();
  return (
    <div className="space-y-6">
      <LanguageSettings controller={controller} />
      <div className="space-y-2">
        <div role="radiogroup" aria-label={t("settings.appearance.theme")} className="rounded-xl border border-line p-1">
          {THEME_OPTIONS.map(([value, label]) => (
            <label key={value} className="flex min-h-[40px] cursor-pointer items-center gap-3 rounded-lg px-2 py-1.5 text-sm hover:bg-panel">
              <input type="radio" name="theme" className="h-4 w-4 accent-[var(--accent)]" checked={theme === value} onChange={() => { writeTheme(value); }} />
              {label}
            </label>
          ))}
        </div>
        <p className="text-xs text-muted">{t("settings.appearance.themeNote")}</p>
      </div>
      <section className="space-y-2">
        <h3 className={HEADING}>{t("settings.appearance.palette")}</h3>
        {/* The swatch cards' radios are sr-only (position: absolute): each card is `relative`, so its radio sits inside
            it and scrolls with the pane. Placed by an outer box instead, a radio below the pane's first screen stuck
            out of the settings dialog, and choosing it scrolled the whole dialog up to bring it into view. */}
        <div role="radiogroup" aria-label={t("settings.appearance.palette")} className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {PALETTES.map((option) => (
            <label
              key={option.value}
              className={cn(
                "relative flex min-h-[44px] cursor-pointer items-center gap-2.5 rounded-xl border px-2.5 py-2 text-sm hover:bg-panel has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-accent/50",
                palette === option.value ? "border-accent bg-accent-soft/50" : "border-line",
              )}
            >
              <input type="radio" name="palette" className="sr-only" checked={palette === option.value} onChange={() => writePalette(option.value, scope)} />
              <span aria-hidden className="flex h-7 w-7 shrink-0 overflow-hidden rounded-lg ring-1 ring-black/10">
                <span className="w-1/2" style={{ background: option.swatch.sidebar }} />
                <span className="w-1/2" style={{ background: option.swatch.accent }} />
              </span>
              <span className="min-w-0 flex-1 truncate">{option.label}</span>
            </label>
          ))}
        </div>
        <p className="text-xs text-muted">{t("settings.appearance.paletteNote")}</p>
      </section>
      <section className="space-y-2">
        <h3 className={HEADING}>{t("settings.appearance.sidebar")}</h3>
        <div role="radiogroup" aria-label={t("settings.appearance.sidebar")} className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {SIDEBAR_TONES.map(([value, label]) => {
            const swatch = PALETTES.find((p) => p.value === palette)?.swatch ?? PALETTES[0]!.swatch;
            return (
              <label
                key={value}
                className={cn(
                  "relative flex min-h-[44px] cursor-pointer items-center gap-2.5 rounded-xl border px-2.5 py-2 text-sm hover:bg-panel has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-accent/50",
                  sidebarTone === value ? "border-accent bg-accent-soft/50" : "border-line",
                )}
              >
                <input type="radio" name="sidebar-tone" className="sr-only" checked={sidebarTone === value} onChange={() => writeSidebarTone(value, scope)} />
                <span aria-hidden className="flex h-7 w-7 shrink-0 flex-col justify-center gap-1 overflow-hidden rounded-lg px-1.5 ring-1 ring-black/10" style={{ background: value === "light" ? `color-mix(in srgb, ${swatch.accent} 5%, #ffffff)` : swatch.sidebar }}>
                  <span className="h-1 rounded-full" style={{ background: value === "light" ? swatch.sidebar : "#ffffff", opacity: 0.7 }} />
                  <span className="h-1.5 rounded-sm" style={{ background: value === "light" ? swatch.accent : "rgba(255,255,255,0.35)" }} />
                  <span className="h-1 rounded-full" style={{ background: value === "light" ? swatch.sidebar : "#ffffff", opacity: 0.7 }} />
                </span>
                <span className="min-w-0 flex-1 truncate">{label}</span>
              </label>
            );
          })}
        </div>
        <p className="text-xs text-muted">{t("settings.appearance.sidebarNote")}</p>
      </section>
      {perWorkspace && (
        <div data-testid="workspace-theme" className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-line px-3 py-2.5">
          <p className="min-w-0 flex-1 text-xs text-muted">{t("settings.appearance.workspaceThemeNote", { name: controller.workspaceName })}</p>
          <Button size="sm" variant="secondary" disabled={!themesDiffer} onClick={() => applyThemeToAllWorkspaces()}>
            {t("settings.appearance.useForAllWorkspaces")}
          </Button>
        </div>
      )}
      <section className="space-y-2">
        <h3 className={HEADING}>{t("settings.appearance.font")}</h3>
        <div role="radiogroup" aria-label={t("settings.appearance.font")} className="rounded-xl border border-line p-1">
          {FONT_OPTIONS.map(([value, label]) => (
            <label key={value} className="flex min-h-[40px] cursor-pointer items-center gap-3 rounded-lg px-2 py-1.5 text-sm hover:bg-panel">
              <input type="radio" name="font" className="h-4 w-4 accent-[var(--accent)]" checked={font === value} onChange={() => writeFont(value)} />
              <span style={{ fontFamily: value === "noto" ? '"Noto Sans JP Variable", var(--font-system)' : "var(--font-system)" }}>{label}</span>
            </label>
          ))}
        </div>
        <p className="text-xs text-muted">{t("settings.appearance.fontNote")}</p>
      </section>
      {desktop && (
        <section className="space-y-2">
          <h3 className={HEADING}>{t("settings.appearance.zoom")}</h3>
          <div className="flex items-center gap-2">
            <Button variant="secondary" size="icon" aria-label={t("settings.appearance.zoomOut")} disabled={zoom <= ZOOM_STEPS[0]} onClick={() => writeZoom(stepZoom(zoom, -1))}>
              −
            </Button>
            <select
              aria-label={t("settings.appearance.zoom")}
              className="h-8 rounded-lg border border-line bg-canvas px-2 text-sm text-ink focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30"
              value={String(zoom)}
              onChange={(e) => writeZoom(Number(e.target.value))}
            >
              {ZOOM_STEPS.map((step) => (
                <option key={step} value={String(step)}>
                  {zoomLabel(step)}
                  {step === DEFAULT_ZOOM ? t("settings.appearance.zoomDefault") : ""}
                </option>
              ))}
            </select>
            <Button variant="secondary" size="icon" aria-label={t("settings.appearance.zoomIn")} disabled={zoom >= ZOOM_STEPS[ZOOM_STEPS.length - 1]!} onClick={() => writeZoom(stepZoom(zoom, 1))}>
              ＋
            </Button>
          </div>
          <p className="text-xs text-muted">
            {t("settings.appearance.zoomNote", { mod: modKeyName() })}
          </p>
        </section>
      )}
      {/* M47: the open timelines and threads follow a change at once (AppController.groupPosts). */}
      <label className={cn(CARD, "cursor-pointer")}>
        <Rows3 size={18} className="text-muted" />
        <span className="min-w-0 flex-1 text-sm">
          {t("settings.appearance.groupPosts")}
          <span className="block text-xs text-muted">{t("settings.appearance.groupPostsNote")}</span>
        </span>
        <input type="checkbox" role="switch" className="h-4 w-4 accent-[var(--accent)]" checked={controller.groupPosts} onChange={(e) => controller.setGroupPosts(e.target.checked)} />
      </label>
      <ComposerModeSettings controller={controller} />
      <NavItemsSettings controller={controller} />
    </div>
  );
}

/**
 * 「入力欄」: rich text (WYSIWYG) or Markdown, mine on every device's Desktop / Web (users.composer_mode; never chosen =
 * rich). The composer's 「Aa」 / 「M↓」 switch changes the same setting. A server without it has no such setting.
 */
export function ComposerModeSettings({ controller }: { controller: AppController }) {
  const me = meOf(controller);
  if (!me || me.composer_mode === undefined) return null;
  const current = composerModeOf(me);
  return (
    <section className="space-y-2">
      <h3 className={HEADING}>{t("settings.composerMode.title")}</h3>
      <div className="flex gap-2 max-sm:flex-col">
        {(
          [
            ["rich", t("composer.mode.rich"), t("settings.composerMode.richNote")],
            ["markdown", t("composer.mode.markdown"), t("settings.composerMode.markdownNote")],
          ] as Array<[ComposerMode, string, string]>
        ).map(([value, title, text]) => (
          <button
            key={value}
            type="button"
            aria-pressed={current === value}
            onClick={() => void controller.setComposerMode(value)}
            className={cn("flex-1 rounded-xl border p-3 text-left transition-colors", current === value ? "border-accent bg-accent-soft/60" : "border-line hover:bg-panel")}
          >
            <span className="block text-sm font-medium">{title}</span>
            <span className="block text-xs text-muted">{text}</span>
          </button>
        ))}
      </div>
      <p className="text-xs text-muted">{t("settings.composerMode.note")}</p>
    </section>
  );
}

/**
 * M111 「サイドバーの項目」: which menu items the sidebar shows and in what order, mine on every device (users.nav_items,
 * apps/shared/nav-items.json). A switch per item, drag (or ↑ / ↓) to reorder, 「元に戻す」 back to the defaults (null).
 * A change saves the whole list, items of the phones and of newer clients included. A server before M111 has no such setting.
 */
export function NavItemsSettings({ controller }: { controller: AppController }) {
  const me = meOf(controller);
  const [dragging, setDragging] = useState<string | null>(null);
  if (!me || me.nav_items === undefined) return null;
  const full = fullNavItems(me.nav_items);
  const shown = shownNavItems(full);
  const save = (list: typeof full | null) => void controller.setNavItems(list);
  const drop = (target: string) => {
    if (!dragging || dragging === target) return setDragging(null);
    const keys = shown.map((item) => item.key).filter((key) => key !== dragging);
    keys.splice(keys.indexOf(target) + (shown.findIndex((i) => i.key === dragging) < shown.findIndex((i) => i.key === target) ? 1 : 0), 0, dragging);
    setDragging(null);
    save(reorderNavItems(full, keys));
  };
  return (
    <section className="space-y-2" aria-label={t("settings.navItems.title")}>
      <div className="flex items-center justify-between gap-2">
        <h3 className={HEADING}>{t("settings.navItems.title")}</h3>
        <Button size="sm" variant="secondary" disabled={me.nav_items === null} onClick={() => save(null)}>
          {t("common.reset")}
        </Button>
      </div>
      <ul className="divide-y divide-line rounded-xl border border-line">
        {shown.map((item, index) => (
          <li
            key={item.key}
            data-nav-item={item.key}
            draggable
            onDragStart={(e) => { e.dataTransfer.effectAllowed = "move"; setDragging(item.key); }}
            onDragEnd={() => setDragging(null)}
            onDragOver={(e) => { if (dragging) e.preventDefault(); }}
            onDrop={(e) => { e.preventDefault(); drop(item.key); }}
            className={cn("flex min-h-[40px] items-center gap-2 px-2 py-1 text-sm", dragging === item.key && "opacity-50")}
          >
            <GripVertical size={15} className="shrink-0 cursor-grab text-muted" aria-hidden />
            <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2">
              <span className={cn("min-w-0 flex-1 truncate", !item.visible && "text-muted")}>{navLabel(item.key)}</span>
              <input
                type="checkbox"
                role="switch"
                aria-label={t("settings.navItems.show", { item: navLabel(item.key) })}
                className="h-4 w-4 accent-[var(--accent)]"
                checked={item.visible}
                onChange={(e) => save(setNavItemVisible(full, item.key, e.target.checked))}
              />
            </label>
            <button type="button" aria-label={t("settings.navItems.up", { item: navLabel(item.key) })} disabled={index === 0} onClick={() => save(moveNavItem(full, item.key, -1))} className="rounded p-1 text-muted hover:bg-panel hover:text-ink disabled:opacity-30">
              <ChevronUp size={14} />
            </button>
            <button type="button" aria-label={t("settings.navItems.down", { item: navLabel(item.key) })} disabled={index === shown.length - 1} onClick={() => save(moveNavItem(full, item.key, 1))} className="rounded p-1 text-muted hover:bg-panel hover:text-ink disabled:opacity-30">
              <ChevronDown size={14} />
            </button>
          </li>
        ))}
      </ul>
      <p className="text-xs text-muted">{t("settings.navItems.note")}</p>
    </section>
  );
}

/**
 * M115 「言語」 (docs/I18N.md): 端末に合わせる / 日本語 / English / 简体中文, mine on every device (users.locale; null = this
 * device's language). Each language is named in itself. Applied at once.
 */
export function LanguageSettings({ controller }: { controller: AppController }) {
  const me = meOf(controller);
  const current = me ? (me.locale ?? null) : getLocalePreference();
  const choices: Array<[UiLocale | null, string]> = [[null, t("settings.language.device")], ["ja", "日本語"], ["en", "English"], ["zh-Hans", "简体中文"]];
  return (
    <section className="space-y-2">
      <h3 className={HEADING}>{t("settings.language.title")}</h3>
      <div role="radiogroup" aria-label={t("settings.language.title")} className="rounded-xl border border-line p-1">
        {choices.map(([value, label]) => (
          <label key={value ?? "device"} className="flex min-h-[40px] cursor-pointer items-center gap-3 rounded-lg px-2 py-1.5 text-sm hover:bg-panel">
            <input type="radio" name="ui-locale" className="h-4 w-4 accent-[var(--accent)]" checked={current === value} onChange={() => void controller.setUiLocale(value)} />
            <span lang={value ?? undefined}>{label}</span>
            {value === null && <span className="text-xs text-muted">({tIn(deviceLocale(), "settings.language.name")})</span>}
          </label>
        ))}
      </div>
      <p className="text-xs text-muted">{t("settings.language.note")}</p>
    </section>
  );
}

/** 「入力」: the send key (this device) and the templates (mine, and the workspace's for an admin). */
function InputSection({ controller }: { controller: AppController }) {
  return (
    <div className="space-y-6">
      <section className="space-y-2">
        <h3 className="text-sm font-semibold">{t("settings.input.sendKey")}</h3>
        <div className="flex gap-2 max-sm:flex-col">
          {(
            [
              ["mod-enter", t("settings.input.sendWith", { key: `${modKeyName()}+Enter` }), t("settings.input.newlineWith", { key: "Enter" })],
              ["shift-enter", t("settings.input.sendWith", { key: "Shift+Enter" }), t("settings.input.newlineWith", { key: "Enter" })],
              ["enter", t("settings.input.sendWith", { key: "Enter" }), t("settings.input.newlineWith", { key: "Shift+Enter" })],
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
      <QuickReactionsSettings controller={controller} />
      <TemplatesSettings controller={controller} />
    </div>
  );
}

/**
 * M50 「リアクションの候補」: the six quick reactions of the long-press sheet (the hover bar shows the first three), mine on
 * every device (users.quick_reactions). A slot opens the picker (plain emoji only) and replaces its emoji; one already in
 * another slot trades places with it. Not chosen: the slots show today's rule (the ones I used last, then the defaults),
 * and choosing one keeps the others as shown. 「元に戻す」 goes back to that rule. A server before M50 has no such setting.
 */
export function QuickReactionsSettings({ controller }: { controller: AppController }) {
  const me = meOf(controller);
  const recent = useRecentEmoji();
  const [slot, setSlot] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  if (!me || me.quick_reactions === undefined) return null;
  const chosen = me.quick_reactions ?? null;
  const shown = quickReactions(recent, MAX_QUICK_REACTIONS, chosen);
  const save = (list: string[] | null) => {
    setSlot(null);
    setBusy(true);
    void controller.setQuickReactions(list).finally(() => setBusy(false));
  };
  const pick = (index: number, glyph: string) => {
    const next = [...shown];
    const other = next.indexOf(glyph);
    if (other === index) return setSlot(null);
    if (other >= 0) next[other] = next[index]!;
    next[index] = glyph;
    save(next);
  };
  return (
    <section className="space-y-2" aria-label={t("settings.quickReactions.title")}>
      <h3 className="text-sm font-semibold">{t("settings.quickReactions.title")}</h3>
      <div className="flex flex-wrap items-center gap-2">
        {shown.map((emoji, index) => (
          <button
            key={`${index}:${emoji}`}
            type="button"
            data-slot={index}
            aria-label={t("settings.quickReactions.slot", { n: index + 1, emoji })}
            aria-pressed={slot === index}
            disabled={busy}
            onClick={() => setSlot(slot === index ? null : index)}
            className={cn(
              "flex h-11 w-11 items-center justify-center rounded-full text-2xl transition-colors disabled:opacity-60",
              slot === index ? "bg-accent-soft ring-2 ring-accent" : "bg-panel hover:bg-panel-2",
            )}
          >
            {emoji}
          </button>
        ))}
        <Button size="sm" variant="secondary" disabled={busy || chosen === null} onClick={() => save(null)} className="ml-auto">
          {t("common.reset")}
        </Button>
      </div>
      <p className="text-xs text-muted">
        {chosen === null
          ? t("settings.quickReactions.notSet")
          : t("settings.quickReactions.set")}
      </p>
      {slot !== null && (
        <div className="rounded-xl border border-line p-3">
          <div className="mb-2 flex items-center justify-between text-xs text-muted">
            <span>{t("settings.quickReactions.pick", { n: slot + 1 })}</span>
            <button type="button" className="rounded px-1.5 py-0.5 hover:bg-panel hover:text-ink" onClick={() => setSlot(null)}>{t("common.cancel")}</button>
          </div>
          {/* Plain emoji only: no custom emoji (no `custom`, and recent ones like :name: are left out). */}
          <EmojiPicker recent={recent.filter((glyph) => !glyph.startsWith(":"))} onPick={(entry) => pick(slot, entry.glyph)} />
        </div>
      )}
    </section>
  );
}

/** 「プロフィールを編集」: photo, username (M96), name, title, my roster line (M23), 在席を隠す (L4). */
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
            <Button size="sm" variant="secondary" onClick={() => avatarInput.current?.click()} title={t("settings.profile.photoHint")}>
              <ImagePlus size={14} /> {t("settings.profile.choosePhoto")}
            </Button>
            {me.avatar_updated_at && (
              <Button size="sm" variant="ghost" className="text-danger" onClick={() => void controller.deleteAvatar()}>
                {t("settings.profile.deletePhoto")}
              </Button>
            )}
          </div>
        </div>
      )}
      {me && (
        // M96: its own form (one request, with its own refusals: taken, reserved, 3 times in 24 hours).
        <UsernameEditor current={me.username} hasPassword={me.has_password !== false} limitNote={me.role !== "admin"} onSubmit={(name) => controller.renameMe(name)} />
      )}
      <form className="space-y-3" onSubmit={save}>
        <Field label={t("settings.profile.displayName")}>
          <Input value={displayName} maxLength={80} onChange={edit(setDisplayName)} required />
        </Field>
        <Field label={t("settings.profile.title")}>
          <Input value={title} maxLength={80} placeholder={t("settings.profile.titlePlaceholder")} onChange={edit(setTitle)} />
        </Field>
        {line && (
          <>
            <Field label={t("settings.profile.topic")}>
              <Input value={topic} maxLength={200} placeholder={t("settings.profile.topicPlaceholder")} onChange={edit(setTopic)} />
            </Field>
            <Field label={t("settings.profile.reading")}>
              <Input value={reading} maxLength={80} placeholder={t("settings.profile.readingPlaceholder")} onChange={edit(setReading)} />
            </Field>
          </>
        )}
        <div className="flex items-center gap-3">
          <Button type="submit" size="sm" disabled={busy || !displayName.trim() || (!nameChanged && !titleChanged && !lineChanged)}>
            {t("settings.profile.save")}
          </Button>
          {saved && <span className="text-xs text-muted">{t("common.saved")}</span>}
        </div>
      </form>
      <section className="space-y-2">
        <h3 className={HEADING}>{t("settings.profile.privacy")}</h3>
        {/* L4 (M31): the server shows me as offline to everyone (me included) while this is on. */}
        <label className={cn(CARD, "cursor-pointer")}>
          <EyeOff size={18} className="text-muted" />
          <span className="min-w-0 flex-1 text-sm">
            {t("settings.profile.hidePresence")} <span className="ml-1 text-xs text-muted">{t("settings.profile.hidePresenceNote")}</span>
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
  const [deleting, setDeleting] = useState(false);
  const [passwordChanged, setPasswordChanged] = useState(false);
  // M48: an account made by Google sign-in has no password (nothing to change, and 2FA is Google's).
  const hasPassword = (controller.store.me ?? controller.me)?.has_password !== false;
  useEffect(() => {
    if (hasPassword) void controller.totpStatus().then(setTotp);
  }, [controller, hasPassword]);

  const savePassword = async (event: FormEvent) => {
    event.preventDefault();
    if (next !== repeat) {
      setPasswordChanged(false);
      setPasswordMessage(t("settings.account.passwordMismatch"));
      return;
    }
    setBusy(true);
    const error = await controller.changePasswordInSession(current, next);
    setBusy(false);
    setPasswordChanged(!error);
    setPasswordMessage(error ?? t("settings.account.passwordChanged"));
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
        <p className="text-sm text-muted">{t("settings.account.googleOnly")}</p>
      )}
      {hasPassword && (
        <>
          <form className="space-y-3" onSubmit={savePassword}>
            <h3 className="text-sm font-semibold">{t("settings.account.changePassword")}</h3>
            <Field label={t("settings.account.currentPassword")}>
              <Input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" required />
            </Field>
            <Field label={t("settings.account.newPassword")}>
              <Input type="password" value={next} minLength={8} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" required />
            </Field>
            <Field label={t("settings.account.repeatPassword")}>
              <Input type="password" value={repeat} onChange={(e) => setRepeat(e.target.value)} autoComplete="new-password" required />
            </Field>
            {passwordMessage && <p className={cn("text-sm", passwordChanged ? "text-muted" : "text-danger")}>{passwordMessage}</p>}
            <Button type="submit" size="sm" disabled={busy}>
              {t("settings.account.change")}
            </Button>
          </form>
          <section className="space-y-2">
            <h3 className="text-sm font-semibold">{t("settings.account.totp")}</h3>
            <div className={CARD}>
              <ShieldCheck size={18} className={totp?.enabled ? "text-success" : "text-muted"} />
              <div className="min-w-0 flex-1 text-sm">
                {totp === null ? (
                  <span className="text-muted">{t("common.checking")}</span>
                ) : totp.enabled ? (
                  <span>
                    {t("settings.account.totpOn")} <span className="ml-1 text-xs text-muted">{t("settings.account.totpOnNote", { left: totp.recovery_codes_left })}</span>
                  </span>
                ) : (
                  <span className="text-muted">{t("settings.account.totpOff")}</span>
                )}
              </div>
              {totp && (
                <Button size="sm" variant="secondary" onClick={() => setTotpDialog(totp.enabled ? "disable" : "setup")}>
                  {totp.enabled ? t("settings.account.turnOff") : t("settings.account.turnOn")}
                </Button>
              )}
            </div>
          </section>
        </>
      )}
      <SessionsList controller={controller} version={sessionsVersion} />
      <BlockedUsersList controller={controller} />
      {/* M104 (docs/MODERATION.md §2): deleting my account from inside the app (App Store 5.1.1(v), Google Play). */}
      <section className="space-y-2">
        <h3 className="text-sm font-semibold">{t("settings.account.delete")}</h3>
        <p className="text-xs text-muted">{t("settings.account.deleteNote")}</p>
        <Button size="sm" variant="danger" onClick={() => setDeleting(true)}>{t("settings.account.deleteButton")}</Button>
      </section>
      {deleting && <DeleteAccountDialog controller={controller} onClose={() => setDeleting(false)} />}
      {totpDialog === "setup" && <TotpSetupDialog controller={controller} onClose={() => setTotpDialog(null)} onEnabled={() => { setTotpDialog(null); void controller.totpStatus().then(setTotp); }} />}
      {totpDialog === "disable" && <TotpDisableDialog controller={controller} onClose={() => setTotpDialog(null)} onDisabled={() => { setTotpDialog(null); void controller.totpStatus().then(setTotp); }} />}
    </div>
  );
}

/** M104 (docs/MODERATION.md §4): the people I blocked, each with 「解除」. */
function BlockedUsersList({ controller }: { controller: AppController }) {
  useStoreUpdates(controller);
  const store = controller.store;
  const ids = [...store.blockedUsers];
  if (ids.length === 0) return null;
  return (
    <section className="space-y-2">
      <h3 className="text-sm font-semibold">{t("settings.account.blocked")}</h3>
      <ul className="space-y-1.5">
        {ids.map((id) => (
          <li key={id} className={CARD}>
            <span className="min-w-0 flex-1 truncate text-sm">{store.users.get(id)?.display_name ?? t("common.unknownUser")}</span>
            <Button size="sm" variant="secondary" onClick={() => void controller.setUserBlocked(id, false)}>{t("settings.account.unblock")}</Button>
          </li>
        ))}
      </ul>
    </section>
  );
}

const PLATFORM_LABELS: Record<string, string> = { ios: "iPhone / iPad", android: "Android", get desktop() { return t("device.desktop"); }, get web() { return t("device.browser"); } };

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
      <h3 className="text-sm font-semibold">{t("settings.sessions.title")}</h3>
      {error !== null ? (
        <div className="space-y-2 text-sm">
          <p role="alert">{t("settings.sessions.loadFailed")}</p>
          <p className="text-muted">{error}</p>
          <Button size="sm" variant="secondary" onClick={() => setAttempt((value) => value + 1)}>{t("common.retry")}</Button>
        </div>
      ) : sessions === null ? (
        <p role="status" className="text-sm text-muted">{t("common.loading")}</p>
      ) : (
        <ul aria-label={t("settings.sessions.title")} className="divide-y divide-line rounded-xl border border-line">
          {sessions.map((session) => (
            <li key={session.id} data-session={session.id} className="flex items-center gap-3 px-3 py-2.5">
              <span className="shrink-0 text-muted">{session.device.platform === "ios" || session.device.platform === "android" ? <Smartphone size={18} /> : session.device.platform === "web" ? <Monitor size={18} /> : <Laptop size={18} />}</span>
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-center gap-2 text-sm">
                  <span className="truncate font-medium">{sessionName(session)}</span>
                  {session.current && <Badge tone="accent" className="shrink-0">{t("settings.sessions.thisDevice")}</Badge>}
                </div>
                <div className="text-xs text-muted" title={fullTimestamp(session.last_used_at)}>
                  {platformLine(session)}{t("settings.sessions.lastUsed")} <span className="whitespace-nowrap">{sinceLabel(session.last_used_at)}</span>
                </div>
              </div>
              {!session.current && (
                <Button size="sm" variant="secondary" className="shrink-0 text-danger" onClick={() => setRevoking(session)}>
                  {t("common.logout")}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {revoking && (
        <Modal title={t("settings.sessions.revokeTitle", { name: sessionName(revoking) })} onClose={() => setRevoking(null)}>
          <p className="mt-3 text-sm text-muted">{t("settings.sessions.revokeBody")}</p>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setRevoking(null)}>{t("common.cancel")}</Button>
            <Button variant="danger" onClick={() => void revoke(revoking)}>{t("common.logout")}</Button>
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
      <ul aria-label={t("settings.section.workspaces")} className="divide-y divide-line rounded-xl border border-line">
        {entries.map((entry) => {
          const active = entry.serverUrl === controller.activeServer;
          const signedIn = active || controller.isSignedIn(entry.serverUrl);
          return (
            <li key={entry.serverUrl} className="flex items-center gap-3 px-3 py-2.5">
              <WorkspaceIcon serverUrl={entry.serverUrl} version={entry.iconVersion} name={entry.name} colorKey={entry.workspaceId ?? entry.serverUrl} className="h-9 w-9 rounded-xl text-sm" />
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-center gap-2 text-sm">
                  <span className="truncate font-medium">{entry.name}</span>
                  {active && <Badge tone="accent" className="shrink-0">{t("settings.workspaces.active")}</Badge>}
                </div>
                <div className="truncate text-xs text-muted">{signInName(entry)} @ {hostLabel(entry.serverUrl)}{signedIn ? "" : t("settings.workspaces.signInNeeded")}</div>
              </div>
              {!active && controller.multiWorkspace && (
                <Button size="sm" variant="secondary" onClick={() => void controller.switchWorkspace(entry.serverUrl)}>
                  {t("settings.workspaces.switch")}
                </Button>
              )}
              {controller.multiWorkspace && (
                <Button size="sm" variant="ghost" className="text-danger" onClick={() => (signedIn ? setLeaving(entry) : void controller.signOutWorkspace(entry.serverUrl))}>
                  {signedIn ? t("settings.workspaces.signOut") : t("settings.workspaces.remove")}
                </Button>
              )}
            </li>
          );
        })}
      </ul>
      {controller.multiWorkspace ? (
        <Button variant="secondary" onClick={() => controller.beginAddWorkspace()}>
          <Plus size={15} /> {t("settings.workspaces.add")}
        </Button>
      ) : (
        <p className="text-xs text-muted">{t("settings.workspaces.browserNote")}</p>
      )}
      {leaving && (
        <Modal title={t("settings.workspaces.signOutTitle", { name: leaving.name })} description={`${signInName(leaving)} @ ${hostLabel(leaving.serverUrl)}`} onClose={() => setLeaving(null)}>
          <p className="mt-3 text-sm text-muted">{t("settings.workspaces.signOutBody")}</p>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setLeaving(null)}>{t("common.cancel")}</Button>
            <Button variant="danger" onClick={() => { const target = leaving; setLeaving(null); void controller.signOutWorkspace(target.serverUrl); }}>
              {t("settings.workspaces.signOut")}
            </Button>
          </div>
        </Modal>
      )}
    </div>
  );
}

/**
 * 「このアプリについて」 (desktop app): the version and 「アップデートを確認」. A new version found here can be installed at
 * once, even after 「あとで」 hid the banner.
 */
function AboutSection({ controller }: { controller: AppController }) {
  const updates = useUpdates(controller.updates);
  const [checked, setChecked] = useState(false);
  const busy = updates.installInProgress || updates.status === "downloading" || updates.status === "installing";
  const check = async () => {
    setChecked(false);
    await updates.check(true);
    setChecked(true);
  };
  return (
    <div className="space-y-4">
      <div className={CARD}>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium">Taylis</div>
          <div className="text-xs text-muted">{t("settings.about.version")} {updates.currentVersion ? versionLabel(updates.currentVersion) : "—"}</div>
        </div>
        <Button size="sm" variant="secondary" disabled={updates.status === "checking" || busy} onClick={() => void check()}>
          {updates.status === "checking" ? t("common.checking") : t("settings.about.check")}
        </Button>
      </div>
      {updates.available ? (
        <div className={CARD}>
          <div className="min-w-0 flex-1 text-sm">{t("settings.about.available", { version: versionLabel(updates.available.version) })}</div>
          <Button size="sm" disabled={busy} onClick={() => void updates.install(() => controller.prepareForRestart())}>
            {busy ? t("settings.about.updating") : t("settings.about.restart")}
          </Button>
        </div>
      ) : (
        checked && updates.status === "idle" && !updates.lastCheckFailed && <p className="text-xs text-muted" role="status">{t("settings.about.latest")}</p>
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
    <Modal onClose={onClose} title={t("settings.title")} className="flex h-[min(86dvh,760px)] w-[960px] max-w-[94vw] flex-col overflow-hidden">
      <div className="mt-4 flex min-h-0 flex-1 overflow-hidden rounded-xl border border-line">
        <nav aria-label={t("settings.list.items")} className="w-[248px] shrink-0 overflow-y-auto border-r border-line bg-panel/60 p-2">
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
