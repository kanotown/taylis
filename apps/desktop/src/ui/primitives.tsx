/** Small design-system layer: Tailwind classes + Radix primitives + Lucide icons. */
import { clsx, type ClassValue } from "clsx";
import { X } from "lucide-react";
import { Dialog, DropdownMenu, Popover, Tooltip } from "radix-ui";
import { type ButtonHTMLAttributes, type ComponentProps, forwardRef, type InputHTMLAttributes, type ReactElement, type ReactNode, type TextareaHTMLAttributes, useCallback, useRef } from "react";
import { twMerge } from "tailwind-merge";
import { t } from "../i18n";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/**
 * M93: a row of underlined tabs that scrolls sideways when it does not fit (管理, 検索). Only sideways: `overflow-x: auto`
 * alone makes the other axis `auto` too, and the tabs' old `-mb-px` (their underline over the row's border) then
 * overflowed by one pixel, so the row scrolled up and down a little. The row's line is an inset shadow instead, which
 * the tabs' own 2 px underline (`UNDERLINE_TAB`) covers from inside the row.
 */
export const UNDERLINE_TAB_ROW = "flex shrink-0 overflow-x-auto overflow-y-hidden overscroll-x-contain shadow-[inset_0_-1px_0_var(--line)]";
/**
 * A mouse wheel's vertical turn scrolls a sideways row (2026-10-04: the 管理 tabs could only be scrolled with a trackpad
 * or a horizontal wheel). Only while the row overflows and the turn is mostly vertical; at either end the page keeps
 * the wheel. Returns whether the row moved (the event is then the row's).
 */
export function wheelScrollsSideways(row: HTMLElement, event: Pick<WheelEvent, "deltaX" | "deltaY" | "deltaMode">): boolean {
  if (row.scrollWidth <= row.clientWidth || event.deltaY === 0 || Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return false;
  const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? row.clientWidth : 1);
  const before = row.scrollLeft;
  row.scrollLeft = Math.max(0, Math.min(row.scrollWidth - row.clientWidth, before + delta));
  return row.scrollLeft !== before;
}

/**
 * A callback ref that makes the wheel scroll the element sideways (wheelScrollsSideways). Not React's onWheel: it
 * listens passively, and the page would scroll as well.
 */
export function useSidewaysWheel<T extends HTMLElement>(): (node: T | null) => void {
  const detach = useRef<(() => void) | null>(null);
  return useCallback((node: T | null) => {
    detach.current?.();
    detach.current = null;
    if (!node) return;
    const onWheel = (event: WheelEvent) => { if (wheelScrollsSideways(node, event)) event.preventDefault(); };
    node.addEventListener("wheel", onWheel, { passive: false });
    detach.current = () => node.removeEventListener("wheel", onWheel);
  }, []);
}

/** The row of `UNDERLINE_TAB_ROW` as an element, with the wheel scrolling it sideways (管理, 検索). */
export function UnderlineTabRow({ className, ...props }: ComponentProps<"div">) {
  const wheel = useSidewaysWheel<HTMLDivElement>();
  return <div ref={wheel} className={cn(UNDERLINE_TAB_ROW, className)} {...props} />;
}

export const UNDERLINE_TAB = "shrink-0 whitespace-nowrap rounded-t-md border-b-2 text-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/60";

type Variant = "primary" | "secondary" | "ghost" | "danger" | "link";
type Size = "sm" | "md" | "icon";

const BASE =
  "inline-flex select-none items-center justify-center font-medium whitespace-nowrap transition-colors disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50";
const VARIANTS: Record<Variant, string> = {
  primary: "bg-accent-solid text-white shadow-sm hover:bg-accent-solid/90",
  secondary: "bg-panel-2 text-ink hover:bg-line",
  ghost: "text-ink hover:bg-ink/6",
  danger: "bg-danger text-white hover:bg-danger/90",
  link: "text-accent hover:underline",
};
const SIZES: Record<Size, string> = {
  sm: "h-7 gap-1 rounded-md px-2.5 text-xs",
  md: "h-9 gap-1.5 rounded-lg px-3.5 text-sm",
  icon: "h-8 w-8 rounded-lg",
};

export const Button = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size }>(
  function Button({ variant = "primary", size = "md", className, type = "button", ...props }, ref) {
    return <button ref={ref} type={type} className={cn(BASE, VARIANTS[variant], SIZES[size], className)} {...props} />;
  },
);

/** Ghost icon button with an accessible label shown as a tooltip. */
export function IconButton({ label, children, className, tone, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; tone?: "sidebar" }) {
  return (
    <Tooltip.Provider delayDuration={350}>
      <Tooltip.Root>
        <Tooltip.Trigger asChild>
          <button
            type="button"
            aria-label={label}
            className={cn(BASE, SIZES.icon, tone === "sidebar" ? "text-sidebar-fg hover:bg-sidebar-hover hover:text-sidebar-strong" : VARIANTS.ghost, className)}
            {...props}
          >
            {children}
          </button>
        </Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content sideOffset={6} className="z-50 rounded-md bg-ink px-2 py-1 text-xs text-canvas shadow-md">
            {label}
            <Tooltip.Arrow className="fill-ink" />
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  );
}

/**
 * Where a hover list opens (2026-10-05): above its trigger, 8 px off the trigger's edge, never on the pointer (a native
 * `title` opened at the cursor, which then covered the names). Flips below when there is no room above.
 */
export const HOVER_LIST = { side: "top", sideOffset: 8, delayDuration: 300, collisionPadding: 8 } as const;

/**
 * Who reacted, who replied, who voted or confirmed, a presence: a short list shown while the pointer rests on the
 * trigger (or it has focus). Not hoverable and not interactive (`pointer-events-none`), so it never takes the hover from
 * the trigger or the row; nothing on a touch screen (Radix ignores touch). Without `content` the trigger stands alone.
 */
export function HoverList({ content, children, side = HOVER_LIST.side }: { content: ReactNode; children: ReactElement; side?: "top" | "bottom" }) {
  if (content === null || content === undefined || content === "") return children;
  return (
    <Tooltip.Provider delayDuration={HOVER_LIST.delayDuration} disableHoverableContent>
      <Tooltip.Root>
        <Tooltip.Trigger asChild>{children}</Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content
            data-hover-list=""
            side={side}
            sideOffset={HOVER_LIST.sideOffset}
            collisionPadding={HOVER_LIST.collisionPadding}
            avoidCollisions
            className="pointer-events-none z-50 max-w-xs whitespace-pre-line break-words rounded-md bg-ink px-2 py-1 text-xs leading-snug text-canvas shadow-md"
          >
            {content}
            <Tooltip.Arrow className="fill-ink" />
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  );
}

const FIELD =
  "w-full rounded-lg border border-line bg-canvas px-3 py-2 text-sm text-ink placeholder:text-muted focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30 disabled:opacity-50";

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...props }, ref) {
  return <input ref={ref} className={cn(FIELD, className)} {...props} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, ...props }, ref) {
  return <textarea ref={ref} className={cn(FIELD, "resize-none", className)} {...props} />;
});

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="block space-y-1">
      <span className="text-xs font-medium text-muted">{label}</span>
      {children}
      {hint && <span className="block text-xs text-muted">{hint}</span>}
    </label>
  );
}

export function Badge({ children, tone = "neutral", className }: { children: ReactNode; tone?: "neutral" | "danger" | "accent"; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-[11px] font-bold leading-none",
        tone === "danger" && "bg-rose-500 text-white",
        tone === "accent" && "bg-accent-soft text-accent",
        tone === "neutral" && "bg-panel-2 text-muted",
        className,
      )}
    >
      {children}
    </span>
  );
}

export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return <kbd className={cn("rounded border border-line bg-panel-2 px-1.5 py-0.5 font-mono text-[11px] text-muted", className)}>{children}</kbd>;
}

/** Centered modal on a blurred overlay; Esc and clicking outside close it. */
export function Modal({
  onClose,
  title,
  description,
  children,
  className,
  hideClose = false,
  focusDialog = false,
}: {
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
  className?: string;
  hideClose?: boolean;
  /** Focus the dialog itself on open instead of its first control (e.g. a tab row, whose clipped focus ring looked
   *  like a selected gap between the first two tabs in the macOS app). */
  focusDialog?: boolean;
}) {
  return (
    <Dialog.Root open onOpenChange={(open) => { if (!open) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="rx-overlay fixed inset-0 z-40 bg-black/40 backdrop-blur-[2px]" />
        <Dialog.Content
          onOpenAutoFocus={focusDialog ? (event) => { event.preventDefault(); (event.currentTarget as HTMLElement | null)?.focus(); } : undefined}
          className={cn(
            "rx-dialog fixed left-1/2 top-1/2 z-50 max-h-[85dvh] w-[460px] max-w-[92vw] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-2xl border border-line bg-canvas p-5 text-ink shadow-2xl focus:outline-none max-md:p-4",
            className,
          )}
        >
          <Dialog.Title className={cn("text-base font-semibold", title ? "" : "sr-only")}>{title || t("primitives.dialog")}</Dialog.Title>
          <Dialog.Description className={cn("mt-1 text-sm text-muted", description ? "" : "sr-only")}>{description ?? title}</Dialog.Description>
          {children}
          {!hideClose && (
            <Dialog.Close asChild>
              <button type="button" aria-label={t("common.close")} className={cn(BASE, VARIANTS.ghost, "absolute right-3 top-3 h-7 w-7 rounded-md text-muted")}>
                <X size={16} />
              </button>
            </Dialog.Close>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

// --- menus -----------------------------------------------------------------------------------

export const Menu = DropdownMenu.Root;
export const MenuTrigger = DropdownMenu.Trigger;
export const MenuRadioGroup = DropdownMenu.RadioGroup;

export function MenuContent({ className, children, ...props }: ComponentProps<typeof DropdownMenu.Content>) {
  return (
    <DropdownMenu.Portal>
      <DropdownMenu.Content
        sideOffset={6}
        align="end"
        className={cn("rx-popover z-50 min-w-52 rounded-xl border border-line bg-canvas p-1 text-ink shadow-xl", className)}
        {...props}
      >
        {children}
      </DropdownMenu.Content>
    </DropdownMenu.Portal>
  );
}

const ITEM = "flex select-none items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm outline-none data-[disabled]:opacity-50 data-[highlighted]:bg-accent-soft";

export function MenuItem({ className, ...props }: ComponentProps<typeof DropdownMenu.Item>) {
  return <DropdownMenu.Item className={cn(ITEM, className)} {...props} />;
}

export function MenuRadioItem({ className, children, ...props }: ComponentProps<typeof DropdownMenu.RadioItem>) {
  return (
    <DropdownMenu.RadioItem className={cn(ITEM, "pl-7 relative", className)} {...props}>
      <DropdownMenu.ItemIndicator aria-hidden className="absolute left-2 text-accent">✓</DropdownMenu.ItemIndicator>
      {children}
    </DropdownMenu.RadioItem>
  );
}

export function MenuCheckboxItem({ className, children, ...props }: ComponentProps<typeof DropdownMenu.CheckboxItem>) {
  return (
    <DropdownMenu.CheckboxItem className={cn(ITEM, "pl-7 relative", className)} {...props}>
      <DropdownMenu.ItemIndicator aria-hidden className="absolute left-2 text-accent">✓</DropdownMenu.ItemIndicator>
      {children}
    </DropdownMenu.CheckboxItem>
  );
}

export function MenuSeparator() {
  return <DropdownMenu.Separator className="my-1 h-px bg-line" />;
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return <DropdownMenu.Label className="px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-muted">{children}</DropdownMenu.Label>;
}

// --- popover -------------------------------------------------------------------------------------

export const PopoverRoot = Popover.Root;
export const PopoverTrigger = Popover.Trigger;
export const PopoverAnchor = Popover.Anchor;

/**
 * A popover's own wheel and touch scrolling stop at it (2026-10-04: the emoji list of a section's icon did not scroll
 * with the mouse wheel). A popover opened from a dialog is portalled outside it, and the dialog's scroll lock
 * (react-remove-scroll, listening on the document) cancels every wheel turn and touch move outside the dialog, the
 * popover's included. Radix's non-modal popover has no lock of its own to put on top, so the events are kept from
 * reaching the document instead; nothing behind a popover needs them (the page under a dialog must not scroll anyway).
 */
function keepScrollInside(node: HTMLElement): () => void {
  const stop = (event: Event) => event.stopPropagation();
  node.addEventListener("wheel", stop, { passive: true });
  node.addEventListener("touchmove", stop, { passive: true });
  return () => {
    node.removeEventListener("wheel", stop);
    node.removeEventListener("touchmove", stop);
  };
}

/**
 * Calls `onHidden` once Radix hides the popover because its anchor is out of view (`hideWhenDetached`: floating-ui's
 * `hide` middleware clips the anchor by its scrolling ancestors, here the timeline, and the popper's wrapper then gets
 * `visibility: hidden`). Watches the wrapper's style, the only place Radix says so.
 */
function closeWhenAnchorHidden(node: HTMLElement, onHidden: () => void): () => void {
  const wrapper = node.parentElement;
  if (!wrapper?.hasAttribute("data-radix-popper-content-wrapper")) return () => {};
  const check = () => {
    if (wrapper.style.visibility === "hidden") onHidden();
  };
  const observer = new MutationObserver(check);
  observer.observe(wrapper, { attributes: true, attributeFilter: ["style"] });
  return () => observer.disconnect();
}

/**
 * Layers: the app's own floating parts stay at z-40 or below (sticky headers 10, the composer's lists 20, panes over
 * the conversation 30, overlays and banners 40); everything portalled to the body (popovers, menus, tooltips, dialogs,
 * toasts) is z-50, above all of them.
 *
 * `onAnchorHidden`: for a popover opened from something that scrolls (a message's reaction picker), close it once that
 * anchor scrolls out of view, as Slack does (2026-10-05: the picker stayed open and was carried away with the
 * message, off the conversation). A popover whose anchor does not scroll (the composer's) leaves it out.
 */
export function PopoverContent({ className, children, ref, onAnchorHidden, ...props }: ComponentProps<typeof Popover.Content> & { onAnchorHidden?: () => void }) {
  const hidden = useRef(onAnchorHidden);
  hidden.current = onAnchorHidden;
  const watch = !!onAnchorHidden;
  const own = useCallback((node: HTMLDivElement | null) => {
    if (typeof ref === "function") ref(node);
    else if (ref) ref.current = node;
    if (!node) return undefined;
    const release = keepScrollInside(node);
    const unwatch = watch ? closeWhenAnchorHidden(node, () => hidden.current?.()) : undefined;
    return () => {
      release();
      unwatch?.();
    };
  }, [ref, watch]);
  return (
    <Popover.Portal>
      <Popover.Content ref={own} sideOffset={6} collisionPadding={8} hideWhenDetached={watch || undefined} className={cn("rx-popover z-50 max-w-[calc(100vw-16px)] rounded-xl border border-line bg-canvas p-2 text-ink shadow-xl outline-none", className)} {...props}>
        {children}
      </Popover.Content>
    </Popover.Portal>
  );
}

/** "⌘" on macOS, "Ctrl" elsewhere, for shortcut hints. */
export function modKey(): string {
  return typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl";
}
