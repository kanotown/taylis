import { Fragment, type ReactNode } from "react";

import { t, type MessageKey, type Params } from ".";

/**
 * A text with markup: `<tag>…</tag>` in the translation becomes `tags.tag(children)` (no nesting), and a
 * `{name}` whose value in `nodes` is an element is put in as it is. E.g. "Press <kbd>Enter</kbd> to send"
 * with `{ kbd: (s) => <kbd>{s}</kbd> }`.
 */
export function tRich(
  key: MessageKey,
  tags: Readonly<Record<string, (children: string) => ReactNode>>,
  params?: Params,
  nodes?: Readonly<Record<string, ReactNode>>,
): ReactNode {
  const text = t(key, params);
  const parts: ReactNode[] = [];
  const pattern = /<(\w+)>(.*?)<\/\1>|\{(\w+)\}/gs;
  let last = 0;
  let index = 0;
  for (let m = pattern.exec(text); m; m = pattern.exec(text)) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    if (m[1] !== undefined) {
      const render = tags[m[1]];
      parts.push(<Fragment key={index++}>{render ? render(m[2] ?? "") : m[2]}</Fragment>);
    } else {
      const node = nodes?.[m[3]!];
      parts.push(node === undefined ? m[0] : <Fragment key={index++}>{node}</Fragment>);
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <>{parts}</>;
}
