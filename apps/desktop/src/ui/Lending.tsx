/**
 * M170 (docs/LENDING.md §12.2): 「備品」 — the workspace's equipment, borrowed and returned by the people themselves.
 *
 * Tabs: 一覧 (the ledger: search, category chips, status; the detail beside it, a page of its own on a phone),
 * 貸出中 (who has what until when), 自分 (my loans, and the loans that named me as the teacher: 「許可していない」 /
 * 「確認した」), 延滞 (keepers), 管理 (keepers: categories, adding items) and 設定 (lending.manage: the switch, the keepers,
 * the defaults). The dialogs borrow (return date up to the item's longest, purpose, the teacher's permission), return,
 * extend and edit. Everything is read again on lending.updated (store.lendingRevision); the server checks every call.
 */
import { Check, ChevronLeft, MessageSquare, Package, Pencil, Plus, Search, Trash2, Wrench } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { isRetryable } from "../api/errors";
import type { AttachmentOut, LendingApproversOut, LendingCategoryOut, LendingItemDetailOut, LendingItemEventOut, LendingItemOut, LendingItemStatus, LendingLoanOut, LendingSettingsOut } from "../api/types";
import { t } from "../i18n";
import type { AppController } from "../state/app";
import { useAttachmentImage } from "./Attachments";
import { LendingCsvSection } from "./LendingCsv";
import { LendingLabelsSection } from "./LendingLabels";
import { BackButton, useCompact } from "./compact";
import { useStoreUpdates } from "./hooks";
import {
  approverChoices,
  borrowProblem,
  type CategoryFilter,
  dueText,
  eventIssue,
  eventText,
  extendProblem,
  extendRange,
  extensionsLeft,
  filterItems,
  type ItemSort,
  latestDueOn,
  needsPermission,
  newRequestId,
  shortDate,
  shortDateOf,
  sortItems,
  statusDot,
  statusLabel,
  type StatusFilter,
  todayIn,
  unavailableText,
} from "./lendingRules";
import { Button, cn, Input, Modal, Textarea, UNDERLINE_TAB, UnderlineTabRow } from "./primitives";
import { UserPopover } from "./UserPopover";

export type LendingTab = "items" | "active" | "mine" | "overdue" | "manage" | "settings";

const field = "block text-xs font-semibold text-muted";
const select = "mt-1 block w-full rounded-lg border border-line bg-canvas px-2 py-2 text-sm font-normal text-ink";

function nameOf(controller: AppController, userId: string | null | undefined): string {
  if (!userId) return t("common.unknownUser");
  return controller.store.users.get(userId)?.display_name ?? t("common.unknownUser");
}

/** Runs a call, shows its error in the banner; true when it worked. */
async function attempt(controller: AppController, call: () => Promise<unknown>): Promise<boolean> {
  try {
    await call();
    return true;
  } catch (error) {
    controller.setError(error);
    return false;
  }
}

// --- the page ---------------------------------------------------------------------------------------------------

/** The ledger and the settings, read on opening and again after every lending.updated. */
function useLedger(controller: AppController) {
  const revision = controller.store.lendingRevision;
  const [settings, setSettings] = useState<LendingSettingsOut | null>(null);
  const [items, setItems] = useState<LendingItemOut[] | null>(null);
  const [categories, setCategories] = useState<LendingCategoryOut[]>([]);
  const [includeRetired, setIncludeRetired] = useState(false);
  const [failed, setFailed] = useState(false);
  const seq = useRef(0);
  const load = useCallback(async () => {
    const api = controller.api;
    if (!api) return;
    const mine = ++seq.current;
    try {
      const s = await api.lendingSettings();
      if (mine !== seq.current) return;
      setSettings(s);
      if (!s.enabled) {
        setItems([]);
        setCategories([]);
        setFailed(false);
        return;
      }
      const [list, cats] = await Promise.all([api.lendingItems(includeRetired), api.lendingCategories()]);
      if (mine !== seq.current) return;
      setItems(list);
      setCategories(cats);
      setFailed(false);
    } catch (error) {
      if (mine !== seq.current) return;
      console.warn("could not load the equipment", error);
      setFailed(true);
    }
  }, [controller.api, includeRetired]);
  useEffect(() => {
    void load();
  }, [load, revision]);
  return { settings, items, categories, includeRetired, setIncludeRetired, failed, reload: load, revision };
}

export function LendingView({ controller }: { controller: AppController }) {
  useStoreUpdates(controller);
  const store = controller.store;
  const ledger = useLedger(controller);
  const { settings, items, categories } = ledger;
  const me = store.me?.id;
  const keeper = settings?.is_keeper ?? store.lending?.is_keeper ?? false;
  const manager = controller.can("lending.manage");
  const today = todayIn(settings?.tz);
  const [tab, setTab] = useState<LendingTab>("items");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const compact = useCompact();

  // A notification or an activity row asked for a loan, an item, or (the keepers' summary) the overdue list.
  const request = controller.openLendingRequest;
  useEffect(() => {
    if (!request) return;
    controller.openLendingRequest = null;
    if (request.itemId) {
      setTab("items");
      setSelectedId(request.itemId);
    } else if (request.loanId) {
      void controller.api?.lendingLoan(request.loanId).then((loan) => {
        setTab("items");
        setSelectedId(loan.item_id);
      }, (error: unknown) => controller.setError(error));
    } else {
      setTab(keeper ? "overdue" : "mine");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request?.seq]);

  const tabs: Array<[LendingTab, string, number | null]> = [
    ["items", t("lending.tab.items"), null],
    ["active", t("lending.tab.active"), items ? items.filter((i) => i.status === "on_loan").length : null],
    ["mine", t("lending.tab.mine"), store.lending?.my_active_count ?? null],
    ...(keeper ? [["overdue", t("lending.tab.overdue"), items ? items.filter((i) => (i.loan?.overdue_days ?? 0) > 0).length : null] as [LendingTab, string, number | null]] : []),
    ...(keeper ? [["manage", t("lending.tab.manage"), null] as [LendingTab, string, number | null]] : []),
    ...(manager ? [["settings", t("lending.tab.settings"), null] as [LendingTab, string, number | null]] : []),
  ];
  const shown: LendingTab = tabs.some(([value]) => value === tab) ? tab : "items";
  const openItem = (itemId: string) => {
    setTab("items");
    setSelectedId(itemId);
  };
  const off = settings !== null && !settings.enabled;

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-lending-page>
      <header className="flex h-[52px] shrink-0 items-center gap-2 border-b border-line px-4 max-md:px-2">
        <BackButton />
        <span className="text-muted max-md:hidden"><Package size={18} /></span>
        <strong className="text-[15px]">{t("nav.lending")}</strong>
      </header>
      {off ? (
        <div data-scroll-memory className="min-h-0 flex-1 overflow-y-auto px-4 py-4 max-md:px-3">
          <div className="mx-auto max-w-3xl space-y-4">
            <p className="text-sm text-muted">{t("lending.off")}</p>
            {manager && settings && <LendingSettingsForm controller={controller} settings={settings} onSaved={() => void ledger.reload()} />}
          </div>
        </div>
      ) : (
        <>
          <UnderlineTabRow role="tablist" aria-label={t("nav.lending")} className="gap-1 px-3 max-md:px-1">
            {tabs.map(([value, label, count]) => (
              <button
                key={value}
                type="button"
                role="tab"
                aria-selected={shown === value}
                data-lending-tab={value}
                onClick={() => setTab(value)}
                className={cn(UNDERLINE_TAB, "px-3 py-2 max-md:px-2.5", shown === value ? "border-accent text-ink" : "border-transparent text-muted hover:text-ink")}
              >
                {label}
                {count !== null && count > 0 && <span className={cn("ml-1.5 text-xs", value === "overdue" ? "font-semibold text-rose-600" : "text-muted")}>{count}</span>}
              </button>
            ))}
          </UnderlineTabRow>
          {ledger.failed && items === null ? (
            <div className="flex flex-col items-center gap-3 py-16 text-sm text-muted">
              {t("common.loadFailed")}
              <Button variant="secondary" size="sm" onClick={() => void ledger.reload()}>{t("common.reload")}</Button>
            </div>
          ) : items === null || settings === null ? (
            <p className="px-4 py-4 text-sm text-muted">{t("common.loading")}</p>
          ) : shown === "items" ? (
            <ItemsTab
              controller={controller}
              settings={settings}
              items={items}
              categories={categories}
              keeper={keeper}
              today={today}
              compact={compact}
              selectedId={selectedId}
              onSelect={setSelectedId}
              includeRetired={ledger.includeRetired}
              onIncludeRetired={ledger.setIncludeRetired}
              revision={ledger.revision}
              onChanged={() => void ledger.reload()}
            />
          ) : (
            <div data-scroll-memory className="min-h-0 flex-1 overflow-y-auto px-4 py-4 max-md:px-3">
              <div className="mx-auto max-w-5xl">
                {shown === "active" ? (
                  <LoansTab controller={controller} scope="active" settings={settings} today={today} revision={ledger.revision} onOpenItem={openItem} onChanged={() => void ledger.reload()} />
                ) : shown === "mine" ? (
                  <MineTab controller={controller} settings={settings} today={today} revision={ledger.revision} onOpenItem={openItem} onChanged={() => void ledger.reload()} me={me} />
                ) : shown === "overdue" ? (
                  <LoansTab controller={controller} scope="overdue" settings={settings} today={today} revision={ledger.revision} onOpenItem={openItem} onChanged={() => void ledger.reload()} />
                ) : shown === "manage" ? (
                  <ManageTab controller={controller} settings={settings} items={items} categories={categories} onChanged={() => void ledger.reload()} onOpenItem={openItem} />
                ) : (
                  <LendingSettingsForm controller={controller} settings={settings} onSaved={() => void ledger.reload()} />
                )}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// --- 一覧 ---------------------------------------------------------------------------------------------------------

function ItemsTab({ controller, settings, items, categories, keeper, today, compact, selectedId, onSelect, includeRetired, onIncludeRetired, revision, onChanged }: {
  controller: AppController;
  settings: LendingSettingsOut;
  items: LendingItemOut[];
  categories: LendingCategoryOut[];
  keeper: boolean;
  today: string;
  compact: boolean;
  selectedId: string | null;
  onSelect: (itemId: string | null) => void;
  includeRetired: boolean;
  onIncludeRetired: (on: boolean) => void;
  revision: number;
  onChanged: () => void;
}) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<CategoryFilter>("all");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [sort, setSort] = useState<ItemSort>("name");
  const [editing, setEditing] = useState(false);
  const shown = useMemo(() => sortItems(filterItems(items, { category, status, query }), sort), [items, category, status, query, sort]);
  const categoryName = (id: string | null) => (id ? categories.find((c) => c.id === id)?.name ?? "" : t("lending.category.none"));
  const selected = selectedId ? items.find((i) => i.id === selectedId) ?? null : null;
  const hasUncategorised = items.some((i) => i.category_id === null);

  const detail = selectedId ? (
    <ItemDetail key={selectedId} controller={controller} itemId={selectedId} settings={settings} categories={categories} keeper={keeper} today={today} revision={revision} onClose={() => onSelect(null)} onChanged={onChanged} />
  ) : null;
  if (compact && detail) return <div data-scroll-memory className="min-h-0 flex-1 overflow-y-auto">{detail}</div>;

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="shrink-0 space-y-2 border-b border-line px-4 py-2 max-md:px-3">
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-line bg-canvas px-2 max-md:basis-full">
              <Search size={14} className="shrink-0 text-muted" />
              <input
                type="search"
                className="h-8 min-w-0 flex-1 bg-transparent text-sm outline-none"
                placeholder={t("lending.search")}
                aria-label={t("lending.search")}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </label>
            <select aria-label={t("lending.col.status")} className="rounded-lg border border-line bg-canvas px-2 py-1.5 text-sm" value={status} onChange={(e) => setStatus(e.target.value as StatusFilter)}>
              <option value="all">{t("lending.status.all")}</option>
              <option value="available">{statusLabel("available")}</option>
              <option value="on_loan">{statusLabel("on_loan")}</option>
              <option value="overdue">{t("lending.status.overdue")}</option>
              <option value="in_repair">{statusLabel("in_repair")}</option>
              {includeRetired && <option value="retired">{statusLabel("retired")}</option>}
            </select>
            <select aria-label={t("lending.sort")} className="rounded-lg border border-line bg-canvas px-2 py-1.5 text-sm" value={sort} onChange={(e) => setSort(e.target.value as ItemSort)}>
              <option value="name">{t("lending.sort.name")}</option>
              <option value="code">{t("lending.sort.code")}</option>
              <option value="due">{t("lending.sort.due")}</option>
            </select>
            {keeper && (
              <Button size="sm" onClick={() => setEditing(true)} aria-label={t("lending.addItem")}>
                <Plus size={14} /> <span className="max-md:hidden">{t("lending.addItem")}</span>
              </Button>
            )}
          </div>
          {(categories.length > 0 || hasUncategorised) && (
            <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label={t("lending.col.category")}>
              {([["all", t("lending.category.all")], ...categories.map((c) => [c.id, c.name] as [string, string]), ...(hasUncategorised ? [["none", t("lending.category.none")] as [string, string]] : [])] as Array<[string, string]>).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={category === value}
                  onClick={() => setCategory(value)}
                  className={cn("h-7 rounded-full border px-2.5 text-[12.5px] transition-colors", category === value ? "border-accent bg-accent-soft text-accent" : "border-line text-muted hover:text-ink")}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
          <div className="flex items-center justify-between gap-2 text-xs text-muted">
            <span>{t("lending.reservationsHint")}</span>
            <label className="flex shrink-0 items-center gap-1.5">
              <input type="checkbox" checked={includeRetired} onChange={(e) => onIncludeRetired(e.target.checked)} />
              {t("lending.showRetired")}
            </label>
          </div>
        </div>
        <div data-scroll-memory className="min-h-0 flex-1 overflow-y-auto">
          {items.length === 0 ? (
            <p className="px-4 py-6 text-sm text-muted">{t("lending.none")}{keeper ? t("lending.noneKeeper") : ""}</p>
          ) : shown.length === 0 ? (
            <p className="px-4 py-6 text-sm text-muted">{t("lending.noMatch")}</p>
          ) : (
            <ul aria-label={t("lending.tab.items")} className="divide-y divide-line">
              {shown.map((item) => (
                <li key={item.id}>
                  <ItemRow controller={controller} item={item} categoryName={categoryName(item.category_id)} today={today} selected={item.id === selected?.id} onOpen={() => onSelect(item.id)} />
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
      {!compact && (
        <aside className="flex w-[360px] shrink-0 flex-col border-l border-line max-lg:w-[320px]" aria-label={t("lending.detail")}>
          {detail ?? <p className="px-4 py-6 text-sm text-muted">{t("lending.pick")}</p>}
        </aside>
      )}
      {editing && <ItemDialog controller={controller} item={null} settings={settings} categories={categories} onClose={() => setEditing(false)} onSaved={(saved) => { setEditing(false); onChanged(); onSelect(saved.id); }} />}
    </div>
  );
}

function ItemPhoto({ controller, photo, size = 40 }: { controller: AppController; photo: AttachmentOut | null; size?: number }) {
  return (
    <span className="flex shrink-0 items-center justify-center overflow-hidden rounded-lg bg-panel-2 text-muted" style={{ width: size, height: size }} aria-hidden="true">
      {photo ? <PhotoImage controller={controller} photo={photo} /> : <Package size={Math.round(size * 0.45)} />}
    </span>
  );
}

function PhotoImage({ controller, photo, kind = "thumbnail" }: { controller: AppController; photo: AttachmentOut; kind?: "thumbnail" | "content" }) {
  const { url } = useAttachmentImage(controller, photo, kind);
  return url ? <img src={url} alt="" className="h-full w-full object-cover" /> : <Package size={16} />;
}

/** One row: the photo, the name and number, category and place, the status (a dot and words) and who has it. */
function ItemRow({ controller, item, categoryName, today, selected, onOpen }: { controller: AppController; item: LendingItemOut; categoryName: string; today: string; selected: boolean; onOpen: () => void }) {
  const loan = item.loan;
  return (
    <button
      type="button"
      onClick={onOpen}
      data-lending-item={item.id}
      aria-current={selected || undefined}
      className={cn("flex w-full items-center gap-3 px-4 py-2 text-left transition-colors hover:bg-panel max-md:px-3", selected && "bg-accent-soft/50")}
    >
      <ItemPhoto controller={controller} photo={item.photo} />
      <span className="grid min-w-0 flex-1 gap-x-3 md:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <span className="min-w-0">
          <span className="flex min-w-0 items-baseline gap-2">
            <span className="truncate text-sm font-medium">{item.name}</span>
            {item.code && <span className="shrink-0 text-xs text-muted">{item.code}</span>}
          </span>
          <span className="block truncate text-xs text-muted">{[categoryName, item.location].filter(Boolean).join(" · ")}</span>
        </span>
        <span className="flex min-w-0 flex-wrap items-center gap-x-2 text-xs">
          <span className="inline-flex items-center gap-1.5" data-status={item.status}>
            <span className={cn("h-2 w-2 shrink-0 rounded-full", statusDot(item))} aria-hidden="true" />
            {statusLabel(item.status)}
          </span>
          {loan && (
            <span className={cn("truncate", loan.overdue_days > 0 ? "font-semibold text-rose-600" : "text-muted")}>
              {nameOf(controller, loan.borrower_id)} · {dueText(loan, today)}
            </span>
          )}
          {!loan && item.status_note && <span className="truncate text-muted">{t("lending.paren", { text: item.status_note })}</span>}
          {item.status === "available" && item.requires_permission && <span className="text-muted">🔑 {t("lending.permissionNeeded")}</span>}
        </span>
      </span>
    </button>
  );
}

// --- the detail -------------------------------------------------------------------------------------------------

type DialogState =
  | { kind: "borrow" }
  | { kind: "return"; loan: LendingLoanOut }
  | { kind: "extend"; loan: LendingLoanOut }
  | { kind: "edit" }
  | { kind: "status" }
  | { kind: "deny"; loan: LendingLoanOut }
  | { kind: "delete" };

function ItemDetail({ controller, itemId, settings, categories, keeper, today, revision, onClose, onChanged }: {
  controller: AppController;
  itemId: string;
  settings: LendingSettingsOut;
  categories: LendingCategoryOut[];
  keeper: boolean;
  today: string;
  revision: number;
  onClose: () => void;
  onChanged: () => void;
}) {
  const me = controller.store.me?.id;
  const [detail, setDetail] = useState<LendingItemDetailOut | null>(null);
  const [loan, setLoan] = useState<LendingLoanOut | null>(null);
  const [history, setHistory] = useState<{ events: LendingItemEventOut[]; next: string | null } | null>(null);
  const [failed, setFailed] = useState(false);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    const api = controller.api;
    if (!api) return;
    try {
      const [item, page] = await Promise.all([api.lendingItem(itemId), api.lendingItemHistory(itemId, null, 20)]);
      setDetail(item);
      setHistory({ events: page.events, next: page.next_before });
      setLoan(item.loan ? await api.lendingLoan(item.loan.id) : null);
      setFailed(false);
    } catch (error) {
      console.warn("could not load the item", error);
      setFailed(true);
    }
  }, [controller.api, itemId]);
  useEffect(() => {
    void load();
  }, [load, revision]);
  const changed = () => {
    void load();
    onChanged();
  };
  const more = async () => {
    if (!history?.next || !controller.api) return;
    const page = await controller.api.lendingItemHistory(itemId, history.next, 50).catch((error: unknown) => {
      controller.setError(error);
      return null;
    });
    if (page) setHistory({ events: [...history.events, ...page.events], next: page.next_before });
  };

  if (!detail) {
    return failed ? (
      <div className="flex flex-col items-center gap-3 py-12 text-sm text-muted">
        {t("common.loadFailed")}
        <Button variant="secondary" size="sm" onClick={() => void load()}>{t("common.reload")}</Button>
      </div>
    ) : (
      <p className="px-4 py-6 text-sm text-muted">{t("common.loading")}</p>
    );
  }
  const category = categories.find((c) => c.id === detail.category_id) ?? null;
  const mine = !!loan && loan.borrower_id === me;
  const approver = !!loan && loan.approver_id === me && loan.permission_required && loan.status === "active";
  const lastReturned = (detail.recent_loans ?? []).find((l) => l.status === "returned");
  const watchable = (detail.status === "on_loan" || detail.status === "in_repair") && !mine;
  const toggleWatch = async () => {
    setBusy(true);
    if (await attempt(controller, () => controller.api!.setLendingWatch(detail.id, !detail.watching))) setDetail({ ...detail, watching: !detail.watching });
    setBusy(false);
  };
  const decide = async (decision: "confirmed") => {
    if (!loan) return;
    setBusy(true);
    if (await attempt(controller, () => controller.api!.decideLendingPermission(loan.id, { decision }))) changed();
    setBusy(false);
  };

  return (
    <div className="space-y-4 px-4 py-4" data-lending-detail={detail.id}>
      <div className="flex items-start gap-2">
        <Button variant="ghost" size="icon" className="-ml-2 md:hidden" aria-label={t("common.back")} onClick={onClose}><ChevronLeft size={18} /></Button>
        <div className="min-w-0 flex-1">
          <h2 className="break-words text-[16px] font-semibold">{detail.name}</h2>
          <p className="text-xs text-muted">{[detail.code, category?.name ?? (detail.category_id ? "" : t("lending.category.none"))].filter(Boolean).join(" · ")}</p>
        </div>
      </div>
      {detail.photo && (
        <div className="aspect-[4/3] w-full overflow-hidden rounded-xl border border-line bg-panel-2">
          <PhotoImage controller={controller} photo={detail.photo} kind="content" />
        </div>
      )}
      <div className="space-y-1 text-sm">
        <p className="flex flex-wrap items-center gap-1.5" data-status={detail.status}>
          <span className={cn("h-2 w-2 rounded-full", statusDot(detail))} aria-hidden="true" />
          <span className="font-medium">{statusLabel(detail.status)}</span>
          {detail.loan && (
            <span className={cn(detail.loan.overdue_days > 0 ? "font-semibold text-rose-600" : "text-muted")}>
              {t("lending.loanOf", { name: nameOf(controller, detail.loan.borrower_id), due: detail.loan.overdue_days > 0 ? t("lending.joined", { a: t("lending.until", { date: shortDate(detail.loan.due_on, today) }), b: t("lending.overdueDays", { count: detail.loan.overdue_days }) }) : t("lending.until", { date: shortDate(detail.loan.due_on, today) }) })}
            </span>
          )}
          {!detail.loan && detail.status_note && <span className="text-muted">{t("lending.paren", { text: detail.status_note })}</span>}
        </p>
        {detail.location && <p><span className="text-muted">{t("lending.labelled", { label: t("lending.location") })}</span>{detail.location}</p>}
        {detail.notes && <p className="whitespace-pre-wrap break-words"><span className="text-muted">{t("lending.labelled", { label: t("lending.notes") })}</span>{detail.notes}</p>}
        <p className="text-muted">
          {detail.requires_permission ? `🔑 ${t("lending.permissionNeeded")} · ` : ""}
          {t("lending.maxDays", { count: detail.max_days })}
        </p>
        {lastReturned?.return_condition === "issue" && detail.status !== "on_loan" && <p className="text-amber-700 dark:text-amber-400">🔧 {t("lending.lastReturnIssue")}</p>}
      </div>

      {loan && !loan.details_hidden && (
        <div className="space-y-1 rounded-xl border border-line px-3 py-2 text-sm" data-loan-details>
          {loan.purpose && <p><span className="text-muted">{t("lending.labelled", { label: t("lending.purpose") })}</span>{loan.purpose}</p>}
          <p className="text-xs text-muted">{t("lending.borrowedOn", { date: shortDateOf(loan.borrowed_at, settings.tz, today) })}{loan.extension_count > 0 ? ` · ${t("lending.extendedTimes", { count: loan.extension_count })}` : ""}</p>
          {loan.permission_required && <PermissionLine controller={controller} loan={loan} />}
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        {detail.status === "available" && (
          <Button size="sm" onClick={() => setDialog({ kind: "borrow" })}>{t("lending.borrow")}</Button>
        )}
        {loan && loan.status === "active" && mine && (
          <>
            <Button size="sm" onClick={() => setDialog({ kind: "return", loan })}>{t("lending.return")}</Button>
            <Button size="sm" variant="secondary" disabled={!loan.can_extend} title={loan.can_extend ? undefined : t("lending.cannotExtend")} onClick={() => setDialog({ kind: "extend", loan })}>{t("lending.extend")}</Button>
          </>
        )}
        {loan && loan.status === "active" && !mine && keeper && (
          <>
            <Button size="sm" variant="secondary" onClick={() => setDialog({ kind: "return", loan })}>{t("lending.recordReturn")}</Button>
            <Button size="sm" variant="secondary" onClick={() => setDialog({ kind: "extend", loan })}>{t("lending.changeDue")}</Button>
          </>
        )}
        {approver && loan && (
          <>
            <Button size="sm" variant="secondary" disabled={busy || loan.permission_state === "denied"} onClick={() => setDialog({ kind: "deny", loan })}>{t("lending.deny")}</Button>
            <Button size="sm" variant="secondary" disabled={busy || loan.permission_state === "confirmed"} onClick={() => void decide("confirmed")}>{t("lending.confirm")}</Button>
          </>
        )}
        {watchable && (
          <Button size="sm" variant="secondary" aria-pressed={detail.watching} disabled={busy} onClick={() => void toggleWatch()}>
            {detail.watching && <Check size={13} />}
            {t("lending.watch")}
          </Button>
        )}
      </div>
      {detail.watching && watchable && <p className="-mt-2 text-xs text-muted">{t("lending.watching")}</p>}

      {keeper && (
        <div className="flex flex-wrap gap-2 border-t border-line pt-3">
          <Button size="sm" variant="ghost" onClick={() => setDialog({ kind: "edit" })}><Pencil size={13} /> {t("lending.editItem")}</Button>
          <Button size="sm" variant="ghost" disabled={detail.status === "on_loan"} title={detail.status === "on_loan" ? t("lending.statusOnLoan") : undefined} onClick={() => setDialog({ kind: "status" })}><Wrench size={13} /> {t("lending.changeStatus")}</Button>
          <Button size="sm" variant="ghost" className="text-danger" disabled={detail.status === "on_loan"} onClick={() => setDialog({ kind: "delete" })}><Trash2 size={13} /> {t("common.delete")}</Button>
        </div>
      )}

      <section aria-label={t("lending.history")}>
        <h3 className="mb-1 text-xs font-semibold text-muted">{t("lending.history")}</h3>
        {history && history.events.length === 0 ? (
          <p className="text-sm text-muted">{t("lending.noHistory")}</p>
        ) : (
          <ul className="space-y-1 text-[13px]">
            {(history?.events ?? []).map((event) => (
              <li key={event.id} className="flex gap-2" data-event={event.kind}>
                <span className="w-11 shrink-0 text-muted">{shortDateOf(event.at, settings.tz, today)}</span>
                <span className="min-w-0 flex-1">
                  <span className="font-medium">{nameOf(controller, event.actor_id)}</span> {eventText(event, today)}
                  {eventIssue(event) && <span className="ml-1" title={t("lending.conditionIssue")}>🔧</span>}
                </span>
              </li>
            ))}
          </ul>
        )}
        {history?.next && <Button size="sm" variant="ghost" className="mt-1" onClick={() => void more()}>{t("lending.moreHistory")}</Button>}
      </section>

      {dialog?.kind === "borrow" && <BorrowDialog controller={controller} item={detail} settings={settings} onClose={() => setDialog(null)} onDone={() => { setDialog(null); changed(); }} onTaken={changed} />}
      {dialog?.kind === "return" && <ReturnDialog controller={controller} loan={dialog.loan} byKeeper={dialog.loan.borrower_id !== me} onClose={() => setDialog(null)} onDone={() => { setDialog(null); changed(); }} />}
      {dialog?.kind === "extend" && <ExtendDialog controller={controller} loan={dialog.loan} settings={settings} today={today} asKeeper={keeper} watchers={detail.watcher_count} onClose={() => setDialog(null)} onDone={() => { setDialog(null); changed(); }} />}
      {dialog?.kind === "deny" && <DenyDialog controller={controller} loanId={dialog.loan.id} borrowerName={nameOf(controller, dialog.loan.borrower_id)} itemName={detail.name} onClose={() => setDialog(null)} onDone={() => { setDialog(null); changed(); }} />}
      {dialog?.kind === "edit" && <ItemDialog controller={controller} item={detail} settings={settings} categories={categories} onClose={() => setDialog(null)} onSaved={() => { setDialog(null); changed(); }} />}
      {dialog?.kind === "status" && <StatusDialog controller={controller} item={detail} onClose={() => setDialog(null)} onDone={() => { setDialog(null); changed(); }} />}
      {dialog?.kind === "delete" && (
        <Modal onClose={() => setDialog(null)} title={t("lending.deleteItem")} description={t("lending.deleteQuestion", { name: detail.name })}>
          <div className="mt-4 flex justify-end gap-2">
            <Button size="sm" variant="secondary" onClick={() => setDialog(null)}>{t("common.cancel")}</Button>
            <Button size="sm" variant="danger" onClick={() => void attempt(controller, () => controller.api!.deleteLendingItem(detail.id)).then((ok) => { setDialog(null); if (ok) { onClose(); onChanged(); } })}>{t("common.delete")}</Button>
          </div>
        </Modal>
      )}
    </div>
  );
}

/** 「🔑 許可した教員：〇〇（確認済み）」 — the teacher's state, for those who see a loan's details. */
function PermissionLine({ controller, loan }: { controller: AppController; loan: LendingLoanOut }) {
  if (!loan.permission_required || !loan.approver_id) return null;
  const state = loan.permission_state === "denied" ? t("lending.permission.denied") : loan.permission_state === "confirmed" ? t("lending.permission.confirmed") : t("lending.permission.claimed");
  return (
    <p className={cn("text-xs", loan.permission_state === "denied" ? "font-semibold text-rose-600" : "text-muted")} data-permission={loan.permission_state ?? undefined}>
      🔑 {t("lending.approvedBy", { name: nameOf(controller, loan.approver_id) })}{t("lending.paren", { text: state })}{loan.permission_note ? ` · ${t("common.quoted", { text: loan.permission_note })}` : ""}
    </p>
  );
}

// --- the dialogs ------------------------------------------------------------------------------------------------

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 「借りる」 (§6.3, §12.2): the return date (up to the item's longest; the calendar offers nothing later), the purpose,
 * and for an item that needs it 「教員の許可を得た」 and the teacher (my supervisor first). 「借りる」 stays off until all is
 * there. One client_request_id for the dialog: a network failure is sent again with it (§7.2), never a second loan. 409
 * lending_item_unavailable says who took it first and reads the item again.
 */
export function BorrowDialog({ controller, item, settings, onClose, onDone, onTaken }: {
  controller: AppController;
  item: Pick<LendingItemOut, "id" | "name" | "requires_permission" | "max_days">;
  settings: Pick<LendingSettingsOut, "tz">;
  onClose: () => void;
  onDone: (loan: LendingLoanOut) => void;
  onTaken: () => void;
}) {
  const today = todayIn(settings.tz);
  const latest = latestDueOn(item, today);
  const [dueOn, setDueOn] = useState(latest);
  const [purpose, setPurpose] = useState("");
  const [permissionConfirmed, setPermissionConfirmed] = useState(false);
  const [approverId, setApproverId] = useState("");
  const [approverQuery, setApproverQuery] = useState("");
  const [approvers, setApprovers] = useState<LendingApproversOut | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(newRequestId());
  useEffect(() => {
    if (!item.requires_permission) return;
    void controller.api?.lendingApprovers().then((out) => {
      setApprovers(out);
      if (out.suggested_ids[0]) setApproverId((id) => id || out.suggested_ids[0]!);
    }, (err: unknown) => setError(controller.describe(err)));
  }, [controller, item.requires_permission]);
  const asking = needsPermission(item, approvers);
  const choices = approverChoices(approvers, (id) => nameOf(controller, id), approverQuery);
  const chosen = approverChoices(approvers, (id) => nameOf(controller, id)).find((c) => c.id === approverId);
  const form = { dueOn, purpose, permissionConfirmed, approverId };
  const waitingForApprovers = item.requires_permission && approvers === null;
  const problem = waitingForApprovers ? null : borrowProblem(form, item, today, approvers);
  const submit = async () => {
    const api = controller.api;
    if (!api || problem || waitingForApprovers) return;
    setBusy(true);
    setError(null);
    const body = {
      client_request_id: requestId.current,
      due_on: dueOn,
      purpose: purpose.trim(),
      permission_confirmed: asking ? permissionConfirmed : false,
      approver_id: asking ? approverId : null,
    };
    for (let tries = 0; ; tries += 1) {
      try {
        const loan = await api.borrowLendingItem(item.id, body);
        setBusy(false);
        onDone(loan);
        return;
      } catch (err) {
        if (isRetryable(err) && tries < 2) {
          await sleep(700 * (tries + 1));
          continue;
        }
        const taken = unavailableText(err, controller.store.me?.id, (id) => nameOf(controller, id), today);
        setError(taken ?? controller.describe(err));
        if (taken) onTaken();
        setBusy(false);
        return;
      }
    }
  };
  return (
    <Modal onClose={onClose} title={t("lending.borrowTitle", { name: item.name })} className="w-[480px]">
      <form
        className="mt-3 space-y-3"
        aria-label={t("lending.borrow")}
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <label className={field}>
          {t("lending.dueOn")}
          <Input className="mt-1" type="date" min={today} max={latest} value={dueOn} onChange={(e) => setDueOn(e.target.value)} required />
          <span className="mt-1 block font-normal" data-due-hint>{t("lending.dueHint", { count: item.max_days, date: shortDate(latest, today) })}</span>
        </label>
        <label className={field}>
          {t("lending.purpose")}
          <Input className="mt-1" maxLength={200} placeholder={t("lending.purposePlaceholder")} value={purpose} onChange={(e) => setPurpose(e.target.value)} autoFocus />
        </label>
        {item.requires_permission && (
          approvers === null ? (
            <p className="text-xs text-muted">{t("common.loading")}</p>
          ) : !asking ? (
            <p className="text-xs text-muted" data-self-approved>🔑 {t("lending.selfApproved")}</p>
          ) : (
            <fieldset className="space-y-2 rounded-xl border border-line px-3 py-2" data-permission-fields>
              <legend className="px-1 text-xs font-semibold text-muted">🔑 {t("lending.permissionNeededLong")}</legend>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={permissionConfirmed} onChange={(e) => setPermissionConfirmed(e.target.checked)} />
                {t("lending.permissionConfirmed")}
              </label>
              <label className={field}>
                {t("lending.approver")}
                {approvers.user_ids.length > 8 && (
                  <Input className="mt-1" placeholder={t("lending.approverSearch")} aria-label={t("lending.approverSearch")} value={approverQuery} onChange={(e) => setApproverQuery(e.target.value)} />
                )}
                <select className={select} value={approverId} onChange={(e) => setApproverId(e.target.value)} aria-label={t("lending.approver")}>
                  <option value="">{t("lending.approverChoose")}</option>
                  {chosen && !choices.some((c) => c.id === chosen.id) && <option value={chosen.id}>{chosen.name}</option>}
                  {choices.map((c) => <option key={c.id} value={c.id}>{c.name}{c.suggested ? t("lending.approverSuggested") : ""}</option>)}
                </select>
              </label>
              <p className="text-xs text-muted">{t("lending.approverNote")}</p>
            </fieldset>
          )
        )}
        {problem && (dueOn !== latest || purpose || permissionConfirmed) && <p className="text-xs text-muted" data-borrow-problem>{t(problem, { date: shortDate(latest, today) })}</p>}
        {error && <p role="alert" className="text-xs text-danger">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="secondary" onClick={onClose}>{t("common.cancel")}</Button>
          <Button size="sm" type="submit" disabled={busy || !!problem || waitingForApprovers}>{t("lending.borrow")}</Button>
        </div>
      </form>
    </Modal>
  );
}

/** 「返す」 (§6.6): 問題なし / 問題あり, a note (needed with 問題あり). A keeper recording someone's return is asked first. */
export function ReturnDialog({ controller, loan, byKeeper, onClose, onDone }: { controller: AppController; loan: LendingLoanOut; byKeeper: boolean; onClose: () => void; onDone: () => void }) {
  const [condition, setCondition] = useState<"ok" | "issue">("ok");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const needsNote = condition === "issue" && !note.trim();
  const submit = async () => {
    const api = controller.api;
    if (!api || needsNote) return;
    setBusy(true);
    setError(null);
    try {
      await api.returnLendingLoan(loan.id, { condition, note: note.trim() || null });
      onDone();
    } catch (err) {
      setError(controller.describe(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      onClose={onClose}
      title={byKeeper ? t("lending.recordReturnTitle", { name: loan.item_name }) : t("lending.returnTitle", { name: loan.item_name })}
      description={byKeeper ? t("lending.recordReturnNote", { name: nameOf(controller, loan.borrower_id) }) : undefined}
      className="w-[440px]"
    >
      <form className="mt-3 space-y-3" aria-label={t("lending.return")} onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <div className="flex gap-4" role="radiogroup" aria-label={t("lending.condition")}>
          {(["ok", "issue"] as const).map((value) => (
            <label key={value} className="flex items-center gap-2 text-sm">
              <input type="radio" name="condition" checked={condition === value} onChange={() => setCondition(value)} />
              {value === "ok" ? t("lending.conditionOk") : t("lending.conditionIssue")}
            </label>
          ))}
        </div>
        <label className={field}>
          {t("lending.returnNote")}
          <Textarea className="mt-1" rows={3} maxLength={500} placeholder={condition === "issue" ? t("lending.issueNotePlaceholder") : t("lending.returnNotePlaceholder")} value={note} onChange={(e) => setNote(e.target.value)} />
        </label>
        {condition === "issue" && needsNote && <p className="text-xs text-muted">{t("lending.check.returnNote")}</p>}
        {error && <p role="alert" className="text-xs text-danger">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="secondary" onClick={onClose}>{t("common.cancel")}</Button>
          <Button size="sm" type="submit" disabled={busy || needsNote}>{byKeeper ? t("lending.recordReturn") : t("lending.return")}</Button>
        </div>
      </form>
    </Modal>
  );
}

/**
 * 「延長」 (§6.5): a new return date in the range (the borrower: after the current one, up to latest_due_on; a keeper: today
 * to 365 days ahead, earlier too), the extensions left, and a word when people wait for the item.
 */
export function ExtendDialog({ controller, loan, settings, today, asKeeper, watchers, onClose, onDone }: {
  controller: AppController;
  loan: LendingLoanOut;
  settings: Pick<LendingSettingsOut, "max_extensions">;
  today: string;
  asKeeper: boolean;
  watchers: number;
  onClose: () => void;
  onDone: () => void;
}) {
  const range = extendRange(loan, today, asKeeper);
  const [dueOn, setDueOn] = useState(asKeeper ? loan.due_on : range.max);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const problem = extendProblem(dueOn, range, loan.due_on, asKeeper);
  const left = extensionsLeft(loan, settings.max_extensions);
  const mine = loan.borrower_id === controller.store.me?.id;
  const submit = async () => {
    const api = controller.api;
    if (!api || problem) return;
    setBusy(true);
    setError(null);
    try {
      await api.extendLendingLoan(loan.id, dueOn);
      onDone();
    } catch (err) {
      setError(controller.describe(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal onClose={onClose} title={mine ? t("lending.extendTitle", { name: loan.item_name }) : t("lending.changeDueTitle", { name: loan.item_name })} description={t("lending.currentDue", { date: shortDate(loan.due_on, today) })} className="w-[440px]">
      <form className="mt-3 space-y-3" aria-label={t("lending.extend")} onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <label className={field}>
          {t("lending.newDueOn")}
          <Input className="mt-1" type="date" min={range.min} max={range.max} value={dueOn} onChange={(e) => setDueOn(e.target.value)} required />
          <span className="mt-1 block font-normal">{t("lending.extendRange", { from: shortDate(range.min, today), to: shortDate(range.max, today) })}</span>
        </label>
        {mine && !asKeeper && <p className="text-xs text-muted" data-extensions-left>{left > 0 ? t("lending.extendsLeft", { count: left }) : t("lending.noExtendsLeft")}</p>}
        {asKeeper && !mine && <p className="text-xs text-muted">{t("lending.changeDueNote")}</p>}
        {watchers > 0 && <p className="text-xs text-amber-700 dark:text-amber-400" data-watchers>{t("lending.watchersWaiting", { count: watchers })}</p>}
        {problem && problem !== "lending.check.sameDue" && <p className="text-xs text-muted">{t(problem, { date: shortDate(range.max, today) })}</p>}
        {error && <p role="alert" className="text-xs text-danger">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="secondary" onClick={onClose}>{t("common.cancel")}</Button>
          <Button size="sm" type="submit" disabled={busy || !!problem}>{mine ? t("lending.extend") : t("lending.changeDue")}</Button>
        </div>
      </form>
    </Modal>
  );
}

/** The teacher's 「許可していない」 (§6, §8.2): after a check, with an optional word; the borrower and the keepers are told. */
export function DenyDialog({ controller, loanId, borrowerName, itemName, onClose, onDone }: { controller: AppController; loanId: string; borrowerName?: string; itemName: string; onClose: () => void; onDone: () => void }) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // From an activity row the borrower is not known yet: the loan says (its details are mine as the teacher).
  const [borrower, setBorrower] = useState<string | null>(borrowerName ?? null);
  useEffect(() => {
    if (borrowerName) return;
    void controller.api?.lendingLoan(loanId).then((loan) => setBorrower(nameOf(controller, loan.borrower_id)), () => setBorrower(t("common.unknownUser")));
  }, [controller, loanId, borrowerName]);
  const submit = async () => {
    const api = controller.api;
    if (!api) return;
    setBusy(true);
    setError(null);
    try {
      await api.decideLendingPermission(loanId, { decision: "denied", note: note.trim() || null });
      onDone();
    } catch (err) {
      setError(controller.describe(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal onClose={onClose} title={t("lending.denyTitle")} description={t("lending.denyQuestion", { name: borrower ?? "…", item: itemName })} className="w-[440px]">
      <form className="mt-3 space-y-3" aria-label={t("lending.deny")} onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <label className={field}>
          {t("lending.permissionNote")}
          <Textarea className="mt-1" rows={2} maxLength={200} value={note} onChange={(e) => setNote(e.target.value)} autoFocus />
        </label>
        {error && <p role="alert" className="text-xs text-danger">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="secondary" onClick={onClose}>{t("common.cancel")}</Button>
          <Button size="sm" type="submit" variant="danger" disabled={busy}>{t("lending.deny")}</Button>
        </div>
      </form>
    </Modal>
  );
}

/** 状態を変える (keepers, §6.2): 貸出可 / 修理中 / 廃棄 with a reason. */
function StatusDialog({ controller, item, onClose, onDone }: { controller: AppController; item: LendingItemDetailOut; onClose: () => void; onDone: () => void }) {
  const [status, setStatus] = useState<Exclude<LendingItemStatus, "on_loan">>(item.status === "on_loan" ? "available" : item.status);
  const [note, setNote] = useState(item.status_note ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    const api = controller.api;
    if (!api) return;
    setBusy(true);
    setError(null);
    try {
      await api.setLendingItemStatus(item.id, { status, note: status === "available" ? null : note.trim() || null });
      onDone();
    } catch (err) {
      setError(controller.describe(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal onClose={onClose} title={t("lending.changeStatus")} description={item.name} className="w-[420px]">
      <form className="mt-3 space-y-3" aria-label={t("lending.changeStatus")} onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <div className="space-y-1" role="radiogroup" aria-label={t("lending.col.status")}>
          {(["available", "in_repair", "retired"] as const).map((value) => (
            <label key={value} className="flex items-center gap-2 text-sm">
              <input type="radio" name="status" checked={status === value} onChange={() => setStatus(value)} />
              {statusLabel(value)}
            </label>
          ))}
        </div>
        {status !== "available" && (
          <label className={field}>
            {t("lending.statusNote")}
            <Input className="mt-1" maxLength={200} placeholder={t("lending.statusNotePlaceholder")} value={note} onChange={(e) => setNote(e.target.value)} />
          </label>
        )}
        {status === "retired" && <p className="text-xs text-muted">{t("lending.retireNote")}</p>}
        {error && <p role="alert" className="text-xs text-danger">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="secondary" onClick={onClose}>{t("common.cancel")}</Button>
          <Button size="sm" type="submit" disabled={busy}>{t("common.save")}</Button>
        </div>
      </form>
    </Modal>
  );
}

const PHOTO_TYPES = "image/jpeg,image/png,image/webp,image/heic,image/heif";

/**
 * 備品を追加 / 編集 (keepers, §12.2): name, category, number, place, accessories and notes, the photo (dropped or chosen,
 * uploaded through POST /attachments and bound by the save), whether permission is needed and the longest loan (the
 * category's default, or the item's own).
 */
export function ItemDialog({ controller, item, settings, categories, onClose, onSaved }: {
  controller: AppController;
  item: LendingItemOut | null;
  settings: Pick<LendingSettingsOut, "default_max_days">;
  categories: LendingCategoryOut[];
  onClose: () => void;
  onSaved: (item: LendingItemDetailOut) => void;
}) {
  const [name, setName] = useState(item?.name ?? "");
  const [categoryId, setCategoryId] = useState(item?.category_id ?? "");
  const [code, setCode] = useState(item?.code ?? "");
  const [location, setLocation] = useState(item?.location ?? "");
  const [notes, setNotes] = useState(item?.notes ?? "");
  const [permission, setPermission] = useState<"inherit" | "yes" | "no">(item && item.requires_permission_source === "item" ? (item.requires_permission ? "yes" : "no") : "inherit");
  const [maxDays, setMaxDays] = useState(item && item.max_days_source === "item" ? String(item.max_days) : "");
  const [photo, setPhoto] = useState<AttachmentOut | null>(item?.photo ?? null);
  const [uploading, setUploading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const category = categories.find((c) => c.id === categoryId) ?? null;
  const inheritedPermission = category?.requires_permission ?? false;
  const inheritedMax = category?.max_days ?? settings.default_max_days;
  const upload = async (file: File | undefined) => {
    const api = controller.api;
    if (!file || !api) return;
    if (!file.type.startsWith("image/")) return setError(t("lending.photoNotImage"));
    setUploading(true);
    setError(null);
    try {
      setPhoto(await api.uploadAttachment(file, file.name || "photo"));
    } catch (err) {
      setError(controller.describe(err));
    } finally {
      setUploading(false);
    }
  };
  const days = maxDays.trim() === "" ? null : Number(maxDays);
  const daysBad = days !== null && (!Number.isInteger(days) || days < 1 || days > 365);
  const submit = async () => {
    const api = controller.api;
    if (!api) return;
    if (!name.trim()) return setError(t("lending.check.name"));
    if (daysBad) return setError(t("lending.check.maxDays"));
    setBusy(true);
    setError(null);
    const body = {
      name: name.trim(),
      category_id: categoryId || null,
      code: code.trim() || null,
      location: location.trim() || null,
      notes: notes.trim() || null,
      requires_permission: permission === "inherit" ? null : permission === "yes",
      max_days: days,
    };
    const photoChanged = (photo?.id ?? null) !== (item?.photo?.id ?? null);
    try {
      const saved = item
        ? await api.updateLendingItem(item.id, { ...body, ...(photoChanged ? { photo_attachment_id: photo?.id ?? null } : {}) })
        : await api.createLendingItem({ ...body, photo_attachment_id: photo?.id ?? null });
      onSaved(saved);
    } catch (err) {
      setError(controller.describe(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal onClose={onClose} title={item ? t("lending.editItem") : t("lending.addItem")} className="w-[560px]">
      <form className="mt-3 space-y-3" aria-label={item ? t("lending.editItem") : t("lending.addItem")} onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <div className="grid grid-cols-[minmax(0,2fr)_minmax(0,1fr)] gap-2 max-md:grid-cols-1">
          <label className={field}>
            {t("lending.name")}
            <Input className="mt-1" maxLength={80} placeholder={t("lending.namePlaceholder")} value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          </label>
          <label className={field}>
            {t("lending.code")}
            <Input className="mt-1" maxLength={40} placeholder={t("lending.codePlaceholder")} value={code} onChange={(e) => setCode(e.target.value)} />
          </label>
        </div>
        <div className="grid grid-cols-2 gap-2 max-md:grid-cols-1">
          <label className={field}>
            {t("lending.col.category")}
            <select className={select} value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
              <option value="">{t("lending.category.none")}</option>
              {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
          <label className={field}>
            {t("lending.location")}
            <Input className="mt-1" maxLength={80} placeholder={t("lending.locationPlaceholder")} value={location} onChange={(e) => setLocation(e.target.value)} />
          </label>
        </div>
        <label className={field}>
          {t("lending.notes")}
          <Textarea className="mt-1" rows={2} maxLength={2000} placeholder={t("lending.notesPlaceholder")} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </label>
        <div>
          <span className={field}>{t("lending.photo")}</span>
          <div
            className="mt-1 flex items-center gap-3 rounded-xl border border-dashed border-line p-2"
            data-photo-drop
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              void upload(e.dataTransfer.files[0]);
            }}
          >
            <ItemPhoto controller={controller} photo={photo} size={56} />
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="secondary" disabled={uploading} onClick={() => fileInput.current?.click()}>{uploading ? t("common.saving") : t("lending.photoChoose")}</Button>
              {photo && <Button size="sm" variant="ghost" onClick={() => setPhoto(null)}>{t("lending.photoRemove")}</Button>}
            </div>
            <span className="text-xs text-muted max-md:hidden">{t("lending.photoDrop")}</span>
            <input ref={fileInput} type="file" accept={PHOTO_TYPES} className="hidden" onChange={(e) => { void upload(e.target.files?.[0]); e.target.value = ""; }} />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2 max-md:grid-cols-1">
          <label className={field}>
            {t("lending.permissionField")}
            <select className={select} value={permission} onChange={(e) => setPermission(e.target.value as typeof permission)}>
              <option value="inherit">{t("lending.inheritPermission", { value: inheritedPermission ? t("lending.yes") : t("lending.no") })}</option>
              <option value="yes">{t("lending.yes")}</option>
              <option value="no">{t("lending.no")}</option>
            </select>
          </label>
          <label className={field}>
            {t("lending.maxDaysField")}
            <Input className="mt-1" inputMode="numeric" placeholder={t("lending.inheritMaxDays", { count: inheritedMax })} value={maxDays} onChange={(e) => setMaxDays(e.target.value)} />
            <span className="mt-1 block font-normal">{t("lending.maxDaysNote")}</span>
          </label>
        </div>
        {error && <p role="alert" className="text-xs text-danger">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="secondary" onClick={onClose}>{t("common.cancel")}</Button>
          <Button size="sm" type="submit" disabled={busy || uploading}>{item ? t("common.save") : t("common.add")}</Button>
        </div>
      </form>
    </Modal>
  );
}

// --- 貸出中・延滞 -------------------------------------------------------------------------------------------------

function useLoans(controller: AppController, scope: "mine" | "active" | "overdue" | "approved", revision: number) {
  const [loans, setLoans] = useState<LendingLoanOut[] | null>(null);
  const [failed, setFailed] = useState(false);
  const load = useCallback(async () => {
    const api = controller.api;
    if (!api) return;
    try {
      setLoans(await api.lendingLoans(scope));
      setFailed(false);
    } catch (error) {
      console.warn("could not load the loans", error);
      setFailed(true);
    }
  }, [controller.api, scope]);
  useEffect(() => {
    void load();
  }, [load, revision]);
  return { loans, failed, reload: load };
}

function Loading({ failed, onReload }: { failed: boolean; onReload: () => void }) {
  return failed ? (
    <div className="flex flex-col items-center gap-3 py-12 text-sm text-muted">
      {t("common.loadFailed")}
      <Button variant="secondary" size="sm" onClick={onReload}>{t("common.reload")}</Button>
    </div>
  ) : (
    <p className="text-sm text-muted">{t("common.loading")}</p>
  );
}

function Person({ controller, userId }: { controller: AppController; userId: string }) {
  const user = controller.store.users.get(userId);
  return (
    <UserPopover controller={controller} userId={userId} className="truncate text-left hover:underline">
      {user?.display_name ?? t("common.unknownUser")}
      {user?.deactivated_at && <span className="ml-1 text-xs text-muted">{t("lending.paren", { text: t("lending.deactivated") })}</span>}
    </UserPopover>
  );
}

/** 貸出中 (everyone) and 延滞 (keepers: the purpose, a DM, recording the return, changing the date). */
function LoansTab({ controller, scope, settings, today, revision, onOpenItem, onChanged }: {
  controller: AppController;
  scope: "active" | "overdue";
  settings: LendingSettingsOut;
  today: string;
  revision: number;
  onOpenItem: (itemId: string) => void;
  onChanged: () => void;
}) {
  const { loans, failed, reload } = useLoans(controller, scope, revision);
  const [dialog, setDialog] = useState<{ kind: "return" | "extend"; loan: LendingLoanOut } | null>(null);
  if (!loans) return <Loading failed={failed} onReload={() => void reload()} />;
  if (loans.length === 0) return <p className="text-sm text-muted">{scope === "active" ? t("lending.active.none") : t("lending.overdue.none")}</p>;
  const overdue = scope === "overdue";
  const contact = async (userId: string) => {
    const id = await controller.openDmWith(userId);
    if (id) window.dispatchEvent(new CustomEvent("chikuwa:open-channel", { detail: id }));
  };
  const done = () => {
    setDialog(null);
    void reload();
    onChanged();
  };
  return (
    <>
      <div className="max-md:hidden grid grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)_5rem_6rem_minmax(0,1fr)] gap-3 border-b border-line px-2 pb-1 text-xs font-semibold text-muted">
        <span>{t("lending.col.item")}</span>
        <span>{t("lending.col.borrower")}</span>
        <span>{t("lending.col.borrowedAt")}</span>
        <span>{t("lending.col.due")}</span>
        <span>{overdue ? t("lending.purpose") : ""}</span>
      </div>
      <ul className="divide-y divide-line" aria-label={overdue ? t("lending.tab.overdue") : t("lending.tab.active")}>
        {loans.map((loan) => (
          <li key={loan.id} data-loan={loan.id} className="grid items-center gap-x-3 gap-y-0.5 px-2 py-2 text-sm md:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)_5rem_6rem_minmax(0,1fr)]">
            <button type="button" className="min-w-0 truncate text-left font-medium hover:underline" onClick={() => onOpenItem(loan.item_id)}>
              {loan.item_name}{loan.item_code ? <span className="ml-1.5 text-xs font-normal text-muted">{loan.item_code}</span> : null}
            </button>
            <span className="flex min-w-0 items-center gap-1"><Person controller={controller} userId={loan.borrower_id} /></span>
            <span className="text-xs text-muted"><span className="md:hidden">{t("lending.labelled", { label: t("lending.col.borrowedAt") })}</span>{shortDateOf(loan.borrowed_at, settings.tz, today)}</span>
            <span className={cn("text-xs", loan.overdue_days > 0 ? "font-semibold text-rose-600" : "text-muted")}><span className="md:hidden">{t("lending.labelled", { label: t("lending.col.due") })}</span>{loan.overdue_days > 0 ? t("lending.joined", { a: shortDate(loan.due_on, today), b: t("lending.overdueDays", { count: loan.overdue_days }) }) : shortDate(loan.due_on, today)}</span>
            <span className="flex min-w-0 flex-wrap items-center gap-1.5">
              {overdue && loan.purpose && <span className="min-w-0 truncate text-xs text-muted">{loan.purpose}</span>}
              {overdue && (
                <span className="ml-auto flex shrink-0 gap-1">
                  <Button size="sm" variant="ghost" aria-label={t("lending.contactOf", { name: nameOf(controller, loan.borrower_id) })} title={t("lending.contact")} onClick={() => void contact(loan.borrower_id)}><MessageSquare size={13} /></Button>
                  <Button size="sm" variant="secondary" onClick={() => setDialog({ kind: "return", loan })}>{t("lending.recordReturn")}</Button>
                  <Button size="sm" variant="secondary" onClick={() => setDialog({ kind: "extend", loan })}>{t("lending.changeDue")}</Button>
                </span>
              )}
            </span>
          </li>
        ))}
      </ul>
      {dialog?.kind === "return" && <ReturnDialog controller={controller} loan={dialog.loan} byKeeper={dialog.loan.borrower_id !== controller.store.me?.id} onClose={() => setDialog(null)} onDone={done} />}
      {dialog?.kind === "extend" && <ExtendDialog controller={controller} loan={dialog.loan} settings={settings} today={today} asKeeper watchers={0} onClose={() => setDialog(null)} onDone={done} />}
    </>
  );
}

// --- 自分 -------------------------------------------------------------------------------------------------------

/** My loans (返す・延長), my recent returns, and the loans that named me as the teacher (「許可していない」「確認した」). */
function MineTab({ controller, settings, today, revision, onOpenItem, onChanged, me }: {
  controller: AppController;
  settings: LendingSettingsOut;
  today: string;
  revision: number;
  onOpenItem: (itemId: string) => void;
  onChanged: () => void;
  me: string | undefined;
}) {
  const mine = useLoans(controller, "mine", revision);
  const approved = useLoans(controller, "approved", revision);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [busy, setBusy] = useState(false);
  const done = () => {
    setDialog(null);
    void mine.reload();
    void approved.reload();
    onChanged();
  };
  const confirm = async (loan: LendingLoanOut) => {
    setBusy(true);
    if (await attempt(controller, () => controller.api!.decideLendingPermission(loan.id, { decision: "confirmed" }))) done();
    setBusy(false);
  };
  const active = (mine.loans ?? []).filter((l) => l.status === "active");
  const returned = (mine.loans ?? []).filter((l) => l.status === "returned");
  const asApprover = (approved.loans ?? []).filter((l) => l.borrower_id !== me);
  const itemButton = (loan: LendingLoanOut) => (
    <button type="button" className="min-w-0 truncate text-left font-medium hover:underline" onClick={() => onOpenItem(loan.item_id)}>
      📦 {loan.item_name}{loan.item_code ? <span className="ml-1.5 text-xs font-normal text-muted">{loan.item_code}</span> : null}
    </button>
  );
  return (
    <div className="space-y-6">
      <Section title={t("lending.mine.active")}>
        {!mine.loans ? <Loading failed={mine.failed} onReload={() => void mine.reload()} /> : active.length === 0 ? (
          <p className="py-2 text-sm text-muted">{t("lending.mine.none")}</p>
        ) : (
          <ul className="divide-y divide-line">
            {active.map((loan) => (
              <li key={loan.id} data-my-loan={loan.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-sm">
                <span className="min-w-0 flex-1">
                  {itemButton(loan)}
                  <span className={cn("block text-xs", loan.overdue_days > 0 ? "font-semibold text-rose-600" : "text-muted")}>{dueText(loan, today)}{loan.purpose ? ` · ${loan.purpose}` : ""}</span>
                  {loan.permission_required && <PermissionLine controller={controller} loan={loan} />}
                </span>
                <Button size="sm" onClick={() => setDialog({ kind: "return", loan })}>{t("lending.return")}</Button>
                <Button size="sm" variant="secondary" disabled={!loan.can_extend} title={loan.can_extend ? undefined : t("lending.cannotExtend")} onClick={() => setDialog({ kind: "extend", loan })}>{t("lending.extend")}</Button>
              </li>
            ))}
          </ul>
        )}
      </Section>
      {(approved.loans === null || asApprover.length > 0) && (
        <Section title={t("lending.approvals")} note={t("lending.approvalsNote")}>
          {!approved.loans ? <Loading failed={approved.failed} onReload={() => void approved.reload()} /> : (
            <ul className="divide-y divide-line">
              {asApprover.map((loan) => (
                <li key={loan.id} data-approval={loan.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-sm">
                  <span className="min-w-0 flex-1">
                    {itemButton(loan)}
                    <span className="block text-xs text-muted">
                      {nameOf(controller, loan.borrower_id)} · {loan.status === "returned" ? t("lending.returnedOn", { date: shortDateOf(loan.returned_at ?? loan.borrowed_at, settings.tz, today) }) : dueText(loan, today)}{loan.purpose ? ` · ${loan.purpose}` : ""}
                    </span>
                    <PermissionLine controller={controller} loan={loan} />
                  </span>
                  <Button size="sm" variant="secondary" disabled={busy || loan.permission_state === "denied"} onClick={() => setDialog({ kind: "deny", loan })}>{t("lending.deny")}</Button>
                  <Button size="sm" variant="secondary" disabled={busy || loan.permission_state === "confirmed"} onClick={() => void confirm(loan)}>{t("lending.confirm")}</Button>
                </li>
              ))}
            </ul>
          )}
        </Section>
      )}
      {returned.length > 0 && (
        <Section title={t("lending.mine.returned")}>
          <ul className="divide-y divide-line">
            {returned.map((loan) => (
              <li key={loan.id} className="flex items-center gap-3 py-1.5 text-sm">
                <span className="min-w-0 flex-1">{itemButton(loan)}</span>
                <span className="shrink-0 text-xs text-muted">
                  {t("lending.returnedOn", { date: shortDateOf(loan.returned_at ?? loan.borrowed_at, settings.tz, today) })}
                  {loan.return_condition === "issue" ? " 🔧" : ""}
                </span>
              </li>
            ))}
          </ul>
        </Section>
      )}
      {dialog?.kind === "return" && <ReturnDialog controller={controller} loan={dialog.loan} byKeeper={false} onClose={() => setDialog(null)} onDone={done} />}
      {dialog?.kind === "extend" && <ExtendDialog controller={controller} loan={dialog.loan} settings={settings} today={today} asKeeper={false} watchers={0} onClose={() => setDialog(null)} onDone={done} />}
      {dialog?.kind === "deny" && <DenyDialog controller={controller} loanId={dialog.loan.id} borrowerName={nameOf(controller, dialog.loan.borrower_id)} itemName={dialog.loan.item_name} onClose={() => setDialog(null)} onDone={done} />}
    </div>
  );
}

function Section({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <section aria-label={title}>
      <h3 className="text-xs font-semibold text-muted">{title}</h3>
      {note && <p className="mt-0.5 text-xs text-muted">{note}</p>}
      <div className="mt-1">{children}</div>
    </section>
  );
}

// --- 管理 -------------------------------------------------------------------------------------------------------

/** Keepers (§12.2): the categories (add, rename, defaults, order, delete), adding an item, the CSV and the QR labels (L7). */
function ManageTab({ controller, settings, items, categories, onChanged, onOpenItem }: {
  controller: AppController;
  settings: LendingSettingsOut;
  items: LendingItemOut[];
  categories: LendingCategoryOut[];
  onChanged: () => void;
  onOpenItem: (itemId: string) => void;
}) {
  const [editing, setEditing] = useState<LendingCategoryOut | "new" | null>(null);
  const [adding, setAdding] = useState(false);
  const [deleting, setDeleting] = useState<LendingCategoryOut | null>(null);
  // The position is the place in the order from 0; the server moves the others along.
  const move = (category: LendingCategoryOut, index: number) => void attempt(controller, () => controller.api!.updateLendingCategory(category.id, { position: index })).then((ok) => { if (ok) onChanged(); });
  return (
    <div className="space-y-6">
      <Section title={t("lending.categories")} note={t("lending.categoriesNote")}>
        <div className="mb-2 flex gap-2">
          <Button size="sm" onClick={() => setEditing("new")}><Plus size={14} /> {t("lending.addCategory")}</Button>
          <Button size="sm" variant="secondary" onClick={() => setAdding(true)}><Plus size={14} /> {t("lending.addItem")}</Button>
        </div>
        {categories.length === 0 ? (
          <p className="text-sm text-muted">{t("lending.noCategories")}</p>
        ) : (
          <ul className="divide-y divide-line rounded-xl border border-line" aria-label={t("lending.categories")}>
            {categories.map((category, index) => (
              <li key={category.id} data-category={category.id} className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
                <span className="min-w-0 flex-1">
                  <span className="font-medium">{category.name}</span>
                  <span className="ml-2 text-xs text-muted">
                    {t("lending.categoryItems", { count: category.item_count })} · {category.requires_permission ? `🔑 ${t("lending.permissionNeeded")}` : t("lending.permissionNotNeeded")} · {t("lending.maxDays", { count: category.max_days ?? settings.default_max_days })}
                  </span>
                </span>
                <Button size="sm" variant="ghost" aria-label={t("common.moveUp")} disabled={index === 0} onClick={() => move(category, index - 1)}>↑</Button>
                <Button size="sm" variant="ghost" aria-label={t("common.moveDown")} disabled={index === categories.length - 1} onClick={() => move(category, index + 1)}>↓</Button>
                <Button size="sm" variant="ghost" aria-label={t("lending.editCategoryOf", { name: category.name })} onClick={() => setEditing(category)}><Pencil size={13} /></Button>
                <Button size="sm" variant="ghost" className="text-danger" aria-label={t("lending.deleteCategoryOf", { name: category.name })} onClick={() => setDeleting(category)}><Trash2 size={13} /></Button>
              </li>
            ))}
          </ul>
        )}
      </Section>
      <LendingCsvSection controller={controller} onChanged={onChanged} />
      <LendingLabelsSection controller={controller} items={items} categories={categories} />
      {editing !== null && <CategoryDialog controller={controller} category={editing === "new" ? null : editing} settings={settings} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); onChanged(); }} />}
      {adding && <ItemDialog controller={controller} item={null} settings={settings} categories={categories} onClose={() => setAdding(false)} onSaved={(saved) => { setAdding(false); onChanged(); onOpenItem(saved.id); }} />}
      {deleting && (
        <Modal onClose={() => setDeleting(null)} title={t("lending.deleteCategory")} description={t("lending.deleteCategoryQuestion", { name: deleting.name })}>
          <div className="mt-4 flex justify-end gap-2">
            <Button size="sm" variant="secondary" onClick={() => setDeleting(null)}>{t("common.cancel")}</Button>
            <Button size="sm" variant="danger" onClick={() => void attempt(controller, () => controller.api!.deleteLendingCategory(deleting.id)).then((ok) => { setDeleting(null); if (ok) onChanged(); })}>{t("common.delete")}</Button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function CategoryDialog({ controller, category, settings, onClose, onSaved }: { controller: AppController; category: LendingCategoryOut | null; settings: Pick<LendingSettingsOut, "default_max_days">; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(category?.name ?? "");
  const [requiresPermission, setRequiresPermission] = useState(category?.requires_permission ?? false);
  const [maxDays, setMaxDays] = useState(category?.max_days ? String(category.max_days) : "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    const api = controller.api;
    if (!api) return;
    const days = maxDays.trim() === "" ? null : Number(maxDays);
    if (!name.trim()) return setError(t("lending.check.name"));
    if (days !== null && (!Number.isInteger(days) || days < 1 || days > 365)) return setError(t("lending.check.maxDays"));
    setBusy(true);
    setError(null);
    try {
      if (category) await api.updateLendingCategory(category.id, { name: name.trim(), requires_permission: requiresPermission, max_days: days });
      else await api.createLendingCategory({ name: name.trim(), requires_permission: requiresPermission, max_days: days });
      onSaved();
    } catch (err) {
      setError(controller.describe(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal onClose={onClose} title={category ? t("lending.editCategory") : t("lending.addCategory")} description={t("lending.categoryDescription")} className="w-[440px]">
      <form className="mt-3 space-y-3" aria-label={category ? t("lending.editCategory") : t("lending.addCategory")} onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <label className={field}>
          {t("lending.name")}
          <Input className="mt-1" maxLength={40} placeholder={t("lending.categoryPlaceholder")} value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={requiresPermission} onChange={(e) => setRequiresPermission(e.target.checked)} />
          {t("lending.categoryPermission")}
        </label>
        <label className={field}>
          {t("lending.maxDaysField")}
          <Input className="mt-1" inputMode="numeric" placeholder={t("lending.inheritMaxDays", { count: settings.default_max_days })} value={maxDays} onChange={(e) => setMaxDays(e.target.value)} />
        </label>
        {error && <p role="alert" className="text-xs text-danger">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="secondary" onClick={onClose}>{t("common.cancel")}</Button>
          <Button size="sm" type="submit" disabled={busy}>{category ? t("common.save") : t("common.add")}</Button>
        </div>
      </form>
    </Modal>
  );
}

// --- 設定 -------------------------------------------------------------------------------------------------------

const hhmm = (minute: number) => `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;

function zones(): string[] {
  try {
    return (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.("timeZone") ?? [];
  } catch {
    return [];
  }
}

/**
 * Administrators (lending.manage, §5.1): the switch, the keepers (people only, 20 at most), the longest loan by default,
 * the extensions a borrower may make, when the keepers hear of an overdue loan, the morning notices' time and the zone.
 * Also in 「管理 → 備品」.
 */
export function LendingSettingsForm({ controller, settings, onSaved }: { controller: AppController; settings: LendingSettingsOut; onSaved?: (settings: LendingSettingsOut) => void }) {
  const store = controller.store;
  const [enabled, setEnabled] = useState(settings.enabled);
  const [keeperIds, setKeeperIds] = useState<string[]>(settings.keeper_ids);
  const [defaultMaxDays, setDefaultMaxDays] = useState(String(settings.default_max_days));
  const [maxExtensions, setMaxExtensions] = useState(String(settings.max_extensions));
  const [keeperOverdueDays, setKeeperOverdueDays] = useState(String(settings.keeper_overdue_days));
  const [noticeTime, setNoticeTime] = useState(hhmm(settings.notice_minute));
  const [tz, setTz] = useState(settings.tz);
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const people = [...store.users.values()]
    .filter((u) => u.role !== "bot" && u.role !== "guest" && (!u.deactivated_at || keeperIds.includes(u.id)))
    .filter((u) => !filter.trim() || `${u.display_name} ${u.username}`.toLowerCase().includes(filter.trim().toLowerCase()))
    .sort((a, b) => Number(keeperIds.includes(b.id)) - Number(keeperIds.includes(a.id)) || a.display_name.localeCompare(b.display_name, "ja"));
  const zoneList = useMemo(zones, []);
  const submit = async () => {
    const api = controller.api;
    if (!api) return;
    const numbers = { default_max_days: Number(defaultMaxDays), max_extensions: Number(maxExtensions), keeper_overdue_days: Number(keeperOverdueDays) };
    const bad = !Number.isInteger(numbers.default_max_days) || numbers.default_max_days < 1 || numbers.default_max_days > 365
      || !Number.isInteger(numbers.max_extensions) || numbers.max_extensions < 0 || numbers.max_extensions > 10
      || !Number.isInteger(numbers.keeper_overdue_days) || numbers.keeper_overdue_days < 1 || numbers.keeper_overdue_days > 30;
    const [h, m] = noticeTime.split(":").map(Number);
    if (bad || h === undefined || m === undefined || Number.isNaN(h) || Number.isNaN(m)) return setError(t("lending.check.settings"));
    if (keeperIds.length > 20) return setError(t("lending.check.keepers"));
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const out = await api.updateLendingSettings({ enabled, keeper_ids: keeperIds, ...numbers, notice_minute: h * 60 + m, tz: tz.trim() || settings.tz });
      setSaved(true);
      onSaved?.(out);
    } catch (err) {
      setError(controller.describe(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="max-w-2xl space-y-4" aria-label={t("lending.tab.settings")} data-lending-settings onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <div>
        <label className="flex items-center gap-2 text-sm font-medium">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          {t("lending.settings.enabled")}
        </label>
        <p className="mt-1 text-xs text-muted">{t("lending.settings.enabledNote")}</p>
      </div>
      <fieldset>
        <legend className={field}>{t("lending.settings.keepers")}{keeperIds.length > 0 ? t("lending.paren", { text: keeperIds.length }) : ""}</legend>
        <Input className="mt-1" placeholder={t("lending.settings.keepersFilter")} aria-label={t("lending.settings.keepersFilter")} value={filter} onChange={(e) => setFilter(e.target.value)} />
        <div className="mt-1 max-h-48 space-y-0.5 overflow-y-auto rounded-md border border-line px-2 py-1">
          {people.map((u) => (
            <label key={u.id} className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={keeperIds.includes(u.id)} onChange={(e) => setKeeperIds(e.target.checked ? [...keeperIds, u.id] : keeperIds.filter((id) => id !== u.id))} />
              {u.display_name} <span className="text-xs text-muted">@{u.username}</span>
              {u.deactivated_at && <span className="text-xs text-muted">{t("lending.paren", { text: t("lending.deactivated") })}</span>}
            </label>
          ))}
        </div>
        <p className="mt-1 text-xs text-muted">{t("lending.settings.keepersNote")}</p>
      </fieldset>
      <div className="grid grid-cols-3 gap-2 max-md:grid-cols-1">
        <label className={field}>
          {t("lending.settings.defaultMaxDays")}
          <Input className="mt-1" inputMode="numeric" value={defaultMaxDays} onChange={(e) => setDefaultMaxDays(e.target.value)} />
        </label>
        <label className={field}>
          {t("lending.settings.maxExtensions")}
          <Input className="mt-1" inputMode="numeric" value={maxExtensions} onChange={(e) => setMaxExtensions(e.target.value)} />
        </label>
        <label className={field}>
          {t("lending.settings.keeperOverdueDays")}
          <Input className="mt-1" inputMode="numeric" value={keeperOverdueDays} onChange={(e) => setKeeperOverdueDays(e.target.value)} />
        </label>
      </div>
      <div className="grid grid-cols-2 gap-2 max-md:grid-cols-1">
        <label className={field}>
          {t("lending.settings.noticeTime")}
          <Input className="mt-1" type="time" value={noticeTime} onChange={(e) => setNoticeTime(e.target.value)} />
        </label>
        <label className={field}>
          {t("lending.settings.tz")}
          <Input className="mt-1" list="lending-zones" value={tz} onChange={(e) => setTz(e.target.value)} />
          <datalist id="lending-zones">{zoneList.map((zone) => <option key={zone} value={zone} />)}</datalist>
        </label>
      </div>
      <p className="text-xs text-muted">{t("lending.settings.note")}</p>
      {error && <p role="alert" className="text-xs text-danger">{error}</p>}
      <div className="flex items-center gap-3">
        <Button size="sm" type="submit" disabled={busy}>{t("common.save")}</Button>
        {saved && <span className="text-xs text-muted" role="status">{t("common.saved")}</span>}
      </div>
    </form>
  );
}

/** 「管理 → 備品」: the settings form (lending.manage), read when the tab opens. */
export function LendingAdminTab({ controller }: { controller: AppController }) {
  const [settings, setSettings] = useState<LendingSettingsOut | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    void controller.api?.lendingSettings().then(setSettings, (error: unknown) => {
      console.warn("could not load the lending settings", error);
      setFailed(true);
    });
  }, [controller.api]);
  return (
    <div className="p-4">
      <p className="mb-3 text-sm text-muted">{t("lending.adminIntro")}</p>
      {settings ? <LendingSettingsForm controller={controller} settings={settings} onSaved={setSettings} /> : <p className="text-sm text-muted">{failed ? t("common.loadFailed") : t("common.loading")}</p>}
    </div>
  );
}
