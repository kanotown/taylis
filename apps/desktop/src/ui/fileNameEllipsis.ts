/**
 * A long attachment / file name is shortened in its middle so the extension stays visible
 * (「研究報告書_最終版_修正…2026年度.pdf」, 2026-10-07). CSS cannot truncate in the middle, so the name is split:
 * `head` truncates, `tail` + `ext` never shrink (FileName.tsx). The rule and its cases are shared with iOS and
 * Android (apps/shared/file-name-ellipsis.json).
 */
export type FileNameParts = { head: string; tail: string; ext: string };

const MAX_EXT = 8;
const TAIL = 6;
const TAIL_FROM = 12;
const ZWJ = 0x200d;

/** A code point that belongs to the character before it (so a tail never starts on it). */
function extendsPrevious(cp: number): boolean {
  return (
    cp === ZWJ ||
    (cp >= 0xfe00 && cp <= 0xfe0f) ||
    (cp >= 0xe0100 && cp <= 0xe01ef) ||
    (cp >= 0x1f3fb && cp <= 0x1f3ff) ||
    (cp >= 0xe0020 && cp <= 0xe007f) ||
    (cp >= 0x1160 && cp <= 0x11ff) ||
    /\p{M}/u.test(String.fromCodePoint(cp))
  );
}

const regionalIndicator = (cp: number) => cp >= 0x1f1e6 && cp <= 0x1f1ff;

export function splitFileName(name: string): FileNameParts {
  const cps = Array.from(name);
  const dot = cps.lastIndexOf(".");
  const extLength = cps.length - 1 - dot;
  if (dot <= 0 || extLength < 1 || extLength > MAX_EXT || cps.slice(dot + 1).some((c) => /\s/u.test(c))) {
    return { head: name, tail: "", ext: "" };
  }
  const stem = cps.slice(0, dot);
  const ext = cps.slice(dot).join("");
  if (stem.length <= TAIL_FROM) return { head: stem.join(""), tail: "", ext };
  const code = (i: number) => stem[i]?.codePointAt(0) ?? 0;
  let start = stem.length - TAIL;
  while (start > 0) {
    if (extendsPrevious(code(start)) || code(start - 1) === ZWJ) { start -= 1; continue; }
    if (regionalIndicator(code(start))) {
      let before = 0;
      while (start - 1 - before >= 0 && regionalIndicator(code(start - 1 - before))) before += 1;
      if (before % 2 === 1) { start -= 1; continue; }
    }
    break;
  }
  return { head: stem.slice(0, start).join(""), tail: stem.slice(start).join(""), ext };
}
