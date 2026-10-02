// @vitest-environment jsdom
/**
 * M72 (CANVAS.md §18) on the real MainScreen with a real SyncEngine and the fake server: 「編集中」 in the canvas's bar
 * (from someone else's frames; mine go out on focus and stop on blur), and 「タスクにする」 on a checklist item opening the
 * task dialog filled from the item, whose POST /tasks names the canvas and the line.
 */
import { useSyncExternalStore } from "react";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type { ApiClient } from "../src/api/client";
import type { TaskCreate, TaskOut } from "../src/api/types";
import { AppController } from "../src/state/app";
import { SyncEngine } from "../src/sync/engine";
import { Store } from "../src/sync/store";
import { type TaskApi, TaskHub } from "../src/sync/tasks";
import { COMPACT_QUERY } from "../src/ui/compact";
import { MainScreen } from "../src/ui/MainScreen";
import { FakeServer } from "./fakeServer";
import { task } from "./taskFixtures";

beforeEach(() => {
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: query === COMPACT_QUERY ? false : false, addEventListener: () => {}, removeEventListener: () => {} }));
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  HTMLElement.prototype.scrollIntoView = () => {};
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const settle = (ms = 0) => act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });

function Screen({ controller, store, engine }: { controller: AppController; store: Store; engine: SyncEngine }) {
  useSyncExternalStore(
    (listener) => {
      const subs = [controller.subscribe(listener), store.subscribe(listener), engine.subscribe(listener)];
      return () => subs.forEach((unsubscribe) => unsubscribe());
    },
    () => `${controller.version}:${store.version}:${engine.status}`,
  );
  return <MainScreen controller={controller} />;
}

/** #lab of alice with bob in it, bob on this device; a canvas of alice's with a checklist; tasks answered by a stub. */
async function setup() {
  const server = new FakeServer();
  const alice = server.addUser("alice");
  const bob = server.addUser("bob");
  const channelId = server.createChannel("lab", alice.id).id;
  server.join(channelId, bob.id);
  const body = `# TODO\n- [ ] 予稿を出す <@${alice.id}> 📅 2030-01-10\n- [x] 会場を予約`;
  const canvas = server.createCanvas(alice.id, channelId, { client_save_id: crypto.randomUUID(), share_to_channel: false, as_tab: true, body, title: "議事録" });
  const store = new Store();
  const inner = server.apiFor(bob.id);
  const engine = new SyncEngine(
    { api: inner, connect: server.connectorFor(bob.id), store, getAccessToken: () => "t", sleep: async () => {}, random: () => 0.5, isActive: () => true },
    { reconnectMinMs: 0, canvasSave: { debounceMs: 30, refreshDebounceMs: 10, retryDelaysMs: [20] } },
  );
  const createTask = vi.fn(async (sent: TaskCreate): Promise<TaskOut> => task(sent.title, { channel_id: sent.channel_id ?? null, canvas_source: { canvas_id: canvas.id, excerpt: "予稿を出す" } }));
  const taskApi = { createTask, listTasks: vi.fn(async () => []), myTasks: vi.fn(async () => []), dueTasks: vi.fn(async () => []), getTask: vi.fn(), updateTask: vi.fn(), moveTask: vi.fn(), deleteTask: vi.fn() };
  (engine as unknown as { tasks: TaskHub }).tasks = new TaskHub({ api: taskApi as unknown as TaskApi, me: () => bob.id });
  const members = async () => [alice.id, bob.id].map((id) => ({ user_id: id, role: "member", joined_at: "2026-01-01T00:00:00Z" }));
  const api = new Proxy({ ...inner, members, baseUrl: "http://server" } as unknown as Record<string, unknown>, { get: (target, key: string) => target[key] ?? (async () => []) }) as unknown as ApiClient;
  await engine.start();
  await engine.idle();
  const controller = new AppController();
  (controller as unknown as { active: unknown }).active = { serverUrl: "http://server", username: "bob", api, store, engine, me: store.me, leaving: false };
  render(<Screen controller={controller} store={store} engine={engine} />);
  await settle();
  fireEvent.click(screen.getByRole("tab", { name: "キャンバス" }));
  await settle(30);
  return { server, alice, bob, channelId, canvas, store, engine, createTask };
}

it("shows who else edits the canvas, and says when I edit", async () => {
  const { server, alice, bob, channelId, canvas } = await setup();
  const socket = server.socketsOf(bob.id)[0]!;
  expect(document.querySelector("[data-canvas-editing]")).toBeNull();
  await act(async () => {
    socket.deliver({ type: "canvas_presence", canvas_id: canvas.id, channel_id: channelId, user_id: alice.id, editing: true, section: "TODO" });
  });
  await settle();
  const editing = document.querySelector("[data-canvas-editing]") as HTMLElement;
  expect(editing.textContent).toContain("Alice が編集中");
  expect(editing.getAttribute("title")).toBe("Alice: TODO");
  await act(async () => {
    socket.deliver({ type: "canvas_presence", canvas_id: canvas.id, channel_id: channelId, user_id: alice.id, editing: false, section: null });
  });
  await settle();
  expect(document.querySelector("[data-canvas-editing]")).toBeNull();

  // Mine: a start on focus (with the caret's heading), a stop on blur.
  const editor = screen.getByRole("textbox", { name: /キャンバスの本文/ }) as HTMLTextAreaElement;
  editor.setSelectionRange(editor.value.length, editor.value.length);
  fireEvent.focus(editor);
  fireEvent.blur(editor);
  await settle();
  const frames = socket.sent.map((raw) => JSON.parse(raw) as { type: string }).filter((f) => f.type === "canvas_presence");
  expect(frames).toEqual([
    { type: "canvas_presence", canvas_id: canvas.id, editing: true, section: "TODO" },
    { type: "canvas_presence", canvas_id: canvas.id, editing: false, section: null },
  ]);
});

it("「タスクにする」 on an open item fills the task dialog from it and sends the canvas and the line", async () => {
  const { alice, channelId, canvas, createTask } = await setup();
  // Only the open item offers it (the preview beside the editor).
  const buttons = [...document.querySelectorAll("[data-make-task]")] as HTMLButtonElement[];
  expect(buttons.map((b) => b.getAttribute("data-make-task"))).toEqual(["1"]);
  fireEvent.click(buttons[0]!);
  await settle(60); // what is typed is saved first
  const dialog = screen.getByRole("dialog", { name: "タスクを追加" });
  expect((within(dialog).getByLabelText("題名") as HTMLInputElement).value).toBe("予稿を出す @Alice");
  expect((within(dialog).getByLabelText("期限") as HTMLInputElement).value).toBe("2030-01-10");
  expect((within(dialog).getByLabelText("追加先") as HTMLSelectElement).value).toBe(channelId);
  expect(within(dialog).getByText("予稿を出す @Alice 📅 2030-01-10")).toBeTruthy();
  await settle(20); // the members for the picker
  expect((within(dialog).getByLabelText("Alice") as HTMLInputElement).checked).toBe(true);
  fireEvent.click(within(dialog).getByRole("button", { name: "追加" }));
  await settle(20);
  expect(createTask).toHaveBeenCalledTimes(1);
  expect(createTask.mock.calls[0]![0]).toMatchObject({
    channel_id: channelId,
    title: "予稿を出す @Alice",
    due_on: "2030-01-10",
    assignee_ids: [alice.id],
    source_canvas_id: canvas.id,
    source_canvas_line: `- [ ] 予稿を出す <@${alice.id}> 📅 2030-01-10`,
  });
  expect(screen.queryByRole("dialog", { name: "タスクを追加" })).toBeNull();
});
