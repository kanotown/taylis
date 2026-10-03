import SwiftUI

/// M88 / M89 (docs/MEMBERSHIP.md §1, §5): the line a system message (type "system": the join / leave lines) shows.
/// Written from its `system_event` with the names in the directory today (a renamed person reads with the new name);
/// the body (names as they were, written by the server) stands in when the event is missing, of a kind this version
/// does not know, or names someone the directory does not have. The web's `systemMessageText`.
enum SystemMessage {
    /// 「A、B」 as the server writes the list (the Japanese comma, no 「と」).
    static func joinNames(_ names: [String]) -> String { names.joined(separator: "、") }

    static func text(body: String, event: SystemEvent?, nameOf: (String) -> String?) -> String {
        guard let event, let actor = nameOf(event.actorId) else { return body }
        let others = event.userIds.map(nameOf)
        if others.contains(where: { $0 == nil }) { return body }
        let list = joinNames(others.compactMap { $0 })
        switch event.kind {
        case "member_joined": return "\(actor) が参加しました"
        case "member_left": return "\(actor) が退出しました"
        case "members_added": return "\(actor) が \(list) を追加しました"
        case "member_removed": return "\(actor) が \(list) を外しました"
        default: return body
        }
    }

    static func text(_ message: MessageState, users: [String: UserPublic]) -> String {
        text(body: message.body, event: message.systemEvent) { users[$0]?.displayName }
    }
}

/// M89 (MEMBERSHIP.md §5 3.): a system line in a timeline: one centred, small, muted line with its time. No avatar, no
/// name header, no reactions or thread line, and a tap or a long press opens nothing (no action sheet, so no
/// 「ここから未読にする」 either). The conversation lays it out as any other row (D23: one row of the upside-down list).
struct SystemMessageRow: View {
    let message: MessageState
    let store: Store
    var margin: CGFloat = 0
    var focused = false

    var body: some View {
        let text = SystemMessage.text(message, users: store.users)
        (Text(text) + Text("  " + Timeline.timeLabel(message.createdAt)).foregroundStyle(.tertiary))
            .font(.caption)
            .foregroundStyle(.secondary)
            .multilineTextAlignment(.center)
            .frame(maxWidth: .infinity, alignment: .center)
            .padding(.vertical, 5)
            .padding(.horizontal, margin)
            .background(focused ? Color.yellow.opacity(0.18) : Color.clear)
            .contentShape(Rectangle())
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("\(text)、\(Timeline.fullLabel(message.createdAt))")
    }
}
