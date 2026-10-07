import { ContextMenu } from "radix-ui";
import { ArrowDown, ArrowUp, ChevronDown, LogOut, Plus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import type { AppController } from "../state/app";
import { dropIndex, gapForPointer, hostLabel, signInName, type WorkspaceEntry } from "../state/workspaces";
import { overlayTitleBar, RAIL_WIDTH, TITLE_ROW_HEIGHT } from "../platform/env";
import { Button, cn, Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger, Modal, modKey } from "./primitives";
import { useMediaQuery } from "./hooks";
import { WorkspaceIcon } from "./workspaceIcons";
import { t } from "../i18n";

const MENU = "rx-popover z-50 min-w-48 rounded-xl border border-line bg-canvas p-1 text-ink shadow-xl";
const ITEM = "flex select-none items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm outline-none data-[highlighted]:bg-accent-soft data-[disabled]:opacity-40";
/** Pixels the pointer must travel before a press on a tile becomes a drag (a click stays a click). */
const DRAG_THRESHOLD = 4;
/** How long the tiles take to slide apart, and the lifted tile to land (ms). */
export const DRAG_SLIDE_MS = 120;
const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

interface Drag {
  serverUrl: string;
  from: number;
  pointerId: number;
  startY: number;
  /** Past the threshold: the tile is lifted, the others slide apart, and the click that ends it is swallowed. */
  moving: boolean;
  /** The slot the tile would drop into (0 = above the first tile, n = below the last). */
  gap: number;
  /** The tiles' tops when the drag began (viewport px): the slots, measured before anything slides. */
  tops: number[];
  height: number;
  /** Where the pressed tile's box sits (viewport px), for the lifted copy. */
  left: number;
  width: number;
  /** Pointer y minus the tile's top at the press: the lifted copy keeps that grip. */
  grip: number;
  /** The lifted copy's top now. */
  ghostTop: number;
  /**
   * After the drop or Esc: the lifted copy glides to its slot, then the drag ends. "drop" — the list is already in
   * its new order, so nothing else may animate; "cancel" — the tiles slide back.
   */
  settling: "drop" | "cancel" | null;
}

/**
 * Where tile `index` is drawn while a drag is under way (px down from its own slot): the tiles between the dragged one
 * and its drop slot move one place to open a gap there, and the dragged tile's own (dimmed) place moves into that gap.
 */
export function dragOffset(drag: Pick<Drag, "from" | "gap" | "tops">, index: number): number {
  const target = dropIndex(drag.from, drag.gap);
  const at = (i: number) => drag.tops[i] ?? 0;
  if (index === drag.from) return at(target) - at(drag.from);
  if (drag.from < target && index > drag.from && index <= target) return at(index - 1) - at(index);
  if (target < drag.from && index >= target && index < drag.from) return at(index + 1) - at(index);
  return 0;
}

export { RAIL_WIDTH };

/**
 * M16c: the workspaces down the left edge (Slack): number / dot for unread, ⌘1 … ⌘9, + to add (WORKSPACES.md §5).
 * M93: drag a tile (or Alt+↑/↓ on a focused one, or its menu) to reorder; the order is saved on this device. Tiles show
 * the admin's icon when the workspace has one. While dragging, a lifted copy follows the pointer and the other tiles slide
 * apart where it would land (Slack / Discord); Esc puts everything back.
 */
export function WorkspaceRail({ controller }: { controller: AppController }) {
  const [leaving, setLeaving] = useState<WorkspaceEntry | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [focusAfterMove, setFocusAfterMove] = useState<string | null>(null);
  const tiles = useRef(new Map<string, HTMLElement>());
  const swallowClick = useRef(false);
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The tile that just landed shows again at once, without its usual opacity fade (no flicker as the lifted copy goes).
  const [landing, setLanding] = useState<string | null>(null);
  const reducedMotion = useMediaQuery(REDUCED_MOTION);
  // macOS: the overlay window buttons sit in the title row across the top (Slack); the rail keeps its 68 px and starts
  // below that row, whose cell over the rail has the top bar's colour on every screen (the other screens draw the rest
  // of the row, ScreenTitleRow). Also in full screen: macOS shows the buttons all through the exit animation, before
  // the app could learn that full screen is ending (README「ウィンドウのタイトルバー」).
  const trafficLights = overlayTitleBar();
  const entries = controller.workspaces;

  // A tile moved from the keyboard keeps the focus (the list re-renders in its new order).
  useEffect(() => {
    if (!focusAfterMove) return;
    tiles.current.get(focusAfterMove)?.querySelector<HTMLButtonElement>("button[data-workspace-tile]")?.focus();
    setFocusAfterMove(null);
  }, [focusAfterMove]);

  useEffect(
    () => () => {
      if (settleTimer.current) clearTimeout(settleTimer.current);
    },
    [],
  );

  const lifted = drag?.moving === true && drag.settling === null;
  // The grabbing hand everywhere while a tile is lifted (the pointer may leave the tile).
  useEffect(() => {
    if (!lifted) return;
    document.body.classList.add("workspace-dragging");
    return () => document.body.classList.remove("workspace-dragging");
  }, [lifted]);

  const move = (entry: WorkspaceEntry, to: number, keepFocus: boolean) => {
    const from = entries.findIndex((e) => e.serverUrl === entry.serverUrl);
    const target = Math.max(0, Math.min(entries.length - 1, to));
    if (from < 0 || target === from) return;
    controller.moveWorkspace(entry.serverUrl, target);
    setAnnouncement(t("rail.moved", { name: entry.name, position: target + 1 }));
    if (keepFocus) setFocusAfterMove(entry.serverUrl);
  };

  const finishSettle = () => {
    if (settleTimer.current) clearTimeout(settleTimer.current);
    settleTimer.current = null;
    if (drag?.moving) setLanding(drag.serverUrl);
    setDrag(null);
  };
  useEffect(() => {
    if (!landing) return;
    let second = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => setLanding(null));
    });
    return () => {
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
    };
  }, [landing]);
  /** The lifted copy glides to `slot` (an index in the order the tiles are drawn in once the drag ends), then goes. */
  const settle = (current: Drag, kind: "drop" | "cancel", slot: number) => {
    if (reducedMotion) {
      finishSettle();
      return;
    }
    setDrag({ ...current, settling: kind, ghostTop: current.tops[slot] ?? current.ghostTop });
    if (settleTimer.current) clearTimeout(settleTimer.current);
    settleTimer.current = setTimeout(finishSettle, DRAG_SLIDE_MS + 20);
  };

  const cancelDrag = () => {
    if (!drag || drag.settling) return;
    if (drag.moving) settle(drag, "cancel", drag.from);
    else setDrag(null);
  };
  // Esc from anywhere (WebKit does not focus a pressed button, so the key may not reach the rail).
  useEffect(() => {
    if (!lifted) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      cancelDrag();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  const onPointerDown = (entry: WorkspaceEntry, index: number) => (event: React.PointerEvent<HTMLButtonElement>) => {
    swallowClick.current = false; // a new press: whatever the last drag left behind is over
    if (event.button !== 0 || entries.length < 2) return;
    if (drag?.settling) finishSettle();
    const rects = entries.map((e) => tiles.current.get(e.serverUrl)?.getBoundingClientRect());
    const own = rects[index];
    if (!own) return;
    const button = event.currentTarget.getBoundingClientRect();
    setDrag({
      serverUrl: entry.serverUrl,
      from: index,
      pointerId: event.pointerId,
      startY: event.clientY,
      moving: false,
      gap: index,
      tops: rects.map((r, i) => r?.top ?? own.top + (i - index) * (own.height + 12)),
      height: own.height,
      left: button.width > 0 ? button.left : own.left + (own.width - 40) / 2,
      width: button.width > 0 ? button.width : 40,
      grip: event.clientY - own.top,
      ghostTop: own.top,
      settling: null,
    });
  };
  const onPointerMove = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (!drag || drag.settling || event.pointerId !== drag.pointerId) return;
    if (!drag.moving && Math.abs(event.clientY - drag.startY) < DRAG_THRESHOLD) return;
    if (!drag.moving) event.currentTarget.setPointerCapture?.(event.pointerId);
    // The lifted copy follows the pointer, kept within half a slot of the first and last tiles.
    const first = drag.tops[0] ?? 0;
    const last = drag.tops[drag.tops.length - 1] ?? first;
    const reach = drag.height / 2 + 6;
    const ghostTop = Math.max(first - reach, Math.min(last + reach, event.clientY - drag.grip));
    const gap = gapForPointer(ghostTop + drag.height / 2, drag.tops.map((top) => top + drag.height / 2));
    setDrag({ ...drag, moving: true, gap, ghostTop });
  };
  const onPointerUp = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (!drag || drag.settling || event.pointerId !== drag.pointerId) return;
    const finished = drag;
    if (!finished.moving) {
      setDrag(null);
      return;
    }
    swallowClick.current = true; // the click that ends a drag does not switch workspaces
    const target = dropIndex(finished.from, finished.gap);
    const entry = entries.find((e) => e.serverUrl === finished.serverUrl);
    if (entry) move(entry, target, false);
    settle(finished, "drop", target);
  };
  const onPointerCancel = () => {
    if (drag && !drag.settling) cancelDrag();
  };

  const draggedEntry = drag?.moving ? entries.find((e) => e.serverUrl === drag.serverUrl) : undefined;
  // The tiles slide while lifted and back after Esc; not in the frame the list takes its new order, nor with reduced motion.
  const slide = drag?.moving && !reducedMotion && drag.settling !== "drop" ? `transform ${DRAG_SLIDE_MS}ms ease` : undefined;

  return (
    <nav aria-label={t("settings.section.workspaces")} className="flex w-[68px] shrink-0 flex-col" data-drop-gap={lifted ? drag.gap : undefined}>
      {trafficLights && (
        <div
          data-tauri-drag-region
          data-testid="rail-title-cell"
          className="shrink-0 bg-sidebar"
          style={{ height: TITLE_ROW_HEIGHT }}
        />
      )}
      <div data-tauri-drag-region data-testid="rail-tiles" className="flex min-h-0 flex-1 flex-col items-center gap-3 overflow-y-auto border-r border-black/20 bg-sidebar-rail py-3">
        {entries.map((entry, index) => (
          <WorkspaceTile
            key={entry.serverUrl}
            controller={controller}
            entry={entry}
            index={index}
            count={entries.length}
            tileRef={(node) => {
              if (node) tiles.current.set(entry.serverUrl, node);
              else tiles.current.delete(entry.serverUrl);
            }}
            placeholder={drag?.moving === true && drag.serverUrl === entry.serverUrl}
            landing={landing === entry.serverUrl}
            offset={lifted ? dragOffset(drag, index) : 0}
            transition={slide}
            onPointerDown={onPointerDown(entry, index)}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerCancel}
            onOpen={() => {
              if (swallowClick.current) {
                swallowClick.current = false;
                return;
              }
              void controller.switchWorkspace(entry.serverUrl);
            }}
            onMove={(to) => move(entry, to, true)}
            onLeave={() => setLeaving(entry)}
          />
        ))}
        <button
          type="button"
          title={t("settings.workspaces.add")}
          aria-label={t("settings.workspaces.add")}
          onClick={() => controller.beginAddWorkspace()}
          className={cn("flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-dashed border-sidebar-strong/30 text-sidebar-strong/70 transition-colors hover:border-sidebar-strong/60 hover:text-sidebar-strong", controller.addingWorkspace && "border-solid border-sidebar-strong bg-sidebar-strong/10 text-sidebar-strong")}
        >
          <Plus size={18} />
        </button>
      </div>
      {drag &&
        draggedEntry &&
        createPortal(
          <div
            data-testid="workspace-drag-ghost"
            aria-hidden
            className={cn(
              "pointer-events-none fixed z-[60] flex items-center justify-center rounded-xl text-[15px] font-bold text-white",
              drag.settling ? "scale-100 shadow-sm" : "scale-110 shadow-[0_10px_24px_rgba(0,0,0,0.45)] ring-2 ring-white/70",
            )}
            style={{
              left: drag.left,
              top: drag.ghostTop,
              width: drag.width,
              height: drag.height,
              cursor: "grabbing",
              transition: reducedMotion
                ? "none"
                : drag.settling
                  ? `top ${DRAG_SLIDE_MS}ms ease, scale ${DRAG_SLIDE_MS}ms ease, box-shadow ${DRAG_SLIDE_MS}ms ease`
                  : "scale 80ms ease",
            }}
          >
            <WorkspaceIcon serverUrl={draggedEntry.serverUrl} version={draggedEntry.iconVersion} name={draggedEntry.name} colorKey={draggedEntry.workspaceId ?? draggedEntry.serverUrl} className="h-10 w-10 rounded-xl" />
          </div>,
          document.body,
        )}
      <span role="status" aria-live="polite" className="sr-only">
        {announcement}
      </span>
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
    </nav>
  );
}

interface TileProps {
  controller: AppController;
  entry: WorkspaceEntry;
  index: number;
  count: number;
  tileRef: (node: HTMLElement | null) => void;
  /** This tile is the one being dragged: its place shows as a dimmed empty slot (the lifted copy is drawn apart). */
  placeholder: boolean;
  landing: boolean;
  /** px to draw the tile away from its slot while another tile is dragged past it. */
  offset: number;
  transition: string | undefined;
  onPointerDown: (event: React.PointerEvent<HTMLButtonElement>) => void;
  onPointerMove: (event: React.PointerEvent<HTMLButtonElement>) => void;
  onPointerUp: (event: React.PointerEvent<HTMLButtonElement>) => void;
  onPointerCancel: () => void;
  onOpen: () => void;
  onMove: (to: number) => void;
  onLeave: () => void;
}

function WorkspaceTile({ controller, entry, index, count, tileRef, placeholder, landing, offset, transition, onPointerDown, onPointerMove, onPointerUp, onPointerCancel, onOpen, onMove, onLeave }: TileProps) {
  const active = entry.serverUrl === controller.activeServer && !controller.addingWorkspace;
  const signedIn = controller.isSignedIn(entry.serverUrl);
  const { badge, unread } = active ? { badge: 0, unread: false } : controller.workspaceUnread(entry.serverUrl);
  const shortcut = index < 9 ? ` (${modKey()}+${index + 1})` : "";
  const reorderHint = count > 1 ? `\n${t("rail.reorderHint")}` : "";
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>
        <div
          ref={tileRef}
          data-workspace={entry.serverUrl}
          className="relative flex w-full shrink-0 justify-center"
          style={{ transform: offset ? `translateY(${offset}px)` : undefined, transition }}
        >
          {placeholder && (
            <span
              data-testid="workspace-drop-gap"
              aria-hidden
              className="pointer-events-none absolute top-0 h-10 w-10 rounded-xl border-2 border-dashed border-sidebar-strong/35 bg-sidebar-strong/15"
            />
          )}
          {/* Slack's marker: a bar on the left edge for the open workspace, a short one for unread. */}
          <span className={cn("absolute left-0 top-1/2 w-1 -translate-y-1/2 rounded-r-full bg-sidebar-strong transition-all", active ? "h-8" : unread ? "h-2" : "h-0")} />
          <button
            type="button"
            data-workspace-tile
            title={`${entry.name}${shortcut}${signedIn || active ? "" : t("rail.signInNeeded")}${reorderHint}`}
            aria-label={entry.name}
            aria-current={active ? "true" : undefined}
            aria-keyshortcuts={count > 1 ? "Alt+ArrowUp Alt+ArrowDown" : undefined}
            onClick={onOpen}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerCancel}
            onKeyDown={(event) => {
              if (!event.altKey || event.metaKey || event.ctrlKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
              event.preventDefault();
              onMove(index + (event.key === "ArrowUp" ? -1 : 1));
            }}
            className={cn(
              "relative flex h-10 w-10 touch-none select-none items-center justify-center rounded-xl text-[15px] font-bold text-white shadow-sm transition-all",
              active ? "shadow-none" : "opacity-85 hover:opacity-100",
              !signedIn && !active && "opacity-45 grayscale",
              placeholder && "cursor-grabbing opacity-0 transition-none",
              landing && "transition-none",
            )}
          >
            <WorkspaceIcon serverUrl={entry.serverUrl} version={entry.iconVersion} name={entry.name} colorKey={entry.workspaceId ?? entry.serverUrl} className="h-10 w-10 rounded-xl" />
            {/* The open workspace's frame: a 2 px line 2 px out from the tile, its own box with a transparent gap. Not
                ring + ring-offset: those are two box-shadows stacked, and along the tile's rounded edge the ring's
                colour showed through the offset's anti-aliased inner edge as a thin line inside the frame (dark on the
                light sidebar, light on the dark one), plainly around an icon with a transparent background. The tile's
                own shadow goes too (it would show in the gap). */}
            {active && <span aria-hidden data-testid="workspace-active-frame" className="pointer-events-none absolute -inset-1 rounded-2xl border-2 border-sidebar-strong" />}
            {badge > 0 ? (
              <span className="absolute -right-1.5 -top-1.5 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-rose-500 px-1 text-[10px] font-bold text-white ring-2 ring-sidebar-rail">
                {badge > 99 ? "99+" : badge}
              </span>
            ) : null}
          </button>
        </div>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className={MENU}>
          <ContextMenu.Label className="px-2.5 py-1 text-xs text-muted">
            {signInName(entry)} @ {hostLabel(entry.serverUrl)}
          </ContextMenu.Label>
          <ContextMenu.Item className={ITEM} onSelect={() => void controller.switchWorkspace(entry.serverUrl)}>{t("dialogs.open")}</ContextMenu.Item>
          {count > 1 && (
            <>
              <ContextMenu.Item className={ITEM} disabled={index === 0} onSelect={() => onMove(index - 1)}>
                <ArrowUp size={14} /> {t("common.moveUp")}
              </ContextMenu.Item>
              <ContextMenu.Item className={ITEM} disabled={index === count - 1} onSelect={() => onMove(index + 1)}>
                <ArrowDown size={14} /> {t("common.moveDown")}
              </ContextMenu.Item>
            </>
          )}
          <ContextMenu.Separator className="my-1 h-px bg-line" />
          <ContextMenu.Item className={cn(ITEM, "text-danger")} onSelect={signedIn || active ? onLeave : () => void controller.signOutWorkspace(entry.serverUrl)}>
            {signedIn || active ? t("rail.signOutMenu") : t("rail.removeFromList")}
          </ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

/** The workspace name over the sidebar: who is signed in where, 「ワークスペースを追加…」 and ログアウト. */
export function WorkspaceMenu({ controller }: { controller: AppController }) {
  const entry = controller.activeEntry;
  const name = controller.workspaceName;
  return (
    <Menu>
      <MenuTrigger asChild>
        <button type="button" className="flex min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-left text-sm font-semibold text-sidebar-strong hover:bg-sidebar-strong/10">
          {/* With the rail on screen (two or more workspaces) its tiles already show the icon. */}
          {!controller.showsRail && <WorkspaceIcon serverUrl={entry?.serverUrl} version={entry?.iconVersion} name={name} colorKey={entry?.workspaceId ?? entry?.serverUrl ?? name} className="h-6 w-6 rounded-md text-[11px]" />}
          <span data-title-name className="truncate">{name}</span>
          <ChevronDown size={14} className="shrink-0 opacity-70" />
        </button>
      </MenuTrigger>
      <MenuContent align="start" className="min-w-60">
        {entry && <div className="px-2.5 pb-1 pt-1.5 text-xs text-muted">{signInName(entry)} @ {hostLabel(entry.serverUrl)}</div>}
        {controller.multiWorkspace && (
          <MenuItem onSelect={() => controller.beginAddWorkspace()}>
            <Plus size={15} /> {t("home.addWorkspace")}
          </MenuItem>
        )}
        <MenuSeparator />
        <MenuItem className="text-danger" onSelect={() => void controller.logout()}>
          <LogOut size={15} /> {controller.workspaces.length > 1 ? t("settings.logoutFrom", { workspace: name }) : t("common.logout")}
        </MenuItem>
      </MenuContent>
    </Menu>
  );
}
