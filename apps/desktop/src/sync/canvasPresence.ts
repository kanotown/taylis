/**
 * M72 (CANVAS.md §18.2): 「編集中」 on a canvas — the volatile `canvas_presence` frames. Pure, so the tests read them.
 *
 * Sending: `editing: true` while the editor has the focus and is used, again at once when the caret's heading changes,
 * else every REFRESH_MS; `editing: false` when it stops (blur, close, another canvas) — only after a true went out.
 * Receiving: an editor shows until TTL_MS pass without a refresh (or a false arrives).
 */

export const CANVAS_PRESENCE_REFRESH_MS = 20_000;
export const CANVAS_PRESENCE_TTL_MS = 45_000;

export interface CanvasPresenceOut {
  type: "canvas_presence";
  canvas_id: string;
  editing: boolean;
  section: string | null;
}

/** What this device last said per canvas; decides which frames go out. */
export class CanvasPresenceSender {
  private readonly sent = new Map<string, { editing: boolean; section: string | null; at: number }>();

  /** The frame to send for this state now, or null (nothing new to say). */
  next(canvasId: string, editing: boolean, section: string | null, now: number): CanvasPresenceOut | null {
    const shown = section?.trim().replace(/\s+/g, " ").slice(0, 120) || null;
    const last = this.sent.get(canvasId);
    if (!editing) {
      if (!last?.editing) return null;
      this.sent.delete(canvasId);
      return { type: "canvas_presence", canvas_id: canvasId, editing: false, section: null };
    }
    if (last?.editing && last.section === shown && now - last.at < CANVAS_PRESENCE_REFRESH_MS) return null;
    this.sent.set(canvasId, { editing: true, section: shown, at: now });
    return { type: "canvas_presence", canvas_id: canvasId, editing: true, section: shown };
  }

  /** A new connection: the server knows nothing of before, so the next true goes out at once. */
  reset(): void {
    this.sent.clear();
  }
}

export interface CanvasEditor {
  userId: string;
  section: string | null;
}

/** Who edits which canvas, as the frames said (kept by the store; expired entries are skipped when read). */
export class CanvasEditors {
  private readonly byCanvas = new Map<string, Map<string, { section: string | null; until: number }>>();

  /** A frame from someone else: true (re)starts their entry for TTL_MS, false ends it. Returns whether it changed. */
  note(canvasId: string, userId: string, editing: boolean, section: string | null, now: number): boolean {
    const users = this.byCanvas.get(canvasId) ?? new Map<string, { section: string | null; until: number }>();
    for (const [other, entry] of users) if (entry.until <= now) users.delete(other); // keep the map small
    let changed: boolean;
    if (editing) {
      changed = users.get(userId)?.section !== section || !users.has(userId);
      users.set(userId, { section, until: now + CANVAS_PRESENCE_TTL_MS });
    } else {
      changed = users.delete(userId);
    }
    if (users.size > 0) this.byCanvas.set(canvasId, users);
    else this.byCanvas.delete(canvasId);
    return changed || editing;
  }

  /** Those editing the canvas now, in the order they started. */
  of(canvasId: string, now: number): CanvasEditor[] {
    const users = this.byCanvas.get(canvasId);
    if (!users) return [];
    return [...users].filter(([, entry]) => entry.until > now).map(([userId, entry]) => ({ userId, section: entry.section }));
  }

  /** The soonest moment an entry of this canvas expires (to re-render then), or null. */
  nextExpiry(canvasId: string, now: number): number | null {
    const users = this.byCanvas.get(canvasId);
    if (!users) return null;
    const times = [...users.values()].map((e) => e.until).filter((t) => t > now);
    return times.length ? Math.min(...times) : null;
  }

  clear(): void {
    this.byCanvas.clear();
  }
}

/** 「〇〇 が編集中」, 「〇〇、△△ が編集中」, 「〇〇 ほか N 人が編集中」. */
export function editingLabel(names: readonly string[]): string {
  if (names.length === 0) return "";
  if (names.length <= 2) return `${names.join("、")} が編集中`;
  return `${names[0]} ほか ${names.length - 1} 人が編集中`;
}
