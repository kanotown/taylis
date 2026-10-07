// @vitest-environment jsdom
/** FileName: a long name's extension never shrinks; the text and title are the whole name (fileNameEllipsis.ts). */
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { FileName } from "../src/ui/FileName";

afterEach(cleanup);

describe("FileName", () => {
  it("truncates the head and keeps the tail and the extension", () => {
    const name = "研究報告書_最終版_修正済み_2026年度.pdf";
    const { container } = render(<FileName name={name} />);
    const root = container.querySelector("[data-file-name]")!;
    expect(root.textContent).toBe(name);
    expect(root.getAttribute("title")).toBe(name);
    expect(root.querySelector("[data-file-name-head]")!.className).toContain("truncate");
    const end = root.querySelector("[data-file-name-end]")!;
    expect(end.textContent).toBe("2026年度.pdf");
    expect(end.className).toContain("shrink-0");
  });

  it("truncates a name without an extension at its end", () => {
    const { container } = render(<FileName name=".env" />);
    const root = container.querySelector("[data-file-name]")!;
    expect(root.textContent).toBe(".env");
    expect(root.className).toContain("truncate");
    expect(root.querySelector("[data-file-name-end]")).toBeNull();
  });

  it("stacked: the stem on the first line, the extension on the second", () => {
    const { container } = render(<FileName name="議事録_第12回_定例ミーティング.docx" stacked />);
    const lines = container.querySelectorAll("[data-file-name] > span");
    expect([...lines].map((line) => line.textContent)).toEqual(["議事録_第12回_定例ミーティング", ".docx"]);
  });

  it("draws each part with render", () => {
    const { container } = render(<FileName name="report.pdf" render={(part) => <mark>{part}</mark>} />);
    expect([...container.querySelectorAll("mark")].map((mark) => mark.textContent)).toEqual(["report", ".pdf"]);
  });
});
