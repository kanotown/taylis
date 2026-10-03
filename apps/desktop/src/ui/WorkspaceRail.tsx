import { ContextMenu } from "radix-ui";
import { ArrowDown, ArrowUp, ChevronDown, LogOut, Plus } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { AppController } from "../state/app";
import { dropIndex, gapForPointer, hostLabel, type WorkspaceEntry } from "../state/workspaces";
import { TRAFFIC_LIGHTS_INSET } from "../platform/env";
import { useReservesTrafficLights } from "../platform/windowState";
import { Button, cn, Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger, Modal, modKey } from "./primitives";
import { WorkspaceIcon } from "./workspaceIcons";

const MENU = "rx-popover z-50 min-w-48 rounded-xl border border-line bg-canvas p-1 text-ink shadow-xl";
const ITEM = "flex select-none items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm outline-none data-[highlighted]:bg-accent-soft data-[disabled]:opacity-40";
/** Pixels the pointer must travel before a press on a tile becomes a drag (a click stays a click). */
const DRAG_THRESHOLD = 4;

interface Drag {
  serverUrl: string;
  from: number;
  pointerId: number;
  startY: number;
  /** Past the threshold: the indicator shows and the click that ends it is swallowed. */
  moving: boolean;
  /** The slot the indicator shows (0 = above the first tile, n = below the last). */
  gap: number;
}

/**
 * M16c: the workspaces down the left edge (Slack): number / dot for unread, ⌘1 … ⌘9, + to add (WORKSPACES.md §5).
 * M93: drag a tile (or Alt+↑/↓ on a focused one, or its menu) to reorder; the order is saved on this device. Tiles show
 * the admin's icon when the workspace has one.
 */
export function WorkspaceRail({ controller }: { controller: AppController }) {
  const [leaving, setLeaving] = useState<WorkspaceEntry | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [focusAfterMove, setFocusAfterMove] = useState<string | null>(null);
  const tiles = useRef(new Map<string, HTMLElement>());
  const swallowClick = useRef(false);
  // macOS: keep all three overlay window buttons inside the rail, with space below them; not in full screen (M93).
  const trafficLights = useReservesTrafficLights();
  const entries = controller.workspaces;

  // A tile moved from the keyboard keeps the focus (the list re-renders in its new order).
  useEffect(() => {
    if (!focusAfterMove) return;
    tiles.current.get(focusAfterMove)?.querySelector<HTMLButtonElement>("button[data-workspace-tile]")?.focus();
    setFocusAfterMove(null);
  }, [focusAfterMove]);

  const move = (entry: WorkspaceEntry, to: number, keepFocus: boolean) => {
    const from = entries.findIndex((e) => e.serverUrl === entry.serverUrl);
    const target = Math.max(0, Math.min(entries.length - 1, to));
    if (from < 0 || target === from) return;
    controller.moveWorkspace(entry.serverUrl, target);
    setAnnouncement(`${entry.name} を ${target + 1} 番目に移動しました`);
    if (keepFocus) setFocusAfterMove(entry.serverUrl);
  };

  const gapAt = (y: number): number =>
    gapForPointer(
      y,
      entries.map((e) => {
        const rect = tiles.current.get(e.serverUrl)?.getBoundingClientRect();
        return rect ? rect.top + rect.height / 2 : Number.POSITIVE_INFINITY;
      }),
    );

  const onPointerDown = (entry: WorkspaceEntry, index: number) => (event: React.PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0 || entries.length < 2) return;
    setDrag({ serverUrl: entry.serverUrl, from: index, pointerId: event.pointerId, startY: event.clientY, moving: false, gap: index });
  };
  const onPointerMove = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    if (!drag.moving && Math.abs(event.clientY - drag.startY) < DRAG_THRESHOLD) return;
    if (!drag.moving) event.currentTarget.setPointerCapture?.(event.pointerId);
    const gap = gapAt(event.clientY);
    if (!drag.moving || gap !== drag.gap) setDrag({ ...drag, moving: true, gap });
  };
  const onPointerUp = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const finished = drag;
    setDrag(null);
    if (!finished.moving) return;
    swallowClick.current = true; // the click that ends a drag does not switch workspaces
    const entry = entries.find((e) => e.serverUrl === finished.serverUrl);
    if (entry) move(entry, dropIndex(finished.from, finished.gap), false);
  };
  const cancelDrag = () => setDrag(null);
  // No indicator in the two slots next to the dragged tile: dropping there keeps the order.
  const indicatorAt = drag?.moving && drag.gap !== drag.from && drag.gap !== drag.from + 1 ? drag.gap : null;

  return (
    <nav
      aria-label="ワークスペース"
      data-tauri-drag-region
      className="flex w-[68px] shrink-0 flex-col items-center gap-3 overflow-y-auto border-r border-black/20 bg-[color-mix(in_srgb,var(--sidebar)_78%,black)] py-3"
      style={trafficLights ? { paddingTop: 48, width: TRAFFIC_LIGHTS_INSET } : undefined}
      onKeyDown={(event) => {
        if (event.key === "Escape" && drag) cancelDrag();
      }}
    >
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
          dragging={drag?.moving === true && drag.serverUrl === entry.serverUrl}
          indicatorBefore={indicatorAt === index}
          indicatorAfter={indicatorAt === entries.length && index === entries.length - 1}
          onPointerDown={onPointerDown(entry, index)}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={cancelDrag}
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
        title="ワークスペースを追加"
        aria-label="ワークスペースを追加"
        onClick={() => controller.beginAddWorkspace()}
        className={cn("flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-dashed border-white/30 text-white/70 transition-colors hover:border-white/60 hover:text-white", controller.addingWorkspace && "border-solid border-white bg-white/10 text-white")}
      >
        <Plus size={18} />
      </button>
      <span role="status" aria-live="polite" className="sr-only">
        {announcement}
      </span>
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
    </nav>
  );
}

interface TileProps {
  controller: AppController;
  entry: WorkspaceEntry;
  index: number;
  count: number;
  tileRef: (node: HTMLElement | null) => void;
  dragging: boolean;
  indicatorBefore: boolean;
  indicatorAfter: boolean;
  onPointerDown: (event: React.PointerEvent<HTMLButtonElement>) => void;
  onPointerMove: (event: React.PointerEvent<HTMLButtonElement>) => void;
  onPointerUp: (event: React.PointerEvent<HTMLButtonElement>) => void;
  onPointerCancel: () => void;
  onOpen: () => void;
  onMove: (to: number) => void;
  onLeave: () => void;
}

/** The drop indicator: a white bar in the middle of the 12 px gap between two tiles. */
function DropIndicator({ edge }: { edge: "top" | "bottom" }) {
  return (
    <span
      data-testid="workspace-drop-indicator"
      aria-hidden
      className={cn("pointer-events-none absolute inset-x-2 h-[3px] rounded-full bg-white shadow-[0_0_0_1px_rgba(0,0,0,0.25)]", edge === "top" ? "-top-[7.5px]" : "-bottom-[7.5px]")}
    />
  );
}

function WorkspaceTile({ controller, entry, index, count, tileRef, dragging, indicatorBefore, indicatorAfter, onPointerDown, onPointerMove, onPointerUp, onPointerCancel, onOpen, onMove, onLeave }: TileProps) {
  const active = entry.serverUrl === controller.activeServer && !controller.addingWorkspace;
  const signedIn = controller.isSignedIn(entry.serverUrl);
  const { badge, unread } = active ? { badge: 0, unread: false } : controller.workspaceUnread(entry.serverUrl);
  const shortcut = index < 9 ? ` (${modKey()}+${index + 1})` : "";
  const reorderHint = count > 1 ? "\nドラッグ、または Alt+↑/↓ で並べ替え" : "";
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>
        <div ref={tileRef} data-workspace={entry.serverUrl} className="relative flex w-full shrink-0 justify-center">
          {indicatorBefore && <DropIndicator edge="top" />}
          {indicatorAfter && <DropIndicator edge="bottom" />}
          {/* Slack's marker: a bar on the left edge for the open workspace, a short one for unread. */}
          <span className={cn("absolute left-0 top-1/2 w-1 -translate-y-1/2 rounded-r-full bg-white transition-all", active ? "h-8" : unread ? "h-2" : "h-0")} />
          <button
            type="button"
            data-workspace-tile
            title={`${entry.name}${shortcut}${signedIn || active ? "" : " — サインインが必要です"}${reorderHint}`}
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
              active ? "ring-2 ring-white ring-offset-2 ring-offset-[color-mix(in_srgb,var(--sidebar)_78%,black)]" : "opacity-85 hover:opacity-100",
              !signedIn && !active && "opacity-45 grayscale",
              dragging && "cursor-grabbing opacity-40",
            )}
          >
            <WorkspaceIcon serverUrl={entry.serverUrl} version={entry.iconVersion} name={entry.name} colorKey={entry.workspaceId ?? entry.serverUrl} className="h-10 w-10 rounded-xl" />
            {badge > 0 ? (
              <span className="absolute -right-1.5 -top-1.5 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-rose-500 px-1 text-[10px] font-bold text-white ring-2 ring-[color-mix(in_srgb,var(--sidebar)_78%,black)]">
                {badge > 99 ? "99+" : badge}
              </span>
            ) : null}
          </button>
        </div>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className={MENU}>
          <ContextMenu.Label className="px-2.5 py-1 text-xs text-muted">
            {entry.username} @ {hostLabel(entry.serverUrl)}
          </ContextMenu.Label>
          <ContextMenu.Item className={ITEM} onSelect={() => void controller.switchWorkspace(entry.serverUrl)}>開く</ContextMenu.Item>
          {count > 1 && (
            <>
              <ContextMenu.Item className={ITEM} disabled={index === 0} onSelect={() => onMove(index - 1)}>
                <ArrowUp size={14} /> 上へ移動
              </ContextMenu.Item>
              <ContextMenu.Item className={ITEM} disabled={index === count - 1} onSelect={() => onMove(index + 1)}>
                <ArrowDown size={14} /> 下へ移動
              </ContextMenu.Item>
            </>
          )}
          <ContextMenu.Separator className="my-1 h-px bg-line" />
          <ContextMenu.Item className={cn(ITEM, "text-danger")} onSelect={signedIn || active ? onLeave : () => void controller.signOutWorkspace(entry.serverUrl)}>
            {signedIn || active ? "サインアウト…" : "一覧から外す"}
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
        <button type="button" className="flex min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-left text-sm font-semibold text-white hover:bg-white/10">
          <WorkspaceIcon serverUrl={entry?.serverUrl} version={entry?.iconVersion} name={name} colorKey={entry?.workspaceId ?? entry?.serverUrl ?? name} className="h-6 w-6 rounded-md text-[11px]" />
          <span className="truncate">{name}</span>
          <ChevronDown size={14} className="shrink-0 opacity-70" />
        </button>
      </MenuTrigger>
      <MenuContent align="start" className="min-w-60">
        {entry && <div className="px-2.5 pb-1 pt-1.5 text-xs text-muted">{entry.username} @ {hostLabel(entry.serverUrl)}</div>}
        {controller.multiWorkspace && (
          <MenuItem onSelect={() => controller.beginAddWorkspace()}>
            <Plus size={15} /> ワークスペースを追加…
          </MenuItem>
        )}
        <MenuSeparator />
        <MenuItem className="text-danger" onSelect={() => void controller.logout()}>
          <LogOut size={15} /> {controller.workspaces.length > 1 ? `${name} からログアウト` : "ログアウト"}
        </MenuItem>
      </MenuContent>
    </Menu>
  );
}
