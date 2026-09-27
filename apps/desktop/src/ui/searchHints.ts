/** M15h: the modifiers offered under the search box; complete ones search at once when clicked. */
export const SEARCH_HINTS: ReadonlyArray<{ label: string; insert: string; complete: boolean }> = [
  { label: "from:@名前", insert: "from:@", complete: false },
  { label: "in:#チャンネル", insert: "in:#", complete: false },
  { label: "before:", insert: "before:", complete: false },
  { label: "after:", insert: "after:", complete: false },
  { label: "on:", insert: "on:", complete: false },
  { label: "ファイルあり", insert: "has:file", complete: true },
  { label: "リンクあり", insert: "has:link", complete: true },
  { label: "ピン留め", insert: "has:pin", complete: true },
  { label: "リアクションあり", insert: "has:reaction", complete: true },
  { label: "投票", insert: "has:poll", complete: true },
  { label: "スレッド", insert: "is:thread", complete: true },
];

/** How the chips name the `has:` flags the server understood. */
export const FLAG_LABELS: Readonly<Record<string, string>> = {
  file: "ファイルあり",
  link: "リンクあり",
  pin: "ピン留め",
  reaction: "リアクションあり",
  poll: "投票",
};

/** Adds a modifier to the query (once); open ones such as "from:@" leave the cursor right after them. */
export function appendModifier(query: string, insert: string): string {
  if (query.split(/\s+/).includes(insert)) return query;
  const base = query.trimEnd();
  return (base ? `${base} ` : "") + insert + (/[:@#]$/.test(insert) ? "" : " ");
}
