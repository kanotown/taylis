import { replaceShortcodes } from "./emoji";

/**
 * Emoji-only messages (M101, docs/EMOJI.md §7): a body that is nothing but emoji (standard ones, `:shortcode:`s and
 * custom emoji of any kind; at most MAX_ITEMS, whitespace between them) is shown large in the timeline and threads.
 * The rule and its cases are shared with iOS and Android: apps/shared/emoji-only.json (tests/emojiOnly.test.ts
 * compares the tables below with it and runs the cases).
 */

export const EMOJI_ONLY_MAX_ITEMS = 23;
export const EMOJI_ONLY_WHITESPACE = [0x20, 0x09, 0x0a, 0x0d, 0xa0, 0x3000];
/** The Unicode Emoji property without ASCII and the sequence components, plus all of 1F000–1FAFF (inclusive pairs). */
export const EMOJI_ONLY_PICTOGRAPHIC: ReadonlyArray<readonly [number, number]> = [
  [0xa9, 0xa9], [0xae, 0xae], [0x203c, 0x203c], [0x2049, 0x2049], [0x2122, 0x2122], [0x2139, 0x2139], [0x2194, 0x2199],
  [0x21a9, 0x21aa], [0x231a, 0x231b], [0x2328, 0x2328], [0x23cf, 0x23cf], [0x23e9, 0x23f3], [0x23f8, 0x23fa],
  [0x24c2, 0x24c2], [0x25aa, 0x25ab], [0x25b6, 0x25b6], [0x25c0, 0x25c0], [0x25fb, 0x25fe], [0x2600, 0x2604],
  [0x260e, 0x260e], [0x2611, 0x2611], [0x2614, 0x2615], [0x2618, 0x2618], [0x261d, 0x261d], [0x2620, 0x2620],
  [0x2622, 0x2623], [0x2626, 0x2626], [0x262a, 0x262a], [0x262e, 0x262f], [0x2638, 0x263a], [0x2640, 0x2640],
  [0x2642, 0x2642], [0x2648, 0x2653], [0x265f, 0x2660], [0x2663, 0x2663], [0x2665, 0x2666], [0x2668, 0x2668],
  [0x267b, 0x267b], [0x267e, 0x267f], [0x2692, 0x2697], [0x2699, 0x2699], [0x269b, 0x269c], [0x26a0, 0x26a1],
  [0x26a7, 0x26a7], [0x26aa, 0x26ab], [0x26b0, 0x26b1], [0x26bd, 0x26be], [0x26c4, 0x26c5], [0x26c8, 0x26c8],
  [0x26ce, 0x26cf], [0x26d1, 0x26d1], [0x26d3, 0x26d4], [0x26e9, 0x26ea], [0x26f0, 0x26f5], [0x26f7, 0x26fa],
  [0x26fd, 0x26fd], [0x2702, 0x2702], [0x2705, 0x2705], [0x2708, 0x270d], [0x270f, 0x270f], [0x2712, 0x2712],
  [0x2714, 0x2714], [0x2716, 0x2716], [0x271d, 0x271d], [0x2721, 0x2721], [0x2728, 0x2728], [0x2733, 0x2734],
  [0x2744, 0x2744], [0x2747, 0x2747], [0x274c, 0x274c], [0x274e, 0x274e], [0x2753, 0x2755], [0x2757, 0x2757],
  [0x2763, 0x2764], [0x2795, 0x2797], [0x27a1, 0x27a1], [0x27b0, 0x27b0], [0x27bf, 0x27bf], [0x2934, 0x2935],
  [0x2b05, 0x2b07], [0x2b1b, 0x2b1c], [0x2b50, 0x2b50], [0x2b55, 0x2b55], [0x3030, 0x3030], [0x303d, 0x303d],
  [0x3297, 0x3297], [0x3299, 0x3299], [0x1f000, 0x1f1e5], [0x1f200, 0x1f3fa], [0x1f400, 0x1faff],
];

export type EmojiOnlyKind = "unicode" | "image" | "text" | "pack";
export interface EmojiOnly {
  kinds: EmojiOnlyKind[];
  /** Exactly one emoji of a pack: shown as a stamp. */
  stamp: boolean;
}

const NAME = /^[a-z0-9][a-z0-9_+-]{1,31}$/;
const VS16 = 0xfe0f;
const ZWJ = 0x200d;
const KEYCAP = 0x20e3;

function pictographic(cp: number): boolean {
  let lo = 0;
  let hi = EMOJI_ONLY_PICTOGRAPHIC.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [start, end] = EMOJI_ONLY_PICTOGRAPHIC[mid]!;
    if (cp < start) hi = mid - 1;
    else if (cp > end) lo = mid + 1;
    else return true;
  }
  return false;
}
const regional = (cp: number | undefined) => cp !== undefined && cp >= 0x1f1e6 && cp <= 0x1f1ff;
const skinTone = (cp: number | undefined) => cp !== undefined && cp >= 0x1f3fb && cp <= 0x1f3ff;
const tag = (cp: number | undefined) => cp !== undefined && cp >= 0xe0020 && cp <= 0xe007e;

/** The emoji of an emoji-only body (in order), or null when it is not one. `custom`: custom emoji by name. */
export function emojiOnly(body: string, custom: { get(name: string): { kind?: string | null; pack_id?: string | null } | undefined }): EmojiOnly | null {
  const cps = [...replaceShortcodes(body)].map((c) => c.codePointAt(0)!);
  const kinds: EmojiOnlyKind[] = [];
  let i = 0;
  /** One element of an emoji sequence at `i`: the end, or -1. */
  const element = (at: number): number => {
    if (!pictographic(cps[at]!)) return -1;
    const base = cps[at]!;
    let j = at + 1;
    if (cps[j] === VS16) j++;
    if (skinTone(cps[j])) j++;
    if (base === 0x1f3f4 && tag(cps[j])) {
      while (tag(cps[j])) j++;
      if (cps[j] !== 0xe007f) return -1;
      j++;
    }
    return j;
  };
  while (i < cps.length) {
    const cp = cps[i]!;
    if (EMOJI_ONLY_WHITESPACE.includes(cp)) { i++; continue; }
    if (kinds.length === EMOJI_ONLY_MAX_ITEMS) return null;
    if (cp === 0x3a) { // ':' name ':'
      let j = i + 1;
      while (j < cps.length && cps[j] !== 0x3a && j - i <= 33) j++;
      const name = String.fromCodePoint(...cps.slice(i + 1, j));
      const emoji = cps[j] === 0x3a && NAME.test(name) ? custom.get(name) : undefined;
      if (!emoji) return null;
      kinds.push(emoji.kind === "text" ? "text" : emoji.pack_id ? "pack" : "image");
      i = j + 1;
      continue;
    }
    if ((cp >= 0x30 && cp <= 0x39) || cp === 0x23 || cp === 0x2a) {
      let j = i + 1;
      if (cps[j] === VS16) j++;
      if (cps[j] !== KEYCAP) return null;
      kinds.push("unicode");
      i = j + 1;
      continue;
    }
    if (regional(cp)) {
      if (!regional(cps[i + 1])) return null;
      kinds.push("unicode");
      i += 2;
      continue;
    }
    let j = element(i);
    if (j < 0) return null;
    while (cps[j] === ZWJ) {
      j = j + 1 < cps.length ? element(j + 1) : -1;
      if (j < 0) return null;
    }
    kinds.push("unicode");
    i = j;
  }
  if (kinds.length === 0) return null;
  return { kinds, stamp: kinds.length === 1 && kinds[0] === "pack" };
}

/**
 * The sizes of an emoji-only body on the desktop / web (px; docs/EMOJI.md §7): a standard emoji's font size, an image
 * emoji's box height (a wide one keeps its ratio, at most 3:1), a text emoji's pill height (its label 1.6× the body's),
 * a pack emoji's height (several), and a single pack emoji's (a stamp).
 */
export const JUMBO = { font: 32, lineHeight: 40, image: 36, pill: 32, pack: 64, stamp: 120 } as const;
