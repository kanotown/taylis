// @vitest-environment jsdom
/**
 * M121 「ドキュメント」 screens (WIKI.md §4, §9.1): the sharing dialog by level (own and inherited entries, the source
 * page or 「上位のページ」, read only below full), the move dialog (gains / losses, page_last_manager), a page whose
 * ancestors I cannot read (「…」, never their titles), a view-only page, a `page:` link to a page I cannot read, the
 * tree's sections and its ＋, and the activity rows of page_mention / page_shared.
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ActivityItem, PageOut, WikiAccessOut, WikiMoveOut } from "../src/api/types";
import type { AppController } from "../src/state/app";
import { Store } from "../src/sync/store";
import { WikiHub } from "../src/sync/wiki";
import { activityHeadlineText, isShownActivity } from "../src/ui/activity";
import { COMPACT_QUERY } from "../src/ui/compact";
import { DocPage } from "../src/ui/DocPage";
import { MoveDialog, ShareDialog } from "../src/ui/DocsDialogs";
import { DocsTree } from "../src/ui/DocsTree";
import { PageLinkChip } from "../src/ui/PageLinkChip";
import { FakeWiki, item, uid } from "./wikiFixtures";

beforeEach(() => {
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: query === COMPACT_QUERY ? false : false, addEventListener: () => {}, removeEventListener: () => {} }));
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

const settle = (ms = 30) => act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });

/** A controller with only what the Docs screens use. */
function fakeController(options: { api?: Record<string, unknown>; hub?: WikiHub | null; isGuest?: boolean; store?: Store } = {}) {
  const store = options.store ?? new Store();
  store.upsertUser({ id: "u-me", username: "me", display_name: "わたし", role: "member", created_at: "", updated_at: "", deactivated_at: null });
  store.upsertUser({ id: "u-2", username: "hanako", display_name: "花子", role: "guest", created_at: "", updated_at: "", deactivated_at: null });
  const errors: unknown[] = [];
  const controller = {
    store,
    api: options.api ?? null,
    engine: options.hub ? { wiki: options.hub } : null,
    isGuest: options.isGuest ?? false,
    isAdmin: false,
    accountKey: "test",
    setError: (e: unknown) => errors.push(e),
    setNotice: () => {},
    copyPageLink: vi.fn(async () => {}),
    requestOpenPage: vi.fn(),
    attachmentMeta: async () => null,
    copyMessageText: async () => {},
  } as unknown as AppController;
  return { controller, store, errors };
}

const access = (level: "view" | "edit" | "full", sourceTitle: string | null = "研究室マニュアル"): WikiAccessOut => ({
  page_id: "p",
  inherit_access: true,
  my_level: level,
  own: [{ principal_type: "user", principal_id: "u-2", level: "view" }],
  effective: [
    { principal_type: "workspace", principal_id: null, level: "edit", inherited: true, source_page_id: sourceTitle ? "parent" : null, source_title: sourceTitle },
    { principal_type: "user", principal_id: "u-2", level: "view", inherited: false, source_page_id: "p", source_title: null },
  ],
});

describe("the sharing dialog", () => {
  it("full access: own and inherited entries (from the page they come from), levels and removal; a narrowing PUT stops the inheritance", async () => {
    const setWikiAccess = vi.fn(async (_id: string, body: unknown) => ({ ...access("full"), inherit_access: (body as { inherit_access: boolean }).inherit_access }));
    const { controller } = fakeController({ api: { wikiAccess: async () => access("full"), setWikiAccess } });
    render(<ShareDialog controller={controller} page={{ id: "p", title: "メモ", icon: null }} onClose={() => {}} />);
    await settle();
    const list = screen.getByRole("list", { name: "見られる人" });
    const everyone = within(list).getByText("ワークスペースの全員").closest("li")!;
    expect(within(everyone).getByText("「研究室マニュアル」から")).toBeTruthy();
    const guest = within(list).getByText("花子").closest("li")!;
    expect(within(guest).getByText("ゲスト")).toBeTruthy();
    expect(screen.getByText("親ページの共有を受け継いでいます")).toBeTruthy();
    fireEvent.change(screen.getByRole("combobox", { name: "ワークスペースの全員 の権限" }), { target: { value: "view" } });
    await settle();
    expect(setWikiAccess).toHaveBeenCalledWith("p", {
      inherit_access: false,
      grants: [{ principal_type: "workspace", principal_id: null, level: "view" }, { principal_type: "user", principal_id: "u-2", level: "view" }],
    });
  });

  it("an inherited entry from a page I cannot read says 「上位のページから」 (never its title)", async () => {
    const { controller } = fakeController({ api: { wikiAccess: async () => access("full", null) } });
    render(<ShareDialog controller={controller} page={{ id: "p", title: "メモ", icon: null }} onClose={() => {}} />);
    await settle();
    expect(screen.getByText("上位のページから")).toBeTruthy();
  });

  it("view or edit access (or a guest with full): read only — no adding, no level menus, no removing", async () => {
    for (const [level, guest] of [["view", false], ["edit", false], ["full", true]] as const) {
      const { controller } = fakeController({ api: { wikiAccess: async () => access(level) }, isGuest: guest });
      render(<ShareDialog controller={controller} page={{ id: "p", title: "メモ", icon: null }} onClose={() => {}} />);
      await settle();
      expect(screen.queryByRole("combobox")).toBeNull();
      expect(screen.queryByRole("textbox", { name: "共有する相手" })).toBeNull();
      expect(screen.queryByRole("button", { name: /を外す/ })).toBeNull();
      expect(screen.getByText("共有の設定を変えられるのは、フルアクセスの人だけです。")).toBeTruthy();
      cleanup();
    }
  });
});

describe("the move dialog", () => {
  const dry = (managerLost: boolean): WikiMoveOut => ({
    dry_run: true,
    page: null,
    manager_lost: managerLost,
    changes: [
      { principal_type: "workspace", principal_id: null, before: null, after: "edit" },
      { principal_type: "user", principal_id: "u-me", before: "full", after: null },
    ],
  });

  it("says who gains and who loses access; 「移動」 follows the new parent unless 「今の共有のまま」", async () => {
    const moveWikiPage = vi.fn(async () => ({ ...dry(false), dry_run: false, page: null }));
    const { controller } = fakeController({ api: { moveWikiPage } });
    render(<MoveDialog controller={controller} page={{ id: "p", title: "メモ", icon: null }} target={{ parent_id: null, before_id: "x" }} dry={dry(false)} onClose={() => {}} onMoved={() => {}} />);
    expect(within(screen.getByRole("region", { name: "見られるようになる人" })).getByText("ワークスペースの全員")).toBeTruthy();
    expect(within(screen.getByRole("region", { name: "見られなくなる人" })).getByText("わたし")).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: /今の共有のまま移動する/ }));
    fireEvent.click(screen.getByRole("button", { name: "移動" }));
    await settle();
    expect(moveWikiPage).toHaveBeenCalledWith("p", { parent_id: null, before_id: "x", after_id: null, dry_run: false, keep_access: true });
  });

  it("nobody with full access would be left (page_last_manager): only 「今の共有のまま」", () => {
    const { controller } = fakeController();
    render(<MoveDialog controller={controller} page={{ id: "p", title: "メモ", icon: null }} target={{ parent_id: null }} dry={dry(true)} onClose={() => {}} onMoved={() => {}} />);
    expect(screen.getByText(/フルアクセスの人が誰もいなくなります/)).toBeTruthy();
    expect((screen.getByRole("radio", { name: /移動先の共有に合わせる/ }) as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole("radio", { name: /今の共有のまま移動する/ }) as HTMLInputElement).checked).toBe(true);
  });
});

describe("a page", () => {
  class CrumbWiki extends FakeWiki {
    override async wikiPage(pageId: string, etag: string | null): Promise<PageOut | null> {
      const page = await super.wikiPage(pageId, etag);
      return page && { ...page, breadcrumbs: [{ id: null, title: null, icon: null, readable: false }, { id: uid(402), title: "見える親", icon: "📘", readable: true }] };
    }
  }

  async function openPage(level: "view" | "edit" | "full") {
    const api = new CrumbWiki();
    const pageId = uid(403);
    api.add(item(uid(402), { title: "見える親" }));
    api.add(item(pageId, { parent_id: uid(402), title: "子のページ", my_level: level }), "# 見出し\n本文です");
    const hub = new WikiHub({ api, store: new Store(), options: { debounceMs: 10, feedDelayMs: 5, resolveDelayMs: 5 } });
    hub.applyBootstrap({ change_seq: 1 });
    const backlinks = vi.fn(async () => []);
    const { controller } = fakeController({ hub, api: { wikiBacklinks: backlinks } });
    render(<DocPage controller={controller} pageId={pageId} onOpenPage={() => {}} onShare={() => {}} onTrash={() => {}} onAddChild={() => {}} />);
    await settle(60);
    return { api, hub };
  }

  it("breadcrumbs: an ancestor I cannot read is 「…」 with no title, no id and no link; a readable one opens", async () => {
    await openPage("full");
    const crumbs = screen.getByRole("navigation", { name: "ページの場所" });
    const hidden = crumbs.querySelector('[data-crumb="hidden"]')!;
    expect(hidden.textContent).toBe("…");
    expect(hidden.closest("button")).toBeNull();
    expect(within(crumbs).getByRole("button", { name: /見える親/ })).toBeTruthy();
    expect(crumbs.textContent).not.toMatch(/undefined|null/);
  });

  it("view access: read only (no 編集 tab, no title box), with the note", async () => {
    await openPage("view");
    expect(screen.queryByRole("tab", { name: "編集" })).toBeNull();
    expect(screen.queryByRole("textbox", { name: "ページの題名" })).toBeNull();
    expect(screen.getByText(/閲覧だけできます/)).toBeTruthy();
    expect(screen.getByRole("heading", { name: "子のページ" })).toBeTruthy();
  });

  it("edit access: 「編集」 opens the canvas editor on the page, which saves on the wiki endpoint", async () => {
    const { api } = await openPage("edit");
    fireEvent.click(screen.getByRole("tab", { name: "編集" }));
    await settle();
    const editor = screen.getByRole("textbox", { name: /キャンバスの本文/ }) as HTMLTextAreaElement;
    fireEvent.change(editor, { target: { value: "# 見出し\n本文です\n足した" } });
    await settle(80);
    expect(api.calls.some((c) => c.startsWith("save") && c.includes("足した"))).toBe(true);
    expect(document.querySelector("[data-save-state]")?.getAttribute("data-save-state")).toBe("saved");
  });
});

describe("links and the tree", () => {
  it("a page: link to a page I cannot read says 「アクセスできないページ」, not its label", async () => {
    const api = new FakeWiki();
    const hub = new WikiHub({ api, store: new Store(), options: { resolveDelayMs: 5 } });
    hub.applyBootstrap({ change_seq: 1 });
    await settle();
    const { controller } = fakeController({ hub });
    render(<PageLinkChip controller={controller} pageId={uid(501)} label="教員だけの会議メモ" />);
    await settle(40);
    expect(screen.getByText("アクセスできないページ")).toBeTruthy();
    expect(screen.queryByText("教員だけの会議メモ")).toBeNull();
  });

  it("the tree: 共有 and プライベート, ＋ for a top-level page per section and for a child; a guest gets no top-level ＋", async () => {
    const api = new FakeWiki();
    api.add(item(uid(601), { title: "マニュアル" }));
    api.add(item(uid(602), { title: "メモ", private: true }));
    api.add(item(uid(603), { title: "閲覧だけ", my_level: "view" }));
    const hub = new WikiHub({ api, store: new Store(), options: {} });
    hub.applyBootstrap({ change_seq: 1 });
    await settle();
    const onCreate = vi.fn();
    const { controller } = fakeController({ hub });
    render(<DocsTree controller={controller} selectedId={null} onOpen={() => {}} onCreate={onCreate} onMove={() => {}} onTrash={() => {}} onOpenTrash={() => {}} />);
    expect(within(screen.getByRole("region", { name: "共有" })).getAllByRole("treeitem").map((li) => li.textContent)).toEqual(["マニュアル", "閲覧だけ"]);
    expect(within(screen.getByRole("region", { name: "プライベート" })).getAllByRole("treeitem").map((li) => li.textContent)).toEqual(["メモ"]);
    fireEvent.click(screen.getByRole("button", { name: "新しいプライベートのページ" }));
    expect(onCreate).toHaveBeenCalledWith({ parentId: null, access: "private" });
    // A view-only page offers no child ＋ and cannot be dragged.
    const viewOnly = screen.getByText("閲覧だけ").closest("[data-page-row]")!;
    expect(within(viewOnly as HTMLElement).queryByRole("button", { name: "子ページを追加" })).toBeNull();
    expect((viewOnly.firstElementChild as HTMLElement).draggable).toBe(false);
    cleanup();
    const guest = fakeController({ hub, isGuest: true });
    render(<DocsTree controller={guest.controller} selectedId={null} onOpen={() => {}} onCreate={onCreate} onMove={() => {}} onTrash={() => {}} onOpenTrash={() => {}} />);
    expect(screen.queryByRole("button", { name: "新しいページ" })).toBeNull();
  });
});

describe("activity rows of Docs", () => {
  const page = { item_id: "i1", page_id: "p1", title: "研究室マニュアル", icon: null, excerpt: "…", rev_id: null, level: "view" as const };
  const base = { actor_ids: ["u-me"], at: "2026-10-07T00:00:00Z" } as unknown as ActivityItem;

  it("page_mention and page_shared show while the page comes with them (readable); their words", () => {
    const nameOf = () => "花子";
    const mention = { ...base, kind: "page_mention", page } as ActivityItem;
    const shared = { ...base, kind: "page_shared", page } as ActivityItem;
    expect(isShownActivity(mention)).toBe(true);
    expect(isShownActivity({ ...shared, page: null } as unknown as ActivityItem)).toBe(false);
    expect(activityHeadlineText(mention, nameOf)).toBe("花子 が「研究室マニュアル」であなたをメンションしました");
    expect(activityHeadlineText(shared, nameOf)).toBe("花子 が「研究室マニュアル」をあなたと共有しました");
  });
});
