import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import type { WorkflowField, WorkflowOut } from "../src/api/types";
import {
  cleanValues,
  defaultValue,
  findWorkflowCommand,
  keyFromLabel,
  renderPreview,
  renderWorkflow,
  runBlockedText,
  unknownPlaceholders,
  validKey,
  workflowCandidates,
  workflowDraftProblem,
} from "../src/ui/workflows";

interface Vectors {
  render: Array<{ name: string; fields: WorkflowField[]; template: string; values: Record<string, unknown>; expected: string }>;
  value_fields: WorkflowField[];
  values: Array<{ name: string; fields?: WorkflowField[]; values: Record<string, unknown>; cleaned: Record<string, unknown> | null; errors: Record<string, string> | null }>;
  keys: { valid: string[]; invalid: string[] };
  defaults: Array<{ name: string; type: WorkflowField["type"]; default: WorkflowField["default"]; today: string; me?: string; expected: unknown }>;
}

const vectors = JSON.parse(readFileSync(new URL("../../shared/workflows.json", import.meta.url), "utf8")) as Vectors;

describe("workflow rendering (apps/shared/workflows.json render)", () => {
  for (const c of vectors.render) {
    it(c.name, () => {
      const cleaned = cleanValues(c.fields, c.values);
      expect(cleaned.ok).toBe(true);
      if (cleaned.ok) expect(renderWorkflow(c.template, c.fields, cleaned.values)).toBe(c.expected);
    });
  }
});

describe("workflow values (apps/shared/workflows.json values)", () => {
  for (const c of vectors.values) {
    it(c.name, () => {
      const result = cleanValues(c.fields ?? vectors.value_fields, c.values);
      if (c.errors === null) expect(result).toEqual({ ok: true, values: c.cleaned });
      else expect(result).toEqual({ ok: false, errors: c.errors });
    });
  }
});

describe("workflow keys and defaults", () => {
  it("keys", () => {
    for (const key of vectors.keys.valid) expect(validKey(key)).toBe(true);
    for (const key of vectors.keys.invalid) expect(validKey(key)).toBe(false);
  });
  for (const c of vectors.defaults) {
    it(`default: ${c.name}`, () => {
      expect(defaultValue({ type: c.type, default: c.default }, c.today, c.me ?? null)).toEqual(c.expected);
    });
  }
  it("a key from a label", () => {
    expect(keyFromLabel("会議/雑誌名", [])).toBe("会議雑誌名");
    expect(keyFromLabel("場所 URL", [])).toBe("場所_URL");
    expect(keyFromLabel("日付", ["日付"])).toBe("日付2");
    expect(keyFromLabel("///", [])).toBe("項目");
  });
  it("the preview treats a value that does not check out yet as empty", () => {
    const fields: WorkflowField[] = [
      { key: "日付", label: "日付", type: "date", required: true, help: "", multiple: false, options: [] },
      { key: "a", label: "A", type: "text", required: false, help: "", multiple: false, options: [] },
    ];
    expect(renderPreview("{{日付}}\n本文 {{a}}", fields, { 日付: "2026-13-01", a: "x" })).toBe("本文 x");
    expect(unknownPlaceholders("{{日付}} {{ 誰 }}", ["日付"])).toEqual(["誰"]);
  });
});

function workflow(name: string, extra: Partial<WorkflowOut> = {}): WorkflowOut {
  return {
    id: name,
    name,
    emoji: null,
    description: "",
    channel_id: "c1",
    offered_channel_ids: ["c1"],
    fields: [],
    template: "x",
    enabled: true,
    created_by: "u1",
    created_at: "",
    updated_at: "",
    can_manage: false,
    can_run: true,
    run_blocked: null,
    ...extra,
  };
}

describe("the slash lookup", () => {
  const list = [workflow("ゼミ欠席報告"), workflow("Report"), workflow("学部 ゼミ案内")];
  it("/name opens a workflow whose name has no spaces; /wf name opens any", () => {
    expect(findWorkflowCommand("ゼミ欠席報告", "", list)?.name).toBe("ゼミ欠席報告");
    expect(findWorkflowCommand("report", "", list)?.name).toBe("Report");
    expect(findWorkflowCommand("report", "extra", list)).toBeNull();
    expect(findWorkflowCommand("wf", "学部  ゼミ案内", list)?.name).toBe("学部 ゼミ案内");
    expect(findWorkflowCommand("wf", "REPORT", list)?.name).toBe("Report");
    expect(findWorkflowCommand("wf", "", list)).toBeNull();
    expect(findWorkflowCommand("ない", "", list)).toBeNull();
  });
  it("candidates follow what is typed", () => {
    expect(workflowCandidates("/ゼミ", list).map((w) => w.name)).toEqual(["ゼミ欠席報告"]);
    expect(workflowCandidates("/", list).map((w) => w.name)).toEqual(["ゼミ欠席報告", "Report"]);
    expect(workflowCandidates("/wf 学部", list).map((w) => w.name)).toEqual(["学部 ゼミ案内"]);
    expect(workflowCandidates("/ゼミ 本文", list)).toEqual([]);
  });
  it("why a workflow cannot run", () => {
    expect(runBlockedText(workflow("a", { run_blocked: "not_a_member" }), "#報告")).toBe("#報告 に参加すると使えます");
    expect(runBlockedText(workflow("a"), "#報告")).toBeNull();
  });
});

describe("the editor's checks", () => {
  const field = (extra: Partial<WorkflowField>): WorkflowField => ({ key: "a", label: "A", type: "text", required: false, help: "", multiple: false, options: [], ...extra });
  it("names, target, template and fields", () => {
    expect(workflowDraftProblem({ name: "", channelId: "c", fields: [], template: "x" })).toBe("名前を入れてください");
    expect(workflowDraftProblem({ name: "a", channelId: "", fields: [], template: "x" })).toBe("送り先のチャンネルを選んでください");
    expect(workflowDraftProblem({ name: "a", channelId: "c", fields: [field({})], template: "{{b}}" })).toContain("{{b}}");
    expect(workflowDraftProblem({ name: "a", channelId: "c", fields: [field({ type: "select", options: [] })], template: "{{a}}" })).toContain("選択肢");
    expect(workflowDraftProblem({ name: "a", channelId: "c", fields: [field({}), field({ label: "B" })], template: "{{a}}" })).toBe("項目のキーが重複しています");
    expect(workflowDraftProblem({ name: "a", channelId: "c", fields: [field({ key: "a b" })], template: "x" })).toContain("キー");
    expect(workflowDraftProblem({ name: "a", channelId: "c", fields: [field({})], template: "{{a}}" })).toBeNull();
  });
});
