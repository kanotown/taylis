/** M189: `@name` as the stored token against the cases every client shares (apps/shared/mention-encode.json). */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import type { GroupOut, UserPublic } from "../src/api/types";
import { decodeMentions, encodeMentions } from "../src/ui/mentions";

interface Vectors {
  users: Array<[string, string]>;
  groups: Array<[string, string]>;
  cases: Array<{ name: string; text: string; stored: string }>;
}

const vectors = JSON.parse(readFileSync(new URL("../../shared/mention-encode.json", import.meta.url), "utf8")) as Vectors;
const users: UserPublic[] = vectors.users.map(([id, username]) => ({ id, username, display_name: username, role: "member", deactivated_at: null, created_at: "", updated_at: "" }));
const groups = vectors.groups.map(([id, name]) => ({ id, name }) as GroupOut);

describe("mention encoding (apps/shared/mention-encode.json)", () => {
  for (const c of vectors.cases) {
    it(c.name, () => {
      expect(encodeMentions(c.text, users, groups)).toBe(c.stored);
    });
  }

  it("keeps a mention in italic when an edited message is saved again", () => {
    const byId = new Map(users.map((u) => [u.id, u]));
    const groupsById = new Map(groups.map((g) => [g.id, g]));
    for (const stored of [`_確認 <@${users[0]!.id}>_`, `_<@${users[1]!.id}> 確認_`, "_全員 <!here>_", `__<@group:${groups[0]!.id}>__`]) {
      expect(encodeMentions(decodeMentions(stored, byId, groupsById), users, groups)).toBe(stored);
    }
  });
});
