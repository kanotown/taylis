/**
 * M153a (docs/WIKI.md §30.3): the bridge between the bundled page editor (apps/desktop/mobile-editor → the files in
 * apps/shared/mobile-editor/dist, shown in a WKWebView / Android WebView while a page is edited) and the native app
 * around it. No dependencies: these types are the contract Swift and Kotlin encode and decode, and
 * ../bridge_messages.json holds one example of every message for their tests (apps/desktop/tests/mobileEditorBridge.test.ts
 * reads the same file).
 *
 * Transport
 * - native → web: `window.taylisEditor.receive(json)` — a JSON string (`evaluateJavaScript` with a string literal) or an
 *   object literal. Messages that arrive before the editor listens are queued and handed over in order.
 * - web → native: one JSON string per message, posted to `window.webkit.messageHandlers.taylis.postMessage` (iOS,
 *   a WKScriptMessageHandler named "taylis") or `TaylisBridge.post` (Android, a @JavascriptInterface named
 *   "TaylisBridge"). Neither present (a desktop browser, the tests): the messages go nowhere unless a transport is given
 *   (`?dev=1` installs the harness, apps/desktop/src/mobileEditor/devHarness.ts).
 *
 * The editor never talks to the server: pages, people, emoji, pictures and links go through these messages, and the
 * access token never reaches the WebView (CSP: connect-src 'none', apps/desktop/mobile-editor/index.html).
 */

/**
 * Bumped when a message changes shape; `ready` carries it so native can refuse a bundle it does not know.
 * 2 (2026-10-10): the body's generation (`load.gen` / `replace.gen` → `changed.baseGen` / `bodyRequested.baseGen`), the
 * request's id (`requestBody.id` → `bodyRequested.id`) and `bodyRequested {loaded: false}` before any `load`. Messages
 * without them are still taken (native then gets no `baseGen` / `id` back).
 */
export const BRIDGE_VERSION = 2;

export type EditorTheme = "light" | "dark" | "system";

/** A native toolbar's buttons (`command`): the same actions as the editor's own formatting row. */
export const EDITOR_COMMANDS = [
  "bold", "italic", "strike", "code",
  "h1", "h2", "h3",
  "bullet", "ordered", "task", "quote", "codeBlock", "divider",
  "link", "mention", "slash", "image", "table",
  "undo", "redo", "indent", "outdent",
] as const;
export type EditorCommand = (typeof EDITOR_COMMANDS)[number];

/** A person or a group `@` offers (`providePeople`); `<@id>` / `<@group:id>` chips show their names. */
export interface BridgePerson {
  id: string;
  /** What is typed after `@` (a group's name for a group). */
  username: string;
  display_name: string;
  /** Default "user". */
  kind?: "user" | "group";
  /** An AI bot (shown with the 「AI」 badge). */
  ai?: boolean;
  /** A group's size, for its row's label. */
  members?: number;
  description?: string | null;
}

/** A page `[[`, `@` and ⌘K offer (`providePages`), and the icon / title of `[label](page:id)` chips. */
export interface BridgePage {
  id: string;
  title: string;
  icon?: string | null;
  kind?: "page" | "database" | "row";
}

/** A custom emoji of the workspace (`provideEmoji`): `:name:` is drawn from `url` (an image) or as a text pill. */
export interface BridgeEmoji {
  name: string;
  /** The image's URL (native's scheme, fetched with the session). Absent for a text emoji. */
  url?: string | null;
  label?: string | null;
  kind?: "image" | "text";
  /** A text emoji's palette colour (apps/shared/text-emoji.json). */
  color?: string | null;
  width?: number;
  height?: number;
}

export type NativeMessage =
  /**
   * A page's body into the editor (a new editor each time). `caretLine`: the body line to put the caret on (coming
   * from the Markdown editor). `attachmentUrl`: where `![alt](attachment:<id>)` images load from, with `{id}` for the
   * id (e.g. `taylis-editor://app/attachment/{id}`); without it an image shows as a box with its alt text.
   * `gen`: native's number for this body (see `replace`); the editor's `changed` / `bodyRequested` carry it back.
   */
  | { type: "load"; body: string; title?: string; theme?: EditorTheme; readOnly?: boolean; caretLine?: number | null; locale?: string | null; attachmentUrl?: string | null; gen?: number }
  /**
   * The body as the server now holds it (a merge, someone else's version): only the blocks that changed are replaced,
   * outside the undo history. Not while an IME composition is open or an edit waits to be written: the body then waits
   * for the composition to end, and an edit written first drops it (the next `changed` carries the editor's text, which
   * the server merges again). `gen`: native's number for this body. The editor's `changed` / `bodyRequested` say which
   * body their text was written on (`baseGen`: the `gen` of the last `load` / `replace` it took), so native saves a text
   * written before a dropped `replace` on the version that text came from, never on the merged one (docs/WIKI.md §30.3).
   */
  | { type: "replace"; body: string; gen?: number }
  | { type: "setTheme"; theme: EditorTheme }
  /**
   * What the keyboard covers, in CSS px, when the WebView is not resized above it (0 when it is): the formatting row
   * sits above the keyboard and the caret is scrolled clear of it. `safeBottom`: the home indicator's inset.
   */
  | { type: "setViewport"; keyboardHeight: number; safeBottom?: number }
  /** A picture native uploaded (after `pickImage`): an image block at the caret. `url`: this image's own URL, if not the template's. */
  | { type: "insertImage"; attachmentId: string; url?: string | null; alt?: string }
  /** The people `@` offers: the whole directory (sent after `load`, and again whenever it changes). */
  | { type: "providePeople"; people: BridgePerson[] }
  /** The answer to `needPages` for `query` (null: the whole tree; the editor then filters by title itself). */
  | { type: "providePages"; query: string | null; pages: BridgePage[] }
  | { type: "provideEmoji"; emoji: BridgeEmoji[] }
  | { type: "focus" }
  | { type: "blur" }
  /**
   * The body as the editor holds it now, at once (`bodyRequested`): before saving on leave, before switching to Markdown.
   * `id`: given back in the answer (native ignores an answer to another request, e.g. one from before a reload).
   */
  | { type: "requestBody"; id?: number }
  /** A native toolbar's button. */
  | { type: "command"; name: EditorCommand };

export type WebMessage =
  /** The page is up and listening: `load` may follow. */
  | { type: "ready"; version: number }
  /**
   * The body changed (typing paused 300 ms, or the editor lost the focus). `dirty`: differs from the last load / replace.
   * `baseGen`: the `gen` of the last `load` / `replace` the editor took (absent when native sent none).
   */
  | { type: "changed"; body: string; dirty: boolean; baseGen?: number }
  /** The answer to `requestBody` (`id` as asked), `baseGen` as in `changed`. */
  | { type: "bodyRequested"; body: string; dirty: boolean; caretLine: number; baseGen?: number; id?: number }
  /**
   * The answer to `requestBody` before any `load` (e.g. the page read again after its web process ended): there is no
   * body, and native must not take this for an empty one.
   */
  | { type: "bodyRequested"; loaded: false; id?: number }
  /** The body line the caret's block starts on (sent when the editor loses the focus; the Markdown editor opens there). */
  | { type: "caret"; line: number }
  /** The document's height in CSS px, when it changed (for a WebView sized to its content). */
  | { type: "height"; px: number }
  /** `@` opened or its query changed: native may `providePeople` (more) people. */
  | { type: "needPeople"; query: string }
  /** `[[`, `@` or ⌘K look for pages: native answers with `providePages` for the same query. */
  | { type: "needPages"; query: string }
  /** The image button / `/画像`: native picks a picture, uploads it and sends `insertImage`. */
  | { type: "pickImage" }
  /** A link, page chip or file chip was tapped: `https://…`, `page:<id>` or `attachment:<id>`; native opens it. */
  | { type: "openLink"; url: string }
  /** ↑ on the body's first line (← at its very start): native may focus the title field. */
  | { type: "focusTitle" }
  /** A line for native's log (an error in the page, a message it did not understand, a refused action). */
  | { type: "log"; level: "debug" | "info" | "warn" | "error"; message: string; detail?: string };

export interface Transport {
  kind: "ios" | "android" | "none" | "dev";
  post(json: string): void;
}

type IosWindow = { webkit?: { messageHandlers?: { taylis?: { postMessage(message: string): void } } } };
type AndroidWindow = { TaylisBridge?: { post(json: string): void } };

/** The native side's message handler, if the page runs in an app's WebView. */
export function detectTransport(win: unknown): Transport {
  const w = (win ?? {}) as IosWindow & AndroidWindow;
  const ios = w.webkit?.messageHandlers?.taylis;
  if (ios && typeof ios.postMessage === "function") return { kind: "ios", post: (json) => ios.postMessage(json) };
  const android = w.TaylisBridge;
  if (android && typeof android.post === "function") return { kind: "android", post: (json) => android.post(json) };
  return { kind: "none", post: () => {} };
}

const NATIVE_TYPES = new Set<NativeMessage["type"]>(["load", "replace", "setTheme", "setViewport", "insertImage", "providePeople", "providePages", "provideEmoji", "focus", "blur", "requestBody", "command"]);
const THEMES = new Set<string>(["light", "dark", "system"]);

/**
 * A message from native as the editor takes it, or why it could not (never throws: a bad message is reported with
 * `log`). Fields are checked where a wrong one would break the editor (a body that is not a string, an unknown command).
 */
export function parseNativeMessage(raw: unknown): { ok: true; message: NativeMessage } | { ok: false; error: string } {
  let value = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return { ok: false, error: "not JSON" };
    }
  }
  if (!value || typeof value !== "object") return { ok: false, error: "not an object" };
  const message = value as Record<string, unknown>;
  const type = message.type;
  if (typeof type !== "string" || !NATIVE_TYPES.has(type as NativeMessage["type"])) return { ok: false, error: `unknown type ${JSON.stringify(type)}` };
  switch (type) {
    case "load":
    case "replace":
      if (typeof message.body !== "string") return { ok: false, error: `${type}: body must be a string` };
      if (type === "load" && message.theme !== undefined && !THEMES.has(String(message.theme))) return { ok: false, error: `load: theme ${JSON.stringify(message.theme)}` };
      if (message.gen !== undefined && !Number.isSafeInteger(message.gen)) return { ok: false, error: `${type}: gen must be an integer` };
      break;
    case "requestBody":
      if (message.id !== undefined && !Number.isSafeInteger(message.id)) return { ok: false, error: "requestBody: id must be an integer" };
      break;
    case "setTheme":
      if (!THEMES.has(String(message.theme))) return { ok: false, error: `setTheme: theme ${JSON.stringify(message.theme)}` };
      break;
    case "setViewport":
      if (typeof message.keyboardHeight !== "number" || !Number.isFinite(message.keyboardHeight)) return { ok: false, error: "setViewport: keyboardHeight must be a number" };
      break;
    case "insertImage":
      if (typeof message.attachmentId !== "string" || !message.attachmentId) return { ok: false, error: "insertImage: attachmentId must be a string" };
      break;
    case "providePeople":
      if (!Array.isArray(message.people)) return { ok: false, error: "providePeople: people must be an array" };
      break;
    case "providePages":
      if (!Array.isArray(message.pages)) return { ok: false, error: "providePages: pages must be an array" };
      break;
    case "provideEmoji":
      if (!Array.isArray(message.emoji)) return { ok: false, error: "provideEmoji: emoji must be an array" };
      break;
    case "command":
      if (!(EDITOR_COMMANDS as readonly string[]).includes(String(message.name))) return { ok: false, error: `command: unknown name ${JSON.stringify(message.name)}` };
      break;
  }
  return { ok: true, message: message as unknown as NativeMessage };
}

export interface Bridge {
  readonly transport: Transport;
  send(message: WebMessage): void;
  /** Native's entry (`window.taylisEditor.receive`): a JSON string or an object. */
  receive(raw: unknown): void;
  /** The editor listens; messages that came before are handed over in order. One listener at a time. */
  listen(handler: (message: NativeMessage) => void): () => void;
}

export function createBridge(transport: Transport): Bridge {
  let handler: ((message: NativeMessage) => void) | null = null;
  const queue: NativeMessage[] = [];
  const send = (message: WebMessage) => {
    try {
      transport.post(JSON.stringify(message));
    } catch (error) {
      // Nothing to report it to: the console is what is left.
      console.error("taylis bridge: post failed", error);
    }
  };
  return {
    transport,
    send,
    receive(raw) {
      const parsed = parseNativeMessage(raw);
      if (!parsed.ok) {
        send({ type: "log", level: "warn", message: `message refused: ${parsed.error}` });
        return;
      }
      if (!handler) {
        queue.push(parsed.message);
        return;
      }
      try {
        handler(parsed.message);
      } catch (error) {
        send({ type: "log", level: "error", message: `${parsed.message.type} failed: ${error instanceof Error ? error.message : String(error)}`, detail: error instanceof Error ? error.stack : undefined });
      }
    },
    listen(next) {
      handler = next;
      while (handler === next && queue.length > 0) {
        const message = queue.shift()!;
        try {
          next(message);
        } catch (error) {
          send({ type: "log", level: "error", message: `${message.type} failed: ${error instanceof Error ? error.message : String(error)}` });
        }
      }
      return () => {
        if (handler === next) handler = null;
      };
    },
  };
}

/** What native sees: `window.taylisEditor`. */
export interface TaylisEditorGlobal {
  version: number;
  receive(raw: unknown): void;
}

/** Puts `window.taylisEditor` in place and relays the page's own errors as `log` lines. */
export function installBridge(win: { taylisEditor?: TaylisEditorGlobal; addEventListener?: Window["addEventListener"] }, bridge: Bridge): void {
  win.taylisEditor = { version: BRIDGE_VERSION, receive: (raw) => bridge.receive(raw) };
  win.addEventListener?.("error", (event) => {
    bridge.send({ type: "log", level: "error", message: event.message || "error", detail: event.error instanceof Error ? event.error.stack : undefined });
  });
  win.addEventListener?.("unhandledrejection", (event) => {
    const reason = (event as PromiseRejectionEvent).reason;
    bridge.send({ type: "log", level: "error", message: `unhandled rejection: ${reason instanceof Error ? reason.message : String(reason)}`, detail: reason instanceof Error ? reason.stack : undefined });
  });
}
