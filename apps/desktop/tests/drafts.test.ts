import { describe, expect, it } from "vitest";

import { Store } from "../src/sync/store";

describe("drafts list (M11h)", () => {
  it("lists the conversations with unsent text or attachments", () => {
    const store = new Store();
    store.setDraft("c1", null, { text: "hello" });
    store.setDraft("c1", "m1", { text: "a reply" });
    store.setDraft("c2", null, { text: "   " });
    expect(store.listDrafts().map((d) => [d.channelId, d.parentId, d.draft.text])).toEqual([
      ["c1", null, "hello"],
      ["c1", "m1", "a reply"],
    ]);
    store.setDraft("c1", null, { text: "" });
    expect(store.listDrafts().map((d) => d.parentId)).toEqual(["m1"]);
  });
});
