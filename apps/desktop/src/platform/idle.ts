/**
 * Whether the reader has left the computer (PUSH_NOTIFICATIONS.md §4.1): no key, pointer, wheel or touch input for
 * `IDLE_MS` while the window kept its focus. A focused window counts as in use and the server holds back the phone's
 * pushes; a window left open on an unattended computer held them back for good (2026-09-29).
 */
export const IDLE_MS = 5 * 60_000;

const INPUT = ["keydown", "pointerdown", "pointermove", "wheel", "touchstart"] as const;

export class IdleWatch {
  private last: number;
  private idle = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  /** `onChange` runs when the reader leaves and when they come back. */
  constructor(private readonly onChange: () => void, private readonly now: () => number = Date.now, private readonly idleMs = IDLE_MS) {
    this.last = now();
  }

  get isIdle(): boolean {
    return this.idle;
  }

  start(target: EventTarget = window): void {
    for (const type of INPUT) target.addEventListener(type, this.input, { capture: true, passive: true });
    this.arm(this.idleMs);
  }

  /** Input: the reader is here (and was away until now). */
  readonly input = (): void => {
    this.last = this.now();
    if (!this.idle) return;
    this.idle = false;
    this.arm(this.idleMs);
    this.onChange();
  };

  /** One timer, not one per input: when it fires early (input came meanwhile) it waits for the rest. */
  private arm(delay: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      const quiet = this.now() - this.last;
      if (quiet < this.idleMs) {
        this.arm(this.idleMs - quiet);
        return;
      }
      this.idle = true;
      this.onChange();
    }, delay);
  }
}

/**
 * Sent on `window` when the reader comes back to a window that stayed focused: the conversation on screen is read
 * then, as when the window comes to the front (nothing is marked read while they are away).
 */
export const READER_BACK = "chikuwa-reader-back";

let watch: IdleWatch | null = null;

/** Starts watching this window's input (main.tsx); `onChange` as in IdleWatch. */
export function watchIdle(onChange: () => void): void {
  watch ??= new IdleWatch(() => {
    onChange();
    if (!watch?.isIdle) window.dispatchEvent(new Event(READER_BACK));
  });
  watch.start();
}

/** The reader has not touched this window for IDLE_MS (never before watchIdle). */
export function readerIdle(): boolean {
  return watch?.isIdle ?? false;
}
