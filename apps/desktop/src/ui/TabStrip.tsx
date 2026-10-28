/**
 * The wide conversation header's tab strip (「メッセージ | キャンバス | タスク | ドライブ」, 2026-10-28): the tabs that fit its
 * room show; the rest go, in order, into 「その他 ▾」 at its end. The selected tab always shows (it takes the place of
 * the last one that would have fitted). Before this the strip scrolled sideways without a scrollbar and its last tabs
 * were simply cut off once 「ドライブ」 had been added. The tabs are measured on an invisible copy of all of them (as
 * OverflowToolbar does). The strip does not shrink; its room is its row's width less what the things beside it need
 * (`stripRoom`): the topic (`data-topic`) needs nothing (it gives way first), the title its whole text up to
 * `data-natural-max` px (a longer name gets an ellipsis rather than folding tabs). So what the strip shows never changes
 * the room it gets, and a strip that folded gives the room it no longer needs back to the title. A ResizeObserver on the
 * row and on the copy (a web font arriving late) measures again; so does every render (another channel's title).
 */
import { ChevronDown } from "lucide-react";
import { useCallback, useLayoutEffect, useRef, useState } from "react";

import { cn, Menu, MenuContent, MenuItem, MenuTrigger } from "./primitives";
import { t } from "../i18n";

/**
 * Which tabs show (their indices, in order; apps/desktop/tests/tabStrip.test.tsx). `widths` are the tabs' widths, `gap`
 * the space between two of them, `more` the 「その他」 button's width, `available` the strip's room and `active` the
 * selected tab. All of them when they fit; otherwise the selected one and, beside 「その他」, as many of the others from
 * the start as fit (never fewer than the selected one, even when it alone is too wide).
 */
export function fittingTabs(widths: readonly number[], gap: number, more: number, available: number, active: number): number[] {
  const all = widths.map((_, index) => index);
  const total = widths.reduce((sum, width) => sum + width, 0) + gap * Math.max(0, widths.length - 1);
  if (widths.length === 0 || total <= available) return all;
  const selected = active >= 0 && active < widths.length ? active : 0;
  let used = (widths[selected] ?? 0) + gap + more;
  const shown = new Set([selected]);
  for (const index of all) {
    if (index === selected) continue;
    const width = widths[index] ?? 0;
    if (used + gap + width > available) break;
    used += gap + width;
    shown.add(index);
  }
  return all.filter((index) => shown.has(index));
}

const TAB = "shrink-0 whitespace-nowrap rounded-md px-2.5 py-1 transition-colors";
const GAP = 0;

/**
 * The strip's room in its row (a flex row with a gap): the row's content width less the gap between each two children
 * and the width every other child needs (`data-topic`: none; else its whole content, at most `data-natural-max`), less
 * the strip's own margins and padding. Infinity when the strip has no row.
 */
export function stripRoom(strip: HTMLElement): number {
  const row = strip.parentElement;
  if (!row) return Infinity;
  const rowStyle = getComputedStyle(row);
  const own = getComputedStyle(strip);
  const px = (value: string) => parseFloat(value) || 0;
  const children = [...row.children].filter((child) => getComputedStyle(child).position !== "absolute" && getComputedStyle(child).display !== "none") as HTMLElement[];
  let room = row.getBoundingClientRect().width - px(rowStyle.paddingLeft) - px(rowStyle.paddingRight) - px(rowStyle.columnGap) * Math.max(0, children.length - 1);
  for (const child of children) {
    if (child === strip || child.hasAttribute("data-topic")) continue;
    const need = Math.max(child.getBoundingClientRect().width, child.scrollWidth);
    const cap = Number(child.getAttribute("data-natural-max"));
    room -= cap > 0 ? Math.min(need, cap) : need;
  }
  return room - px(own.marginLeft) - px(own.marginRight) - px(own.paddingLeft) - px(own.paddingRight);
}

export function TabStrip<T extends string>({ tabs, value, onChange, label, className }: {
  tabs: ReadonlyArray<readonly [T, string]>;
  value: T;
  onChange: (value: T) => void;
  /** The tablist's accessible name. */
  label: string;
  className?: string;
}) {
  const strip = useRef<HTMLDivElement>(null);
  const copy = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState<number[] | null>(null);
  const active = Math.max(0, tabs.findIndex(([key]) => key === value));
  const names = tabs.map(([, name]) => name).join("\u0000");

  const layout = useCallback(() => {
    const el = strip.current;
    const measure = copy.current;
    if (!el || !measure) return;
    const items = [...measure.children] as HTMLElement[];
    const moreButton = items.pop();
    const widths = items.map((item) => item.getBoundingClientRect().width);
    const total = widths.reduce((sum, width) => sum + width, 0) + GAP * Math.max(0, widths.length - 1);
    const moreWidth = moreButton?.getBoundingClientRect().width ?? 0;
    // Not laid out (hidden, or a test's DOM): every tab, as the strip was.
    if (!moreButton || items.length !== tabs.length || total === 0) {
      setShown(null);
      return;
    }
    const next = fittingTabs(widths, GAP, moreWidth, stripRoom(el), active);
    setShown((previous) => (next.length === tabs.length ? null : previous && previous.join() === next.join() ? previous : next));
  }, [tabs.length, active]);

  // Every render: the things beside the strip may have changed (another channel's title, a deadline chip).
  useLayoutEffect(() => layout());
  useLayoutEffect(() => {
    const el = strip.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => layout());
    if (el.parentElement) observer.observe(el.parentElement);
    if (copy.current) observer.observe(copy.current);
    return () => observer.disconnect();
  }, [layout, names]);

  const visible = shown ?? tabs.map((_, index) => index);
  const hidden = tabs.map((_, index) => index).filter((index) => !visible.includes(index));
  return (
    <div
      ref={strip}
      className={cn("relative flex shrink-0 items-center overflow-hidden rounded-lg bg-panel-2 p-0.5 text-xs font-medium", className)}
      data-tab-strip=""
    >
      {/* The invisible copy every width is read from: each tab, then 「その他 ▾」. */}
      <div ref={copy} aria-hidden className="pointer-events-none invisible absolute left-0 top-0 flex items-center" style={{ width: "max-content" }}>
        {tabs.map(([key, name]) => (
          <span key={key} className={TAB}>{name}</span>
        ))}
        <span className={cn(TAB, "inline-flex items-center gap-1")}>
          {t("main.tab.more")}
          <ChevronDown size={13} />
        </span>
      </div>
      <div role="tablist" aria-label={label} className="flex min-w-0 items-center">
        {visible.map((index) => {
          const [key, name] = tabs[index]!;
          return (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={value === key}
              onClick={() => onChange(key)}
              className={cn(TAB, value === key ? "bg-canvas text-ink shadow-sm" : "text-muted hover:text-ink")}
            >
              {name}
            </button>
          );
        })}
      </div>
      {hidden.length > 0 && (
        <Menu>
          <MenuTrigger asChild>
            <button type="button" data-tab-more="" className={cn(TAB, "inline-flex items-center gap-1 text-muted hover:text-ink")}>
              {t("main.tab.more")}
              <ChevronDown size={13} />
            </button>
          </MenuTrigger>
          <MenuContent align="end">
            {hidden.map((index) => {
              const [key, name] = tabs[index]!;
              return (
                <MenuItem key={key} onSelect={() => onChange(key)}>
                  {name}
                </MenuItem>
              );
            })}
          </MenuContent>
        </Menu>
      )}
    </div>
  );
}
