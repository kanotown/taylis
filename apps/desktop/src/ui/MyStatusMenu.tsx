/**
 * The quick status menu (docs/PRESENCE.md §11, like Mattermost's): my avatar in the sidebar header (and at the top of
 * 「自分」 / the settings list) opens it. On top my picture with the dot, my name and the current state
 * (「取り込み中（〜15:30）」 with 「解除」); then the four choices — オンライン（自動）, 離席中, 取り込み中 (a submenu of
 * durations), オフライン表示 — each one press; then 「ステータスを設定」 (the custom status, M11d), 在室状況 (a submenu
 * of my states while the board is on, docs/PRESENCE.md §7.1), 「プロフィールを編集」 and 設定.
 *
 * Keyboard: Radix's menu (↑ / ↓, → or Enter opens a submenu, ← closes it, Esc closes the menu).
 */
import { DropdownMenu } from "radix-ui";
import { Check, ChevronRight, DoorOpen, Settings as SettingsIcon, Smile, UserRoundPen } from "lucide-react";
import { type ReactElement, type ReactNode, useState } from "react";

import type { DndDuration, PresenceChoice, PresenceLook } from "../api/types";
import type { AppController } from "../state/app";
import { entryOf, myChoices, myState } from "./attendance";
import { attendanceColorStyle, StateGlyph } from "./attendanceIcons";
import { chooseMyState } from "./AttendanceView";
import { Avatar } from "./Avatar";
import { useStoreUpdates } from "./hooks";
import { cn } from "./primitives";
import { choiceLabel, currentMe, DND_DURATIONS, durationLabel, myPresenceChoice, myPresenceLine, presenceRequest } from "./presence";
import { StatusGlyph } from "./UserPopover";
import { activeStatus } from "./users";
import { t } from "../i18n";

const CONTENT = "rx-popover z-50 rounded-xl border border-line bg-canvas p-1 text-ink shadow-xl";
const ITEM = "flex min-h-9 select-none items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-sm outline-none data-[disabled]:opacity-50 data-[highlighted]:bg-accent-soft";

const CHOICE_LOOK: Record<PresenceChoice, PresenceLook> = { auto: "online", away: "away", dnd: "dnd", invisible: "offline" };
const HINT_KEYS = { auto: "presence.hint.auto", away: "presence.hint.away", dnd: "presence.hint.dnd", invisible: "presence.hint.invisible" } as const;

/** The small dot of a choice (the avatar's dot, alone). */
export function PresenceDot({ look, size = 10 }: { look: PresenceLook; size?: number }) {
  return (
    <span
      aria-hidden
      data-presence-dot={look}
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-full",
        look === "online" ? "bg-success" : look === "away" ? "bg-warning" : look === "dnd" ? "bg-danger" : "border-[1.5px] border-muted",
      )}
      style={{ width: size, height: size }}
    >
      {look === "dnd" && <span className="block rounded-full bg-white" style={{ width: "62%", height: Math.max(1.5, Math.round(size * 0.18)) }} />}
    </span>
  );
}

export function MyStatusMenu({ controller, children, onSettings, onOpenAttendance, align = "start", defaultOpen = false }: {
  controller: AppController;
  /** The trigger (my avatar, or my avatar and name). */
  children: ReactElement;
  onSettings?: () => void;
  /** 在室状況's 「在室状況を開く」 (the board). */
  onOpenAttendance?: () => void;
  align?: "start" | "end";
  /** Tests. */
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <DropdownMenu.Root open={open} onOpenChange={setOpen} modal={false}>
      <DropdownMenu.Trigger asChild>{children}</DropdownMenu.Trigger>
      {open && (
        <DropdownMenu.Portal>
          <DropdownMenu.Content data-my-status-menu sideOffset={6} align={align} collisionPadding={8} className={cn(CONTENT, "w-72")}>
            <MenuBody controller={controller} onSettings={onSettings} onOpenAttendance={onOpenAttendance} />
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      )}
    </DropdownMenu.Root>
  );
}

function MenuBody({ controller, onSettings, onOpenAttendance }: { controller: AppController; onSettings?: () => void; onOpenAttendance?: () => void }) {
  useStoreUpdates(controller);
  const store = controller.store;
  const me = currentMe(store);
  if (!me) return null;
  const choice = myPresenceChoice(me);
  const status = activeStatus(store.users.get(me.id) ?? me);
  const choose = (next: PresenceChoice, duration?: DndDuration) => {
    void controller.setMyPresence(presenceRequest(next, duration));
  };
  const board = store.attendance;
  const attendance = !!board && !controller.isGuest;
  const current = attendance ? myState(board, me.id) : null;
  const mine = attendance ? entryOf(board, me.id) : null;
  const choiceItem = (value: PresenceChoice): ReactNode => (
    <DropdownMenu.Item
      key={value}
      role="menuitemradio"
      aria-checked={choice === value}
      data-presence-choice={value}
      className={ITEM}
      onSelect={() => choose(value)}
    >
      <PresenceDot look={CHOICE_LOOK[value]} />
      <ChoiceText value={value} />
      {choice === value && <Check aria-hidden size={15} className="shrink-0 text-accent" />}
    </DropdownMenu.Item>
  );

  return (
    <>
      <div data-my-status-header className="flex items-center gap-3 px-2.5 pb-2 pt-1.5">
        <Avatar id={me.id} name={me.display_name} size={40} className="rounded-xl" presence={store.presenceOf(me.id)} showOffline />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold">{me.display_name}</div>
          <div data-my-presence-line className="truncate text-xs text-muted">{myPresenceLine(me)}</div>
        </div>
        {choice === "dnd" && (
          <DropdownMenu.Item
            data-presence-clear
            title={t("presence.clearTitle")}
            className="shrink-0 select-none rounded-md border border-line px-2 py-0.5 text-xs outline-none data-[highlighted]:bg-accent-soft"
            // The settings' 「再開」: the pause alone ends. `auto` would also drop 離席中 or 「在席を隠す」 chosen there.
            onSelect={() => void controller.updateProfile({ dnd_until: null })}
          >
            {t("presence.clear")}
          </DropdownMenu.Item>
        )}
      </div>
      {status && (
        <DropdownMenu.Item data-my-custom-status className={cn(ITEM, "mx-1 mb-1 border border-line")} onSelect={() => window.dispatchEvent(new CustomEvent("chikuwa:open-status"))}>
          {status.emoji ? <StatusGlyph controller={controller} emoji={status.emoji} size={16} /> : <Smile aria-hidden size={15} className="text-muted" />}
          <span className="min-w-0 flex-1 truncate">{status.text}</span>
        </DropdownMenu.Item>
      )}
      <DropdownMenu.Separator className="my-1 h-px bg-line" />
      <DropdownMenu.Group aria-label={t("presence.menu")}>
        {choiceItem("auto")}
        {choiceItem("away")}
        <DropdownMenu.Sub>
          <DropdownMenu.SubTrigger role="menuitemradio" aria-checked={choice === "dnd"} data-presence-choice="dnd" className={ITEM}>
            <PresenceDot look="dnd" />
            <ChoiceText value="dnd" />
            {choice === "dnd" && <Check aria-hidden size={15} className="shrink-0 text-accent" />}
            <ChevronRight aria-hidden size={15} className="shrink-0 text-muted" />
          </DropdownMenu.SubTrigger>
          <DropdownMenu.Portal>
            <DropdownMenu.SubContent data-dnd-durations sideOffset={4} collisionPadding={8} className={cn(CONTENT, "min-w-48")}>
              <DropdownMenu.Label className="px-2.5 py-1 text-[11px] font-semibold text-muted">{t("presence.duration.title")}</DropdownMenu.Label>
              {DND_DURATIONS.map((duration) => (
                <DropdownMenu.Item key={duration} data-dnd-duration={duration} className={ITEM} onSelect={() => choose("dnd", duration)}>
                  {durationLabel(duration)}
                </DropdownMenu.Item>
              ))}
            </DropdownMenu.SubContent>
          </DropdownMenu.Portal>
        </DropdownMenu.Sub>
        {choiceItem("invisible")}
      </DropdownMenu.Group>
      <DropdownMenu.Separator className="my-1 h-px bg-line" />
      <DropdownMenu.Item data-my-status-set className={ITEM} onSelect={() => window.dispatchEvent(new CustomEvent("chikuwa:open-status"))}>
        <Smile aria-hidden size={15} className="shrink-0 text-muted" />
        <span className="flex-1">{t("popover.setStatus")}</span>
      </DropdownMenu.Item>
      {attendance && board && (
        <DropdownMenu.Sub>
          <DropdownMenu.SubTrigger data-my-attendance className={ITEM}>
            {current ? (
              <span aria-hidden className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md" style={attendanceColorStyle(current.color)}>
                <StateGlyph state={current} size={12} />
              </span>
            ) : (
              <DoorOpen aria-hidden size={15} className="shrink-0 text-muted" />
            )}
            <span className="min-w-0 flex-1 truncate">{current ? t("presence.attendance", { state: current.label }) : t("presence.attendanceNone")}</span>
            <ChevronRight aria-hidden size={15} className="shrink-0 text-muted" />
          </DropdownMenu.SubTrigger>
          <DropdownMenu.Portal>
            <DropdownMenu.SubContent data-my-attendance-states sideOffset={4} collisionPadding={8} className={cn(CONTENT, "min-w-52")}>
              {myChoices(board, me.id).map((state) => (
                <DropdownMenu.Item
                  key={state.id}
                  role="menuitemradio"
                  aria-checked={mine?.state_id === state.id}
                  className={ITEM}
                  // The same note rule as the pill: the same state keeps it, another clears it.
                  onSelect={() => void chooseMyState(controller, state.id, mine?.state_id === state.id ? (mine?.note ?? null) : null)}
                >
                  <span aria-hidden className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md" style={attendanceColorStyle(state.color)}>
                    <StateGlyph state={state} size={12} />
                  </span>
                  <span className="min-w-0 flex-1 truncate">{state.label}</span>
                  {mine?.state_id === state.id && <Check aria-hidden size={15} className="shrink-0 text-accent" />}
                </DropdownMenu.Item>
              ))}
              {onOpenAttendance && <DropdownMenu.Separator className="my-1 h-px bg-line" />}
              {onOpenAttendance && (
                <DropdownMenu.Item className={cn(ITEM, "text-muted")} onSelect={onOpenAttendance}>
                  <DoorOpen aria-hidden size={15} /> {t("attendance.pill.open")}
                </DropdownMenu.Item>
              )}
            </DropdownMenu.SubContent>
          </DropdownMenu.Portal>
        </DropdownMenu.Sub>
      )}
      <DropdownMenu.Item className={ITEM} onSelect={() => window.dispatchEvent(new CustomEvent("chikuwa:open-profile"))}>
        <UserRoundPen aria-hidden size={15} className="shrink-0 text-muted" />
        <span className="flex-1">{t("settings.section.profile")}</span>
      </DropdownMenu.Item>
      {onSettings && (
        <DropdownMenu.Item className={ITEM} onSelect={onSettings}>
          <SettingsIcon aria-hidden size={15} className="shrink-0 text-muted" />
          <span className="flex-1">{t("settings.title")}</span>
        </DropdownMenu.Item>
      )}
    </>
  );
}

function ChoiceText({ value }: { value: PresenceChoice }) {
  return (
    <span className="min-w-0 flex-1">
      <span className="block truncate">{choiceLabel(value)}</span>
      <span className="block truncate text-[11px] text-muted">{t(HINT_KEYS[value])}</span>
    </span>
  );
}
