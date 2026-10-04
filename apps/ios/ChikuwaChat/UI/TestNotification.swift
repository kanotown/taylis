import SwiftUI

/// The words for 「テスト通知を送る」's result (PUSH_NOTIFICATIONS.md §15), the same as the desktop's and Android's.
enum TestNotificationText {
    enum Tone: Equatable { case ok, problem, none }

    static let platformNames = ["ios": "iPhone / iPad", "android": "Android", "desktop": "デスクトップ", "web": "ブラウザ"]

    /// The device's name as its owner knows it, with 「(この端末)」 on the one that asked.
    static func deviceName(_ device: TestNotificationDevice) -> String {
        let trimmed = device.deviceName?.trimmingCharacters(in: .whitespaces) ?? ""
        let name = trimmed.isEmpty ? (platformNames[device.platform] ?? device.platform) : trimmed
        return device.current ? "\(name) (この端末)" : name
    }

    static func status(_ device: TestNotificationDevice) -> (text: String, tone: Tone) {
        switch device.status {
        case "sent": return ("送信しました", .ok)
        case "failed": return (device.detail.map { "送れませんでした (\($0))" } ?? "送れませんでした", .problem)
        case "no_token": return ("プッシュ未登録 (端末の通知がオフか、アプリをまだ開き直していません)", .problem)
        case "not_configured":
            return (device.pushProvider == "fcm" ? "このサーバでは Android のプッシュが無効です" : "このサーバでは iOS のプッシュが無効です", .problem)
        case "in_app": return ("プッシュなし (アプリを開いていれば表示されます)", .none)
        case "disabled": return (device.detail == "session_expired" ? "ログインの期限切れ" : "ログアウト済み", .none)
        default: return (device.status, .none)
        }
    }

    /// Lines above the list: push off on this server, nothing that can take a push, DND.
    static func notes(_ out: TestNotificationOut) -> [String] {
        var notes: [String] = []
        if !out.apnsConfigured && !out.fcmConfigured {
            notes.append("このサーバはプッシュ通知が設定されていません (iPhone・Android のアプリには、開いている間だけ通知が出ます)")
        } else if !out.apnsConfigured {
            notes.append("iOS のプッシュ (APNs) はこのサーバでは無効です")
        } else if !out.fcmConfigured {
            notes.append("Android のプッシュ (FCM) はこのサーバでは無効です")
        }
        let phones = out.devices.filter { $0.status != "disabled" && ($0.platform == "ios" || $0.platform == "android") }
        if phones.isEmpty { notes.append("プッシュ通知を受け取れる端末 (iPhone・Android のアプリ) はありません") }
        if out.dndActive { notes.append("通知を一時停止中ですが、テスト通知は送りました") }
        return notes
    }
}

/// 「テスト通知」 in 「通知」: the server pushes to every device of mine; the list says what happened on each.
struct TestNotificationSection: View {
    let controller: AppController
    /// iOS's permission for this app: when it is off, the push cannot show here (said under the button).
    let permissionDenied: Bool
    @State private var busy = false
    @State private var result: TestNotificationOut?
    @State private var error: String?

    var body: some View {
        Section {
            Button {
                Task { await send() }
            } label: {
                HStack {
                    Label("テスト通知を送る", systemImage: "bell.badge")
                    if busy { Spacer(); ProgressView() }
                }
            }
            .disabled(busy)
            if let error {
                Text(error).font(.footnote).foregroundStyle(.red)
            }
            if let result {
                ForEach(TestNotificationText.notes(result), id: \.self) { note in
                    Text(note).font(.footnote).foregroundStyle(.secondary)
                }
                ForEach(result.devices) { device in
                    let status = TestNotificationText.status(device)
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Image(systemName: icon(status.tone)).foregroundStyle(color(status.tone))
                        VStack(alignment: .leading, spacing: 2) {
                            Text(TestNotificationText.deviceName(device))
                            Text(status.text).font(.footnote).foregroundStyle(status.tone == .problem ? Color.red : Color.secondary)
                        }
                    }
                    .accessibilityElement(children: .combine)
                }
            }
        } header: {
            Text("テスト通知")
        } footer: {
            if permissionDenied {
                Text("この端末では通知がオフのため、送っても表示されません。上の「設定アプリで変更」から許可してください。")
            } else {
                Text("この端末と、ほかの端末 (スマートフォンのアプリ・開いているデスクトップ版) に送ります。")
            }
        }
    }

    private func send() async {
        busy = true
        error = nil
        defer { busy = false }
        do {
            result = try await controller.sendTestNotification()
        } catch {
            result = nil
            self.error = controller.describe(error)
        }
    }

    private func icon(_ tone: TestNotificationText.Tone) -> String {
        switch tone {
        case .ok: return "checkmark.circle.fill"
        case .problem: return "exclamationmark.circle.fill"
        case .none: return "minus.circle"
        }
    }

    private func color(_ tone: TestNotificationText.Tone) -> Color {
        switch tone {
        case .ok: return .green
        case .problem: return .red
        case .none: return .secondary
        }
    }
}
