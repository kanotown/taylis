/**
 * M44: the history's comparison of two versions of a canvas (CANVAS.md §4.9 「現在の版との行単位の差分」): lines added
 * and removed (Myers' diff), and inside a line that was only touched up the words that changed. The words are cut as the
 * server's merge cuts them (server/app/modules/canvases/merge.py): spaces, one punctuation mark, or a run of one script —
 * kanji, hiragana, katakana, letters and digits — so a Japanese sentence splits into its phrases without spaces.
 * This is display only; merging stays on the server.
 */

export type DiffKind = "same" | "add" | "del";

export interface WordPiece {
  text: string;
  changed: boolean;
}

export interface DiffLine {
  kind: DiffKind;
  text: string;
  /** 1-based line numbers in the older / newer text. */
  oldNo: number | null;
  newNo: number | null;
  /** A touched-up line: which words changed (a removed line's old words, an added line's new ones). */
  words?: WordPiece[];
}

export type DiffRow = DiffLine | { kind: "skip"; count: number };

type Op = { kind: DiffKind; a: number; b: number };

/** Beyond this many edits the middle is taken as replaced as a whole (a pasted-over document): still correct, less fine. */
const MAX_EDITS = 3_000;

/** Myers' O((N+M)·D) shortest edit script between `a` and `b`, common head and tail trimmed first. */
function editScript<T>(a: readonly T[], b: readonly T[], maxEdits = MAX_EDITS): Op[] {
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const ops: Op[] = [];
  for (let i = 0; i < head; i++) ops.push({ kind: "same", a: i, b: i });
  const n = a.length - head - tail;
  const m = b.length - head - tail;
  const middle = middleScript(a, b, head, n, m, maxEdits);
  ops.push(...middle);
  for (let i = 0; i < tail; i++) ops.push({ kind: "same", a: head + n + i, b: head + m + i });
  return ops;
}

function middleScript<T>(a: readonly T[], b: readonly T[], off: number, n: number, m: number, maxEdits: number): Op[] {
  const removeAll = () => [
    ...Array.from({ length: n }, (_, i): Op => ({ kind: "del", a: off + i, b: -1 })),
    ...Array.from({ length: m }, (_, j): Op => ({ kind: "add", a: -1, b: off + j })),
  ];
  if (n === 0 || m === 0) return removeAll();
  const max = Math.min(n + m, maxEdits);
  const size = 2 * max + 1;
  const v = new Int32Array(size);
  // The frontier before each step, only the part the walk back reads (k − 1 … k + 1 for |k| ≤ d): O(D²), not O(D·(N+M)).
  const trace: Array<{ lo: number; at: Int32Array }> = [];
  let found = -1;
  for (let d = 0; d <= max; d++) {
    const lo = Math.max(0, max - d - 1);
    trace.push({ lo, at: v.slice(lo, Math.min(size, max + d + 2)) });
    for (let k = -d; k <= d; k += 2) {
      const down = k === -d || (k !== d && v[max + k - 1]! < v[max + k + 1]!);
      let x = down ? v[max + k + 1]! : v[max + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[off + x] === b[off + y]) {
        x++;
        y++;
      }
      v[max + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break;
      }
    }
    if (found >= 0) break;
  }
  if (found < 0) return removeAll();
  // Walk back through the saved frontiers.
  const ops: Op[] = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d--) {
    const frame = trace[d]!;
    const at = (k: number) => frame.at[max + k - frame.lo]!;
    const k = x - y;
    const down = k === -d || (k !== d && at(k - 1) < at(k + 1));
    const prevK = down ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      x--;
      y--;
      ops.push({ kind: "same", a: off + x, b: off + y });
    }
    if (down) {
      y--;
      ops.push({ kind: "add", a: -1, b: off + y });
    } else {
      x--;
      ops.push({ kind: "del", a: off + x, b: -1 });
    }
  }
  while (x > 0 && y > 0) {
    x--;
    y--;
    ops.push({ kind: "same", a: off + x, b: off + y });
  }
  return ops.reverse();
}

const WORD = /\n|[^\S\n]+|[\p{Script=Han}々〆ヶ]+|\p{Script=Hiragana}+|[\p{Script=Katakana}ー]+|[\p{L}\p{N}_]+|./gu;

/** A line cut into words as the server's merge cuts it. */
export function words(text: string): string[] {
  return text.match(WORD) ?? [];
}

/**
 * The words that changed between a removed line and the line that took its place, or null when the two share too little
 * to be read as one line touched up (then they show as a plain removal and addition).
 */
export function wordDiff(before: string, after: string): { before: WordPiece[]; after: WordPiece[] } | null {
  const a = words(before);
  const b = words(after);
  if (a.length + b.length > 2_000) return null;
  const ops = editScript(a, b, 400);
  const same = ops.filter((op) => op.kind === "same").reduce((sum, op) => sum + (a[op.a] ?? "").length, 0);
  const longer = Math.max(before.length, after.length);
  if (longer === 0 || same / longer < 0.4) return null;
  const pieces = (kind: "del" | "add", source: string[]): WordPiece[] => {
    const out: WordPiece[] = [];
    for (const op of ops) {
      if (op.kind === "same") push(out, source === a ? a[op.a]! : b[op.b]!, false);
      else if (op.kind === kind) push(out, source[kind === "del" ? op.a : op.b]!, true);
    }
    return out;
  };
  return { before: pieces("del", a), after: pieces("add", b) };
}

function push(out: WordPiece[], text: string, changed: boolean): void {
  const last = out[out.length - 1];
  if (last && last.changed === changed) last.text += text;
  else out.push({ text, changed });
}

/** Every line of `after` against `before`: kept, removed or added, with the changed words of lines touched up. */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = before === "" ? [] : before.split("\n");
  const b = after === "" ? [] : after.split("\n");
  const ops = editScript(a, b);
  const lines: DiffLine[] = [];
  let i = 0;
  while (i < ops.length) {
    const op = ops[i]!;
    if (op.kind === "same") {
      lines.push({ kind: "same", text: a[op.a]!, oldNo: op.a + 1, newNo: op.b + 1 });
      i++;
      continue;
    }
    // A run of removals and additions: pair them in order for the word view.
    const dels: Op[] = [];
    const adds: Op[] = [];
    while (i < ops.length && ops[i]!.kind !== "same") {
      const o = ops[i]!;
      if (o.kind === "del") dels.push(o);
      else adds.push(o);
      i++;
    }
    const paired = Math.min(dels.length, adds.length);
    const delLines: DiffLine[] = dels.map((o) => ({ kind: "del", text: a[o.a]!, oldNo: o.a + 1, newNo: null }));
    const addLines: DiffLine[] = adds.map((o) => ({ kind: "add", text: b[o.b]!, oldNo: null, newNo: o.b + 1 }));
    for (let p = 0; p < paired; p++) {
      const pair = wordDiff(delLines[p]!.text, addLines[p]!.text);
      if (!pair) continue;
      delLines[p]!.words = pair.before;
      addLines[p]!.words = pair.after;
    }
    lines.push(...delLines, ...addLines);
  }
  return lines;
}

/** The changed lines with `context` lines around them; longer stretches of kept lines fold into a 「… N 行」 row. */
export function diffRows(lines: readonly DiffLine[], context = 3): DiffRow[] {
  const keep = new Array<boolean>(lines.length).fill(false);
  lines.forEach((line, index) => {
    if (line.kind === "same") return;
    for (let k = Math.max(0, index - context); k <= Math.min(lines.length - 1, index + context); k++) keep[k] = true;
  });
  const rows: DiffRow[] = [];
  let skipped = 0;
  lines.forEach((line, index) => {
    if (keep[index]) {
      if (skipped) rows.push({ kind: "skip", count: skipped });
      skipped = 0;
      rows.push(line);
    } else skipped++;
  });
  if (skipped) rows.push({ kind: "skip", count: skipped });
  return rows;
}

/** 「+3 −1」 counts of a comparison. */
export function diffCounts(lines: readonly DiffLine[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of lines) {
    if (line.kind === "add") added++;
    else if (line.kind === "del") removed++;
  }
  return { added, removed };
}
