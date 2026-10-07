import { isTauri } from "../platform/env";

/**
 * In-app updates (「更新して再起動」, desktop only). The Tauri updater reads latest.json from the latest GitHub Release
 * of kanotown/taylis (tauri.conf.json plugins.updater; docs/DEVELOPMENT.md 「デスクトップ版のリリース」)
 * and checks the download against the updater key's signature. This side decides when to look (at start and every
 * 6 hours), what the banner shows, and the order of 更新: download → save what is pending (drafts, the send queue)
 * → install → relaunch. Windows' installer quits the app as it starts, so the saving comes before installing.
 * The web build never looks: the server it is served from is its update.
 */

export const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** What the banner needs of an available update (a thin view of the plugin's `Update`). */
export interface AvailableUpdate {
  version: string;
  /** The release notes (latest.json `notes`); the banner shows the first line. */
  body?: string;
  download(onEvent: (event: UpdateDownloadEvent) => void): Promise<void>;
  install(): Promise<void>;
}

export type UpdateDownloadEvent =
  | { event: "Started"; data: { contentLength?: number } }
  | { event: "Progress"; data: { chunkLength: number } }
  | { event: "Finished" };

export interface UpdaterDeps {
  /** The Tauri app (the web build never checks). */
  isDesktop: () => boolean;
  check: () => Promise<AvailableUpdate | null>;
  relaunch: () => Promise<void>;
  currentVersion: () => Promise<string>;
}

export type UpdateStatus = "idle" | "checking" | "available" | "downloading" | "installing";

/** The first non-empty line of the release notes, without a Markdown heading mark. */
export function notesFirstLine(body: string | undefined): string {
  for (const line of (body ?? "").split(/\r?\n/)) {
    const text = line.replace(/^#+\s*/, "").trim();
    if (text) return text;
  }
  return "";
}

/** 「v0.1.20」: tags carry the v, the updater's versions do not. */
export function versionLabel(version: string): string {
  return version.startsWith("v") ? version : `v${version}`;
}

export const tauriUpdaterDeps: UpdaterDeps = {
  isDesktop: isTauri,
  async check() {
    const { check } = await import("@tauri-apps/plugin-updater");
    return check();
  },
  async relaunch() {
    const { relaunch } = await import("@tauri-apps/plugin-process");
    await relaunch();
  },
  async currentVersion() {
    const { getVersion } = await import("@tauri-apps/api/app");
    return getVersion();
  },
};

export class UpdateChecker {
  status: UpdateStatus = "idle";
  /** The update found by the last check (null: none, or not looked yet). */
  available: AvailableUpdate | null = null;
  /** 「あとで」: the banner stays hidden until the next start (the settings button still offers it). */
  dismissed = false;
  /** Bytes downloaded and the total (null when the server does not say). */
  progress: { downloaded: number; total: number | null } | null = null;
  /** The running app's version (null until read, and in the web build). */
  currentVersion: string | null = null;
  /** The last check failed (the settings do not say 「最新の版です」 then). */
  lastCheckFailed = false;
  /** Bumped on every change (useSyncExternalStore). */
  version = 0;

  private readonly listeners = new Set<() => void>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private running: Promise<AvailableUpdate | null> | null = null;
  /**
   * Review v0.1.30 #6: the install under way (download → prepare → install → relaunch), held apart from the shown
   * `status`. While it runs no second install starts, and a check that was already on its way when it began changes
   * neither the status nor the update (its answer is dropped).
   */
  private installing: Promise<boolean> | null = null;

  /** An install is under way (the buttons stay disabled whatever a late check says). */
  get installInProgress(): boolean {
    return this.installing !== null;
  }

  constructor(
    private readonly deps: UpdaterDeps = tauriUpdaterDeps,
    /** The app's error toast. */
    private readonly onError: (error: unknown) => void = (err) => console.error("update failed", err),
  ) {}

  get enabled(): boolean {
    return this.deps.isDesktop();
  }

  /** The banner: an update found, not put off with 「あとで」. */
  get bannerVisible(): boolean {
    return this.available !== null && !this.dismissed;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    this.version += 1;
    for (const listener of this.listeners) listener();
  }

  /** At start: read the version, look now and every 6 hours. Nothing in the web build. */
  start(): void {
    if (!this.enabled || this.timer !== null) return;
    void this.readCurrentVersion();
    void this.check(false);
    this.timer = setInterval(() => void this.check(false), UPDATE_CHECK_INTERVAL_MS);
  }

  /** The running app's version (tauri.conf.json, set from the release tag at build time); null in the web build. */
  async readCurrentVersion(): Promise<string | null> {
    if (!this.enabled) return null;
    if (this.currentVersion !== null) return this.currentVersion;
    try {
      this.currentVersion = await this.deps.currentVersion();
      this.emit();
    } catch (err) {
      console.warn("could not read the app version", err);
    }
    return this.currentVersion;
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Looks for an update. The automatic checks stay quiet when they fail (offline, GitHub down: the next one
   * follows); the settings button (`manual`) shows the error. Resolves to the update found, or null.
   */
  async check(manual: boolean): Promise<AvailableUpdate | null> {
    if (!this.enabled) return null;
    if (this.installing) return this.available;
    if (this.running) return this.running;
    this.status = "checking";
    this.emit();
    const run = (async () => {
      try {
        const found = await this.deps.check();
        if (this.installing) return found; // 「更新して再起動」 was pressed meanwhile: the install keeps the screen
        // A newer version than the one put off brings the banner back.
        if (found && this.available && found.version !== this.available.version) this.dismissed = false;
        if (manual && found) this.dismissed = false;
        this.available = found;
        this.lastCheckFailed = false;
        this.status = found ? "available" : "idle";
        return found;
      } catch (err) {
        if (this.installing) {
          console.warn("update check failed", err);
          return null;
        }
        this.status = this.available ? "available" : "idle";
        this.lastCheckFailed = true;
        if (manual) this.onError(err);
        else console.warn("update check failed", err);
        return null;
      } finally {
        this.running = null;
        this.emit();
      }
    })();
    this.running = run;
    return run;
  }

  /** 「あとで」. */
  later(): void {
    this.dismissed = true;
    this.emit();
  }

  /**
   * 「更新して再起動」: download (with progress), save what is pending (`prepare`: drafts, the send queue, canvases),
   * install and relaunch. A failure shows the error toast and leaves the banner for another try.
   */
  install(prepare: () => Promise<void>): Promise<boolean> {
    const update = this.available;
    if (!update || this.installing) return Promise.resolve(false);
    const run = this.runInstall(update, prepare);
    this.installing = run;
    return run;
  }

  private async runInstall(update: AvailableUpdate, prepare: () => Promise<void>): Promise<boolean> {
    this.status = "downloading";
    this.progress = { downloaded: 0, total: null };
    this.emit();
    try {
      await update.download((event) => {
        if (event.event === "Started") this.progress = { downloaded: 0, total: event.data.contentLength ?? null };
        else if (event.event === "Progress") this.progress = { downloaded: (this.progress?.downloaded ?? 0) + event.data.chunkLength, total: this.progress?.total ?? null };
        else return;
        this.emit();
      });
      this.status = "installing";
      this.emit();
      await prepare();
      await update.install(); // Windows: the installer takes over and the app quits here
      await this.deps.relaunch();
      return true;
    } catch (err) {
      this.installing = null;
      this.status = this.available ? "available" : "idle";
      this.progress = null;
      this.emit();
      this.onError(err);
      return false;
    }
  }
}
