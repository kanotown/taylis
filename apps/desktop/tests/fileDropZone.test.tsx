// @vitest-environment jsdom
/** Drag and drop upload onto a pane (docs/PREVIEWS.md §10): the overlay's states and where the files go. */
import { act, cleanup, createEvent, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ChannelState } from "../src/sync/types";
import { composerKey, DROP_WATCHDOG_MS, FileDropPane, registerComposerFiles } from "../src/ui/FileDropZone";
import { conversationDropBlock } from "../src/ui/MainScreen";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  // A drag that started in the page ends (the module follows it across tests).
  fireEvent(window, new Event("dragend"));
});

const file = new File(["%PDF"], "a.pdf", { type: "application/pdf" });

/** A drag event carrying `types` (and `files` for a drop), as the browser sends one. */
function drag(type: "dragEnter" | "dragOver" | "dragLeave" | "drop", target: Element, types: string[] = ["Files"], files: File[] = []) {
  const dataTransfer = { types, files, dropEffect: "none" as string };
  const event = createEvent[type](target, { dataTransfer });
  Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
  fireEvent(target, event);
  return { event, dataTransfer };
}

function pane(props: Partial<Parameters<typeof FileDropPane>[0]> = {}) {
  const onUnavailable = vi.fn();
  const view = render(
    <FileDropPane enabled blocked={null} destination="#general に添付" target={composerKey("c1", null)} onUnavailable={onUnavailable} {...props}>
      <div data-testid="list"><p data-testid="row">本文</p></div>
      <textarea aria-label="入力" />
    </FileDropPane>,
  );
  const zone = document.querySelector("[data-drop-zone]")!;
  return { view, zone, onUnavailable, overlay: () => document.querySelector("[data-drop-overlay]") as HTMLElement | null };
}

describe("FileDropPane", () => {
  it("shows the frame while files are over the pane, without flicker across its children", () => {
    const { zone, overlay } = pane();
    drag("dragEnter", zone);
    expect(overlay()?.dataset["dropOverlay"]).toBe("ready");
    expect(screen.getByText("ここにドロップしてアップロード")).toBeTruthy();
    expect(screen.getByText("#general に添付")).toBeTruthy();
    // Into a child: enter on the child comes before leave from the pane; the counter keeps the frame up.
    drag("dragEnter", screen.getByTestId("row"));
    drag("dragLeave", zone);
    expect(overlay()).not.toBeNull();
    const { dataTransfer } = drag("dragOver", screen.getByTestId("row"));
    expect(dataTransfer.dropEffect).toBe("copy");
    // Out of the window.
    drag("dragLeave", screen.getByTestId("row"));
    expect(overlay()).toBeNull();
  });

  it("ignores text and links, and pictures dragged inside the app", () => {
    const { zone, overlay } = pane();
    const { event } = drag("dragEnter", zone, ["text/plain", "text/uri-list"]);
    expect(overlay()).toBeNull();
    expect(event.defaultPrevented).toBe(false); // left to whatever takes text (the composer)
    // A picture from the timeline: Chromium lists "Files" for it too, but its drag began in the page.
    fireEvent(window, new Event("dragstart"));
    drag("dragEnter", zone, ["Files", "text/uri-list"]);
    expect(overlay()).toBeNull();
    fireEvent(window, new Event("dragend"));
    drag("dragEnter", zone);
    expect(overlay()).not.toBeNull();
  });

  it("hands the dropped files to the pane's composer", () => {
    const take = vi.fn();
    const release = registerComposerFiles(composerKey("c1", null), take);
    const { zone, overlay, onUnavailable } = pane();
    drag("dragEnter", zone);
    const { event } = drag("drop", screen.getByTestId("row"), ["Files"], [file]);
    expect(event.defaultPrevented).toBe(true);
    expect(take).toHaveBeenCalledWith([file]);
    expect(overlay()).toBeNull();
    expect(onUnavailable).not.toHaveBeenCalled();
    release();
    // No composer on screen any more (it unmounted): said, not silently dropped.
    drag("dragEnter", zone);
    drag("drop", zone, ["Files"], [file]);
    expect(onUnavailable).toHaveBeenCalledTimes(1);
    expect(take).toHaveBeenCalledTimes(1);
  });

  it("looks refused where uploads are not allowed, and a drop there uploads nothing", () => {
    const take = vi.fn();
    const release = registerComposerFiles(composerKey("c1", null), take);
    const { zone, overlay } = pane({ blocked: "アーカイブされたチャンネルです" });
    drag("dragEnter", zone);
    expect(overlay()?.dataset["dropOverlay"]).toBe("blocked");
    expect(screen.getByText("ここにはアップロードできません")).toBeTruthy();
    expect(screen.getByText("アーカイブされたチャンネルです")).toBeTruthy();
    expect(drag("dragOver", zone).dataTransfer.dropEffect).toBe("none");
    const { event } = drag("drop", zone, ["Files"], [file]);
    expect(event.defaultPrevented).toBe(true); // the webview must not open the file instead
    expect(take).not.toHaveBeenCalled();
    release();
  });

  it("does nothing while another tab covers the pane", () => {
    const { zone, overlay } = pane({ enabled: false });
    drag("dragEnter", zone);
    expect(overlay()).toBeNull();
  });

  it("takes the frame down when the drag ends elsewhere or its last dragleave is lost", () => {
    vi.useFakeTimers();
    const { zone, overlay } = pane();
    drag("dragEnter", zone);
    fireEvent(window, new Event("drop"));
    expect(overlay()).toBeNull();
    drag("dragEnter", zone);
    act(() => { vi.advanceTimersByTime(DROP_WATCHDOG_MS / 2); });
    drag("dragOver", zone); // still moving over it
    act(() => { vi.advanceTimersByTime(DROP_WATCHDOG_MS / 2 + 10); });
    expect(overlay()).not.toBeNull();
    act(() => { vi.advanceTimersByTime(DROP_WATCHDOG_MS); }); // no dragover since: gone
    expect(overlay()).toBeNull();
  });

  it("two panes are two zones: only the one under the pointer lights up", () => {
    const left = vi.fn();
    const right = vi.fn();
    const releases = [registerComposerFiles(composerKey("c1", null), left), registerComposerFiles(composerKey("c1", "p1"), right)];
    render(
      <>
        <FileDropPane enabled blocked={null} destination="#general に添付" target={composerKey("c1", null)} onUnavailable={() => {}}><p>会話</p></FileDropPane>
        <FileDropPane enabled blocked={null} destination="スレッドに添付" target={composerKey("c1", "p1")} onUnavailable={() => {}}><p>スレッド</p></FileDropPane>
      </>,
    );
    const [conversation, thread] = [...document.querySelectorAll("[data-drop-zone]")];
    drag("dragEnter", thread!);
    expect(document.querySelectorAll("[data-drop-overlay]")).toHaveLength(1);
    expect(screen.getByText("スレッドに添付")).toBeTruthy();
    drag("drop", thread!, ["Files"], [file]);
    expect(right).toHaveBeenCalledWith([file]);
    expect(left).not.toHaveBeenCalled();
    expect(conversation).toBeTruthy();
    releases.forEach((release) => release());
  });
});

it("says why the conversation takes no files", () => {
  const channel = { id: "c1", type: "public", isMember: true, archived: false, posting_policy: "everyone", membership: { role: "member" } } as unknown as ChannelState;
  expect(conversationDropBlock(channel, false, false)).toBeNull();
  expect(conversationDropBlock({ ...channel, archived: true }, false, false)).toBe("アーカイブされたチャンネルです");
  expect(conversationDropBlock({ ...channel, posting_policy: "owners" } as ChannelState, false, false)).toBe("このチャンネルに投稿できるのはオーナーだけです");
  expect(conversationDropBlock({ ...channel, posting_policy: "owners" } as ChannelState, false, true)).toBeNull(); // an admin may
  expect(conversationDropBlock({ ...channel, isMember: false }, true, false)).toBe("参加していない会話です");
});
