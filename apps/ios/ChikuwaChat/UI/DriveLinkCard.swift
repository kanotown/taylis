import SwiftUI

/// M166 (docs/DRIVE.md §13.1, §25, §26): the cards under a message for its `<this server>/d/<id>` links (at most three,
/// each once). Readable: a small picture (a photo, a video's poster, a document's first page) or the kind's icon, the
/// item's current name and 「研究室ドライブ › 論文 · 4.6 MB」; a tap opens the viewer, or the folder / the file's details
/// in a sheet. Not readable (404: no access, in the trash or gone): 「表示できないファイル」 only — no name, no size,
/// no place.
struct DriveLinkCards: View {
    @Bindable var controller: AppController
    let ids: [String]
    /// The body's further drive links (past the three cards): asked too, so the text names them (or says
    /// 「表示できないファイル」) rather than 「ドライブのファイル」.
    var inlineOnly: [String] = []

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(ids, id: \.self) { DriveLinkCard(controller: controller, itemId: $0) }
        }
        .task(id: inlineOnly) {
            for id in inlineOnly { await controller.drive?.resolveLink(id) }
        }
    }
}

struct DriveLinkCard: View {
    static let width: CGFloat = 280

    @Bindable var controller: AppController
    let itemId: String
    @State private var opening = false

    private var state: DriveHub.LinkState? { controller.drive?.linkState(itemId) }

    var body: some View {
        Button(action: tapped) { face }
            .buttonStyle(.plain)
            .disabled(opening)
            .task(id: itemId) { await controller.drive?.resolveLink(itemId) }
    }

    @ViewBuilder
    private var face: some View {
        HStack(spacing: 10) {
            switch state {
            case .item(let detail)? where detail.item.isFolder && detail.item.album != nil:
                // AL3 (docs/ALBUMS.md §10.4): an album's card.
                AlbumCardFace(controller: controller, detail: detail, album: detail.item.album!)
            case .item(let detail)?:
                DriveThumbnail(controller: controller, item: detail.item, side: 44)
                VStack(alignment: .leading, spacing: 2) {
                    Text(detail.item.name).font(.subheadline.weight(.medium)).foregroundStyle(Color.primary).fileNameLine(detail.item.name)
                    Text(DriveRules.cardDetail(detail)).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                }
            case .unreadable?:
                icon("lock")
                VStack(alignment: .leading, spacing: 2) {
                    Text("表示できないファイル").font(.subheadline.weight(.medium)).foregroundStyle(Color.primary)
                    Text("このファイルを見る権限が無いか、ゴミ箱に移されたか削除されました。").font(.caption).foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            case .failed?:
                icon("exclamationmark.triangle")
                VStack(alignment: .leading, spacing: 2) {
                    Text("ファイルを読み込めませんでした").font(.subheadline.weight(.medium)).foregroundStyle(Color.primary)
                    Text("タップでもう一度試します。").font(.caption).foregroundStyle(.secondary)
                }
            case nil:
                icon("externaldrive")
                Text("ファイルを読み込み中…").font(.subheadline).foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
            if opening { ProgressView() }
        }
        .padding(8)
        .frame(maxWidth: Self.width, alignment: .leading)
        .background(Color.secondary.opacity(0.10), in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(Color.secondary.opacity(0.18), lineWidth: 0.5))
        .contentShape(RoundedRectangle(cornerRadius: 10))
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isButton)
    }

    private func icon(_ name: String) -> some View {
        Image(systemName: name).font(.system(size: 18)).foregroundStyle(.secondary)
            .frame(width: 44, height: 44)
            .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 6))
    }

    private func tapped() {
        switch state {
        case .failed?:
            Task { await controller.drive?.resolveLink(itemId, force: true) }
        case .unreadable?:
            controller.notice = tr("このファイルは表示できません（見る権限が無いか、削除されました）")
        default:
            opening = true
            Task {
                defer { opening = false }
                await controller.openDriveLink(itemId)
            }
        }
    }
}

extension AppController {
    var drive: DriveHub? { engine?.drive }

    /// A drive link tapped (its card, the link in the text): a file with a viewer opens in it at once; a folder, or a
    /// file without one, in the link's sheet; one I cannot read only says so (its name never shows).
    func openDriveLink(_ itemId: String) async {
        guard let hub = drive else { return }
        switch await hub.resolveLink(itemId) {
        case .unreadable:
            notice = tr("このファイルは表示できません（見る権限が無いか、削除されました）")
        case .failed:
            driveLink = DriveLinkTarget(id: itemId)
        case .item(let detail):
            if !detail.item.isFolder, DriveRules.viewer(detail.item) != nil, let viewing = await DriveViewing.of(detail.item, controller: self) {
                driveViewer = viewing
            } else {
                driveLink = DriveLinkTarget(id: itemId)
            }
        }
    }

    /// The drive item's link (`<server>/d/<id>`) on the clipboard.
    func copyDriveLink(_ itemId: String) {
        guard let api else { return }
        copyToClipboard(DriveLink.url(base: api.baseUrl, itemId: itemId), notice: tr("リンクをコピーしました"))
    }
}
