import SwiftUI

/// M45: a canvas rendered (CANVAS.md §4.2): the message renderer's blocks plus tasks with boxes that tick (§4.4
/// 「チェックの切り替え」), the canvas's images (the authenticated loader) and rules. Headings carry ids for the outline and,
/// for those who may edit, 「このセクションを編集」 (§5).
struct CanvasBodyView: View {
    let body_: String
    @Bindable var controller: AppController
    /// nil: the boxes only show (read only).
    var onToggleTask: ((Int, Bool) -> Void)?
    /// nil: no section editing.
    var onEditSection: ((Int) -> Void)?
    /// M73 (CANVAS.md §18.3): 「タスクにする」 on an open checklist item's long press (its line); nil: not offered.
    var onMakeTask: ((Int) -> Void)?

    init(body: String, controller: AppController, onToggleTask: ((Int, Bool) -> Void)?, onEditSection: ((Int) -> Void)? = nil,
         onMakeTask: ((Int) -> Void)? = nil) {
        self.body_ = body
        self.controller = controller
        self.onToggleTask = onToggleTask
        self.onEditSection = onEditSection
        self.onMakeTask = onMakeTask
    }

    static func anchor(_ line: Int) -> String { "canvas-h-\(line)" }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(BodyTokenizer.parseLinedBlocks(body_, canvas: true).enumerated()), id: \.offset) { _, entry in
                block(entry.block, line: entry.line)
            }
        }
        .environment(\.openURL, OpenURLAction { url in
            if url.scheme == CanvasLink.scheme, let id = url.host {
                controller.canvasLink = CanvasLinkTarget(id: id)
                return .handled
            }
            if url.scheme == Permalink.scheme, let id = url.host {
                Task { await controller.openPermalink(id) }
                return .handled
            }
            return .systemAction
        })
    }

    @ViewBuilder
    private func block(_ block: BodyBlock, line: Int) -> some View {
        switch block {
        case .task(let items):
            VStack(alignment: .leading, spacing: 2) {
                ForEach(items, id: \.line) { item in taskRow(item) }
            }
        case .image(let alt, let attachmentId, _):
            CanvasImageView(attachmentId: attachmentId, alt: alt, controller: controller)
        case .rule:
            Divider().padding(.vertical, 6)
        case .heading:
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                message([block])
                if let onEditSection {
                    Button { onEditSection(line) } label: {
                        Image(systemName: "square.and.pencil").font(.subheadline).foregroundStyle(.secondary)
                            .frame(width: 32, height: 32).contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("このセクションを編集")
                }
            }
            .padding(.top, 6)
            .id(Self.anchor(line))
        default:
            message([block])
        }
    }

    private func taskRow(_ item: BodyTaskItem) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Button { onToggleTask?(item.line, !item.done) } label: {
                Image(systemName: item.done ? "checkmark.square.fill" : "square")
                    .font(.title3)
                    .foregroundStyle(item.done ? Color.accentColor : Color.secondary)
                    .frame(minWidth: 32, minHeight: 32)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(onToggleTask == nil)
            .accessibilityLabel(item.done ? "完了を取り消す" : "完了にする")
            .accessibilityValue(item.done ? "完了" : "未完了")
            message([.paragraph([item.tokens])])
                .strikethrough(item.done)
                .foregroundStyle(item.done ? .secondary : .primary)
        }
        .padding(.leading, CGFloat(item.level) * 24)
        .modifier(MakeTaskMenu(action: item.done ? nil : onMakeTask.map { make in { make(item.line) } }))
    }

    private func message(_ blocks: [BodyBlock]) -> some View {
        let store = controller.store
        return MessageBodyView(text: "", users: store.users, groups: store.groups, internalBase: controller.api?.baseUrl,
                               customEmoji: store.customEmoji, emojiImages: store.emojiImages,
                               onNeedEmojiImage: { controller.loadEmojiImage($0) }, preparsed: blocks)
    }
}

/// M73: the long press of an open checklist item offers 「タスクにする」; nothing is attached without one (a done item,
/// a read-only body), so the row scrolls and ticks as before.
private struct MakeTaskMenu: ViewModifier {
    let action: (() -> Void)?

    func body(content: Content) -> some View {
        if let action {
            content
                .contentShape(.contextMenuPreview, Rectangle())
                .contextMenu { Button("タスクにする", systemImage: "checklist", action: action) }
        } else {
            content
        }
    }
}

/// An image of the canvas (`![alt](attachment:<uuid>)`): its thumbnail, else the file itself (images only, §4.10), with
/// authentication; 「表示できない画像」 when neither loads (another canvas's file, or one I may not see).
struct CanvasImageView: View {
    let attachmentId: String
    let alt: String
    @Bindable var controller: AppController
    @State private var loader = AttachmentImageLoader()
    @State private var attempt = 0

    var body: some View {
        Group {
            if let image = loader.image {
                Image(uiImage: image).resizable().scaledToFit()
                    .frame(maxWidth: .infinity, maxHeight: 320, alignment: .leading)
                    .clipShape(RoundedRectangle(cornerRadius: 10))
                    .accessibilityLabel(alt.isEmpty ? tr("画像") : alt)
            } else if loader.failed {
                Button { attempt += 1 } label: {
                    Label(alt.isEmpty ? "表示できない画像" : "表示できない画像：\(alt)", systemImage: "photo")
                        .font(.footnote).foregroundStyle(.secondary)
                        .padding(.horizontal, 12).padding(.vertical, 8)
                        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(style: StrokeStyle(lineWidth: 1, dash: [4])).foregroundStyle(.secondary))
                }
                .buttonStyle(.plain)
            } else {
                ZStack {
                    Color.secondary.opacity(0.12)
                    ProgressView()
                }
                .frame(width: 200, height: 140)
                .clipShape(RoundedRectangle(cornerRadius: 10))
            }
        }
        .task(id: "\(attachmentId):\(attempt)") {
            await loader.load {
                guard let api = controller.api else { throw URLError(.notConnectedToInternet) }
                do {
                    return try await api.fetchData("/api/v1/attachments/\(attachmentId)/thumbnail")
                } catch ApiError.api(_, let code, _) where code == "thumbnail_not_found" {
                    // A small image the server made no thumbnail of: the file itself (an image is checked by UIImage).
                    return try await api.fetchData("/api/v1/attachments/\(attachmentId)/content?inline=1")
                }
            }
        }
    }
}
