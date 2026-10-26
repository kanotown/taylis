// @vitest-environment jsdom
// M173 (docs/LENDING.md §5.4, §13.5, §17.7): 「備品」's CSV and QR labels on Desktop / Web — the import dialog (the dry
// run's counts, errors and diff table; 「取り込む」 sends the same file for real; the server's line errors after it), the
// diff's wording, the QR matrix and the label sheets (24 a page, names escaped), the `/eq/<id>` link and entry route,
// and the numbers read from GET /lending/summary after lending.updated (the M170 way for an older server).
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError, describeError } from "../src/api/errors";
import type { LendingImportOut, LendingSummaryOut, UserMe } from "../src/api/types";
import type { AppController } from "../src/state/app";
import { SyncEngine } from "../src/sync/engine";
import { Store } from "../src/sync/store";
import { changeLines, csvErrors, ImportDialog, importValue } from "../src/ui/LendingCsv";
import { escapeHtml, labelPages, labelSheetDocument, labelSheetMarkup, qrModules, qrSvg } from "../src/ui/LendingLabels";
import { equipmentLink, parseEquipmentLink, parseEventLink } from "../src/ui/permalink";
import { parseEntryPath } from "../src/ui/routes";
import { FakeServer } from "./fakeServer";

afterEach(() => cleanup());

const ITEM = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const settle = async (times = 4) => {
  for (let i = 0; i < times; i++) await act(async () => { await Promise.resolve(); });
};

function controllerWith(api: Record<string, unknown>) {
  const store = new Store();
  store.setMe({ id: "me", username: "me", display_name: "わたし", role: "member", capabilities: [] } as unknown as UserMe);
  const controller = {
    store,
    api,
    setError: vi.fn(),
    describe: (error: unknown) => describeError(error),
    subscribe: () => () => {},
  } as unknown as AppController;
  return controller;
}

const DRY: LendingImportOut = {
  dry_run: true,
  created: 1,
  updated: 1,
  unchanged: 1,
  skipped: 1,
  new_categories: ["カメラ"],
  errors: [],
  rows: [
    { line: 2, action: "created", item_id: null, name: "カメラ A", code: "CAM-01", changes: [{ field: "name", before: null, after: "カメラ A" }, { field: "category", before: null, after: "カメラ" }, { field: "location", before: null, after: null }] },
    { line: 3, action: "updated", item_id: "t", name: "三脚", code: "TRI-1", changes: [{ field: "location", before: "棚 A", after: "棚 B" }, { field: "requires_permission", before: null, after: "false" }] },
    { line: 4, action: "unchanged", item_id: "u", name: "本", code: "B-1", changes: [] },
    { line: 5, action: "skipped", item_id: null, name: "古いもの", code: "OLD-1", changes: [] },
  ],
};

describe("the import's wording", () => {
  it("writes each change the way a person reads it", () => {
    expect(importValue({ field: "requires_permission" }, "true")).toBe("要る");
    expect(importValue({ field: "requires_permission" }, null)).toBe("既定");
    expect(importValue({ field: "max_days" }, "7")).toBe("最長 7 日");
    expect(importValue({ field: "max_days" }, null)).toBe("既定");
    expect(importValue({ field: "location" }, null)).toBe("（空）");
    expect(importValue({ field: "notes" }, "充電器\nケース")).toBe("充電器 / ケース");
    expect(changeLines(DRY.rows[0]!)).toEqual(["名前：カメラ A", "分類：カメラ"]);
    expect(changeLines(DRY.rows[1]!)).toEqual(["置き場所：棚 A → 棚 B", "許可が要る：既定 → 要らない"]);
  });

  it("reads the server's line errors from a 400 lending_csv_invalid only", () => {
    const errors = [{ line: 3, code: "code_duplicate", message: "管理番号「A-1」が 2 行目にもあります。" }];
    expect(csvErrors(new ApiError(400, "lending_csv_invalid", "x", { errors }))).toEqual(errors);
    expect(csvErrors(new ApiError(400, "validation_error", "x", { errors }))).toBeNull();
    expect(csvErrors(new Error("x"))).toBeNull();
  });
});

describe("the import dialog", () => {
  const file = new File(["管理番号,名前\r\n"], "items.csv", { type: "text/csv" });

  it("shows the dry run and applies the same file", async () => {
    const applied = { ...DRY, dry_run: false };
    const importLendingItems = vi.fn(async () => applied);
    const controller = controllerWith({ importLendingItems });
    const onDone = vi.fn();
    render(<ImportDialog controller={controller} file={file} result={DRY} errors={[]} onClose={() => {}} onDone={onDone} />);
    expect(document.querySelector("[data-import-summary]")?.textContent).toBe("新しく作る 1 件・変える 1 件・変わらない 1 件・飛ばす（廃棄）1 件");
    expect(document.querySelector("[data-import-categories]")?.textContent).toBe("新しい分類：カメラ");
    const rows = () => [...document.querySelectorAll("[data-import-row]")].map((row) => row.getAttribute("data-action"));
    expect(rows()).toEqual(["created", "updated"]); // the unchanged and skipped rows only on asking
    fireEvent.click(screen.getByLabelText("変わらない行も表示"));
    expect(rows()).toEqual(["created", "updated", "unchanged", "skipped"]);
    fireEvent.click(screen.getByRole("button", { name: "取り込む（2 件）" }));
    await settle();
    expect(importLendingItems).toHaveBeenCalledWith(file, false, "items.csv");
    expect(onDone).toHaveBeenCalledWith(applied);
  });

  it("cannot apply while a line has an error, and shows the errors the server finds when applying", async () => {
    const lines = [{ line: 4, code: "name_required", message: "「名前」が空です。" }];
    const { unmount } = render(<ImportDialog controller={controllerWith({})} file={file} result={{ ...DRY, errors: lines }} errors={lines} onClose={() => {}} onDone={() => {}} />);
    expect((screen.getByRole("button", { name: /取り込む/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("alert").textContent).toContain("4 行目");
    unmount();

    const later = [{ line: 2, code: "code_duplicate", message: "管理番号「CAM-01」が 3 行目にもあります。" }];
    const importLendingItems = vi.fn(async () => {
      throw new ApiError(400, "lending_csv_invalid", "x", { errors: later });
    });
    const controller = controllerWith({ importLendingItems });
    const onDone = vi.fn();
    render(<ImportDialog controller={controller} file={file} result={DRY} errors={[]} onClose={() => {}} onDone={onDone} />);
    fireEvent.click(screen.getByRole("button", { name: "取り込む（2 件）" }));
    await settle();
    expect(onDone).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toContain("管理番号「CAM-01」が 3 行目にもあります。");
    expect(controller.setError).not.toHaveBeenCalled();
  });

  it("says when nothing would change", () => {
    const same: LendingImportOut = { ...DRY, created: 0, updated: 0, unchanged: 1, skipped: 0, new_categories: [], rows: [DRY.rows[2]!] };
    render(<ImportDialog controller={controllerWith({})} file={file} result={same} errors={[]} onClose={() => {}} onDone={() => {}} />);
    expect(screen.getByText("変わるものはありません。")).toBeTruthy();
    expect((screen.getByRole("button", { name: "取り込む（0 件）" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("the labels", () => {
  const link = equipmentLink("https://chat.example.ac.jp/", ITEM);

  it("links the item under /eq/, which the browser opens in 「備品」 (/e/ stays the calendar's)", () => {
    expect(link).toBe(`https://chat.example.ac.jp/eq/${ITEM}`);
    expect(parseEquipmentLink("https://chat.example.ac.jp", link)).toBe(ITEM);
    expect(parseEquipmentLink("https://chat.example.ac.jp", `https://CHAT.example.ac.jp/eq/${ITEM.toUpperCase()}?x=1`)).toBe(ITEM);
    expect(parseEquipmentLink("https://other.example", link)).toBeNull();
    expect(parseEventLink("https://chat.example.ac.jp", link)).toBeNull();
    expect(parseEventLink("https://chat.example.ac.jp", `https://chat.example.ac.jp/e/${ITEM}`)).toBe(ITEM);
    expect(parseEntryPath(`/eq/${ITEM}`)).toEqual({ kind: "equipment", id: ITEM });
    expect(parseEntryPath(`/e/${ITEM}`)).toEqual({ kind: "event", id: ITEM });
    expect(parseEntryPath("/eq/not-an-id")).toBeNull();
  });

  it("makes a QR code: a square of 21 + 4k modules with the three finder patterns", () => {
    const modules = qrModules(link);
    const size = modules.length;
    expect((size - 21) % 4).toBe(0);
    expect(size).toBeGreaterThanOrEqual(29);
    expect(modules.every((row) => row.length === size)).toBe(true);
    const finder = (top: number, left: number) => [0, 1, 2, 3, 4, 5, 6].every((i) => modules[top]![left + i] && modules[top + 6]![left + i] && modules[top + i]![left] && modules[top + i]![left + 6]);
    expect(finder(0, 0) && finder(0, size - 7) && finder(size - 7, 0)).toBe(true);
    expect(modules[size - 1]![size - 1]).toBeTypeOf("boolean");
    expect(qrModules(link)).toEqual(modules); // the same link, the same code
    const svg = qrSvg(link);
    expect(svg).toContain(`viewBox="0 0 ${size + 4} ${size + 4}"`);
    expect(svg.match(/h1v1h-1z/g)?.length).toBe(modules.flat().filter(Boolean).length);
  });

  it("lays out 24 labels a page, the names and numbers escaped", () => {
    const items = Array.from({ length: 25 }, (_, n) => ({ id: `${ITEM.slice(0, -2)}${String(n).padStart(2, "0")}`, name: n === 0 ? "<b>カメラ</b> & \"A\"" : `備品 ${n}`, code: n === 0 ? "CAM-01" : null }));
    expect(labelPages(items).map((page) => page.length)).toEqual([24, 1]);
    const markup = labelSheetMarkup("https://chat.example.ac.jp", items);
    expect(markup.match(/class="page"/g)?.length).toBe(2);
    expect(markup.match(/class="label"/g)?.length).toBe(25);
    expect(markup).toContain(escapeHtml("<b>カメラ</b> & \"A\""));
    expect(markup).not.toContain("<b>カメラ</b>");
    expect(markup).toContain('<div class="code">CAM-01</div>');
    const doc = labelSheetDocument("https://chat.example.ac.jp", items.slice(0, 1));
    expect(doc.startsWith("<!doctype html>")).toBe(true);
    expect(doc).toContain("@page { size: A4; margin: 0; }");
  });
});

describe("the numbers after lending.updated", () => {
  const SUMMARY: LendingSummaryOut = { enabled: true, is_keeper: true, my_active_count: 2, my_overdue_count: 1, keeper_attention_count: 3, settings_updated_at: null };

  async function engineWith(api: Record<string, unknown>) {
    const server = new FakeServer();
    const bob = server.addUser("bob");
    const store = new Store();
    const base = server.apiFor(bob.id) as unknown as Record<string, unknown>;
    const engine = new SyncEngine(
      { api: Object.assign(base, api) as never, connect: server.connectorFor(bob.id), store, getAccessToken: () => "token", sleep: async () => {}, random: () => 0.5 },
      { pageSize: 3, gapLimit: 5, reconnectMinMs: 0 },
    );
    return { server, store, engine };
  }

  it("reads GET /lending/summary, not the settings and the loans", async () => {
    const lendingSummary = vi.fn(async (): Promise<LendingSummaryOut | null> => SUMMARY);
    const lendingLoans = vi.fn(async () => []);
    const { server, store, engine } = await engineWith({ lendingSummary, lendingLoans });
    await engine.start();
    await engine.idle();
    server.emitLendingUpdated();
    await new Promise((resolve) => setTimeout(resolve, 350));
    await engine.idle();
    expect(lendingSummary).toHaveBeenCalledTimes(1);
    expect(lendingLoans).not.toHaveBeenCalled();
    expect(store.lending).toEqual(SUMMARY);
    // Turned off: null, and the item goes.
    lendingSummary.mockResolvedValueOnce(null);
    server.emitLendingUpdated({ settings: true });
    await new Promise((resolve) => setTimeout(resolve, 350));
    await engine.idle();
    expect(store.lending).toBeNull();
    engine.stop();
  });

  it("works them out from the loans on a server without the route", async () => {
    const lendingSummary = vi.fn(async () => {
      throw new ApiError(404, "not_found", "Not found");
    });
    const { server, store, engine } = await engineWith({ lendingSummary });
    await engine.start();
    await engine.idle();
    server.lendingSettings = { enabled: true, keeper_ids: [], default_max_days: 14, max_extensions: 2, keeper_overdue_days: 3, notice_minute: 540, tz: "Asia/Tokyo", is_keeper: false, updated_at: null };
    server.emitLendingUpdated();
    await new Promise((resolve) => setTimeout(resolve, 350));
    await engine.idle();
    expect(lendingSummary).toHaveBeenCalledTimes(1);
    expect(server.lendingReads).toBe(1);
    expect(store.lending).toMatchObject({ my_active_count: 0, my_overdue_count: 0 });
    engine.stop();
  });
});
