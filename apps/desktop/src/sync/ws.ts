import type { WsConnector, WsLike } from "./engine";

/** WebSocket API (available in the Tauri WebView) adapted to the engine's transport. */
export const browserConnector =
  (url: string): WsConnector =>
  (_token: string) =>
    new Promise<WsLike>((resolve, reject) => {
      const socket = new WebSocket(url);
      let messageHandler: ((data: string) => void) | null = null;
      let closeHandler: ((code: number) => void) | null = null;
      socket.onopen = () =>
        resolve({
          send: (data) => socket.send(data),
          close: () => socket.close(),
          onMessage: (handler) => {
            messageHandler = handler;
          },
          onClose: (handler) => {
            closeHandler = handler;
          },
        });
      socket.onmessage = (event: MessageEvent<string>) => messageHandler?.(event.data);
      socket.onclose = (event: CloseEvent) => closeHandler?.(event.code);
      socket.onerror = () => reject(new Error("websocket error"));
    });
