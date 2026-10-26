/**
 * M173 (docs/LENDING.md §5.4, §12.2, §17.7): 「管理 → CSV」 for keepers. 「書き出す」 saves the ledger (UTF-8 with a BOM,
 * which Excel opens); 「取り込む…」 sends the chosen file as a dry run first and shows what it would do — counts, the new
 * categories, every line's errors and a table of the rows with their changes — and 「取り込む」 applies it in one go
 * (the server checks the file again; while any line has an error nothing is imported).
 */
import { Download, Upload } from "lucide-react";
import { useMemo, useRef, useState } from "react";

import { ApiError } from "../api/errors";
import type { LendingImportChangeOut, LendingImportErrorOut, LendingImportOut, LendingImportRowOut } from "../api/types";
import { t } from "../i18n";
import type { AppController } from "../state/app";
import { Button, cn, Modal } from "./primitives";

/** A changed value as the diff table writes it (the server sends permission as "true" / "false", days as digits). */
export function importValue(change: Pick<LendingImportChangeOut, "field">, value: string | null): string {
  if (change.field === "requires_permission") {
    if (value === "true") return t("lending.import.value.yes");
    if (value === "false") return t("lending.import.value.no");
    return t("lending.import.value.default");
  }
  if (change.field === "max_days") return value === null ? t("lending.import.value.default") : t("lending.maxDays", { count: Number(value) });
  if (value === null || value === "") return t("lending.import.value.empty");
  const line = value.replace(/\s*\n\s*/g, " / ");
  return line.length > 60 ? `${line.slice(0, 59)}…` : line;
}

/** 「置き場所：棚 A → 棚 B」, one per change (a new item lists only the fields it fills). */
export function changeLines(row: Pick<LendingImportRowOut, "action" | "changes">): string[] {
  return (row.changes ?? [])
    .filter((change) => row.action !== "created" || change.after !== null)
    .map((change) => {
      const label = t(`lending.import.field.${change.field}`);
      const after = importValue(change, change.after);
      return row.action === "created" ? t("lending.labelled", { label }) + after : `${t("lending.labelled", { label })}${importValue(change, change.before)} → ${after}`;
    });
}

/** How many rows the import would write (created + updated). */
export function importCount(result: Pick<LendingImportOut, "created" | "updated">): number {
  return result.created + result.updated;
}

/** The server's line errors from a 400 lending_csv_invalid (dry run or apply), else null. */
export function csvErrors(error: unknown): LendingImportErrorOut[] | null {
  if (!(error instanceof ApiError) || error.code !== "lending_csv_invalid") return null;
  const details = error.details as { errors?: LendingImportErrorOut[] } | undefined;
  return Array.isArray(details?.errors) ? details.errors : null;
}

function stamp(): string {
  const now = new Date();
  return `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;
}

/** The CSV part of 「管理」. */
export function LendingCsvSection({ controller, onChanged }: { controller: AppController; onChanged: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<"export" | "check" | null>(null);
  const [pending, setPending] = useState<{ file: File; result: LendingImportOut | null; errors: LendingImportErrorOut[] } | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const exportCsv = async () => {
    const api = controller.api;
    if (!api) return;
    setBusy("export");
    try {
      await controller.saveFile(`equipment-${stamp()}.csv`, await api.exportLendingItems());
    } catch (error) {
      controller.setError(error);
    } finally {
      setBusy(null);
    }
  };

  const check = async (file: File) => {
    const api = controller.api;
    if (!api) return;
    setBusy("check");
    setDone(null);
    try {
      const result = await api.importLendingItems(file, true, file.name);
      setPending({ file, result, errors: result.errors });
    } catch (error) {
      const errors = csvErrors(error);
      if (errors) setPending({ file, result: null, errors });
      else controller.setError(error);
    } finally {
      setBusy(null);
    }
  };

  return (
    <section aria-label={t("lending.csv")} data-lending-csv>
      <h3 className="text-xs font-semibold text-muted">{t("lending.csv")}</h3>
      <p className="mt-0.5 text-xs text-muted">{t("lending.csvNote")}</p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => void exportCsv()}>
          <Download size={14} /> {t("lending.csvExport")}
        </Button>
        <Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => input.current?.click()}>
          <Upload size={14} /> {busy === "check" ? t("lending.csvChecking") : t("lending.csvImport")}
        </Button>
        <input
          ref={input}
          type="file"
          accept=".csv,text/csv"
          className="hidden"
          data-lending-csv-file
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file) void check(file);
          }}
        />
        {done && <span className="text-xs text-muted" role="status">{done}</span>}
      </div>
      {pending && (
        <ImportDialog
          controller={controller}
          file={pending.file}
          result={pending.result}
          errors={pending.errors}
          onClose={() => setPending(null)}
          onDone={(applied) => {
            setPending(null);
            setDone(t("lending.import.done", { created: applied.created, updated: applied.updated }));
            onChanged();
          }}
        />
      )}
    </section>
  );
}

const ACTION_TONE: Record<LendingImportRowOut["action"], string> = {
  created: "text-emerald-700 dark:text-emerald-400",
  updated: "text-accent",
  unchanged: "text-muted",
  skipped: "text-muted",
};

/** The dry run's report and 「取り込む」. */
export function ImportDialog({ controller, file, result, errors: initialErrors, onClose, onDone }: {
  controller: AppController;
  file: File;
  result: LendingImportOut | null;
  errors: LendingImportErrorOut[];
  onClose: () => void;
  onDone: (applied: LendingImportOut) => void;
}) {
  const [errors, setErrors] = useState(initialErrors);
  const [showUnchanged, setShowUnchanged] = useState(false);
  const [sending, setSending] = useState(false);
  const rows = useMemo(() => (result?.rows ?? []).filter((row) => showUnchanged || row.action === "created" || row.action === "updated"), [result, showUnchanged]);
  const count = result ? importCount(result) : 0;

  const apply = async () => {
    const api = controller.api;
    if (!api || !result) return;
    setSending(true);
    try {
      onDone(await api.importLendingItems(file, false, file.name));
    } catch (error) {
      const lines = csvErrors(error);
      if (lines) setErrors(lines);
      else controller.setError(error);
    } finally {
      setSending(false);
    }
  };

  return (
    <Modal onClose={onClose} title={t("lending.import.title")} description={file.name} className="w-[760px]">
      <div className="space-y-3 text-sm" data-lending-import>
        {result && (
          <p data-import-summary>
            {t("lending.import.summary", { created: result.created, updated: result.updated, unchanged: result.unchanged, skipped: result.skipped })}
          </p>
        )}
        {result && result.new_categories.length > 0 && (
          <p className="text-xs text-muted" data-import-categories>{t("lending.import.newCategories", { names: result.new_categories.join(t("common.listSeparator")) })}</p>
        )}
        {errors.length > 0 && (
          <div role="alert" className="rounded-lg border border-rose-300 px-3 py-2 dark:border-rose-800" data-import-errors>
            <p className="font-medium text-rose-700 dark:text-rose-400">{t("lending.import.errors", { count: errors.length })}</p>
            <ul className="mt-1 max-h-40 space-y-0.5 overflow-y-auto text-xs">
              {errors.map((error, index) => (
                <li key={index} data-import-error={error.line}>
                  <span className="text-muted">{error.line > 0 ? t("lending.import.line", { line: error.line }) : t("lending.import.wholeFile")}</span>　{error.message}
                </li>
              ))}
            </ul>
          </div>
        )}
        {result && (
          <>
            <label className="flex items-center gap-2 text-xs text-muted">
              <input type="checkbox" checked={showUnchanged} onChange={(e) => setShowUnchanged(e.target.checked)} />
              {t("lending.import.showUnchanged")}
            </label>
            {rows.length === 0 ? (
              <p className="text-muted">{t("lending.import.nothing")}</p>
            ) : (
              <div className="max-h-[45dvh] overflow-auto rounded-lg border border-line">
                <table className="w-full text-left text-xs" data-import-table>
                  <thead className="sticky top-0 bg-panel text-muted">
                    <tr>
                      <th className="px-2 py-1.5 font-medium">{t("lending.import.col.line")}</th>
                      <th className="px-2 py-1.5 font-medium">{t("lending.import.col.action")}</th>
                      <th className="px-2 py-1.5 font-medium">{t("lending.code")}</th>
                      <th className="px-2 py-1.5 font-medium">{t("lending.name")}</th>
                      <th className="px-2 py-1.5 font-medium">{t("lending.import.col.changes")}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {rows.map((row) => (
                      <tr key={row.line} data-import-row={row.line} data-action={row.action} className="align-top">
                        <td className="px-2 py-1.5 tabular-nums text-muted">{row.line}</td>
                        <td className={cn("whitespace-nowrap px-2 py-1.5 font-medium", ACTION_TONE[row.action])}>{t(`lending.import.action.${row.action}`)}</td>
                        <td className="whitespace-nowrap px-2 py-1.5">{row.code ?? ""}</td>
                        <td className="px-2 py-1.5">{row.name}</td>
                        <td className="px-2 py-1.5 text-muted">
                          {changeLines(row).map((line, index) => <div key={index}>{line}</div>)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
        <div className="flex justify-end gap-2 pt-1">
          <Button size="sm" variant="secondary" onClick={onClose}>{t("common.cancel")}</Button>
          <Button size="sm" disabled={!result || errors.length > 0 || count === 0 || sending} onClick={() => void apply()}>
            {t("lending.import.apply", { count })}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
