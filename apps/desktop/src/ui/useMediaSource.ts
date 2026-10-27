import { useEffect, useRef, useState } from "react";

import type { AttachmentOut } from "../api/types";
import type { AppController } from "../state/app";
import { acquireVideo } from "./videoSource";

/**
 * A video's or a sound's bytes as an object URL, through the same authenticated `fetchBlob` as the photos, shared by
 * every holder of the same attachment (videoSource.ts). `<video>` / `<audio>` cannot send the bearer token, hence the
 * blob. `enabled` false: nothing is fetched. `stream`: a URL to play from instead (M161: a drive file on the Web plays
 * from a download ticket's URL with Range, so it starts at once and seeks, not as a whole blob first).
 */
export function useMediaSource(controller: AppController, attachment: AttachmentOut, enabled = true, stream?: () => Promise<string>) {
  const api = controller.api;
  const [attempt, setAttempt] = useState(0);
  const key = `${attachment.id}/${attempt}`;
  const [state, setState] = useState({ key, api, url: null as string | null, failed: false });
  const streamRef = useRef(stream);
  streamRef.current = stream;
  useEffect(() => {
    if (!enabled) return;
    if (!api) {
      setState({ key, api, url: null, failed: true });
      return;
    }
    setState({ key, api, url: null, failed: false });
    let cancelled = false;
    const streaming = streamRef.current;
    if (streaming) {
      streaming().then(
        (url) => { if (!cancelled) setState({ key, api, url, failed: false }); },
        () => { if (!cancelled) setState({ key, api, url: null, failed: true }); },
      );
      return () => {
        cancelled = true;
      };
    }
    const handle = acquireVideo(api, attachment.id);
    handle.promise.then(
      (url) => { if (!cancelled) setState({ key, api, url, failed: false }); },
      () => { if (!cancelled) setState({ key, api, url: null, failed: true }); },
    );
    return () => {
      cancelled = true;
      handle.release();
    };
  }, [attachment.id, api, enabled, key]);
  const current = enabled && state.key === key && state.api === api;
  return {
    url: current ? state.url : null,
    failed: current && state.failed,
    retry: () => setAttempt((value) => value + 1),
  };
}
