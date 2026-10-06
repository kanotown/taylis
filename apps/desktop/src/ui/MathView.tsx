/**
 * TeX math (DATA_MODEL.md 「本文の形式」, apps/shared/math.json) drawn with KaTeX. KaTeX, its stylesheet and its fonts are
 * a chunk of their own, loaded the first time a body with a formula is drawn (never for the others). Until then — and
 * when a formula cannot be drawn — the source shows in a code-like style; a formula KaTeX cannot read is its source in a
 * muted error style (title: the reason). Copying selected math copies its TeX with its dollars (katex copy-tex).
 */
import { useEffect, useState } from "react";

import { cn } from "./primitives";

type Katex = typeof import("katex").default;

let katexModule: Katex | null = null;
let loading: Promise<Katex> | null = null;

/** The KaTeX chunk (script, stylesheet, the copy handler); one load for the whole app. */
export function loadKatex(): Promise<Katex> {
  loading ??= Promise.all([import("katex"), import("katex/dist/katex.min.css"), import("katex/contrib/copy-tex")]).then(([module]) => {
    katexModule = module.default;
    return module.default;
  });
  return loading;
}

/** Rendered formulas by source and mode: a timeline draws the same rows again and again. */
const cache = new Map<string, string | null>();
const CACHE_LIMIT = 500;

/**
 * A formula's HTML, or null when KaTeX cannot draw it. Untrusted input: `trust: false` (no \href, \url, \includegraphics
 * …), sizes capped (`maxSize`, in em) and macro expansion bounded (`maxExpand`), so a formula cannot draw a huge box or
 * loop; the length itself is capped by the tokenizer (MATH_MAX_LENGTH).
 */
export function renderMath(katex: Katex, tex: string, display: boolean): string | null {
  const key = (display ? "D" : "I") + tex;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  let html: string | null;
  try {
    html = katex.renderToString(tex, {
      displayMode: display,
      throwOnError: false,
      errorColor: "var(--muted)",
      trust: false,
      strict: "ignore",
      maxSize: 20,
      maxExpand: 300,
      output: "htmlAndMathml",
    });
  } catch {
    html = null; // something other than a parse error (those come back as the source in errorColor)
  }
  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value!);
  cache.set(key, html);
  return html;
}

/** `display`: a block of its own, centred, scrolling sideways when wider than the row; otherwise in the line. */
export function MathView({ tex, display, inlineDisplay = false }: { tex: string; display: boolean; inlineDisplay?: boolean }) {
  const [katex, setKatex] = useState<Katex | null>(katexModule);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (katex) return;
    let live = true;
    loadKatex().then(
      (module) => live && setKatex(() => module),
      () => live && setFailed(true),
    );
    return () => {
      live = false;
    };
  }, [katex]);
  const source = display ? `$$${tex}$$` : inlineDisplay ? `$$${tex}$$` : `$${tex}$`;
  const html = katex ? renderMath(katex, tex, display) : null;
  if (!html) {
    const Tag = display ? "div" : "code";
    return (
      <Tag data-math={failed || katex ? "error" : "loading"} className={cn("math-source", display && "my-1 block overflow-x-auto whitespace-pre-wrap font-mono text-[13px]")}>
        {source}
      </Tag>
    );
  }
  if (display) return <div data-math="display" className="math-display my-1 overflow-x-auto overflow-y-hidden py-1" dangerouslySetInnerHTML={{ __html: html }} />;
  return <span data-math="inline" className="math-inline" dangerouslySetInnerHTML={{ __html: html }} />;
}
