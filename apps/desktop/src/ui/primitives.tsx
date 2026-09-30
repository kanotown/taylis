/** Small design-system layer: Tailwind classes + Radix primitives + Lucide icons. */
import { clsx, type ClassValue } from "clsx";
import { X } from "lucide-react";
import { Dialog, DropdownMenu, Popover, Tooltip } from "radix-ui";
import { type ButtonHTMLAttributes, type ComponentProps, forwardRef, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from "react";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

type Variant = "primary" | "secondary" | "ghost" | "danger" | "link";
type Size = "sm" | "md" | "icon";

const BASE =
  "inline-flex select-none items-center justify-center font-medium whitespace-nowrap transition-colors disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50";
const VARIANTS: Record<Variant, string> = {
  primary: "bg-accent text-white shadow-sm hover:bg-accent/90",
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
            className={cn(BASE, SIZES.icon, tone === "sidebar" ? "text-sidebar-fg hover:bg-sidebar-hover hover:text-white" : VARIANTS.ghost, className)}
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
}: {
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
  className?: string;
  hideClose?: boolean;
}) {
  return (
    <Dialog.Root open onOpenChange={(open) => { if (!open) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="rx-overlay fixed inset-0 z-40 bg-black/40 backdrop-blur-[2px]" />
        <Dialog.Content
          className={cn(
            "rx-dialog fixed left-1/2 top-1/2 z-50 max-h-[85dvh] w-[460px] max-w-[92vw] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-2xl border border-line bg-canvas p-5 text-ink shadow-2xl focus:outline-none max-md:p-4",
            className,
          )}
        >
          <Dialog.Title className={cn("text-base font-semibold", title ? "" : "sr-only")}>{title || "ダイアログ"}</Dialog.Title>
          <Dialog.Description className={cn("mt-1 text-sm text-muted", description ? "" : "sr-only")}>{description ?? title}</Dialog.Description>
          {children}
          {!hideClose && (
            <Dialog.Close asChild>
              <button type="button" aria-label="閉じる" className={cn(BASE, VARIANTS.ghost, "absolute right-3 top-3 h-7 w-7 rounded-md text-muted")}>
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

export function PopoverContent({ className, children, ...props }: ComponentProps<typeof Popover.Content>) {
  return (
    <Popover.Portal>
      <Popover.Content sideOffset={6} collisionPadding={8} className={cn("rx-popover z-50 max-w-[calc(100vw-16px)] rounded-xl border border-line bg-canvas p-2 text-ink shadow-xl outline-none", className)} {...props}>
        {children}
      </Popover.Content>
    </Popover.Portal>
  );
}

/** "⌘" on macOS, "Ctrl" elsewhere, for shortcut hints. */
export function modKey(): string {
  return typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl";
}
