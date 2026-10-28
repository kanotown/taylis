// @vitest-environment jsdom
// 2026-10-28: a channel topic's Markdown links (as Mattermost's header), on one line; unsafe schemes are not linked.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AppController } from "../src/state/app";
import { Store } from "../src/sync/store";
import { openInternalLink, TopicText, topicHasLink, topicTokens } from "../src/ui/TopicText";

afterEach(cleanup);

const BASE = "https://chat.example.ac.jp";
const ID = "0190a0b0-c0d0-7e0f-8a0b-0c0d0e0f1a2b";

function controller() {
  return {
    store: new Store(),
    api: { baseUrl: BASE },
    openPermalink: vi.fn(async () => true),
    openCanvasLink: vi.fn(async () => true),
    openDriveLink: vi.fn(async () => true),
    requestOpenPage: vi.fn(),
    requestOpenEvent: vi.fn(),
    requestOpenLending: vi.fn(),
  } as unknown as AppController & Record<string, ReturnType<typeof vi.fn>>;
}

describe("topicTokens", () => {
  it("links [text](https://…) and bare URLs, keeps bold and code", () => {
    expect(topicTokens("議事録は [Wiki](https://wiki.example.org/a?b=1) と https://example.com/x を見る **必読** `make`")).toEqual([
      { kind: "text", text: "議事録は " },
      { kind: "link", url: "https://wiki.example.org/a?b=1", label: "Wiki" },
      { kind: "text", text: " と " },
      { kind: "link", url: "https://example.com/x" },
      { kind: "text", text: " を見る " },
      { kind: "bold", text: "必読" },
      { kind: "text", text: " " },
      { kind: "code", text: "make" },
    ]);
  });

  it("links mailto only as [text](mailto:…)", () => {
    expect(topicTokens("連絡: [加納](mailto:kano@example.ac.jp)")).toEqual([
      { kind: "text", text: "連絡: " },
      { kind: "link", url: "mailto:kano@example.ac.jp", label: "加納" },
    ]);
    expect(topicHasLink("kano@example.ac.jp")).toBe(false);
  });

  it("never links other schemes", () => {
    for (const topic of ["[x](javascript:alert(1))", "[x](data:text/html,hi)", "javascript:alert(1)", "[x](ftp://example.com)", "[x](mailto:javascript:alert(1))", "[x](vbscript:msgbox)"]) {
      expect(topicHasLink(topic), topic).toBe(false);
      expect(topicTokens(topic).every((token) => token.kind !== "link"), topic).toBe(true);
    }
  });

  it("reads mentions as names and keeps one line", () => {
    expect(topicTokens(`担当 <@${ID}>\n次回 <!here>`, (id) => (id === ID ? "加納" : null))).toEqual([{ kind: "text", text: "担当 @加納 次回 @here" }]);
  });
});

describe("TopicText", () => {
  it("renders the links; an external one opens outside, ours open in the app", () => {
    const c = controller();
    render(<TopicText controller={c} topic={`[Wiki](https://wiki.example.org) · [議事](${BASE}/m/${ID}) · [予定](${BASE}/e/${ID}) · [x](javascript:alert(1))`} />);
    const wiki = screen.getByRole("link", { name: "Wiki" });
    expect(wiki.getAttribute("href")).toBe("https://wiki.example.org");
    expect(wiki.getAttribute("target")).toBe("_blank");
    expect(wiki.getAttribute("rel")).toContain("noopener");
    expect(screen.getAllByRole("link")).toHaveLength(3); // the javascript: one is text
    expect(screen.getByText(/\[x\]\(javascript:alert\(1\)\)/)).toBeTruthy();

    fireEvent.click(screen.getByRole("link", { name: "議事" }));
    expect(c.openPermalink).toHaveBeenCalledWith(ID);
    fireEvent.click(screen.getByRole("link", { name: "予定" }));
    expect(c.requestOpenEvent).toHaveBeenCalledWith(ID);
  });

  it("routes every permalink kind of this server, and nothing of another one", () => {
    const c = controller();
    expect(openInternalLink(c, BASE, `${BASE}/c/${ID}`)).toBe(true);
    expect(c.openCanvasLink).toHaveBeenCalledWith(ID);
    expect(openInternalLink(c, BASE, `${BASE}/p/${ID}`)).toBe(true);
    expect(c.requestOpenPage).toHaveBeenCalledWith(ID);
    expect(openInternalLink(c, BASE, `${BASE}/d/${ID}`)).toBe(true);
    expect(c.openDriveLink).toHaveBeenCalledWith(ID);
    expect(openInternalLink(c, BASE, `${BASE}/eq/${ID}`)).toBe(true);
    expect(c.requestOpenLending).toHaveBeenCalledWith({ itemId: ID, loanId: null });
    expect(openInternalLink(c, BASE, `https://other.example.org/m/${ID}`)).toBe(false);
    expect(openInternalLink(c, null, `${BASE}/m/${ID}`)).toBe(false);
  });
});
