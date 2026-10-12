/**
 * The places rail (2026-10-12, docs/MOBILE_UI.md §18): the sidebar's menu items (スレッド, アクティビティ, ファイル,
 * キャンバス, ドキュメント, カレンダー…) as a narrow column of icons left of the conversation list, so the list starts with the
 * channels (Slack). Each icon names itself in a tooltip on hover and keyboard focus, carries its unread badge and is
 * highlighted while its page is open. Each place stands where I put it (UserMe.desktop_places, §18.2): in the rail (as
 * many as fit its height, in my order), as a sidebar row, or only under 「その他」. The customise menu 「項目の配置」 moves
 * them and hides the rail; the order is set in 設定 → 表示 → 「サイドバーの項目」. One tab stop; ↑ / ↓ / Home / End move
 * between the icons.
 */
import { Ellipsis, EyeOff, SlidersHorizontal } from "lucide-react";
import { Tooltip } from "radix-ui";
import { type KeyboardEvent, type ReactNode, useLayoutEffect, useRef, useState } from "react";

import type { PlaceSpot } from "./desktopPlaces";
import { cn, Menu, MenuContent, MenuItem, MenuLabel, MenuRadioGroup, MenuRadioItem, MenuSeparator, MenuSub, MenuSubContent, MenuSubTrigger, MenuTrigger } from "./primitives";
import { type MessageKey, t } from "../i18n";

/** The rail's width (px); MainScreen adds it to the sidebar's column. */
export const PLACES_RAIL_WIDTH = 52;
/** One icon's height plus the gap under it (px): h-10 and gap-1. */
export const RAIL_ITEM_PITCH = 44;
/** The rail's padding, top and bottom together (py-2). */
const RAIL_PADDING = 16;

export interface PlaceBadge {
  /** What the badge shows ("99+" past 99). */
  text: string;
  /** Red: a mention, a fired reminder, a to-do due; neutral: unread without a mention, drafts, open reminders. */
  tone: "danger" | "neutral";
}

export interface Place {
  key: string;
  label: string;
  icon: ReactNode;
  onSelect: () => void;
  active: boolean;
  /** The tooltip's second line (what the page holds). */
  hint?: string;
  /** The accessible name when it says more than the label (アクティビティ（未読 3）). */
  ariaLabel?: string;
  badge?: PlaceBadge | null;
  /** A quiet number for the tooltip and the menu (saved, who is in the room). */
  count?: number;
  /** Something unread here: the icon is drawn stronger. */
  emphasis?: boolean;
}

/** The three places a place can stand, in the menus' order. */
export const PLACE_SPOTS: ReadonlyArray<readonly [PlaceSpot, MessageKey]> = [
  ["rail", "places.spot.rail"],
  ["sidebar", "places.spot.sidebar"],
  ["hidden", "places.spot.hidden"],
];

export function spotLabel(spot: PlaceSpot): string {
  return t(PLACE_SPOTS.find(([value]) => value === spot)![1]);
}

/**
 * How many of `count` rail places fit a rail `height` px tall, with 「その他」 and the customise button under them (and
 * each icon's gap). 0 or less (not laid out yet, a test's DOM) counts as tall enough for all.
 */
export function railFit(count: number, height: number, controls = 2): number {
  if (!(height > 0)) return count;
  const room = height - RAIL_PADDING - controls * RAIL_ITEM_PITCH;
  return Math.max(0, Math.min(count, Math.floor(room / RAIL_ITEM_PITCH)));
}

/**
 * The places standing in the rail (put there, the first `fit`, in my order) and the ones under 「その他」 (the hidden ones
 * and the rail's that do not fit, in order). Sidebar rows are in neither: they are in view already.
 */
export function railLayout(places: readonly Place[], spotOf: (key: string) => PlaceSpot, fit: number): { rail: Place[]; more: Place[] } {
  const rail = places.filter((place) => spotOf(place.key) === "rail").slice(0, Math.max(0, fit));
  const inRail = new Set(rail.map((place) => place.key));
  return { rail, more: places.filter((place) => !inRail.has(place.key) && spotOf(place.key) !== "sidebar") };
}

/** The strongest badge among `places` (「その他」 shows a dot for what it hides): danger beats neutral. */
export function strongestBadge(places: readonly Place[]): PlaceBadge["tone"] | null {
  if (places.some((place) => place.badge?.tone === "danger")) return "danger";
  return places.some((place) => place.badge) ? "neutral" : null;
}

const ITEM = "relative flex h-10 w-10 shrink-0 items-center justify-center rounded-xl outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent/70";
const IDLE = "text-sidebar-fg hover:bg-sidebar-hover hover:text-sidebar-strong";
const ACTIVE = "bg-sidebar-active text-sidebar-active-fg";

export function PlacesRail({ places, spotOf, onPlace, onHideRail, onArrange }: {
  /** Every place I can open here, in my order. */
  places: readonly Place[];
  /** Where each place stands (rail / sidebar / hidden). */
  spotOf: (key: string) => PlaceSpot;
  /** Moves a place (undefined: a server without the setting; no customise menu then). */
  onPlace?: (key: string, spot: PlaceSpot) => void;
  /** 「アイコン列を隠す」: the rail's places become sidebar rows. */
  onHideRail?: () => void;
  /** 「並べ替え…」: the settings' list. */
  onArrange?: () => void;
}) {
  const root = useRef<HTMLElement>(null);
  const [height, setHeight] = useState(0);
  useLayoutEffect(() => {
    const element = root.current;
    if (!element) return;
    const measure = () => setHeight(element.clientHeight);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const controls = onPlace ? 2 : 1;
  const railCount = places.filter((place) => spotOf(place.key) === "rail").length;
  const { rail, more } = railLayout(places, spotOf, railFit(railCount, height, controls));
  const moreActive = more.some((place) => place.active);
  const moreBadge = strongestBadge(more);
  // One tab stop: the open place's icon, else the first one.
  const tabStop = rail.find((place) => place.active)?.key ?? rail[0]?.key ?? "more";

  // In the capture phase: on 「その他」 and the customise button ↓ would otherwise open their menu (Radix's trigger), and
  // a prevented key is left alone by it. Only the rail's own icons: the menus are portalled out of the rail's DOM (React
  // still bubbles their keys through here).
  const onKeyDownCapture = (event: KeyboardEvent<HTMLElement>) => {
    const keys = ["ArrowDown", "ArrowUp", "Home", "End"];
    if (!keys.includes(event.key) || event.altKey || event.metaKey || event.ctrlKey) return;
    const items = [...(root.current?.querySelectorAll<HTMLElement>("[data-rail-item]") ?? [])];
    const from = items.indexOf(event.target as HTMLElement);
    if (from < 0) return;
    event.preventDefault();
    event.stopPropagation();
    const to = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (from + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    items[to]?.focus();
  };

  return (
    <nav
      ref={root}
      aria-label={t("rail.places")}
      aria-orientation="vertical"
      data-places-rail=""
      onKeyDownCapture={onKeyDownCapture}
      className="flex h-full min-h-0 shrink-0 flex-col items-center gap-1 overflow-hidden border-r border-sidebar-line py-2"
      style={{ width: PLACES_RAIL_WIDTH }}
    >
      <Tooltip.Provider delayDuration={250} disableHoverableContent>
        {rail.map((place) => (
          <RailTip key={place.key} label={place.label} hint={place.hint} count={place.count}>
            <button
              type="button"
              data-rail-item=""
              data-nav-item={place.key}
              tabIndex={place.key === tabStop ? 0 : -1}
              aria-label={place.ariaLabel ?? place.label}
              aria-current={place.active ? "page" : undefined}
              onClick={place.onSelect}
              className={cn(ITEM, place.active ? ACTIVE : IDLE, place.emphasis && !place.active && "text-sidebar-strong")}
            >
              {place.icon}
              {place.badge && <RailBadge badge={place.badge} />}
            </button>
          </RailTip>
        ))}
        <div className="min-h-0 flex-1" />
        <Menu>
          <RailTip label={t("rail.more")}>
            <MenuTrigger asChild>
              <button
                type="button"
                data-rail-item=""
                data-rail-more=""
                tabIndex={tabStop === "more" ? 0 : -1}
                aria-label={t("rail.more")}
                className={cn(ITEM, moreActive ? ACTIVE : IDLE)}
              >
                <Ellipsis size={20} />
                {moreBadge && <span data-more-badge={moreBadge} className={cn("absolute right-1 top-1 h-2.5 w-2.5 rounded-full ring-2 ring-sidebar", moreBadge === "danger" ? "bg-rose-500" : "bg-sidebar-strong")} />}
              </button>
            </MenuTrigger>
          </RailTip>
          <MenuContent side="right" align="end" className="max-h-[80vh] overflow-y-auto">
            <MenuLabel>{t("rail.more")}</MenuLabel>
            {more.length === 0 && <p className="px-2.5 py-1.5 text-sm text-muted">{t("rail.moreEmpty")}</p>}
            <PlaceMenuItems places={more} />
            {onArrange && (
              <>
                <MenuSeparator />
                <MenuItem onSelect={onArrange}>{t("rail.arrange")}</MenuItem>
              </>
            )}
          </MenuContent>
        </Menu>
        {onPlace && (
          <Menu>
            <RailTip label={t("rail.customize")}>
              <MenuTrigger asChild>
                <button type="button" data-rail-item="" data-rail-customize="" tabIndex={-1} aria-label={t("rail.customize")} className={cn(ITEM, IDLE, "h-8 opacity-70 hover:opacity-100")}>
                  <SlidersHorizontal size={16} />
                </button>
              </MenuTrigger>
            </RailTip>
            <MenuContent side="right" align="end" className="max-h-[80vh] w-72 overflow-y-auto">
              <MenuLabel>{t("rail.customize")}</MenuLabel>
              {places.map((place) => <PlaceSpotSubmenu key={place.key} place={place} spot={spotOf(place.key)} onPlace={onPlace} />)}
              <p className="px-2.5 pb-1 pt-1.5 text-xs leading-snug text-muted">{t("rail.pinnedNote")}</p>
              <MenuSeparator />
              {onHideRail && (
                <MenuItem data-hide-rail="" onSelect={onHideRail}>
                  <EyeOff size={14} className="text-muted" />
                  {t("places.hideRail")}
                </MenuItem>
              )}
              {onArrange && <MenuItem onSelect={onArrange}>{t("rail.arrange")}</MenuItem>}
            </MenuContent>
          </Menu>
        )}
      </Tooltip.Provider>
    </nav>
  );
}

/** The places of a menu (「その他」 in the rail or in the sidebar): icon, name, badge or quiet number. */
export function PlaceMenuItems({ places }: { places: readonly Place[] }) {
  return (
    <>
      {places.map((place) => (
        <MenuItem key={place.key} data-nav-item={place.key} aria-current={place.active ? "page" : undefined} onSelect={place.onSelect} className={cn(place.active && "font-semibold")}>
          <span className="flex w-5 shrink-0 justify-center text-muted [&_svg]:h-4 [&_svg]:w-4">{place.icon}</span>
          <span className="flex-1 truncate">{place.label}</span>
          {place.badge ? (
            <span className={cn("rounded-full px-1.5 text-[11px] font-bold", place.badge.tone === "danger" ? "bg-rose-500 text-white" : "bg-panel-2 text-muted")}>{place.badge.text}</span>
          ) : place.count ? (
            <span className="text-xs text-muted">{place.count}</span>
          ) : null}
        </MenuItem>
      ))}
    </>
  );
}

/** One place in 「項目の配置」: its icon and name, where it stands now, and a submenu of アイコン列 / サイドバー / 表示しない. */
export function PlaceSpotSubmenu({ place, spot, onPlace }: { place: Pick<Place, "key" | "label" | "icon">; spot: PlaceSpot; onPlace: (key: string, spot: PlaceSpot) => void }) {
  return (
    <MenuSub>
      <MenuSubTrigger data-place-item={place.key} data-spot={spot}>
        <span className="flex w-5 shrink-0 justify-center text-muted [&_svg]:h-4 [&_svg]:w-4">{place.icon}</span>
        <span className="min-w-0 flex-1 truncate">{place.label}</span>
        <span className="shrink-0 text-xs text-muted">{spotLabel(spot)}</span>
      </MenuSubTrigger>
      <MenuSubContent>
        <MenuRadioGroup value={spot} onValueChange={(value) => { if (value !== spot) onPlace(place.key, value as PlaceSpot); }}>
          {PLACE_SPOTS.map(([value, label]) => (
            <MenuRadioItem key={value} value={value} data-spot-choice={value}>{t(label)}</MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuSubContent>
    </MenuSub>
  );
}

function RailBadge({ badge }: { badge: PlaceBadge }) {
  return (
    <span
      data-badge={badge.tone}
      className={cn(
        "pointer-events-none absolute -right-1 -top-1 inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-bold leading-none ring-2 ring-sidebar",
        badge.tone === "danger" ? "bg-rose-500 text-white" : "bg-sidebar-strong text-sidebar",
      )}
    >
      {badge.text}
    </span>
  );
}

/** The name to the right of an icon (and the page's one-line description), on hover and on keyboard focus. */
function RailTip({ label, hint, count, children }: { label: string; hint?: string; count?: number; children: ReactNode }) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>{children}</Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content side="right" sideOffset={8} collisionPadding={8} className="pointer-events-none z-50 max-w-60 rounded-md bg-ink px-2 py-1 text-xs leading-snug text-canvas shadow-md">
          <span className="block font-semibold">
            {label}
            {count ? <span className="ml-1.5 font-normal opacity-75">{count}</span> : null}
          </span>
          {hint && hint !== label && <span className="block opacity-80">{hint}</span>}
          <Tooltip.Arrow className="fill-ink" />
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}
