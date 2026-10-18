// @vitest-environment jsdom
/**
 * CALENDAR.md §11: the 「予定」 bot's line ends with the event's link `<server>/e/<id>`; on this server it is a
 * 「予定を開く」 chip that asks the main screen to open the event, and any other server's link stays a plain link.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AppController } from "../src/state/app";
import { Store } from "../src/sync/store";
import { MessageBody } from "../src/ui/MessageBody";

const EVENT = "01a14ef1-938c-730b-921c-aa35cf558502";

afterEach(cleanup);

function view(body: string) {
  const controller = { store: new Store(), subscribe: () => () => {}, requestOpenEvent: vi.fn() } as unknown as AppController;
  render(<MessageBody body={body} users={new Map()} internalBase="https://chat.example" controller={controller} />);
  return controller;
}

describe("event links", () => {
  it("opens the event from this server's link", () => {
    const controller = view(`📅 Alice さんが「ゼミ」を 10/20 (火) 13:00〜14:00 に追加しました\nhttps://chat.example/e/${EVENT}`);
    fireEvent.click(screen.getByRole("button", { name: "予定を開く" }));
    expect(controller.requestOpenEvent).toHaveBeenCalledWith(EVENT);
  });

  it("leaves another server's link alone", () => {
    view(`https://other.example/e/${EVENT}`);
    expect(screen.queryByRole("button", { name: "予定を開く" })).toBeNull();
    expect(screen.getByRole("link").getAttribute("href")).toBe(`https://other.example/e/${EVENT}`);
  });
});
