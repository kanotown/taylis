import XCTest
@testable import ChikuwaChat

/// M16b: the search conditions, date ranges, request, recent searches and suggestions (same cases as the desktop).
@MainActor
final class SearchLogicTests: XCTestCase {
    private let tokyo: Calendar = {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "Asia/Tokyo")!
        return calendar
    }()
    private var now: Date { tokyo.date(from: DateComponents(year: 2026, month: 9, day: 27, hour: 15, minute: 30))! }

    private func local(_ date: Date?) -> String? {
        guard let date else { return nil }
        let formatter = DateFormatter()
        formatter.calendar = tokyo
        formatter.timeZone = tokyo.timeZone
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy-MM-dd HH:mm"
        return formatter.string(from: date)
    }

    private func defaults() -> UserDefaults {
        let name = "search-tests-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: name)!
        defaults.removePersistentDomain(forName: name)
        return defaults
    }

    func testDatePresetsAndPickedDaysBecomeLocalMidnightsWithAnExclusiveEnd() {
        let today = SearchLogic.dateRange(.preset(.today), now: now, calendar: tokyo)
        XCTAssertEqual(local(today.after), "2026-09-27 00:00")
        XCTAssertNil(today.before)
        let yesterday = SearchLogic.dateRange(.preset(.yesterday), now: now, calendar: tokyo)
        XCTAssertEqual([local(yesterday.after), local(yesterday.before)], ["2026-09-26 00:00", "2026-09-27 00:00"])
        XCTAssertEqual(local(SearchLogic.dateRange(.preset(.week), now: now, calendar: tokyo).after), "2026-09-21 00:00")
        XCTAssertEqual(local(SearchLogic.dateRange(.preset(.month), now: now, calendar: tokyo).after), "2026-08-29 00:00")
        XCTAssertEqual(local(SearchLogic.dateRange(.preset(.year), now: now, calendar: tokyo).after), "2025-09-28 00:00")

        // The last picked day is included: `before` is the next day's midnight.
        let custom = SearchLogic.dateRange(.range(from: "2026-09-01", to: "2026-09-10"), now: now, calendar: tokyo)
        XCTAssertEqual([local(custom.after), local(custom.before)], ["2026-09-01 00:00", "2026-09-11 00:00"])
        let open = SearchLogic.dateRange(.range(from: nil, to: "2026-09-30"), now: now, calendar: tokyo)
        XCTAssertNil(open.after)
        XCTAssertEqual(local(open.before), "2026-10-01 00:00")
        let broken = SearchLogic.dateRange(.range(from: "nope", to: "2026-02-31"), now: now, calendar: tokyo)
        XCTAssertNil(broken.after)
        XCTAssertNil(broken.before)
        XCTAssertNil(SearchLogic.day("2026-9-1", calendar: tokyo))
        XCTAssertEqual(SearchLogic.dayString(now, calendar: tokyo), "2026-09-27")
    }

    func testLabels() {
        XCTAssertEqual(SearchLogic.dateLabel(.preset(.month)), "過去 30 日間")
        XCTAssertEqual(SearchLogic.dateLabel(.range(from: "2026-09-01", to: "2026-09-01")), "2026/09/01")
        XCTAssertEqual(SearchLogic.dateLabel(.range(from: "2026-09-01", to: "2026-09-10")), "2026/09/01 〜 2026/09/10")
        XCTAssertEqual(SearchLogic.dateLabel(.range(from: "2026-09-01", to: nil)), "2026/09/01 以降")
        XCTAssertEqual(SearchLogic.dateLabel(.range(from: nil, to: "2026-09-10")), "2026/09/10 まで")
        XCTAssertNil(SearchLogic.dateLabel(nil))
        XCTAssertEqual(SearchLogic.totalLabel(7, capped: false), "7 件")
        XCTAssertEqual(SearchLogic.totalLabel(1234, capped: false), "1,234 件")
        XCTAssertEqual(SearchLogic.totalLabel(1000, capped: true), "1,000 件以上")
    }

    /// MOBILE_POLISH.md S1: a hit's time is 今日 / 昨日 / the date, then a 24-hour time (Android's results the same).
    func testResultStampsSayTodayYesterdayOrTheDate() {
        XCTAssertEqual(SearchResultRow.stamp("2026-09-27T00:05:00Z", now: now, calendar: tokyo), "今日 9:05")
        XCTAssertEqual(SearchResultRow.stamp("2026-09-27T13:16:00.123456Z", now: now, calendar: tokyo), "今日 22:16")
        XCTAssertEqual(SearchResultRow.stamp("2026-09-26T05:00:00Z", now: now, calendar: tokyo), "昨日 14:00")
        XCTAssertEqual(SearchResultRow.stamp("2026-09-25T05:00:00Z", now: now, calendar: tokyo), "9月25日 (金) 14:00")
        XCTAssertEqual(SearchResultRow.stamp("2025-12-31T05:00:00Z", now: now, calendar: tokyo), "2025年12月31日 (水) 14:00")
        XCTAssertEqual(SearchResultRow.stamp("not a date", now: now, calendar: tokyo), "")
    }

    func testRequestSendsTheFiltersAndSortsFilterOnlySearchesNewestFirst() {
        let params = SearchParams(q: "  ", fromUserId: "u1", date: .preset(.yesterday), has: [.file, .link], isThread: true, sort: .relevance)
        XCTAssertFalse(params.isEmpty)
        XCTAssertTrue(SearchParams(q: " ").isEmpty)
        let items = SearchLogic.request(params, now: now, calendar: tokyo).queryItems(limit: 30, offset: 60)
        func values(_ name: String) -> [String] { items.filter { $0.name == name }.compactMap(\.value) }
        XCTAssertEqual(values("q"), [""])
        XCTAssertEqual(values("from_user_id"), ["u1"])
        XCTAssertEqual(values("channel_id"), [])
        XCTAssertEqual(values("has"), ["file", "link"])
        XCTAssertEqual(values("is_thread"), ["true"])
        XCTAssertEqual(values("sort"), ["newest"])
        XCTAssertEqual(values("after"), ["2026-09-26T00:00:00+09:00"])
        XCTAssertEqual(values("before"), ["2026-09-27T00:00:00+09:00"])
        XCTAssertEqual(values("tz_offset_minutes"), ["540"])
        XCTAssertEqual(values("limit"), ["30"])
        XCTAssertEqual(values("offset"), ["60"])

        var worded = params
        worded.q = " 設計 "
        let request = SearchLogic.request(worded, now: now, calendar: tokyo)
        XCTAssertEqual(request.q, "設計")
        XCTAssertEqual(request.sort, .relevance)
        let plain = SearchLogic.request(SearchParams(q: "a", channelId: "c1"), now: now, calendar: tokyo).queryItems(limit: 30, offset: 0)
        XCTAssertFalse(plain.contains { $0.name == "is_thread" || $0.name == "has" || $0.name == "after" || $0.name == "before" })
        XCTAssertTrue(plain.contains(URLQueryItem(name: "channel_id", value: "c1")))

        // "+09:00" must reach the server as a plus, not a space.
        let path = ApiClient.pathWithQuery("/api/v1/search/messages", SearchLogic.request(SearchParams(date: .preset(.today)), now: now, calendar: tokyo)
            .queryItems(limit: 30, offset: 0))
        XCTAssertTrue(path.contains("after=2026-09-27T00:00:00%2B09:00"), path)
    }

    /// The search covers public channels I have not joined and archived ones; 「アーカイブを除く」 leaves the archives out.
    func testArchivedChannelsCanBeLeftOutAndHitsAreTagged() throws {
        let params = SearchParams(q: "設計", excludeArchived: true)
        let request = SearchLogic.request(params, now: now, calendar: tokyo)
        XCTAssertTrue(request.queryItems(limit: 30, offset: 0).contains(URLQueryItem(name: "exclude_archived", value: "true")))
        XCTAssertFalse(request.canvasQueryItems(limit: 30, offset: 0).contains { $0.name == "exclude_archived" })
        XCTAssertFalse(request.pageQueryItems(limit: 30, offset: 0).contains { $0.name == "exclude_archived" })
        XCTAssertFalse(SearchLogic.request(SearchParams(q: "設計"), now: now, calendar: tokyo).queryItems(limit: 30, offset: 0)
            .contains { $0.name == "exclude_archived" })
        // Alone it is no condition (the words are still needed), and clearing the filters drops it.
        XCTAssertTrue(SearchParams(excludeArchived: true).isEmpty)
        XCTAssertFalse(params.withoutFilters.excludeArchived)
        XCTAssertEqual(SearchLogic.describe(params, userName: { _ in nil }, channelTitle: { _ in nil }), "設計 · アーカイブを除く")
        // Remembered searches keep it (the desktop's field name); ones saved before it read as off.
        let encoded = try JSONEncoder().encode(params)
        XCTAssertEqual(try JSONDecoder().decode(SearchParams.self, from: encoded), params)
        XCTAssertEqual(try JSONDecoder().decode(SearchParams.self, from: Data(#"{"q":"a","excludeArchived":true}"#.utf8)).excludeArchived, true)
        XCTAssertEqual(try JSONDecoder().decode(SearchParams.self, from: Data(#"{"q":"a"}"#.utf8)).excludeArchived, false)

        XCTAssertEqual(SearchLogic.channelTag(archived: false, joined: false), "未参加")
        XCTAssertEqual(SearchLogic.channelTag(archived: true, joined: false), "未参加・アーカイブ済み")
        XCTAssertEqual(SearchLogic.channelTag(archived: true, joined: true), "アーカイブ済み")
        XCTAssertNil(SearchLogic.channelTag(archived: false, joined: true))
    }

    func testClearingFiltersKeepsTheWordsAndTokensFollowTheFilters() {
        let params = SearchParams(q: " 設計 ", fromUserId: "u1", channelId: "c1", date: .preset(.week), has: [.file], isThread: true, sort: .newest)
        XCTAssertTrue(params.hasFilters)
        XCTAssertEqual(params.withoutFilters, SearchParams(q: " 設計 ", sort: .newest))
        XCTAssertEqual(params.tokens, [.sender("u1"), .channel("c1")])
        let edited = params.applying([.channel("c2")])
        XCTAssertNil(edited.fromUserId)
        XCTAssertEqual(edited.channelId, "c2")
        XCTAssertEqual(edited.has, [.file])
        XCTAssertEqual(SearchLogic.describe(params, userName: { $0 == "u1" ? "田中" : nil }, channelTitle: { $0 == "c1" ? "#general" : nil }),
                       "設計 · 送信者：田中 · #general · 過去 7 日間 · ファイルあり · スレッド内")
        XCTAssertEqual(SearchLogic.describe(SearchParams(fromUserId: "gone"), userName: { _ in nil }, channelTitle: { _ in nil }), "送信者：?")
    }

    func testRecentSearchesKeepTenNewestFirstWithoutDuplicatesPerAccount() {
        let defaults = defaults()
        let key = RecentSearches.key(account: "http://s|alice")
        XCTAssertEqual(key, "chikuwa.search.recent:http://s|alice")
        for i in 0..<12 { RecentSearches.push(SearchParams(q: "word \(i)"), key: key, defaults: defaults) }
        RecentSearches.push(SearchParams(q: "word 5 ", sort: .newest), key: key, defaults: defaults) // only the order differs
        let list = RecentSearches.read(key: key, defaults: defaults)
        XCTAssertEqual(list.count, 10)
        XCTAssertEqual(list[0].q, "word 5")
        XCTAssertEqual(list.filter { $0.q == "word 5" }.count, 1)
        XCTAssertEqual(RecentSearches.read(key: RecentSearches.key(account: "http://s|bob"), defaults: defaults), [])
        XCTAssertFalse(RecentSearches.remove(list[0], key: key, defaults: defaults).contains { $0.q == "word 5" })
        RecentSearches.push(SearchParams(), key: key, defaults: defaults) // nothing to remember
        XCTAssertEqual(RecentSearches.read(key: key, defaults: defaults).count, 9)
        RecentSearches.clear(key: key, defaults: defaults)
        XCTAssertEqual(RecentSearches.read(key: key, defaults: defaults), [])
    }

    func testRecentSearchesKeepTheirFiltersAndSurviveDamage() {
        let defaults = defaults()
        let key = RecentSearches.key(account: "a")
        let full = SearchParams(q: "設計", fromUserId: "u1", channelId: "c1", date: .range(from: "2026-09-01", to: nil), has: [.poll, .pin], isThread: true, sort: .newest)
        RecentSearches.push(full, key: key, defaults: defaults)
        RecentSearches.push(SearchParams(date: .preset(.week)), key: key, defaults: defaults)
        XCTAssertEqual(RecentSearches.read(key: key, defaults: defaults), [SearchParams(date: .preset(.week)), full])

        defaults.set("{not json", forKey: key)
        XCTAssertEqual(RecentSearches.read(key: key, defaults: defaults), [])
        defaults.set(#"[{"q":"ok","has":["file","bogus"],"date":{"preset":"someday"}},3,null,{"x":1}]"#, forKey: key)
        XCTAssertEqual(RecentSearches.read(key: key, defaults: defaults), [SearchParams(q: "ok", has: [.file])])
        // The desktop's shape (explicit nulls) reads the same.
        defaults.set(#"[{"q":"a","fromUserId":null,"channelId":"c","date":{"preset":"week"},"has":[],"isThread":false,"sort":"newest"}]"#, forKey: key)
        XCTAssertEqual(RecentSearches.read(key: key, defaults: defaults), [SearchParams(q: "a", channelId: "c", date: .preset(.week), sort: .newest)])
    }

    private func user(_ id: String, _ username: String, _ name: String, deactivated: Bool = false) -> UserPublic {
        UserPublic(id: id, username: username, displayName: name, role: "member", deactivatedAt: deactivated ? "2026-01-01T00:00:00Z" : nil, createdAt: "", updatedAt: "")
    }

    private func channel(_ id: String, _ name: String, member: Bool = true) -> ChannelState {
        let out = ChannelOut(id: id, type: "public", name: name, topic: nil, purpose: nil, archived: false, createdBy: nil, lastSeq: 0, lastMessageAt: nil,
                             createdAt: "", updatedAt: "", membership: member ? MembershipOut(role: "member", joinedAt: "") : nil, dmUserIds: nil)
        return ChannelState(channel: out, isMember: member, syncedSeq: nil, lastSeq: 0, hasOlder: false)
    }

    func testSuggestionsForAnEmptyFieldAndWhileTyping() {
        let users = [user("u1", "tanaka", "田中 太郎"), user("u2", "taro.s", "佐藤 太郎"), user("u3", "gone", "田中 退職", deactivated: true)]
        let channels = [channel("c1", "tanaka-lab"), channel("c2", "general"), channel("c3", "tanaka-secret", member: false)]
        let title: (ChannelState) -> String = { "#\($0.channel.name ?? "")" }
        let recent = [SearchParams(q: "田中さんの資料")]

        let empty = SearchSuggestions.build("  ", users: users, channels: channels, recent: recent, title: title)
        XCTAssertEqual(empty, [.recent(recent[0]), .has(.file), .has(.link), .has(.pin), .thread, .times])
        XCTAssertEqual(SearchSuggestions.grouped(empty).map(\.group), [.recent, .filters])

        let typing = SearchSuggestions.build("田中", users: users, channels: channels, recent: recent, title: title)
        XCTAssertEqual(typing.first, .search("田中"))
        XCTAssertEqual(typing.compactMap { if case .user(let u) = $0 { return u.id } else { return nil } }, ["u1"]) // not the deactivated one
        XCTAssertTrue(typing.contains(.recent(recent[0])))
        XCTAssertEqual(SearchSuggestions.grouped(typing).map(\.group), [.search, .people, .recent])

        let byName = SearchSuggestions.build("@tanaka", users: users, channels: channels, recent: [], title: title)
        XCTAssertEqual(byName.map(\.id), ["search:@tanaka", "user:u1", "channel:c1"]) // only conversations I am in
        // Full-width letters fold like the desktop (NFKC + lowercase).
        XCTAssertEqual(SearchSuggestions.build("ＴＡＮＡＫＡ", users: users, channels: channels, recent: [], title: title).map(\.id),
                       ["search:ＴＡＮＡＫＡ", "user:u1", "channel:c1"])
        // A person whose username starts with the words comes before one who only contains them.
        let people = [user("a", "abby", "Amy"), user("b", "bob", "Zed")]
        XCTAssertEqual(SearchSuggestions.build("b", users: people, channels: [], recent: [], title: title).map(\.id), ["search:b", "user:b", "user:a"])
        // At most four people and four conversations.
        let many = (0..<6).map { user("m\($0)", "member\($0)", "Member \($0)") }
        let rooms = (0..<6).map { channel("r\($0)", "member-room-\($0)") }
        let crowded = SearchSuggestions.build("member", users: many, channels: rooms, recent: [], title: title)
        XCTAssertEqual(crowded.filter { $0.group == .people }.count, 4)
        XCTAssertEqual(crowded.filter { $0.group == .conversations }.count, 4)
    }
}
