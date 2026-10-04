import type { TextEmojiColor } from "../api/types";

/**
 * Text emoji colours (M100, docs/EMOJI.md §1): a copy of apps/shared/text-emoji.json (tests/textEmoji.test.ts compares
 * them). null = gray.
 */
export const TEXT_EMOJI_COLORS: Readonly<Record<TextEmojiColor, { light: { bg: string; fg: string }; dark: { bg: string; fg: string } }>> = {
  gray: { light: { bg: "#E8E8EC", fg: "#3A3A44" }, dark: { bg: "#3A3A44", fg: "#E8E8EC" } },
  red: { light: { bg: "#FDE2E1", fg: "#B3261E" }, dark: { bg: "#5C1D1A", fg: "#FFB4AB" } },
  orange: { light: { bg: "#FFE6CC", fg: "#A04A00" }, dark: { bg: "#5A3000", fg: "#FFC58A" } },
  yellow: { light: { bg: "#FFF3BF", fg: "#7A5C00" }, dark: { bg: "#4D3D00", fg: "#FFE08A" } },
  green: { light: { bg: "#DDF4E4", fg: "#1E6B3A" }, dark: { bg: "#163D24", fg: "#9FE0B4" } },
  blue: { light: { bg: "#DCEBFF", fg: "#1D4FA0" }, dark: { bg: "#18325C", fg: "#A8C8FF" } },
  purple: { light: { bg: "#ECE2FC", fg: "#5B2DA6" }, dark: { bg: "#36225A", fg: "#D2BCFA" } },
  pink: { light: { bg: "#FCE1EF", fg: "#A3215F" }, dark: { bg: "#5A1A3A", fg: "#FFB0D5" } },
};

/** Japanese names for the colour choice in the add dialog. */
export const TEXT_EMOJI_COLOR_NAMES: Readonly<Record<TextEmojiColor, string>> = {
  gray: "グレー",
  red: "赤",
  orange: "オレンジ",
  yellow: "黄",
  green: "緑",
  blue: "青",
  purple: "紫",
  pink: "ピンク",
};

export const TEXT_EMOJI_LABEL_MAX = 12;

export function textEmojiColors(color: string | null | undefined) {
  return TEXT_EMOJI_COLORS[(color ?? "gray") as TextEmojiColor] ?? TEXT_EMOJI_COLORS.gray;
}
