// @vitest-environment jsdom
/**
 * CF5 (docs/CHANNEL_FILES.md §12.4, §23, §26): a file over the attachment limit added to the composer is offered to the
 * drive — the channel's 「投稿のファイル › 2026-10」 (POST /drive/channel-posts), the channel drive's top where its files
 * stay out of its drive, マイドライブ in a DM or where I cannot write the channel's drive — goes up with the drive's
 * resumable upload, shows its progress in a chip that can cancel it, lets sending go on, and leaves its `/d/<id>` link
 * in the draft when done.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "../src/api/errors";
import type { DriveChannelPostsOut, DriveChildrenOut, DriveItemOut, DriveLocationOut, DriveUploadCompleteOut, DriveUploadCreate, DriveUploadOut } from "../src/api/types";
import { addBigUploads, appendLink, bigFileWhere, bigUploadsOf, chipJob, findPostsFolder, holdsSend, isBigFile, monthFolderName, resetBigUploads, resolveBigFilePlace, splitRelease } from "../src/drive/bigFiles";
import type { UploadJob } from "../src/drive/uploads";
import type { AppController } from "../src/state/app";
import { Store } from "../src/sync/store";
import type { ChannelState } from "../src/sync/types";
import { Composer } from "../src/ui/Composer";
import { FakeServer } from "./fakeServer";

const MB = 1024 * 1024;
const BASE = "https://chat.example";
const NOW = new Date("2026-10-29T03:00:00Z");

function folder(id: string, over: Partial<DriveItemOut> = {}): DriveItemOut {
  return {
    id, location_id: "loc-ch", parent_id: "root-ch", kind: "folder", name: id, size_bytes: 0, content_type: null,
    content_modified_at: null, created_by: "u1", created_at: "", updated_by: "u1", updated_at: "", version_count: 0, file: null,
    link_count: 0, posted: false, ...over,
  } as DriveItemOut;
}

function location(kind: DriveLocationOut["kind"], over: Partial<DriveLocationOut> = {}): DriveLocationOut {
  const id = kind === "channel" ? "loc-ch" : "loc-me";
  return {
    id, kind, channel_id: kind === "channel" ? "ch" : null, user_id: null, root_id: kind === "channel" ? "root-ch" : "root-me",
    name: kind === "channel" ? "m2" : "マイドライブ", can_write: true, can_manage: false, can_share: true, external_links: true,
    quota_bytes: null, used_bytes: 0, item_count: 0, ...over,
  };
}

function channelPosts(over: Partial<DriveChannelPostsOut> = {}): DriveChannelPostsOut {
  return {
    location: location("channel"), files_to_drive: true, month: "2026-10", timezone: "Asia/Tokyo",
    posts_folder: folder("posts", { name: "投稿のファイル", system_role: "channel_posts" }),
    month_folder: folder("month", { name: "2026-10", parent_id: "posts" }), ...over,
  };
}

/** A server before CF5: POST /drive/channel-posts is no route there. */
const noRoute = async (): Promise<DriveChannelPostsOut> => {
  throw new ApiError(404, "not_found", "Not Found");
};

function listing(items: DriveItemOut[], next: string | null = null): DriveChildrenOut {
  return { folder: folder("root-ch"), items, next_cursor: next, path: [], shared_above: 0 };
}

/** A big File without its bytes held: `size` says it is big, and each slice reads zeros of the slice's length. */
function bigFile(name: string, size = 101 * MB): File {
  const file = new File([new Uint8Array([1, 2, 3, 4])], name, { type: "video/mp4", lastModified: 1_700_000_000_000 });
  Object.defineProperty(file, "size", { value: size });
  Object.defineProperty(file, "slice", { value: (start: number, end: number) => ({ arrayBuffer: async () => new ArrayBuffer(Math.min(end, size) - start) }) });
  return file;
}

afterEach(cleanup);
beforeEach(() => {
  resetBigUploads();
  localStorage.clear();
});

describe("the rules", () => {
  it("tells a big file by the attachment limit (the server's when it said)", () => {
    expect(isBigFile(100 * MB)).toBe(false);
    expect(isBigFile(100 * MB + 1)).toBe(true);
    expect(isBigFile(150 * MB, 200 * MB)).toBe(false);
    expect(isBigFile(150 * MB, null)).toBe(true);
  });

  it("names the month folder in the server's zone (Asia/Tokyo unless it says)", () => {
    expect(monthFolderName(new Date("2026-10-31T14:59:00Z"))).toBe("2026-10");
    expect(monthFolderName(new Date("2026-10-31T15:00:00Z"))).toBe("2026-11");
    expect(monthFolderName(new Date("2026-12-31T15:30:00Z"))).toBe("2027-01");
    expect(monthFolderName(new Date("2026-10-31T15:00:00Z"), "UTC")).toBe("2026-10");
  });

  it("puts the link at the end of the draft, once", () => {
    expect(appendLink("", `${BASE}/d/x`)).toBe(`${BASE}/d/x `);
    expect(appendLink("動画です", `${BASE}/d/x`)).toBe(`動画です ${BASE}/d/x `);
    expect(appendLink("動画です\n", `${BASE}/d/x`)).toBe(`動画です\n${BASE}/d/x `);
    expect(appendLink(`見て ${BASE}/d/x `, `${BASE}/d/x`)).toBe(`見て ${BASE}/d/x `);
  });

  it("sends a channel's files to its drive where I can write it: 「投稿のファイル」 while its files go there, else the top", () => {
    const on = { channel_files_to_drive: true };
    expect(bigFileWhere({ type: "public", files_to_drive: null }, on)).toBe("posts");
    expect(bigFileWhere({ type: "private", files_to_drive: true }, { channel_files_to_drive: false })).toBe("posts");
    expect(bigFileWhere({ type: "public", files_to_drive: false }, on)).toBe("channel");
    expect(bigFileWhere({ type: "public", files_to_drive: null }, { channel_files_to_drive: false })).toBe("channel");
    expect(bigFileWhere({ type: "public", files_to_drive: false }, on, false)).toBe("me");
    expect(bigFileWhere({ type: "dm", files_to_drive: null }, on)).toBe("me");
    expect(bigFileWhere({ type: "group_dm", files_to_drive: null }, on)).toBe("me");
    expect(bigFileWhere({ type: "public", files_to_drive: null }, on, false)).toBe("me");
  });

  it("keeps a composer's chips over a restart, matched to the queue's job by client_upload_id", () => {
    const job = { id: "j1", clientUploadId: "c1", name: "big.mp4", size: 200 * MB, state: "uploading" } as UploadJob;
    const release = vi.fn();
    addBigUploads("acct", "ch:", [job], "#m2 › 投稿のファイル › 2026-10", release);
    resetBigUploads(); // the app started again: only localStorage is left
    const [kept] = bigUploadsOf("acct", "ch:");
    expect(kept).toEqual({ clientUploadId: "c1", key: "ch:", name: "big.mp4", size: 200 * MB, label: "#m2 › 投稿のファイル › 2026-10" });
    expect(bigUploadsOf("acct", "other:")).toEqual([]);
    const restored = { ...job, id: "j2", state: "needs-file" } as UploadJob;
    expect(chipJob(kept!, [restored])).toBe(restored);
    expect(holdsSend(restored)).toBe(true);
    expect(holdsSend(null)).toBe(true);
    expect(holdsSend({ ...restored, state: "done" })).toBe(false);
  });

  it("lets a split release go once every part has", () => {
    const release = vi.fn();
    const [a, b] = splitRelease(release, 2) as [() => void, () => void];
    a();
    a();
    expect(release).not.toHaveBeenCalled();
    b();
    expect(release).toHaveBeenCalledOnce();
  });
});

describe("the folder", () => {
  const channel = { id: "ch", name: "m2", type: "public", files_to_drive: null } as unknown as ChannelState;
  const settings = { channel_files_to_drive: true };

  it("asks the server for 「投稿のファイル › month」 and uploads into the month folder itself", async () => {
    const api = { driveChannelPosts: vi.fn(async () => channelPosts()), resolveDriveLocation: vi.fn(), driveChildren: vi.fn() };
    const place = await resolveBigFilePlace(api, channel, settings, NOW);
    expect(api.driveChannelPosts).toHaveBeenCalledWith("ch");
    expect(place).toEqual({ target: { parentId: "month", locationId: "loc-ch", label: "#m2 › 投稿のファイル › 2026-10" }, relativeDir: "", kind: "posts" });
    expect(api.resolveDriveLocation).not.toHaveBeenCalled();
    expect(api.driveChildren).not.toHaveBeenCalled();
  });

  it("uses the channel drive's top when the server says its files stay out of its drive", async () => {
    const api = { driveChannelPosts: vi.fn(async () => channelPosts({ files_to_drive: false, posts_folder: null, month_folder: null })), resolveDriveLocation: vi.fn(), driveChildren: vi.fn() };
    expect(await resolveBigFilePlace(api, channel, settings, NOW)).toEqual({ target: { parentId: "root-ch", locationId: "loc-ch", label: "#m2" }, relativeDir: "", kind: "root" });
  });

  it("uses the channel drive's top, without asking for 「投稿のファイル」, where the switch is off", async () => {
    const api = { driveChannelPosts: vi.fn(), resolveDriveLocation: vi.fn(async () => location("channel")), driveChildren: vi.fn() };
    const place = await resolveBigFilePlace(api, { ...channel, files_to_drive: false } as ChannelState, settings, NOW);
    expect(place).toEqual({ target: { parentId: "root-ch", locationId: "loc-ch", label: "#m2" }, relativeDir: "", kind: "root" });
    expect(api.driveChannelPosts).not.toHaveBeenCalled();
    expect(api.resolveDriveLocation).toHaveBeenCalledWith({ kind: "channel", channel_id: "ch" });
  });

  it("goes to マイドライブ where I cannot write the channel's drive (403), and in a DM", async () => {
    const refused = {
      driveChannelPosts: vi.fn(async () => {
        throw new ApiError(403, "drive_read_only", "no");
      }),
      resolveDriveLocation: vi.fn(async () => location("user")),
      driveChildren: vi.fn(),
    };
    expect((await resolveBigFilePlace(refused, channel, settings, NOW)).target).toEqual({ parentId: "root-me", locationId: "loc-me", label: "マイドライブ" });
    expect(refused.resolveDriveLocation).toHaveBeenCalledWith({ kind: "me" });
    const readOnlyTop = { driveChannelPosts: vi.fn(), resolveDriveLocation: vi.fn(async (body: { kind: string }) => (body.kind === "channel" ? location("channel", { can_write: false }) : location("user"))), driveChildren: vi.fn() };
    expect((await resolveBigFilePlace(readOnlyTop, { ...channel, files_to_drive: false } as ChannelState, settings, NOW)).kind).toBe("me");
    const dm = { driveChannelPosts: vi.fn(), resolveDriveLocation: vi.fn(async () => location("user")), driveChildren: vi.fn() };
    await resolveBigFilePlace(dm, { ...channel, type: "dm" } as ChannelState, settings, NOW);
    await resolveBigFilePlace(dm, { ...channel, type: "group_dm" } as ChannelState, settings, NOW);
    expect(dm.resolveDriveLocation.mock.calls).toEqual([[{ kind: "me" }], [{ kind: "me" }]]);
    expect(dm.driveChannelPosts).not.toHaveBeenCalled();
  });

  it("has no place in an archived channel (the composer says the file is too large)", async () => {
    const api = { driveChannelPosts: vi.fn(), resolveDriveLocation: vi.fn(), driveChildren: vi.fn() };
    await expect(resolveBigFilePlace(api, { ...channel, archived: true } as ChannelState, settings, NOW)).rejects.toThrow();
    expect(api.resolveDriveLocation).not.toHaveBeenCalled();
  });

  describe("a server before CF5 (no POST /drive/channel-posts)", () => {
    it("finds 「投稿のファイル」 by its role, on a later page too, and names the month below it in the server's zone", async () => {
      const driveChildren = vi.fn(async (_id: string, query?: { cursor?: string | null }) =>
        query?.cursor ? listing([folder("posts", { name: "投稿のファイル", system_role: "channel_posts" })]) : listing([folder("a"), folder("投稿のファイル")], "next"),
      );
      const api = { driveChannelPosts: vi.fn(noRoute), resolveDriveLocation: vi.fn(async () => location("channel")), driveChildren };
      const place = await resolveBigFilePlace(api, channel, settings, NOW);
      expect(api.resolveDriveLocation).toHaveBeenCalledWith({ kind: "channel", channel_id: "ch" });
      expect(place).toEqual({ target: { parentId: "posts", locationId: "loc-ch", label: "#m2 › 投稿のファイル › 2026-10" }, relativeDir: "2026-10", kind: "posts" });
      expect(driveChildren).toHaveBeenCalledTimes(2);
      const late = new Date("2026-10-31T15:30:00Z");
      expect((await resolveBigFilePlace(api, channel, settings, late)).relativeDir).toBe("2026-11");
      expect((await resolveBigFilePlace(api, channel, settings, late, "UTC")).relativeDir).toBe("2026-10");
    });

    it("uses the channel drive's top while 「投稿のファイル」 is not made yet (an ordinary folder of that name is not it)", async () => {
      const api = { driveChannelPosts: vi.fn(noRoute), resolveDriveLocation: vi.fn(async () => location("channel")), driveChildren: vi.fn(async () => listing([folder("投稿のファイル")])) };
      expect(await findPostsFolder(api, "root-ch")).toBeNull();
      const place = await resolveBigFilePlace(api, channel, settings, NOW);
      expect(place).toEqual({ target: { parentId: "root-ch", locationId: "loc-ch", label: "#m2" }, relativeDir: "", kind: "root" });
    });

    it("goes to マイドライブ where I cannot write the channel's drive, or am refused it", async () => {
      const readOnly = { driveChannelPosts: vi.fn(noRoute), resolveDriveLocation: vi.fn(async (body: { kind: string }) => (body.kind === "channel" ? location("channel", { can_write: false }) : location("user"))), driveChildren: vi.fn() };
      expect((await resolveBigFilePlace(readOnly, channel, settings, NOW)).target).toEqual({ parentId: "root-me", locationId: "loc-me", label: "マイドライブ" });
      expect(readOnly.driveChildren).not.toHaveBeenCalled();
      const refused = {
        driveChannelPosts: vi.fn(noRoute),
        resolveDriveLocation: vi.fn(async (body: { kind: string }) => {
          if (body.kind === "channel") throw new ApiError(403, "forbidden", "no");
          return location("user");
        }),
        driveChildren: vi.fn(),
      };
      expect((await resolveBigFilePlace(refused, channel, settings, NOW)).kind).toBe("me");
    });
  });
});

/** A drive that takes uploads; the completion waits for `finish()`. */
function fakeDriveApi(options: { me?: "ok" | "refused" } = {}) {
  let release: (() => void) | null = null;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const sessions = new Map<string, DriveUploadOut>();
  const creates: DriveUploadCreate[] = [];
  const api = {
    baseUrl: BASE,
    uploadAttachment: vi.fn(),
    resolveDriveLocation: vi.fn(async (body: { kind: string }) => {
      if (body.kind === "me" && options.me === "refused") throw new ApiError(403, "forbidden", "a guest");
      return body.kind === "channel" ? location("channel") : location("user");
    }),
    driveChannelPosts: vi.fn(async () => channelPosts()),
    driveChildren: vi.fn(async () => listing([])),
    createDriveUpload: vi.fn(async (body: DriveUploadCreate) => {
      creates.push(body);
      const out = {
        id: `up-${creates.length}`, client_upload_id: body.client_upload_id, status: "active", location_id: "loc", parent_id: body.parent_id,
        relative_dir: body.relative_dir ?? null, name: body.name, on_conflict: body.on_conflict, target_item_id: null, part_size: 16 * MB,
        parts_total: Math.ceil(body.size_bytes / (16 * MB)), received_parts: [], size_bytes: body.size_bytes, error: null, item_id: null,
        created_at: "", expires_at: "", content_modified_at: null,
      } as unknown as DriveUploadOut;
      sessions.set(out.id, out);
      return out;
    }),
    driveUpload: vi.fn(async (id: string) => sessions.get(id)!),
    driveUploads: vi.fn(async () => ({ uploads: [...sessions.values()] })),
    patchDriveUpload: vi.fn(),
    putDrivePart: vi.fn(async (id: string, number: number) => {
      const session = sessions.get(id)!;
      session.received_parts = [...session.received_parts, number];
      return { number, size_bytes: 16 * MB, received_parts: session.received_parts };
    }),
    completeDriveUpload: vi.fn(async (): Promise<DriveUploadCompleteOut> => {
      await gate;
      return { status: "completed", item: folder("item-big", { kind: "file" }) };
    }),
    abortDriveUpload: vi.fn(async () => undefined),
  };
  return { api, creates, finish: () => release?.() };
}

function setup(type: ChannelState["type"], api: ReturnType<typeof fakeDriveApi>["api"], filesToDrive: boolean | null = null) {
  const store = new Store();
  const server = new FakeServer();
  const me = server.addUser("me");
  const channel = store.upsertChannel({ ...server.createChannel("m2", me.id, type), files_to_drive: filesToDrive } as never, { isMember: true });
  store.workspaceSettings = { ...store.workspaceSettings, channel_files_to_drive: true };
  const controller = {
    store, api, accountKey: `acct-${Math.random()}`, sendKey: "shift-enter", isAdmin: false, can: () => false,
    setError: vi.fn(), setNotice: vi.fn(), driveReach: vi.fn(async () => null), engine: { send: vi.fn() },
  } as unknown as AppController;
  render(<Composer controller={controller} channel={channel} />);
  const input = document.querySelector('input[type="file"]:not([accept])') as HTMLInputElement;
  return { store, channel, controller, input };
}

describe("the composer", () => {
  it("offers the channel's drive for a big file, uploads it into the month folder with its progress, lets sending go on, then puts its link in", async () => {
    const drive = fakeDriveApi();
    const { store, channel, controller, input } = setup("public", drive.api);
    fireEvent.change(input, { target: { files: [bigFile("実験の動画.mp4")] } });
    const offer = await screen.findByRole("group", { name: "大きなファイル" });
    expect(offer.textContent).toContain("「実験の動画.mp4」は添付の上限（100 MB）を超えています。");
    expect(offer.textContent).toContain("このチャンネルのドライブの「投稿のファイル」");
    expect(drive.api.uploadAttachment).not.toHaveBeenCalled();
    expect(controller.setError).not.toHaveBeenCalled();

    act(() => store.setDraft(channel.id, null, { text: "先に送る" }));
    fireEvent.click(screen.getByRole("button", { name: "ドライブにアップロードしてリンクを投稿" }));
    await waitFor(() => expect(drive.creates).toHaveLength(1));
    const month = "2026-10";
    expect(drive.api.driveChannelPosts).toHaveBeenCalledWith(channel.id);
    expect(drive.creates[0]).toMatchObject({ name: "実験の動画.mp4", parent_id: "month", on_conflict: "rename", size_bytes: 101 * MB });
    expect(drive.creates[0]?.relative_dir ?? null).toBeNull();
    expect(screen.queryByRole("group", { name: "大きなファイル" })).toBeNull();
    await waitFor(() => expect(drive.api.completeDriveUpload).toHaveBeenCalled());
    expect(drive.api.putDrivePart).toHaveBeenCalledTimes(7);
    expect(screen.getByText(`保存先：#m2 › 投稿のファイル › ${month}`, { exact: false })).toBeTruthy();
    expect(screen.getByRole("progressbar", { name: "「実験の動画.mp4」のアップロード" })).toBeTruthy();
    expect(screen.getByText("アップロード中も送信できます。終わるとリンクが入力欄に入ります。")).toBeTruthy();

    // Sending does not wait for the upload: the text goes now, the link into the emptied draft later.
    const sendButton = screen.getByRole("button", { name: "送信" }) as HTMLButtonElement;
    expect(sendButton.disabled).toBe(false);
    fireEvent.click(sendButton);
    await waitFor(() => expect(controller.engine!.send).toHaveBeenCalled());
    expect(controller.setNotice).not.toHaveBeenCalled();
    await waitFor(() => expect(store.draft(channel.id).text).toBe(""));
    act(() => store.setDraft(channel.id, null, { text: "動画です" }));

    await act(async () => drive.finish());
    await waitFor(() => expect(store.draft(channel.id).text).toBe(`動画です ${BASE}/d/item-big `));
    expect(document.querySelector("[data-big-upload]")).toBeNull();
    // Once: the chip is gone, nothing puts the link in again.
    act(() => store.setDraft(channel.id, null, { text: "" }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(store.draft(channel.id).text).toBe("");
  });

  it("offers マイドライブ in a DM (others cannot open it), and the channel drive's top where its files stay out of its drive", async () => {
    for (const [type, filesToDrive, text, parent] of [
      ["dm", null, "マイドライブにアップロードして、リンクを投稿できます。ほかの人はこのリンクのファイルを開けません", "root-me"],
      ["public", false, "このチャンネルのドライブにアップロードして、リンクを投稿できます。", "root-ch"],
    ] as const) {
      const drive = fakeDriveApi();
      const { input } = setup(type, drive.api, filesToDrive);
      fireEvent.change(input, { target: { files: [bigFile("big.zip"), bigFile("big2.zip")] } });
      const offer = await screen.findByRole("group", { name: "大きなファイル" });
      expect(offer.textContent).toContain("2 件のファイルが添付の上限（100 MB）を超えています。");
      expect(offer.textContent).toContain(text);
      fireEvent.click(screen.getByRole("button", { name: "ドライブにアップロードしてリンクを投稿" }));
      await waitFor(() => expect(drive.creates).toHaveLength(2));
      expect(drive.creates.map((create) => [create.parent_id, create.relative_dir ?? null])).toEqual([[parent, null], [parent, null]]);
      expect(drive.api.driveChannelPosts).not.toHaveBeenCalled();
      cleanup();
    }
  });

  it("follows the server's attachment limit", async () => {
    const drive = fakeDriveApi();
    drive.api.uploadAttachment.mockResolvedValue({ id: "a1", filename: "mid.mp4", content_type: "video/mp4", size_bytes: 4, status: "pending", has_thumbnail: false, created_at: "" });
    const { store, channel, input } = setup("public", drive.api);
    store.setServerLimits(200 * MB, "Asia/Tokyo");
    fireEvent.change(input, { target: { files: [bigFile("mid.mp4", 150 * MB)] } });
    await waitFor(() => expect(store.draft(channel.id).attachments.map((a) => a.id)).toEqual(["a1"]));
    expect(screen.queryByRole("group", { name: "大きなファイル" })).toBeNull();
    fireEvent.change(input, { target: { files: [bigFile("big.mp4", 201 * MB)] } });
    expect((await screen.findByRole("group", { name: "大きなファイル" })).textContent).toContain("（200 MB）");
  });

  it("attaches the small files as before and offers only the big one", async () => {
    const drive = fakeDriveApi();
    drive.api.uploadAttachment.mockResolvedValue({ id: "a1", filename: "small.pdf", content_type: "application/pdf", size_bytes: 4, status: "pending", has_thumbnail: false, created_at: "" });
    const { store, channel, input } = setup("public", drive.api);
    const small = new File([new Uint8Array([1])], "small.pdf", { type: "application/pdf" });
    fireEvent.change(input, { target: { files: [small, bigFile("big.mp4")] } });
    await waitFor(() => expect(store.draft(channel.id).attachments.map((a) => a.id)).toEqual(["a1"]));
    expect(drive.api.uploadAttachment).toHaveBeenCalledOnce();
    expect((await screen.findByRole("group", { name: "大きなファイル" })).textContent).toContain("「big.mp4」");
  });

  it("drops the offer on やめる, and cancels a running upload from its chip", async () => {
    const drive = fakeDriveApi();
    const { input } = setup("public", drive.api);
    fireEvent.change(input, { target: { files: [bigFile("a.mp4")] } });
    fireEvent.click(await screen.findByRole("button", { name: "キャンセル" }));
    expect(screen.queryByRole("group", { name: "大きなファイル" })).toBeNull();
    expect(drive.api.createDriveUpload).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { files: [bigFile("b.mp4")] } });
    fireEvent.click(await screen.findByRole("button", { name: "ドライブにアップロードしてリンクを投稿" }));
    await waitFor(() => expect(drive.api.completeDriveUpload).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "「b.mp4」のアップロードをやめる" }));
    await waitFor(() => expect(drive.api.abortDriveUpload).toHaveBeenCalledWith("up-1"));
    expect(document.querySelector("[data-big-upload]")).toBeNull();
  });

  it("says the file is too large when there is no drive I can write (a guest has no マイドライブ)", async () => {
    const drive = fakeDriveApi({ me: "refused" });
    const { controller, input } = setup("dm", drive.api);
    fireEvent.change(input, { target: { files: [bigFile("big.mov")] } });
    fireEvent.click(await screen.findByRole("button", { name: "ドライブにアップロードしてリンクを投稿" }));
    await waitFor(() => expect(controller.setError).toHaveBeenCalledWith("「big.mov」は大きすぎます（100 MB まで）"));
    expect(drive.api.createDriveUpload).not.toHaveBeenCalled();
  });
});
