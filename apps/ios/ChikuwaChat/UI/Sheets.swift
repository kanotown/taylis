import SwiftUI

struct NewDmView: View {
    @Bindable var controller: AppController
    let onOpen: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var selected = Set<String>()
    @State private var error: String?

    private var users: [UserPublic] {
        controller.store.users.values.filter { $0.id != controller.store.me?.id && $0.deactivatedAt == nil }.sorted { $0.displayName < $1.displayName }
    }

    var body: some View {
        NavigationStack {
            List(users, selection: $selected) { user in
                HStack {
                    Text(user.displayName)
                    Text("@\(user.username)").foregroundStyle(.secondary).font(.footnote)
                }
            }
            .environment(\.editMode, .constant(.active))
            .navigationTitle("ダイレクトメッセージ")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("閉じる") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("開く") {
                        Task {
                            guard let api = controller.api else { return }
                            do {
                                let channel = try await api.createDm(userIds: Array(selected))
                                controller.store.upsertChannel(channel, isMember: true)
                                onOpen(channel.id)
                                dismiss()
                            } catch { self.error = "\(error)" }
                        }
                    }
                    .disabled(selected.isEmpty || selected.count > 8)
                }
            }
            if let error { Text(error).foregroundStyle(.red).font(.footnote).padding() }
        }
    }
}

struct NewChannelView: View {
    @Bindable var controller: AppController
    let onOpen: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var isPrivate = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                TextField("名前 (例: general)", text: $name).textInputAutocapitalization(.never).autocorrectionDisabled()
                Toggle("プライベート", isOn: $isPrivate)
                if let error { Text(error).foregroundStyle(.red).font(.footnote) }
            }
            .navigationTitle("チャンネルを作成")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("閉じる") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("作成") {
                        Task {
                            guard let api = controller.api else { return }
                            do {
                                let channel = try await api.createChannel(name: name.trimmingCharacters(in: .whitespaces), type: isPrivate ? "private" : "public")
                                controller.store.upsertChannel(channel, isMember: true)
                                onOpen(channel.id)
                                dismiss()
                            } catch { self.error = "\(error)" }
                        }
                    }
                    .disabled(name.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
        }
    }
}

struct AddMemberView: View {
    @Bindable var controller: AppController
    let channelId: String
    @Environment(\.dismiss) private var dismiss
    @State private var members: Set<String>?
    @State private var selected = Set<String>()
    @State private var error: String?

    private var candidates: [UserPublic] {
        controller.store.users.values
            .filter { $0.id != controller.store.me?.id && $0.deactivatedAt == nil && !(members?.contains($0.id) ?? true) }
            .sorted { $0.displayName < $1.displayName }
    }

    var body: some View {
        NavigationStack {
            Group {
                if members == nil {
                    ProgressView()
                } else if candidates.isEmpty {
                    Text("追加できるユーザーはいません").foregroundStyle(.secondary)
                } else {
                    List(candidates, selection: $selected) { user in Text(user.displayName) }
                        .environment(\.editMode, .constant(.active))
                }
            }
            .navigationTitle("メンバーを追加")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("閉じる") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("追加") {
                        Task {
                            guard let api = controller.api else { return }
                            do {
                                for userId in selected { _ = try await api.addMember(channelId: channelId, userId: userId) }
                                dismiss()
                            } catch { self.error = "\(error)" }
                        }
                    }
                    .disabled(selected.isEmpty)
                }
            }
            .task {
                let list = (try? await controller.api?.members(channelId: channelId)) ?? []
                members = Set(list.map(\.userId))
            }
            if let error { Text(error).foregroundStyle(.red).font(.footnote).padding() }
        }
    }
}
