/**
 * M43: the canvas save loop (sync/canvasSave.ts, CANVAS.md §4.4 「クライアント側の規則」) against the fake server: the
 * pause before saving, the idempotent retry, the merged body taking the text's place, typing during a save, the three
 * conflict choices, a base that is gone, offline, reading again on canvas.updated, a refusal, and a restored state.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError, NetworkError } from "../src/api/errors";
import type { CanvasOut, CanvasSaveIn, CanvasSaveOut } from "../src/api/types";
import { CanvasSaver, type CanvasPendingState, type CanvasSaveApi } from "../src/sync/canvasSave";
import { FakeServer } from "./fakeServer";

const BODY = "# 議事録\n## 出席\n- alice\n\n## 決定事項\n来週までに研究計画を提出する。\n\n## TODO\n- [ ] 資料\n- [ ] 練習";

interface Harness {
  server: FakeServer;
  alice: { id: string };
  bob: { id: string };
  channelId: string;
  canvas: CanvasOut;
  api: CanvasSaveApi & { calls: CanvasSaveIn[]; gets: number; fail: Array<"down" | "lost" | "busy" | Error> };
  saver: CanvasSaver;
  persisted: Array<CanvasPendingState | null>;
}

/** Bob's saver on alice's canvas; `fail` makes the next saves fail: "down" before the server, "lost" after it. */
async function harness(options: { restored?: CanvasPendingState | null; body?: string } = {}): Promise<Harness> {
  const server = new FakeServer();
  const alice = server.addUser("alice");
  const bob = server.addUser("bob");
  const channelId = server.createChannel("lab", alice.id).id;
  server.join(channelId, bob.id);
  const canvas = server.createCanvas(alice.id, channelId, { client_save_id: crypto.randomUUID(), share_to_channel: false, as_tab: true, body: options.body ?? BODY, title: "議事録" });
  const inner = server.apiFor(bob.id);
  const api: Harness["api"] = {
    calls: [],
    gets: 0,
    fail: [],
    getCanvas: async (id, known) => {
      api.gets += 1;
      return inner.getCanvas!(id, known);
    },
    saveCanvas: async (id, body): Promise<CanvasSaveOut> => {
      api.calls.push({ ...body });
      const failure = api.fail.shift();
      if (failure === "down") throw new NetworkError(new TypeError("Failed to fetch"));
      if (failure === "busy") throw new ApiError(503, "http_503", "busy");
      if (failure instanceof Error) throw failure;
      const answer = await inner.saveCanvas!(id, body);
      if (failure === "lost") throw new NetworkError(new TypeError("Failed to fetch"));
      return answer;
    },
  };
  const persisted: Array<CanvasPendingState | null> = [];
  const saver = new CanvasSaver(canvas.id, channelId, api, { debounceMs: 2000, refreshDebounceMs: 500, retryDelaysMs: [1000, 2000], persist: (state) => persisted.push(state) }, options.restored ?? null);
  await saver.load();
  await saver.settled();
  return { server, alice, bob, channelId, canvas, api, saver, persisted };
}

const head = (h: Harness) => h.server.canvases.get(h.canvas.id)!.canvas;
/** Alice saves on the head (as another device would). */
const aliceSaves = (h: Harness, body: string) => h.server.saveCanvas(h.alice.id, h.canvas.id, { base_rev_id: head(h).head_rev_id, body, client_save_id: crypto.randomUUID(), on_conflict: "fail" });

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the save loop", () => {
  it("saves the whole body once typing pauses for 2 s, on the version it was written on", async () => {
    const h = await harness();
    expect(h.saver.status).toBe("saved");
    expect(h.saver.text).toBe(BODY);
    h.saver.edit(BODY + "\n- [ ] 予稿");
    expect(h.saver.status).toBe("editing");
    await vi.advanceTimersByTimeAsync(1500);
    h.saver.edit(BODY + "\n- [ ] 予稿を出す"); // the pause starts again
    await vi.advanceTimersByTimeAsync(1999);
    expect(h.api.calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    await h.saver.settled();
    expect(h.api.calls).toHaveLength(1);
    expect(h.api.calls[0]).toMatchObject({ base_rev_id: h.canvas.head_rev_id, body: BODY + "\n- [ ] 予稿を出す", on_conflict: "fail" });
    expect(h.saver.status).toBe("saved");
    expect(head(h).body).toBe(BODY + "\n- [ ] 予稿を出す");
    expect(h.persisted.at(-1)).toBeNull(); // nothing left to keep
  });

  it("flush saves at once; nothing typed sends nothing", async () => {
    const h = await harness();
    await h.saver.flush();
    expect(h.api.calls).toHaveLength(0);
    h.saver.edit("# 新しい本文");
    await h.saver.flush();
    expect(h.api.calls).toHaveLength(1);
    expect(head(h).body).toBe("# 新しい本文");
  });

  it("takes the server's merged body when nothing was typed meanwhile, the caret's text included", async () => {
    const h = await harness();
    aliceSaves(h, BODY.replace("- alice", "- alice\n- carol"));
    const before = h.saver.textRevision;
    h.saver.edit(BODY.replace("- [ ] 練習", "- [ ] 練習 (bob)"));
    await h.saver.flush();
    expect(h.saver.text).toBe(BODY.replace("- alice", "- alice\n- carol").replace("- [ ] 練習", "- [ ] 練習 (bob)"));
    expect(h.saver.textRevision).toBe(before + 1); // the editor takes it
    expect(h.saver.status).toBe("saved");
    // The next save is written on the head (the merged version).
    const merged = head(h).head_rev_id;
    h.saver.edit(h.saver.text + "\n");
    await h.saver.flush();
    expect(h.api.calls.at(-1)!.base_rev_id).toBe(merged);
    expect(head(h).body).toBe(h.saver.text);
  });

  it("typing during a save keeps the text; the next save is written on the version that holds what was sent", async () => {
    const h = await harness();
    aliceSaves(h, BODY.replace("- alice", "- alice\n- carol"));
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const save = h.api.saveCanvas;
    h.api.saveCanvas = async (id, body) => {
      await gate;
      return save(id, body);
    };
    const sent = BODY.replace("研究計画", "発表資料");
    h.saver.edit(sent);
    const flushing = h.saver.flush();
    expect(h.saver.status).toBe("saving");
    h.saver.edit(sent + "\n追記"); // typed while the save is on the wire
    release();
    await flushing;
    expect(h.saver.text).toBe(sent + "\n追記"); // not replaced under the typing
    expect(h.saver.status).toBe("editing");
    await vi.advanceTimersByTimeAsync(2000);
    await h.saver.settled();
    const second = h.api.calls[1]!;
    expect(second.base_rev_id).not.toBe(h.canvas.head_rev_id);
    expect(h.server.canvases.get(h.canvas.id)!.revisions.get(second.base_rev_id)).toBe(sent); // the side version
    expect(head(h).body).toBe(BODY.replace("- alice", "- alice\n- carol").replace("研究計画", "発表資料") + "\n追記");
    expect(h.saver.text).toBe(head(h).body); // the merge came back once typing stopped
  });

  it("a save lost on the network is sent again with the same key, body and base: one version", async () => {
    const h = await harness();
    h.api.fail.push("lost", "down");
    h.saver.edit(BODY + "\n追記");
    await h.saver.flush();
    expect(h.saver.status).toBe("offline");
    const versions = head(h).version;
    await vi.advanceTimersByTimeAsync(1000); // the second attempt fails before the server
    expect(h.saver.status).toBe("offline");
    await vi.advanceTimersByTimeAsync(2000);
    await h.saver.settled();
    expect(h.api.calls).toHaveLength(3);
    expect(new Set(h.api.calls.map((c) => c.client_save_id)).size).toBe(1);
    expect(new Set(h.api.calls.map((c) => c.base_rev_id)).size).toBe(1);
    expect(h.api.calls.every((c) => c.body === BODY + "\n追記")).toBe(true);
    expect(head(h).version).toBe(versions); // the retry made no second version
    expect(h.saver.status).toBe("saved");
  });

  it("429 / 5xx retry the same way; online() sends at once instead of waiting", async () => {
    const h = await harness();
    h.api.fail.push("busy");
    h.saver.edit(BODY + "\nx");
    await h.saver.flush();
    expect(h.saver.status).toBe("retrying");
    h.saver.online();
    await h.saver.settled();
    expect(h.api.calls).toHaveLength(2);
    expect(h.api.calls[1]!.client_save_id).toBe(h.api.calls[0]!.client_save_id);
    expect(h.saver.status).toBe("saved");
  });

  it("the unsaved state is kept (with the key on the wire) and a restored saver sends it again", async () => {
    const h = await harness();
    h.api.fail.push("lost");
    h.saver.edit(BODY + "\n保存前に落ちた");
    await h.saver.flush();
    const kept = h.persisted.at(-1)!;
    expect(kept.inFlight?.sent).toBe(BODY + "\n保存前に落ちた");
    h.saver.dispose();
    // The app starts again: the same key goes out, then nothing more.
    const inner = h.server.apiFor(h.bob.id);
    const calls: CanvasSaveIn[] = [];
    const restarted = new CanvasSaver(h.canvas.id, h.channelId, { getCanvas: (id, v) => inner.getCanvas!(id, v), saveCanvas: (id, body) => { calls.push(body); return inner.saveCanvas!(id, body); } }, {}, kept);
    await restarted.load();
    await restarted.settled();
    expect(calls.map((c) => c.client_save_id)).toEqual([kept.inFlight!.clientSaveId]);
    expect(restarted.status).toBe("saved");
    expect(restarted.text).toBe(BODY + "\n保存前に落ちた");
    expect(head(h).body).toBe(BODY + "\n保存前に落ちた");
  });
});

describe("conflicts", () => {
  async function conflicted() {
    const h = await harness();
    aliceSaves(h, BODY.replace("研究計画", "発表資料"));
    h.saver.edit(BODY.replace("研究計画", "予稿"));
    await h.saver.flush();
    return h;
  }

  it("409 canvas_conflict waits for a choice with the regions, and saves nothing meanwhile", async () => {
    const h = await conflicted();
    expect(h.saver.status).toBe("conflict");
    expect(h.saver.conflict!.details.conflicts).toEqual([expect.objectContaining({ ours: "来週までに予稿を提出する。", theirs: "来週までに発表資料を提出する。" })]);
    h.saver.edit(h.saver.text + "\n続き");
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.api.calls).toHaveLength(1);
    expect(h.persisted.at(-1)).not.toBeNull(); // kept until chosen
  });

  it.each([
    ["ours", "来週までに予稿を提出する。"],
    ["theirs", "来週までに発表資料を提出する。"],
    ["both", "来週までに発表資料を提出する。\n> 来週までに予稿を提出する。"],
  ] as const)("「%s」 sends the text again on the same version with a new key and takes the result", async (choice, line) => {
    const h = await conflicted();
    const first = h.api.calls[0]!;
    await h.saver.resolveConflict(choice);
    const second = h.api.calls[1]!;
    expect(second).toMatchObject({ base_rev_id: first.base_rev_id, on_conflict: choice, body: first.body });
    expect(second.client_save_id).not.toBe(first.client_save_id);
    expect(h.saver.status).toBe("saved");
    expect(head(h).body).toContain(line);
    expect(h.saver.text).toBe(head(h).body);
    // Saves after it go back to asking.
    h.saver.edit(h.saver.text + "\n");
    await h.saver.flush();
    expect(h.api.calls.at(-1)!.on_conflict).toBe("fail");
  });

  it("409 canvas_base_expired shows the current body; 「今の本文」 takes it, 「自分の本文」 saves mine on it", async () => {
    const h = await harness();
    aliceSaves(h, BODY + "\nalice");
    h.server.eraseCanvasRevision(h.canvas.id, h.canvas.head_rev_id); // pruned while bob was away
    h.saver.edit(BODY + "\nbob");
    await h.saver.flush();
    expect(h.saver.status).toBe("expired");
    expect(h.saver.expired!.body).toBe(BODY + "\nalice");
    const current = head(h).head_rev_id;
    await h.saver.resolveExpired("mine");
    expect(h.api.calls.at(-1)!.base_rev_id).toBe(current);
    expect(head(h).body).toBe(BODY + "\nbob");
    expect(h.saver.status).toBe("saved");

    const g = await harness();
    aliceSaves(g, BODY + "\nalice");
    g.server.eraseCanvasRevision(g.canvas.id, g.canvas.head_rev_id);
    g.saver.edit(BODY + "\nbob");
    await g.saver.flush();
    await g.saver.resolveExpired("theirs");
    expect(g.saver.text).toBe(BODY + "\nalice");
    expect(g.saver.status).toBe("saved");
    expect(g.api.calls).toHaveLength(1);
  });
});

describe("someone else's versions", () => {
  it("canvas.updated while idle reads the canvas again (0.5 s later, If-None-Match) and replaces the text", async () => {
    const h = await harness();
    const gets = h.api.gets;
    aliceSaves(h, BODY + "\nalice");
    h.saver.remoteVersion(head(h).version);
    h.saver.remoteVersion(head(h).version); // a burst: one read
    await vi.advanceTimersByTimeAsync(499);
    expect(h.api.gets).toBe(gets);
    await vi.advanceTimersByTimeAsync(1);
    await h.saver.settled();
    expect(h.api.gets).toBe(gets + 1);
    expect(h.saver.text).toBe(BODY + "\nalice");
    h.saver.remoteVersion(head(h).version); // nothing newer: no read
    await vi.advanceTimersByTimeAsync(600);
    expect(h.api.gets).toBe(gets + 1);
  });

  it("canvas.updated while typing reads nothing; the next save merges", async () => {
    const h = await harness();
    const gets = h.api.gets;
    h.saver.edit(BODY.replace("- [ ] 練習", "- [ ] 練習!"));
    aliceSaves(h, BODY.replace("- alice", "- alice\n- carol"));
    h.saver.remoteVersion(head(h).version);
    await vi.advanceTimersByTimeAsync(600);
    expect(h.api.gets).toBe(gets);
    expect(h.saver.text).toBe(BODY.replace("- [ ] 練習", "- [ ] 練習!"));
    await vi.advanceTimersByTimeAsync(1400);
    await h.saver.settled();
    expect(h.saver.text).toBe(BODY.replace("- alice", "- alice\n- carol").replace("- [ ] 練習", "- [ ] 練習!"));
  });

  it("an IME composition is not replaced: the merged body waits for the next save or read", async () => {
    const h = await harness();
    let composing = true;
    h.saver.canReplace = () => !composing;
    aliceSaves(h, BODY + "\nalice");
    h.saver.edit(BODY.replace("研究計画", "研究計画書"));
    await h.saver.flush();
    expect(h.saver.text).toBe(BODY.replace("研究計画", "研究計画書")); // left alone
    composing = false;
    await h.saver.flush(); // nothing typed since: read again
    expect(h.saver.text).toBe(BODY.replace("研究計画", "研究計画書") + "\nalice");
  });

  it("a refusal stops saving (the text stays); an edit tries again; the trash stops it for good", async () => {
    const h = await harness();
    h.api.fail.push(new ApiError(422, "canvas_too_large", "too large"));
    h.saver.edit(BODY + "\n長すぎる");
    await h.saver.flush();
    expect(h.saver.status).toBe("blocked");
    expect(h.saver.text).toBe(BODY + "\n長すぎる");
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.api.calls).toHaveLength(1);
    h.saver.edit(BODY + "\n短く");
    await h.saver.flush();
    expect(h.saver.status).toBe("saved");
    h.saver.gone();
    h.saver.edit(BODY + "\nもう保存されない");
    await h.saver.flush();
    expect(h.saver.status).toBe("gone");
    expect(h.api.calls).toHaveLength(2);
  });
});

describe("the web tab closing (M44)", () => {
  it("hands over the typed text as a save for a keepalive request; if the page lives on, the loop sends the same key", async () => {
    const h = await harness();
    expect(h.saver.unloadSave()).toBeNull(); // nothing typed
    h.saver.edit(BODY + "\n閉じる直前");
    const request = h.saver.unloadSave()!;
    expect(request).toMatchObject({ base_rev_id: h.canvas.head_rev_id, body: BODY + "\n閉じる直前", on_conflict: "fail" });
    expect(h.persisted.at(-1)?.inFlight?.clientSaveId).toBe(request.client_save_id);
    // The keepalive request lands (the browser sends it after the page is gone) …
    await h.server.apiFor(h.bob.id).saveCanvas!(h.canvas.id, request);
    // … and a page kept in the back-forward cache resumes with the same save: answered once, no second version.
    await vi.advanceTimersByTimeAsync(0);
    await h.saver.settled();
    expect(h.api.calls.map((c) => c.client_save_id)).toEqual([request.client_save_id]);
    expect(head(h).body).toBe(BODY + "\n閉じる直前");
    expect(h.server.canvases.get(h.canvas.id)!.history).toHaveLength(2);
    expect(h.saver.status).toBe("saved");
  });

  it("a save on the wire is handed over as it is; text typed after it goes on its base with a new key", async () => {
    const h = await harness();
    h.api.fail.push("down");
    h.saver.edit(BODY + "\n1");
    await h.saver.flush(); // failed on the network: kept, waiting to be sent again
    const first = h.api.calls[0]!;
    expect(h.saver.unloadSave()).toEqual(first);
    h.saver.edit(BODY + "\n1\n2");
    const next = h.saver.unloadSave()!;
    expect(next).toMatchObject({ base_rev_id: first.base_rev_id, body: BODY + "\n1\n2" });
    expect(next.client_save_id).not.toBe(first.client_save_id);
  });

  it("asks to stay only for what a keepalive request cannot carry", async () => {
    const h = await harness();
    h.saver.edit(BODY + "\n少し");
    expect(h.saver.mustStay).toBe(false);
    h.saver.edit(BODY + "\n" + "長い本文。".repeat(5_000)); // over the 64 KiB a keepalive request may carry
    expect(h.saver.mustStay).toBe(true);
    expect(h.saver.unloadSave()).toBeNull();
    h.saver.edit(BODY + "\n少し");
    await h.saver.flush();
    expect(h.saver.mustStay).toBe(false); // saved
    h.api.fail.push(new ApiError(403, "canvas_edit_restricted", "restricted"));
    h.saver.edit(BODY + "\n拒否");
    await h.saver.flush();
    expect(h.saver.mustStay).toBe(true); // refused: only copying keeps it
  });
});
