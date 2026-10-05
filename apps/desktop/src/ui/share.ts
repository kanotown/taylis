/** Sharing a message into another conversation (M13c): a comment, the original as a quote, its permalink. */
import { t } from "../i18n";

export function shareBody(original: string, permalink: string, comment: string, maxQuote = 300): string {
  const text = original.trim();
  const clipped = text.length > maxQuote ? text.slice(0, maxQuote).trimEnd() + "…" : text;
  const quote = (clipped || t("common.attachmentParen"))
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
  return [comment.trim(), quote, permalink].filter(Boolean).join("\n");
}
