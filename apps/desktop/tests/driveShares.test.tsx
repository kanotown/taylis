// @vitest-environment jsdom
/**
 * M163 (docs/DRIVE.md §9, §17.4): external share links on screen — the dialog's choices (expiry presets within the
 * workspace's longest, a date, 「期限なし」 only when allowed), the request it sends, the address shown once with the
 * warning, copying it, the links' states and revoking one, the switches' messages, the listing's sign, 管理 →
 * 「ドライブ」's switches and list, and the public page `/s/<token>` (password, file, folder, ZIP, a stopped link).
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DriveItemLinksOut, DriveItemOut, DriveLinkPolicyOut, DriveShareLinkOut, ShareInfoOut, SharedChildrenOut, SharedItemOut } from "../src/api/types";
import { blockedReason, defaultChoice, downloadsLabel, expiresAt, expiryChoices, formProblem, shareUrl } from "../src/drive/shares";
import { ShareApi, tokenFromPath } from "../src/share/api";
import { previewKind, SharePage } from "../src/share/SharePage";
import type { AppController } from "../src/state/app";
import { AdminDriveLinks } from "../src/ui/AdminDriveLinks";
import { ShareLinksDialog, SharedMark } from "../src/ui/DriveShareDialog";
import { SHARE_PATH, sharePage } from "../vite.config";

const POLICY: DriveLinkPolicyOut = { enabled: true, location_enabled: true, can_share: true, max_days: 90, default_days: 7, password_required: false };

const ITEM: DriveItemOut = {
  id: "item", location_id: "loc", parent_id: "root", kind: "folder", name: "共同研究", size_bytes: null, content_type: null,
  content_modified_at: null, created_by: "me", created_at: "2026-10-01T00:00:00Z", updated_by: "me", updated_at: "2026-10-01T00:00:00Z",
  version_count: 0, file: null, link_count: 1,
};

function link(overrides: Partial<DriveShareLinkOut> = {}): DriveShareLinkOut {
  return {
    id: "l1", item_id: "item", item_name: "共同研究", item_kind: "folder", location_id: "loc", location_kind: "workspace", location_name: "研究室ドライブ",
    created_by: "me", created_by_name: "加納", created_at: "2026-10-01T00:00:00Z", expires_at: "2026-10-08T00:00:00Z", has_password: false,
    max_downloads: 20, download_count: 3, note: "〇〇大の先生", last_used_at: null, state: "active", can_edit: true, can_revoke: true,
    ...overrides,
  };
}

function controllerWith(api: Record<string, unknown>, extra: Record<string, unknown> = {}): AppController {
  return {
    api: { baseUrl: "https://chat.example.com", ...api },
    store: { me: { id: "me" }, users: new Map() },
    can: () => false,
    setError: vi.fn(),
    setNotice: vi.fn(),
    copyToClipboard: vi.fn(async () => true),
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
  window.location.hash = "";
});

describe("the dialog's rules", () => {
  it("offers presets within the longest expiry, a date, and 「期限なし」 only when there is no longest", () => {
    expect(expiryChoices({ max_days: 90 }).map((c) => (c.kind === "days" ? c.days : c.kind))).toEqual([1, 7, 30, 90, "date"]);
    expect(expiryChoices({ max_days: 14 }).map((c) => (c.kind === "days" ? c.days : c.kind))).toEqual([1, 7, 14, "date"]);
    expect(expiryChoices({ max_days: null }).map((c) => (c.kind === "days" ? c.days : c.kind))).toEqual([1, 7, 30, 90, "date", "none"]);
    expect(defaultChoice({ max_days: 90, default_days: 7 })).toEqual({ kind: "days", days: 7 });
  });

  it("turns the choice into expires_at (a date: the end of that day, never past the longest)", () => {
    const now = new Date("2026-10-21T10:00:00Z");
    expect(expiresAt({ kind: "days", days: 7 }, "", { max_days: 90 }, now)).toBe("2026-10-28T10:00:00.000Z");
    expect(expiresAt({ kind: "none" }, "", { max_days: null }, now)).toBeNull();
    expect(expiresAt({ kind: "date" }, "2026-10-20", { max_days: 90 }, now)).toBeUndefined();
    expect(expiresAt({ kind: "date" }, "2027-12-31", { max_days: 90 }, now)).toBeUndefined();
    expect(expiresAt({ kind: "date" }, "nonsense", { max_days: 90 }, now)).toBeUndefined();
    const picked = expiresAt({ kind: "date" }, "2026-11-01", { max_days: 90 }, now)!;
    expect(new Date(picked).getDate()).toBe(1);
    // The last allowed day itself is capped at exactly the longest.
    const last = expiresAt({ kind: "date" }, "2027-01-19", { max_days: 90 }, now)!;
    expect(new Date(last).getTime()).toBe(now.getTime() + 90 * 86_400_000);
  });

  it("checks the form, builds the address, says why links are off", () => {
    expect(formProblem({ usePassword: true, password: "abc", limit: "", note: "" }, { password_required: false }, "x")).toBe("パスワードは 4 文字以上にしてください");
    expect(formProblem({ usePassword: false, password: "", limit: "", note: "" }, { password_required: true }, "x")).toContain("4 文字");
    expect(formProblem({ usePassword: false, password: "", limit: "0", note: "" }, { password_required: false }, "x")).toContain("1 以上");
    expect(formProblem({ usePassword: false, password: "", limit: "2.5", note: "" }, { password_required: false }, "x")).toContain("1 以上");
    expect(formProblem({ usePassword: false, password: "", limit: "", note: "" }, { password_required: false }, undefined)).toContain("日付");
    expect(formProblem({ usePassword: false, password: "", limit: "20", note: "" }, { password_required: false }, null)).toBeNull();
    expect(shareUrl("https://chat.example.com/", "/s/abc")).toBe("https://chat.example.com/s/abc");
    expect(shareUrl("", "/s/abc", "https://web.example.com")).toBe("https://web.example.com/s/abc");
    expect(shareUrl("https://x", "https://chat.example.com/s/abc")).toBe("https://chat.example.com/s/abc");
    expect(blockedReason({ ...POLICY, enabled: false })).toBe("外部リンクは管理者が止めています。");
    expect(blockedReason({ ...POLICY, location_enabled: false })).toContain("この場所");
    expect(blockedReason({ ...POLICY, can_share: false })).toContain("ゲスト");
    expect(blockedReason(POLICY)).toBeNull();
    expect(downloadsLabel({ download_count: 3, max_downloads: 20 })).toBe("ダウンロード 3 ／ 20 回");
    expect(downloadsLabel({ download_count: 3, max_downloads: null })).toBe("ダウンロード 3 回");
  });

  it("reads the token from /s/<token> only, and the dev server serves share.html there", () => {
    expect(tokenFromPath("/s/AbC_d-0123456789abcdef")).toBe("AbC_d-0123456789abcdef");
    expect(tokenFromPath("/s/AbC_d-0123456789abcdef/")).toBe("AbC_d-0123456789abcdef");
    expect(tokenFromPath("/s/short")).toBeNull();
    expect(tokenFromPath("/s/../etc/passwd")).toBeNull();
    expect(tokenFromPath("/m/AbC_d-0123456789abcdef")).toBeNull();
    expect(SHARE_PATH.test("/s/AbC_d-0123456789abcdef?x=1")).toBe(true);
    expect(SHARE_PATH.test("/s/a/b")).toBe(false);
    const plugin = sharePage();
    const uses: ((req: { url?: string }, res: unknown, next: () => void) => void)[] = [];
    (plugin.configureServer as (server: unknown) => void)({ middlewares: { use: (fn: (typeof uses)[number]) => uses.push(fn) } });
    const req = { url: "/s/AbC_d-0123456789abcdef" };
    const next = vi.fn();
    uses[0]!(req, null, next);
    expect(req.url).toBe("/share.html");
    const other = { url: "/assets/app.js" };
    uses[0]!(other, null, next);
    expect(other.url).toBe("/assets/app.js");
    expect(next).toHaveBeenCalledTimes(2);
  });
});

describe("the share dialog", () => {
  it("makes a link, shows its address once with the warning, copies it, lists and revokes links", async () => {
    const data: DriveItemLinksOut = { links: [link(), link({ id: "l2", note: null, state: "paused", created_by: "other", created_by_name: "山田", can_edit: false })], policy: POLICY };
    const driveItemLinks = vi.fn(async () => data);
    const createDriveLink = vi.fn(async () => ({ link: link({ id: "new", has_password: true }), url: "/s/TOKEN1234567890abcdef", path: "/s/TOKEN1234567890abcdef" }));
    const revokeDriveLink = vi.fn(async () => undefined);
    const onChanged = vi.fn();
    const controller = controllerWith({ driveItemLinks, createDriveLink, revokeDriveLink });
    render(<ShareLinksDialog controller={controller} item={ITEM} onClose={vi.fn()} onChanged={onChanged} />);
    await screen.findByText("新しいリンク");
    expect((screen.getByLabelText("期限") as HTMLSelectElement).value).toBe("d7");
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["1 日", "7 日", "30 日", "90 日", "日付を指定"]);

    fireEvent.change(screen.getByLabelText("期限"), { target: { value: "d30" } });
    fireEvent.click(screen.getByLabelText("パスワードを付ける"));
    fireEvent.change(screen.getByLabelText("パスワード"), { target: { value: "secret pass" } });
    fireEvent.change(screen.getByLabelText("ダウンロードの回数の上限"), { target: { value: "20" } });
    fireEvent.change(screen.getByLabelText("誰向けか（任意）"), { target: { value: " B 先生 " } });
    const before = Date.now();
    fireEvent.click(screen.getByRole("button", { name: /リンクを作る/ }));
    await waitFor(() => expect(createDriveLink).toHaveBeenCalledTimes(1));
    const [itemId, body] = createDriveLink.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(itemId).toBe("item");
    expect(body).toMatchObject({ password: "secret pass", max_downloads: 20, note: "B 先生" });
    const days = (new Date(body.expires_at as string).getTime() - before) / 86_400_000;
    expect(days).toBeGreaterThan(29.99);
    expect(days).toBeLessThan(30.01);

    const url = (await screen.findByLabelText("リンクの URL")) as HTMLInputElement;
    expect(url.value).toBe("https://chat.example.com/s/TOKEN1234567890abcdef");
    expect(screen.getByText(/この URL は今だけ表示します/).textContent).toContain("サーバには写しを残しません");
    expect(screen.getByText(/パスワードはリンクとは別の方法/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /コピー/ }));
    await waitFor(() => expect(controller.copyToClipboard).toHaveBeenCalledWith("https://chat.example.com/s/TOKEN1234567890abcdef", "リンクをコピーしました"));
    expect(onChanged).toHaveBeenCalled();

    // The list: states, who made someone else's link, revoking after asking.
    const rows = document.querySelectorAll("[data-share-link]");
    expect([...rows].map((r) => r.getAttribute("data-share-link"))).toEqual(["active", "paused"]);
    expect(rows[0]!.textContent).toContain("〇〇大の先生");
    expect(rows[0]!.textContent).toContain("ダウンロード 3 ／ 20 回");
    expect(rows[1]!.textContent).toContain("停止中");
    expect(rows[1]!.textContent).toContain("作った人：山田");
    fireEvent.click(within(rows[0] as HTMLElement).getByRole("button", { name: "取り消す" }));
    const confirm = await screen.findByRole("dialog", { name: "リンクを取り消す" });
    fireEvent.click(within(confirm).getByRole("button", { name: "取り消す" }));
    await waitFor(() => expect(revokeDriveLink).toHaveBeenCalledWith("l1"));
    expect(controller.setNotice).toHaveBeenCalledWith("リンクを取り消しました");
  });

  it("refuses a short password and a bad limit before sending; 「期限なし」 when allowed", async () => {
    const createDriveLink = vi.fn();
    const controller = controllerWith({ driveItemLinks: vi.fn(async () => ({ links: [], policy: { ...POLICY, max_days: null, password_required: true } })), createDriveLink });
    render(<ShareLinksDialog controller={controller} item={ITEM} onClose={vi.fn()} onChanged={vi.fn()} />);
    await screen.findByText("新しいリンク");
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toContain("期限なし");
    expect((screen.getByLabelText(/パスワードを付ける/) as HTMLInputElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("パスワード"), { target: { value: "abc" } });
    fireEvent.click(screen.getByRole("button", { name: /リンクを作る/ }));
    expect((await screen.findByRole("alert")).textContent).toContain("4 文字以上");
    expect(createDriveLink).not.toHaveBeenCalled();
    expect(screen.getByText("まだリンクはありません")).toBeTruthy();
  });

  it("says only that links are off when the workspace or the location stopped them", async () => {
    const controller = controllerWith({ driveItemLinks: vi.fn(async () => ({ links: [link({ state: "paused" })], policy: { ...POLICY, enabled: false, can_share: false } })) });
    render(<ShareLinksDialog controller={controller} item={ITEM} onClose={vi.fn()} onChanged={vi.fn()} />);
    expect((await screen.findByText(/外部リンクは管理者が止めています/)).closest("[data-share-blocked]")).toBeTruthy();
    expect(document.querySelector("[data-share-form]")).toBeNull();
  });

  it("marks shared items in the listing", () => {
    render(<SharedMark count={2} />);
    expect(screen.getByLabelText("外部共有リンク 2 件")).toBeTruthy();
    cleanup();
    const { container } = render(<SharedMark count={0} />);
    expect(container.textContent).toBe("");
  });
});

describe("管理 → ドライブ: external links", () => {
  it("shows the switches, saves them, lists every link and revokes as an administrator", async () => {
    const settings = { external_links_enabled: true, link_max_days: 90, link_password_required: false, default_days: 7 };
    const updateAdminDriveShareSettings = vi.fn(async (patch: Record<string, unknown>) => ({ ...settings, ...patch }));
    const adminRevokeDriveLink = vi.fn(async () => undefined);
    const controller = controllerWith({
      adminDriveShareSettings: vi.fn(async () => settings),
      adminDriveLinks: vi.fn(async () => ({ links: [link({ item_name: "私.txt", location_kind: "user", location_name: "マイドライブ（Mia）", created_by: "mia", created_by_name: "Mia" })], next_cursor: null })),
      updateAdminDriveShareSettings,
      adminRevokeDriveLink,
    });
    render(<AdminDriveLinks controller={controller} />);
    const toggle = await screen.findByRole("switch", { name: "外部共有リンクを使えるようにする" });
    fireEvent.click(toggle);
    await waitFor(() => expect(updateAdminDriveShareSettings).toHaveBeenCalledWith({ external_links_enabled: false }));
    fireEvent.change(screen.getByLabelText("リンクの期限の最長"), { target: { value: "none" } });
    await waitFor(() => expect(updateAdminDriveShareSettings).toHaveBeenCalledWith({ link_max_days: null }));
    fireEvent.click(screen.getByRole("switch", { name: "パスワードを必須にする" }));
    await waitFor(() => expect(updateAdminDriveShareSettings).toHaveBeenCalledWith({ link_password_required: true }));
    const row = document.querySelector("[data-share-link]") as HTMLElement;
    expect(row.textContent).toContain("私.txt");
    expect(row.textContent).toContain("マイドライブ（Mia）");
    fireEvent.click(within(row).getByRole("button", { name: "取り消す" }));
    fireEvent.click(within(await screen.findByRole("dialog", { name: "リンクを取り消す" })).getByRole("button", { name: "取り消す" }));
    await waitFor(() => expect(adminRevokeDriveLink).toHaveBeenCalledWith("l1"));
    await waitFor(() => expect(document.querySelector("[data-share-link]")).toBeNull());
  });
});

// --- the public page --------------------------------------------------------------------------------------------------

function shared(id: string, kind: "file" | "folder", name: string, extra: Partial<SharedItemOut> = {}): SharedItemOut {
  return { id, kind, name, size_bytes: kind === "file" ? 1024 : null, content_type: kind === "file" ? "application/pdf" : null, modified_at: "2026-10-01T00:00:00Z", has_thumbnail: false, width: null, height: null, preview: null, ...extra };
}

function info(extra: Partial<ShareInfoOut>): ShareInfoOut {
  return { state: "active", kind: "folder", password_required: false, unlocked: true, expires_at: "2026-10-28T00:00:00Z", downloads_left: null, root_id: "f", item: shared("f", "folder", "ゼミ資料"), workspace_name: "加納研", ...extra };
}

function respond(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const TOKEN = "AbC_d-0123456789abcdefghijklmnopqrstuvwxyz0";

describe("the public page", () => {
  it("asks for the password first, then shows the folder with its ZIP and downloads", async () => {
    let unlocked = false;
    const children: SharedChildrenOut = { folder: shared("f", "folder", "ゼミ資料"), path: [{ id: "f", name: "ゼミ資料" }], items: [shared("sub", "folder", "sub"), shared("a", "file", "論文.pdf", { preview: { status: "ready", pages: 3, width: 600, height: 800 } })], next_cursor: null };
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === `/api/v1/shares/${TOKEN}/unlock`) {
        const sent = JSON.parse(String(init?.body)) as { password: string };
        if (sent.password !== "right pass") return respond(401, { error: { code: "share_password_invalid", message: "Wrong password" } });
        unlocked = true;
        return new Response(null, { status: 204 });
      }
      if (url === `/api/v1/shares/${TOKEN}`) return respond(200, unlocked ? info({ password_required: true }) : info({ password_required: true, unlocked: false, item: null, kind: null, root_id: null }));
      if (url.startsWith(`/api/v1/shares/${TOKEN}/folders/f/children`)) return respond(200, children);
      return respond(404, { error: { code: "drive_item_not_found", message: "" } });
    });
    render(<SharePage api={new ShareApi(TOKEN, fetchImpl as unknown as typeof fetch)} />);
    const field = await screen.findByLabelText("パスワード");
    expect(screen.queryByText("ゼミ資料")).toBeNull();
    fireEvent.change(field, { target: { value: "wrong" } });
    fireEvent.click(screen.getByRole("button", { name: /開く/ }));
    expect((await screen.findByRole("alert")).textContent).toBe("パスワードが違います");
    fireEvent.change(screen.getByLabelText("パスワード"), { target: { value: "right pass" } });
    fireEvent.click(screen.getByRole("button", { name: /開く/ }));
    await screen.findByText("論文.pdf");
    expect(fetchImpl.mock.calls.every(([, init]) => (init as RequestInit | undefined)?.credentials === "same-origin")).toBe(true);
    const zip = screen.getByRole("link", { name: /すべてを ZIP でダウンロード/ }) as HTMLAnchorElement;
    expect(zip.getAttribute("href")).toBe(`/api/v1/shares/${TOKEN}/zip`);
    expect(zip.hasAttribute("download")).toBe(true);
    const file = screen.getByRole("link", { name: "論文.pdf をダウンロード" });
    expect(file.getAttribute("href")).toBe(`/api/v1/shares/${TOKEN}/items/a/content`);
    expect(screen.getByRole("button", { name: "論文.pdf をプレビュー" })).toBeTruthy();
    expect(document.querySelector("[data-share-limits]")!.textContent).toContain("まで");
    // Nothing on the page names who shared it or where it lives.
    expect(document.body.textContent).not.toContain("研究室ドライブ");
    expect(document.body.textContent).toContain("加納研");
  });

  it("shows a file link with its download and the downloads left", async () => {
    const fetchImpl = vi.fn(async () => respond(200, info({ kind: "file", root_id: "x", downloads_left: 2, item: shared("x", "file", "data.csv", { content_type: "text/csv" }) })));
    render(<SharePage api={new ShareApi(TOKEN, fetchImpl as unknown as typeof fetch)} />);
    await screen.findByText("data.csv");
    expect(screen.getByRole("link", { name: /ダウンロード/ }).getAttribute("href")).toBe(`/api/v1/shares/${TOKEN}/items/x/content`);
    expect(screen.getByText(/あと 2 回ダウンロードできます/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /プレビュー/ })).toBeNull();
  });

  it("says a stopped link does not work, without saying why", async () => {
    const fetchImpl = vi.fn(async () => respond(410, { error: { code: "share_link_unavailable", message: "gone" } }));
    render(<SharePage api={new ShareApi(TOKEN, fetchImpl as unknown as typeof fetch)} />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("このリンクは使えません");
    expect(screen.queryByRole("button", { name: "再試行" })).toBeNull();
  });

  it("previews images by thumbnail and documents by their preview", () => {
    expect(previewKind(shared("a", "file", "a.pdf", { preview: { status: "ready", pages: 1, width: 1, height: 1 } }))).toBe("document");
    expect(previewKind(shared("b", "file", "b.png", { content_type: "image/png", has_thumbnail: true }))).toBe("image");
    expect(previewKind(shared("c", "file", "c.svg", { content_type: "image/svg+xml" }))).toBeNull();
    expect(previewKind(shared("d", "folder", "d"))).toBeNull();
  });
});
