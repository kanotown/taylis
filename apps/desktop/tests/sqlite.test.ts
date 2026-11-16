import { describe, expect, it, vi } from "vitest";

import { SqlitePersistence } from "../src/platform/sqlite";

const { executed, opened, invoked } = vi.hoisted(() => ({ executed: [] as string[], opened: [] as string[], invoked: [] as Array<[string, unknown]> }));
vi.mock("@tauri-apps/plugin-sql", () => ({
  default: {
    load: async () => {
      throw new Error("the plugin's load is not in the capability");
    },
    get: (path: string) => {
      opened.push(path);
      return {
        execute: async (query: string) => {
          executed.push(query);
        },
        select: async () => [],
      };
    },
  },
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (command: string, args: { profile: string }) => {
    invoked.push([command, args]);
    return `sqlite:chikuwa-${args.profile}.db`;
  },
}));

describe("the local database (§11)", () => {
  it("is opened by the app's own command (only its profile name), never the plugin's load (2026-11-16)", async () => {
    await SqlitePersistence.open("0123456789abcdef0123456789abcdef");
    expect(invoked).toEqual([["local_store_open", { profile: "0123456789abcdef0123456789abcdef" }]]);
    expect(opened).toEqual(["sqlite:chikuwa-0123456789abcdef0123456789abcdef.db"]);
  });

  it("overwrites deleted rows in the file and shrinks it when the store is erased at sign-out (M28b)", async () => {
    executed.length = 0;
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
