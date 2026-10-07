/**
 * 在室状況 (docs/PRESENCE.md §7.1): the quick switch. A small pill with my state (its icon, colour and name; 「在室状況」
 * with an outline while I have none) beside the workspace's name: over the sidebar on a wide window, in the home header
 * and at the top of 「自分」 on a phone-width page. It opens a small menu with all my states (the workspace's, then mine)
 * as one-press items, the note, and 「在室状況を開く」. Only while the board is on, never for guests.
 *
 * Room: the pill never wraps and never pushes the name off. It shows its name while the row has room for the whole
 * workspace name and the whole pill; else only its icon (the name in the tooltip); the workspace name gives up its tail
 * for that icon down to NAME_MIN_EM characters, and below that the pill hides (pillMode).
 *
 * Keyboard: Tab to it, Enter / Space (or ↓) opens, ↑ / ↓ / Home / End move through the states, Enter chooses, Esc
 * closes; ⌘⇧Y / Ctrl+Shift+Y opens it from anywhere (the wide layout's pill; Slack's 「ステータスを設定」 key).
 */
import { Check, CircleDashed, DoorOpen } from "lucide-react";
import { type FormEvent, type KeyboardEvent as ReactKeyboardEvent, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import type { AppController } from "../state/app";
import { entryOf, myChoices, myState } from "./attendance";
import { attendanceColorStyle, StateGlyph } from "./attendanceIcons";
import { chooseMyState } from "./AttendanceView";
import { useStoreUpdates } from "./hooks";
import { Button, cn, Input, PopoverContent, PopoverRoot, PopoverTrigger } from "./primitives";
import { t } from "../i18n";

/** The workspace name keeps at least this many characters (em) before the pill gives way. */
export const NAME_MIN_EM = 4;
/** The icon-only pill's width (px). */
const ICON_WIDTH = 28;
/** The space between the name and the pill (px; the wrapper's margin-left). */
const GAP = 6;

export type PillMode = "full" | "icon" | "hidden";

/**
 * How the pill fits in its row (px). `room` = the row's inner width minus everything but the name and the pill;
 * `nameNatural` = the name's whole width, `nameMin` = its width cut to NAME_MIN_EM; `full` = the pill with its label.
 */
export function pillMode({ room, nameNatural, nameMin, full }: { room: number; nameNatural: number; nameMin: number; full: number }): PillMode {
  if (room - nameNatural - GAP >= full) return "full";
  if (room - Math.min(nameNatural, nameMin) - GAP >= ICON_WIDTH) return "icon";
  return "hidden";
}

/** Measures the row the pill sits in (its parent): the name is the sibling holding [data-title-name]. */
function measure(wrapper: HTMLElement, measurer: HTMLElement): PillMode {
  const row = wrapper.parentElement;
  // Not laid out (a hidden tab, a test's DOM): show it whole; the observer measures again once it is.
  if (!row || row.clientWidth === 0) return "full";
  const style = getComputedStyle(row);
  const gap = Number.parseFloat(style.columnGap) || 0;
  let room = row.clientWidth - (Number.parseFloat(style.paddingLeft) || 0) - (Number.parseFloat(style.paddingRight) || 0);
  let nameNatural = 0;
  let nameMin = 0;
  const children = [...row.children].filter((child) => child instanceof HTMLElement && getComputedStyle(child).position !== "absolute") as HTMLElement[];
  for (const child of children) {
    if (child === wrapper) continue;
    const text = child.querySelector<HTMLElement>("[data-title-name]") ?? (child.hasAttribute("data-title-name") ? child : null);
    if (text) {
      const chrome = child.offsetWidth - text.clientWidth;
      const em = Number.parseFloat(getComputedStyle(text).fontSize) || 14;
      nameNatural = chrome + text.scrollWidth;
      nameMin = chrome + Math.min(text.scrollWidth, NAME_MIN_EM * em);
    } else if (!child.hasAttribute("data-flex-spacer")) {
      room -= child.offsetWidth;
    }
  }
  room -= gap * Math.max(0, children.length - 1);
  return pillMode({ room, nameNatural, nameMin, full: measurer.offsetWidth });
}

export function AttendancePill({ controller, onOpenBoard, placement, collapsed, shortcut = false }: {
  controller: AppController;
  onOpenBoard?: () => void;
  /** sidebar: over the sidebar, pushed to its right edge; inline: right after the name (phone headers). */
  placement: "sidebar" | "inline";
  /** Force the look (tests); else measured. */
  collapsed?: boolean;
  /** Listen for ⌘⇧Y (only one pill on screen should). */
  shortcut?: boolean;
}) {
  useStoreUpdates(controller);
  const store = controller.store;
  const board = store.attendance;
  const meId = store.me?.id ?? null;
  const wrapper = useRef<HTMLDivElement>(null);
  const measurer = useRef<HTMLSpanElement>(null);
  const [measured, setMeasured] = useState<PillMode>("full");
  const [open, setOpen] = useState(false);
  const visible = !!board && !!meId && !controller.isGuest;
  const state = visible ? myState(board, meId) : null;
  const label = state?.label ?? t("attendance.pill.none");

  const remeasure = useCallback(() => {
    if (wrapper.current && measurer.current) setMeasured(measure(wrapper.current, measurer.current));
  }, []);
  useLayoutEffect(() => {
    if (!visible || collapsed !== undefined) return undefined;
    remeasure();
    const row = wrapper.current?.parentElement;
    if (!row || typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(remeasure);
    observer.observe(row);
    return () => observer.disconnect();
  }, [visible, collapsed, remeasure, label, controller.workspaceName]);

  useEffect(() => {
    if (!shortcut || !visible) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !(event.metaKey || event.ctrlKey) || !event.shiftKey || event.altKey || event.key.toLowerCase() !== "y") return;
      // A dialog on top has the keyboard.
      if (document.querySelector('[role="dialog"][data-state="open"], [role="alertdialog"]')) return;
      event.preventDefault();
      setOpen(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [shortcut, visible]);

  if (!visible || !board) return null;
  const mode: PillMode = collapsed === undefined ? measured : collapsed ? "icon" : "full";
  const iconOnly = mode !== "full";
  const sidebar = placement === "sidebar";
  const title = state ? t("attendance.pill.label", { state: state.label }) : t("attendance.pill.menu");
  const face = (
    <>
      {state ? <StateGlyph state={state} size={14} /> : <CircleDashed aria-hidden size={14} className="shrink-0" />}
      <span className="max-w-[8em] truncate">{label}</span>
    </>
  );
  const shape = "inline-flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full text-[12px] font-medium";
  const outline = sidebar ? "border border-sidebar-strong/35 text-sidebar-strong/90 hover:bg-sidebar-strong/10" : "border border-line text-muted hover:bg-panel-2";

  return (
    <div
      ref={wrapper}
      data-tauri-drag-region={sidebar || undefined}
      data-attendance-pill-slot={mode}
      className={cn("relative flex min-w-0 shrink-0", sidebar ? "ml-auto pl-1.5" : "pl-0.5", mode === "hidden" && "invisible w-0 overflow-hidden pl-0")}
    >
      {/* The full pill's width, measured while only the icon shows. */}
      <span ref={measurer} aria-hidden className={cn(shape, "pointer-events-none invisible absolute left-0 top-0 border px-2.5")}>
        {face}
      </span>
      <PopoverRoot open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            data-attendance-pill={state?.kind ?? "none"}
            data-collapsed={iconOnly || undefined}
            aria-label={title}
            aria-haspopup="menu"
            title={iconOnly ? title : `${title}（${shortcutLabel()}）`}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown" && !open) {
                event.preventDefault();
                setOpen(true);
              }
            }}
            style={state ? attendanceColorStyle(state.color) : undefined}
            className={cn(
              shape,
              "transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/70",
              state ? "text-emoji border border-transparent hover:brightness-95" : outline,
              iconOnly ? "w-7 justify-center px-0" : "px-2.5",
            )}
          >
            {iconOnly ? (state ? <StateGlyph state={state} size={15} /> : <CircleDashed aria-hidden size={15} />) : face}
          </button>
        </PopoverTrigger>
        {open && (
          // The menu focuses the current state itself (rather than Radix's first focusable).
          <PopoverContent align={sidebar ? "end" : "start"} className="w-72 p-1.5" onOpenAutoFocus={(event) => event.preventDefault()}>
            <PillMenu controller={controller} onDone={() => setOpen(false)} onOpenBoard={onOpenBoard ? () => { setOpen(false); onOpenBoard(); } : undefined} />
          </PopoverContent>
        )}
      </PopoverRoot>
    </div>
  );
}

function shortcutLabel(): string {
  return typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘⇧Y" : "Ctrl+Shift+Y";
}

/** The menu: my states as one-press items, the note, 「在室状況を開く」. */
function PillMenu({ controller, onDone, onOpenBoard }: { controller: AppController; onDone: () => void; onOpenBoard?: () => void }) {
  const store = controller.store;
  const board = store.attendance!;
  const meId = store.me?.id ?? null;
  const mine = entryOf(board, meId ?? "");
  const [note, setNote] = useState(mine?.note ?? "");
  const [busy, setBusy] = useState(false);
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const items = list.current;
    (items?.querySelector<HTMLElement>('[role="menuitemradio"][aria-checked="true"]') ?? items?.querySelector<HTMLElement>('[role="menuitemradio"]'))?.focus();
  }, []);
  const choices = myChoices(board, meId);

  const choose = async (stateId: string) => {
    if (busy) return;
    setBusy(true);
    const same = mine?.state_id === stateId;
    const ok = await chooseMyState(controller, stateId, same ? (mine?.note ?? null) : null);
    setBusy(false);
    if (ok) onDone();
  };
  const saveNote = async (event: FormEvent) => {
    event.preventDefault();
    if (!mine || busy) return;
    setBusy(true);
    const ok = await chooseMyState(controller, mine.state_id, note.trim() || null);
    setBusy(false);
    if (ok) onDone();
  };
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const items = [...(list.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? [])];
    if (!items.length) return;
    const index = items.indexOf(document.activeElement as HTMLElement);
    const next =
      event.key === "ArrowDown" ? (index + 1) % items.length
      : event.key === "ArrowUp" ? (index <= 0 ? items.length - 1 : index - 1)
      : event.key === "Home" ? 0
      : event.key === "End" ? items.length - 1
      : null;
    if (next === null) return;
    event.preventDefault();
    items[next]!.focus();
  };

  return (
    <div data-attendance-menu>
      <div className="px-2 pb-1 pt-0.5 text-[11px] font-semibold text-muted">{t("attendance.pill.menu")}</div>
      <div ref={list} role="menu" aria-label={t("attendance.choose")} onKeyDown={onKeyDown} className="flex flex-col">
        {choices.map((state, index) => {
          const current = mine?.state_id === state.id;
          return (
            <button
              key={state.id}
              type="button"
              role="menuitemradio"
              aria-checked={current}
              data-attendance-choice={state.id}
              disabled={busy}
              tabIndex={current || (!choices.some((s) => s.id === mine?.state_id) && index === 0) ? 0 : -1}
              onClick={() => void choose(state.id)}
              className={cn(
                "flex h-9 w-full items-center gap-2.5 rounded-lg px-2 text-left text-sm outline-none transition-colors hover:bg-panel-2 focus-visible:bg-panel-2 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/60 disabled:opacity-60",
                current && "font-semibold",
              )}
            >
              <span aria-hidden className="text-emoji inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md" style={attendanceColorStyle(state.color)}>
                <StateGlyph state={state} size={14} />
              </span>
              <span className="min-w-0 flex-1 truncate">{state.label}</span>
              {state.owner_id && <span className="text-[11px] text-muted">{t("attendance.personal")}</span>}
              {current && <Check aria-hidden size={15} className="shrink-0 text-accent" />}
            </button>
          );
        })}
      </div>
      {mine && (
        <form onSubmit={(event) => void saveNote(event)} className="mt-1.5 flex items-center gap-1.5 border-t border-line px-1 pt-2">
          <Input
            aria-label={t("attendance.note")}
            placeholder={t("attendance.notePlaceholder")}
            value={note}
            maxLength={100}
            onChange={(event) => setNote(event.target.value)}
            className="h-8 text-[13px]"
          />
          <Button type="submit" size="sm" variant="secondary" disabled={busy || (note.trim() || null) === (mine.note ?? null)}>
            {t("common.save")}
          </Button>
        </form>
      )}
      {onOpenBoard && <div role="separator" className="mx-1 my-1.5 h-px bg-line" />}
      {onOpenBoard && (
        <button
          type="button"
          onClick={onOpenBoard}
          data-attendance-open-board
          className="flex h-9 w-full items-center gap-2 rounded-lg px-2 text-left text-sm text-muted outline-none hover:bg-panel-2 hover:text-ink focus-visible:bg-panel-2 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/60"
        >
          <DoorOpen aria-hidden size={15} /> {t("attendance.pill.open")}
        </button>
      )}
    </div>
  );
}
