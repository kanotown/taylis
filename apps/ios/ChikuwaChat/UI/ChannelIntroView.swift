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
        if out.isDm {
            return DMList.isNotesToSelf(channel, meId: store.me?.id) ? DMList.notesIntro : tr("\(title) との会話の始まりです。")
        }
        let creator = out.createdBy.flatMap { store.users[$0]?.displayName }
        let day = Self.date(out.createdAt).map { Self.dayFormatter.string(from: $0) }
        let isPrivate = out.type == "private"
        var text: String
        switch (creator, day) {
        case let (creator?, day?):
            text = isPrivate ? tr("\(creator) が\(day)に作成した非公開チャンネルの始まりです。") : tr("\(creator) が\(day)に作成した公開チャンネルの始まりです。")
        case let (creator?, nil):
            text = isPrivate ? tr("\(creator) が作成した非公開チャンネルの始まりです。") : tr("\(creator) が作成した公開チャンネルの始まりです。")
        case let (nil, day?):
            text = isPrivate ? tr("\(day)に作成した非公開チャンネルの始まりです。") : tr("\(day)に作成した公開チャンネルの始まりです。")
        case (nil, nil):
            text = isPrivate ? tr("作成した非公開チャンネルの始まりです。") : tr("作成した公開チャンネルの始まりです。")
        }
        if let count = out.memberCount, count > 0 { text += tr(" メンバー \(count) 人。") }
        return text
    }

    /// 2026年10月5日 / Oct 5, 2026 / 2026年10月5日, in the UI language.
    private static var dayFormatter: DateFormatter {
        let formatter = DateFormatter()
        formatter.locale = UILanguage.shared.locale
        formatter.setLocalizedDateFormatFromTemplate("yMMMd")
        return formatter
    }
    private static let fractional: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()
    private static func date(_ raw: String) -> Date? { fractional.date(from: raw) ?? ISO8601DateFormatter().date(from: raw) }
}
