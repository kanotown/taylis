import SwiftUI

/// The start of a conversation (M11h): what the channel is for, who made it and how many are in it.
struct ChannelIntroView: View {
    @Bindable var controller: AppController
    let channel: ChannelState

    var body: some View {
        let store = controller.store
        let out = channel.channel
        let title = channelTitle(channel, store: store)
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Image(systemName: out.isDm ? "at" : (out.type == "private" ? "lock" : "number")).foregroundStyle(.secondary)
                Text(out.isDm ? title : String(title.drop(while: { $0 == "#" }))).font(.title2).bold()
            }
            Text(summary(store: store, title: title)).font(.subheadline).foregroundStyle(.secondary)
            if let text = out.purpose ?? out.topic, !text.isEmpty { Text(text).font(.subheadline) }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 12).padding(.top, 16).padding(.bottom, 10)
    }

    private func summary(store: Store, title: String) -> String {
        let out = channel.channel
        if out.isDm { return "\(title) との会話の始まりです。" }
        var text = ""
        if let creator = out.createdBy.flatMap({ store.users[$0]?.displayName }) { text += "\(creator) が" }
        if let date = Self.date(out.createdAt) { text += Self.dayFormatter.string(from: date) + "に" }
        text += "作成した\(out.type == "private" ? "非公開" : "公開")チャンネルの始まりです。"
        if let count = out.memberCount, count > 0 { text += " メンバー \(count) 人。" }
        return text
    }

    private static let dayFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "ja_JP")
        formatter.dateFormat = "yyyy年M月d日"
        return formatter
    }()
    private static let fractional: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()
    private static func date(_ raw: String) -> Date? { fractional.date(from: raw) ?? ISO8601DateFormatter().date(from: raw) }
}
