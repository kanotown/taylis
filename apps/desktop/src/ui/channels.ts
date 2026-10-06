/** Sidebar rules shared by the list, the quick switcher and keyboard navigation. */
import { isMutedChannel, type NotifyLevel } from "../sync/notifications";
import type { ChannelState, SidebarDefaultOut, SidebarSectionOut, UserPublic } from "../sync/types";
import { t } from "../i18n";
import { JIS_KANJI } from "./jisKanji";

export function isDmChannel(channel: ChannelState): boolean {
  return channel.type === "dm" || channel.type === "group_dm";
}

/**
 * A conversation's name: `#name` for channels, the other members for DMs (also the notification title). My own DM (a
 * DM with nobody but me, Slack / Mattermost style) is named after me; `me` stands in while the users are not loaded.
 */
export function conversationTitle(channel: ChannelState, users: ReadonlyMap<string, UserPublic>, meId: string | null, me?: NamedUser | null): string {
  if (channel.type === "public" || channel.type === "private") return `#${channel.name ?? ""}`;
  const others = (channel.dm_user_ids ?? []).filter((id) => id !== meId);
  if (others.length === 0) return myName(users, meId, me);
  return others.map((id) => users.get(id)?.display_name ?? "…").join(", ");
}

type NamedUser = Pick<UserPublic, "display_name" | "username">;

/** My name as the lists show it: my display name, else my username, else 「…」 (not loaded yet). */
export function myName(users: ReadonlyMap<string, NamedUser>, meId: string | null, me?: NamedUser | null): string {
  const user = (meId ? users.get(meId) : undefined) ?? me ?? undefined;
  return user?.display_name?.trim() || user?.username?.trim() || "…";
}

// --- my own DM (Slack / Mattermost: a DM with only me, titled with my name) --------------------------------------

/** A DM with nobody but me. */
export function isSelfNotes(channel: ChannelState, meId: string | null): boolean {
  return !!meId && channel.type === "dm" && (channel.dm_user_ids ?? []).every((id) => id === meId);
}

/** What my own DM says where its conversation starts (empty, or at the start of its history). */
export function selfNotesIntro(): string {
  return t("channels.selfNotes.intro");
}

/** The new-DM picker's line under my name. */
export function selfNotesHint(): string {
  return t("channels.selfNotes.hint");
}

/**
 * Whether a DM list shows my own DM's placeholder row first: there is no DM with only me among my channels yet (a tap on
 * the row makes it), and the filter is empty or matches my name (`name`, as myName gives it), ignoring case.
 */
export function showsSelfNotesPlaceholder(channels: Iterable<ChannelState>, meId: string | null, name: string, query = ""): boolean {
  if (!meId) return false;
  for (const channel of channels) if (channel.isMember && isSelfNotes(channel, meId)) return false;
  const needle = query.trim().toLowerCase();
  return !needle || name.trim().toLowerCase().includes(needle);
}

/**
 * The home list's 「ダイレクトメッセージ」 section: the placeholder as above, but never while the section is folded or only
 * unread conversations are listed. (My own DM starred or in one of my sections exists, so it gets no placeholder either.)
 */
export function showsSelfNotesInDmSection(
  channels: Iterable<ChannelState>,
  meId: string | null,
  name: string,
  options: { collapsed?: boolean; unreadOnly?: boolean; query?: string } = {},
): boolean {
  if (options.collapsed || options.unreadOnly) return false;
  return showsSelfNotesPlaceholder(channels, meId, name, options.query);
}

/** M15a: whether I may start top-level posts here; thread replies stay open to every member. */
export function canPostTopLevel(channel: ChannelState, isAdmin: boolean): boolean {
  return channel.posting_policy !== "owners" || isAdmin || channel.membership?.role === "owner";
}

/**
 * M15b / L4 (M31): private → public shows the whole history to everyone, so only an admin who is a member of the channel
 * may (SECURITY.md; the server says 403 admin_not_member otherwise).
 */
export function canMakePublic(channel: ChannelState, isAdmin: boolean): boolean {
  return channel.type === "private" && isAdmin && channel.isMember;
}

// --- notification level and mute (M35; the rules live in sync/notifications.ts, which the engine uses too) --------

export { DEFAULT_OVERALL_LEVEL, effectiveNotificationLevel, isMutedChannel, isTimedMuted, overallLevel, ownNotification, resolveNotificationLevel } from "../sync/notifications";
export type { NotifyLevel } from "../sync/notifications";

/** The overall setting's choices, as the settings and a conversation's 「既定 (…)」 name them. */
export const OVERALL_LEVEL_LABELS: Record<NotifyLevel, string> = {
  get all() { return t("notify.overall.all"); },
  get mentions() { return t("notify.overall.mentions"); },
  get none() { return t("notify.overall.none"); },
};

/** A conversation's own levels, as its notification menu names them. */
export const CHANNEL_LEVEL_LABELS: Record<NotifyLevel, string> = {
  get all() { return t("notify.channel.all"); },
  get mentions() { return t("notify.channel.mentions"); },
  get none() { return t("notify.channel.none"); },
};

/** The value a conversation's notification menu uses for "no level of its own" (radio values cannot be null). */
export const FOLLOW_DEFAULT = "default";

/**
 * A conversation's notification menu: 「既定 (<my overall setting>)」 (level null), then its own levels. The first label
 * follows the overall setting, so it changes when that does.
 */
export function notificationChoices(overall: NotifyLevel): Array<{ value: typeof FOLLOW_DEFAULT | NotifyLevel; level: NotifyLevel | null; label: string }> {
  return [
    { value: FOLLOW_DEFAULT, level: null, label: t("notify.channel.default", { level: OVERALL_LEVEL_LABELS[overall] }) },
    ...(["all", "mentions", "none"] as const).map((level) => ({ value: level, level, label: CHANNEL_LEVEL_LABELS[level] })),
  ];
}

/** The footnote under the overall setting. */
export function overallLevelNote(): string {
  return t("notify.overall.note");
}

/**
 * M24: someone else's times that I have not set to level "all" is quiet unread: unread only with a mention, a faint dot
 * otherwise (SYNC_PROTOCOL.md §10.5; the vectors in apps/shared/unread-rules.json).
 */
export function isQuietChannel(channel: ChannelState, meId: string | null, now?: Date): boolean {
  return !!channel.times_owner_id && channel.times_owner_id !== meId && channel.notificationLevel !== "all" && !isMutedChannel(channel, now);
}

/** Slack / Mattermost rule: a muted channel only counts as unread when I am mentioned; so does a quiet one (M24). */
export function hasUnread(channel: ChannelState, meId: string | null, now?: Date): boolean {
  if (!channel.isMember) return false;
  return isMutedChannel(channel, now) || isQuietChannel(channel, meId, now) ? channel.mentionCount > 0 : channel.unreadCount > 0;
}

/** Badge number: mentions for channels and muted conversations, every message for DMs. */
export function badgeCount(channel: ChannelState, now?: Date): number {
  if (isMutedChannel(channel, now)) return channel.mentionCount;
  return isDmChannel(channel) ? channel.unreadCount : channel.mentionCount;
}

/** What the app icon shows (M13f): the badge numbers of every conversation I am in, added up. */
export function unreadBadgeTotal(channels: Iterable<ChannelState>, now?: Date): number {
  let total = 0;
  for (const channel of channels) if (channel.isMember && !channel.archived) total += badgeCount(channel, now);
  return total;
}

export interface ChannelSections {
  /** Starred conversations (M12a); left out of every other section. */
  favorites: ChannelState[];
  /** My own sections (M14f), in order; their conversations are left out of `channels` / `dms`. */
  custom: Array<{ section: SidebarSectionOut; channels: ChannelState[] }>;
  channels: ChannelState[];
  /** M24: times channels I am in, mine first; left out of `channels`. */
  times: ChannelState[];
  /** Pinned DMs (M118), my own DM, then the section's sort (newest first unless chosen otherwise). */
  dms: ChannelState[];
  browse: ChannelState[];
}

// --- the order inside a section (DATA_MODEL.md sidebar_sections 「セクションの中の並び順」「並べ替え」) -------------
// The same on every client: apps/shared/sidebar-order.json (desktop tests/sidebarOrder.test.ts, iOS SidebarOrderTests,
// Android SidebarOrderTest). No platform collator: ICU's ties and the JVM's java.text.Collator differ.

/** The level-2 key: the name after NFKC, A-Z lower-cased and katakana folded to hiragana (compared by UTF-16 code unit). */
export function nameSortKey(name: string): string {
  let key = "";
  for (const ch of name.normalize("NFKC")) {
    const code = ch.codePointAt(0) ?? 0;
    key += code >= 0x41 && code <= 0x5a ? String.fromCharCode(code + 0x20) : code >= 0x30a1 && code <= 0x30f6 ? String.fromCharCode(code - 0x60) : ch;
  }
  return key;
}

const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Small kana as the large ones (level 1). */
const LARGE_KANA: Record<number, number> = {
  0x3041: 0x3042, 0x3043: 0x3044, 0x3045: 0x3046, 0x3047: 0x3048, 0x3049: 0x304a, 0x3063: 0x3064,
  0x3083: 0x3084, 0x3085: 0x3086, 0x3087: 0x3088, 0x308e: 0x308f, 0x3095: 0x304b, 0x3096: 0x3051,
};

let jisIndex: Map<number, number> | null = null;
function jisRank(code: number): number | undefined {
  if (!jisIndex) {
    jisIndex = new Map();
    let rank = 0;
    for (const ch of JIS_KANJI) jisIndex.set(ch.codePointAt(0) ?? 0, rank++);
  }
  return jisIndex.get(code);
}

/** One level-1 element: [class, weight, digits]; a run of digits compares by its length, then its digits. */
type CollationElement = [number, number, string];

const isIdeograph = (c: number) => (c >= 0x3400 && c <= 0x4dbf) || (c >= 0x4e00 && c <= 0x9fff) || (c >= 0xf900 && c <= 0xfaff) || (c >= 0x20000 && c <= 0x3ffff);

/** The level-1 elements of a name: NFKD, combining and voicing marks dropped, then classified (see the JSON's comment). */
export function collationElements(name: string): CollationElement[] {
  const codes = [...name.normalize("NFKD")].map((ch) => ch.codePointAt(0) ?? 0);
  const out: CollationElement[] = [];
  for (let i = 0; i < codes.length; i++) {
    const c = codes[i]!;
    if ((c >= 0x300 && c <= 0x36f) || c === 0x3099 || c === 0x309a) continue;
    if (c >= 0x30 && c <= 0x39) {
      let j = i;
      while (j < codes.length && codes[j]! >= 0x30 && codes[j]! <= 0x39) j++;
      const digits = String.fromCharCode(...codes.slice(i, j)).replace(/^0+/, "") || "0";
      out.push([1, digits.length, digits]);
      i = j - 1;
      continue;
    }
    const rank = jisRank(c);
    if (c >= 0x41 && c <= 0x5a) out.push([2, c + 0x20, ""]);
    else if (c >= 0x61 && c <= 0x7a) out.push([2, c, ""]);
    else if ((c >= 0x3041 && c <= 0x3096) || (c >= 0x30a1 && c <= 0x30f6)) {
      const hiragana = c >= 0x30a1 ? c - 0x60 : c;
      out.push([3, LARGE_KANA[hiragana] ?? hiragana, ""]);
    } else if (rank !== undefined) out.push([4, rank, ""]);
    else if (isIdeograph(c)) out.push([4, 10000 + c, ""]);
    else if (c < 0x3040 || (c >= 0x309b && c <= 0x30a0) || (c >= 0x30fb && c <= 0x30ff) || (c >= 0xff00 && c <= 0xffef)) out.push([0, c, ""]);
    else out.push([5, c, ""]);
  }
  return out;
}

const elementCache = new Map<string, CollationElement[]>();
function cachedElements(name: string): CollationElement[] {
  let elements = elementCache.get(name);
  if (!elements) {
    if (elementCache.size > 4000) elementCache.clear();
    elements = collationElements(name);
    elementCache.set(name, elements);
  }
  return elements;
}

function compareElements(a: CollationElement[], b: CollationElement[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const x = a[i]!, y = b[i]!;
    if (x[0] !== y[0]) return x[0] - y[0];
    if (x[1] !== y[1]) return x[1] - y[1];
    if (x[2] !== y[2]) return byCodeUnit(x[2], y[2]);
  }
  return a.length - b.length;
}

/**
 * Two names in the sidebar's Japanese order: level 1 [collationElements] (kana by gojūon, kanji in JIS X 0208 order,
 * numbers as numbers, case and voicing ignored), level 2 [nameSortKey], level 3 the raw names by UTF-16 code unit.
 */
export function compareNames(a: string, b: string): number {
  return compareElements(cachedElements(a), cachedElements(b)) || byCodeUnit(nameSortKey(a), nameSortKey(b)) || byCodeUnit(a, b);
}

/** A section's 並べ替え (DATA_MODEL.md sidebar_sections). */
export type SidebarSort = "name" | "recent" | "manual";
export type DefaultSectionKey = "favorites" | "channels" | "dms";
export interface SectionSort {
  sort?: SidebarSort | null;
  manual_order?: readonly string[] | null;
}
/** The default sections' sorts when I chose none (or the server is older). */
export const DEFAULT_SORTS: Record<DefaultSectionKey, SidebarSort> = { favorites: "name", channels: "name", dms: "recent" };

/** A default section's sort from the server's list. */
export function defaultSort(defaults: readonly SidebarDefaultOut[] | undefined, key: DefaultSectionKey): SectionSort {
  return defaults?.find((row) => row.key === key) ?? { sort: DEFAULT_SORTS[key], manual_order: [] };
}

type Sortable = Pick<ChannelState, "id" | "name" | "type" | "last_message_at" | "created_at">;
const isDm = (row: Pick<Sortable, "type">) => row.type === "dm" || row.type === "group_dm";

/** Channels by name, then by id. */
export function compareByName(a: Pick<Sortable, "id" | "name">, b: Pick<Sortable, "id" | "name">): number {
  return compareNames(a.name ?? "", b.name ?? "") || byCodeUnit(a.id, b.id);
}

/** Newest first: the last message, else when the conversation was made (the server's text), then by id. */
export function compareNewest(a: Pick<Sortable, "id" | "last_message_at" | "created_at">, b: Pick<Sortable, "id" | "last_message_at" | "created_at">): number {
  return byCodeUnit(b.last_message_at ?? b.created_at ?? "", a.last_message_at ?? a.created_at ?? "") || byCodeUnit(a.id, b.id);
}

/**
 * The rows of a section in its sort: name = channels by name, then DMs by their title (`title`, the client's display
 * title); recent = all newest first; manual = `manual_order` first, the rest after it by name.
 */
export function sectionOrder<T extends Sortable>(rows: readonly T[], sort: SectionSort = {}, title: (row: T) => string = (row) => row.name ?? ""): T[] {
  if (sort.sort === "recent") return [...rows].sort(compareNewest);
  if (sort.sort === "manual") {
    const place = new Map((sort.manual_order ?? []).map((id, index) => [id, index] as const));
    const placed = rows.filter((row) => place.has(row.id)).sort((a, b) => place.get(a.id)! - place.get(b.id)!);
    return [...placed, ...sectionOrder(rows.filter((row) => !place.has(row.id)), {}, title)];
  }
  const byTitle = (a: T, b: T) => compareNames(title(a), title(b)) || byCodeUnit(a.id, b.id);
  return [...rows.filter((row) => !isDm(row)).sort(compareByName), ...rows.filter(isDm).sort(byTitle)];
}

/**
 * M118 (DATA_MODEL.md sidebar_sections 「DM の固定」): the pinned DMs of a section first, in pin order (bootstrap's
 * `dm_pins`), then the others as they were. Only DMs and group DMs are ever pinned, so a channel never moves.
 */
export function pinnedFirst<T extends { id: string }>(rows: readonly T[], pins: readonly string[] | null | undefined): T[] {
  if (!pins?.length) return [...rows];
  const place = new Map(pins.map((id, index) => [id, index] as const));
  const pinned = rows.filter((row) => place.has(row.id)).sort((a, b) => place.get(a.id)! - place.get(b.id)!);
  return pinned.length ? [...pinned, ...rows.filter((row) => !place.has(row.id))] : [...rows];
}

/**
 * The sidebar order: each section in its sort (DMs: my own DM first unless by hand), joinable public channels by name.
 * M118: pinned DMs come first in every section that holds them, even by hand; then my own DM (when not pinned).
 */
export function sectionChannels(
  all: ChannelState[],
  options: {
    unreadOnly?: boolean;
    currentId?: string | null;
    now?: Date;
    favorites?: ReadonlySet<string>;
    sections?: readonly SidebarSectionOut[];
    defaults?: readonly SidebarDefaultOut[];
    meId?: string | null;
    title?: (channel: ChannelState) => string;
    /** M118: my pinned DMs, oldest pin first. */
    dmPins?: readonly string[] | null;
  } = {},
): ChannelSections {
  const meId = options.meId ?? null;
  const title = options.title;
  const keep = (channel: ChannelState) => !options.unreadOnly || channel.id === options.currentId || hasUnread(channel, meId, options.now);
  const isTimes = (channel: ChannelState) => !!channel.times_owner_id;
  const mineFirst = (a: ChannelState, b: ChannelState) => Number(b.times_owner_id === meId) - Number(a.times_owner_id === meId) || compareByName(a, b);
  const starred = (channel: ChannelState) => options.favorites?.has(channel.id) ?? false;
  const placed = new Map<string, string>();
  for (const section of options.sections ?? []) for (const id of section.channel_ids) placed.set(id, section.id);
  const loose = (channel: ChannelState) => !starred(channel) && !placed.has(channel.id);
  const visible = (channel: ChannelState) => channel.isMember && !channel.archived && keep(channel);
  const dmSort = defaultSort(options.defaults, "dms");
  const dms = all.filter((c) => c.isMember && isDmChannel(c) && keep(c) && loose(c));
  const pins = options.dmPins ?? null;
  const pinned = new Set(pins ?? []);
  const self = dmSort.sort === "manual" ? [] : dms.filter((c) => isSelfNotes(c, meId) && !pinned.has(c.id));
  return {
    favorites: pinnedFirst(sectionOrder(all.filter((c) => visible(c) && starred(c)), defaultSort(options.defaults, "favorites"), title), pins),
    custom: (options.sections ?? []).map((section) => ({ section, channels: pinnedFirst(sectionOrder(all.filter((c) => visible(c) && !starred(c) && placed.get(c.id) === section.id), section, title), pins) })),
    channels: sectionOrder(all.filter((c) => visible(c) && !isDmChannel(c) && !isTimes(c) && loose(c)), defaultSort(options.defaults, "channels"), title),
    times: all.filter((c) => visible(c) && isTimes(c) && loose(c)).sort(mineFirst),
    dms: [...pinnedFirst(dms.filter((c) => pinned.has(c.id)), pins), ...self, ...sectionOrder(dms.filter((c) => !pinned.has(c.id) && !self.includes(c)), dmSort, title)],
    browse: options.unreadOnly ? [] : all.filter((c) => !c.isMember && c.type === "public" && !c.archived).sort(compareByName),
  };
}

/** Alt+↑/↓ walks this order; Alt+Shift+↑/↓ walks only unread conversations. Wraps around. */
export function stepChannel(
  order: ChannelState[],
  currentId: string | null,
  delta: 1 | -1,
  options: { unreadOnly?: boolean; now?: Date; meId?: string | null } = {},
): ChannelState | undefined {
  if (order.length === 0) return undefined;
  const index = order.findIndex((c) => c.id === currentId);
  for (let step = 1; step <= order.length; step++) {
    const candidate = order[(index + delta * step + order.length * step) % order.length];
    if (!candidate || candidate.id === currentId) continue;
    if (!options.unreadOnly || hasUnread(candidate, options.meId ?? null, options.now)) return candidate;
  }
  return undefined;
}
