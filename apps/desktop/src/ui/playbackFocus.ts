/**
 * Only one thing plays at a time (2026-10-28, docs/PREVIEWS.md §13): starting an audio row, the audio viewer or a video
 * in the viewer pauses whichever was playing before (as Slack does). The players call `claimPlayback` from their
 * `play` event and `releasePlayback` when they go away.
 */
let current: HTMLMediaElement | null = null;

export function claimPlayback(element: HTMLMediaElement): void {
  const previous = current;
  current = element;
  if (previous && previous !== element && !previous.paused) {
    try {
      previous.pause();
    } catch {
      // an element already torn down: nothing plays there
    }
  }
}

export function releasePlayback(element: HTMLMediaElement | null): void {
  if (element && current === element) current = null;
}

/** Test hook. */
export function playingElement(): HTMLMediaElement | null {
  return current;
}
