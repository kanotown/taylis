/**
 * M161 (docs/DRIVE.md §6, §17.3): the drive's upload queue against a fake server — parts cut and sent once, a session
 * resumed from the parts the server has (after a lost connection, a pause, a restart), the name-conflict question and
 * its 「残りすべてに同じ操作」, a completion that answers 202, and the restart notes.
 */
import { describe, expect, it, vi } from "vitest";

import { ApiError, NetworkError } from "../src/api/errors";
import type { DriveUploadCompleteOut, DriveUploadCreate, DriveUploadOut, DriveUploadPatch } from "../src/api/types";
import { type ConflictQuestion, missingParts, partCount, partRange, type PersistedUpload, sameFile, sentBytes, type UploadApi, UploadQueue, type UploadSource, type UploadStorage, uploadTotals } from "../src/drive/uploads";

const PART = 4;

interface Session {
  out: DriveUploadOut;
  parts: Map<number, Uint8Array>;
  existing: boolean;
}

/** A small server: sessions, parts by number, completion with the three conflict modes over a set of taken names. */
class FakeDrive implements UploadApi {
  sessions = new Map<string, Session>();
  byClient = new Map<string, string>();
  taken = new Map<string, "file" | "folder">();
  files = new Map<string, Uint8Array>();
  puts: Array<[string, number]> = [];
  creates = 0;
  completes = 0;
  /** Calls that fail with a network error first (name of the method → how many times). */
  failNext = new Map<string, number>();
  /** The completion answers 202 this many times before 200. */
  completing = 0;
  private next = 1;

  private fail(name: string): void {
    const left = this.failNext.get(name) ?? 0;
    if (left > 0) {
      this.failNext.set(name, left - 1);
      throw new NetworkError(new TypeError("Failed to fetch"));
    }
  }

  private key(parentId: string, dir: string | null | undefined, name: string): string {
    return `${parentId}/${dir ? `${dir}/` : ""}${name}`.toLowerCase();
  }

  async createDriveUpload(body: DriveUploadCreate): Promise<DriveUploadOut> {
    this.fail("create");
    this.creates += 1;
    const known = this.byClient.get(body.client_upload_id);
    if (known) return this.sessions.get(known)!.out;
    const key = this.key(body.parent_id, body.relative_dir, body.name);
    if ((body.on_conflict ?? "fail") === "fail" && this.taken.has(key)) {
      throw new ApiError(409, "drive_name_taken", "taken", { existing_id: "x", existing_kind: this.taken.get(key) });
    }
    const id = `u${this.next++}`;
    const out: DriveUploadOut = {
      id, client_upload_id: body.client_upload_id, status: "active", location_id: "loc", parent_id: body.parent_id,
      relative_dir: body.relative_dir ?? null, name: body.name, on_conflict: body.on_conflict ?? "fail", target_item_id: null,
      part_size: PART, parts_total: partCount(body.size_bytes, PART), received_parts: [], size_bytes: body.size_bytes,
      content_modified_at: null, expires_at: "2026-10-22T00:00:00Z", created_at: "2026-10-21T00:00:00Z", item_id: null, version_id: null, error: null,
    };
    this.sessions.set(id, { out, parts: new Map(), existing: false });
    this.byClient.set(body.client_upload_id, id);
    return out;
  }

  async driveUpload(uploadId: string): Promise<DriveUploadOut> {
    this.fail("get");
    const session = this.sessions.get(uploadId);
    if (!session) throw new ApiError(404, "drive_upload_not_found", "gone");
    return { ...session.out, received_parts: [...session.parts.keys()].sort((a, b) => a - b) };
  }

  async driveUploads(): Promise<{ uploads: DriveUploadOut[] }> {
    const uploads = [...this.sessions.values()].filter((s) => s.out.status === "active").map((s) => ({ ...s.out, received_parts: [...s.parts.keys()].sort((a, b) => a - b) }));
    return { uploads };
  }

  async patchDriveUpload(uploadId: string, patch: DriveUploadPatch): Promise<DriveUploadOut> {
    const session = this.sessions.get(uploadId)!;
    if (patch.on_conflict) session.out.on_conflict = patch.on_conflict;
    session.out.error = null;
    return session.out;
  }

  async putDrivePart(uploadId: string, number: number, bytes: Uint8Array, sha: string, signal?: AbortSignal) {
    this.fail("put");
    if (signal?.aborted) throw new DOMException("aborted", "AbortError");
    const session = this.sessions.get(uploadId)!;
    expect(sha).toBe(`sha:${bytes.byteLength}:${bytes[0] ?? -1}`);
    const [start, end] = partRange(number, session.out.size_bytes, PART);
    expect(bytes.byteLength).toBe(end - start);
    session.parts.set(number, bytes);
    this.puts.push([uploadId, number]);
    return { part_number: number, size_bytes: bytes.byteLength };
  }

  async completeDriveUpload(uploadId: string): Promise<DriveUploadCompleteOut> {
    this.fail("complete");
    this.completes += 1;
    const session = this.sessions.get(uploadId)!;
    const out = session.out;
    const missing = missingParts(out.parts_total, [...session.parts.keys()]);
    if (missing.length) throw new ApiError(409, "drive_upload_incomplete", "missing", { missing });
    const key = this.key(out.parent_id, out.relative_dir, out.name);
    if (this.taken.has(key) && out.on_conflict === "fail") {
      out.error = "drive_name_taken";
      throw new ApiError(409, "drive_name_taken", "taken", { existing_kind: this.taken.get(key) });
    }
    if (this.completing > 0) {
      this.completing -= 1;
      out.status = "completing";
      setTimeout(() => this.finish(session, key), 0);
      return { status: "completing" };
    }
    this.finish(session, key);
    return { status: "completed", item: { id: `item-${out.id}` } as DriveUploadCompleteOut["item"] };
  }

  private finish(session: Session, key: string): void {
    const out = session.out;
    const bytes = new Uint8Array(out.size_bytes);
    for (const [n, part] of session.parts) bytes.set(part, (n - 1) * PART);
    let name = key;
    if (this.taken.has(key) && out.on_conflict === "rename") name = `${key} (1)`;
    this.files.set(name, bytes);
    this.taken.set(name, "file");
    out.status = "completed";
    out.item_id = `item-${out.id}`;
  }

  async abortDriveUpload(uploadId: string): Promise<void> {
    const session = this.sessions.get(uploadId);
    if (session) session.out.status = "aborted";
  }
}

function source(name: string, size: number, options: { dir?: string; path?: string | null; lastModified?: number; failAt?: number } = {}): UploadSource & { reads: number } {
  const bytes = Uint8Array.from({ length: size }, (_, i) => (i * 7 + name.length) % 251);
  const src = {
    name, size, lastModified: options.lastModified ?? 1_700_000_000_000, relativeDir: options.dir ?? "", path: options.path ?? null, reads: 0,
    async read(start: number, end: number) {
      src.reads += 1;
      if (options.failAt !== undefined && start >= options.failAt) throw new Error("gone");
      return bytes.slice(start, end);
    },
  };
  return src;
}

function memoryStorage(initial: PersistedUpload[] = []): UploadStorage & { saved: PersistedUpload[] } {
  const store = {
    saved: initial,
    load: () => store.saved,
    save: (entries: PersistedUpload[]) => { store.saved = entries; },
  };
  return store;
}

let ids = 0;
function queueWith(api: FakeDrive, extra: Partial<ConstructorParameters<typeof UploadQueue>[0]> = {}) {
  const storage = (extra.storage as ReturnType<typeof memoryStorage>) ?? memoryStorage();
  const queue = new UploadQueue({
    api,
    storage,
    sha256: async (bytes) => `sha:${bytes.byteLength}:${bytes[0] ?? -1}`,
    newId: () => `id-${++ids}`,
    sleep: async () => undefined,
    ...extra,
  });
  return { queue, storage };
}

async function settle(queue: UploadQueue, until: () => boolean = () => !queue.busy): Promise<void> {
  for (let i = 0; i < 200 && !until(); i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

const TARGET = { parentId: "root", locationId: "loc", label: "研究室ドライブ" };

describe("parts", () => {
  it("cuts a file into parts and counts what the server has", () => {
    expect(partCount(0, 4)).toBe(0);
    expect(partCount(4, 4)).toBe(1);
    expect(partCount(9, 4)).toBe(3);
    expect(partRange(3, 9, 4)).toEqual([8, 9]);
    expect(missingParts(4, [2, 4])).toEqual([1, 3]);
    expect(sentBytes([1, 3, 3], 9, 4)).toBe(5);
    expect(sameFile({ name: "a.pdf", size: 3, lastModified: 1000 }, { name: "a.pdf", size: 3, lastModified: 1500 })).toBe(true);
    expect(sameFile({ name: "a.pdf", size: 3, lastModified: 1000 }, { name: "a.pdf", size: 4, lastModified: 1000 })).toBe(false);
    expect(sameFile({ name: "が.pdf".normalize("NFD"), size: 3, lastModified: null }, { name: "が.pdf", size: 3, lastModified: 5 })).toBe(true);
  });
});

describe("the queue", () => {
  it("sends every part once, completes, and the bytes arrive whole", async () => {
    const api = new FakeDrive();
    const done = vi.fn();
    const { queue, storage } = queueWith(api, { onDone: done });
    const file = source("report.pdf", 10);
    const [job] = queue.add([file], TARGET);
    await settle(queue);
    expect(job!.state).toBe("done");
    expect(api.puts.map(([, n]) => n).sort()).toEqual([1, 2, 3]);
    expect(api.files.get("root/report.pdf")).toEqual(await file.read(0, 10));
    expect(done).toHaveBeenCalledTimes(1);
    expect(storage.saved).toEqual([]); // nothing left to resume
    expect(uploadTotals(queue.jobs)).toMatchObject({ files: 1, done: 1, bytes: 10, sent: 10, pending: 0 });
  });

  it("keeps a folder's shape and runs three files at once", async () => {
    const api = new FakeDrive();
    const { queue } = queueWith(api, { filesAtOnce: 3 });
    const files = [source("a.txt", 5, { dir: "Data/2026" }), source("b.txt", 5, { dir: "Data" }), source("c.txt", 1), source("d.txt", 0)];
    queue.add(files, TARGET);
    await settle(queue);
    expect(queue.jobs.map((job) => job.state)).toEqual(["done", "done", "done", "done"]);
    expect([...api.files.keys()].sort()).toEqual(["root/c.txt", "root/d.txt", "root/data/2026/a.txt", "root/data/b.txt"]);
  });

  it("waits out a lost connection and goes on from the parts the server has", async () => {
    const api = new FakeDrive();
    vi.useFakeTimers();
    try {
      const { queue } = queueWith(api, { partsPerFile: 1, now: () => Date.now() });
      const [job] = queue.add([source("big.bin", 12)], TARGET);
      // The second part breaks off.
      const put = api.putDrivePart.bind(api);
      let calls = 0;
      api.putDrivePart = async (...args) => {
        calls += 1;
        if (calls === 2) throw new NetworkError(new TypeError("Load failed"));
        return put(...args);
      };
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(0);
      expect(job!.state).toBe("waiting");
      expect(job!.received).toEqual([1]);
      // Back online before the retry timer: on at once, asking which parts arrived; part 1 is not sent again.
      queue.online();
      await vi.advanceTimersByTimeAsync(10);
      for (let i = 0; i < 20 && job!.state !== "done"; i++) await vi.advanceTimersByTimeAsync(10);
      expect(job!.state).toBe("done");
      expect(api.puts.filter(([, n]) => n === 1)).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("pauses and resumes without sending a part twice", async () => {
    const api = new FakeDrive();
    const { queue } = queueWith(api, { partsPerFile: 1 });
    const [job] = queue.add([source("movie.mp4", 16)], TARGET);
    const put = api.putDrivePart.bind(api);
    api.putDrivePart = async (...args) => {
      const out = await put(...args);
      if (args[1] === 2) queue.pause(job!.id);
      return out;
    };
    await settle(queue, () => job!.state === "paused");
    await settle(queue, () => false);
    expect(job!.state).toBe("paused");
    expect(job!.received.sort()).toEqual([1, 2]);
    api.putDrivePart = put;
    queue.resume(job!.id);
    await settle(queue);
    expect(job!.state).toBe("done");
    expect(api.puts.map(([, n]) => n)).toEqual([1, 2, 3, 4]);
  });

  it("asks about a taken name once for the whole batch when told to", async () => {
    const api = new FakeDrive();
    api.taken.set("root/a.txt", "file");
    api.taken.set("root/b.txt", "file");
    const questions: ConflictQuestion[] = [];
    const ask = vi.fn(async (question: ConflictQuestion) => {
      questions.push({ ...question });
      return { choice: "version" as const, all: true };
    });
    const { queue } = queueWith(api, { ask });
    queue.add([source("a.txt", 3), source("b.txt", 3), source("c.txt", 3)], TARGET);
    await settle(queue);
    expect(ask).toHaveBeenCalledTimes(1);
    expect(questions[0]!.existingKind).toBe("file");
    expect(questions[0]!.remaining).toBe(2);
    expect(queue.jobs.map((job) => [job.name, job.state, job.onConflict])).toEqual([["a.txt", "done", "version"], ["b.txt", "done", "version"], ["c.txt", "done", "fail"]]);
    // A version replaced the name, no copy was made.
    expect(api.files.has("root/a.txt (1)")).toBe(false);
  });

  it("asks each conflict when not told to apply to all, and skips or renames as answered", async () => {
    const api = new FakeDrive();
    api.taken.set("root/a.txt", "file");
    api.taken.set("root/b.txt", "folder");
    const answers = [{ choice: "skip" as const, all: false }, { choice: "rename" as const, all: false }];
    const ask = vi.fn(async () => answers.shift()!);
    const { queue } = queueWith(api, { ask });
    queue.add([source("a.txt", 3), source("b.txt", 3)], TARGET);
    await settle(queue);
    expect(ask).toHaveBeenCalledTimes(2);
    expect(queue.jobs.map((job) => job.state)).toEqual(["skipped", "done"]);
    expect(api.files.has("root/b.txt (1)")).toBe(true);
    // A skipped file made no session and sent nothing.
    expect(api.puts.every(([id]) => api.sessions.get(id)!.out.name === "b.txt")).toBe(true);
  });

  it("asks again when the name is taken while the parts were going up", async () => {
    const api = new FakeDrive();
    const ask = vi.fn(async () => ({ choice: "rename" as const, all: false }));
    const { queue } = queueWith(api, { ask });
    const put = api.putDrivePart.bind(api);
    api.putDrivePart = async (...args) => {
      api.taken.set("root/late.txt", "file"); // someone else's upload finished first
      return put(...args);
    };
    const [job] = queue.add([source("late.txt", 3)], TARGET);
    await settle(queue);
    expect(ask).toHaveBeenCalledTimes(1);
    expect(job!.state).toBe("done");
    expect(api.sessions.get(job!.uploadId!)!.out.on_conflict).toBe("rename");
    expect(api.files.has("root/late.txt (1)")).toBe(true);
  });

  it("waits for a completion that answers 202", async () => {
    const api = new FakeDrive();
    api.completing = 1;
    const sleep = vi.fn(async () => new Promise<void>((resolve) => setTimeout(resolve, 0)));
    const { queue } = queueWith(api, { sleep });
    const [job] = queue.add([source("huge.iso", 9)], TARGET);
    await settle(queue);
    expect(job!.state).toBe("done");
    expect(sleep).toHaveBeenCalled();
    expect(job!.itemId).toBe(`item-${job!.uploadId}`);
  });

  it("fails with the server's reason and tries again on request", async () => {
    const api = new FakeDrive();
    const create = api.createDriveUpload.bind(api);
    let refuse = true;
    api.createDriveUpload = async (body) => {
      if (refuse) throw new ApiError(409, "drive_quota_exceeded", "full");
      return create(body);
    };
    const { queue } = queueWith(api);
    const [job] = queue.add([source("x.bin", 4)], TARGET);
    await settle(queue);
    expect(job!.state).toBe("failed");
    expect(job!.error).toBe("drive_quota_exceeded");
    refuse = false;
    queue.resume(job!.id);
    await settle(queue);
    expect(job!.state).toBe("done");
  });

  it("starts over when the session expired", async () => {
    const api = new FakeDrive();
    const { queue } = queueWith(api, { partsPerFile: 1 });
    const [job] = queue.add([source("slow.bin", 8)], TARGET);
    const put = api.putDrivePart.bind(api);
    let first = true;
    api.putDrivePart = async (...args) => {
      if (first && args[1] === 2) {
        first = false;
        throw new ApiError(410, "drive_upload_expired", "expired");
      }
      return put(...args);
    };
    await settle(queue, () => job!.state === "queued" || job!.state === "done");
    // Queued again with a new session; run it.
    await settle(queue);
    expect(job!.state).toBe("done");
    expect(api.creates).toBe(2);
  });

  it("cancels: the session is dropped on the server", async () => {
    const api = new FakeDrive();
    const { queue } = queueWith(api, { partsPerFile: 1 });
    const [job] = queue.add([source("drop.bin", 12)], TARGET);
    const put = api.putDrivePart.bind(api);
    api.putDrivePart = async (...args) => {
      const out = await put(...args);
      void queue.cancel(job!.id);
      return out;
    };
    await settle(queue);
    expect(job!.state).toBe("cancelled");
    expect(api.sessions.get(job!.uploadId!)!.out.status).toBe("aborted");
  });
});

describe("after a restart", () => {
  it("a browser's session waits for the same file to be picked again, then sends only what is missing", async () => {
    const api = new FakeDrive();
    const storage = memoryStorage();
    const first = queueWith(api, { storage, partsPerFile: 1 });
    const file = source("thesis.pdf", 12, { lastModified: 1_700_000_000_000 });
    const [job] = first.queue.add([file], TARGET);
    const put = api.putDrivePart.bind(api);
    api.putDrivePart = async (...args) => {
      const out = await put(...args);
      if (args[1] === 1) first.queue.stop(); // the tab is closed after the first part
      return out;
    };
    await settle(first.queue, () => api.puts.length >= 1);
    await settle(first.queue, () => false);
    expect(storage.saved).toHaveLength(1);
    expect(storage.saved[0]).toMatchObject({ name: "thesis.pdf", size: 12, uploadId: job!.uploadId, path: null });
    api.putDrivePart = put;

    const second = queueWith(api, { storage, partsPerFile: 1 });
    await second.queue.restore();
    const [restored] = second.queue.jobs;
    expect(restored!.state).toBe("needs-file");
    expect(restored!.received).toEqual([1]);
    // A different file does not match; the same one (name, size, time) does.
    expect(second.queue.attach([source("thesis.pdf", 11)])).toHaveLength(1);
    expect(second.queue.attach([source("thesis.pdf", 12, { lastModified: 1_700_000_000_500 })])).toEqual([]);
    await settle(second.queue);
    expect(restored!.state).toBe("done");
    expect(api.puts.map(([, n]) => n)).toEqual([1, 2, 3]);
    expect(storage.saved).toEqual([]);
  });

  it("the desktop app reads the file again from its path and goes on by itself", async () => {
    const api = new FakeDrive();
    const created = await api.createDriveUpload({ client_upload_id: "c1", parent_id: "root", name: "data.csv", size_bytes: 8, on_conflict: "fail" });
    const bytes = await source("data.csv", 8).read(0, 8);
    await api.putDrivePart(created.id, 1, bytes.slice(0, 4), `sha:4:${bytes[0]}`);
    const storage = memoryStorage([{ clientUploadId: "c1", uploadId: created.id, name: "data.csv", size: 8, lastModified: null, relativeDir: "", target: TARGET, onConflict: "fail", path: "/Users/me/data.csv", paused: false }]);
    const reopen = vi.fn(async (entry: PersistedUpload) => source(entry.name, entry.size, { path: entry.path }));
    const { queue } = queueWith(api, { storage, reopen });
    await queue.restore();
    await settle(queue);
    expect(reopen).toHaveBeenCalledTimes(1);
    expect(queue.jobs[0]!.state).toBe("done");
    expect(api.puts.map(([, n]) => n)).toEqual([1, 2]);
  });

  it("a session the server no longer has is not shown again", async () => {
    const api = new FakeDrive();
    const storage = memoryStorage([{ clientUploadId: "gone", uploadId: "u-gone", name: "gone.txt", size: 3, lastModified: null, relativeDir: "", target: TARGET, onConflict: "fail", path: null, paused: false }]);
    const { queue } = queueWith(api, { storage });
    await queue.restore();
    expect(queue.jobs).toEqual([]);
  });

  it("a file that can no longer be read waits to be picked again", async () => {
    const api = new FakeDrive();
    const { queue } = queueWith(api, { partsPerFile: 1 });
    const [job] = queue.add([source("moved.bin", 12, { failAt: 4 })], TARGET);
    await settle(queue);
    expect(job!.state).toBe("needs-file");
    expect(job!.error).toBe("read_failed");
    expect(job!.received).toEqual([1]);
  });
});

describe("drive.upload.updated", () => {
  it("a completion finished in the background ends the job", () => {
    const api = new FakeDrive();
    const { queue } = queueWith(api);
    const [job] = queue.add([source("bg.bin", 0)], TARGET);
    queue.stop();
    job!.state = "completing";
    job!.uploadId = "u-bg";
    queue.applyEvent({ id: "u-bg", client_upload_id: job!.clientUploadId, status: "completed", item_id: "item-bg" } as DriveUploadOut);
    expect(job!.state).toBe("done");
    expect(job!.itemId).toBe("item-bg");
  });
});
