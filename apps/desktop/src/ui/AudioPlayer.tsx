import { Download, Loader2, Music, Pause, Play } from "lucide-react";
import { type KeyboardEvent, useCallback, useEffect, useRef, useState } from "react";

import type { AttachmentOut } from "../api/types";
import type { AppController } from "../state/app";
import { t } from "../i18n";
import { formatDuration, formatSize } from "./attachmentLayout";
import { FileName } from "./FileName";
import { claimPlayback, releasePlayback } from "./playbackFocus";
import { cn } from "./primitives";
import { useMediaSource } from "./useMediaSource";
import { type PlaybackProblem, playbackProblem, STREAM_RENEWALS_MAX, STREAM_STALL_MS, STREAM_TICKET_STALE_MS } from "./videoPlayback";

/** "m:ss" of a position in seconds (the tile's formatDuration). */
function clock(seconds: number): string {
  return formatDuration(Math.max(0, seconds) * 1000) ?? "0:00";
}

/** A key event that should toggle the player: Space, unless a button (which presses itself) or a text field has it. */
function togglesOnSpace(event: KeyboardEvent | globalThis.KeyboardEvent): boolean {
  if (event.key !== " " && event.code !== "Space") return false;
  if (event.altKey || event.metaKey || event.ctrlKey) return false;
  const target = event.target as HTMLElement | null;
  if (target?.closest?.("button, textarea, select, [contenteditable='true'], input:not([type='range'])")) return false;
  return true;
}

/**
 * A sound in the app (2026-10-28, docs/PREVIEWS.md §13): play / pause, the name and size, a seek bar with the time,
 * and the download, in a compact row as Slack draws an audio attachment. The bytes are fetched only when it is first
 * played (with the bearer token, as a blob: useMediaSource; a drive file on the Web streams from a ticket's URL, which
 * is renewed when it lapsed as the video viewer's is). A sound this engine cannot decode (MediaError 3 / 4 before it
 * loaded: Ogg / Opus in an older WebKit, AIFF in Chromium) says so with the download instead of trying again.
 *
 * Only one thing plays at a time (playbackFocus.ts). Space toggles it while the row has the focus (`spaceAnywhere`: in
 * the viewer, wherever the focus is but on a button or a field).
 */
export function AudioPlayer({ attachment, controller, tone = "panel", autoPlay = false, stream, downloadable = true, spaceAnywhere = false }: {
  attachment: AttachmentOut;
  controller: AppController;
  /** "panel": in a message (the app's colours); "dark": in the viewer's dark card. */
  tone?: "panel" | "dark";
  autoPlay?: boolean;
  stream?: () => Promise<string>;
  /** False while the message is being sent (no download yet). */
  downloadable?: boolean;
  spaceAnywhere?: boolean;
}) {
  const audio = useRef<HTMLAudioElement>(null);
  const [wanted, setWanted] = useState(autoPlay);
  const [pendingPlay, setPendingPlay] = useState(autoPlay);
  const { url, failed, retry } = useMediaSource(controller, attachment, wanted, stream);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const known = attachment.duration_ms != null && attachment.duration_ms > 0 ? attachment.duration_ms / 1000 : null;
  const [duration, setDuration] = useState<number | null>(known);
  const [problem, setProblem] = useState<PlaybackProblem | null>(null);
  const playback = useRef({ played: false, urlAt: 0, renewals: 0, at: 0, playing: false, resume: null as { at: number; playing: boolean } | null });
  const stall = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearStall = useCallback(() => {
    if (stall.current) clearTimeout(stall.current);
    stall.current = null;
  }, []);

  const start = useCallback(() => {
    const element = audio.current;
    if (!element) return;
    const played = element.play();
    // Refused without a fresh click (WebKit on the Web after the fetch): it stays paused, the next press plays at once.
    // Any other failure arrives as the element's `error`.
    if (played && typeof played.catch === "function") played.catch(() => setPlaying(false));
  }, []);

  useEffect(() => {
    if (!url) return;
    playback.current.played = false;
    playback.current.urlAt = Date.now();
  }, [url]);
  useEffect(() => {
    if (!url || !pendingPlay) return;
    setPendingPlay(false);
    start();
  }, [url, pendingPlay, start]);
  useEffect(() => {
    const element = audio.current;
    return () => {
      clearStall();
      releasePlayback(element);
    };
  }, [clearStall]);

  const again = useCallback((automatic: boolean) => {
    clearStall();
    const state = playback.current;
    if (automatic) state.renewals += 1;
    else state.renewals = 0;
    const resume = { at: state.at, playing: automatic ? state.playing : true };
    state.resume = resume;
    setProblem(null);
    setPendingPlay(resume.playing);
    retry();
  }, [clearStall, retry]);

  const shown: PlaybackProblem | null = problem ?? (failed ? "network" : null);
  const loading = wanted && !url && !failed;

  const toggle = useCallback(() => {
    if (shown === "unsupported") return;
    if (shown === "network") {
      again(false);
      return;
    }
    const element = audio.current;
    if (!url || !element) {
      setWanted(true);
      setPendingPlay((value) => !value); // a second press while it loads: do not start after all
      return;
    }
    if (element.paused) start();
    else element.pause();
  }, [again, shown, start, url]);
  const toggleRef = useRef(toggle);
  toggleRef.current = toggle;

  useEffect(() => {
    if (!spaceAnywhere) return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented || !togglesOnSpace(event)) return;
      event.preventDefault();
      toggleRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [spaceAnywhere]);

  const onError = (element: HTMLAudioElement) => {
    const state = playback.current;
    const kind = playbackProblem(element.error?.code, state.played);
    if (kind === "network" && stream && state.renewals < STREAM_RENEWALS_MAX) {
      again(true);
      return;
    }
    clearStall();
    setPlaying(false);
    setProblem(kind);
  };
  const onWaiting = () => {
    if (!stream || stall.current) return;
    stall.current = setTimeout(() => {
      stall.current = null;
      const state = playback.current;
      if (Date.now() - state.urlAt >= STREAM_TICKET_STALE_MS && state.renewals < STREAM_RENEWALS_MAX) again(true);
    }, STREAM_STALL_MS);
  };
  const learnDuration = (element: HTMLAudioElement) => {
    if (Number.isFinite(element.duration) && element.duration > 0) setDuration(element.duration);
  };

  const dark = tone === "dark";
  const icon = loading && pendingPlay ? <Loader2 size={18} className="animate-spin" aria-hidden />
    : playing ? <Pause size={18} fill="currentColor" aria-hidden />
    : <Play size={18} fill="currentColor" className="translate-x-px" aria-hidden />;
  const label = loading && pendingPlay ? t("attach.loadingAudio") : playing ? t("attach.pauseAudio") : t("attach.playAudio");
  const ready = url !== null && duration !== null && !shown;
  return (
    <div
      data-audio-player=""
      data-state={shown ?? (playing ? "playing" : loading ? "loading" : "paused")}
      role="group"
      aria-label={t("attach.audioPlayer", { name: attachment.filename })}
      tabIndex={0}
      onKeyDown={(event) => {
        if (spaceAnywhere || !togglesOnSpace(event)) return;
        event.preventDefault();
        toggle();
      }}
      className={cn(
        "flex max-w-full items-center gap-3 rounded-xl border px-3 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
        dark ? "w-[28rem] border-white/15 bg-white/5 text-white" : "w-80 border-line bg-panel text-ink",
      )}
    >
      <button
        type="button"
        data-audio-toggle=""
        aria-label={label}
        title={label}
        disabled={shown === "unsupported"}
        onClick={toggle}
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent-solid text-white shadow-sm hover:bg-accent-solid/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 disabled:opacity-40"
      >
        {shown === "unsupported" ? <Music size={16} aria-hidden /> : icon}
      </button>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        {/* The name has the whole line; the size stands where the time will be until the sound has loaded. */}
        <FileName name={attachment.filename} className="min-w-0 text-sm font-medium" />

        {shown ? (
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <p role="status" data-audio-problem={shown} className={cn("text-xs", dark ? "text-white/80" : "text-muted")}>
              {shown === "unsupported" ? t("attach.audioUnplayable") : t("attach.audioFailed")}
            </p>
            {shown === "network" && (
              <button type="button" className={cn("text-xs font-medium underline-offset-2 hover:underline", dark ? "text-white" : "text-accent")} onClick={() => again(false)}>
                {t("common.retry")}
              </button>
            )}
          </div>
        ) : (
          <div className="flex min-w-0 items-center gap-2">
            <input
              type="range"
              data-audio-seek=""
              min={0}
              max={ready ? duration : 1}
              step="any"
              value={ready ? Math.min(time, duration) : 0}
              disabled={!ready}
              aria-label={t("attach.seek")}
              aria-valuetext={duration ? `${clock(time)} / ${clock(duration)}` : clock(time)}
              onChange={(event) => {
                const value = Number(event.currentTarget.value);
                const element = audio.current;
                if (element && Number.isFinite(value)) element.currentTime = value;
                setTime(value);
              }}
              className="h-1 min-w-0 flex-1 cursor-pointer accent-accent-solid disabled:cursor-default disabled:opacity-50"
            />
            <span data-audio-time="" className={cn("shrink-0 text-xs tabular-nums", dark ? "text-white/70" : "text-muted")}>
              {url && duration ? `${clock(time)} / ${clock(duration)}` : url ? clock(time) : [formatDuration(attachment.duration_ms), formatSize(attachment.size_bytes)].filter(Boolean).join(" · ")}
            </span>
          </div>
        )}
      </div>
      {downloadable && (
        <button
          type="button"
          data-audio-download=""
          title={t("attach.download")}
          aria-label={t("attach.downloadName", { name: attachment.filename })}
          onClick={() => void controller.downloadAttachment(attachment)}
          className={cn("flex h-8 w-8 shrink-0 items-center justify-center rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent", dark ? "text-white/80 hover:bg-white/15" : "text-muted hover:bg-accent-soft/60 hover:text-ink")}
        >
          <Download size={16} aria-hidden />
        </button>
      )}
      <audio
        ref={audio}
        src={url ?? undefined}
        preload="metadata"
        hidden
        onPlay={(event) => {
          claimPlayback(event.currentTarget);
          playback.current.playing = true;
          setPlaying(true);
        }}
        onPause={() => {
          playback.current.playing = false;
          setPlaying(false);
        }}
        onEnded={() => {
          playback.current.playing = false;
          setPlaying(false);
        }}
        onLoadedMetadata={(event) => {
          const element = event.currentTarget;
          learnDuration(element);
          const state = playback.current;
          state.played = true;
          const resume = state.resume;
          state.resume = null;
          if (resume && resume.at > 0) element.currentTime = resume.at;
        }}
        onDurationChange={(event) => learnDuration(event.currentTarget)}
        onTimeUpdate={(event) => {
          playback.current.at = event.currentTarget.currentTime;
          setTime(event.currentTarget.currentTime);
        }}
        onPlaying={() => {
          playback.current.renewals = 0;
          clearStall();
        }}
        onWaiting={onWaiting}
        onStalled={onWaiting}
        onProgress={clearStall}
        onCanPlay={clearStall}
        onError={(event) => onError(event.currentTarget)}
      />
    </div>
  );
}
