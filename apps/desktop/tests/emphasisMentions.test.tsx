// @vitest-environment jsdom
/**
 * M188 (apps/shared/inline-format.json `emphasis_mentions`): a mention inside bold, italic or strike is drawn as the
 * mention (the person's card, the group's or @here), in the emphasis' style, not as the raw `<@…>`.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { GroupOut, UserMe, UserPublic } from "../src/api/types";
import type { AppController } from "../src/state/app";
import { Store } from "../src/sync/store";
import { MessageBody } from "../src/ui/MessageBody";
import { topicTokens } from "../src/ui/TopicText";

const ALICE = "00000000-0000-7000-8000-000000000001";
const BOB = "00000000-0000-7000-8000-000000000002";
const GROUP = "00000000-0000-7000-8000-00000000000a";

const person = (id: string, username: string, display_name: string): UserPublic =>
  ({ id, username, display_name, role: "member", deactivated_at: null, created_at: "", updated_at: "" }) as UserPublic;

afterEach(cleanup);

function view(body: string) {
  const store = new Store();
  const alice = person(ALICE, "alice", "Alice");
  store.setMe(alice as unknown as UserMe);
  store.upsertUser(alice);
  store.upsertUser(person(BOB, "bob.k", "Bob K"));
  const groups = new Map<string, GroupOut>([[GROUP, { id: GROUP, name: "design", description: null, member_ids: [ALICE, BOB], created_by: ALICE, created_at: "", updated_at: "", managed: false }]]);
  const controller = { store, subscribe: () => () => {}, openDmWith: vi.fn(), setUserBlocked: vi.fn() } as unknown as AppController;
  return render(<MessageBody body={body} users={store.users} groups={groups} controller={controller} />).container;
}

describe("a mention in emphasis", () => {
  it("bold: the person's card inside the <strong>, the text around it kept", () => {
    const body = view(`**確認 <@${BOB}> さん**`);
    const strong = body.querySelector("strong")!;
    expect(strong.textContent).toBe("確認 @Bob K さん");
    expect(strong.contains(screen.getByRole("button", { name: "Bob K のプロフィール" }))).toBe(true);
    expect(body.textContent).not.toContain("<@");
  });

  it("italic and strike: a group and @here as outside emphasis", () => {
    const body = view(`_<@group:${GROUP}> と <!here>_ ~~<!channel>~~`);
    const em = body.querySelector("em")!;
    expect([...em.querySelectorAll(".mention")].map((el) => el.textContent)).toEqual(["@design", "@here"]);
    expect(body.querySelector("del .mention")?.textContent).toBe("@channel");
    expect(body.textContent).not.toContain("<!");
  });

  it("emphasis without a mention renders as before, and look-alikes stay text", () => {
    const body = view("**ただの太字** **<@yamada>**");
    const [plain, lookalike] = [...body.querySelectorAll("strong")];
    expect(plain!.textContent).toBe("ただの太字");
    expect(lookalike!.textContent).toBe("<@yamada>");
    expect(body.querySelector(".mention")).toBeNull();
  });

  it("in a channel topic reads as the name", () => {
    expect(topicTokens(`**連絡は <@${BOB}> まで** _<!here>_`, (id) => (id === BOB ? "Bob K" : null))).toEqual([
      { kind: "bold", text: "連絡は @Bob K まで" },
      { kind: "text", text: " " },
      { kind: "italic", text: "@here" },
    ]);
  });
});
