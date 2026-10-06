import SwiftUI

/// Messages pinned in a channel (M11c), most recently pinned first; a row reveals the message. The conversation's
/// 「ピン留め」 tab (M29): fetched each time the tab is shown, and kept live in between (`PinLists`).
struct PinsView: View {
    @Bindable var controller: AppController
    let channelId: String
    let onOpen: (MessageOut) -> Void

    var body: some View {
        List {
            if let pins = controller.pinLists.pins(channelId) {
                if pins.isEmpty {
                    Text("ピン留めされたメッセージはありません。メッセージを長押しして「チャンネルにピン留め」を選ぶと、ここに集まります。")
                        .font(.footnote).foregroundStyle(.secondary)
                }
                ForEach(pins) { message in
                    Button { onOpen(message) } label: { MessageCardView(message: message, controller: controller) }.buttonStyle(.plain)
                }
            } else {
                ProgressView()
            }
        }
        .listStyle(.plain)
        .task(id: controller.engine?.status) { await load() }
        .refreshable { await load() }
    }

    private func load() async {
        guard let api = controller.api else { return }
        controller.pinLists.loading(channelId)
        do {
            let pins = try await api.listPins(channelId: channelId)
            controller.pinLists.loaded(channelId, pins)
        } catch {
            controller.pinLists.loadFailed(channelId)
            controller.error = controller.describe(error)
        }
    }
}

/// The pins tabs' rows while the app runs. Between fetches every message row the app takes (the live events, the
/// answers to my own pins, unpins and deletes) is applied to them: a pinned message deleted or unpinned, here or by
/// someone else, stayed in the tab until it was shown again (2026-10-06); one pinned elsewhere comes in.
struct PinLists: Equatable {
    private var lists: [String: [MessageOut]] = [:]
    /// The rows that came while a channel's pins were being fetched: applied over the answer, which may be older.
    private var cameDuringLoad: [String: [MessageOut]] = [:]

    func pins(_ channelId: String) -> [MessageOut]? { lists[channelId] }

    mutating func loading(_ channelId: String) { cameDuringLoad[channelId] = [] }

    mutating func loaded(_ channelId: String, _ pins: [MessageOut]) {
        var list = pins
        for message in cameDuringLoad.removeValue(forKey: channelId) ?? [] { list = Self.applying(message, to: list) ?? list }
        lists[channelId] = list
    }

    mutating func loadFailed(_ channelId: String) { cameDuringLoad[channelId] = nil }

    /// Whether anything was kept (AppController puts the copy back only then: every row of every page comes by).
    @discardableResult
    mutating func take(_ message: MessageOut) -> Bool {
        let buffered = cameDuringLoad[message.channelId] != nil
        cameDuringLoad[message.channelId]?.append(message)
        guard let list = lists[message.channelId], let next = Self.applying(message, to: list) else { return buffered }
        lists[message.channelId] = next
        return true
    }

    /// `pins` with the message's newer version taken (SYNC_PROTOCOL.md §8: the newer updated_seq wins), or nil when
    /// nothing changes. Deleted or unpinned, it leaves; pinned, it is in its place (the most recently pinned first).
    static func applying(_ message: MessageOut, to pins: [MessageOut]) -> [MessageOut]? {
        var next = pins
        if let index = pins.firstIndex(where: { $0.id == message.id }) {
            guard message.updatedSeq > pins[index].updatedSeq else { return nil }
            if !message.deleted, message.pinnedAt == pins[index].pinnedAt {
                next[index] = message
                return next
            }
            next.remove(at: index)
        }
        guard !message.deleted, let pinnedAt = message.pinnedAt else { return next.count == pins.count ? nil : next }
        next.insert(message, at: next.firstIndex { ($0.pinnedAt ?? "") < pinnedAt } ?? next.count)
        return next
    }
}

/// A compact message card shared by the pins tab and the saved list.
struct MessageCardView: View {
    let message: MessageOut
    @Bindable var controller: AppController

    var body: some View {
        let store = controller.store
        let sender = store.users[message.senderId]?.displayName ?? "?"
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                AvatarView(id: message.senderId, name: sender, size: 20)
                Text(sender).bold()
                Text(store.channel(message.channelId).map { channelTitle($0, store: store) } ?? "?").foregroundStyle(.secondary).lineLimit(1)
                Spacer()
                Text(Timeline.timeLabel(message.createdAt)).foregroundStyle(.secondary)
            }
            .font(.caption)
            CustomEmoji.excerpt(message.body.isEmpty ? message.attachments.map(\.filename).joined(separator: ", ") : Mentions.decode(message.body, users: store.users, groups: store.groups),
                                controller: controller, height: CustomEmoji.inlineHeight)
                .lineLimit(4)
        }
        .padding(.vertical, 2)
        // The whole card is the tap target: a plain-style button hits only what is drawn, so the blank end of a short
        // pinned or saved message did nothing.
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
    }
}
