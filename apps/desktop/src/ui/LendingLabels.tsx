/**
 * M173 (docs/LENDING.md §13.5, §17.7): 「管理 → QR のラベル」 for keepers. The chosen items' labels — name, control number
 * and a QR code of the item's link `<server>/eq/<id>` — on A4 sheets of 24 labels (3 × 8, 70 × 37 mm, the common
 * Japanese label paper). 「印刷」 prints them from this page (everything else is hidden while printing); 「HTML で保存」
 * keeps the same sheets as a file to print from a browser, for an app window that cannot print. A phone's camera opens
 * the link in the browser, which shows the item in 「備品」 (the Web client's `/eq/` route); the server's page at that
 * path says nothing about the item.
 *
 * The QR code comes from qrcode-generator (MIT, no dependencies, pinned): the matrix only, drawn here as an SVG path.
 */
import qrcode from "qrcode-generator";
import { Printer, QrCode, Save } from "lucide-react";
import { useMemo, useState } from "react";
import { createPortal } from "react-dom";

import type { LendingCategoryOut, LendingItemOut } from "../api/types";
import { t } from "../i18n";
import type { AppController } from "../state/app";
import { equipmentLink } from "./permalink";
import { Button, Modal } from "./primitives";

export const LABELS_PER_PAGE = 24;
const PRINT_ROOT = "lending-labels-print";

/** The QR code's modules (true = dark), error correction M (the label may get scuffed). */
export function qrModules(text: string): boolean[][] {
  const qr = qrcode(0, "M");
  qr.addData(text, "Byte");
  qr.make();
  const size = qr.getModuleCount();
  return Array.from({ length: size }, (_, row) => Array.from({ length: size }, (_, col) => qr.isDark(row, col)));
}

/** An SVG of the QR code with a quiet zone of `margin` modules; it scales to whatever box it is put in. */
export function qrSvg(text: string, margin = 2): string {
  const modules = qrModules(text);
  const size = modules.length + margin * 2;
  let path = "";
  modules.forEach((row, y) => {
    row.forEach((dark, x) => {
      if (dark) path += `M${x + margin} ${y + margin}h1v1h-1z`;
    });
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges"><rect width="${size}" height="${size}" fill="#fff"/><path d="${path}" fill="#000"/></svg>`;
}

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
}

/** The items in pages of 24. */
export function labelPages<T>(items: readonly T[]): T[][] {
  const pages: T[][] = [];
  for (let at = 0; at < items.length; at += LABELS_PER_PAGE) pages.push(items.slice(at, at + LABELS_PER_PAGE));
  return pages;
}

const SHEET_CSS = `
.lending-labels .page { width: 210mm; height: 297mm; box-sizing: border-box; padding: 0.5mm 0; display: grid; grid-template-columns: repeat(3, 70mm); grid-template-rows: repeat(8, 37mm); break-after: page; page-break-after: always; overflow: hidden; }
.lending-labels .page:last-child { break-after: auto; page-break-after: auto; }
.lending-labels .label { box-sizing: border-box; padding: 3mm 3mm 3mm 3.5mm; display: flex; gap: 2.5mm; align-items: center; overflow: hidden; font-family: "Noto Sans JP", system-ui, sans-serif; color: #000; }
.lending-labels .qr { width: 29mm; height: 29mm; flex: none; }
.lending-labels .qr svg { width: 100%; height: 100%; display: block; }
.lending-labels .text { min-width: 0; display: flex; flex-direction: column; gap: 1mm; }
.lending-labels .name { font-size: 10pt; font-weight: 700; line-height: 1.25; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; word-break: break-all; }
.lending-labels .code { font-size: 9pt; font-family: ui-monospace, "JetBrains Mono", monospace; word-break: break-all; }
`;

/** The sheets' markup (the items' names and numbers escaped). */
export function labelSheetMarkup(baseUrl: string, items: readonly Pick<LendingItemOut, "id" | "name" | "code">[]): string {
  const pages = labelPages(items).map((page) => {
    const labels = page
      .map((item) => {
        const code = item.code ? `<div class="code">${escapeHtml(item.code)}</div>` : "";
        const alt = escapeHtml(t("lending.labels.qrAlt", { name: item.name }));
        return `<div class="label" data-label="${escapeHtml(item.id)}"><div class="qr" role="img" aria-label="${alt}">${qrSvg(equipmentLink(baseUrl, item.id))}</div><div class="text"><div class="name">${escapeHtml(item.name)}</div>${code}</div></div>`;
      })
      .join("");
    return `<div class="page">${labels}</div>`;
  });
  return `<div class="lending-labels">${pages.join("")}</div>`;
}

/** A whole document of the sheets, for 「HTML で保存」. */
export function labelSheetDocument(baseUrl: string, items: readonly Pick<LendingItemOut, "id" | "name" | "code">[]): string {
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>${escapeHtml(t("lending.labels"))}</title><style>@page { size: A4; margin: 0; } html, body { margin: 0; background: #fff; }${SHEET_CSS}</style></head><body>${labelSheetMarkup(baseUrl, items)}</body></html>`;
}

// While printing, only the sheets: the app (and the dialog, a portal of its own) is hidden.
const PRINT_CSS = `
@media screen { #${PRINT_ROOT} { display: none; } }
@media print {
  @page { size: A4; margin: 0; }
  html, body { height: auto !important; overflow: visible !important; background: #fff !important; }
  body > *:not(#${PRINT_ROOT}) { display: none !important; }
  #${PRINT_ROOT} { display: block !important; }
}
${SHEET_CSS}`;

/** The label sheet dialog: choose the items, then print or save. */
export function LabelsDialog({ controller, items, categories, onClose }: {
  controller: AppController;
  items: LendingItemOut[];
  categories: LendingCategoryOut[];
  onClose: () => void;
}) {
  const usable = useMemo(() => items.filter((item) => item.status !== "retired"), [items]);
  const [category, setCategory] = useState<string>("all");
  const [chosen, setChosen] = useState<Set<string>>(() => new Set(usable.map((item) => item.id)));
  const shown = usable.filter((item) => category === "all" || (category === "none" ? item.category_id === null : item.category_id === category));
  const picked = usable.filter((item) => chosen.has(item.id));
  const pages = labelPages(picked).length;
  const baseUrl = controller.api?.baseUrl ?? location.origin;
  const markup = useMemo(() => labelSheetMarkup(baseUrl, picked), [baseUrl, picked]);
  const toggle = (id: string, on: boolean) => setChosen((now) => {
    const next = new Set(now);
    if (on) next.add(id);
    else next.delete(id);
    return next;
  });
  const setAll = (on: boolean) => setChosen((now) => {
    const next = new Set(now);
    for (const item of shown) {
      if (on) next.add(item.id);
      else next.delete(item.id);
    }
    return next;
  });
  const save = () => void controller.saveFile("equipment-labels.html", new Blob([labelSheetDocument(baseUrl, picked)], { type: "text/html" }));

  return (
    <Modal onClose={onClose} title={t("lending.labels")} description={t("lending.labelsNote")} className="w-[640px]">
      <div className="space-y-3 text-sm" data-lending-labels>
        <div className="flex flex-wrap items-center gap-2">
          <select aria-label={t("lending.col.category")} className="rounded-lg border border-line bg-canvas px-2 py-1.5 text-sm" value={category} onChange={(e) => setCategory(e.target.value)}>
            <option value="all">{t("lending.category.all")}</option>
            {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            <option value="none">{t("lending.category.none")}</option>
          </select>
          <Button size="sm" variant="ghost" onClick={() => setAll(true)}>{t("lending.labels.selectAll")}</Button>
          <Button size="sm" variant="ghost" onClick={() => setAll(false)}>{t("lending.labels.selectNone")}</Button>
          <span className="ml-auto text-xs text-muted" data-labels-count>{t("lending.labels.selected", { count: picked.length, pages })}</span>
        </div>
        {shown.length === 0 ? (
          <p className="text-muted">{t("lending.labels.empty")}</p>
        ) : (
          <ul className="max-h-[40dvh] divide-y divide-line overflow-y-auto rounded-lg border border-line">
            {shown.map((item) => (
              <li key={item.id}>
                <label className="flex items-center gap-2 px-3 py-1.5">
                  <input type="checkbox" checked={chosen.has(item.id)} onChange={(e) => toggle(item.id, e.target.checked)} data-label-item={item.id} />
                  <span className="min-w-0 flex-1 truncate">{item.name}</span>
                  {item.code && <span className="shrink-0 font-mono text-xs text-muted">{item.code}</span>}
                </label>
              </li>
            ))}
          </ul>
        )}
        <p className="text-xs text-muted">{t("lending.labels.saveHtmlNote")}</p>
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="secondary" onClick={onClose}>{t("common.cancel")}</Button>
          <Button size="sm" variant="secondary" disabled={picked.length === 0} onClick={save}><Save size={14} /> {t("lending.labels.saveHtml")}</Button>
          <Button size="sm" disabled={picked.length === 0} onClick={() => window.print()}><Printer size={14} /> {t("lending.labels.print")}</Button>
        </div>
      </div>
      {createPortal(
        <div id={PRINT_ROOT}>
          <style>{PRINT_CSS}</style>
          <div dangerouslySetInnerHTML={{ __html: markup }} />
        </div>,
        document.body,
      )}
    </Modal>
  );
}

/** The labels part of 「管理」. */
export function LendingLabelsSection({ controller, items, categories }: { controller: AppController; items: LendingItemOut[]; categories: LendingCategoryOut[] }) {
  const [open, setOpen] = useState(false);
  return (
    <section aria-label={t("lending.labels")} data-lending-labels-section>
      <h3 className="text-xs font-semibold text-muted">{t("lending.labels")}</h3>
      <p className="mt-0.5 text-xs text-muted">{t("lending.labelsNote")}</p>
      <div className="mt-2">
        <Button size="sm" variant="secondary" onClick={() => setOpen(true)}><QrCode size={14} /> {t("lending.labels.make")}</Button>
      </div>
      {open && <LabelsDialog controller={controller} items={items} categories={categories} onClose={() => setOpen(false)} />}
    </section>
  );
}
