/** M115: the tests read the Japanese texts (the source language), whatever the machine's language is. */
import { afterEach } from "vitest";
import { setLocale } from "../src/i18n";

setLocale("ja");

// ui/ime.ts treats the keydown right after a compositionend as the IME's until the next keyup (or a short grace): a test
// that ends just after a compositionend must not hand that to the next test.
afterEach(() => {
  if (typeof document !== "undefined") document.dispatchEvent(new KeyboardEvent("keyup"));
});
