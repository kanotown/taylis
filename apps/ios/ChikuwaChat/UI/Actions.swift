import SwiftUI

/// M143 (docs/ACTIONS.md §9.2): the rules of the 操作ボタン, apart from how they look (the same as Desktop / Web's
/// actions.ts). Pressing calls the relay once through the server; only a network failure (no answer from our server)
/// sends the same request again, with the same client_invoke_id, so the server answers the first result and never calls
/// the relay twice.
enum ActionRules {
    struct Group: Equatable, Identifiable {
        /// The group's name; nil for the buttons without one (drawn last).
        let label: String?
        let actions: [ActionOut]
        var id: String { label ?? "\u{0}" }
    }

    /// The buttons in the administrator's order, grouped by `groupLabel` (a group where its first button is; the ungrouped
    /// ones last).
    static func groups(_ actions: [ActionOut]) -> [Group] {
        let sorted = actions.enumerated().sorted { ($0.element.position, $0.offset) < ($1.element.position, $1.offset) }.map(\.element)
        var order: [String] = []
        var byLabel: [String: [ActionOut]] = [:]
        var loose: [ActionOut] = []
        for action in sorted {
            guard let label = cleanLabel(action.groupLabel) else {
                loose.append(action)
                continue
            }
            if byLabel[label] == nil { order.append(label) }
            byLabel[label, default: []].append(action)
        }
        var out = order.map { Group(label: $0, actions: byLabel[$0] ?? []) }
        if !loose.isEmpty { out.append(Group(label: nil, actions: loose)) }
        return out
    }

    private static func cleanLabel(_ label: String?) -> String? {
        guard let trimmed = label?.trimmingCharacters(in: .whitespacesAndNewlines), !trimmed.isEmpty else { return nil }
        return trimmed
    }

    /// 「研究室の鍵：開ける」, or the name alone.
    static func title(_ action: ActionOut) -> String {
        guard let group = cleanLabel(action.groupLabel) else { return action.name }
        return tr("\(group)：\(action.name)")
    }

    /// The confirmation's sentence: the administrator's, else 「研究室の鍵：開ける を実行しますか？」.
    static func confirmText(_ action: ActionOut) -> String {
        if let own = action.confirmText?.trimmingCharacters(in: .whitespacesAndNewlines), !own.isEmpty { return own }
        return tr("\(title(action)) を実行しますか？")
    }

    /// The buttons to draw (none while off, from an older server, or when I may press nothing).
    static func pressable(_ list: ActionListOut?) -> [ActionOut] {
        guard let list, list.enabled else { return [] }
        return list.actions
    }

    /// The buttons on the 在室状況 page and in its quick switch too (the workspace's 「在室状況のページにも表示する」).
    static func onAttendance(_ list: ActionListOut?) -> [ActionOut] {
        guard let list, list.showOnAttendance else { return [] }
        return pressable(list)
    }

    /// Whether 「操作」 has its tile (and its switch in the tiles' settings): the feature on, at least one button I may
    /// press, and never for a guest or a bot (the server gives them none anyway).
    static func visible(_ list: ActionListOut?, role: String?) -> Bool {
        guard let role, role != "guest", role != "bot" else { return false }
        return !pressable(list).isEmpty
    }

    /// What to say after a press: the relay's message if it gave one, else a sentence for the outcome.
    static func resultText(_ out: ActionInvokeOut, action: ActionOut) -> (ok: Bool, text: String) {
        let message = out.message?.trimmingCharacters(in: .whitespacesAndNewlines)
        if out.ok { return (true, message?.isEmpty == false ? message! : tr("\(title(action)) を実行しました")) }
        if let message, !message.isEmpty { return (false, message) }
        switch out.error {
        case "timeout":
            return (false, tr("機器（またはハブ）から応答がありませんでした。実行されたかどうかわかりません。状態を確かめてください"))
        case "network":
            return (false, tr("機器（またはハブ）に接続できませんでした。オフラインかもしれません"))
        case "interrupted":
            return (false, tr("送信が途中で止まりました。実行されたかどうかわかりません。状態を確かめてください"))
        case "secret_missing", "url_not_allowed":
            return (false, tr("このボタンの設定に問題があります。管理者に連絡してください"))
        case "relay_error":
            let status = out.statusCode.map(String.init) ?? "?"
            return (false, tr("実行できませんでした（HTTP \(status)）"))
        default:
            return (false, out.status == "pending" ? tr("まだ処理中です。少し待ってから状態を確かめてください") : tr("実行できませんでした"))
        }
    }

    /// The text for a press the server refused (429, no permission, turned off) or that never reached the server.
    static func refusalText(_ error: Error) -> String {
        if case ApiError.api(let status, _, _) = error, status == 429 { return tr("少し待ってからもう一度押してください") }
        return ErrorMessages.text(for: error)
    }

    /// A new id per press.
    static func newInvokeId() -> String { UUID().uuidString.lowercased() }

    /// One press: the server calls the relay once. A network failure (no answer from our server) is sent again with the
    /// same id, up to `attempts` times in all (the first and 2 more); the server answers a repeat with the first result
    /// instead of calling again. Any other failure (a refusal, 429, 5xx) is thrown at once: a person decides to press
    /// again.
    static func invokeOnce(_ invoke: (String) async throws -> ActionInvokeOut, attempts: Int = 3, id: String = newInvokeId(),
                           wait: (Int) async -> Void = { attempt in _ = try? await Task.sleep(for: .seconds(attempt)) }) async throws -> ActionInvokeOut {
        var attempt = 1
        while true {
            do {
                return try await invoke(id)
            } catch ApiError.network(let underlying) {
                if attempt >= attempts { throw ApiError.network(underlying) }
                await wait(attempt)
                attempt += 1
            }
        }
    }
}

extension AppController {
    /// M143: one press of a button (after its confirmation), the outcome in the notice (success, the relay's message) or
    /// the error banner (the relay's reason, a timeout, a refusal). True when it ran.
    @discardableResult
    func pressAction(_ action: ActionOut) async -> Bool {
        guard let api else { return false }
        do {
            let out = try await ActionRules.invokeOnce { id in try await api.invokeAction(id: action.id, clientInvokeId: id) }
            let result = ActionRules.resultText(out, action: action)
            if result.ok { notice = result.text } else { error = result.text }
            return result.ok
        } catch {
            self.error = ActionRules.refusalText(error)
            if case ApiError.api(_, let code, _) = error, ["actions_disabled", "action_not_found", "action_disabled", "action_not_allowed"].contains(code) {
                await engine?.loadActions()  // the list here is out of date
            }
            return false
        }
    }
}

/// A button's picture: its icon (the 在室状況 set), else its emoji, else a bolt. Decorative (the name is beside it).
struct ActionGlyph: View {
    let controller: AppController
    let action: ActionOut
    var size: CGFloat = 17

    var body: some View {
        if AttendanceIcons.glyph(icon: action.icon, emoji: action.emoji) == .none {
            Image(systemName: "bolt.fill")
                .font(.system(size: size * 0.85, weight: .semibold))
                .frame(width: AttendanceIcons.boxWidth(size), height: size)
                .accessibilityHidden(true)
        } else {
            AttendanceGlyph(controller: controller, icon: action.icon, emoji: action.emoji, size: size)
        }
    }
}

/// The presses of one screen (the 「操作」 page, the 在室状況 page, the quick switch): which buttons are being sent
/// (pressing one again meanwhile does nothing) and the one whose confirmation is open. Held by the screen, whose List
/// carries the confirmation (`actionConfirmation`), so a lazily drawn row never owns it.
@MainActor
@Observable
final class ActionPresser {
    private(set) var busy: Set<String> = []
    var asking: ActionOut?
    /// After each press answered (the quick switch closes then, so the notice or the banner shows).
    @ObservationIgnored var onFinished: (() -> Void)?

    /// A tap: the confirmation when the button wants one, else the press at once.
    func press(_ action: ActionOut, controller: AppController) {
        guard !busy.contains(action.id) else { return }
        if action.confirm { asking = action } else { run(action, controller: controller) }
    }

    func run(_ action: ActionOut, controller: AppController) {
        guard !busy.contains(action.id) else { return }
        busy.insert(action.id)
        Task {
            await controller.pressAction(action)
            busy.remove(action.id)
            onFinished?()
        }
    }
}

private struct ActionConfirmation: ViewModifier {
    @Bindable var presser: ActionPresser
    let controller: AppController

    func body(content: Content) -> some View {
        content.alert(presser.asking.map(ActionRules.title) ?? "",
                      isPresented: Binding(get: { presser.asking != nil }, set: { if !$0 { presser.asking = nil } }),
                      presenting: presser.asking) { action in
            Button("キャンセル", role: .cancel) {}
            Button("実行") { presser.run(action, controller: controller) }
        } message: { action in
            Text(ActionRules.confirmText(action))
        }
    }
}

extension View {
    /// The confirmation before a press (the button's title, its sentence, 「実行」).
    func actionConfirmation(_ presser: ActionPresser, controller: AppController) -> some View {
        modifier(ActionConfirmation(presser: presser, controller: controller))
    }
}

/// 「操作」 in the UI language (the shared catalogue's label is the Japanese 「操作」, which is also the gestures section).
var actionsTitle: String { tr(LocalizedStringResource("nav.actions", defaultValue: "操作")) }  // i18n-ignore: keyed (nav.actions)

/// The buttons in their groups for a List: a Section per group (its name as the header), its buttons side by side; the
/// ungrouped ones last. A press asks first (when the button wants it), then spins on the button until the relay answered;
/// the outcome shows in the notice or the error banner.
struct ActionButtonSections: View {
    @Bindable var controller: AppController
    let actions: [ActionOut]
    let presser: ActionPresser
    /// A heading over the first group (the 在室状況 page: 「操作」).
    var heading: String? = nil
    /// M143 §12.4: the groups' states, a line under each heading (nil: none shown).
    var feed: ActionStatusFeed? = nil

    var body: some View {
        let groups = ActionRules.groups(actions)
        ForEach(Array(groups.enumerated()), id: \.element.id) { index, group in
            Section {
                if let feed { ActionGroupStatus(controller: controller, group: group, feed: feed) }
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 132), spacing: 8)], spacing: 8) {
                    ForEach(group.actions) { action in button(action) }
                }
                .padding(.vertical, 4)
            } header: {
                header(group, first: index == 0)
            }
        }
    }

    @ViewBuilder
    private func header(_ group: ActionRules.Group, first: Bool) -> some View {
        if first, let heading {
            if let label = group.label { Text("\(heading) · \(label)").textCase(nil) } else { Text(heading).textCase(nil) }
        } else if let label = group.label {
            Text(label).textCase(nil)
        }
    }

    private func button(_ action: ActionOut) -> some View {
        let sending = presser.busy.contains(action.id)
        return Button { presser.press(action, controller: controller) } label: {
            HStack(spacing: 8) {
                if sending {
                    ProgressView().controlSize(.small)
                } else {
                    ActionGlyph(controller: controller, action: action)
                        .foregroundStyle(Color.accentColor)
                }
                Text(action.name).lineLimit(2).multilineTextAlignment(.center)
            }
            .font(.body.weight(.medium))
            .frame(maxWidth: .infinity, minHeight: 52)
            .padding(.horizontal, 10)
            .background(Color(.tertiarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Color(.separator), lineWidth: 1))
            .contentShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        }
        .buttonStyle(.plain)
        .foregroundStyle(Color.primary)
        .disabled(sending)
        .accessibilityLabel(ActionRules.title(action))
        .accessibilityValue(sending ? tr("送信中") : "")
    }
}

/// The quick switch's 「操作」 rows (在室状況's sheet, when the workspace shows the buttons there): 「組：名前」 per row,
/// spinning while sent.
struct ActionQuickRows: View {
    @Bindable var controller: AppController
    let actions: [ActionOut]
    let presser: ActionPresser

    var body: some View {
        Section {
            ForEach(ActionRules.groups(actions).flatMap(\.actions)) { action in row(action) }
        } header: {
            Text(actionsTitle)
        }
    }

    private func row(_ action: ActionOut) -> some View {
        let sending = presser.busy.contains(action.id)
        return Button { presser.press(action, controller: controller) } label: {
            HStack(spacing: 12) {
                Group {
                    if sending { ProgressView().controlSize(.small) } else { ActionGlyph(controller: controller, action: action) }
                }
                .foregroundStyle(Color.accentColor)
                .frame(width: 32, height: 32)
                .background(Color(.tertiarySystemFill), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                Text(ActionRules.title(action)).lineLimit(1)
                Spacer(minLength: 0)
            }
            .frame(minHeight: 48)
            .contentShape(Rectangle())
        }
        .foregroundStyle(Color.primary)
        .disabled(sending)
        .listRowInsets(EdgeInsets(top: 2, leading: 16, bottom: 2, trailing: 16))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(ActionRules.title(action))
        .accessibilityValue(sending ? tr("送信中") : "")
        .accessibilityAddTraits(.isButton)
    }
}

/// 「操作」 (docs/ACTIONS.md §9.2): the buttons I may press in their groups, from the home tile. The buttons are made on
/// Desktop / Web (管理 → 操作ボタン); nothing to manage here.
struct ActionsView: View {
    static let selectionId = "actions"
    @Bindable var controller: AppController
    @State private var presser = ActionPresser()
    @State private var statusFeed = ActionStatusFeed()

    var body: some View {
        let actions = ActionRules.pressable(controller.store.actions)
        List {
            if actions.isEmpty {
                ContentUnavailableView("押せるボタンはありません", systemImage: "bolt.slash")
                    .listRowBackground(Color.clear)
            } else {
                ActionButtonSections(controller: controller, actions: actions, presser: presser, feed: statusFeed)
            }
        }
        .listStyle(.insetGrouped)
        .actionConfirmation(presser, controller: controller)
        .actionStatusPolling(controller, feed: statusFeed, active: !actions.isEmpty)
        .navigationTitle(actionsTitle)
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await controller.engine?.loadActions() }
        .task { await controller.engine?.loadActions() }
    }
}
