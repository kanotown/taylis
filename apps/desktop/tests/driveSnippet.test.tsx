// @vitest-environment jsdom
/**
 * docs/DRIVE.md §29: the drive search's matches inside files — the pieces the server marked, the label with the PDF
 * page, the search asked with `content`, and a name match (or an older server's answer) showing no snippet.
 */
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { DriveItemOut, DriveSearchHitOut, DriveSearchOut } from "../src/api/types";
import { matchedInside, openPage, snippetPieces } from "../src/drive/snippet";
import type { AppController } from "../src/state/app";
import { DriveResults } from "../src/ui/DriveSearch";
import { DriveSnippet } from "../src/ui/DriveSnippet";

function file(id: string, name: string): DriveItemOut {
  return {
    id, location_id: "loc", parent_id: "root", kind: "file", name, size_bytes: 40_000, content_type: "application/pdf",
    content_modified_at: null, created_by: "u1", created_at: "2026-10-01T00:00:00Z", updated_by: "u1", updated_at: "2026-10-01T09:30:00Z",
    version_count: 1, file: null, link_count: 0,
  };
}

const CONTENT_HIT: DriveSearchHitOut = {
  item: file("a", "四半期報告.pdf"),
  path: [{ id: "root", name: "研究室ドライブ" }],
  location_kind: "workspace",
  match: "content",
  snippet: [
    { text: "…共振器の", hit: false },
    { text: "品質係数", hit: true },
    { text: "は予想よりも高く…", hit: false },
  ],
  page: 2,
};

const NAME_HIT: DriveSearchHitOut = {
  item: file("b", "品質係数のメモ.txt"),
  path: [{ id: "root", name: "研究室ドライブ" }],
  location_kind: "workspace",
  match: "name",
  snippet: null,
  page: null,
};

afterEach(() => cleanup());

describe("snippet helpers", () => {
  it("reads the marked pieces and the page to open", () => {
    expect(snippetPieces(CONTENT_HIT)).toEqual([
      { text: "…共振器の", hit: false },
      { text: "品質係数", hit: true },
      { text: "は予想よりも高く…", hit: false },
    ]);
    expect(snippetPieces(NAME_HIT)).toBeNull();
    // An older server says nothing of them.
    expect(snippetPieces({} as DriveSearchHitOut)).toBeNull();
    expect(matchedInside(CONTENT_HIT)).toBe(true);
    expect(matchedInside({ match: "both" })).toBe(true);
    expect(matchedInside(NAME_HIT)).toBe(false);
    expect(openPage(CONTENT_HIT)).toBe(2);
    expect(openPage({ match: "content", page: 1 })).toBeNull(); // the first page is where it opens anyway
    expect(openPage({ match: "name", page: 3 })).toBeNull();
    expect(openPage(null)).toBeNull();
  });
});

describe("DriveSnippet", () => {
  it("marks the found words and names the page", () => {
    const { container } = render(<DriveSnippet hit={CONTENT_HIT} />);
    const marks = [...container.querySelectorAll("mark")].map((node) => node.textContent);
    expect(marks).toEqual(["品質係数"]);
    expect(container.textContent).toContain("…共振器の品質係数は予想よりも高く…");
    expect(container.textContent).toMatch(/2/);
  });

  it("shows nothing for a name match", () => {
    const { container } = render(<DriveSnippet hit={NAME_HIT} />);
    expect(container.innerHTML).toBe("");
  });

  it("never renders the text as HTML", () => {
    const { container } = render(<DriveSnippet hit={{ ...CONTENT_HIT, snippet: [{ text: "<b>x</b>", hit: true }] }} />);
    expect(container.querySelector("b")).toBeNull();
    expect(container.querySelector("mark")?.textContent).toBe("<b>x</b>");
  });
});

describe("the search screen's drive tab", () => {
  it("asks for the text inside and shows the snippets", async () => {
    const out: DriveSearchOut = { items: [NAME_HIT, CONTENT_HIT], next_cursor: null, keywords: ["品質係数"] };
    const searchDrive = vi.fn(async () => out);
    const controller = { api: { searchDrive }, engine: null, setError: vi.fn() } as unknown as AppController;
    render(<DriveResults controller={controller} q="品質係数" onShowInDrive={vi.fn()} />);
    await waitFor(() => expect(document.querySelector("[data-drive-results]")?.textContent).toContain("四半期報告"));
    expect(searchDrive).toHaveBeenCalledWith({ q: "品質係数", limit: 50, content: true });
    const snippets = document.querySelectorAll("[data-drive-snippet]");
    expect(snippets).toHaveLength(1);
    expect(snippets[0]?.querySelector("mark")?.textContent).toBe("品質係数");
  });
});
