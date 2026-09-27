import SwiftUI

/// M15f: rules shared by the link bar and its editor.
enum ChannelLinks {
    /// Only http(s) links (the server refuses the rest).
    static func validUrl(_ text: String) -> Bool {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.contains(where: \.isWhitespace), let url = URL(string: trimmed), let scheme = url.scheme?.lowercased() else { return false }
        return (scheme == "http" || scheme == "https") && !(url.host ?? "").isEmpty
    }
}

extension ChannelState {
    /// M15f: whether I may change this conversation's links (the server says the same).
    func canEditLinks(isAdmin: Bool, isGuest: Bool) -> Bool {
        isMember && !channel.archived && !isGuest && canPostTopLevel(isAdmin: isAdmin)
    }
}

/// M15f: the conversation's pinned links at the top (Slack's bookmarks bar); hidden while empty.
struct ChannelLinksRow: View {
    @Bindable var controller: AppController
    let channel: ChannelState
    let onAdd: () -> Void
    let onEdit: (ChannelLinkOut) -> Void
    @Environment(\.openURL) private var openURL

    private var editable: Bool {
        channel.canEditLinks(isAdmin: controller.store.me?.role == "admin", isGuest: controller.store.me?.role == "guest")
    }

    var body: some View {
        let links = controller.store.linksOf(channel.id)
        if !links.isEmpty {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    ForEach(Array(links.enumerated()), id: \.element.id) { index, link in
                        Button { if let url = URL(string: link.url) { openURL(url) } } label: {
                            Label(link.title, systemImage: "link").font(.caption).lineLimit(1)
                        }
                        .buttonStyle(.bordered)
                        .controlSize(.small)
                        .contextMenu {
                            if editable {
                                Button("編集", systemImage: "pencil") { onEdit(link) }
                                Button("左へ移動", systemImage: "arrow.left") {
                                    Task { _ = await controller.updateChannelLink(channel.id, linkId: link.id, position: index - 1) }
                                }.disabled(index == 0)
                                Button("右へ移動", systemImage: "arrow.right") {
                                    Task { _ = await controller.updateChannelLink(channel.id, linkId: link.id, position: index + 1) }
                                }.disabled(index == links.count - 1)
                                Button("削除", systemImage: "trash", role: .destructive) {
                                    Task { _ = await controller.deleteChannelLink(channel.id, linkId: link.id) }
                                }
                            }
                        }
                    }
                    if editable {
                        Button(action: onAdd) { Label("リンク", systemImage: "plus").font(.caption) }
                            .buttonStyle(.borderless)
                    }
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
            }
            Divider()
        }
    }
}

/// Add a link, or edit one (URL and title).
struct ChannelLinkEditor: View {
    @Bindable var controller: AppController
    let channelId: String
    let link: ChannelLinkOut?
    @Environment(\.dismiss) private var dismiss
    @State private var url = ""
    @State private var title = ""
    @State private var busy = false

    private var urlOk: Bool { ChannelLinks.validUrl(url) }
    private var trimmedTitle: String { title.trimmingCharacters(in: .whitespacesAndNewlines) }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("https://", text: $url)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    TextField("名前 (例: デザイン資料)", text: $title)
                } footer: {
                    if !url.isEmpty && !urlOk { Text("http:// か https:// で始まる URL を入れてください").foregroundStyle(.red) }
                }
            }
            .navigationTitle(link == nil ? "リンクを追加" : "リンクを編集")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("キャンセル") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(link == nil ? "追加" : "保存") {
                        busy = true
                        Task {
                            let value = url.trimmingCharacters(in: .whitespacesAndNewlines)
                            let ok = if let link {
                                await controller.updateChannelLink(channelId, linkId: link.id, title: trimmedTitle, url: value)
                            } else {
                                await controller.addChannelLink(channelId, title: trimmedTitle, url: value)
                            }
                            busy = false
                            if ok { dismiss() }
                        }
                    }
                    .disabled(busy || !urlOk || trimmedTitle.isEmpty)
                }
            }
            .onAppear {
                url = link?.url ?? ""
                title = link?.title ?? ""
            }
        }
        .presentationDetents([.medium])
    }
}
