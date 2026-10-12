/**
 * The tab bar of the wide layout (docs/MOBILE_UI.md §19) and the 「新しいタブで開く」 gestures shared by the sidebar rows,
 * the places rail, the threads list and the Docs tree: a middle click, ⌘-click (Ctrl-click on Windows / Linux) and the
 * right-click menu's item. The menu's item and ⌘-click open the new tab in front (the user's wish); a middle click opens
 * it behind, as a browser does. Shift turns either click the other way.
 */
import { ContextMenu } from "radix-ui";
import { Plus, X } from "lucide-react";
import { type DragEvent, type KeyboardEvent, type MouseEvent, type ReactNode, useRef, useState } from "react";

import { isMacPlatform } from "./historyShortcuts";
import { cn, useScrollRow } from "./primitives";
import { openContextMenuByKey } from "./SidebarMenus";
import { t } from "../i18n";

/** ⌘-click on a Mac, Ctrl-click elsewhere (a Mac's Ctrl-click is its right click). */
export function isNewTabClick(event: Pick<MouseEvent, "metaKey" | "ctrlKey">, mac = isMacPlatform()): boolean {
  return mac ? event.metaKey : event.ctrlKey;
}

/**
 * A middle click opens in a new tab (Shift: in front). Its mousedown is prevented: no autoscroll (Windows) or paste
 * (Linux), and no new window in the desktop app's webview.
 */
export function middleClickProps(open: ((foreground: boolean) => void) | undefined): { onMouseDown?: (event: MouseEvent) => void; onAuxClick?: (event: MouseEvent) => void } {
  if (!open) return {};
  return {
    onMouseDown: (event) => {
      if (event.button === 1) event.preventDefault();
    },
    onAuxClick: (event) => {
      if (event.button !== 1) return;
      event.preventDefault();
      event.stopPropagation();
      open(event.shiftKey);
    },
  };
}

/** A click that opens in a new tab with ⌘ / Ctrl held, in front (⌘⇧: behind) (true: handled), else the row's own click. */
export function clickOrNewTab(event: MouseEvent, open: ((foreground: boolean) => void) | undefined): boolean {
  if (!open || !isNewTabClick(event)) return false;
  event.preventDefault();
  open(!event.shiftKey);
  return true;
}

const MENU = "rx-popover z-50 min-w-48 rounded-xl border border-line bg-canvas p-1 text-ink shadow-xl";
const MENU_ITEM = "flex select-none items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm outline-none data-[disabled]:opacity-50 data-[highlighted]:bg-accent-soft";

/** A right-click menu with 「新しいタブで開く」 (and the element's own `items` above it); none without `onOpenInNewTab`. */
export function NewTabContextMenu({ onOpenInNewTab, children }: { onOpenInNewTab?: () => void; children: ReactNode }) {
  if (!onOpenInNewTab) return <>{children}</>;
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild onKeyDown={openContextMenuByKey}>{children}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className={MENU} collisionPadding={8}>
          <ContextMenu.Item className={MENU_ITEM} data-open-new-tab="" onSelect={onOpenInNewTab}>{t("tabs.openInNewTab")}</ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

export interface TabBadge {
  text: string | null;
  tone: "danger" | "neutral";
}

export interface TabItem {
  id: string;
  label: string;
  icon: ReactNode;
  /** Unread there (a background tab): a number (red for a mention) or a dot. */
  badge: TabBadge | null;
}

const TAB_DRAG = "application/x-taylis-tab";

export function DesktopTabBar({ tabs, activeId, onSelect, onClose, onCloseOthers, onMove, onNew, newLabel, style }: {
  tabs: readonly TabItem[];
  activeId: string;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onCloseOthers: (id: string) => void;
  /** `id` to index `to` of the list without it. */
  onMove: (id: string, to: number) => void;
  onNew: () => void;
  /** 「新しいタブ（⌘T）」. */
  newLabel: string;
  style?: React.CSSProperties;
}) {
  const row = useScrollRow<HTMLDivElement>();
  const dragged = useRef<string | null>(null);
  const [over, setOver] = useState<{ id: string; after: boolean } | null>(null);

  const dropIndex = (targetId: string, after: boolean, id: string): number => {
    const without = tabs.filter((tab) => tab.id !== id);
    const at = without.findIndex((tab) => tab.id === targetId);
    return at < 0 ? without.length : at + (after ? 1 : 0);
  };
  const half = (event: DragEvent<HTMLElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    return box.width > 0 && event.clientX > box.left + box.width / 2;
  };

  return (
    <div
      data-tab-bar=""
      // The line under the bar is an inset shadow: the active tab (drawn over it) covers it and joins the page.
      className="flex h-9 min-w-0 items-end gap-1 bg-sidebar pl-1.5 pr-1 text-sidebar-fg shadow-[inset_0_-1px_0_var(--line)]"
      style={style}
    >
      <div ref={row} role="tablist" aria-label={t("tabs.label")} className="scroll-row flex min-w-0 flex-1 items-end gap-0.5 overflow-x-auto overflow-y-hidden pt-1">
        {tabs.map((tab, index) => {
          const active = tab.id === activeId;
          const neighbours = tabs.length;
          return (
            <ContextMenu.Root key={tab.id}>
              <ContextMenu.Trigger asChild>
                <div
                  data-desk-tab={tab.id}
                  draggable
                  onDragStart={(event) => {
                    dragged.current = tab.id;
                    event.dataTransfer?.setData(TAB_DRAG, tab.id);
                    if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
                  }}
                  onDragEnd={() => {
                    dragged.current = null;
                    setOver(null);
                  }}
                  onDragOver={(event) => {
                    const id = dragged.current ?? event.dataTransfer?.getData(TAB_DRAG);
                    if (!id) return;
                    event.preventDefault();
                    const after = half(event);
                    if (over?.id !== tab.id || over.after !== after) setOver({ id: tab.id, after });
                  }}
                  onDragLeave={() => setOver((value) => (value?.id === tab.id ? null : value))}
                  onDrop={(event) => {
                    const id = dragged.current ?? event.dataTransfer?.getData(TAB_DRAG);
                    event.preventDefault();
                    dragged.current = null;
                    setOver(null);
                    if (id && id !== tab.id) onMove(id, dropIndex(tab.id, half(event), id));
                  }}
                  onMouseDown={(event) => {
                    if (event.button === 1) event.preventDefault();
                  }}
                  onAuxClick={(event) => {
                    // A middle click closes the tab (a browser).
                    if (event.button !== 1) return;
                    event.preventDefault();
                    onClose(tab.id);
                  }}
                  className={cn(
                    "group relative flex h-8 w-[200px] min-w-[104px] shrink items-center rounded-t-lg text-[13px] transition-colors",
                    // The active tab joins the page under it (its bottom edge covers the bar's line), outlined so it
                    // stands out of a dark bar too.
                    active ? "border-x border-t border-line bg-canvas text-ink" : "text-sidebar-fg hover:bg-sidebar-hover hover:text-sidebar-strong",
                  )}
                >
                  {over?.id === tab.id && <span aria-hidden className={cn("pointer-events-none absolute inset-y-1 w-0.5 rounded bg-accent", over.after ? "-right-px" : "-left-px")} />}
                  <button
                    type="button"
                    role="tab"
                    id={`desk-tab-${tab.id}`}
                    aria-selected={active}
                    tabIndex={active ? 0 : -1}
                    title={tab.label}
                    onClick={() => onSelect(tab.id)}
                    onKeyDown={(event: KeyboardEvent<HTMLButtonElement>) => {
                      if (event.key === "Delete" || (event.key === "Backspace" && !event.metaKey)) {
                        event.preventDefault();
                        onClose(tab.id);
                        return;
                      }
                      openContextMenuByKey(event);
                    }}
                    className="flex h-full min-w-0 flex-1 items-center gap-1.5 rounded-t-lg pl-2.5 pr-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/60"
                  >
                    <span aria-hidden className="flex h-4 w-4 shrink-0 items-center justify-center opacity-75 [&_svg]:h-[14px] [&_svg]:w-[14px]">{tab.icon}</span>
                    <span className={cn("min-w-0 flex-1 truncate", tab.badge && "font-semibold")}>{tab.label}</span>
                    {tab.badge && (
                      tab.badge.text ? (
                        <span data-tab-badge={tab.badge.tone} aria-label={t("tabs.unread", { count: tab.badge.text })} className={cn("shrink-0 rounded-full px-1.5 text-[10px] font-bold leading-4", tab.badge.tone === "danger" ? "bg-rose-500 text-white" : "bg-sidebar-strong/80 text-sidebar")}>
                          {tab.badge.text}
                        </span>
                      ) : (
                        <span data-tab-badge="dot" aria-label={t("tabs.unreadDot")} className="h-2 w-2 shrink-0 rounded-full bg-current opacity-80" />
                      )
                    )}
                  </button>
                  <button
                    type="button"
                    tabIndex={-1}
                    aria-label={t("tabs.close", { name: tab.label })}
                    title={t("tabs.closeTitle")}
                    onClick={() => onClose(tab.id)}
                    className={cn(
                      "mr-1 flex h-5 w-5 shrink-0 items-center justify-center rounded text-current opacity-0 transition-opacity hover:bg-ink/10 group-hover:opacity-70 hover:!opacity-100",
                      active && "opacity-60",
                    )}
                  >
                    <X size={13} />
                  </button>
                </div>
              </ContextMenu.Trigger>
              <ContextMenu.Portal>
                <ContextMenu.Content className={MENU} collisionPadding={8}>
                  <ContextMenu.Item className={MENU_ITEM} data-tab-action="close" onSelect={() => onClose(tab.id)}>{t("tabs.closeTitle")}</ContextMenu.Item>
                  <ContextMenu.Item className={MENU_ITEM} data-tab-action="close-others" disabled={neighbours < 2} onSelect={() => onCloseOthers(tab.id)}>{t("tabs.closeOthers")}</ContextMenu.Item>
                  <ContextMenu.Separator className="my-1 h-px bg-line" />
                  <ContextMenu.Item className={MENU_ITEM} data-tab-action="left" disabled={index === 0} onSelect={() => onMove(tab.id, index - 1)}>{t("tabs.moveLeft")}</ContextMenu.Item>
                  <ContextMenu.Item className={MENU_ITEM} data-tab-action="right" disabled={index === tabs.length - 1} onSelect={() => onMove(tab.id, index + 1)}>{t("tabs.moveRight")}</ContextMenu.Item>
                  <ContextMenu.Separator className="my-1 h-px bg-line" />
                  <ContextMenu.Item className={MENU_ITEM} data-tab-action="new" onSelect={onNew}>{t("tabs.new")}</ContextMenu.Item>
                </ContextMenu.Content>
              </ContextMenu.Portal>
            </ContextMenu.Root>
          );
        })}
      </div>
      <button
        type="button"
        data-new-tab=""
        aria-label={newLabel}
        title={newLabel}
        onClick={onNew}
        className="mb-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-sidebar-fg hover:bg-sidebar-hover hover:text-sidebar-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
      >
        <Plus size={16} />
      </button>
    </div>
  );
}
