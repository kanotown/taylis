/**
 * M170 (docs/LENDING.md §12.2): 「備品」's pure rules — the workspace's dates, the list's filters and order, what the borrow
 * and extend dialogs allow, the badge, and how a history line or a refusal reads. The server checks everything again.
 */
import { ApiError } from "../api/errors";
import type { LendingApproversOut, LendingItemEventOut, LendingItemOut, LendingItemStatus, LendingLoanOut, LendingSummaryOut } from "../api/types";
import { type MessageKey, t } from "../i18n";

// --- dates (docs/LENDING.md §4.2, §8.1: the workspace's zone, a date is "YYYY-MM-DD") ------------------------------

/** Today in `tz` (the settings' zone), as the server counts the return dates. An unknown zone falls back to the device's. */
export function todayIn(tz: string | null | undefined, now: Date = new Date()): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: tz || undefined, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  } catch {
    return new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  }
}

const dayMs = 86_400_000;
const utcOf = (date: string): number => {
  const [y, m, d] = date.split("-").map(Number);
  return Date.UTC(y!, (m ?? 1) - 1, d ?? 1);
};

export function addDays(date: string, days: number): string {
  return new Date(utcOf(date) + days * dayMs).toISOString().slice(0, 10);
}

/** `to − from` in days. */
export function daysBetween(from: string, to: string): number {
  return Math.round((utcOf(to) - utcOf(from)) / dayMs);
}

/** 「10/30」 (the year when it is not this one). */
export function shortDate(date: string, today?: string): string {
  const [y, m, d] = date.split("-").map(Number);
  const sameYear = !today || today.slice(0, 4) === date.slice(0, 4);
  return sameYear ? `${m}/${d}` : `${y}/${m}/${d}`;
}

/** A timestamp's date in the zone, 「10/16」. */
export function shortDateOf(iso: string, tz: string | null | undefined, today?: string): string {
  return shortDate(todayIn(tz, new Date(iso)), today);
}

// --- the list (§12.2: filtered here, by category, status and text) ----------------------------------------------

export type StatusFilter = "all" | LendingItemStatus | "overdue";
export type CategoryFilter = "all" | "none" | string;
export type ItemSort = "name" | "code" | "due";

const fold = (text: string): string => text.normalize("NFKC").toLowerCase();

export function filterItems(items: readonly LendingItemOut[], filter: { category: CategoryFilter; status: StatusFilter; query: string }): LendingItemOut[] {
  const words = fold(filter.query).split(/\s+/).filter(Boolean);
  return items.filter((item) => {
    if (filter.category === "none" ? item.category_id !== null : filter.category !== "all" && item.category_id !== filter.category) return false;
    if (filter.status === "overdue" ? !(item.loan && item.loan.overdue_days > 0) : filter.status !== "all" && item.status !== filter.status) return false;
    if (words.length === 0) return true;
    const haystack = fold([item.name, item.code ?? "", item.location ?? ""].join(" "));
    return words.every((word) => haystack.includes(word));
  });
}

/** Name: the server's order (Japanese collation) kept; number: by number (none last); due: the loans first, soonest first. */
export function sortItems(items: readonly LendingItemOut[], by: ItemSort): LendingItemOut[] {
  if (by === "name") return [...items];
  const index = new Map(items.map((item, i) => [item.id, i]));
  const tie = (a: LendingItemOut, b: LendingItemOut) => index.get(a.id)! - index.get(b.id)!;
  if (by === "code") {
    return [...items].sort((a, b) => (a.code === null ? 1 : 0) - (b.code === null ? 1 : 0) || (a.code ?? "").localeCompare(b.code ?? "", "ja", { numeric: true }) || tie(a, b));
  }
  return [...items].sort((a, b) => (a.loan ? 0 : 1) - (b.loan ? 0 : 1) || (a.loan?.due_on ?? "").localeCompare(b.loan?.due_on ?? "") || tie(a, b));
}

export function statusLabel(status: LendingItemStatus): string {
  switch (status) {
    case "available":
      return t("lending.status.available");
    case "on_loan":
      return t("lending.status.on_loan");
    case "in_repair":
      return t("lending.status.in_repair");
    case "retired":
      return t("lending.status.retired");
    default:
      return String(status); // a status this build does not know
  }
}

/** The status dot's colour (§12.2: green available, blue on loan, red overdue, grey in repair / retired). */
export function statusDot(item: Pick<LendingItemOut, "status" | "loan">): string {
  if (item.status === "on_loan") return item.loan && item.loan.overdue_days > 0 ? "bg-rose-500" : "bg-sky-500";
  if (item.status === "available") return "bg-emerald-500";
  return "bg-zinc-400";
}

/** 「10/30 まで」, 「今日まで」 or 「2 日過ぎ」. */
export function dueText(loan: { due_on: string; overdue_days: number }, today: string): string {
  if (loan.overdue_days > 0) return t("lending.overdueDays", { count: loan.overdue_days });
  if (loan.due_on === today) return t("lending.dueToday");
  return t("lending.until", { date: shortDate(loan.due_on, today) });
}

/** The navigation item's red number (§12.1): my loans past due, and for keepers the loans that need them. */
export function lendingBadgeCount(summary: LendingSummaryOut | null): number {
  if (!summary) return 0;
  return summary.my_overdue_count + (summary.is_keeper ? summary.keeper_attention_count : 0);
}

// --- borrowing (§6.3, §6.4) ---------------------------------------------------------------------------------------

/** The latest return date the item allows today. */
export function latestDueOn(item: Pick<LendingItemOut, "max_days">, today: string): string {
  return addDays(today, item.max_days);
}

export interface BorrowForm {
  dueOn: string;
  purpose: string;
  permissionConfirmed: boolean;
  approverId: string;
}

/** Whether the item asks for the teacher's permission from me (a teacher of @faculty borrows without, §6.3). */
export function needsPermission(item: Pick<LendingItemOut, "requires_permission">, approvers: Pick<LendingApproversOut, "self_approved"> | null): boolean {
  return item.requires_permission && !approvers?.self_approved;
}

/** What keeps 「借りる」 off, or null. */
export function borrowProblem(form: BorrowForm, item: Pick<LendingItemOut, "requires_permission" | "max_days">, today: string, approvers: LendingApproversOut | null): MessageKey | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(form.dueOn)) return "lending.check.due";
  if (form.dueOn < today) return "lending.check.duePast";
  if (form.dueOn > latestDueOn(item, today)) return "lending.check.dueTooLong";
  if (!form.purpose.trim()) return "lending.check.purpose";
  if (needsPermission(item, approvers)) {
    if (!form.permissionConfirmed) return "lending.check.permission";
    if (!form.approverId || !(approvers?.user_ids ?? []).includes(form.approverId)) return "lending.check.approver";
  }
  return null;
}

/** The teachers to choose from: my supervisor first (§12.2), then the rest by name; `query` narrows by name. */
export function approverChoices(approvers: LendingApproversOut | null, nameOf: (userId: string) => string, query = ""): Array<{ id: string; name: string; suggested: boolean }> {
  if (!approvers) return [];
  const suggested = new Set(approvers.suggested_ids);
  const words = fold(query).split(/\s+/).filter(Boolean);
  return approvers.user_ids
    .map((id) => ({ id, name: nameOf(id), suggested: suggested.has(id) }))
    .filter((choice) => words.every((word) => fold(choice.name).includes(word)))
    .sort((a, b) => Number(b.suggested) - Number(a.suggested) || a.name.localeCompare(b.name, "ja"));
}

// --- extending (§6.5) ---------------------------------------------------------------------------------------------

/** The dates the extend dialog offers: the borrower the day after the due date to `latest_due_on`; a keeper today … +365. */
export function extendRange(loan: Pick<LendingLoanOut, "due_on" | "latest_due_on">, today: string, asKeeper: boolean): { min: string; max: string } {
  if (asKeeper) return { min: today, max: addDays(today, 365) };
  return { min: addDays(loan.due_on, 1), max: loan.latest_due_on };
}

export function extensionsLeft(loan: Pick<LendingLoanOut, "extension_count">, maxExtensions: number): number {
  return Math.max(0, maxExtensions - loan.extension_count);
}

export function extendProblem(dueOn: string, range: { min: string; max: string }, current: string, asKeeper: boolean): MessageKey | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dueOn)) return "lending.check.due";
  if (dueOn === current) return "lending.check.sameDue";
  if (dueOn < range.min) return asKeeper ? "lending.check.duePast" : "lending.check.notLater";
  if (dueOn > range.max) return "lending.check.dueTooLong";
  return null;
}

// --- refusals (§5.5, §7.1) ----------------------------------------------------------------------------------------

/**
 * 409 lending_item_unavailable as the borrow dialog says it: 「〇〇 さんが先に借りました（10/30 まで）」, 「すでに借りています」
 * (I have it), or the status it is in; null for any other error.
 */
export function unavailableText(error: unknown, me: string | undefined, nameOf: (userId: string) => string, today: string): string | null {
  if (!(error instanceof ApiError) || error.code !== "lending_item_unavailable") return null;
  const details = (error.details ?? {}) as { status?: LendingItemStatus; borrower_id?: string; due_on?: string };
  if (details.borrower_id && details.borrower_id === me) return t("lending.takenByMe");
  if (details.borrower_id) return t("lending.takenBy", { name: nameOf(details.borrower_id), date: details.due_on ? shortDate(details.due_on, today) : "?" });
  if (details.status) return t("lending.notAvailableNow", { status: statusLabel(details.status) });
  return null;
}

// --- the history (§5.2) -------------------------------------------------------------------------------------------

/** One history line's words (who comes first, drawn by the caller). */
export function eventText(event: Pick<LendingItemEventOut, "kind" | "details">, today: string): string {
  const d = event.details as Record<string, unknown>;
  const date = (value: unknown) => (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? shortDate(value, today) : "?");
  switch (event.kind) {
    case "created":
      return t("lending.event.created");
    case "updated":
      return t("lending.event.updated");
    case "status":
      return typeof d.to === "string" ? t("lending.event.status", { status: statusLabel(d.to as LendingItemStatus) }) + (typeof d.note === "string" && d.note ? t("lending.event.note", { note: d.note }) : "") : t("lending.event.updated");
    case "borrowed":
      return t("lending.event.borrowed", { date: date(d.due_on) });
    case "extended":
      return t("lending.event.extended", { from: date(d.from), to: date(d.to) });
    case "due_changed":
      return t("lending.event.dueChanged", { from: date(d.from), to: date(d.to) });
    case "returned":
      return d.by_keeper ? t("lending.event.returnedByKeeper") : t("lending.event.returned");
    case "permission_denied":
      return t("lending.event.denied");
    case "permission_confirmed":
      return t("lending.event.confirmed");
    default:
      return t("lending.event.other");
  }
}

/** A return marked 「問題あり」 (🔧, shown to everyone, §3.2). */
export function eventIssue(event: Pick<LendingItemEventOut, "kind" | "details">): boolean {
  return event.kind === "returned" && (event.details as { condition?: string }).condition === "issue";
}

/** A new client_request_id (one per borrow; a retry sends the same, §7.2). */
export function newRequestId(): string {
  return crypto.randomUUID();
}
