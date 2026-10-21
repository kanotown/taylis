/**
 * The drive's live signals (M161, docs/DRIVE.md §14, SYNC_PROTOCOL.md §18). The drive is never kept on the device:
 * the screens read what they show from the API, and these only say when to read it again.
 *
 * - drive.changed {location_id, folder_ids, seq}: the open folder (if listed) and the trash read again. A repeated or
 *   late event (a seq not newer than the last one seen for that location) is dropped.
 * - drive.upload.updated {upload}: the upload panel learns a background completion or an expiry.
 * - drive.location.updated {location}: the locations column reads again.
 * - After a reconnect (events may have been lost) and when my channels or my role change, everything on screen is
 *   read again ("resync" / "locations").
 */
import type { DriveChanged, DriveUploadOut } from "../api/types";

export type DriveSignal =
  | { kind: "changed"; locationId: string; folderIds: string[] }
  | { kind: "upload"; upload: DriveUploadOut }
  | { kind: "locations" }
  | { kind: "resync" };

export class DriveHub {
  private readonly listeners = new Set<(signal: DriveSignal) => void>();
  private readonly seen = new Map<string, number>();

  subscribe(listener: (signal: DriveSignal) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(signal: DriveSignal): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(signal);
      } catch (error) {
        console.warn("a drive listener failed", error);
      }
    }
  }

  applyEvent(type: string, data: Record<string, unknown>): void {
    if (type === "drive.changed") {
      const changed = data as unknown as DriveChanged;
      const last = this.seen.get(changed.location_id);
      if (last !== undefined && changed.seq <= last) return;
      this.seen.set(changed.location_id, changed.seq);
      this.emit({ kind: "changed", locationId: changed.location_id, folderIds: changed.folder_ids ?? [] });
    } else if (type === "drive.upload.updated") {
      const upload = (data as { upload?: DriveUploadOut }).upload;
      if (upload) this.emit({ kind: "upload", upload });
    } else if (type === "drive.location.updated") {
      this.emit({ kind: "locations" });
    }
  }

  /** Reconnected: whatever is open is read again. */
  online(): void {
    this.emit({ kind: "resync" });
  }

  /** My memberships or role changed: the locations (and an open one I may have lost) are read again. */
  accessMayHaveChanged(): void {
    this.emit({ kind: "locations" });
  }
}

/**
 * Several drive.changed for the open folder within `ms` read it once (§14: 300 ms). Returns the function to call for
 * each signal that concerns it, and one to cancel a pending read.
 */
export function coalesce(run: () => void, ms = 300, timers: Pick<typeof globalThis, "setTimeout" | "clearTimeout"> = globalThis): { poke: () => void; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return {
    poke() {
      if (timer) return;
      timer = timers.setTimeout(() => {
        timer = null;
        run();
      }, ms);
    },
    cancel() {
      if (timer) timers.clearTimeout(timer);
      timer = null;
    },
  };
}
