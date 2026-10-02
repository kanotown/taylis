import { act, fireEvent, screen, within } from "@testing-library/react";

/** Lets Radix finish closing a menu (it hands focus back, and runs what an item opens, after a tick). */
export const tick = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

/** Opens the 「その他」 (⋯) menu of a message row's hover bar (`row`, or the only row) and returns the menu. */
export function openRowMenu(row: HTMLElement = document.body): HTMLElement {
  fireEvent.keyDown(within(row).getByRole("button", { name: "その他" }), { key: "Enter" });
  return screen.getByRole("menu");
}

/** The ⋯ menu's item labels, in order (separators left out). */
export function rowMenuLabels(row?: HTMLElement): string[] {
  const menu = openRowMenu(row);
  return within(menu).getAllByRole("menuitem").map((item) => item.getAttribute("aria-label") ?? item.textContent?.replace("Alt+クリック", "").trim() ?? "");
}

/** Chooses `name` from the row's ⋯ menu, and waits for the menu to close (and what the item opens to open). */
export async function chooseFromRowMenu(name: string, row?: HTMLElement): Promise<void> {
  const menu = openRowMenu(row);
  fireEvent.click(within(menu).getByRole("menuitem", { name }));
  await tick();
}
