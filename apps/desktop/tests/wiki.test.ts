/**
 * M121 「ドキュメント」 (WIKI.md §9.1, §10, §14): the tree's order and sections, the change feed applied (removed,
 * reset), drops turned into the server's before / after ids, the hub (ETag, feed after wiki.changed, wiki.page.updated,
 * link titles, a page saved on the wiki endpoints with the canvas's loop), the sharing edits per level, and the editor's
 * `[[` and `/` helpers.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import type { WikiAccessOut } from "../src/api/types";
import { Store } from "../src/sync/store";
import { WikiHub } from "../src/sync/wiki";
import { applyChanges, buildTree, comparePages, dropTarget, rootTarget } from "../src/sync/wikiTree";
import { addGrant, changeLevel, pageRights, removeGrant, setInherit } from "../src/ui/docsAccess";
import { applySlash, insertPageLink, linkLabel, pageLinkQuery, slashItems, slashQuery } from "../src/ui/docEditor";
import { FakeWiki, item, uid } from "./wikiFixtures";

afterEach(() => vi.useRealTimers());

const map = (...pages: ReturnType<typeof item>[]) => new Map(pages.map((p) => [p.id, p]));

describe("the tree (wikiTree.ts)", () => {
  it("siblings by position in byte order, then id; roots split into 共有 and プライベート; a page whose parent is not here is a root", () => {
    const [r1, r2, r3, c1, c2, orphan] = [uid(101), uid(102), uid(103), uid(104), uid(105), uid(106)];
    const pages = map(
      item(r1, { position: "b" }),
      item(r2, { position: "B" }), // "B" < "b" in byte order (not locale order)
      item(r3, { position: "a", private: true }),
      item(c2, { parent_id: r1, position: "a" }),
      item(c1, { parent_id: r1, position: "a" }), // same position: by id
      item(orphan, { parent_id: uid(999), position: "c" }),
    );
    const tree = buildTree(pages.values());
    expect(tree.shared.map((p) => p.id)).toEqual([r2, r1, orphan]);
    expect(tree.private.map((p) => p.id)).toEqual([r3]);
    expect(tree.children.get(r1)!.map((p) => p.id)).toEqual([c1, c2]);
    expect(comparePages({ position: "a", id: "2" }, { position: "a", id: "1" })).toBeGreaterThan(0);
  });

  it("database rows and pages in the trash never show", () => {
    const tree = buildTree([item(uid(110), { kind: "row" }), item(uid(111), { deleted_at: "2026-10-07T00:00:00Z" }), item(uid(112))]);
    expect(tree.shared.map((p) => p.id)).toEqual([uid(112)]);
  });

  it("the change feed: changed pages replace, removed ones go with what was below them, unless brought back", () => {
    const [root, child, grandchild, keep, moved] = [uid(120), uid(121), uid(122), uid(123), uid(124)];
    const pages = map(item(root), item(child, { parent_id: root }), item(grandchild, { parent_id: child }), item(keep), item(moved, { parent_id: root }));
    // `root` left me (trashed, or no longer shared); `moved` stays readable on its own: the server sends it as a root.
    const next = applyChanges(pages, { pages: [item(moved, { parent_id: null, version: 2 }), item(keep, { title: "新しい題名", version: 2 })], removed: [root] });
    expect([...next.keys()].sort()).toEqual([keep, moved].sort());
    expect(next.get(keep)!.title).toBe("新しい題名");
    expect(next.get(moved)!.parent_id).toBeNull();
  });

  it("drops: above / below a page (its parent's before / after ids), inside it (after its last child), never into itself or below itself", () => {
    const [a, b, c, a1, a2] = [uid(130), uid(131), uid(132), uid(133), uid(134)];
    const pages = map(item(a, { position: "a" }), item(b, { position: "b" }), item(c, { position: "c" }), item(a1, { parent_id: a, position: "a" }), item(a2, { parent_id: a, position: "b" }));
    expect(dropTarget(pages, c, a, "before")).toEqual({ parent_id: null, before_id: a });
    expect(dropTarget(pages, c, a1, "after")).toEqual({ parent_id: a, after_id: a1 });
    expect(dropTarget(pages, b, a, "inside")).toEqual({ parent_id: a, after_id: a2 });
    expect(dropTarget(pages, a, a1, "inside")).toBeNull(); // below itself: 409 wiki_move_cycle
    expect(dropTarget(pages, a, a, "after")).toBeNull();
    expect(dropTarget(pages, b, a, "after")).toBeNull(); // already right after a
    expect(dropTarget(pages, a2, a, "inside")).toBeNull(); // already a's last child
    expect(dropTarget(pages, a1, b, "inside")).toEqual({ parent_id: b });
    expect(rootTarget(pages, a1, "shared")).toEqual({ parent_id: null, before_id: a });
  });
});

describe("the hub (sync/wiki.ts)", () => {
  function setup(options: { feedDelayMs?: number } = {}) {
    const api = new FakeWiki();
    const store = new Store();
    const notices: unknown[] = [];
    const hub = new WikiHub({ api, store, options: { debounceMs: 10, refreshDebounceMs: 5, retryDelaysMs: [10], feedDelayMs: options.feedDelayMs ?? 5, resolveDelayMs: 5 }, onNotice: (n) => notices.push(n) });
    return { api, store, hub, notices };
  }
  const settle = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

  it("bootstrap without `wiki`: a server before M120 (unsupported, nothing asked)", () => {
    const { api, hub } = setup();
    hub.applyBootstrap(undefined);
    expect(hub.state).toBe("unsupported");
    expect(hub.available).toBe(false);
    expect(api.calls).toEqual([]);
  });

  it("reads the tree once, then catches up from the feed on wiki.changed (a burst is one read); removed pages go; reset reads the tree again without the ETag", async () => {
    const { api, store, hub } = setup();
    const [a, b] = [uid(201), uid(202)];
    api.add(item(a));
    api.add(item(b));
    hub.applyBootstrap({ change_seq: 1 });
    await settle();
    expect(hub.state).toBe("ready");
    expect([...hub.pages.keys()].sort()).toEqual([a, b].sort());
    // The feed: b removed, a renamed; three events, one read.
    api.nextChanges = { pages: [item(a, { title: "改名", version: 2 })], removed: [b], cursor: 4, reset: false };
    for (const seq of [2, 3, 4]) hub.applyEvent("wiki.changed", { seq });
    await settle();
    expect(api.calls.filter((c) => c.startsWith("changes"))).toEqual(["changes 1"]);
    expect([...hub.pages.keys()]).toEqual([a]);
    expect(hub.page(a)!.title).toBe("改名");
    // An old seq does nothing; a newer one with reset reads the whole tree (no ETag).
    hub.applyEvent("wiki.changed", { seq: 3 });
    await settle();
    expect(api.calls.filter((c) => c.startsWith("changes"))).toHaveLength(1);
    api.nextChanges = { pages: [], removed: [], cursor: 9, reset: true };
    api.cursor = 9;
    hub.applyEvent("wiki.changed", { seq: 9 });
    await settle();
    expect(api.calls.at(-1)).toBe("tree -");
    expect([...hub.pages.keys()].sort()).toEqual([a, b].sort()); // the fake still has b
    // Kept for the next start (Tauri's SQLite), with the cursor and the ETag.
    await settle(600);
    expect(store.wikiTreeSnapshot()).toMatchObject({ cursor: 9, etag: '"e1"' });
  });

  it("a stored tree is read again with its ETag (304 keeps it); after that a reconnect only reads the feed", async () => {
    const { api, store } = setup();
    const a = uid(210);
    api.add(item(a));
    store.setWikiTreeSnapshot({ pages: [item(a)], cursor: 1, etag: '"e1"' });
    const hub = new WikiHub({ api, store, options: { feedDelayMs: 5 } });
    expect(hub.hasTree).toBe(true); // offline: the stored tree shows at once
    hub.applyBootstrap({ change_seq: 1 });
    await settle();
    expect(api.calls).toEqual(['tree "e1"']);
    hub.applyBootstrap({ change_seq: 3 });
    await settle();
    expect(api.calls.at(-1)).toBe("changes 1");
  });

  it("wiki.page.updated takes the title and icon (not the place), and reads an open idle page again", async () => {
    const { api, hub } = setup();
    const [parent, a] = [uid(220), uid(221)];
    api.add(item(parent));
    api.add(item(a, { parent_id: parent }), "本文");
    hub.applyBootstrap({ change_seq: 1 });
    await settle();
    const held = hub.hold(a);
    await settle();
    expect(held.saver!.text).toBe("本文");
    api.pages.set(a, { ...api.pages.get(a)!, title: "新しい", icon: "📘", version: 2 });
    api.bodies.set(a, "誰かが書いた");
    hub.applyEvent("wiki.page.updated", { page: { ...api.pages.get(a)!, parent_id: null }, change: "content" });
    await settle(60);
    expect(hub.page(a)).toMatchObject({ title: "新しい", icon: "📘", parent_id: parent });
    expect(held.saver!.text).toBe("誰かが書いた");
    held.release();
  });

  it("a page saves on the wiki endpoints after the pause (the canvas's loop); page_conflict waits for a choice", async () => {
    const { api, store, hub } = setup();
    const a = uid(230);
    api.add(item(a), "はじめ");
    hub.applyBootstrap({ change_seq: 1 });
    await settle();
    const held = hub.hold(a);
    await settle();
    const saver = held.saver!;
    saver.edit("はじめ\n追記");
    expect(saver.status).toBe("editing");
    expect(store.pendingPage(a)).toBeNull(); // nothing on the wire yet
    await settle(80);
    expect(api.calls.filter((c) => c.startsWith("save"))).toEqual([`save ${a.slice(-3)} "はじめ\\n追記"`]);
    expect(saver.status).toBe("saved");
    expect(hub.page(a)!.version).toBe(2); // the tree follows the answer
    api.conflictNext = true;
    saver.edit("はじめ\n追記\nもう一行");
    await settle(80);
    expect(saver.status).toBe("conflict");
    expect(store.pendingPage(a)).not.toBeNull(); // kept for a restart until the choice is made
    await saver.resolveConflict("ours");
    expect(saver.status).toBe("saved");
    held.release();
  });

  it("link titles: from the tree, else resolved in one batch; a page I cannot read resolves to null", async () => {
    const { api, hub } = setup();
    const [inTree, other, hidden] = [uid(240), uid(241), uid(242)];
    api.add(item(inTree, { title: "木にある" }));
    hub.applyBootstrap({ change_seq: 1 });
    await settle();
    api.pages.set(other, item(other, { title: "木にない" })); // readable but not in my tree (e.g. not loaded yet)
    expect(hub.resolve(inTree)).toMatchObject({ title: "木にある" });
    expect(hub.resolve(other)).toBeUndefined();
    expect(hub.resolve(hidden)).toBeUndefined();
    await settle();
    expect(api.calls.filter((c) => c.startsWith("resolve"))).toEqual(["resolve 2"]);
    expect(hub.resolve(other)).toMatchObject({ title: "木にない" });
    expect(hub.resolve(hidden)).toBeNull();
  });

  it("wiki.mentioned / wiki.shared reach the notice callback", () => {
    const { hub, notices } = setup();
    hub.applyEvent("wiki.shared", { page_id: "p", title: "t", level: "view", by_user_id: "u" });
    hub.applyEvent("wiki.mentioned", { page_id: "p", rev_id: "r", title: "t", by_user_id: "u" });
    expect(notices).toEqual([{ kind: "shared", data: expect.objectContaining({ level: "view" }) }, { kind: "mentioned", data: expect.objectContaining({ rev_id: "r" }) }]);
  });
});

describe("rights and sharing edits (docsAccess.ts)", () => {
  it("the level decides what shows: view reads, edit writes, full shares (not a guest)", () => {
    expect(pageRights({ my_level: "view" }, false)).toEqual({ view: true, edit: false, manage: false, share: false });
    expect(pageRights({ my_level: "edit" }, false)).toEqual({ view: true, edit: true, manage: false, share: false });
    expect(pageRights({ my_level: "full" }, false)).toEqual({ view: true, edit: true, manage: true, share: true });
    expect(pageRights({ my_level: "full" }, true).share).toBe(false);
  });

  const access: WikiAccessOut = {
    page_id: "p",
    inherit_access: true,
    my_level: "full",
    own: [{ principal_type: "user", principal_id: "u-me", level: "full" }],
    effective: [
      { principal_type: "workspace", principal_id: null, level: "edit", inherited: true, source_page_id: "parent", source_title: "親" },
      { principal_type: "user", principal_id: "u-me", level: "full", inherited: false, source_page_id: "p", source_title: null },
    ],
  };

  it("adding or raising keeps the inheritance (an own entry)", () => {
    expect(addGrant(access, { principal_type: "user", principal_id: "u-2" }, "view")).toEqual({
      inherit_access: true,
      grants: [{ principal_type: "user", principal_id: "u-me", level: "full" }, { principal_type: "user", principal_id: "u-2", level: "view" }],
    });
    expect(changeLevel(access, { principal_type: "workspace" }, "full")).toEqual({
      inherit_access: true,
      grants: [{ principal_type: "user", principal_id: "u-me", level: "full" }, { principal_type: "workspace", principal_id: null, level: "full" }],
    });
  });

  it("narrowing or removing an inherited entry stops the inheritance; everyone else keeps their access", () => {
    expect(changeLevel(access, { principal_type: "workspace", principal_id: null }, "view")).toEqual({
      inherit_access: false,
      grants: [{ principal_type: "workspace", principal_id: null, level: "view" }, { principal_type: "user", principal_id: "u-me", level: "full" }],
    });
    expect(removeGrant(access, { principal_type: "workspace", principal_id: null })).toEqual({
      inherit_access: false,
      grants: [{ principal_type: "user", principal_id: "u-me", level: "full" }],
    });
    expect(removeGrant({ ...access, own: [...access.own, { principal_type: "user", principal_id: "u-2", level: "edit" }] }, { principal_type: "user", principal_id: "u-2" }).inherit_access).toBe(true);
  });

  it("「受け継ぎを止める」 keeps everyone's access as own entries; 「親に合わせる」 keeps the own ones", () => {
    expect(setInherit(access, false)).toEqual({ inherit_access: false, grants: access.effective.map(({ principal_type, principal_id, level }) => ({ principal_type, principal_id, level })) });
    expect(setInherit({ ...access, inherit_access: false }, true)).toEqual({ inherit_access: true, grants: [{ principal_type: "user", principal_id: "u-me", level: "full" }] });
  });
});

describe("the editor's `[[` and `/` (docEditor.ts)", () => {
  const page = { id: uid(301), title: "GPU サーバの予約" };

  it("`[[` on the caret's line becomes `[title](page:<uuid>)` (brackets in a title made safe)", () => {
    const text = "手順は [[GPU";
    const q = pageLinkQuery(text, text.length)!;
    expect(q).toEqual({ start: 4, query: "GPU" });
    expect(insertPageLink({ text, start: text.length, end: text.length }, q.start, page)).toEqual({ text: `手順は [GPU サーバの予約](page:${page.id})`, start: 4 + `[GPU サーバの予約](page:${page.id})`.length, end: 4 + `[GPU サーバの予約](page:${page.id})`.length });
    expect(pageLinkQuery("[[a]] b", 7)).toBeNull();
    expect(pageLinkQuery("[[a\nb", 5)).toBeNull();
    expect(linkLabel("[draft] notes")).toBe("［draft］ notes");
    expect(linkLabel("  ")).toBe("無題");
  });

  it("`/` only at the start of a line; items filter by the label or English / romaji words", () => {
    expect(slashQuery("a\n/mi", 5)).toEqual({ start: 2, query: "mi" });
    expect(slashQuery("a /mi", 5)).toBeNull();
    expect(slashQuery("/a b", 4)).toBeNull();
    expect(slashItems("").length).toBe(15);
    expect(slashItems("table").map((i) => i.key)).toEqual(["table"]);
    expect(slashItems("見出し").map((i) => i.key)).toEqual(["h1", "h2", "h3"]);
    expect(slashItems("子").map((i) => i.key)).toEqual(["childPage"]);
  });

  it("a chosen item replaces `/query`; table, image and child page are left to the editor", () => {
    const text = "前\n/mi\n後";
    expect(applySlash({ text, start: 5, end: 5 }, 2, "h2")).toEqual({ kind: "edit", state: { text: "前\n## \n後", start: 5, end: 5 } });
    expect(applySlash({ text, start: 5, end: 5 }, 2, "code")).toEqual({ kind: "edit", state: { text: "前\n```\n\n```\n後", start: 6, end: 6 } });
    expect(applySlash({ text, start: 5, end: 5 }, 2, "pageLink").state.text).toBe("前\n[[\n後");
    expect(applySlash({ text, start: 5, end: 5 }, 2, "childPage")).toEqual({ kind: "childPage", state: { text: "前\n\n後", start: 2, end: 2 } });
  });
});
