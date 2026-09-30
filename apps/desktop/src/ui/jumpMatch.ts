/**
 * M37 (MOBILE_UI.md §6.2): the rule the phone's 「移動・検索」 and the desktop's ⌘K use to find a conversation or a person
 * by name. The same rule runs on iOS and Android; every client is tested against apps/shared/jump-match.json (made by
 * apps/shared/gen_jump_match.py, the reference).
 */

/** NFKC (full-width / half-width forms), lower case, katakana as hiragana, no leading # or @, trimmed. */
export function normalizeName(text: string): string {
  let folded = text.normalize("NFKC").toLowerCase().trim();
  let out = "";
  for (const c of folded) {
    const code = c.codePointAt(0)!;
    out += code >= 0x30a1 && code <= 0x30f6 ? String.fromCodePoint(code - 0x60) : c;
  }
  folded = out.replace(/^[#@]+/, "");
  return folded.trim();
}

/** What starts a word inside a name: after one of these, the next letters are a word's start. */
const SEPARATORS = " -_./・　";

/**
 * 0: a name starts with the query; 1: a word in a name does (after a space, - _ . / ・); 2: a name contains it; null:
 * no match (also for an empty query). The best over the names (a DM: the people's display names and usernames).
 */
export function matchScore(query: string, names: readonly string[]): 0 | 1 | 2 | null {
  const q = normalizeName(query);
  if (!q) return null;
  let best: 0 | 1 | 2 | null = null;
  for (const name of names) {
    const n = normalizeName(name);
    let s: 0 | 1 | 2;
    if (n.startsWith(q)) s = 0;
    else if (wordStarts(n, q)) s = 1;
    else if (n.includes(q)) s = 2;
    else continue;
    if (best === null || s < best) best = s;
    if (best === 0) break;
  }
  return best;
}

function wordStarts(name: string, query: string): boolean {
  for (let i = 1; i < name.length; i++) if (SEPARATORS.includes(name[i - 1]!) && name.startsWith(query, i)) return true;
  return false;
}

export interface JumpItem {
  id: string;
  /** What the row shows; the last tie-break (normalized, code-point order). */
  title: string;
  /** What the query is matched against. */
  names: readonly string[];
  unread?: boolean;
}

/** Code-unit order, the same on every platform (a locale's collation orders kanji differently from one to another). */
const byCodeUnits = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Matches only: by score, then unread first, then the normalized title, then the id. */
export function rankItems<T extends JumpItem>(query: string, items: readonly T[]): T[] {
  const hits: Array<{ item: T; score: number; title: string }> = [];
  for (const item of items) {
    const score = matchScore(query, item.names);
    if (score !== null) hits.push({ item, score, title: normalizeName(item.title) });
  }
  hits.sort((a, b) => a.score - b.score || Number(!!b.item.unread) - Number(!!a.item.unread) || byCodeUnits(a.title, b.title) || byCodeUnits(a.item.id, b.item.id));
  return hits.map((hit) => hit.item);
}
