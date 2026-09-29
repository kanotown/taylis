import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import type { TemplateOut } from "../src/api/types";
import { SyncEngine } from "../src/sync/engine";
import { Store } from "../src/sync/store";
import { appendTemplate, expandTemplate, findTemplate, nextWeekdays, orderTemplates, parseSchedule, templateCandidates, templateSummary, templateWithText } from "../src/ui/templates";
import { FakeServer } from "./fakeServer";

interface Vectors {
  expand: Array<{ name: string; today: string; input: string; output: string }>;
  schedule: Array<{ name: string; today: string; args: string; question: string; options: string[] }>;
  schedule_errors: Array<{ name: string; today: string; args: string }>;
  weekdays: Array<{ name: string; today: string; options: string[] }>;
}

const vectors = JSON.parse(readFileSync(new URL("../../shared/templates.json", import.meta.url), "utf8")) as Vectors;

/** `2026-09-28` → that local calendar day (the rules read the device's local date). */
function localDay(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y!, m! - 1, d!, 9, 30);
}

describe("template placeholders (apps/shared/templates.json expand)", () => {
  it.each(vectors.expand.map((c) => [c.name, c] as const))("%s", (_name, c) => {
    expect(expandTemplate(c.input, localDay(c.today))).toBe(c.output);
  });
});

describe("/日程 (apps/shared/templates.json schedule)", () => {
  it.each(vectors.schedule.map((c) => [c.name, c] as const))("%s", (_name, c) => {
    expect(parseSchedule(c.args, localDay(c.today))).toEqual({ question: c.question, options: c.options });
  });
  it.each(vectors.schedule_errors.map((c) => [c.name, c] as const))("refuses: %s", (_name, c) => {
    expect(parseSchedule(c.args, localDay(c.today))).toBeNull();
  });
  it.each(vectors.weekdays.map((c) => [c.name, c] as const))("/日程 alone offers the next weekdays %s", (_name, c) => {
    expect(nextWeekdays(localDay(c.today), 5)).toEqual(c.options);
  });
});

const template = (patch: Partial<TemplateOut> & Pick<TemplateOut, "id" | "name">): TemplateOut => ({
  body: `${patch.name} の本文`,
  scope: "workspace",
  owner_id: null,
  suggest_in: "any",
  position: 0,
  created_at: "2026-09-29T00:00:00Z",
  updated_at: "2026-09-29T00:00:00Z",
  ...patch,
});

describe("choosing a template (DATA_MODEL.md message_templates)", () => {
  const rows = [
    template({ id: "u1", name: "メモ", scope: "user", owner_id: "me", position: 0 }),
    template({ id: "w2", name: "週報", position: 1 }),
    template({ id: "w1", name: "日報", position: 0, suggest_in: "times" }),
    template({ id: "u2", name: "日報", scope: "user", owner_id: "me", position: 1, suggest_in: "times" }),
    template({ id: "w3", name: "b", position: 1 }),
  ];

  it("orders the workspace's then mine, by position then name; a times channel puts suggest_in=times first", () => {
    expect(orderTemplates(rows).map((t) => t.id)).toEqual(["w1", "w3", "w2", "u1", "u2"]);
    expect(orderTemplates(rows, true).map((t) => t.id)).toEqual(["w1", "u2", "w3", "w2", "u1"]);
  });

  it("finds `/name` case-insensitively, mine before the workspace's", () => {
    expect(findTemplate(rows, "日報")?.id).toBe("u2");
    expect(findTemplate(rows, "週報")?.id).toBe("w2");
    expect(findTemplate(rows, "B")?.id).toBe("w3");
    expect(findTemplate(rows, "月報")).toBeNull();
  });

  it("offers templates by the typed prefix", () => {
    const ordered = orderTemplates(rows);
    expect(templateCandidates("/", ordered)).toHaveLength(5);
    expect(templateCandidates("/日", ordered).map((t) => t.id)).toEqual(["w1", "u2"]);
    expect(templateCandidates("/日報 ", ordered)).toEqual([]);
    expect(templateCandidates("text /日", ordered)).toEqual([]);
  });

  it("inserts: the body alone into an empty input, else after a blank line; `/name text` adds the text on a new line", () => {
    expect(appendTemplate("", "本文")).toBe("本文");
    expect(appendTemplate("  \n", "本文")).toBe("本文");
    expect(appendTemplate("書きかけ\n", "本文")).toBe("書きかけ\n\n本文");
    expect(templateWithText("本文", "")).toBe("本文");
    expect(templateWithText("本文", "追記")).toBe("本文\n追記");
    expect(templateSummary("\n  \n**日報 {date}**\n- ")).toBe("**日報 {date}**");
  });

  it("loads templates from bootstrap and follows template.updated", async () => {
    const server = new FakeServer();
    const alice = server.addUser("alice");
    const bob = server.addUser("bob");
    server.createChannel("general", alice.id);
    server.templates.set("w1", template({ id: "w1", name: "日報" }));
    server.templates.set("b1", template({ id: "b1", name: "bob's", scope: "user", owner_id: bob.id }));
    const store = new Store();
    const engine = new SyncEngine(
      { api: server.apiFor(alice.id), connect: server.connectorFor(alice.id), store, getAccessToken: () => "t", sleep: async () => {} },
      { pageSize: 50 },
    );
    await engine.start();
    await engine.idle();
    expect([...store.templates.keys()]).toEqual(["w1"]); // nobody else's own templates
    const before = store.version;
    server.emitTemplate(template({ id: "w1", name: "日報", body: "新しい本文" }), false);
    await engine.idle();
    expect(store.templates.get("w1")?.body).toBe("新しい本文");
    expect(store.version).toBeGreaterThan(before); // the composer and the settings re-render
    server.emitTemplate(template({ id: "a1", name: "mine", scope: "user", owner_id: alice.id }), false);
    await engine.idle();
    expect([...store.templates.keys()].sort()).toEqual(["a1", "w1"]);
    server.emitTemplate(template({ id: "w1", name: "日報" }), true);
    await engine.idle();
    expect([...store.templates.keys()]).toEqual(["a1"]);
    engine.stop();
  });
});
