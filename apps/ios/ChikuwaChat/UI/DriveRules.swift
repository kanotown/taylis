import Foundation

/// M166 (docs/DRIVE.md §13.1, §25): drive links, `<server>/d/<item_id>`, recognised only for the server we are logged
/// into (another server's `/d/` stays a plain link).
enum DriveLink {
    static let scheme = "chikuwa-drive"
    /// A message shows at most this many cards (the desktop reads the first three links for its warning too).
    static let cardLimit = 3
    private static let uuid = try! NSRegularExpression(pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", options: [.caseInsensitive])

    /// The item id when `url` is a drive link on `base` (case-insensitive prefix, query / fragment ignored).
    static func itemId(base: URL?, url: String) -> String? {
        guard let base else { return nil }
        var prefix = base.absoluteString
        while prefix.hasSuffix("/") { prefix.removeLast() }
        prefix += "/d/"
        guard url.count >= prefix.count, url.prefix(prefix.count).lowercased() == prefix.lowercased() else { return nil }
        var id = String(url.dropFirst(prefix.count))
        for stop in ["/", "?", "#"] { if let range = id.range(of: stop) { id = String(id[..<range.lowerBound]) } }
        let range = NSRange(location: 0, length: (id as NSString).length)
        return uuid.firstMatch(in: id, range: range) != nil ? id.lowercased() : nil
    }

    static func url(base: URL, itemId: String) -> String {
        var text = base.absoluteString
        while text.hasSuffix("/") { text.removeLast() }
        return text + "/d/" + itemId
    }

    /// The drive items a body links to, in order, each once, at most `limit` (the cards under the message: three). Code
    /// spans and blocks are not links (BodyTokenizer).
    static func ids(in body: String, base: URL?, limit: Int = cardLimit) -> [String] {
        guard base != nil, body.contains("/d/") else { return [] }
        var out: [String] = []
        for link in Links.all(in: body) {
            guard let id = itemId(base: base, url: link), !out.contains(id) else { continue }
            out.append(id)
            if out.count == limit { break }
        }
        return out
    }

    /// The in-app link put into a body's attributed text; the row's `openURL` handler opens the item.
    static func internalLink(itemId: String) -> URL? { URL(string: "\(scheme)://\(itemId)") }

    /// What the link reads as inside the text: the item's current name with its kind's mark, 「表示できないファイル」, or
    /// 「ドライブのファイル」 while not known. Never the label the sender wrote: someone who cannot read the item must
    /// not learn its name from the message (§13.1).
    static func inlineText(_ state: DriveHub.LinkState?) -> String {
        switch state {
        case .item(let detail)?: return (detail.item.isFolder ? "📁 " : "📎 ") + detail.item.name
        case .unreadable?: return "📎 " + tr("表示できないファイル")
        case .failed?, nil: return "📎 " + tr("ドライブのファイル")
        }
    }
}

/// What a drive file opens in: the app's photo viewer, its video player (streamed with Range), the PDF viewer of the
/// server's preview (PDF and Office, PREVIEWS.md §5), or none (its details: download, share).
enum DriveViewerKind: Equatable {
    case image, video, document
}

/// Sizes in the drive, up to gigabytes (the drives hold files of several GB; formatSize stops at MB).
func driveSize(_ bytes: Int64) -> String {
    if bytes >= 1_073_741_824 { return String(format: "%.1f GB", Double(bytes) / 1_073_741_824) }
    return formatSize(bytes)
}

/// M166: the pure parts of the phone's drive screens (DriveViews.swift), the same rules as the desktop's.
enum DriveRules {
    /// The root's name in my language: 研究室ドライブ and マイドライブ by kind, a channel's drive by the channel's name.
    static func rootName(kind: String?, serverName: String) -> String {
        switch kind {
        case "workspace": tr("研究室ドライブ")
        case "user": tr("マイドライブ")
        default: serverName
        }
    }

    /// The path from the root (renamed by kind) down to the folder; CF3: a channel drive's 「投稿のファイル」 in my language.
    static func crumbs(_ path: [DriveCrumb], kind: String?) -> [DriveCrumb] {
        guard let root = path.first else { return path }
        let rest = path.dropFirst().enumerated().map { offset, crumb in
            DriveCrumb(id: crumb.id, name: ChannelFiles.crumbName(crumb, depth: offset + 1, kind: kind), systemRole: crumb.systemRole)
        }
        return [DriveCrumb(id: root.id, name: rootName(kind: kind, serverName: root.name))] + rest
    }

    /// 「研究室ドライブ › 論文」: where an item is (its card, a search hit).
    static func whereLabel(_ path: [DriveCrumb], kind: String?) -> String {
        crumbs(path, kind: kind).map(\.name).joined(separator: " › ")
    }

    /// The card's second line: 「研究室ドライブ › 論文 · 4.6 MB」, a folder 「… · フォルダ」.
    static func cardDetail(_ detail: DriveItemDetailOut) -> String {
        let place = whereLabel(detail.path, kind: detail.locationKind)
        let what = detail.item.isFolder ? tr("フォルダ") : driveSize(detail.item.sizeBytes ?? 0)
        return place.isEmpty ? what : place + " · " + what
    }

    /// A row's second line: when it changed, and a file's size.
    static func rowDetail(_ item: DriveItemOut, now: Date = Date(), calendar: Calendar = .current) -> String {
        let date = dateLabel(item.shownDate, now: now, calendar: calendar)
        guard !item.isFolder else { return date }
        return [date, driveSize(item.sizeBytes ?? 0)].filter { !$0.isEmpty }.joined(separator: " · ")
    }

    /// Today: the time; this year: 「10月22日」; before: 「2025年3月1日」.
    static func dateLabel(_ iso: String, now: Date = Date(), calendar: Calendar = .current) -> String {
        guard let date = parseIsoDate(iso) else { return "" }
        if calendar.isDate(date, inSameDayAs: now) {
            let parts = calendar.dateComponents([.hour, .minute], from: date)
            return String(format: "%d:%02d", parts.hour ?? 0, parts.minute ?? 0)
        }
        let parts = calendar.dateComponents([.year, .month, .day], from: date)
        if parts.year == calendar.component(.year, from: now) { return tr("\(parts.month ?? 0)月\(parts.day ?? 0)日") }
        return tr("\(String(parts.year ?? 0))年\(parts.month ?? 0)月\(parts.day ?? 0)日")
    }

    /// The viewer a file opens in; nil for a folder and for a file without one (its details instead). As the desktop's
    /// `viewerKind` (§27, §29): every PDF (its own bytes while its preview is not made) and every Office file (the viewer
    /// asks for, or waits for, its preview) open in the document viewer.
    static func viewer(_ item: DriveItemOut) -> DriveViewerKind? {
        guard !item.isFolder, let file = item.file else { return nil }
        let type = (item.contentType ?? "").lowercased()
        if type.hasPrefix("video/") { return .video }
        if type.hasPrefix("image/"), file.hasThumbnail { return .image }
        if file.preview?.isReady == true || file.preview?.isPending == true || isPdf(item) || isOffice(item) { return .document }
        return nil
    }

    private static let officeExtensions: Set<String> = ["doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods", "odp", "rtf"]
    private static let officeType = try! NSRegularExpression(
        pattern: "^application/(msword|rtf|vnd\\.ms-(excel|powerpoint)|vnd\\.openxmlformats-officedocument\\.|vnd\\.oasis\\.opendocument\\.(text|spreadsheet|presentation)$)")
    /// What the server's sniffer answers for a file it could not place (the server then goes by the extension).
    private static let unplaced: Set<String> = ["", "application/octet-stream", "application/zip", "application/x-ole-storage"]

    private static func ext(_ name: String) -> String { (name as NSString).pathExtension.lowercased() }

    /// A PDF: by its type, or by its name when the server could not tell (bytes before the header, §27).
    static func isPdf(_ item: DriveItemOut) -> Bool {
        guard !item.isFolder else { return false }
        let type = (item.contentType ?? "").lowercased()
        return type == "application/pdf" || (ext(item.name) == "pdf" && (type.isEmpty || type == "application/octet-stream"))
    }

    /// An Office file the converter may turn into a PDF (the server's preview_kinds.source_kind).
    static func isOffice(_ item: DriveItemOut) -> Bool {
        guard !item.isFolder else { return false }
        let type = (item.contentType ?? "").lowercased()
        let range = NSRange(type.startIndex..., in: type)
        return officeType.firstMatch(in: type, range: range) != nil || (unplaced.contains(type) && officeExtensions.contains(ext(item.name)))
    }

    /// Where the document viewer reads a file's pages (the desktop's `documentSource`).
    enum DocumentSource: Equatable {
        /// The made preview (/attachments/{id}/preview/pdf; for a PDF that is the file itself).
        case preview
        /// A PDF whose preview is not ready (not made, being made, failed, too large): its own bytes.
        case original
        /// An Office file's preview is being made (「プレビューを作成中…」 until it is ready).
        case making
        /// An Office file without one (imported, §24): the viewer asks the server to make it.
        case ask
        /// The Office file's preview could not be made (the download is offered).
        case failed
    }

    static func documentSource(_ item: DriveItemOut) -> DocumentSource {
        let preview = item.file?.preview
        if preview?.isReady == true { return .preview }
        if isPdf(item) { return .original }
        if preview?.isPending == true { return .making }
        if preview?.status == "failed" { return .failed }
        return .ask
    }

    /// The thumbnail a row or card shows: a photo's, a video's poster, a document's first page.
    static func thumbnailPath(_ item: DriveItemOut) -> String? {
        guard let file = item.file else { return nil }
        if file.hasThumbnail || file.hasPoster { return "/api/v1/attachments/\(file.attachmentId)/thumbnail" }
        if file.preview?.isReady == true { return "/api/v1/attachments/\(file.attachmentId)/preview/thumbnail" }
        return nil
    }

    /// The SF Symbol of an item without a thumbnail (and under one while it loads).
    static func icon(_ item: DriveItemOut) -> String {
        if item.isFolder { return "folder" }
        let type = item.contentType ?? "", name = item.name.lowercased()
        if type.hasPrefix("image/") { return "photo" }
        if type.hasPrefix("video/") { return "film" }
        if type.hasPrefix("audio/") { return "waveform" }
        if isPdf(item) { return "doc.richtext" }
        if type == "application/zip" || name.hasSuffix(".zip") { return "doc.zipper" }
        if ["xls", "xlsx", "ods", "csv"].contains((name as NSString).pathExtension) { return "tablecells" }
        if ["ppt", "pptx", "odp", "key"].contains((name as NSString).pathExtension) { return "rectangle.on.rectangle" }
        if type.hasPrefix("text/") || ["doc", "docx", "odt", "rtf", "txt", "md"].contains((name as NSString).pathExtension) { return "doc.text" }
        return "doc"
    }

    /// The file as the existing viewers take it (AttachmentOut): its current version's attachment, under the item's name.
    static func attachment(_ item: DriveItemOut) -> AttachmentOut? {
        guard let file = item.file else { return nil }
        return AttachmentOut(id: file.attachmentId, filename: item.name, contentType: item.contentType ?? "application/octet-stream",
                             sizeBytes: item.sizeBytes ?? 0, width: file.width, height: file.height, hasThumbnail: file.hasThumbnail,
                             status: "attached", createdAt: item.updatedAt, hasPoster: file.hasPoster, durationMs: file.durationMs,
                             preview: file.preview)
    }

    /// A name safe as a file's on this device (the server's name may hold `/`, from Nextcloud's import).
    static func fileName(_ name: String) -> String {
        let cleaned = name.replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: ":", with: "_")
        let trimmed = cleaned.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty || trimmed == "." || trimmed == ".." ? "file" : trimmed
    }

    /// The drives in the list's order: 研究室ドライブ, マイドライブ, then the channels' by name.
    static func ordered(_ locations: [DriveLocationOut]) -> [DriveLocationOut] {
        let rank = { (kind: String) in kind == "workspace" ? 0 : kind == "user" ? 1 : 2 }
        return locations.sorted { a, b in
            rank(a.kind) != rank(b.kind) ? rank(a.kind) < rank(b.kind) : SidebarOrder.namesInOrder(a.name, b.name)
        }
    }

    /// 「1.2 GB 使用」 / 「1.2 GB（上限 5.0 GB）」.
    static func usage(_ location: DriveLocationOut) -> String {
        if let quota = location.quotaBytes { return tr("\(driveSize(location.usedBytes))（上限 \(driveSize(quota))）") }
        return tr("\(driveSize(location.usedBytes)) 使用")
    }
}

/// CF3 (docs/CHANNEL_FILES.md §9, §12.7): the channel's own switch in its details (owners).
enum FilesToDriveChoice: Hashable {
    case workspace, on, off

    init(_ value: Bool?) { self = value.map { $0 ? .on : .off } ?? .workspace }

    /// PATCH's `files_to_drive`.
    var value: Bool? {
        switch self {
        case .workspace: nil
        case .on: true
        case .off: false
        }
    }
}

/// CF3 (docs/CHANNEL_FILES.md §12, §19.3): the pure parts of channel files on the phone — how a posted file shows in its
/// message, the composer's line, the delete confirmation's switch, the special folder's name.
enum ChannelFiles {
    /// How an attachment shows in its message.
    enum Look: Equatable {
        /// The usual tile (a plain attachment, or a posted file still in its channel's drive).
        case plain
        /// In another drive: the usual tile only when I can read it there (GET /drive/items/{id}), else 「表示できないファイル」.
        case moved(itemId: String)
        /// 「削除されたファイル」 (no name, no picture); `restoreId` while it is in the trash (「戻す」 for who may write the
        /// channel's drive).
        case deleted(restoreId: String?)
    }

    static func look(_ attachment: AttachmentOut) -> Look {
        guard let drive = attachment.drive else { return .plain }
        switch drive.state {
        case "available": return .plain
        case "moved": return drive.itemId.map { .moved(itemId: $0) } ?? .deleted(restoreId: nil)
        case "trashed": return .deleted(restoreId: drive.itemId)
        case "deleted": return .deleted(restoreId: nil)
        default: return .plain  // a state a later server adds: the attachment as a client before CF3 shows it
        }
    }

    /// The drive item 「ドライブで表示」 opens: a posted file still in its channel's drive, or moved (the sheet then says
    /// whether I can read it there).
    static func driveItemId(_ attachment: AttachmentOut) -> String? {
        guard let drive = attachment.drive, drive.state == "available" || drive.state == "moved" else { return nil }
        return drive.itemId
    }

    /// The message's files 「ドライブで表示」 offers, in order.
    static func driveItems(_ attachments: [AttachmentOut]) -> [(itemId: String, name: String)] {
        attachments.compactMap { attachment in driveItemId(attachment).map { ($0, attachment.filename) } }
    }

    /// Whether files posted in this conversation go to its drive (§9): public and private channels, the channel's own
    /// switch or else the workspace's. A server before CF1 (no workspace setting) has none.
    static func savesToDrive(_ channel: ChannelOut, settings: WorkspaceSettings) -> Bool {
        guard channel.type == "public" || channel.type == "private", let workspace = settings.channelFilesToDrive else { return false }
        return channel.filesToDrive ?? workspace
    }

    /// The composer's line under the waiting files (§12.3).
    static func composerHint(channelName: String) -> String { tr("#\(channelName) のドライブの「投稿のファイル」に保存されます") }

    /// The special folder's name in my language (§3.3); other items keep their own.
    static func name(_ item: DriveItemOut) -> String { item.isChannelPosts ? tr("投稿のファイル") : item.name }

    /// The name the server stores the folder under (§3.3).
    static let storedName = "投稿のファイル"  // i18n-ignore: the server's stored name, compared, never shown as is

    /// A step of a path: 「投稿のファイル」 in my language when it is that folder — by its `system_role` (§19.4), or from a
    /// server whose steps carry none, by place and name: the folder is always the root's child in a channel's drive under
    /// the stored name (it cannot be renamed or moved, and no other folder there can take its name).
    static func crumbName(_ crumb: DriveCrumb, depth: Int, kind: String?) -> String {
        if let role = crumb.systemRole { return role == "channel_posts" ? tr("投稿のファイル") : crumb.name }
        return kind == "channel" && depth == 1 && crumb.name == storedName ? tr("投稿のファイル") : crumb.name
    }

    /// The delete confirmation (§7.3): how many files the default (`auto`) puts in the drive's trash, and how many stay
    /// because they changed since they were posted.
    struct DeleteChoice: Equatable {
        let trash: Int
        let changed: Int
        let staying: Int

        init(_ files: [MessageDriveFileOut]) {
            trash = files.filter(\.trash).count
            changed = files.filter { !$0.trash && $0.reason == "changed" }.count
            staying = files.filter { !$0.trash }.count
        }

        /// The switch's line; nil when nothing would go to the trash (no switch then).
        var toggleTitle: String? { trash > 0 ? tr("ドライブの \(trash) 件のファイルもゴミ箱に移す") : nil }

        /// What stays in the drive whatever the switch says.
        var note: String? {
            if changed > 0 { return tr("\(changed) 件は投稿の後に変更されたため、ドライブに残ります。") }
            if trash == 0 && staying > 0 { return tr("添付したファイルはチャンネルのドライブに残ります。") }
            return nil
        }

        /// DELETE's `drive_files`: the switch on is the server's default; off keeps them all.
        static func parameter(trashing: Bool) -> String { trashing ? "auto" : "keep" }
    }

    /// Whether deleting this message asks about its drive files first: a posted file not purged yet.
    static func asksOnDelete(_ attachments: [AttachmentOut]) -> Bool {
        attachments.contains { $0.drive != nil && $0.drive?.state != "deleted" }
    }

    /// A post in a file's details: 「三井 · 10/28 15:02 · #m2-seminar（スレッド）」.
    static func postLine(_ post: DrivePostOut, sender: String, channel: String?) -> String {
        var parts = [sender, Timeline.fullLabel(post.postedAt)]
        if let channel { parts.append(post.parentId == nil ? "#" + channel : tr("#\(channel)（スレッド）")) }
        return parts.joined(separator: " · ")
    }
}

/// CF5 (docs/CHANNEL_FILES.md §12.4): a file over the attachment limit (100 MB) added to the composer goes up into a
/// drive with the background drive upload (DRIVE.md §30), and its `/d/` link goes into the draft once it is done.
enum ComposerDrive {
    /// Where such a file may go from a conversation.
    enum Plan: Equatable {
        /// A public or private channel: with `posts` (its posted files go to its drive) its 「投稿のファイル › 2026-10」,
        /// else (the switch off) its drive's top — the members can open the link there, not in マイドライブ. マイドライブ
        /// when I cannot write to the channel's drive.
        case channel(posts: Bool)
        /// A DM or group DM (no drive of its own): マイドライブ, whose link the others cannot open.
        case myDrive
    }

    /// The folder the upload was resolved to, for the question before it starts.
    enum Destination: Equatable {
        /// The channel's 「投稿のファイル」 (the month's folder below it is found or made on completion).
        case channelPosts(channelName: String)
        /// The channel's drive's top: its posted files stay out of the drive (the switch off), or its 「投稿のファイル」
        /// is not made yet (the first posted file makes it; a client cannot make that special folder, no API).
        case channelRoot(channelName: String)
        /// マイドライブ: a DM, or a channel whose drive I may not write to (an owners-only channel's member).
        case myDrive(fromChannel: Bool)
    }

    struct Resolved: Equatable {
        let target: DriveUploadTarget
        let destination: Destination
    }

    /// nil: the size error as before — no drive on the server, or an archived conversation.
    static func plan(_ channel: ChannelOut, settings: WorkspaceSettings, driveAvailable: Bool) -> Plan? {
        guard driveAvailable, !channel.archived else { return nil }
        if channel.isDm { return .myDrive }
        return .channel(posts: ChannelFiles.savesToDrive(channel, settings: settings))
    }

    /// The month folder 「2026-10」 in the server's zone (DriveUploadRules.monthName).
    static func monthName(_ date: Date, zone: TimeZone = DriveUploadRules.postsZone) -> String {
        DriveUploadRules.monthName(date, zone: zone)
    }

    /// The channel drive's 「投稿のファイル」 among the root's items (by its role, never by its name).
    static func postsFolder(_ items: [DriveItemOut]) -> DriveItemOut? {
        items.first { $0.isChannelPosts && $0.isFolder && $0.trashedAt == nil }
    }

    /// The root's pages read to find 「投稿のファイル」 (folders come first, by name).
    static let rootPages = 10

    /// The upload's folder: the plan's drive, resolved (made on first use) through the drive's API.
    @MainActor
    static func resolve(_ plan: Plan, channel: ChannelOut, api: DriveApi, now: Date = Date()) async throws -> Resolved {
        let name = channel.name ?? ""
        if case .channel(let posts) = plan {
            let location = try await api.resolveDrive(channelId: channel.id)
            if location.canWrite {
                var cursor: String?
                for _ in 0..<(posts ? rootPages : 0) {
                    let page = try await api.driveChildren(folderId: location.rootId, sort: .name, descending: false, cursor: cursor)
                    if let posts = postsFolder(page.items) {
                        let month = monthName(now)
                        let label = "#\(name) › \(tr("投稿のファイル")) › \(month)"
                        return Resolved(target: DriveUploadTarget(parentId: posts.id, locationId: location.id, label: label, relativeDir: month),
                                        destination: .channelPosts(channelName: name))
                    }
                    guard let next = page.nextCursor else { break }
                    cursor = next
                }
                return Resolved(target: DriveUploadTarget(parentId: location.rootId, locationId: location.id, label: "#\(name)"),
                                destination: .channelRoot(channelName: name))
            }
        }
        let mine = try await api.resolveDrive(channelId: nil)
        return Resolved(target: DriveUploadTarget(parentId: mine.rootId, locationId: mine.id, label: tr("マイドライブ")),
                        destination: .myDrive(fromChannel: plan != .myDrive))
    }

    /// The question's text: where the file goes, and who cannot open its link.
    static func explanation(_ destination: Destination) -> String {
        let after = tr("終わるとリンクが入力欄に入ります。")
        let unreadable = tr("ほかの人はリンクのファイルを開けません（ドライブで共有してください）。")
        switch destination {
        case .channelPosts(let name): return tr("#\(name) のドライブの「投稿のファイル」にアップロードします。") + after
        case .channelRoot(let name): return tr("#\(name) のドライブにアップロードします。") + after
        case .myDrive(fromChannel: true): return tr("このチャンネルのドライブには書き込めないため、マイドライブにアップロードします。") + after + unreadable
        case .myDrive(fromChannel: false): return tr("マイドライブにアップロードします。") + after + unreadable
        }
    }

    /// The composer's rows of a conversation: its uploads not linked yet (cancelled ones leave), oldest first.
    static func rows(_ batches: [DriveUploadBatch], account: String?, composer: DriveUploadComposer) -> [DriveUploadRow] {
        guard let account else { return [] }
        return batches.filter { $0.account == account && $0.composer == composer }.flatMap { batch in
            batch.jobs.filter { $0.linked != true && $0.state != .cancelled && $0.state != .skipped }.map { DriveUploadRow(batch: batch, job: $0) }
        }
    }

    /// The account's composer uploads that are done and whose link is not in their draft yet (the share sheet's are
    /// posted by the processor instead).
    static func finished(_ batches: [DriveUploadBatch], account: String?) -> [DriveUploadRow] {
        guard let account else { return [] }
        return batches.filter { $0.account == account && $0.composer != nil && $0.composer?.send != true }.flatMap { batch in
            batch.jobs.filter { $0.state == .done && $0.linked != true }.map { DriveUploadRow(batch: batch, job: $0) }
        }
    }

    /// Each finished upload's link at the end of its conversation's draft in `store` (the draft then syncs to my other
    /// devices as typed text does). Returns the names of those without a link (a file I can no longer read, §28.3).
    @MainActor
    static func link(_ rows: [DriveUploadRow], store: Store) -> [String] {
        var unlinked: [String] = []
        for row in rows {
            guard let composer = row.batch.composer else { continue }
            guard let itemId = row.job.itemId, let base = URL(string: row.batch.serverUrl) else {
                unlinked.append(row.job.name)
                continue
            }
            let link = DriveLink.url(base: base, itemId: itemId)
            store.setDraft(composer.channelId, parentId: composer.parentId) { $0.text = inserting(link, into: $0.text) }
        }
        return unlinked
    }

    /// The draft's text with the link at its end, on a line of its own (unchanged when the link is in it already).
    static func inserting(_ link: String, into text: String) -> String {
        if text.contains(link) { return text }
        if text.isEmpty || text.hasSuffix("\n") { return text + link }
        return text + "\n" + link
    }
}
