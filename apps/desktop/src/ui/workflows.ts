/**
 * Workflows (M94, docs/WORKFLOWS.md): the pure parts of the form and its preview. The server renders the message that is
 * posted (server/app/modules/workflows/render.py); the preview and the form's checks follow the same rules, held to them
 * by apps/shared/workflows.json. Defaults are filled here, on the device that opens the form.
 */
import type { FieldDefault, WorkflowField, WorkflowFieldType, WorkflowOut } from "../api/types";
import { t, labelled } from "../i18n";

export type FieldValue = string | string[] | boolean;
export type Values = Record<string, FieldValue>;
export type ValueError = "required" | "invalid" | "too_long" | "not_an_option" | "user_not_found";

export const WEEKDAYS_JA = ["月", "火", "水", "木", "金", "土", "日"] as const; // 0 = Monday
export const MAX_TEXT = 200;
export const MAX_TEXTAREA = 4000;
export const MAX_USERS = 20;
export const MAX_FIELDS = 20;
export const MAX_TEMPLATE = 4000;
export const MAX_NAME = 40;
/** The menu's mark when a workflow has no emoji of its own. */
export const DEFAULT_EMOJI = "⚡";

export const FIELD_TYPES: ReadonlyArray<[WorkflowFieldType, string]> = [
  labelled("text", "workflow.type.text"),
  labelled("textarea", "workflow.type.textarea"),
  labelled("date", "workflow.type.date"),
  labelled("time", "workflow.type.time"),
  labelled("datetime", "workflow.type.datetime"),
  labelled("select", "workflow.type.select"),
  labelled("user", "workflow.type.user"),
  labelled("checkbox", "workflow.type.checkbox"),
];

export const VALUE_ERROR_TEXT: Record<ValueError, string> = {
  get required() { return t("workflow.error.required"); },
  get invalid() { return t("workflow.error.invalid"); },
  get too_long() { return t("workflow.error.tooLong"); },
  get not_an_option() { return t("workflow.error.notAnOption"); },
  get user_not_found() { return t("workflow.error.userNotFound"); },
};

const PLACEHOLDER = /\{\{\s*([^{}\s]+)\s*\}\}/gu;
const KEY = /^[\p{L}\p{N}_]{1,30}$/u;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DATETIME = /^(\d{4}-\d{2}-\d{2})T(([01]\d|2[0-3]):([0-5]\d))$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

const length = (text: string) => [...text].length;

export function validKey(key: string): boolean {
  return key === key.normalize("NFC") && KEY.test(key);
}

/** A key made from a label: its letters, digits and `_` (spaces become `_`), not one of `taken`. */
export function keyFromLabel(label: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const base = [...label.normalize("NFC").trim().replace(/\s+/gu, "_")].filter((ch) => /[\p{L}\p{N}_]/u.test(ch)).slice(0, 26).join("") || t("workflow.field");
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) if (!used.has(`${base}${n}`)) return `${base}${n}`;
}

/** The keys of `{{key}}`, in order of first appearance. */
export function placeholders(template: string): string[] {
  const keys: string[] = [];
  for (const match of template.matchAll(PLACEHOLDER)) {
    const key = match[1]!.normalize("NFC");
    if (!keys.includes(key)) keys.push(key);
  }
  return keys;
}

export function unknownPlaceholders(template: string, keys: readonly string[]): string[] {
  return placeholders(template).filter((key) => !keys.includes(key));
}

function parseDate(value: string): { y: number; m: number; d: number } | null {
  const match = DATE.exec(value);
  if (!match) return null;
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) return null;
  return { y, m, d };
}

function weekdayOf(y: number, m: number, d: number): number {
  return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7; // 0 = Monday
}

/** 「2026年7月28日 (火)」 for `YYYY-MM-DD`; "" when it is not a date. */
export function dateLabel(value: string): string {
  const day = parseDate(value);
  return day ? `${day.y}年${day.m}月${day.d}日 (${WEEKDAYS_JA[weekdayOf(day.y, day.m, day.d)]})` : "";
}

function validDatetime(value: string): boolean {
  const match = DATETIME.exec(value);
  return !!match && parseDate(match[1]!) !== null;
}

export function emptyValue(field: Pick<WorkflowField, "type">): FieldValue {
  return field.type === "user" ? [] : field.type === "checkbox" ? false : "";
}

/** The value in its stored shape, or the reason it is refused (the server's _clean_one). */
function cleanOne(field: WorkflowField, raw: unknown): FieldValue | { error: ValueError } {
  const kind = field.type;
  if (raw === undefined || raw === null) return emptyValue(field);
  if (kind === "checkbox") return typeof raw === "boolean" ? raw : { error: "invalid" };
  if (kind === "user") {
    const items = typeof raw === "string" ? [raw] : raw;
    if (!Array.isArray(items) || !items.every((i) => typeof i === "string")) return { error: "invalid" };
    const ids: string[] = [];
    for (const item of items as string[]) {
      if (!UUID.test(item)) return { error: "invalid" };
      const id = item.toLowerCase();
      if (!ids.includes(id)) ids.push(id);
    }
    if (ids.length > (field.multiple ? MAX_USERS : 1)) return { error: "too_long" };
    return ids;
  }
  if (typeof raw !== "string") return { error: "invalid" };
  let value = raw.replace(/\r\n/g, "\n").replace(CONTROL, "");
  if (kind === "text") {
    value = value.split(/\s+/u).filter(Boolean).join(" ");
    return length(value) > MAX_TEXT ? { error: "too_long" } : value;
  }
  value = value.trim();
  if (kind === "textarea") return length(value) > MAX_TEXTAREA ? { error: "too_long" } : value;
  if (!value) return "";
  if (kind === "select") return (field.options ?? []).includes(value) ? value : { error: "not_an_option" };
  if (kind === "date" && !parseDate(value)) return { error: "invalid" };
  if (kind === "time" && !TIME.test(value)) return { error: "invalid" };
  if (kind === "datetime" && !validDatetime(value)) return { error: "invalid" };
  return value;
}

export function isBlank(field: Pick<WorkflowField, "type">, value: FieldValue): boolean {
  if (field.type === "checkbox") return value !== true;
  return value === "" || (Array.isArray(value) && value.length === 0);
}

export type CleanResult = { ok: true; values: Values } | { ok: false; errors: Record<string, ValueError> };

/** Every field's value in its stored shape, or a reason per key (unknown keys included). */
export function cleanValues(fields: readonly WorkflowField[], values: Record<string, unknown>): CleanResult {
  const errors: Record<string, ValueError> = {};
  const known = new Set(fields.map((f) => f.key));
  for (const key of Object.keys(values)) if (!known.has(key)) errors[key] = "invalid";
  const cleaned: Values = {};
  for (const field of fields) {
    const value = cleanOne(field, values[field.key]);
    if (typeof value === "object" && !Array.isArray(value)) {
      errors[field.key] = value.error;
      continue;
    }
    if (field.required && isBlank(field, value)) {
      errors[field.key] = "required";
      continue;
    }
    cleaned[field.key] = value;
  }
  return Object.keys(errors).length > 0 ? { ok: false, errors } : { ok: true, values: cleaned };
}

/** A typed value cannot call anyone: `<@…` and `<!…` lose their `<`. */
export function escapeText(value: string): string {
  return value.replace(/<(?=[@!])/g, "＜");
}

export function formatValue(field: WorkflowField, value: FieldValue | undefined): string {
  if (field.type === "checkbox") return value === true ? "はい" : "いいえ";
  if (field.type === "user") return (Array.isArray(value) ? value : []).map((id) => `<@${id}>`).join(" ");
  if (!value || typeof value !== "string") return "";
  if (field.type === "date") return dateLabel(value);
  if (field.type === "datetime") {
    const match = DATETIME.exec(value);
    return match && parseDate(match[1]!) ? `${dateLabel(match[1]!)} ${match[2]}` : "";
  }
  if (field.type === "time") return value;
  return escapeText(value);
}

/**
 * Review v0.1.30 #4: `trusted[i]` says whether `text[i]` came from the template or a user field. A `<` followed by `@`,
 * `!` or `#` starts a token up to the next `>` (just those two characters when no `>` follows); when any of it was
 * typed, the `<` becomes U+FF1C, so no mention is put together from a value and its surroundings (the server's
 * `_neutralize`).
 */
function neutralize(text: string, trusted: readonly boolean[]): string {
  const chars = text.split("");
  for (let i = 0; i < chars.length - 1; i++) {
    if (chars[i] !== "<" || !"@!#".includes(chars[i + 1]!)) continue;
    const close = text.indexOf(">", i + 2);
    const end = close === -1 ? i + 1 : close;
    for (let k = i; k <= end; k++) {
      if (!trusted[k]) {
        chars[i] = "＜";
        break;
      }
    }
  }
  return chars.join("");
}

/**
 * The message body: lines whose placeholders are all empty are left out; replaced once (the server's render). Mentions
 * only from the template and user fields.
 */
export function renderWorkflow(template: string, fields: readonly WorkflowField[], values: Values): string {
  const texts = new Map(fields.map((f) => [f.key, formatValue(f, values[f.key] ?? emptyValue(f))]));
  const userKeys = new Set(fields.filter((f) => f.type === "user").map((f) => f.key));
  let out = "";
  const trusted: boolean[] = [];
  let started = false;
  const emit = (piece: string, isTrusted: boolean) => {
    out += piece;
    for (let k = 0; k < piece.length; k++) trusted.push(isTrusted);
  };
  for (const line of template.replace(/\r\n/g, "\n").split("\n")) {
    const keys = [...line.matchAll(PLACEHOLDER)].map((m) => m[1]!.normalize("NFC"));
    if (keys.length > 0 && keys.every((key) => (texts.has(key) ? texts.get(key) === "" : false))) continue;
    if (started) emit("\n", true);
    started = true;
    let at = 0;
    for (const match of line.matchAll(PLACEHOLDER)) {
      emit(line.slice(at, match.index), true);
      const key = match[1]!.normalize("NFC");
      const text = texts.get(key);
      if (text === undefined) emit(match[0], true);
      else emit(text, userKeys.has(key));
      at = match.index! + match[0].length;
    }
    emit(line.slice(at), true);
  }
  return neutralize(out, trusted).replace(/^\n+|\n+$/g, "");
}

/** The preview while the form is being filled: each field that does not check out yet counts as empty. */
export function renderPreview(template: string, fields: readonly WorkflowField[], values: Values): string {
  const cleaned: Values = {};
  for (const field of fields) {
    const value = cleanOne(field, values[field.key]);
    cleaned[field.key] = typeof value === "object" && !Array.isArray(value) ? emptyValue(field) : value;
  }
  return renderWorkflow(template, fields, cleaned);
}

function isoDay(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/** What a field starts with (WORKFLOWS.md §3.1). `today` is the device's date (`YYYY-MM-DD` or a Date). */
export function defaultValue(field: { type: WorkflowFieldType; default?: FieldDefault | null }, today: string | Date, me: string | null): FieldValue {
  const spec = field.default;
  if (!spec) return emptyValue(field);
  const day = typeof today === "string" ? today : isoDay(today);
  const withTime = (date: string) => (field.type === "datetime" ? `${date}T${spec.time ?? "09:00"}` : date);
  switch (spec.kind) {
    case "me":
      return field.type === "user" && me ? [me] : emptyValue(field);
    case "today":
      return withTime(day);
    case "next_weekday": {
      const start = parseDate(day);
      if (!start || spec.weekday === null || spec.weekday === undefined) return emptyValue(field);
      const ahead = (spec.weekday - weekdayOf(start.y, start.m, start.d) + 7) % 7;
      const date = new Date(Date.UTC(start.y, start.m - 1, start.d + ahead));
      return withTime(`${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`);
    }
    case "literal":
      if (field.type === "checkbox") return spec.value === true;
      return typeof spec.value === "string" ? spec.value : emptyValue(field);
  }
  return emptyValue(field);
}

export function initialValues(fields: readonly WorkflowField[], today: string | Date, me: string | null): Values {
  return Object.fromEntries(fields.map((field) => [field.key, defaultValue(field, today, me)]));
}

/** Example values for the editor's preview: the defaults, else a sample of each kind. */
export function sampleValues(fields: readonly WorkflowField[], today: string | Date, me: string | null): Values {
  const values = initialValues(fields, today, me);
  for (const field of fields) {
    if (!isBlank(field, values[field.key]!) || field.type === "checkbox") continue;
    const day = typeof today === "string" ? today : isoDay(today);
    values[field.key] =
      field.type === "date" ? day
      : field.type === "datetime" ? `${day}T13:00`
      : field.type === "time" ? "13:00"
      : field.type === "select" ? (field.options?.[0] ?? "")
      : field.type === "user" ? (me ? [me] : [])
      : `(${field.label})`;
  }
  return values;
}

const fold = (text: string) => text.normalize("NFC").toLowerCase();

/**
 * The workflow `/name` or `/wf name` opens: `name` is what parseSlashCommand read (lowercased), `args` what followed. A
 * name with spaces opens only through `/wf`. Null when neither names one.
 */
export function findWorkflowCommand(name: string, args: string, workflows: readonly WorkflowOut[]): WorkflowOut | null {
  if (name === "wf") {
    const wanted = fold(args.trim().replace(/\s+/gu, " "));
    return wanted ? workflows.find((w) => fold(w.name) === wanted) ?? null : null;
  }
  if (args.trim()) return null;
  return workflows.find((w) => fold(w.name) === fold(name)) ?? null;
}

/** `/` candidates: workflows whose name starts with what follows `/` (no space yet) or `/wf `. */
export function workflowCandidates(text: string, workflows: readonly WorkflowOut[]): WorkflowOut[] {
  const wf = /^\/wf\s+(.*)$/isu.exec(text);
  if (wf) {
    const prefix = fold(wf[1]!.replace(/\s+/gu, " ").trimStart());
    return workflows.filter((w) => fold(w.name).startsWith(prefix));
  }
  const match = /^\/([\p{L}\p{N}_-]*)$/u.exec(text);
  if (!match) return [];
  const prefix = fold(match[1]!);
  return workflows.filter((w) => !/\s/u.test(w.name) && fold(w.name).startsWith(prefix));
}

/** Why I cannot submit it, for the menu; null when I can. */
export function runBlockedText(workflow: Pick<WorkflowOut, "run_blocked">, target: string): string | null {
  switch (workflow.run_blocked) {
    case "disabled":
      return t("workflow.paused");
    case "archived":
      return t("workflow.blocked.archived", { target });
    case "not_a_member":
      return t("workflow.blocked.notMember", { target });
    case "posting_restricted":
      return t("workflow.blocked.postingRestricted", { target });
    default:
      return null;
  }
}

/** The editor's checks before saving (the server checks them again). */
export function workflowDraftProblem(draft: { name: string; channelId: string; fields: readonly WorkflowField[]; template: string }): string | null {
  if (!draft.name.trim()) return t("workflow.check.name");
  if (length(draft.name.trim()) > MAX_NAME) return t("workflow.check.nameTooLong", { max: MAX_NAME });
  if (!draft.channelId) return t("workflow.check.channel");
  if (!draft.template.trim()) return t("workflow.check.template");
  if (length(draft.template) > MAX_TEMPLATE) return t("workflow.check.templateTooLong", { max: MAX_TEMPLATE });
  const keys = draft.fields.map((f) => f.key);
  for (const field of draft.fields) {
    if (!validKey(field.key)) return t("workflow.check.key", { field: field.label || field.key });
    if (!field.label.trim()) return t("workflow.check.fieldName");
    if (field.type === "select") {
      const options = field.options ?? [];
      if (options.length === 0 || options.some((o) => !o.trim())) return t("workflow.check.options", { field: field.label });
      if (new Set(options).size !== options.length) return t("workflow.check.optionsDuplicate", { field: field.label });
    }
  }
  if (new Set(keys).size !== keys.length) return t("workflow.check.keysDuplicate");
  const unknown = unknownPlaceholders(draft.template, keys);
  if (unknown.length > 0) return t("workflow.check.unknownKeys", { keys: unknown.map((k) => `{{${k}}}`).join(" ") });
  return null;
}
