import SwiftUI
import UIKit

/// M117 (docs/CALLS.md): calls by meeting link. The server makes the room and posts it as a message; the call itself
/// happens outside the app (the Jitsi Meet app takes meet.jit.si's universal links when installed, otherwise Safari).
enum CallRules {
    /// The 📞 in the conversation's bar (§7): calls on (a server before M117 sends no switch), a member who may start
    /// top-level posts (an announcement channel: owners and admins), not archived, not my DM with myself (nobody to call).
    static func canStart(_ channel: ChannelState, settings: WorkspaceSettings, isAdmin: Bool, meId: String?) -> Bool {
        settings.callsEnabled && channel.isMember && !channel.channel.archived && channel.canPostTopLevel(isAdmin: isAdmin)
            && !(channel.channel.type == "dm" && DMList.isNotesToSelf(channel, meId: meId))
    }

    /// 「📞 〇〇 さんが通話を始めました」: the card's line (the push says the same, server/app/i18n/messages.json).
    static func startedLine(_ name: String) -> String { tr("📞 \(name) さんが通話を始めました") }

    /// What the card opens: http(s) only (the server makes https rooms; http only for a local test server).
    static func joinUrl(_ call: MessageCall) -> URL? {
        guard let url = URL(string: call.url), let scheme = url.scheme?.lowercased(), scheme == "https" || scheme == "http",
              url.host?.isEmpty == false else { return nil }
        return url
    }

    /// The server's own line in the body (§5, for clients before M117).
    static let bodyLead = "📞 通話を始めました"  // i18n-ignore: the server's text, matched

    /// What of a call message's body shows under its card: nothing for the server's 「📞 通話を始めました」 and the link
    /// (the card says both), and what an edit added otherwise.
    static func extraBody(_ body: String, call: MessageCall) -> String {
        body.components(separatedBy: "\n")
            .filter { line in
                let text = line.trimmingCharacters(in: .whitespaces)
                return text != bodyLead && text != call.url && text != "<\(call.url)>"
            }
            .joined(separator: "\n")
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Outside the app, never in a web view (camera and microphone permissions, §7).
    @MainActor
    static func open(_ url: URL) { UIApplication.shared.open(url) }
}

/// One idempotency key per conversation until its call is posted (CALLS.md §7): a retry after a failure (a lost answer
/// too) sends the same `client_msg_id`, and the server answers with the call it already made. A refused request lets
/// the key go; a key older than ten minutes is not reused (a tap much later is a new call).
struct CallKeys {
    static let lifetime: TimeInterval = 600
    private var keys: [String: (key: String, at: Date)] = [:]

    mutating func key(for channelId: String, now: Date = Date(), make: () -> String = { UUID().uuidString.lowercased() }) -> String {
        if let held = keys[channelId], now.timeIntervalSince(held.at) < Self.lifetime { return held.key }
        let key = make()
        keys[channelId] = (key, now)
        return key
    }

    /// Posted, or refused: the next tap is a new call.
    mutating func done(_ channelId: String) { keys[channelId] = nil }
}

extension AppController {
    /// M117 (docs/CALLS.md §7): `POST /channels/{id}/calls`; the message into the conversation, the room's URL back to
    /// open. A failure says why and keeps the key for a retry when trying again can help; `409 calls_disabled` hides the 📞.
    func startCall(_ channelId: String) async -> URL? {
        guard let api else { return nil }
        let key = callKeys.key(for: channelId)
        do {
            let call = try await api.startCall(channelId: channelId, clientMsgId: key)
            callKeys.done(channelId)
            if let engine { engine.postedFromHere(call.message) } else { store.upsertMessage(call.message) }
            return URL(string: call.url)
        } catch {
            if let apiError = error as? ApiError, !apiError.isRetryable {
                callKeys.done(channelId)
                if apiError.code == "calls_disabled" { store.callsTurnedOff() }
            }
            self.error = describe(error)
            return nil
        }
    }
}

/// The card a call message shows instead of its link (§7): who started it, and 「参加する」 for as long as it is there
/// (the server does not know when a call ends).
struct CallCardView: View {
    let call: MessageCall
    let starter: String

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "phone.fill")
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(.white)
                .frame(width: 32, height: 32)
                .background(Color.green, in: Circle())
                .accessibilityHidden(true)
            Text(tr("\(starter) さんが通話を始めました"))
                .font(.subheadline)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 4)
            if let url = CallRules.joinUrl(call) {
                Button("参加する") { CallRules.open(url) }
                    .buttonStyle(.borderedProminent)
                    .tint(.green)
                    .controlSize(.small)
            }
        }
        .padding(10)
        .background(Color.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).stroke(Color.secondary.opacity(0.2), lineWidth: 0.5))
        .frame(maxWidth: 420, alignment: .leading)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(CallRules.startedLine(starter))
    }
}

/// The conversation bar's 📞: a confirmation first (a link goes to every member), then the room opens outside the app.
struct CallButton: View {
    @Bindable var controller: AppController
    let channelId: String
    @State private var confirming = false
    @State private var starting = false

    var body: some View {
        Button { confirming = true } label: { Image(systemName: "phone") }
            .disabled(starting)
            .accessibilityLabel("通話を始める")
            // An alert in the middle of the screen, as the delete confirmation (a dialog pointed at the bar sat oddly).
            .alert("通話を始めますか？", isPresented: $confirming) {
                Button("キャンセル", role: .cancel) {}
                Button("通話を始める") { start() }
            } message: {
                Text("メンバーに通知が届き、会議のリンクが投稿されます。")
            }
    }

    private func start() {
        starting = true
        Task {
            if let url = await controller.startCall(channelId) { CallRules.open(url) }
            starting = false
        }
    }
}
