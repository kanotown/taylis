import SwiftUI

/// M143 (docs/ACTIONS.md §12, §12.4): the state of what the buttons operate (「施錠中・ドア閉」), as the relays tell it —
/// the rules (the same as Desktop / Web's actions.ts) and the line under each group's heading.
extension ActionRules {
    /// The key a group's state is held by: "g:<label>", or "a:<id>" for a button without a group (its own group).
    static func statusKey(_ groupLabel: String?, _ actionId: String) -> String {
        if let label = groupLabel?.trimmingCharacters(in: .whitespacesAndNewlines), !label.isEmpty { return "g:\(label)" }
        return "a:\(actionId)"
    }

    /// Whether `a` was fetched after `b` (ISO times; an unreadable one counts as old).
    static func isNewer(_ a: String, than b: String) -> Bool {
        guard let first = parseIsoDate(a) else { return false }
        guard let second = parseIsoDate(b) else { return true }
        return first > second
    }

    /// 「状態を取得できませんでした：…」 with the relay's message, else a sentence for the reason.
    static func statusFailureText(_ status: ActionStatusOut) -> String {
        if let message = status.message?.trimmingCharacters(in: .whitespacesAndNewlines), !message.isEmpty {
            return statusFailed(message)
        }
        let reason: String
        switch status.error {
        case "timeout": reason = tr("中継から応答がありませんでした")
        case "network": reason = tr("中継に接続できませんでした")
        case "relay_error": reason = tr("中継がエラーを返しました")
        case "invalid_answer": reason = tr("中継の答えを読めませんでした")
        case "secret_missing", "url_not_allowed": reason = tr("ボタンの設定に問題があります。管理者に連絡してください")
        default: reason = tr("原因はわかりません")
        }
        return statusFailed(reason)
    }

    static func statusFailed(_ reason: String) -> String { tr("状態を取得できませんでした：\(reason)") }

    /// Why a whole read failed: 429 「少し待ってからもう一度押してください」, else the shared error text.
    static func statusReadFailure(_ error: Error) -> String {
        if case ApiError.api(let status, _, _) = error, status == 429 { return tr("少し待ってからもう一度押してください") }
        return ErrorMessages.text(for: error)
    }

    /// 「たった今確認」「3 分前に確認」, or the time (「10:23 に確認」, 「10/7 10:23 に確認」) an hour or more ago.
    static func checkedLabel(_ iso: String, now: Date = Date(), calendar: Calendar = .current) -> String {
        guard let at = parseIsoDate(iso) else { return "" }
        let minutes = Int(max(0, now.timeIntervalSince(at)) / 60)
        if minutes < 1 { return tr("たった今確認") }
        if minutes < 60 { return tr("\(minutes) 分前に確認") }
        let parts = calendar.dateComponents([.month, .day, .hour, .minute], from: at)
        let time = "\(parts.hour ?? 0):" + String(format: "%02d", parts.minute ?? 0)
        let when = calendar.isDate(at, inSameDayAs: now) ? time : "\(parts.month ?? 0)/\(parts.day ?? 0) \(time)"
        return tr("\(when) に確認")
    }

    /// The details as one line: 「電池 85% · ドア 閉」.
    static func statusDetails(_ status: ActionStatusOut) -> String {
        (status.status?.details ?? []).map { "\($0.label) \($0.value)" }.joined(separator: " · ")
    }

    /// What a group's state line shows (nil: nothing — no state is provided for it).
    enum StatusLine: Equatable {
        case state(ActionStatusOut)
        case failed(String)
        case loading
    }

    /// `expected`: a button of the group provides the state (a status I may only see arrives by the group's name).
    static func statusLine(_ status: ActionStatusOut?, expected: Bool, loading: Bool, readError: String?) -> StatusLine? {
        if let status {
            return status.ok && status.status != nil ? .state(status) : .failed(statusFailureText(status))
        }
        guard expected else { return nil }
        if let readError { return .failed(statusFailed(readError)) }
        return loading ? .loading : nil
    }

    /// The tone's dot: ok green, warn yellow, alert red, neutral (or unknown) gray.
    static func toneColor(_ tone: String) -> Color {
        switch tone {
        case "ok": .green
        case "warn": .orange
        case "alert": .red
        default: .gray
        }
    }
}

/// How often the states are read again while a page shows them (the server answers from its cache in between).
let actionStatusPollSeconds: TimeInterval = 60

/// The states as a page shows them: the first read under way, a refresh the person asked for, why the last read failed.
/// Held by the page (`.task` reads on open and every minute while it is on screen and the app is active).
@MainActor
@Observable
final class ActionStatusFeed {
    private(set) var loading = true
    private(set) var refreshing = false
    private(set) var error: String?
    /// For 「◯分前に確認」 (moves every half minute).
    private(set) var now = Date()
    @ObservationIgnored private var lastRead: Date?

    func read(_ load: (Bool) async throws -> Void, refresh: Bool = false) async {
        lastRead = Date()
        if refresh { refreshing = true }
        do {
            try await load(refresh)
            error = nil
        } catch is CancellationError {
        } catch ApiError.network(let underlying as URLError) where underlying.code == .cancelled {
        } catch {
            self.error = ActionRules.statusReadFailure(error)
        }
        loading = false
        if refresh { refreshing = false }
        now = Date()
    }

    /// While the page is on screen: read now if the last read is a minute old (or none), then every minute; `now` every
    /// half minute. Ends when the task is cancelled (the page left, the app went to the background).
    func run(_ load: @escaping (Bool) async throws -> Void) async {
        while !Task.isCancelled {
            if lastRead.map({ Date().timeIntervalSince($0) >= actionStatusPollSeconds - 1 }) ?? true { await read(load) }
            now = Date()
            try? await Task.sleep(for: .seconds(30))
        }
    }
}

extension AppController {
    /// GET /actions/status into the store (`refresh`: ask the relays now).
    func loadActionStatuses(refresh: Bool) async throws {
        try await engine?.loadActionStatuses(refresh: refresh)
    }
}

/// One group's state under its heading: a tone dot, the text, the details and 「◯分前に確認」, the refresh button; or
/// 「状態を確認中…」, or why it is missing. `label`: the button's name, for a button without a group.
struct ActionStatusRow: View {
    let line: ActionRules.StatusLine
    var label: String? = nil
    let feed: ActionStatusFeed
    let refresh: () -> Void

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Circle()
                .fill(dotColor)
                .frame(width: 9, height: 9)
                .alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + 4 }
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                main
                if case .state(let status) = line {
                    let details = ActionRules.statusDetails(status)
                    Text([details, ActionRules.checkedLabel(status.fetchedAt, now: feed.now)].filter { !$0.isEmpty }.joined(separator: " · "))
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            Button(action: refresh) {
                if feed.refreshing {
                    ProgressView().controlSize(.small)
                } else {
                    Image(systemName: "arrow.clockwise").font(.footnote.weight(.semibold))
                }
            }
            .buttonStyle(.borderless)
            .disabled(feed.refreshing)
            .frame(minWidth: 32, minHeight: 32)
            .accessibilityLabel("状態を更新")
        }
        .accessibilityElement(children: .contain)
    }

    private var dotColor: Color {
        if case .state(let status) = line { return ActionRules.toneColor(status.status?.tone ?? "neutral") }
        return Color(.tertiaryLabel)
    }

    @ViewBuilder
    private var main: some View {
        let prefix = label.map { "\($0)：" } ?? ""  // i18n-ignore: the name and a separator
        switch line {
        case .state(let status):
            Text(prefix + (status.status?.text ?? "")).font(.subheadline.weight(.semibold))
        case .failed(let text):
            Text(prefix + text).font(.subheadline).foregroundStyle(.red)
        case .loading:
            Text(prefix + tr("状態を確認中…")).font(.subheadline).foregroundStyle(.secondary)
        }
    }
}

/// The state rows of a group: one for a named group; one per button that provides its own for the ungrouped ones.
struct ActionGroupStatus: View {
    @Bindable var controller: AppController
    let group: ActionRules.Group
    let feed: ActionStatusFeed

    var body: some View {
        let statuses = controller.store.actionStatuses
        if let label = group.label, let first = group.actions.first {
            row(statuses[ActionRules.statusKey(label, first.id)], expected: group.actions.contains { $0.providesStatus == true }, label: nil)
        } else {
            ForEach(group.actions) { action in
                row(statuses[ActionRules.statusKey(nil, action.id)], expected: action.providesStatus == true, label: action.name)
            }
        }
    }

    @ViewBuilder
    private func row(_ status: ActionStatusOut?, expected: Bool, label: String?) -> some View {
        if let line = ActionRules.statusLine(status, expected: expected, loading: feed.loading, readError: feed.error) {
            ActionStatusRow(line: line, label: label, feed: feed) {
                Task {
                    await feed.read({ try await controller.loadActionStatuses(refresh: $0) }, refresh: true)
                    // A refresh I asked for that failed (429 「少し待って…」, no answer) says so even over a state shown.
                    if let error = feed.error { controller.error = error }
                }
            }
        }
    }
}

/// Reads the states while the page is on screen and the app active (§12.4), when there are buttons to show.
struct ActionStatusPolling: ViewModifier {
    let controller: AppController
    let feed: ActionStatusFeed
    let active: Bool
    @Environment(\.scenePhase) private var scenePhase

    func body(content: Content) -> some View {
        content.task(id: active && scenePhase == .active) {
            guard active, scenePhase == .active else { return }
            await feed.run { try await controller.loadActionStatuses(refresh: $0) }
        }
    }
}

extension View {
    func actionStatusPolling(_ controller: AppController, feed: ActionStatusFeed, active: Bool) -> some View {
        modifier(ActionStatusPolling(controller: controller, feed: feed, active: active))
    }
}
