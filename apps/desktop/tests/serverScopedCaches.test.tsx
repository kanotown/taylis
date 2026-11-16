// @vitest-environment jsdom
/**
 * 2026-11-16 (a hostile-server review): what this device keeps by an id a server chose is kept by server and id, so
 * one workspace's server cannot name another workspace's channel or database and reach what is kept for it: a
 * channel's workflow list (a minute in memory), the view a database opens with (localStorage), and link previews and
 * attachment details (emptied when another workspace comes on screen).
 */
import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AppController } from "../src/state/app";
import { Store } from "../src/sync/store";
import { readRemembered, remember } from "../src/ui/DatabaseView";
import { invalidateWorkflowLists, useChannelWorkflows } from "../src/ui/WorkflowViews";

afterEach(() => {
  invalidateWorkflowLists();
  localStorage.clear();
});

function workspace(server: string, name: string) {
  const channelWorkflows = vi.fn(async () => [{ id: `${name}-wf`, name, channel_id: "same-channel" }]);
  const controller = { api: { baseUrl: server, channelWorkflows }, store: { channels: new Map() } } as unknown as AppController;
  return { controller, channelWorkflows };
}

describe("caches keyed by server", () => {
  it("a channel's workflows: another server's channel with the same id is asked again, never served from the cache", async () => {
    const honest = workspace("https://a.example.com", "honest");
    const hostile = workspace("https://b.example.com", "hostile");
    const first = renderHook(() => useChannelWorkflows(hostile.controller, "same-channel"));
    await waitFor(() => expect(first.result.current?.[0]?.name).toBe("hostile"));
    const second = renderHook(() => useChannelWorkflows(honest.controller, "same-channel"));
    await waitFor(() => expect(second.result.current?.[0]?.name).toBe("honest"));
    expect(honest.channelWorkflows).toHaveBeenCalledOnce();
    // The same server again within the minute: from the cache.
    const third = renderHook(() => useChannelWorkflows(honest.controller, "same-channel"));
    expect(third.result.current?.[0]?.name).toBe("honest");
    expect(honest.channelWorkflows).toHaveBeenCalledOnce();
  });

  it("link previews (by URL) and attachment details (by id) of one workspace are not shown in another", async () => {
    const controller = new AppController();
    const sessions = (controller as unknown as { sessions: Map<string, unknown> }).sessions;
    const activate = (s: unknown) => (controller as unknown as { activate: (s: unknown) => void }).activate(s);
    const session = (serverUrl: string, title: string) => {
      const api = {
        baseUrl: serverUrl,
        serverInfo: async () => { throw new Error("offline"); },
        fetchBlob: async () => new Blob(),
        linkPreview: vi.fn(async (url: string) => ({ status: "ok", url, title, site_name: null, description: null, image_url: null })),
        getAttachment: vi.fn(async (id: string) => ({ id, filename: `${title}.pdf` })),
      };
      const value = { serverUrl, username: "bob", api, store: new Store(), engine: {} as unknown, me: null, leaving: false };
      sessions.set(serverUrl, value);
      return value;
    };
    const hostile = session("https://b.example.com", "偽のタイトル");
    const honest = session("https://a.example.com", "本物");
    activate(hostile);
    controller.linkPreview("https://github.com/x");
    await waitFor(() => expect(controller.linkPreviews.get("https://github.com/x")?.title).toBe("偽のタイトル"));
    expect((await controller.attachmentMeta("same-id"))?.filename).toBe("偽のタイトル.pdf");

    activate(honest);
    expect(controller.linkPreviews.has("https://github.com/x")).toBe(false);
    controller.linkPreview("https://github.com/x");
    await waitFor(() => expect(controller.linkPreviews.get("https://github.com/x")?.title).toBe("本物"));
    expect((await controller.attachmentMeta("same-id"))?.filename).toBe("本物.pdf");
    expect(honest.api.linkPreview).toHaveBeenCalledOnce();
  });

  it("a database's view: remembered per server; the key before 2026-11-16 is still read", () => {
    remember("https://a.example.com", "db1", "view-a");
    expect(readRemembered("https://a.example.com", "db1")).toBe("view-a");
    expect(readRemembered("https://b.example.com", "db1")).toBeNull();
    remember("https://b.example.com", "db1", "view-b");
    expect(readRemembered("https://a.example.com", "db1")).toBe("view-a");
    localStorage.setItem("wikidb:view:db2", "old-view");
    expect(readRemembered("https://a.example.com", "db2")).toBe("old-view");
    expect(localStorage.getItem("wikidb:view:db1")).toBeNull(); // never written any more
  });
});
