import SwiftUI

/// The share sheet (MOBILE_UI.md §21.2): what is shared, an optional message, the destination, 送信 / キャンセル.
struct ShareRootView: View {
    @Bindable var model: ShareModel

    var body: some View {
        NavigationStack {
            content
                .navigationTitle("Taylis に送る")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    if model.phase == .editing || model.phase == .loading {
                        ToolbarItem(placement: .cancellationAction) {
                            Button("キャンセル") { model.cancel() }
                        }
                        ToolbarItem(placement: .confirmationAction) {
                            if model.mode == .drive {
                                Button("保存") { Task { await model.saveToDrive() } }
                                    .fontWeight(.semibold)
                                    .disabled(!model.canSave)
                                    .accessibilityIdentifier("share.save")
                            } else {
                                Button("送信") { Task { await model.send() } }
                                    .fontWeight(.semibold)
                                    .disabled(!model.canSend)
                                    .accessibilityIdentifier("share.send")
                            }
                        }
                    }
                }
        }
    }

    @ViewBuilder
    private var content: some View {
        switch model.phase {
        case .loading:
            ProgressView()
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        case .notSignedIn:
            OutcomeView(symbol: "person.crop.circle.badge.exclamationmark", tint: .secondary,
                        title: Text("サインインしていません"), message: Text("Taylis を開いてサインインしてください")) {
                model.close()
            }
        case .editing:
            ShareForm(model: model)
        case .sending:
            SendingView(progress: model.progress) { model.closeWhileSending() }
        case .sent:
            OutcomeView(symbol: "checkmark.circle.fill", tint: .green, title: Text("送信しました"), message: nil, close: nil)
        case .pending(let text):
            OutcomeView(symbol: "clock.arrow.circlepath", tint: .orange, title: Text("送信を待っています"), message: Text(text)) {
                model.close()
            }
        case .failed(let text):
            OutcomeView(symbol: "exclamationmark.triangle.fill", tint: .red,
                        title: model.mode == .drive ? Text("保存できませんでした") : Text("送信できませんでした"), message: Text(text)) {
                model.close()
            }
        case .saving, .saved:
            ShareDriveSavingView(model: model)
        }
    }
}

private struct ShareForm: View {
    @Bindable var model: ShareModel

    var body: some View {
        Form {
            if model.workspaces.count > 1 {
                Section {
                    Picker("ワークスペース", selection: Binding(get: { model.workspace?.serverUrl ?? "" },
                                                        set: { url in
                                                            if let next = model.workspaces.first(where: { $0.serverUrl == url }) { model.select(next) }
                                                        })) {
                        ForEach(model.workspaces) { workspace in
                            Text(workspace.name).tag(workspace.serverUrl)
                        }
                    }
                    .accessibilityIdentifier("share.workspace")
                }
            }
            // docs/DRIVE.md §29: files can go into a drive folder instead of a conversation.
            if !model.files.isEmpty {
                Section {
                    Picker("保存先の種類", selection: $model.mode) {
                        Text("会話に送る").tag(ShareModel.Mode.conversation)
                        Text("ドライブに保存").tag(ShareModel.Mode.drive)
                    }
                    .pickerStyle(.segmented)
                    .accessibilityIdentifier("share.mode")
                }
            }
            if model.mode == .drive {
                ShareDriveSection(model: model)
            } else {
                Section {
                    NavigationLink {
                        if let destinations = model.destinations {
                            DestinationPicker(model: destinations, selection: $model.destination)
                        }
                    } label: {
                        HStack {
                            Text("送信先")
                            Spacer()
                            if let destination = model.destination {
                                DestinationLabel(destination: destination).foregroundStyle(.secondary)
                            } else {
                                Text("選んでください").foregroundStyle(.secondary)
                            }
                        }
                    }
                    .accessibilityIdentifier("share.destination")
                }
            }
            if !model.files.isEmpty || model.unreadable > 0 {
                Section {
                    ForEach(model.files) { file in
                        // The drive takes larger files than a message (the server says so per file).
                        FileRow(file: file, thumbnail: model.thumbnails[file.id],
                                tooLarge: model.mode == .conversation && file.size > model.limits.maxAttachmentBytes,
                                limit: model.limits.maxAttachmentBytes) {
                            model.remove(file)
                        }
                    }
                    if model.unreadable > 0 {
                        Label("読み込めなかった項目があります（\(model.unreadable)件）", systemImage: "exclamationmark.circle")
                            .foregroundStyle(.secondary)
                            .font(.footnote)
                    }
                } header: {
                    if model.mode == .drive { Text("保存するファイル") } else { Text("添付するファイル") }
                } footer: {
                    if model.tooMany, model.mode == .conversation {
                        Text("ファイルは\(model.limits.maxAttachmentsPerMessage)件までです。減らしてください").foregroundStyle(.red)
                    }
                    // CF5 (docs/CHANNEL_FILES.md §12.4): they go up into the conversation's drive and come as links.
                    if !model.tooLarge.isEmpty, model.mode == .conversation {
                        Text("上限を超えるファイルはドライブにアップロードし、終わったものからリンクを投稿します")
                    }
                }
            }
            if model.mode == .conversation {
                Section("メッセージ") {
                    TextField("メッセージを追加（任意）", text: $model.text, axis: .vertical)
                        .lineLimit(1...8)
                        .accessibilityIdentifier("share.text")
                }
            }
        }
    }
}

private struct FileRow: View {
    let file: StagedFile
    let thumbnail: UIImage?
    let tooLarge: Bool
    let limit: Int64
    let remove: () -> Void

    var body: some View {
        HStack(spacing: 12) {
            Group {
                if let thumbnail {
                    Image(uiImage: thumbnail).resizable().scaledToFill()
                } else {
                    Image(systemName: file.isVideo ? "film" : file.isImage ? "photo" : "doc")
                        .font(.title2)
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .background(Color(.secondarySystemFill))
                }
            }
            .frame(width: 44, height: 44)
            .clipShape(RoundedRectangle(cornerRadius: 6))
            VStack(alignment: .leading, spacing: 2) {
                Text(file.filename).lineLimit(1).truncationMode(.middle)
                if tooLarge {
                    Text("\(ShareModel.formatSize(file.size)) · ドライブにアップロードしてリンクを投稿").font(.caption).foregroundStyle(.secondary)
                } else {
                    Text(ShareModel.formatSize(file.size)).font(.caption).foregroundStyle(.secondary)
                }
            }
            Spacer(minLength: 0)
            Button(action: remove) {
                Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(Text("外す"))
        }
    }
}

private struct DestinationLabel: View {
    let destination: ShareDestination

    var body: some View {
        Label {
            // The icon says # / 🔒 already: the name without its 「#」.
            Text(destination.isDm ? destination.title : String(destination.title.drop(while: { $0 == "#" }))).lineLimit(1)
        } icon: {
            Image(systemName: symbol)
        }
    }

    private var symbol: String {
        switch destination.kind {
        case "private": "lock"
        case "dm": "person"
        case "group_dm": "person.2"
        default: "number"
        }
    }
}

/// The destination list: recent conversations (from the app), and every conversation of mine through the search.
private struct DestinationPicker: View {
    @Bindable var model: ShareDestinationModel
    @Binding var selection: ShareDestination?
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        List {
            if model.query.isEmpty, !model.recent.isEmpty {
                Section("最近の会話") { rows }
            } else {
                Section { rows }
            }
            if model.loading {
                HStack { Spacer(); ProgressView(); Spacer() }
            } else if model.failure != nil {
                Text("会話の一覧を読み込めませんでした").foregroundStyle(.secondary).font(.footnote)
            } else if model.results.isEmpty {
                Text("見つかりません").foregroundStyle(.secondary)
            }
        }
        .searchable(text: $model.query, placement: .navigationBarDrawer(displayMode: .always), prompt: Text("チャンネルや DM を検索"))
        .onChange(of: model.query) { _, query in
            if !query.isEmpty { Task { await model.loadAll() } }
        }
        .navigationTitle("送信先")
        .navigationBarTitleDisplayMode(.inline)
    }

    private var rows: some View {
        ForEach(model.results) { destination in
            Button {
                selection = destination
                dismiss()
            } label: {
                HStack {
                    DestinationLabel(destination: destination).foregroundStyle(.primary)
                    Spacer()
                    if selection?.id == destination.id { Image(systemName: "checkmark").foregroundStyle(Color.accentColor) }
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
        }
    }
}

private struct SendingView: View {
    let progress: Double
    let closeEarly: () -> Void

    var body: some View {
        VStack(spacing: 20) {
            ProgressView(value: progress)
                .progressViewStyle(.linear)
                .frame(maxWidth: 280)
            Text("送信しています…").foregroundStyle(.secondary)
            Button("閉じる（送信は続きます）", action: closeEarly)
                .buttonStyle(.bordered)
                .accessibilityIdentifier("share.closeEarly")
        }
        .padding()
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

private struct OutcomeView: View {
    let symbol: String
    let tint: Color
    let title: Text
    let message: Text?
    let close: (() -> Void)?

    var body: some View {
        VStack(spacing: 14) {
            Image(systemName: symbol).font(.system(size: 44)).foregroundStyle(tint)
            title.font(.headline)
            if let message { message.multilineTextAlignment(.center).foregroundStyle(.secondary) }
            if let close {
                Button("閉じる", action: close)
                    .buttonStyle(.borderedProminent).tint(Color.taylisSolid)
                    .padding(.top, 6)
                    .accessibilityIdentifier("share.close")
            }
        }
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
