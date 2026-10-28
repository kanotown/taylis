// @vitest-environment jsdom
/**
 * M165 (docs/DRIVE.md §13): the drive in the conversations — `/d/<id>` links (recognised on this server only, the entry
 * URL), the card (readable: name, place, size, opening; unreadable: 「表示できないファイル」 and never the name), the
 * composer's 「ドライブから」 picker (link or copy, the reach warning), the draft's warning on a pasted link, and
 * 「ドライブに保存」 (the request it sends, the conversation's drive first, a refusal shown).
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "../src/api/errors";
import type { AttachmentOut, DriveItemDetailOut, DriveItemOut, DriveLocationOut } from "../src/api/types";
import { cardDetails, defaultSaveLocation, reachWarning, withoutDriveLink } from "../src/drive/conversation";
import { AppController, type DriveLinkState } from "../src/state/app";
import type { ChannelState } from "../src/sync/types";
import { DriveLinkWarning, DrivePickerDialog, SaveToDriveDialog } from "../src/ui/DriveConversation";
import { MessageBody } from "../src/ui/MessageBody";
import { messageActions } from "../src/ui/messageActions";
import { driveLink, driveLinksIn, parseDriveLink } from "../src/ui/permalink";
import { parseEntryPath } from "../src/ui/routes";

const BASE = "https://chat.example";
const ITEM_ID = "01a14ef1-938c-730b-921c-aa35cf558502";
const OTHER_ID = "01a14ef1-938c-730b-921c-aa35cf558503";

const WORKSPACE: DriveLocationOut = {
  id: "ws", kind: "workspace", channel_id: null, user_id: null, root_id: "ws-root", name: "研究室ドライブ",
  can_write: true, can_manage: false, can_share: true, external_links: true, quota_bytes: null, used_bytes: 0, item_count: 0,
};
const LAB: DriveLocationOut = { ...WORKSPACE, id: "lab", kind: "channel", channel_id: "ch-lab", root_id: "lab-root", name: "lab" };

const CHANNEL = { id: "ch-lab", type: "private", name: "lab", isMember: true, archived: false } as unknown as ChannelState;

function item(overrides: Partial<DriveItemOut> = {}): DriveItemOut {
  return {
    id: ITEM_ID, location_id: "ws", parent_id: "folder-1", kind: "file", name: "修論_最終.zip", size_bytes: 4_823_112, content_type: "application/zip",
    content_modified_at: null, created_by: "u1", created_at: "2026-10-01T00:00:00Z", updated_by: "u1", updated_at: "2026-10-01T00:00:00Z",
    version_count: 1, file: null, link_count: 0, posted: false, ...overrides,
  };
}

function detail(overrides: Partial<DriveItemOut> = {}): DriveItemDetailOut {
  return { item: item(overrides), path: [{ id: "ws-root", name: "研究室ドライブ" }, { id: "folder-1", name: "資料" }], location_kind: "workspace" };
}

function stub(extra: Record<string, unknown> = {}, api: Record<string, unknown> = {}): AppController {
  return {
    api: { baseUrl: BASE, fetchBlob: vi.fn(async () => new Blob()), ...api },
    store: { users: new Map(), me: { id: "u1" }, channels: new Map(), draft: () => ({ text: "", attachments: [] }), canvasMeta: () => null, subscribe: () => () => {}, version: 0 },
    subscribe: () => () => {},
    setError: vi.fn(),
    setNotice: vi.fn(),
    isGuest: false,
    ...extra,
  } as unknown as AppController;
}

beforeEach(() => {
  vi.stubGlobal("IntersectionObserver", class {
    observe() {}
    disconnect() {}
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("drive links", () => {
  it("are recognised on this server only, in a draft, and as the browser's entry URL", () => {
    expect(parseDriveLink(BASE, `${BASE}/d/${ITEM_ID}`)).toBe(ITEM_ID);
    expect(parseDriveLink(BASE, `${BASE}/D/${ITEM_ID.toUpperCase()}?x=1`)).toBe(ITEM_ID);
    expect(parseDriveLink(BASE, `https://other.example/d/${ITEM_ID}`)).toBeNull();
    expect(parseDriveLink(BASE, `${BASE}/d/not-an-id`)).toBeNull();
    expect(driveLink(`${BASE}/`, ITEM_ID)).toBe(`${BASE}/d/${ITEM_ID}`);
    expect(driveLinksIn(BASE, `見て ${BASE}/d/${ITEM_ID} と ${BASE}/d/${OTHER_ID}、もう一度 ${BASE}/d/${ITEM_ID} https://other.example/d/${OTHER_ID}`)).toEqual([ITEM_ID, OTHER_ID]);
    expect(parseEntryPath(`/d/${ITEM_ID}`)).toEqual({ kind: "drive", id: ITEM_ID });
    expect(withoutDriveLink(`資料です\n${BASE}/d/${ITEM_ID} \nよろしく`, BASE, ITEM_ID)).toBe("資料です\n\nよろしく");
  });

  it("asks the server once and maps 404 and the trash to the same unreadable state", async () => {
    const driveItem = vi.fn(async (id: string) => {
      if (id === "gone") throw new ApiError(404, "drive_item_not_found", "");
      if (id === "broken") throw new ApiError(500, "internal_error", "");
      return id === "trashed" ? detail({ trashed_at: "2026-10-02T00:00:00Z" }) : detail();
    });
    const self = { api: { driveItem }, driveLinks: new Map() } as unknown as AppController;
    const ask = (id: string): Promise<DriveLinkState> => AppController.prototype.driveLink.call(self, id);
    expect((await ask(ITEM_ID)).state).toBe("ok");
    await ask(ITEM_ID);
    expect(driveItem).toHaveBeenCalledTimes(1);
    expect(await ask("gone")).toEqual({ state: "unreadable" });
    expect(await ask("trashed")).toEqual({ state: "unreadable" });
    expect(await ask("broken")).toEqual({ state: "error" });
  });
});

describe("the card", () => {
  it("shows a readable item as it is now and opens it in the drive", async () => {
    const openDriveLink = vi.fn(async () => true);
    const controller = stub({ driveLink: vi.fn(async () => ({ state: "ok", detail: detail() })), openDriveLink });
    render(<MessageBody body={`これ ${BASE}/d/${ITEM_ID}`} users={new Map()} internalBase={BASE} controller={controller} />);
    const card = await waitFor(() => {
      const found = document.querySelector(`[data-drive-card="${ITEM_ID}"][data-readable="true"]`);
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    expect(card.textContent).toContain("修論_最終.zip");
    expect(card.textContent).toContain("研究室ドライブ › 資料 · 4.6 MB");
    fireEvent.click(within(card).getByTitle(`${BASE}/d/${ITEM_ID}`));
    expect(openDriveLink).toHaveBeenCalledWith(ITEM_ID);
    fireEvent.click(within(card).getByRole("button", { name: "ドライブで表示" }));
    expect(openDriveLink).toHaveBeenCalledTimes(2);
  });

  it("shows 「表示できないファイル」 to whoever cannot read it, without its name", async () => {
    const controller = stub({ driveLink: vi.fn(async () => ({ state: "unreadable" })) });
    render(<MessageBody body={`[修論_最終.zip](${BASE}/d/${ITEM_ID})`} users={new Map()} internalBase={BASE} controller={controller} />);
    const card = await waitFor(() => {
      const found = document.querySelector(`[data-drive-card="${ITEM_ID}"][data-readable="false"]`);
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    expect(card.textContent).toContain("表示できないファイル");
    expect(document.body.textContent).not.toContain("修論");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("leaves another server's /d/ link a plain link", () => {
    const controller = stub({ driveLink: vi.fn() });
    render(<MessageBody body={`https://other.example/d/${ITEM_ID}`} users={new Map()} internalBase={BASE} controller={controller} />);
    expect(screen.getByRole("link").getAttribute("href")).toBe(`https://other.example/d/${ITEM_ID}`);
    expect(controller.driveLink).not.toHaveBeenCalled();
  });

  it("names a folder and a channel's drive in the details line", () => {
    const folder: DriveItemDetailOut = { item: item({ kind: "folder", size_bytes: null }), path: [{ id: "lab-root", name: "lab" }], location_kind: "channel" };
    expect(cardDetails(folder)).toBe("#lab · フォルダ");
  });
});

describe("the reach warning", () => {
  it("says how many cannot read the item, in a channel and a DM, and nothing when everyone can", () => {
    expect(reachWarning({ readable: 4, unreadable: 3 }, { type: "public" })).toBe("このチャンネルの 3 人はこのファイルを見られません。");
    expect(reachWarning({ readable: 1, unreadable: 1 }, { type: "dm" })).toBe("この会話の 1 人はこのファイルを見られません。");
    expect(reachWarning({ readable: 5, unreadable: 0 }, { type: "public" })).toBeNull();
    expect(reachWarning(null, { type: "public" })).toBeNull();
  });

  it("warns about a pasted link above the draft; 「コピーとして送る」 and 「このまま」", async () => {
    const driveReach = vi.fn(async () => ({ readable: 2, unreadable: 3 }));
    const controller = stub({ driveReach, driveLink: vi.fn(async () => ({ state: "ok", detail: detail() })) });
    const onSendCopy = vi.fn(async () => {});
    render(<DriveLinkWarning controller={controller} channel={CHANNEL} text={`見てください ${BASE}/d/${ITEM_ID}`} onSendCopy={onSendCopy} />);
    const warning = await screen.findByRole("status");
    expect(warning.textContent).toContain("「修論_最終.zip」：このチャンネルの 3 人はこのファイルを見られません。");
    expect(driveReach).toHaveBeenCalledWith(ITEM_ID, "ch-lab");
    fireEvent.click(within(warning).getByRole("button", { name: "コピーとして送る" }));
    expect(onSendCopy).toHaveBeenCalledWith(ITEM_ID);
    fireEvent.click(within(warning).getByRole("button", { name: "このまま" }));
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("says nothing when everyone in the conversation can read the item", async () => {
    const driveReach = vi.fn(async () => ({ readable: 5, unreadable: 0 }));
    const controller = stub({ driveReach, driveLink: vi.fn(async () => ({ state: "ok", detail: detail() })) });
    render(<DriveLinkWarning controller={controller} channel={CHANNEL} text={`${BASE}/d/${ITEM_ID}`} onSendCopy={vi.fn()} />);
    await waitFor(() => expect(driveReach).toHaveBeenCalled());
    expect(screen.queryByRole("status")).toBeNull();
  });
});

describe("「ドライブから」", () => {
  function pickerApi(extra: Record<string, unknown> = {}) {
    return {
      driveLocations: vi.fn(async () => ({ locations: [WORKSPACE, LAB] })),
      driveChildren: vi.fn(async (folderId: string) => ({
        folder: item({ id: folderId, kind: "folder" }),
        path: [{ id: folderId, name: folderId === "lab-root" ? "lab" : "研究室ドライブ" }],
        items: folderId === "lab-root" ? [item({ id: "lab-file", location_id: "lab", name: "議事録.pdf" })] : [item({ id: "folder-x", kind: "folder", name: "論文", size_bytes: null }), item()],
        next_cursor: null,
      })),
      searchDrive: vi.fn(async () => ({ items: [], next_cursor: null })),
      attachDriveCopy: vi.fn(async () => ({ id: "att-copy", filename: "修論_最終.zip" }) as unknown as AttachmentOut),
      ...extra,
    };
  }

  it("opens on the conversation's own drive, warns on a pick some cannot read, and inserts its link", async () => {
    const api = pickerApi();
    const driveReach = vi.fn(async (id: string) => (id === ITEM_ID ? { readable: 2, unreadable: 1 } : { readable: 3, unreadable: 0 }));
    const onLink = vi.fn();
    render(<DrivePickerDialog controller={stub({ driveReach }, api)} channel={CHANNEL} onLink={onLink} onCopy={vi.fn()} onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: /議事録\.pdf/ }));
    await waitFor(() => expect(screen.getByText("この会話のメンバーは全員このファイルを見られます。")).toBeTruthy());
    expect(api.driveChildren).toHaveBeenCalledWith("lab-root", expect.anything());

    fireEvent.click(screen.getByRole("button", { name: "研究室ドライブ" }));
    fireEvent.click(await screen.findByRole("button", { name: /修論_最終\.zip/ }));
    const warning = await waitFor(() => {
      const found = document.querySelector('[data-drive-reach="warning"]');
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    expect(warning.textContent).toContain("このチャンネルの 1 人はこのファイルを見られません。");
    expect(warning.textContent).toContain("コピーとして送りますか？");
    fireEvent.click(screen.getByRole("button", { name: "リンクを入れる" }));
    expect(onLink).toHaveBeenCalledWith(expect.objectContaining({ id: ITEM_ID }));
  });

  it("attaches a copy of a file; a folder goes as a link only", async () => {
    const api = pickerApi();
    const onCopy = vi.fn();
    const onClose = vi.fn();
    render(<DrivePickerDialog controller={stub({ driveReach: vi.fn(async () => null) }, api)} channel={{ ...CHANNEL, id: "ch-other" } as ChannelState} onLink={vi.fn()} onCopy={onCopy} onClose={onClose} />);
    fireEvent.click(await screen.findByRole("button", { name: /^論文$/ }));
    expect((screen.getByRole("button", { name: "コピーを添付" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: /修論_最終\.zip/ }));
    fireEvent.click(screen.getByRole("button", { name: "コピーを添付" }));
    await waitFor(() => expect(onCopy).toHaveBeenCalledWith(expect.objectContaining({ id: "att-copy" })));
    expect(api.attachDriveCopy).toHaveBeenCalledWith(ITEM_ID);
    expect(onClose).toHaveBeenCalled();
  });
});

describe("「ドライブに保存」", () => {
  const ATTACHMENT = { id: "att-1", filename: "議事録.txt", size_bytes: 7, status: "attached" } as unknown as AttachmentOut;

  function saveApi(extra: Record<string, unknown> = {}) {
    return {
      resolveDriveLocation: vi.fn(async () => LAB),
      driveLocations: vi.fn(async () => ({ locations: [WORKSPACE, LAB] })),
      driveChildren: vi.fn(async (folderId: string) => ({ folder: item({ id: folderId, kind: "folder" }), path: [{ id: folderId, name: "lab" }], items: [], next_cursor: null })),
      saveAttachmentToDrive: vi.fn(async (_body: unknown) => item({ id: "saved" })),
      ...extra,
    };
  }

  it("saves into the conversation's drive with an op id, a new name, and says where", async () => {
    const api = saveApi();
    const controller = stub({ requestShowInDrive: vi.fn() }, api);
    const onClose = vi.fn();
    render(<SaveToDriveDialog controller={controller} attachments={[ATTACHMENT]} channel={CHANNEL} onClose={onClose} />);
    await screen.findByText("保存先：#lab");
    expect(api.resolveDriveLocation).toHaveBeenCalledWith({ kind: "channel", channel_id: "ch-lab" });
    fireEvent.change(screen.getByRole("textbox", { name: "ファイル名" }), { target: { value: "第3回.txt" } });
    fireEvent.click(screen.getByRole("button", { name: /ここに保存/ }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const body = api.saveAttachmentToDrive.mock.calls[0]![0] as unknown as Record<string, unknown>;
    expect(body).toMatchObject({ attachment_id: "att-1", folder_id: "lab-root", name: "第3回.txt", on_conflict: "rename" });
    expect(typeof body.client_op_id).toBe("string");
    expect(controller.setNotice).toHaveBeenCalledWith("1 件を #lab に保存しました", expect.objectContaining({ label: "表示" }));
  });

  it("shows the server's refusal and stays open (a folder I cannot write)", async () => {
    const api = saveApi({ saveAttachmentToDrive: vi.fn(async () => { throw new ApiError(403, "drive_read_only", ""); }) });
    const onClose = vi.fn();
    render(<SaveToDriveDialog controller={stub({}, api)} attachments={[ATTACHMENT]} channel={CHANNEL} onClose={onClose} />);
    await waitFor(() => expect(api.driveChildren).toHaveBeenCalled());
    await waitFor(() => expect((screen.getByRole("button", { name: /ここに保存/ }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: /ここに保存/ }));
    expect((await screen.findByRole("alert")).textContent).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("starts in the conversation's drive, else マイドライブ, else the first one I can write", () => {
    const mine: DriveLocationOut = { ...WORKSPACE, id: "me", kind: "user", root_id: "me-root", name: "マイドライブ" };
    expect(defaultSaveLocation([WORKSPACE, LAB, mine], "ch-lab")?.id).toBe("lab");
    expect(defaultSaveLocation([WORKSPACE, LAB, mine], "ch-dm")?.id).toBe("me");
    expect(defaultSaveLocation([{ ...WORKSPACE, can_write: false }, { ...LAB, can_write: false }], "ch-lab")).toBeNull();
  });

  it("is a message action only while the message has stored attachments", () => {
    const message = { id: "m", body: "x", reactions: [], pending: false, deleted: false, seq: 1 } as never;
    const base = { message, mine: true, isAdmin: false, saved: false, thread: true, editable: true, showReactions: true, canMakeTask: false, canRequestReview: false, unreadOffered: false };
    expect(messageActions({ ...base, canSaveToDrive: true }).map((a) => a.key)).toContain("saveToDrive");
    expect(messageActions(base).map((a) => a.key)).not.toContain("saveToDrive");
  });
});
