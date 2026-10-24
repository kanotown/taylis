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

    /// The path from the root (renamed by kind) down to the folder.
    static func crumbs(_ path: [DriveCrumb], kind: String?) -> [DriveCrumb] {
        guard let root = path.first else { return path }
        return [DriveCrumb(id: root.id, name: rootName(kind: kind, serverName: root.name))] + path.dropFirst()
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
