import Observation
import SwiftUI
import UIKit

/// M69: the iCal feed calls (ApiClient and the test fakes).
@MainActor
protocol CalendarFeedApi: AnyObject {
    func calendarFeeds() async throws -> [CalendarFeedOut]
    func createCalendarFeed(scope: String) async throws -> CalendarFeedCreated
    func deleteCalendarFeed(id: String) async throws
}

/// M69 (CALENDAR.md §10.6, §10.9): what the 「カレンダーを購読 (iCal)」 screen holds: my feeds, the scope chosen for a new
/// one, the URL just made (shown this once: the server keeps only a hash) and the last error, in the shared words.
@MainActor
@Observable
final class CalendarFeedsModel {
    enum Scope: String, CaseIterable, Identifiable {
        case all, personal

        var id: String { rawValue }
        var choice: String { self == .all ? tr("すべて（自分のカレンダーと参加しているチャンネル）") : tr("自分のカレンダーだけ") }
    }

    /// nil: not read yet.
    private(set) var feeds: [CalendarFeedOut]?
    var scope: Scope = .all
    /// The URL made last, until the screen closes.
    private(set) var madeUrl: String?
    private(set) var copied = false
    private(set) var busy = false
    private(set) var error: String?
    @ObservationIgnored private let api: CalendarFeedApi?
    @ObservationIgnored private let describe: (Error) -> String

    init(api: CalendarFeedApi?, describe: @escaping (Error) -> String = ErrorMessages.text(for:)) {
        self.api = api
        self.describe = describe
    }

    var available: Bool { api != nil }

    static func scopeLabel(_ scope: String) -> String { scope == "personal" ? tr("自分のカレンダーだけ") : tr("すべて") }

    /// 「2026/10/2」.
    static func shortDate(_ iso: String) -> String {
        guard let date = parseIsoDate(iso) else { return "" }
        let p = CalendarDates.local.dateComponents([.year, .month, .day], from: date)
        return "\(p.year!)/\(p.month!)/\(p.day!)"
    }

    /// 「2026/10/2 に作成 ・ まだ読まれていません」.
    static func detail(_ feed: CalendarFeedOut) -> String {
        let used = feed.lastUsedAt.map { tr("\(shortDate($0)) に読まれました") } ?? tr("まだ読まれていません")
        return tr("\(shortDate(feed.createdAt)) に作成 ・ \(used)")
    }

    /// The URL as Apple's calendar subscribes to it (webcal: opens the 「照会」 sheet on the phone).
    static func webcal(_ url: String) -> URL? {
        guard let range = url.range(of: "^https?://", options: .regularExpression) else { return nil }
        return URL(string: "webcal://" + url[range.upperBound...])
    }

    func load() async {
        guard let api else { return }
        do {
            feeds = try await api.calendarFeeds()
        } catch {
            self.error = describe(error)
        }
    }

    func create() async {
        guard let api, !busy else { return }
        busy = true
        error = nil
        defer { busy = false }
        do {
            let created = try await api.createCalendarFeed(scope: scope.rawValue)
            madeUrl = created.url
            copied = false
            feeds = (feeds ?? []) + [created.feed]
        } catch {
            self.error = describe(error)
        }
    }

    func remove(_ feed: CalendarFeedOut) async {
        guard let api, !busy else { return }
        busy = true
        error = nil
        defer { busy = false }
        do {
            try await api.deleteCalendarFeed(id: feed.id)
            feeds = (feeds ?? []).filter { $0.id != feed.id }
        } catch {
            self.error = describe(error)
        }
    }

    /// The URL made onto the clipboard.
    func copy(to pasteboard: UIPasteboard = .general) {
        guard let madeUrl else { return }
        pasteboard.string = madeUrl
        copied = true
    }
}

/// M69: 「カレンダーを購読 (iCal)」 from the calendar's ⋯ — make a private feed URL (everything I see, or my own calendar
/// only), copy it (shown this once), list my URLs and delete them (the URL stops at once), with how to add one to Google
/// and Apple's calendars. Anyone who has a URL sees the events: the screen says so first.
struct CalendarFeedsView: View {
    @State var model: CalendarFeedsModel
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Label("購読 URL を知っている人は、ログインしなくても誰でも予定を見られます。人に教えないでください。漏れたら削除して作り直してください。",
                          systemImage: "exclamationmark.triangle")
                        .font(.footnote)
                        .foregroundStyle(.orange)
                }
                Section {
                    Picker("範囲", selection: $model.scope) {
                        ForEach(CalendarFeedsModel.Scope.allCases) { Text($0.choice).tag($0) }
                    }
                    .pickerStyle(.inline)
                    .labelsHidden()
                    Button("購読 URL を作る") { Task { await model.create() } }
                        .disabled(!model.available || model.busy)
                } header: {
                    Text("範囲")
                } footer: {
                    Text("Google カレンダーや Apple のカレンダーにこのカレンダーの予定を表示します（読み取り専用）。")
                }
                if let url = model.madeUrl {
                    Section {
                        Text(url).font(.footnote.monospaced()).textSelection(.enabled).accessibilityLabel("購読 URL")
                        Button { model.copy() } label: {
                            Label(model.copied ? "コピーしました" : "コピー", systemImage: model.copied ? "checkmark" : "doc.on.doc")
                        }
                        if let webcal = CalendarFeedsModel.webcal(url) {
                            Button { openURL(webcal) } label: { Label("この iPhone のカレンダーに追加", systemImage: "calendar.badge.plus") }
                        }
                    } header: {
                        Text("購読 URL")
                    } footer: {
                        Text("この URL はいまだけ表示します。閉じると再表示できません（必要なら作り直してください）。")
                    }
                }
                Section("作った購読 URL") {
                    if let feeds = model.feeds {
                        if feeds.isEmpty {
                            Text("まだありません").foregroundStyle(.secondary)
                        }
                        ForEach(feeds) { feed in
                            HStack {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(CalendarFeedsModel.scopeLabel(feed.scope))
                                    Text(CalendarFeedsModel.detail(feed)).font(.caption).foregroundStyle(.secondary)
                                }
                                Spacer(minLength: 0)
                                Button(role: .destructive) { Task { await model.remove(feed) } } label: {
                                    Image(systemName: "trash")
                                }
                                .buttonStyle(.borderless)
                                .disabled(model.busy)
                                .accessibilityLabel("この購読 URL を削除")
                            }
                        }
                    } else {
                        Text(model.available ? "読み込み中…" : "接続すると表示します").foregroundStyle(.secondary)
                    }
                }
                if let error = model.error {
                    Section { Text(error).foregroundStyle(.red).font(.footnote) }
                }
                Section("使い方") {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Google カレンダー（ブラウザ）：左の「他のカレンダー」の「＋」→「URL で追加」に URL を貼り付けて「カレンダーを追加」。")
                        Text("iPhone：上の「この iPhone のカレンダーに追加」、または「設定」→「カレンダー」→「アカウント」→「アカウントを追加」→「その他」→「照会するカレンダーを追加」に URL を貼り付け。Mac は「ファイル」→「新規カレンダー照会…」。")
                        Text("反映はカレンダーのアプリが読みに来たとき（数分〜数時間ごと）です。90 日前から 400 日先までの予定が入ります。")
                    }
                    .font(.caption)
                    .foregroundStyle(.secondary)
                }
            }
            .navigationTitle("カレンダーを購読（iCal）")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("閉じる") { dismiss() } }
            }
            .task { await model.load() }
        }
    }
}
