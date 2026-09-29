import { describe, expect, it, vi } from "vitest";

import { SqlitePersistence } from "../src/platform/sqlite";

const { executed } = vi.hoisted(() => ({ executed: [] as string[] }));
vi.mock("@tauri-apps/plugin-sql", () => ({
  default: {
    load: async () => ({
      execute: async (query: string) => {
        executed.push(query);
      },
      select: async () => [],
    }),
  },
}));

describe("the local database (§11)", () => {
  it("overwrites deleted rows in the file and shrinks it when the store is erased at sign-out (M28b)", async () => {
    const db = await SqlitePersistence.open("profile");
    expect(executed[0]).toBe("PRAGMA secure_delete = ON"); // before the schema: every delete from here on is secure
    executed.length = 0;
    await db.deleteMessage("m1");
    expect(executed).toEqual(["DELETE FROM messages WHERE id = $1"]);
    executed.length = 0;
    await db.clearAll();
    expect(executed.slice(0, 5).every((q) => q.startsWith("DELETE FROM "))).toBe(true);
    expect(executed.at(-1)).toBe("VACUUM");
  });
});
