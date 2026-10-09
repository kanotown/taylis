/**
 * M153a (WIKI.md §30.3): the editor bridge's contract (apps/shared/mobile-editor/src/bridge.ts) — the transports, every
 * example message of apps/shared/mobile-editor/bridge_messages.json (the same examples the iOS and Android tests decode),
 * the refusals, the queue before a listener, and a handler that throws.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

import { BRIDGE_VERSION, createBridge, detectTransport, EDITOR_COMMANDS, installBridge, type NativeMessage, parseNativeMessage, type WebMessage } from "../../shared/mobile-editor/src/bridge";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const fixtures = JSON.parse(readFileSync(join(root, "apps", "shared", "mobile-editor", "bridge_messages.json"), "utf8")) as {
  version: number;
  native_to_web: NativeMessage[];
  web_to_native: WebMessage[];
  refused: Array<{ raw: unknown; error: string }>;
};

describe("the transports", () => {
  it("iOS: the JSON string goes to webkit.messageHandlers.taylis.postMessage", () => {
    const postMessage = vi.fn();
    const transport = detectTransport({ webkit: { messageHandlers: { taylis: { postMessage } } } });
    expect(transport.kind).toBe("ios");
    createBridge(transport).send({ type: "ready", version: BRIDGE_VERSION });
    expect(postMessage).toHaveBeenCalledWith(JSON.stringify({ type: "ready", version: BRIDGE_VERSION }));
  });

  it("Android: the JSON string goes to TaylisBridge.post", () => {
    const post = vi.fn();
    const transport = detectTransport({ TaylisBridge: { post } });
    expect(transport.kind).toBe("android");
    createBridge(transport).send({ type: "pickImage" });
    expect(post).toHaveBeenCalledWith('{"type":"pickImage"}');
  });

  it("neither (a desktop browser, the tests): nothing is posted and nothing throws", () => {
    const transport = detectTransport({});
    expect(transport.kind).toBe("none");
    expect(() => createBridge(transport).send({ type: "caret", line: 3 })).not.toThrow();
    expect(detectTransport(undefined).kind).toBe("none");
  });
});

describe("the messages", () => {
  it("the fixture is written for this bridge version", () => {
    expect(fixtures.version).toBe(BRIDGE_VERSION);
  });

  it("every native example parses as its type, as an object and as a JSON string", () => {
    const seen = new Set<string>();
    for (const example of fixtures.native_to_web) {
      const asObject = parseNativeMessage(example);
      expect(asObject.ok, JSON.stringify(example)).toBe(true);
      const asString = parseNativeMessage(JSON.stringify(example));
      expect(asString.ok && asString.message).toEqual(example);
      seen.add(example.type);
    }
    // One of each kind.
    expect([...seen].sort()).toEqual(["blur", "command", "focus", "insertImage", "load", "provideEmoji", "providePages", "providePeople", "replace", "requestBody", "setTheme", "setViewport"]);
  });

  it("every web example round-trips through the transport as the same JSON", () => {
    const posted: string[] = [];
    const bridge = createBridge({ kind: "dev", post: (json) => posted.push(json) });
    const seen = new Set<string>();
    for (const example of fixtures.web_to_native) {
      bridge.send(example);
      expect(JSON.parse(posted.at(-1)!)).toEqual(example);
      seen.add(example.type);
    }
    expect([...seen].sort()).toEqual(["bodyRequested", "caret", "changed", "focusTitle", "height", "log", "needPages", "needPeople", "openLink", "pickImage", "ready"]);
  });

  it("the refused examples are refused with the fixture's reason, and reported to native with log", () => {
    const posted: WebMessage[] = [];
    const bridge = createBridge({ kind: "dev", post: (json) => posted.push(JSON.parse(json)) });
    const handler = vi.fn();
    bridge.listen(handler);
    for (const { raw, error } of fixtures.refused) {
      const parsed = parseNativeMessage(raw);
      expect(parsed.ok).toBe(false);
      expect(!parsed.ok && parsed.error).toBe(error);
      bridge.receive(raw);
      expect(posted.at(-1)).toEqual({ type: "log", level: "warn", message: `message refused: ${error}` });
    }
    expect(handler).not.toHaveBeenCalled();
  });

  it("every editor command is accepted by name", () => {
    for (const name of EDITOR_COMMANDS) expect(parseNativeMessage({ type: "command", name }).ok).toBe(true);
    expect(EDITOR_COMMANDS.length).toBe(22);
  });

  it("messages before a listener are queued and handed over in order; the listener can stop", () => {
    const bridge = createBridge({ kind: "dev", post: () => {} });
    bridge.receive({ type: "providePeople", people: [] });
    bridge.receive('{"type":"load","body":"a"}');
    const got: string[] = [];
    const stop = bridge.listen((message) => got.push(message.type));
    expect(got).toEqual(["providePeople", "load"]);
    bridge.receive({ type: "focus" });
    expect(got).toEqual(["providePeople", "load", "focus"]);
    stop();
    bridge.receive({ type: "blur" });
    expect(got).toEqual(["providePeople", "load", "focus"]);
    const next: string[] = [];
    bridge.listen((message) => next.push(message.type));
    expect(next).toEqual(["blur"]);
  });

  it("a handler that throws is reported with log, and the bridge goes on", () => {
    const posted: WebMessage[] = [];
    const bridge = createBridge({ kind: "dev", post: (json) => posted.push(JSON.parse(json)) });
    let calls = 0;
    bridge.listen(() => {
      calls += 1;
      if (calls === 1) throw new Error("boom");
    });
    bridge.receive({ type: "focus" });
    expect(posted.at(-1)).toMatchObject({ type: "log", level: "error", message: "focus failed: boom" });
    bridge.receive({ type: "blur" });
    expect(calls).toBe(2);
  });

  it("installBridge: window.taylisEditor.receive and the version; the page's errors become log lines", () => {
    const posted: WebMessage[] = [];
    const bridge = createBridge({ kind: "dev", post: (json) => posted.push(JSON.parse(json)) });
    const listeners = new Map<string, (event: unknown) => void>();
    const win = { addEventListener: (name: string, fn: (event: unknown) => void) => listeners.set(name, fn) } as unknown as Window & { taylisEditor?: { version: number; receive(raw: unknown): void } };
    installBridge(win, bridge);
    expect(win.taylisEditor?.version).toBe(BRIDGE_VERSION);
    const got: NativeMessage[] = [];
    bridge.listen((message) => got.push(message));
    win.taylisEditor!.receive('{"type":"setTheme","theme":"dark"}');
    expect(got).toEqual([{ type: "setTheme", theme: "dark" }]);
    listeners.get("error")!({ message: "ReferenceError: x", error: new Error("x") });
    expect(posted.at(-1)).toMatchObject({ type: "log", level: "error", message: "ReferenceError: x" });
    listeners.get("unhandledrejection")!({ reason: new Error("later") });
    expect(posted.at(-1)).toMatchObject({ type: "log", level: "error", message: "unhandled rejection: later" });
  });
});
