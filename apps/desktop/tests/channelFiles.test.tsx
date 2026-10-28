// @vitest-environment jsdom
/**
 * CF2 (docs/CHANNEL_FILES.md §12, §19.3): files posted in a channel live in its drive too. A message draws each state
 * (as before and 「ドライブで表示」 / 「表示できないファイル」 for a moved one / 「削除されたファイル」 with 「戻す」 for writers),
 * never the name of a file it may not show; the viewers say where it is and whether a newer version exists; the delete
 * asks about the drive's files; the drive shows 「投稿のファイル」 in the UI language with no rename / move / trash,
 * marks posted files and lists their posts; a trash or a move that hides files from messages is confirmed first; the
 * composer says where files go; the local cache keeps `drive`.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "../src/api/errors";
import type { AttachmentOut, DriveChildrenOut, DriveImpactOut, DriveItemDetailOut, DriveItemOut, DriveLocationOut, DriveUsageOut, DriveVersionListOut, MessageOut } from "../src/api/types";
import { AdminDriveTab } from "../src/ui/AdminDriveTab";
import { VersionsDialog } from "../src/ui/DriveVersions";
import { canRearrange, canRestorePosted, crumbName, deleteDriveFiles, driveFilesParam, filesToDrive, hasNewerVersion, impactLines, itemName, postedView } from "../src/drive/channelFiles";
import { setLocale } from "../src/i18n";
import type { AppController, DriveLinkState } from "../src/state/app";
import { Store } from "../src/sync/store";
import type { ChannelState, MessageState } from "../src/sync/types";
import { AttachmentList, Lightbox } from "../src/ui/Attachments";
import { ComposerDriveHint, DeleteDriveFilesOption } from "../src/ui/ChannelFiles";
import { DriveBrowser } from "../src/ui/DriveBrowser";
import { messageActions } from "../src/ui/messageActions";
import { MemoryPersistence } from "./fakeServer";

const FILE: AttachmentOut = { id: "a1", filename: "修論_草稿.pdf", content_type: "application/pdf", size_bytes: 2048, has_thumbnail: false, has_poster: false, has_display: false, duration_ms: null, status: "attached", created_at: "2026-10-28T06:00:00Z", width: null, height: null };
const PHOTO: AttachmentOut = { ...FILE, id: "p1", filename: "実験の写真.png", content_type: "image/png", has_thumbnail: true, width: 10, height: 10 };

function posted(attachment: AttachmentOut, state: "available" | "moved" | "trashed" | "deleted", item = "item-1"): AttachmentOut {
  return state === "deleted"
    ? { ...attachment, drive: { item_id: null, version_id: null, version_number: null, state } }
    : { ...attachment, drive: { item_id: item, version_id: "ver-1", version_number: 1, state } };
}

const CHANNEL = { id: "ch", type: "public", name: "m2-seminar", isMember: true, archived: false, posting_policy: "everyone", membership: { role: "member", joined_at: "" }, files_to_drive: null } as unknown as ChannelState;

function driveItem(id: string, over: Partial<DriveItemOut> = {}): DriveItemOut {
  return {
    id, location_id: "loc", parent_id: "root", kind: "file", name: `${id}.pdf`, size_bytes: 2048, content_type: "application/pdf",
    content_modified_at: null, created_by: "u1", created_at: "2026-10-01T00:00:00Z", updated_by: "u1", updated_at: "2026-10-01T09:30:00Z",
    version_count: 1, file: null, link_count: 0, posted: false, ...over,
  };
}

function detail(item: DriveItemOut, path = [{ id: "root", name: "研究室ドライブ" }, { id: "papers", name: "論文" }], kind: DriveItemDetailOut["location_kind"] = "workspace"): DriveItemDetailOut {
  return { item, path, location_kind: kind };
}

function controllerWith(options: { link?: DriveLinkState | ((id: string) => DriveLinkState); api?: Record<string, unknown>; channel?: ChannelState | null; canModerate?: boolean; settings?: Record<string, unknown> } = {}) {
  const link = options.link ?? { state: "unreadable" };
  return {
    api: { fetchBlob: vi.fn(async () => new Blob()), ...options.api },
    engine: null,
    accountKey: "test",
    store: {
      users: new Map([["u1", { id: "u1", display_name: "加納" }], ["u2", { id: "u2", display_name: "三井" }]]),
      getChannel: (id: string) => (id === "ch" ? (options.channel === undefined ? CHANNEL : options.channel) : undefined),
      workspaceSettings: options.settings ?? { channel_files_to_drive: true },
    },
    driveLink: vi.fn(async (id: string) => (typeof link === "function" ? link(id) : link)),
    openDriveLink: vi.fn(async () => true),
    openPermalink: vi.fn(async () => true),
    restorePostedFile: vi.fn(async () => true),
    messageDriveFiles: vi.fn(async () => null),
    can: vi.fn(() => options.canModerate ?? false),
    setError: vi.fn(),
    setNotice: vi.fn(),
    downloadAttachment: vi.fn(),
    downloadDriveFile: vi.fn(),
    downloadDriveZip: vi.fn(),
  } as unknown as AppController & { driveLink: ReturnType<typeof vi.fn>; openDriveLink: ReturnType<typeof vi.fn>; restorePostedFile: ReturnType<typeof vi.fn> };
}

beforeEach(() => {
  vi.stubGlobal("URL", class extends URL {
    static override createObjectURL = vi.fn(() => "blob:x");
    static override revokeObjectURL = vi.fn();
  });
  vi.stubGlobal("IntersectionObserver", class {
    observe() {}
    disconnect() {}
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  setLocale("ja");
});

describe("the rules (drive/channelFiles.ts)", () => {
  it("reads a file's state from AttachmentOut.drive", () => {
    expect(postedView(FILE)).toBe("plain");
    expect(postedView({ ...FILE, drive: null })).toBe("plain");
    expect(postedView(posted(FILE, "available"))).toBe("available");
    expect(postedView(posted(FILE, "moved"))).toBe("moved");
    expect(postedView(posted(FILE, "trashed"))).toBe("gone");
    expect(postedView(posted(FILE, "deleted"))).toBe("gone");
  });

  it("finds a newer version by comparing the version ids", () => {
    const item = driveItem("item-1", { file: { attachment_id: "x", version_id: "ver-1", width: null, height: null, has_thumbnail: false, has_poster: false, has_display: false, has_location: false, duration_ms: null, preview: null } });
    expect(hasNewerVersion(posted(FILE, "available").drive, item)).toBe(false);
    expect(hasNewerVersion(posted(FILE, "available").drive, { ...item, file: { ...item.file!, version_id: "ver-2" } })).toBe(true);
    expect(hasNewerVersion(posted(FILE, "deleted").drive, item)).toBe(false);
  });

  it("decides the composer's line by the channel's switch, else the workspace's; never in a DM or before CF1", () => {
    expect(filesToDrive({ ...CHANNEL, files_to_drive: null }, { channel_files_to_drive: true })).toBe(true);
    expect(filesToDrive({ ...CHANNEL, files_to_drive: false }, { channel_files_to_drive: true })).toBe(false);
    expect(filesToDrive({ ...CHANNEL, files_to_drive: true }, { channel_files_to_drive: false })).toBe(true);
    expect(filesToDrive({ ...CHANNEL, type: "dm", files_to_drive: null }, { channel_files_to_drive: true })).toBe(false);
    expect(filesToDrive({ ...CHANNEL, files_to_drive: undefined }, {})).toBe(false);
  });

  it("offers 「戻す」 to who can write the channel's drive", () => {
    expect(canRestorePosted(CHANNEL, false)).toBe(true);
    expect(canRestorePosted({ ...CHANNEL, archived: true }, false)).toBe(false);
    expect(canRestorePosted({ ...CHANNEL, isMember: false }, false)).toBe(false);
    expect(canRestorePosted({ ...CHANNEL, posting_policy: "owners" }, false)).toBe(false);
    expect(canRestorePosted({ ...CHANNEL, posting_policy: "owners" }, true)).toBe(true);
    expect(canRestorePosted({ ...CHANNEL, posting_policy: "owners", membership: { role: "owner", joined_at: "" } } as ChannelState, false)).toBe(true);
  });

  it("sends auto while the box is on, keep when it is off or nothing would go", () => {
    const summary = deleteDriveFiles([{ trash: true, reason: null }, { trash: false, reason: "changed" }, { trash: false, reason: "not_permitted" }]);
    expect(summary).toEqual({ trash: 1, changed: 1, others: 1 });
    expect(driveFilesParam(summary, true)).toBe("auto");
    expect(driveFilesParam(summary, false)).toBe("keep");
    expect(driveFilesParam({ trash: 0, changed: 1, others: 0 }, true)).toBe("keep");
    expect(driveFilesParam(null, true)).toBeUndefined();
  });

  it("words the warning per conversation, with the members and guests a move hides it from", () => {
    const impact: DriveImpactOut = { posted_messages: 3, channels: [{ channel_id: "ch", messages: 2, unreadable_after: 3, unreadable_guests: 2 }] };
    const name = (id: string) => (id === "ch" ? "m2-seminar" : null);
    expect(impactLines(impact, "move", name)).toEqual([
      "このファイルは #m2-seminar の 2 件のメッセージに付いています。",
      "移すと、#m2-seminar のメンバーのうち 3 人（ゲスト 2 人を含む）がメッセージの中でこのファイルを見られなくなります。",
      "ほかに、見る権限の無い会話の 1 件のメッセージにも付いています。",
    ]);
    const trash = impactLines({ posted_messages: 2, channels: [{ channel_id: "ch", messages: 2, unreadable_after: 5, unreadable_guests: 0 }] }, "trash", name);
    expect(trash[0]).toBe("このファイルは #m2-seminar の 2 件のメッセージに付いています。");
    expect(trash.at(-1)).toContain("削除されたファイル");
  });

  it("names 「投稿のファイル」 in the UI language and keeps it in place", () => {
    const folder = driveItem("posts", { kind: "folder", name: "投稿のファイル", system_role: "channel_posts" });
    expect(itemName(folder)).toBe("投稿のファイル");
    setLocale("en");
    expect(itemName(folder)).toBe("Posted files");
    expect(crumbName({ id: "unseen", name: "投稿のファイル" }, 1, "channel")).toBe("Posted files");
    expect(crumbName({ id: "unseen", name: "投稿のファイル" }, 2, "channel")).toBe("投稿のファイル"); // deeper: a folder of that name
    expect(crumbName({ id: "unseen", name: "投稿のファイル" }, 1, "workspace")).toBe("投稿のファイル");
    // §19.4: a server that says the crumb's role is believed (no guessing by the name).
    expect(crumbName({ id: "x", name: "投稿のファイル", system_role: "channel_posts" }, 3, "workspace")).toBe("Posted files");
    expect(crumbName({ id: "x", name: "投稿のファイル", system_role: null }, 1, "channel")).toBe("投稿のファイル");
    setLocale("zh-Hans");
    expect(itemName(folder)).toBe("帖子中的文件");
    expect(canRearrange([folder])).toBe(false);
    expect(canRearrange([driveItem("2026-10", { kind: "folder", name: "2026-10" })])).toBe(true);
  });
});

describe("a message's files (§12.1)", () => {
  it("draws an available file as before, the others as their state says, never a hidden file's name", async () => {
    const controller = controllerWith({ link: { state: "unreadable" } });
    render(<AttachmentList attachments={[posted(FILE, "available"), posted({ ...FILE, id: "a2", filename: "見せない.pdf" }, "trashed", "item-2"), posted({ ...FILE, id: "a3", filename: "消えた.pdf" }, "deleted"), posted({ ...FILE, id: "a4", filename: "移した.pdf" }, "moved", "item-4")]} controller={controller} channelId="ch" />);
    expect(screen.getByTitle("修論_草稿.pdf")).toBeTruthy();
    expect(screen.getAllByText("削除されたファイル")).toHaveLength(2);
    expect(await screen.findByText("表示できないファイル")).toBeTruthy();
    expect(screen.getByText("このファイルは別の場所へ移されました。")).toBeTruthy();
    expect(controller.driveLink).toHaveBeenCalledWith("item-4", false);
    for (const hidden of ["見せない.pdf", "消えた.pdf", "移した.pdf"]) expect(document.body.textContent).not.toContain(hidden);
    // The status is said by an icon and the text: no coloured band.
    for (const row of document.querySelectorAll("[data-posted-file]")) expect(row.className).not.toMatch(/border-l-[2-9]/);
  });

  it("offers 「戻す」 for a trashed file to who can write the drive, and not for a deleted one", async () => {
    const controller = controllerWith();
    render(<AttachmentList attachments={[posted(FILE, "trashed"), posted({ ...FILE, id: "a2" }, "deleted")]} controller={controller} channelId="ch" />);
    expect(screen.getByText("ゴミ箱にあります")).toBeTruthy();
    const restore = screen.getAllByRole("button", { name: /戻す/ });
    expect(restore).toHaveLength(1);
    fireEvent.click(restore[0]!);
    await waitFor(() => expect(controller.restorePostedFile).toHaveBeenCalledWith("item-1"));
    cleanup();
    // Only owners post here: a member may not write the drive.
    render(<AttachmentList attachments={[posted(FILE, "trashed")]} controller={controllerWith({ channel: { ...CHANNEL, posting_policy: "owners" } as ChannelState })} channelId="ch" />);
    expect(screen.getByText("削除されたファイル")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /戻す/ })).toBeNull();
  });

  it("draws a moved file for who can read it where it is, with that place", async () => {
    const controller = controllerWith({ link: { state: "ok", detail: detail(driveItem("item-1")) } });
    render(<AttachmentList attachments={[posted(PHOTO, "moved")]} controller={controller} channelId="ch" />);
    await screen.findByText("研究室ドライブ › 論文");
    expect(document.querySelector("[data-posted-file=moved] [data-media-tile]")).toBeTruthy();
    fireEvent.click(screen.getByText("研究室ドライブ › 論文"));
    expect(controller.openDriveLink).toHaveBeenCalledWith("item-1");
  });

  it("the viewer says where the file is, offers 「ドライブで表示」 and a newer version", async () => {
    const current = driveItem("item-1", { updated_by: "u2", file: { attachment_id: "x2", version_id: "ver-2", width: null, height: null, has_thumbnail: false, has_poster: false, has_display: false, has_location: false, duration_ms: null, preview: null } });
    const controller = controllerWith({ link: { state: "ok", detail: detail(current, [{ id: "root", name: "m2-seminar" }, { id: "posts", name: "投稿のファイル" }, { id: "m", name: "2026-10" }], "channel") } });
    const onClose = vi.fn();
    render(<Lightbox attachment={posted(PHOTO, "available")} controller={controller} onClose={onClose} />);
    expect(await screen.findByText("ドライブ：#m2-seminar › 投稿のファイル › 2026-10")).toBeTruthy();
    expect(screen.getByText(/新しいバージョンがあります（.*三井）/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "最新を開く" })).toBeTruthy();
    // A posted file is in the drive already: the copy is 「ほかの場所に保存」.
    expect(screen.getByRole("button", { name: "ほかの場所に保存" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "ドライブで表示" }));
    expect(onClose).toHaveBeenCalled();
    expect(controller.openDriveLink).toHaveBeenCalledWith("item-1");
  });

  it("the message menu offers 「ドライブで表示」 for a posted file only", () => {
    const base = { mine: true, isAdmin: false, saved: false, thread: true, editable: true, showReactions: true, canMakeTask: false, canRequestReview: false, unreadOffered: false, canSaveToDrive: true };
    const message = { id: "m1", body: "", attachments: [posted(FILE, "available")] } as unknown as MessageState;
    const keys = messageActions({ ...base, message }).map((action) => action.key);
    expect(keys).toContain("showInDrive");
    expect(messageActions({ ...base, message }).find((action) => action.key === "saveToDrive")?.label).toBe("ほかの場所に保存");
    expect(messageActions({ ...base, message: { ...message, attachments: [posted(FILE, "trashed")] } }).map((action) => action.key)).not.toContain("showInDrive");
    expect(messageActions({ ...base, message: { ...message, attachments: [FILE] } }).find((action) => action.key === "saveToDrive")?.label).toBe("ドライブに保存");
  });
});

describe("the delete's check box (§7.3)", () => {
  it("is on by default with what auto would trash, says why the others stay, and sends keep when cleared", async () => {
    const controller = controllerWith();
    (controller.messageDriveFiles as ReturnType<typeof vi.fn>).mockResolvedValue([
      { attachment_id: "a1", item_id: "i1", state: "available", trash: true, reason: null },
      { attachment_id: "a2", item_id: "i2", state: "available", trash: true, reason: null },
      { attachment_id: "a3", item_id: "i3", state: "available", trash: false, reason: "changed" },
    ]);
    const onChange = vi.fn();
    render(<DeleteDriveFilesOption controller={controller} message={{ id: "m1", attachments: [posted(FILE, "available")] }} onChange={onChange} />);
    const box = await screen.findByRole("checkbox", { name: /ドライブの 2 件のファイルもゴミ箱に移す/ });
    expect((box as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText("1 件は投稿の後に変更されたため、ドライブに残ります。")).toBeTruthy();
    expect(onChange).toHaveBeenLastCalledWith("auto");
    fireEvent.click(box);
    expect(onChange).toHaveBeenLastCalledWith("keep");
    expect(controller.messageDriveFiles).toHaveBeenCalledWith("m1");
  });

  it("asks nothing for a message without files in a drive", async () => {
    const controller = controllerWith();
    const onChange = vi.fn();
    render(<DeleteDriveFilesOption controller={controller} message={{ id: "m1", attachments: [FILE, posted(PHOTO, "trashed")] }} onChange={onChange} />);
    await act(async () => undefined);
    expect(controller.messageDriveFiles).not.toHaveBeenCalled();
    expect(document.querySelector("[data-delete-drive-files]")).toBeNull();
    expect(onChange).toHaveBeenLastCalledWith(undefined);
  });

  it("says the files stay when none would go to the trash (another's files)", async () => {
    const controller = controllerWith();
    (controller.messageDriveFiles as ReturnType<typeof vi.fn>).mockResolvedValue([{ attachment_id: "a1", item_id: "i1", state: "available", trash: false, reason: "not_permitted" }]);
    const onChange = vi.fn();
    render(<DeleteDriveFilesOption controller={controller} message={{ id: "m1", attachments: [posted(FILE, "available")] }} onChange={onChange} />);
    expect(await screen.findByText("添付したファイルはチャンネルのドライブに残ります。")).toBeTruthy();
    expect(screen.queryByRole("checkbox")).toBeNull();
    // The text and the choice come from the same answer but land in separate renders: wait for the call.
    await waitFor(() => expect(onChange).toHaveBeenLastCalledWith("keep"));
  });
});

describe("the drive (§12.2)", () => {
  const LOCATION: DriveLocationOut = {
    id: "loc", kind: "channel", channel_id: "ch", user_id: null, root_id: "root", name: "m2-seminar",
    can_write: true, can_manage: true, can_share: false, external_links: true, quota_bytes: null, used_bytes: 0, item_count: 0,
  };
  const ROOT = driveItem("root", { kind: "folder", name: "", parent_id: null });
  const POSTS = driveItem("posts", { kind: "folder", name: "投稿のファイル", system_role: "channel_posts", size_bytes: null, content_type: null });
  const POSTED = driveItem("doc", { name: "修論_草稿.pdf", posted: true });
  const listing: DriveChildrenOut = { folder: ROOT, path: [{ id: "root", name: "m2-seminar" }], items: [POSTS, POSTED], next_cursor: null, shared_above: 0 };

  function browserController(api: Record<string, unknown>, link?: DriveLinkState) {
    return controllerWith({ api: { driveChildren: vi.fn(async () => listing), searchDrive: vi.fn(), ...api }, link });
  }

  it("shows 「投稿のファイル」 with its icon and in the UI language, without rename, move or trash", async () => {
    setLocale("en");
    const controller = browserController({});
    render(<DriveBrowser controller={controller} location={LOCATION} folderId="root" onFolder={vi.fn()} />);
    await screen.findByText("Posted files");
    expect(screen.queryByText("投稿のファイル")).toBeNull();
    expect(document.querySelector('[data-drive-item="posts"] [data-drive-icon="channel_posts"]')).toBeTruthy();
    fireEvent.contextMenu(document.querySelector('[data-drive-item="posts"]')!);
    const menu = await screen.findByRole("menu");
    expect(within(menu).queryByRole("menuitem", { name: /Rename/ })).toBeNull();
    expect(within(menu).queryByRole("menuitem", { name: /^Move/ })).toBeNull();
    expect(within(menu).queryByRole("menuitem", { name: /trash/i })).toBeNull();
    expect(within(menu).getByRole("menuitem", { name: /ZIP/ })).toBeTruthy();
  });

  it("keeps rename, move and trash for an ordinary file, marks a posted one and lists its posts", async () => {
    const controller = browserController({}, { state: "ok", detail: detail({ ...POSTED, posts: [{ message_id: "m9", channel_id: "ch", parent_id: "root-msg", sender_id: "u2", version_number: 1, posted_at: "2026-10-28T06:02:00Z" }] }) });
    render(<DriveBrowser controller={controller} location={LOCATION} folderId="root" onFolder={vi.fn()} />);
    await screen.findByTitle("修論_草稿.pdf");
    expect(document.querySelector('[data-drive-item="doc"] [data-drive-posted]')).toBeTruthy();
    expect(document.querySelector('[data-drive-item="posts"] [data-drive-posted]')).toBeNull();
    fireEvent.contextMenu(document.querySelector('[data-drive-item="doc"]')!);
    const menu = await screen.findByRole("menu");
    expect(within(menu).getByRole("menuitem", { name: /名前を変更/ })).toBeTruthy();
    expect(within(menu).getByRole("menuitem", { name: /ゴミ箱/ })).toBeTruthy();
    fireEvent.keyDown(menu, { key: "Escape" });
    // The details pane: 「投稿」 with 「メッセージを表示」.
    fireEvent.click(screen.getByRole("button", { name: "詳細" }));
    fireEvent.click(document.querySelector('[data-drive-check="doc"]')!);
    const posts = await waitFor(() => { const found = document.querySelector("[data-drive-post=m9]"); expect(found).toBeTruthy(); return found!; });
    expect(posts.textContent).toMatch(/三井 · .* · #m2-seminar（スレッド）/);
    fireEvent.click(screen.getByRole("button", { name: "メッセージを表示" }));
    expect(controller.openPermalink).toHaveBeenCalledWith("m9");
  });

  it("the selection bar offers no move or trash while 「投稿のファイル」 is selected", async () => {
    const controller = browserController({});
    render(<DriveBrowser controller={controller} location={LOCATION} folderId="root" onFolder={vi.fn()} />);
    await screen.findByText("投稿のファイル");
    fireEvent.click(document.querySelector('[data-drive-check="posts"]')!);
    const bar = document.querySelector("[data-drive-selection-bar]") as HTMLElement;
    expect(within(bar).queryByRole("button", { name: /移動/ })).toBeNull();
    expect(within(bar).queryByRole("button", { name: /ゴミ箱/ })).toBeNull();
    // Delete and F2 do nothing on it either.
    fireEvent.keyDown(screen.getByRole("grid"), { key: "Delete" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("asks before a trash that hides files from messages, and trashes only when confirmed", async () => {
    const driveImpact = vi.fn(async (): Promise<DriveImpactOut> => ({ posted_messages: 2, channels: [{ channel_id: "ch", messages: 2, unreadable_after: 4, unreadable_guests: 0 }] }));
    const trashDriveItems = vi.fn(async () => ({ results: [{ id: "doc", ok: true }] }));
    const controller = browserController({ driveImpact, trashDriveItems });
    render(<DriveBrowser controller={controller} location={LOCATION} folderId="root" onFolder={vi.fn()} />);
    await screen.findByTitle("修論_草稿.pdf");
    fireEvent.click(document.querySelector('[data-drive-check="doc"]')!);
    fireEvent.click(within(document.querySelector("[data-drive-selection-bar]") as HTMLElement).getByRole("button", { name: /ゴミ箱/ }));
    const dialog = await screen.findByRole("dialog");
    expect(driveImpact).toHaveBeenCalledWith(["doc"], null);
    expect(dialog.textContent).toContain("このファイルは #m2-seminar の 2 件のメッセージに付いています。");
    expect(dialog.textContent).toContain("30 日は戻せます");
    expect(trashDriveItems).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "キャンセル" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(trashDriveItems).not.toHaveBeenCalled();
    // Again (still selected), confirmed this time.
    fireEvent.click(within(document.querySelector("[data-drive-selection-bar]") as HTMLElement).getByRole("button", { name: /ゴミ箱/ }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "ゴミ箱へ" }));
    await waitFor(() => expect(trashDriveItems).toHaveBeenCalledWith(["doc"]));
  });

  it("trashes at once when no message would change (or the server cannot tell)", async () => {
    const trashDriveItems = vi.fn(async () => ({ results: [{ id: "doc", ok: true }] }));
    for (const driveImpact of [vi.fn(async () => ({ posted_messages: 0, channels: [] })), vi.fn(async () => { throw new Error("offline"); })]) {
      const controller = browserController({ driveImpact, trashDriveItems });
      render(<DriveBrowser controller={controller} location={LOCATION} folderId="root" onFolder={vi.fn()} />);
      await screen.findByTitle("修論_草稿.pdf");
      fireEvent.click(document.querySelector('[data-drive-check="doc"]')!);
      fireEvent.click(within(document.querySelector("[data-drive-selection-bar]") as HTMLElement).getByRole("button", { name: /ゴミ箱/ }));
      await waitFor(() => expect(trashDriveItems).toHaveBeenCalled());
      expect(screen.queryByRole("dialog")).toBeNull();
      trashDriveItems.mockClear();
      cleanup();
    }
  });
});

describe("the composer's line (§12.3)", () => {
  it("says where files go in a channel with the switch on, not in a DM nor with it off", () => {
    const controller = controllerWith();
    const view = render(<ComposerDriveHint controller={controller} channel={CHANNEL} shown />);
    expect(screen.getByText("ファイルは #m2-seminar のドライブ『投稿のファイル』にも保存されます")).toBeTruthy();
    view.rerender(<ComposerDriveHint controller={controller} channel={CHANNEL} shown={false} />);
    expect(document.querySelector("[data-composer-drive-hint]")).toBeNull();
    view.rerender(<ComposerDriveHint controller={controller} channel={{ ...CHANNEL, type: "dm" } as ChannelState} shown />);
    expect(document.querySelector("[data-composer-drive-hint]")).toBeNull();
    view.rerender(<ComposerDriveHint controller={controller} channel={{ ...CHANNEL, files_to_drive: false } as ChannelState} shown />);
    expect(document.querySelector("[data-composer-drive-hint]")).toBeNull();
  });
});

describe("the local cache (§16, Desktop's SQLite)", () => {
  function message(drive: AttachmentOut["drive"], updatedSeq: number): MessageOut {
    return {
      id: "m1", client_msg_id: "c1", channel_id: "ch", sender_id: "u1", seq: 5, updated_seq: updatedSeq, body: "資料です",
      created_at: "2026-10-28T06:00:00Z", edited_at: null, deleted_at: null, attachments: [{ ...FILE, drive }],
    } as unknown as MessageOut;
  }

  it("keeps `drive` with the message's row, follows message.updated, and reads it back after a restart", async () => {
    const persistence = new MemoryPersistence();
    const store = new Store(persistence);
    store.upsertMessage({ ...message({ item_id: "i1", version_id: "v1", version_number: 1, state: "available" }, 5), seq: 5 } as MessageState);
    // change = "attachments": the file went to the drive's trash (a newer updated_seq wins).
    store.upsertMessage({ ...message({ item_id: "i1", version_id: "v1", version_number: 1, state: "trashed" }, 9), seq: 5 } as MessageState);
    await store.flushPersistence();
    expect(JSON.parse(persistence.messages.get("m1")!.json).attachments[0].drive.state).toBe("trashed");
    const again = new Store(persistence);
    await again.load();
    expect(again.message("ch", "m1")!.attachments![0]!.drive).toEqual({ item_id: "i1", version_id: "v1", version_number: 1, state: "trashed" });
    // A row stored before CF1 has no `drive`: an ordinary attachment.
    expect(postedView({ ...FILE })).toBe("plain");
  });
});

describe("versions and the administrators' screen", () => {
  it("names a posted version and says why it cannot be deleted (409 drive_version_posted)", async () => {
    const versions: DriveVersionListOut = {
      keep_versions: 10,
      keep_days: 30,
      versions: [
        { id: "v2", number: 2, size_bytes: 300, source: "upload", uploaded_by: "u1", created_at: "2026-10-29T01:00:00Z", content_modified_at: null, current: true, sha256: null },
        { id: "v1", number: 1, size_bytes: 200, source: "message", uploaded_by: "u2", created_at: "2026-10-28T01:00:00Z", content_modified_at: null, current: false, sha256: null },
      ],
    };
    const deleteDriveVersion = vi.fn(async () => { throw new ApiError(409, "drive_version_posted", "posted"); });
    const controller = controllerWith({ api: { driveVersions: vi.fn(async () => versions), deleteDriveVersion } });
    render(<VersionsDialog controller={controller} item={driveItem("doc")} location={{ can_write: true, can_manage: true }} onClose={vi.fn()} onChanged={vi.fn()} />);
    await screen.findByText("バージョン 1");
    expect(document.body.textContent).toContain("チャンネルへの投稿");
    fireEvent.click(screen.getByRole("button", { name: "バージョン 1 を削除" }));
    const ask = (await screen.findAllByRole("dialog")).at(-1)!;
    fireEvent.click(within(ask).getByRole("button", { name: "削除" }));
    expect(await screen.findByText("このバージョンはメッセージに添付されているため削除できません。先にメッセージを削除してください")).toBeTruthy();
  });

  it("the workspace's switch and each location's posted files", async () => {
    const usage: DriveUsageOut = {
      total: { used_bytes: 3 * 1024 ** 3, item_count: 10, location_count: 1, current_bytes: 1, old_versions_bytes: 0, trash_bytes: 0, total_quota_bytes: null, user_default_quota_bytes: null, chat_attachments_bytes: 0, chat_attachment_count: 0 },
      locations: [{ id: "c", kind: "channel", channel_id: "ch", user_id: null, name: "m2-seminar", archived: false, used_bytes: 3 * 1024 ** 3, item_count: 10, quota_bytes: 2 * 1024 ** 3, effective_quota_bytes: 2 * 1024 ** 3, updated_at: "2026-10-21T00:00:00Z", current_bytes: 1, old_versions_bytes: 0, trash_bytes: 0, posted_bytes: 1024 ** 3 }],
      people: [],
    };
    const adminUpdateWorkspaceSettings = vi.fn(async (patch: Record<string, unknown>) => ({ channel_files_to_drive: patch.channel_files_to_drive }));
    const setWorkspaceSettings = vi.fn();
    const controller = controllerWith({
      api: {
        adminDriveUsage: vi.fn(async () => usage),
        adminDriveLinks: vi.fn(async () => ({ links: [], next_cursor: null })),
        adminDriveShareSettings: vi.fn(async () => null),
        adminWorkspaceSettings: vi.fn(async () => ({ channel_files_to_drive: true })),
        adminUpdateWorkspaceSettings,
      },
    });
    (controller.store as unknown as { setWorkspaceSettings: typeof setWorkspaceSettings }).setWorkspaceSettings = setWorkspaceSettings;
    render(<AdminDriveTab controller={controller} />);
    const toggle = await screen.findByRole("switch", { name: "チャンネルに投稿したファイルをチャンネルのドライブに保存する" });
    expect((toggle as HTMLInputElement).checked).toBe(true);
    expect(document.querySelector("[data-admin-drive-posted]")!.textContent).toContain("うち投稿のファイル 1.0 GB");
    expect(document.querySelector("[data-admin-drive-posted]")!.textContent).toContain("上限を超えています");
    fireEvent.click(toggle);
    await waitFor(() => expect(adminUpdateWorkspaceSettings).toHaveBeenCalledWith({ channel_files_to_drive: false }));
    await waitFor(() => expect(setWorkspaceSettings).toHaveBeenCalledWith(expect.objectContaining({ channel_files_to_drive: false })));
  });
});
