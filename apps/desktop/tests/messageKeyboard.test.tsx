// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { focusChatRegion, messageRowKey } from "../src/ui/messageKeyboard";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it("moves between rows in the same list and never intercepts text or action controls", () => {
  const scroll = vi.fn();
  HTMLElement.prototype.scrollIntoView = scroll;
  const thread = vi.fn();
  render(<><section data-message-list>{[1, 2, 3].map((n) => <article key={n} className="message" tabIndex={0} onKeyDown={(event) => messageRowKey(event, thread)}>
    <p>row {n}</p><input aria-label={`edit ${n}`} /><div className="row-actions"><button>action {n}</button></div>
  </article>)}</section><section data-message-list><article className="message" tabIndex={0}>thread row</article></section></>);
  const rows = screen.getAllByRole("article");
  rows[0]!.focus();
  fireEvent.keyDown(rows[0]!, { key: "ArrowDown" });
  expect(document.activeElement).toBe(rows[1]);
  fireEvent.keyDown(rows[1]!, { key: "End" });
  expect(document.activeElement).toBe(rows[2]);
  fireEvent.keyDown(rows[2]!, { key: "ArrowDown" });
  expect(document.activeElement).toBe(rows[2]);
  fireEvent.keyDown(rows[2]!, { key: "Home" });
  expect(document.activeElement).toBe(rows[0]);
  fireEvent.keyDown(rows[0]!, { key: "F10", shiftKey: true });
  expect(document.activeElement).toBe(screen.getByText("action 1"));
  fireEvent.keyDown(screen.getByText("action 1"), { key: "ArrowRight" });
  expect(thread).not.toHaveBeenCalled();
  const input = screen.getByLabelText("edit 1");
  input.focus();
  fireEvent.keyDown(input, { key: "ArrowDown" });
  expect(document.activeElement).toBe(input);
  fireEvent.keyDown(rows[0]!, { key: "t", isComposing: true });
  expect(thread).not.toHaveBeenCalled();
  fireEvent.keyDown(rows[0]!, { key: "ArrowRight" });
  expect(thread).toHaveBeenCalledOnce();
  expect(scroll).toHaveBeenCalledWith({ block: "nearest" });
});

it("cycles visible regions in both directions without leaving a modal", () => {
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([{}] as unknown as DOMRectList);
  render(<><nav data-chat-focus><button>channels</button></nav><div data-chat-focus><article className="message" tabIndex={0}>message</article></div><div className="composer"><textarea aria-label="composer" /></div><div data-chat-focus style={{ visibility: "hidden" }}><button>hidden</button></div><div role="dialog"><button>modal</button></div></>);
  screen.getByText("channels").focus();
  expect(focusChatRegion(false)).toBe(true);
  expect(document.activeElement).toBe(screen.getByRole("article"));
  focusChatRegion(false);
  expect(document.activeElement).toBe(screen.getByLabelText("composer"));
  focusChatRegion(false);
  expect(document.activeElement).toBe(screen.getByText("channels"));
  focusChatRegion(true);
  expect(document.activeElement).toBe(screen.getByLabelText("composer"));
  screen.getByText("modal").focus();
  expect(focusChatRegion(false)).toBe(false);
  expect(document.activeElement).toBe(screen.getByText("modal"));
});
