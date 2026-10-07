/**
 * A row of formatting buttons that never runs out of its frame (2026-10-08: the canvas / page editor's toolbar was cut
 * off when the editor pane beside the preview was narrow; the last buttons could only be reached by a hidden sideways
 * scroll). The buttons that fit show; the rest go, in order, into a 「…」 menu at the end of the row (a keyboard reaches
 * it with Tab and its items with the arrow keys). What fits is measured with a ResizeObserver on the row, against an
 * invisible copy of all the buttons, so it follows the pane's width as it is dragged.
 */
import { Ellipsis } from "lucide-react";
import { Fragment, type ReactNode, useCallback, useLayoutEffect, useRef, useState } from "react";
import { cn, IconButton, Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "./primitives";
import { t } from "../i18n";

export interface ToolbarTool {
  icon: ReactNode;
  label: string;
  run: () => void;
  /** A divider before it (the start of a group). */
  group?: boolean;
  /** Pressed (the rich composer's marks at the caret); undefined: not a toggle. */
  active?: boolean;
  disabled?: boolean;
}

/**
 * How many of the tools fit (apps/desktop/tests/overflowToolbar.test.tsx): `ends[i]` is where tool i ends from the row's
 * start (its divider and the gaps before it counted), `more` the 「…」 button with its gap, `available` the row's room.
 * All of them when they fit; otherwise as many as fit beside 「…」, at least none.
 */
export function fittingTools(ends: readonly number[], more: number, available: number): number {
  const all = ends.length;
  if (all === 0 || (ends[all - 1] ?? 0) <= available) return all;
  let n = all - 1;
  while (n > 0 && (ends[n - 1] ?? 0) + more > available) n--;
  return n;
}

export function OverflowToolbar({ tools, label, className, buttonClassName, activeClassName, trailing, role = "toolbar" }: {
  tools: readonly ToolbarTool[];
  /** The toolbar's accessible name. */
  label: string;
  className?: string;
  /** Each button's classes (size, colour). */
  buttonClassName: string;
  activeClassName?: string;
  /** Always shown at the end, after 「…」 (the composer's mode switch). */
  trailing?: ReactNode;
  role?: "toolbar" | "group";
}) {
  const row = useRef<HTMLDivElement>(null);
  const measure = useRef<HTMLDivElement>(null);
  const tail = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(tools.length);
  /** An item was picked in the menu: the editor takes the focus back, not 「…」. */
  const picked = useRef(false);
  const hasTrailing = trailing !== undefined && trailing !== null;

  const layout = useCallback(() => {
    const el = row.current;
    const copy = measure.current;
    if (!el || !copy) return;
    const style = getComputedStyle(el);
    const room = el.clientWidth - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0) - (tail.current?.offsetWidth ?? 0);
    const items = [...copy.children] as HTMLElement[];
    const more = items.pop();
    // Not laid out (hidden, or a test without a layout): every tool.
    if (el.clientWidth === 0 || !more || items.length !== tools.length) {
      setShown(tools.length);
      return;
    }
    const origin = copy.getBoundingClientRect().left;
    const ends = items.map((item) => item.getBoundingClientRect().right - origin);
    const gap = parseFloat(getComputedStyle(copy).columnGap) || 0;
    setShown(fittingTools(ends, more.getBoundingClientRect().width + gap, room - (hasTrailing ? gap : 0)));
  }, [tools.length, hasTrailing]);

  useLayoutEffect(() => {
    layout();
    const el = row.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => layout());
    observer.observe(el);
    if (tail.current) observer.observe(tail.current);
    return () => observer.disconnect();
  }, [layout]);

  const visible = tools.slice(0, shown);
  const hidden = tools.slice(shown);
  const divider = (key: string, measured = false) => <span key={key} aria-hidden className={cn("mx-1 h-4 w-px shrink-0 bg-line", measured && "inline-block")} />;
  return (
    <div ref={row} role={role} aria-label={label} className={cn("relative flex min-w-0 items-center gap-0.5 overflow-hidden", className)}>
      {/* The invisible copy every width is read from: each tool with the divider before it, then 「…」. */}
      <div ref={measure} aria-hidden className="pointer-events-none invisible absolute left-0 top-0 flex items-center gap-0.5" style={{ width: "max-content" }}>
        {tools.map((tool, index) => (
          <span key={index} className="flex shrink-0 items-center gap-0.5">
            {tool.group && index > 0 && divider("d", true)}
            <span className={cn("inline-flex shrink-0", buttonClassName)} />
          </span>
        ))}
        <span className={cn("inline-flex shrink-0", buttonClassName)} />
      </div>
      {visible.map((tool, index) => (
        <Fragment key={index}>
          {tool.group && index > 0 && divider(`d${index}`)}
          <IconButton
            label={tool.label}
            aria-pressed={tool.active === undefined ? undefined : tool.active}
            className={cn(buttonClassName, tool.active && activeClassName)}
            disabled={tool.disabled}
            onMouseDown={(event) => event.preventDefault()}
            onClick={tool.run}
          >
            {tool.icon}
          </IconButton>
        </Fragment>
      ))}
      {hidden.length > 0 && (
        <Menu modal={false}>
          <MenuTrigger asChild>
            <button
              type="button"
              title={t("composer.moreFormatting")}
              aria-label={t("composer.moreFormatting")}
              disabled={hidden.every((tool) => tool.disabled)}
              onMouseDown={(event) => event.preventDefault()}
              className={cn("flex shrink-0 items-center justify-center rounded-md hover:bg-panel-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 disabled:opacity-40", buttonClassName)}
            >
              <Ellipsis size={15} />
            </button>
          </MenuTrigger>
          <MenuContent
            align="end"
            className="min-w-44"
            onCloseAutoFocus={(event) => {
              // After a pick the editor puts the caret back itself; Escape returns to 「…」.
              if (picked.current) event.preventDefault();
              picked.current = false;
            }}
          >
            {hidden.map((tool, index) => (
              <Fragment key={index}>
                {tool.group && index > 0 && <MenuSeparator />}
                <MenuItem
                  disabled={tool.disabled}
                  className={cn("[&_svg]:shrink-0 [&_svg]:text-muted", tool.active && "text-accent [&_svg]:text-accent")}
                  onSelect={() => {
                    picked.current = true;
                    tool.run();
                  }}
                >
                  {tool.icon}
                  <span className="min-w-0 flex-1 truncate">{tool.label}</span>
                </MenuItem>
              </Fragment>
            ))}
          </MenuContent>
        </Menu>
      )}
      {trailing && (
        <div ref={tail} className="ml-auto flex shrink-0 items-center">
          {trailing}
        </div>
      )}
    </div>
  );
}
