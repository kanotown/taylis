// @vitest-environment jsdom
/**
 * The send key (tester, 2026-09-30): ⌘+Enter on a Mac, Ctrl+Enter on Windows, by default; Enter and Shift+Enter stay
 * as choices, and a choice made before keeps.
 */
import { afterEach, expect, it } from "vitest";

import { isSendKey, readSendKey, sendKeyLabel, writeSendKey } from "../src/ui/prefs";

afterEach(() => localStorage.clear());

const key = (extra: { shiftKey?: boolean; metaKey?: boolean; ctrlKey?: boolean } = {}) => ({ key: "Enter", shiftKey: false, ...extra });

it("defaults to ⌘/Ctrl+Enter; an earlier choice keeps", () => {
  expect(readSendKey()).toBe("mod-enter");
  writeSendKey("shift-enter");
  expect(readSendKey()).toBe("shift-enter");
  writeSendKey("enter");
  expect(readSendKey()).toBe("enter");
});

it("mod-enter sends with ⌘ or Ctrl only; Enter and Shift+Enter are newlines", () => {
  expect(isSendKey(key({ metaKey: true }), "mod-enter")).toBe(true);
  expect(isSendKey(key({ ctrlKey: true }), "mod-enter")).toBe(true);
  expect(isSendKey(key(), "mod-enter")).toBe(false);
  expect(isSendKey(key({ shiftKey: true }), "mod-enter")).toBe(false);
  expect(isSendKey({ key: "a", shiftKey: false, metaKey: true }, "mod-enter")).toBe(false);
});

it("the other choices ignore ⌘/Ctrl+Enter", () => {
  expect(isSendKey(key(), "enter")).toBe(true);
  expect(isSendKey(key({ shiftKey: true }), "enter")).toBe(false);
  expect(isSendKey(key({ metaKey: true }), "enter")).toBe(false);
  expect(isSendKey(key({ shiftKey: true }), "shift-enter")).toBe(true);
  expect(isSendKey(key(), "shift-enter")).toBe(false);
});

it("labels name the platform's key", () => {
  expect(sendKeyLabel("mod-enter").newline).toBe("Enter");
  expect(sendKeyLabel("mod-enter").send).toMatch(/^(⌘|Ctrl)\+Enter$/);
});
