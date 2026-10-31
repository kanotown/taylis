import { type FocusEvent, type KeyboardEvent, type PointerEvent, useEffect, useRef, useState } from "react";

/**
 * The viewers' video controls only while they are wanted (2026-10-31, docs/PREVIEWS.md §12.2). Chromium and WebKit
 * keep their own controls (and the dark scrim behind them) on screen for as long as a clip is paused, so a paused
 * frame stayed dimmed after the mouse had left it. The `controls` attribute is now on while a mouse is over the
 * video, while it (or one of its controls) has the keyboard focus, and always on a screen without hover (touch:
 * a tap must find the play button). Leaving with a button held (dragging the time bar out) waits for the release.
 * The element stays focusable (`tabIndex` 0) so the keyboard can bring the controls back; focus from a click does not
 * hold them (the mouse leaving still brightens the frame), focus from Tab or a key pressed on the video does.
 */
export function useHoverControls(): {
  controls: boolean;
  props: {
    tabIndex: number;
    onPointerEnter: (event: PointerEvent<HTMLVideoElement>) => void;
    onPointerMove: (event: PointerEvent<HTMLVideoElement>) => void;
    onPointerLeave: (event: PointerEvent<HTMLVideoElement>) => void;
    onPointerDown: () => void;
    onKeyDown: (event: KeyboardEvent<HTMLVideoElement>) => void;
    onFocus: (event: FocusEvent<HTMLVideoElement>) => void;
    onBlur: (event: FocusEvent<HTMLVideoElement>) => void;
  };
} {
  const [hover, setHover] = useState(false);
  const [focused, setFocused] = useState(false);
  const [touch] = useState(() => noHover());
  const release = useRef<(() => void) | null>(null);
  const pressed = useRef(false);
  useEffect(() => () => release.current?.(), []);
  const enter = (event: PointerEvent<HTMLVideoElement>) => {
    release.current?.();
    if (event.pointerType === "mouse" || event.pointerType === "pen") setHover(true);
  };
  return {
    controls: touch || hover || focused,
    props: {
      tabIndex: 0,
      onPointerEnter: enter,
      // A video opened under a resting mouse gets no enter: the first move counts.
      onPointerMove: (event) => { if (!hover) enter(event); },
      onPointerLeave: (event) => {
        if (event.pointerType !== "mouse" && event.pointerType !== "pen") return;
        if (event.buttons === 0 || typeof window === "undefined") {
          setHover(false);
          return;
        }
        const up = () => {
          release.current?.();
          setHover(false);
        };
        window.addEventListener("pointerup", up, { once: true });
        release.current = () => {
          window.removeEventListener("pointerup", up);
          release.current = null;
        };
      },
      onPointerDown: () => { pressed.current = true; },
      onKeyDown: () => setFocused(true),
      onFocus: () => {
        setFocused(!pressed.current);
        pressed.current = false;
      },
      onBlur: () => {
        setFocused(false);
        pressed.current = false;
      },
    },
  };
}

function noHover(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(hover: none)").matches;
}
