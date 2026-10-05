/**
 * M115 (docs/I18N.md): the dictionaries and t(). Every key in every locale with the same parameters, the formatter's
 * parameters and plurals, the locale rules, and no lookup while a module loads (it would stay in the start's language).
 */
import { afterEach, describe, expect, it } from "vitest";

import { deviceLocale, format, importTimeCalls, intlLocale, labelled, markStarted, normalizeLocale, setLocale, t, tIn, type MessageKey } from "../src/i18n";
import { en } from "../src/i18n/en";
import { ja } from "../src/i18n/ja";
import { zhHans } from "../src/i18n/zhHans";

const BRANCH = /(?:=\d+|zero|one|two|few|many|other)\s*\{/g;
const PARAM = /\{(\w+)(?=\}|\s*,)/g;
const params = (text: string) => new Set([...text.replace(BRANCH, "(").matchAll(PARAM)].map((m) => m[1]));

afterEach(() => setLocale("ja"));

describe("dictionaries", () => {
  it("every key is in every locale, with text, and nothing else", () => {
    const keys = Object.keys(ja).sort();
    expect(Object.keys(en).sort()).toEqual(keys);
    expect(Object.keys(zhHans).sort()).toEqual(keys);
    for (const dict of [ja, en, zhHans] as const) {
      for (const [key, text] of Object.entries(dict)) expect(text, key).not.toBe("");
    }
  });

  it("a translation uses the same parameters as the Japanese text", () => {
    for (const key of Object.keys(ja) as MessageKey[]) {
      const want = params(ja[key]);
      expect(params(en[key]), `en ${key}`).toEqual(want);
      expect(params(zhHans[key]), `zh-Hans ${key}`).toEqual(want);
    }
  });

  it("English and Chinese texts are not left in Japanese (kana)", () => {
    const kana = /[぀-ヿ]/;
    // Names and examples that are Japanese on purpose.
    const allowed = new Set<string>(["settings.profile.readingPlaceholder"]);
    for (const key of Object.keys(ja) as MessageKey[]) {
      if (allowed.has(key)) continue;
      expect(kana.test(en[key]), `en ${key}: ${en[key]}`).toBe(false);
      expect(kana.test(zhHans[key]), `zh-Hans ${key}: ${zhHans[key]}`).toBe(false);
    }
  });
});

describe("t and format", () => {
  it("parameters and plurals", () => {
    expect(format("{n} 件", { n: 3 })).toBe("3 件");
    expect(format("{count, plural, one {# reply} other {# replies}}", { count: 1 }, "en")).toBe("1 reply");
    expect(format("{count, plural, one {# reply} other {# replies}}", { count: 4 }, "en")).toBe("4 replies");
    expect(format("{count, plural, =0 {none} other {# of {name}}}", { count: 0, name: "x" }, "en")).toBe("none");
    expect(format("{count, plural, =0 {none} other {# of {name}}}", { count: 2, name: "x" }, "en")).toBe("2 of x");
    expect(format("missing {who}", {})).toBe("missing {who}");
  });

  it("follows the locale", () => {
    expect(t("common.cancel")).toBe("キャンセル");
    setLocale("en");
    expect(t("common.cancel")).toBe("Cancel");
    setLocale("zh-Hans");
    expect(t("common.cancel")).toBe("取消");
    expect(tIn("ja", "common.cancel")).toBe("キャンセル");
    const pair = labelled("x", "common.cancel");
    expect(pair[1]).toBe("取消");
    setLocale("en");
    expect(pair).toEqual(["x", "Cancel"]);
  });

  it("locale rules", () => {
    expect(normalizeLocale("en-GB")).toBe("en");
    expect(normalizeLocale("zh-TW")).toBe("zh-Hans");
    expect(normalizeLocale("ja_JP")).toBe("ja");
    expect(normalizeLocale("fr")).toBeNull();
    expect(deviceLocale(["fr-FR", "zh-CN", "en"])).toBe("zh-Hans");
    expect(deviceLocale(["de"])).toBe("ja");
    expect(intlLocale("en")).toBe("en-US");
  });
});

describe("no lookups while modules load", () => {
  it("importing every module of the app calls t() nowhere", async () => {
    const before = importTimeCalls.length;
    await Promise.all(Object.values(import.meta.glob(["../src/**/*.{ts,tsx}", "!../src/main.tsx", "!../src/**/*.d.ts"])).map((load) => load()));
    expect(importTimeCalls.slice(before)).toEqual([]);
    markStarted();
  });
});
