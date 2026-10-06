import Foundation

// M16b: the search screen's conditions, date presets, recent searches and as-you-type suggestions.
// Same rules as the desktop (apps/desktop/src/ui/search.ts); the UI is in SearchView.swift.

/// The content filters of GET /search/messages (`has`, repeatable).
enum SearchHasFlag: String, Codable, CaseIterable, Identifiable {
    case file, link, pin, reaction, poll

    var id: String { rawValue }

    var label: String {
        switch self {
        case .file: return tr("ファイルあり")
        case .link: return tr("リンクあり")
        case .pin: return tr("ピン留め")
        case .reaction: return tr("リアクションあり")
        case .poll: return tr("投票")
        }
    }

    var systemImage: String {
        switch self {
        case .file: return "paperclip"
        case .link: return "link"
        case .pin: return "pin"
        case .reaction: return "face.smiling"
        case .poll: return "chart.bar"
        }
    }
}

enum SearchSort: String, Codable, CaseIterable, Identifiable {
    case relevance, newest

    var id: String { rawValue }
    var label: String { self == .relevance ? tr("関連度順") : tr("新しい順") }
}

enum SearchDatePreset: String, Codable, CaseIterable, Identifiable {
    case today, yesterday, week, month, year

    var id: String { rawValue }

    var label: String {
        switch self {
        case .today: return tr("今日")
        case .yesterday: return tr("昨日")
        case .week: return tr("過去 7 日間")
        case .month: return tr("過去 30 日間")
        case .year: return tr("過去 1 年間")
        }
    }

    /// How many days before today the range starts (today is one of the days).
    var daysBack: Int {
        switch self {
        case .today: return 0
        case .yesterday: return 1
        case .week: return 6
        case .month: return 29
        case .year: return 364
        }
    }
}

/// The period filter: a preset (resolved when the search runs, so a remembered 「今日」 stays today) or days picked
/// on the calendar ("YYYY-MM-DD" in the device's zone; either end may be open).
enum SearchDate: Hashable, Codable {
    case preset(SearchDatePreset)
    case range(from: String?, to: String?)

    private enum Keys: String, CodingKey { case preset, from, to }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        if let preset = try c.decodeIfPresent(SearchDatePreset.self, forKey: .preset) {
            self = .preset(preset)
        } else {
            self = .range(from: try c.decodeIfPresent(String.self, forKey: .from), to: try c.decodeIfPresent(String.self, forKey: .to))
        }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: Keys.self)
        switch self {
        case .preset(let preset):
            try c.encode(preset, forKey: .preset)
        case .range(let from, let to):
            try c.encode(from, forKey: .from)
            try c.encode(to, forKey: .to)
        }
    }
}

/// What a search looks for: the words (typed modifiers such as from:@name stay in them) plus the filters picked
/// from menus. Stored as JSON for 「最近の検索」 (same field names as the desktop).
struct SearchParams: Hashable, Codable {
    var q = ""
    var fromUserId: String? = nil
    var channelId: String? = nil
    var date: SearchDate? = nil
    var has: [SearchHasFlag] = []
    var isThread = false
    /// L8 (TIMES_FEED.md §6): only times channels (the 「Times」 chip; is:times typed in the words works too).
    var isTimes = false
    var sort: SearchSort = .relevance

    init(q: String = "", fromUserId: String? = nil, channelId: String? = nil, date: SearchDate? = nil, has: [SearchHasFlag] = [],
         isThread: Bool = false, isTimes: Bool = false, sort: SearchSort = .relevance) {
        self.q = q
        self.fromUserId = fromUserId
        self.channelId = channelId
        self.date = date
        self.has = has
        self.isThread = isThread
        self.isTimes = isTimes
        self.sort = sort
    }

    private enum CodingKeys: String, CodingKey { case q, fromUserId, channelId, date, has, isThread, isTimes, sort }

    /// Lenient: a remembered search keeps what it can (unknown kinds are dropped, a bad date is forgotten).
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        q = try c.decode(String.self, forKey: .q)
        fromUserId = try? c.decodeIfPresent(String.self, forKey: .fromUserId)
        channelId = try? c.decodeIfPresent(String.self, forKey: .channelId)
        date = try? c.decodeIfPresent(SearchDate.self, forKey: .date)
        has = ((try? c.decodeIfPresent([String].self, forKey: .has)) ?? []).compactMap(SearchHasFlag.init(rawValue:))
        isThread = (try? c.decodeIfPresent(Bool.self, forKey: .isThread)) ?? false
        isTimes = (try? c.decodeIfPresent(Bool.self, forKey: .isTimes)) ?? false
        sort = (try? c.decodeIfPresent(SearchSort.self, forKey: .sort)) ?? .relevance
    }

    var words: String { q.trimmingCharacters(in: .whitespacesAndNewlines) }
    var hasFilters: Bool { fromUserId != nil || channelId != nil || date != nil || !has.isEmpty || isThread || isTimes }
    /// Nothing to look for: no words and no filters (the server answers empty_query).
    var isEmpty: Bool { words.isEmpty && !hasFilters }
    /// 「条件をクリア」: the words and the order stay.
    var withoutFilters: SearchParams { SearchParams(q: q, sort: sort) }
    /// Searches without words are always newest first (there is nothing to rank by).
    var effectiveSort: SearchSort { words.isEmpty ? .newest : sort }
}

/// GET /search/messages for one search: `after` inclusive, `before` exclusive.
struct SearchRequest: Equatable {
    var q: String
    var channelId: String?
    var fromUserId: String?
    var after: Date?
    var before: Date?
    var has: [SearchHasFlag]
    var isThread: Bool
    var isTimes = false
    var sort: SearchSort
    /// The caller's zone for typed before: / after: / on: dates (DATA_MODEL.md 検索).
    var tzOffsetMinutes: Int
    var timeZone: TimeZone

    func queryItems(limit: Int, offset: Int) -> [URLQueryItem] {
        let iso = ISO8601DateFormatter()
        iso.timeZone = timeZone
        iso.formatOptions = [.withInternetDateTime]
        var items = [URLQueryItem(name: "q", value: q)]
        if let channelId { items.append(URLQueryItem(name: "channel_id", value: channelId)) }
        if let fromUserId { items.append(URLQueryItem(name: "from_user_id", value: fromUserId)) }
        if let after { items.append(URLQueryItem(name: "after", value: iso.string(from: after))) }
        if let before { items.append(URLQueryItem(name: "before", value: iso.string(from: before))) }
        for flag in has { items.append(URLQueryItem(name: "has", value: flag.rawValue)) }
        if isThread { items.append(URLQueryItem(name: "is_thread", value: "true")) }
        if isTimes { items.append(URLQueryItem(name: "is_times", value: "true")) }
        items.append(URLQueryItem(name: "sort", value: sort.rawValue))
        items.append(URLQueryItem(name: "tz_offset_minutes", value: String(tzOffsetMinutes)))
        items.append(URLQueryItem(name: "limit", value: String(limit)))
        items.append(URLQueryItem(name: "offset", value: String(offset)))
        return items
    }

    /// M58: GET /search/canvases takes the same words, person, conversation, dates and order; not has: / is:thread /
    /// is:times (a canvas has none of them: typed ones come back as unresolved).
    func canvasQueryItems(limit: Int, offset: Int) -> [URLQueryItem] {
        let skipped: Set<String> = ["has", "is_thread", "is_times"]
        return queryItems(limit: limit, offset: offset).filter { !skipped.contains($0.name) }
    }

    /// Nothing a canvas search could look for: no words, conversation, person or dates (it is not sent).
    var canvasIsEmpty: Bool { q.isEmpty && channelId == nil && fromUserId == nil && after == nil && before == nil }

    /// M122 (docs/WIKI.md §8.1): GET /search/pages takes the words (`in:<page title>` stays in them), the person (who made
    /// or last changed the page), the dates and the order; pages belong to no conversation.
    func pageQueryItems(limit: Int, offset: Int) -> [URLQueryItem] {
        let skipped: Set<String> = ["has", "is_thread", "is_times", "channel_id"]
        return queryItems(limit: limit, offset: offset).filter { !skipped.contains($0.name) }
    }

    /// Nothing a page search could look for (it is not sent).
    var pageIsEmpty: Bool { q.isEmpty && fromUserId == nil && after == nil && before == nil }
}

enum SearchLogic {
    /// The instants the API filters on, in the viewer's days: presets count back from today's midnight, a picked
    /// range runs from its first day's midnight to the midnight after its last day.
    static func dateRange(_ date: SearchDate?, now: Date = Date(), calendar: Calendar = .current) -> (after: Date?, before: Date?) {
        guard let date else { return (nil, nil) }
        switch date {
        case .preset(let preset):
            let today = calendar.startOfDay(for: now)
            return (calendar.date(byAdding: .day, value: -preset.daysBack, to: today), preset == .yesterday ? today : nil)
        case .range(let from, let to):
            let end = day(to, calendar: calendar).flatMap { calendar.date(byAdding: .day, value: 1, to: $0) }
            return (day(from, calendar: calendar), end)
        }
    }

    /// "YYYY-MM-DD" → that day's midnight in the calendar's zone; nil for anything else (2026-02-31 included).
    static func day(_ value: String?, calendar: Calendar = .current) -> Date? {
        guard let value, value.range(of: #"^\d{4}-\d{2}-\d{2}$"#, options: .regularExpression) != nil else { return nil }
        let parts = value.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3, let date = calendar.date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2])) else { return nil }
        let check = calendar.dateComponents([.year, .month, .day], from: date)
        guard check.year == parts[0], check.month == parts[1], check.day == parts[2] else { return nil }
        return calendar.startOfDay(for: date)
    }

    /// A picked calendar day as "YYYY-MM-DD" (the form a range keeps).
    static func dayString(_ date: Date, calendar: Calendar = .current) -> String {
        let parts = calendar.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", parts.year ?? 0, parts.month ?? 0, parts.day ?? 0)
    }

    /// The chip text for the period filter.
    static func dateLabel(_ date: SearchDate?) -> String? {
        guard let date else { return nil }
        switch date {
        case .preset(let preset):
            return preset.label
        case .range(let from, let to):
            let start = from?.replacingOccurrences(of: "-", with: "/")
            let end = to?.replacingOccurrences(of: "-", with: "/")
            if let start, let end { return start == end ? start : tr("\(start) 〜 \(end)") }
            if let start { return tr("\(start) 以降") }
            if let end { return tr("\(end) まで") }
            return nil
        }
    }

    static func request(_ params: SearchParams, now: Date = Date(), calendar: Calendar = .current) -> SearchRequest {
        let range = dateRange(params.date, now: now, calendar: calendar)
        return SearchRequest(q: params.words, channelId: params.channelId, fromUserId: params.fromUserId, after: range.after, before: range.before,
                             has: params.has, isThread: params.isThread, isTimes: params.isTimes, sort: params.effectiveSort,
                             tzOffsetMinutes: calendar.timeZone.secondsFromGMT(for: now) / 60, timeZone: calendar.timeZone)
    }

    /// L8: a hit's channel the store does not know (SearchOut.channels): its bare name, 「(アーカイブ済み)」 after an
    /// archived one; 「?」 without one.
    static func otherChannelName(_ channel: ChannelOut?) -> String {
        guard let channel, let name = channel.name else { return "?" }
        return channel.archived ? tr("\(name)（アーカイブ済み）") : name
    }

    /// 「123 件」, or 「1,000 件以上」 when the server stopped counting.
    static func totalLabel(_ total: Int, capped: Bool) -> String {
        let formatter = NumberFormatter()
        formatter.numberStyle = .decimal
        formatter.locale = UILanguage.shared.locale
        return tr("\(formatter.string(from: NSNumber(value: total)) ?? String(total)) 件\(capped ? tr("以上") : "")")
    }

    /// One line for a search: the words, then the filters (「設計」 · 送信者: 田中 · #general · 過去 7 日間).
    static func describe(_ params: SearchParams, userName: (String) -> String?, channelTitle: (String) -> String?) -> String {
        var parts: [String] = []
        if !params.words.isEmpty { parts.append(params.words) }
        if let id = params.fromUserId { parts.append(tr("送信者：\(userName(id) ?? "?")")) }
        if let id = params.channelId { parts.append(channelTitle(id) ?? "?") }
        if let date = dateLabel(params.date) { parts.append(date) }
        parts += params.has.map(\.label)
        if params.isThread { parts.append(tr("スレッド内")) }
        if params.isTimes { parts.append("Times") }
        return parts.joined(separator: " · ")
    }
}

/// 「最近の検索」: the last ten searches of one account on this device (UserDefaults, a convenience only).
enum RecentSearches {
    static let limit = 10

    /// `account` is "server|username" (the same name as the Keychain item and the local store).
    static func key(account: String) -> String { "chikuwa.search.recent:\(account)" }

    /// Two searches are the same when only the order differs.
    static func same(_ a: SearchParams, _ b: SearchParams) -> Bool {
        var x = a
        var y = b
        x.q = x.words
        y.q = y.words
        x.sort = .relevance
        y.sort = .relevance
        return x == y
    }

    static func read(key: String, defaults: UserDefaults = .standard) -> [SearchParams] {
        guard let text = defaults.string(forKey: key), let data = text.data(using: .utf8),
              let rows = (try? JSONSerialization.jsonObject(with: data)) as? [Any] else { return [] }
        let entries: [SearchParams] = rows.compactMap { row in
            guard let object = row as? [String: Any], let json = try? JSONSerialization.data(withJSONObject: object) else { return nil }
            return try? JSONDecoder().decode(SearchParams.self, from: json)
        }
        return Array(entries.prefix(limit))
    }

    /// Newest first, without duplicates; returns the new list. An empty search is not remembered.
    @discardableResult
    static func push(_ params: SearchParams, key: String, defaults: UserDefaults = .standard) -> [SearchParams] {
        guard !params.isEmpty else { return read(key: key, defaults: defaults) }
        var entry = params
        entry.q = params.words
        let next = Array(([entry] + read(key: key, defaults: defaults).filter { !same($0, entry) }).prefix(limit))
        write(next, key: key, defaults: defaults)
        return next
    }

    @discardableResult
    static func remove(_ params: SearchParams, key: String, defaults: UserDefaults = .standard) -> [SearchParams] {
        let next = read(key: key, defaults: defaults).filter { !same($0, params) }
        write(next, key: key, defaults: defaults)
        return next
    }

    static func clear(key: String, defaults: UserDefaults = .standard) {
        defaults.removeObject(forKey: key)
    }

    private static func write(_ entries: [SearchParams], key: String, defaults: UserDefaults) {
        guard let data = try? JSONEncoder().encode(entries), let text = String(data: data, encoding: .utf8) else { return }
        defaults.set(text, forKey: key)
    }
}

/// A row under the search field.
enum SearchSuggestion: Hashable, Identifiable {
    /// 「"xxx" を検索」
    case search(String)
    case recent(SearchParams)
    /// → 送信者
    case user(UserPublic)
    /// → チャンネル (a conversation I am in)
    case channel(id: String, title: String, type: String)
    case has(SearchHasFlag)
    case thread
    /// L8: is:times (TIMES_FEED.md §6).
    case times

    var id: String {
        switch self {
        case .search(let q): return "search:\(q)"
        case .recent(let params):
            let json = (try? JSONEncoder().encode(params)).flatMap { String(data: $0, encoding: .utf8) }
            return "recent:\(json ?? params.q)"
        case .user(let user): return "user:\(user.id)"
        case .channel(let id, _, _): return "channel:\(id)"
        case .has(let flag): return "has:\(flag.rawValue)"
        case .thread: return "thread"
        case .times: return "times"
        }
    }

    /// Rows of one kind sit under one heading.
    var group: SearchSuggestionGroup {
        switch self {
        case .search: return .search
        case .recent: return .recent
        case .user: return .people
        case .channel: return .conversations
        case .has, .thread, .times: return .filters
        }
    }
}

enum SearchSuggestionGroup: String {
    case search, recent, filters, people, conversations

    var heading: String? {
        switch self {
        case .search: return nil
        case .recent: return tr("最近の検索")
        case .filters: return tr("絞り込み")
        case .people: return tr("人（この人の投稿）")
        case .conversations: return tr("チャンネル（この中を検索）")
        }
    }
}

enum SearchSuggestions {
    /// Width, case and kana variants compare equal (NFKC + lowercase), as on the desktop.
    static func fold(_ value: String) -> String { value.precomposedStringWithCompatibilityMapping.lowercased() }

    /// Empty field: recent searches, then quick filters. While typing: search for the words, then people
    /// (→ 送信者) and conversations I am in (→ チャンネル) whose names match, then matching recent searches.
    static func build(_ input: String, users: [UserPublic], channels: [ChannelState], recent: [SearchParams],
                      title: (ChannelState) -> String) -> [SearchSuggestion] {
        let text = input.trimmingCharacters(in: .whitespacesAndNewlines)
        if text.isEmpty {
            return recent.prefix(RecentSearches.limit).map { SearchSuggestion.recent($0) } + [.has(.file), .has(.link), .has(.pin), .thread, .times]
        }
        var bare = text
        if bare.hasPrefix("@") || bare.hasPrefix("#") { bare.removeFirst() }
        let needle = fold(bare)
        let japanese = Locale(identifier: "ja")
        let people = users
            .filter { $0.deactivatedAt == nil && (fold($0.displayName).contains(needle) || fold($0.username).contains(needle)) }
            .sorted { a, b in
                let aFirst = fold(a.username).hasPrefix(needle)
                let bFirst = fold(b.username).hasPrefix(needle)
                if aFirst != bFirst { return aFirst }
                return a.displayName.compare(b.displayName, locale: japanese) == .orderedAscending
            }
            .prefix(4)
            .map { SearchSuggestion.user($0) }
        let conversations = channels
            .filter { $0.isMember && fold(title($0)).contains(needle) }
            .map { (state: $0, title: title($0)) }
            .sorted { $0.title.compare($1.title, locale: japanese) == .orderedAscending }
            .prefix(4)
            .map { SearchSuggestion.channel(id: $0.state.id, title: $0.title, type: $0.state.channel.type) }
        let matching = recent
            .filter { !$0.q.isEmpty && fold($0.q).contains(fold(text)) && $0.q != text }
            .prefix(3)
            .map { SearchSuggestion.recent($0) }
        return [.search(text)] + people + conversations + matching
    }

    /// The rows cut where the kind changes, each run under its heading.
    static func grouped(_ rows: [SearchSuggestion]) -> [SearchSuggestionSection] {
        var result: [SearchSuggestionSection] = []
        for row in rows {
            if let last = result.last, last.group == row.group {
                result[result.count - 1].rows.append(row)
            } else {
                result.append(SearchSuggestionSection(group: row.group, rows: [row]))
            }
        }
        return result
    }
}

struct SearchSuggestionSection: Identifiable {
    let group: SearchSuggestionGroup
    var rows: [SearchSuggestion]

    var id: String { group.rawValue }
}

/// A sender or a conversation filter shown as a token in the search field.
enum SearchToken: Hashable, Identifiable {
    case sender(String)
    case channel(String)

    var id: String {
        switch self {
        case .sender(let id): return "sender:\(id)"
        case .channel(let id): return "channel:\(id)"
        }
    }
}

extension SearchParams {
    /// The field's tokens for these filters (sender first).
    var tokens: [SearchToken] {
        var tokens: [SearchToken] = []
        if let fromUserId { tokens.append(.sender(fromUserId)) }
        if let channelId { tokens.append(.channel(channelId)) }
        return tokens
    }

    /// The same search with the sender and conversation the tokens name (the last one of a kind wins).
    func applying(_ tokens: [SearchToken]) -> SearchParams {
        var next = self
        next.fromUserId = nil
        next.channelId = nil
        for token in tokens {
            switch token {
            case .sender(let id): next.fromUserId = id
            case .channel(let id): next.channelId = id
            }
        }
        return next
    }
}
