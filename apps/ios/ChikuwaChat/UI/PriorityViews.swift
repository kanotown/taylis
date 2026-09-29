import SwiftUI

/// M15e: 「重要」 / 「緊急」 above a message and in the composer.
struct PriorityLabelView: View {
    let priority: String

    var body: some View {
        let urgent = priority == "urgent"
        Label(urgent ? "緊急" : "重要", systemImage: urgent ? "exclamationmark.triangle.fill" : "info.circle.fill")
            .font(.caption2.bold())
            .foregroundStyle(urgent ? Color.red : Color.accentColor)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background((urgent ? Color.red : Color.accentColor).opacity(0.12), in: RoundedRectangle(cornerRadius: 4))
    }
}

/// M15e: 「確認しました」 for readers, and who has acknowledged so far.
struct AckBarView: View {
    let message: MessageState
    @Bindable var controller: AppController
    /// A channel read before joining (M27): who confirmed, without the button.
    var readOnly = false
    /// L4: opens who has and who has not acknowledged (the conversation presents it; nil in a preview).
    var present: ((MessageSheet) -> Void)? = nil

    var body: some View {
        let store = controller.store
        let mine = store.me.map { me in message.acks.contains { $0.userId == me.id } } ?? false
        let own = store.me?.id == message.senderId
        let names = message.acks.map { store.users[$0.userId]?.displayName ?? "?" }
        HStack(spacing: 8) {
            if !own && !readOnly {
                Button { Task { await controller.toggleAck(message) } } label: {
                    Label(mine ? "確認済み" : "確認しました", systemImage: "checkmark.circle")
                }
                .buttonStyle(.bordered)
                .tint(mine ? Color.accentColor : Color.secondary)
                .controlSize(.mini)
            }
            if let present, !readOnly {
                // L4: who has and who has not, and (for the author) a reminder to the rest.
                Button { present(MessageSheet(kind: .acks, message: message)) } label: {
                    Text(names.isEmpty ? "まだ誰も確認していません" : PeopleList.compact(names) + " が確認")
                        .font(.caption).foregroundStyle(.secondary).lineLimit(1)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(names.isEmpty ? "確認の状況: まだ誰も確認していません" : "確認の状況: \(names.count) 人が確認")
            } else if names.isEmpty {
                Text("まだ誰も確認していません").font(.caption).foregroundStyle(.secondary)
            } else {
                // M27: who, not only how many (a tap lists everyone).
                Menu {
                    ForEach(Array(names.enumerated()), id: \.offset) { _, name in Text(name) }
                } label: {
                    Text(PeopleList.compact(names) + " が確認").font(.caption).foregroundStyle(.secondary).lineLimit(1)
                }
                .accessibilityLabel("\(names.count) 人が確認: " + names.joined(separator: "、"))
            }
        }
        .padding(.top, 2)
    }
}

/// L4 (M31): who has acknowledged a message and who has not; its author (or an admin) reminds the rest, each with a
/// reminder only they see (at most once an hour).
struct AckStatusView: View {
    let message: MessageState
    @Bindable var controller: AppController
    @Environment(\.dismiss) private var dismiss
    @State private var pending: [String]?
    @State private var reminding = false
    /// What the last reminder did (shown here: the app's notices are behind the sheet).
    @State private var result: (ok: Bool, text: String)?

    private var store: Store { controller.store }
    private var canRemind: Bool { store.me.map { $0.id == message.senderId || $0.role == "admin" } ?? false }

    private func name(_ id: String) -> String { store.users[id]?.displayName ?? "…" }

    var body: some View {
        NavigationStack {
            List {
                Section("確認済み \(message.acks.count) 人") {
                    if message.acks.isEmpty { Text("まだ誰も確認していません").foregroundStyle(.secondary) }
                    ForEach(message.acks, id: \.userId) { ack in
                        HStack(spacing: 10) {
                            AvatarView(id: ack.userId, name: name(ack.userId), size: 24)
                            Text(name(ack.userId))
                        }
                    }
                }
                Section(pending.map { "未確認 \($0.count) 人" } ?? "未確認") {
                    if let pending {
                        if pending.isEmpty { Text("全員が確認しました").foregroundStyle(.secondary) }
                        ForEach(pending, id: \.self) { id in
                            HStack(spacing: 10) {
                                AvatarView(id: id, name: name(id), size: 24)
                                Text(name(id))
                            }
                        }
                        if canRemind && !pending.isEmpty {
                            Button {
                                reminding = true
                                Task {
                                    let outcome = await controller.remindUnacknowledged(message)
                                    result = outcome
                                    if outcome.ok { await load() }
                                    reminding = false
                                }
                            } label: {
                                Label("未確認の人にリマインド", systemImage: "bell.badge")
                            }
                            .disabled(reminding)
                            if let result {
                                Text(result.text).font(.footnote).foregroundStyle(result.ok ? Color.secondary : Color.red)
                            }
                        }
                    } else {
                        ProgressView()
                    }
                }
            }
            .navigationTitle("確認の状況")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("閉じる") { dismiss() } } }
            // Again when someone acknowledges while it is open (the message's acks change).
            .task(id: message.acks.count) { await load() }
        }
        .presentationDetents([.medium, .large])
    }

    private func load() async {
        if let ids = await controller.ackPending(message) { pending = ids }
    }
}

