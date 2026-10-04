// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { UserPublic } from "../src/api/types";
import { guardFileDrops } from "../src/platform/fileDrops";
import { Avatar } from "../src/ui/Avatar";
import { configureAvatars, noteVersions } from "../src/ui/avatars";
import { configureWorkspaceIcons, WorkspaceIcon } from "../src/ui/workspaceIcons";

const user = (id: string, version: string | null): UserPublic => ({ id, username: id, display_name: "Alice", role: "member", deactivated_at: null, created_at: "", updated_at: "", avatar_updated_at: version });
const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 0)));

afterEach(() => {
  cleanup();
  configureAvatars(null);
  configureWorkspaceIcons(null);
});

describe("no initials flashing before a picture", () => {
  it("shows a neutral tile while a picture first loads, then the picture at once on a later mount", async () => {
    configureAvatars(async () => new Blob(["png"], { type: "image/png" }), "https://a");
    noteVersions([user("u1", "v1")]);
    const first = render(<Avatar id="u1" name="Alice" />);
    expect(screen.getByTestId("avatar-loading")).toBeTruthy();
    expect(first.container.textContent).not.toContain("A");
    await settle();
    expect(first.container.querySelector("img")?.getAttribute("src")).toMatch(/^blob:/);
    first.unmount();
    const again = render(<Avatar id="u1" name="Alice" />);
    expect(again.container.querySelector("img")).toBeTruthy(); // the first render already has it
    expect(screen.queryByTestId("avatar-loading")).toBeNull();
  });

  it("shows the initials without a picture, or when it fails", async () => {
    configureAvatars(async () => {
      throw new Error("offline");
    }, "https://a");
    noteVersions([user("u1", null), user("u2", "v1")]);
    const none = render(<Avatar id="u1" name="Alice" />);
    expect(none.container.textContent).toBe("A");
    none.unmount();
    const failing = render(<Avatar id="u2" name="Bob" />);
    await settle();
    expect(failing.container.textContent).toBe("B");
    expect(failing.container.querySelector("img")).toBeNull();
  });

  it("does the same for the workspace icon", async () => {
    configureWorkspaceIcons(async () => new Blob(["png"], { type: "image/png" }));
    const first = render(<WorkspaceIcon serverUrl="https://a" version="v1" name="研究室" colorKey="a" />);
    expect(screen.getByTestId("workspace-icon-loading")).toBeTruthy();
    expect(first.container.textContent).toBe("");
    await settle();
    expect(screen.getByTestId("workspace-icon")).toBeTruthy();
    first.unmount();
    render(<WorkspaceIcon serverUrl="https://a" version="v1" name="研究室" colorKey="a" />);
    expect(screen.getByTestId("workspace-icon")).toBeTruthy();
  });
});

describe("files dropped where nothing takes them", () => {
  const dragEvent = (type: string, types: string[]) => {
    const event = new Event(type, { bubbles: true, cancelable: true }) as DragEvent;
    Object.defineProperty(event, "dataTransfer", { value: { types, dropEffect: "copy" } });
    return event;
  };

  it("are turned away (the webview would open the file in place of the app); drop zones and other drags are left alone", () => {
    const target = new EventTarget() as unknown as Window;
    guardFileDrops(target);
    const files = dragEvent("drop", ["Files"]);
    target.dispatchEvent(files);
    expect(files.defaultPrevented).toBe(true);
    const over = dragEvent("dragover", ["Files"]);
    target.dispatchEvent(over);
    expect(over.defaultPrevented).toBe(true);
    expect(over.dataTransfer?.dropEffect).toBe("none");
    const channel = dragEvent("dragover", ["application/x-chikuwa-channel"]);
    target.dispatchEvent(channel);
    expect(channel.defaultPrevented).toBe(false);
    // A drop zone (the composer) took it first: its drop effect stays.
    const taken = dragEvent("dragover", ["Files"]);
    taken.preventDefault();
    target.dispatchEvent(taken);
    expect(taken.dataTransfer?.dropEffect).toBe("copy");
  });
});
