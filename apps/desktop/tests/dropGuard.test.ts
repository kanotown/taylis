// @vitest-environment jsdom
/**
 * Drops nothing takes (platform/fileDrops.ts guardFileDrops): files from outside, and since 2026-11-16 links from
 * outside, are turned away where no drop zone or text field takes them, so the webview never loads them in place of
 * the app (the Tauri app also cancels such navigations: src-tauri/src/navigation.rs).
 */
import { afterEach, describe, expect, it } from "vitest";

import { guardFileDrops } from "../src/platform/fileDrops";

guardFileDrops(window);

afterEach(() => {
  document.body.innerHTML = "";
  window.dispatchEvent(new Event("dragend"));
});

function drop(target: Element, types: string[], kind: "dragover" | "drop" = "drop") {
  const dataTransfer = { types, dropEffect: "copy" };
  const event = new Event(kind, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
  target.dispatchEvent(event);
  return { prevented: event.defaultPrevented, dropEffect: dataTransfer.dropEffect };
}

describe("drops nothing takes", () => {
  it("a link from outside dropped on the page is refused (no navigation), shown as no drop while over it", () => {
    const row = document.body.appendChild(document.createElement("div"));
    expect(drop(row, ["text/uri-list", "text/plain"], "dragover")).toEqual({ prevented: true, dropEffect: "none" });
    expect(drop(row, ["text/uri-list", "text/plain"]).prevented).toBe(true);
  });

  it("a link over a text field or the rich editor is left to it (the field inserts the text)", () => {
    const input = document.body.appendChild(document.createElement("textarea"));
    const editor = document.body.appendChild(document.createElement("div"));
    editor.setAttribute("contenteditable", "true");
    const inner = editor.appendChild(document.createElement("p"));
    for (const target of [input, inner]) expect(drop(target, ["text/uri-list"]).prevented).toBe(false);
  });

  it("files from outside are refused as before; plain text and drags that start in the page are left alone", () => {
    const row = document.body.appendChild(document.createElement("div"));
    expect(drop(row, ["Files"]).prevented).toBe(true);
    expect(drop(row, ["text/plain"]).prevented).toBe(false);
    // A row or a link dragged inside the app: its own handlers decide while it moves.
    row.dispatchEvent(new Event("dragstart", { bubbles: true }));
    expect(drop(row, ["text/uri-list"], "dragover")).toEqual({ prevented: false, dropEffect: "copy" });
  });

  it("a drop zone that took the drop first is not second-guessed", () => {
    const zone = document.body.appendChild(document.createElement("div"));
    zone.addEventListener("drop", (event) => event.preventDefault());
    zone.addEventListener("dragover", (event) => event.preventDefault());
    const { dropEffect } = drop(zone, ["text/uri-list"], "dragover");
    expect(dropEffect).toBe("copy");
  });
});
