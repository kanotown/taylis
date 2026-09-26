/**
 * Message body format (DATA_MODEL.md "本文の形式"): plain text with mention tokens plus a small
 * inline subset. This is a tokenizer, not an HTML renderer: React escapes everything.
 */
export type Token =
  | { kind: "text"; text: string }
  | { kind: "bold"; text: string }
  | { kind: "italic"; text: string }
  | { kind: "code"; text: string }
  | { kind: "codeblock"; text: string }
  | { kind: "link"; url: string }
  | { kind: "mention"; userId: string }
  | { kind: "mention_all"; target: string }
  | { kind: "newline" };

const PATTERN =
  /(```([\s\S]*?)```)|(`([^`\n]+)`)|(\*([^*\n]+)\*)|(_([^_\n]+)_)|(<@([0-9a-f-]{36})>)|(<!(channel|here)>)|(https?:\/\/[^\s<>]+)|(\n)/g;

export function tokenize(body: string): Token[] {
  const tokens: Token[] = [];
  let last = 0;
  for (const match of body.matchAll(PATTERN)) {
    const index = match.index ?? 0;
    if (index > last) tokens.push({ kind: "text", text: body.slice(last, index) });
    if (match[1] !== undefined) tokens.push({ kind: "codeblock", text: (match[2] ?? "").replace(/^\n|\n$/g, "") });
    else if (match[3] !== undefined) tokens.push({ kind: "code", text: match[4] ?? "" });
    else if (match[5] !== undefined) tokens.push({ kind: "bold", text: match[6] ?? "" });
    else if (match[7] !== undefined) tokens.push({ kind: "italic", text: match[8] ?? "" });
    else if (match[9] !== undefined) tokens.push({ kind: "mention", userId: match[10] ?? "" });
    else if (match[11] !== undefined) tokens.push({ kind: "mention_all", target: match[12] ?? "" });
    else if (match[13] !== undefined) tokens.push({ kind: "link", url: match[13] });
    else tokens.push({ kind: "newline" });
    last = index + match[0].length;
  }
  if (last < body.length) tokens.push({ kind: "text", text: body.slice(last) });
  return tokens;
}
