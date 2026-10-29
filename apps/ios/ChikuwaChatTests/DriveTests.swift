import SwiftUI
import XCTest
@testable import ChikuwaChat

/// A drive server in memory (the hub's and the folder model's calls).
@MainActor
final class FakeDriveApi: DriveApi {
    var locations: [DriveLocationOut] = []
    var locationsError: Error?
    var children: [String: [DriveItemOut]] = [:]
    var paths: [String: [DriveCrumb]] = [:]
    var childrenError: Error?
    var pageSize = 2
    var items: [String: DriveItemDetailOut] = [:]
    var itemError: Error?
    /// CF5: the drives `resolveDrive` answers as writable (a channel's id, or "me").
    var writable: Set<String> = []
    private(set) var calls: [String] = []

    func driveLocations() async throws -> [DriveLocationOut] {
        calls.append("locations")
        if let locationsError { throw locationsError }
        return locations
    }

    func resolveDrive(channelId: String?) async throws -> DriveLocationOut {
        calls.append("resolve \(channelId ?? "me")")
        return DriveLocationOut(id: "loc-\(channelId ?? "me")", kind: channelId == nil ? "user" : "channel", channelId: channelId,
                                rootId: "root-\(channelId ?? "me")", name: channelId == nil ? "マイドライブ" : "ゼミ",
                                canWrite: writable.contains(channelId ?? "me"))
    }

    func driveChildren(folderId: String, sort: DriveSort, descending: Bool, cursor: String?) async throws -> DriveChildrenOut {
        calls.append("children \(folderId) \(sort.rawValue) \(descending ? "desc" : "asc") \(cursor ?? "-")")
        if let childrenError { throw childrenError }
        let all = children[folderId] ?? []
        let start = Int(cursor ?? "0") ?? 0
        let page = Array(all.dropFirst(start).prefix(pageSize))
        let next = start + pageSize < all.count ? String(start + pageSize) : nil
        return DriveChildrenOut(folder: folder(folderId), path: paths[folderId] ?? [DriveCrumb(id: folderId, name: "研究室ドライブ")],
                                items: page, nextCursor: next)
    }

    func driveItem(_ id: String) async throws -> DriveItemDetailOut {
        calls.append("item \(id)")
        if let itemError { throw itemError }
        guard let item = items[id] else { throw ApiError.api(status: 404, code: "drive_item_not_found", message: "") }
        return item
    }

    func searchDrive(query: String, locationId: String?, cursor: String?, origin: String) async throws -> DriveSearchOut { DriveSearchOut(items: []) }
    func driveDownloadTicket(_ itemId: String) async throws -> DriveTicketOut { DriveTicketOut(url: "/api/v1/drive/download/t-\(itemId)", expiresIn: 300) }
    func driveZip(_ itemIds: [String]) async throws -> DriveZipOut { DriveZipOut(url: "/api/v1/drive/zip/z", filename: "a.zip") }
    func requestDrivePreview(_ itemId: String) async throws -> AttachmentPreviewOut? {
        calls.append("preview \(itemId)")
        return AttachmentPreviewOut(status: "pending")
    }
    func createDriveFolder(parentId: String, name: String, clientOpId: String) async throws -> DriveItemOut {
        calls.append("folder \(parentId) \(name)")
        return folder("new-\(name)", parent: parentId)
    }

    func folder(_ id: String, parent: String? = nil) -> DriveItemOut {
        DriveItemOut(id: id, locationId: "ws", parentId: parent, kind: "folder", name: id, createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z")
    }
}

func driveFile(_ id: String, name: String, type: String, size: Int64 = 1000, file: DriveFileOut? = nil, parent: String = "f1") -> DriveItemOut {
    DriveItemOut(id: id, locationId: "ws", parentId: parent, kind: "file", name: name, sizeBytes: size, contentType: type,
                 createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z", versionCount: 1,
                 file: file ?? DriveFileOut(attachmentId: "a-\(id)", versionId: "v-\(id)"))
}

@MainActor
final class DriveLinkTests: XCTestCase {
    private let base = URL(string: "http://127.0.0.1:18766")!
    private let id = "01a16063-9d83-753d-a072-1f33464eecfe"

    func testOnlyThisServersDriveLinksAreRecognised() {
        XCTAssertEqual(DriveLink.itemId(base: base, url: "http://127.0.0.1:18766/d/\(id)"), id)
        XCTAssertEqual(DriveLink.itemId(base: URL(string: "http://127.0.0.1:18766/")!, url: "HTTP://127.0.0.1:18766/d/\(id.uppercased())?x=1#y"), id)
        XCTAssertNil(DriveLink.itemId(base: base, url: "https://other.example/d/\(id)"))
        XCTAssertNil(DriveLink.itemId(base: base, url: "http://127.0.0.1:18766/m/\(id)"))
        XCTAssertNil(DriveLink.itemId(base: base, url: "http://127.0.0.1:18766/d/not-an-id"))
        XCTAssertNil(DriveLink.itemId(base: nil, url: "http://127.0.0.1:18766/d/\(id)"))
        XCTAssertEqual(DriveLink.url(base: URL(string: "http://127.0.0.1:18766/")!, itemId: id), "http://127.0.0.1:18766/d/\(id)")
    }

    func testABodysCardsAreItsDriveLinksOnceAtMostThree() {
        let ids = (0..<5).map { "00000000-0000-0000-0000-00000000000\($0)" }
        let body = """
        修論: http://127.0.0.1:18766/d/\(ids[0]) と [資料](http://127.0.0.1:18766/d/\(ids[1]))
        もう一度 http://127.0.0.1:18766/d/\(ids[0])。コード `http://127.0.0.1:18766/d/\(ids[2])` は数えない
        ほかのサーバ https://x.example/d/\(ids[3]) と http://127.0.0.1:18766/d/\(ids[3]) http://127.0.0.1:18766/d/\(ids[4])
        """
        XCTAssertEqual(DriveLink.ids(in: body, base: base), [ids[0], ids[1], ids[3]])
        // Past the three cards, the text's own links are asked too (their names, or 「表示できないファイル」).
        XCTAssertEqual(DriveLink.ids(in: body, base: base, limit: 20), [ids[0], ids[1], ids[3], ids[4]])
        XCTAssertEqual(DriveLink.ids(in: "no links", base: base), [])
    }

    func testTheTextNeverShowsTheSendersLabel() {
        let detail = DriveItemDetailOut(item: driveFile("x", name: "修論_最終版.pdf", type: "application/pdf"), path: [], locationKind: "workspace")
        XCTAssertEqual(DriveLink.inlineText(.item(detail)), "📎 修論_最終版.pdf")
        let folder = DriveItemDetailOut(item: FakeDriveApi().folder("ゼミ", parent: "r"), path: [])
        XCTAssertEqual(DriveLink.inlineText(.item(folder)), "📁 ゼミ")
        XCTAssertEqual(DriveLink.inlineText(.unreadable), "📎 表示できないファイル")
        XCTAssertEqual(DriveLink.inlineText(nil), "📎 ドライブのファイル")
        XCTAssertEqual(DriveLink.inlineText(.failed), "📎 ドライブのファイル")
    }
}

@MainActor
final class DriveRulesTests: XCTestCase {
    private var tokyo: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "Asia/Tokyo")!
        return calendar
    }

    func testRootsAreNamedByKind() {
        XCTAssertEqual(DriveRules.rootName(kind: "workspace", serverName: "x"), "研究室ドライブ")
        XCTAssertEqual(DriveRules.rootName(kind: "user", serverName: "x"), "マイドライブ")
        XCTAssertEqual(DriveRules.rootName(kind: "channel", serverName: "学会準備"), "学会準備")
        let path = [DriveCrumb(id: "r", name: "Lab"), DriveCrumb(id: "a", name: "論文")]
        XCTAssertEqual(DriveRules.crumbs(path, kind: "workspace").map(\.name), ["研究室ドライブ", "論文"])
        XCTAssertEqual(DriveRules.whereLabel(path, kind: "workspace"), "研究室ドライブ › 論文")
        XCTAssertEqual(DriveRules.crumbs([], kind: "workspace"), [])
    }

    func testTheCardSaysWhereAndHowBig() {
        let path = [DriveCrumb(id: "r", name: "研究室ドライブ"), DriveCrumb(id: "a", name: "論文")]
        let file = DriveItemDetailOut(item: driveFile("x", name: "a.pdf", type: "application/pdf", size: 4_823_112), path: path, locationKind: "workspace")
        XCTAssertEqual(DriveRules.cardDetail(file), "研究室ドライブ › 論文 · 4.6 MB")
        let folder = DriveItemDetailOut(item: FakeDriveApi().folder("b", parent: "a"), path: path, locationKind: "workspace")
        XCTAssertEqual(DriveRules.cardDetail(folder), "研究室ドライブ › 論文 · フォルダ")
    }

    func testSizesGoUpToGigabytes() {
        XCTAssertEqual(driveSize(512), "512 B")
        XCTAssertEqual(driveSize(314_572_800), "300.0 MB")
        XCTAssertEqual(driveSize(5_368_709_120), "5.0 GB")
    }

    func testDatesAreShortAndInTheUsersWords() {
        let now = ISO8601DateFormatter().date(from: "2026-10-22T03:00:00Z")!
        XCTAssertEqual(DriveRules.dateLabel("2026-10-22T01:05:00Z", now: now, calendar: tokyo), "10:05")
        XCTAssertEqual(DriveRules.dateLabel("2026-02-01T09:12:00Z", now: now, calendar: tokyo), "2月1日")
        XCTAssertEqual(DriveRules.dateLabel("2025-03-01T09:12:00Z", now: now, calendar: tokyo), "2025年3月1日")
        XCTAssertEqual(DriveRules.dateLabel("nonsense", now: now, calendar: tokyo), "")
        var item = driveFile("x", name: "a.txt", type: "text/plain", size: 2048)
        item.contentModifiedAt = "2026-02-01T09:12:00Z"
        XCTAssertEqual(DriveRules.rowDetail(item, now: now, calendar: tokyo), "2月1日 · 2 KB")
        XCTAssertEqual(DriveRules.rowDetail(FakeDriveApi().folder("f"), now: now, calendar: tokyo), "10月1日")
    }

    func testWhatAFileOpensIn() {
        let pdf = driveFile("p", name: "a.pdf", type: "application/pdf",
                            file: DriveFileOut(attachmentId: "a", preview: AttachmentPreviewOut(status: "ready", pages: 6, width: 800, height: 1100)))
        XCTAssertEqual(DriveRules.viewer(pdf), .document)
        let docx = driveFile("d", name: "a.docx", type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                             file: DriveFileOut(attachmentId: "a", preview: AttachmentPreviewOut(status: "pending")))
        XCTAssertEqual(DriveRules.viewer(docx), .document, "§29: a preview being made opens the viewer (「プレビューを作成中…」)")
        // §27 / §29: every PDF and Office file opens the viewer, made preview or not (imported files have none).
        XCTAssertEqual(DriveRules.viewer(driveFile("ip", name: "論文.pdf", type: "application/pdf")), .document)
        XCTAssertEqual(DriveRules.viewer(driveFile("jp", name: "前置き.PDF", type: "application/octet-stream")), .document)
        XCTAssertEqual(DriveRules.viewer(driveFile("id", name: "議事録.docx", type: "application/zip")), .document)
        XCTAssertEqual(DriveRules.viewer(driveFile("ix", name: "表.xlsx", type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")), .document)
        XCTAssertNil(DriveRules.viewer(driveFile("t", name: "memo.txt", type: "text/plain")))
        XCTAssertNil(DriveRules.viewer(driveFile("z", name: "a.zip", type: "application/zip")))
        let photo = driveFile("i", name: "a.jpg", type: "image/jpeg", file: DriveFileOut(attachmentId: "a", hasThumbnail: true))
        XCTAssertEqual(DriveRules.viewer(photo), .image)
        let bigPhoto = driveFile("i2", name: "huge.tif", type: "image/tiff")
        XCTAssertNil(DriveRules.viewer(bigPhoto), "no thumbnail (too large, not a format the server reads): no viewer")
        XCTAssertEqual(DriveRules.viewer(driveFile("v", name: "a.mp4", type: "video/mp4")), .video)
        XCTAssertNil(DriveRules.viewer(driveFile("b", name: "a.bin", type: "application/octet-stream")))
        XCTAssertNil(DriveRules.viewer(FakeDriveApi().folder("f")))
        XCTAssertEqual(DriveRules.thumbnailPath(photo), "/api/v1/attachments/a/thumbnail")
        XCTAssertEqual(DriveRules.thumbnailPath(pdf), "/api/v1/attachments/a/preview/thumbnail")
        XCTAssertNil(DriveRules.thumbnailPath(docx))
    }

    /// The desktop's `documentSource` (§27): where the document viewer reads a file's pages.
    func testWhereTheDocumentViewerReadsThePages() {
        func file(_ name: String, _ type: String, _ status: String?) -> DriveItemOut {
            driveFile(name, name: name, type: type, file: DriveFileOut(attachmentId: "a", preview: status.map { AttachmentPreviewOut(status: $0) }))
        }
        XCTAssertEqual(DriveRules.documentSource(file("a.pdf", "application/pdf", "ready")), .preview)
        XCTAssertEqual(DriveRules.documentSource(file("a.pdf", "application/pdf", nil)), .original)
        XCTAssertEqual(DriveRules.documentSource(file("a.pdf", "application/pdf", "pending")), .original)
        XCTAssertEqual(DriveRules.documentSource(file("a.pdf", "application/pdf", "failed")), .original)
        XCTAssertEqual(DriveRules.documentSource(file("b.pdf", "application/octet-stream", nil)), .original)
        XCTAssertEqual(DriveRules.documentSource(file("a.docx", "application/zip", "ready")), .preview)
        XCTAssertEqual(DriveRules.documentSource(file("a.docx", "application/zip", "pending")), .making)
        XCTAssertEqual(DriveRules.documentSource(file("a.docx", "application/zip", "failed")), .failed)
        XCTAssertEqual(DriveRules.documentSource(file("a.docx", "application/zip", nil)), .ask)
        XCTAssertTrue(DriveRules.isPdf(file("x.pdf", "", nil)))
        XCTAssertFalse(DriveRules.isPdf(file("x.pdf", "text/plain", nil)), "a typed file is what its type says")
        XCTAssertTrue(DriveRules.isOffice(file("x.ppt", "application/x-ole-storage", nil)))
        XCTAssertTrue(DriveRules.isOffice(file("x", "application/msword", nil)))
        XCTAssertFalse(DriveRules.isOffice(file("x.csv", "text/csv", nil)))
        XCTAssertFalse(DriveRules.isOffice(FakeDriveApi().folder("f.docx")))
        XCTAssertEqual(DriveRules.icon(file("y.pdf", "application/octet-stream", nil)), "doc.richtext")
    }

    func testTheViewersGetTheItemsNameAndCurrentVersion() {
        var item = driveFile("i", name: "集合写真.jpg", type: "image/jpeg", size: 1234,
                             file: DriveFileOut(attachmentId: "att", versionId: "v2", width: 1600, height: 1200, hasThumbnail: true))
        item.updatedAt = "2026-10-21T00:00:00Z"
        let attachment = DriveRules.attachment(item)!
        XCTAssertEqual(attachment.id, "att")
        XCTAssertEqual(attachment.filename, "集合写真.jpg")
        XCTAssertEqual(attachment.sizeBytes, 1234)
        XCTAssertTrue(attachment.isImage)
        XCTAssertNil(DriveRules.attachment(FakeDriveApi().folder("f")))
        XCTAssertEqual(DriveRules.fileName("a/b:c.pdf"), "a_b_c.pdf")
        XCTAssertEqual(DriveRules.fileName(" .. "), "file")
    }

    func testTheDrivesInTheirOrder() {
        let list = [DriveLocationOut(id: "c2", kind: "channel", rootId: "r", name: "ゼミ"),
                    DriveLocationOut(id: "u", kind: "user", rootId: "r", name: "マイドライブ"),
                    DriveLocationOut(id: "c1", kind: "channel", rootId: "r", name: "学会準備"),
                    DriveLocationOut(id: "w", kind: "workspace", rootId: "r", name: "研究室ドライブ")]
        XCTAssertEqual(DriveRules.ordered(list).map(\.id), ["w", "u", "c2", "c1"])
        XCTAssertEqual(DriveRules.usage(DriveLocationOut(id: "w", kind: "workspace", rootId: "r", name: "", usedBytes: 2048)), "2 KB 使用")
        XCTAssertEqual(DriveRules.usage(DriveLocationOut(id: "w", kind: "workspace", rootId: "r", name: "", quotaBytes: 5_368_709_120, usedBytes: 2048)),
                       "2 KB（上限 5.0 GB）")
    }
}

@MainActor
final class DriveHubTests: XCTestCase {
    func testTheServerHasTheDriveWhenItAnswers() async {
        let api = FakeDriveApi()
        api.locations = [DriveLocationOut(id: "w", kind: "workspace", rootId: "r", name: "研究室ドライブ")]
        let hub = DriveHub(api: api)
        await hub.bootstrap()
        XCTAssertTrue(hub.available)
        XCTAssertEqual(hub.locations?.map(\.id), ["w"])
        XCTAssertEqual(hub.reconnects, 0)
        await hub.bootstrap()
        XCTAssertEqual(hub.reconnects, 1, "a later bootstrap is a reconnect: open folders read again")

        let older = FakeDriveApi()
        older.locationsError = ApiError.api(status: 404, code: "not_found", message: "")
        let none = DriveHub(api: older)
        await none.bootstrap()
        XCTAssertFalse(none.available)

        let offline = FakeDriveApi()
        offline.locationsError = ApiError.network(URLError(.notConnectedToInternet))
        let away = DriveHub(api: offline)
        await away.bootstrap()
        XCTAssertFalse(away.available)
        XCTAssertNotNil(away.locationsFailure)
    }

    func testChangedFoldersAreSignalledInOrderOnce() {
        let hub = DriveHub(api: FakeDriveApi())
        let event = { (seq: Int, folders: [String]) -> JSONValue in
            .object(["location_id": .string("w"), "folder_ids": .array(folders.map(JSONValue.string)), "seq": .number(Double(seq))])
        }
        hub.applyEvent("drive.changed", event(5, ["a", "b"]))
        XCTAssertEqual(hub.signal("a"), 1)
        XCTAssertEqual(hub.signal("b"), 1)
        hub.applyEvent("drive.changed", event(5, ["a"]))  // the same event again
        hub.applyEvent("drive.changed", event(3, ["a"]))  // an older one, late
        XCTAssertEqual(hub.signal("a"), 1)
        hub.applyEvent("drive.changed", event(6, ["a"]))
        XCTAssertEqual(hub.signal("a"), 2)
        XCTAssertEqual(hub.signal("c"), 0)
        // Another drive has its own numbers.
        hub.applyEvent("drive.changed", .object(["location_id": .string("x"), "folder_ids": .array([.string("c")]), "seq": .number(1)]))
        XCTAssertEqual(hub.signal("c"), 1)
    }

    func testALinkIsAskedOnceAMinuteAndNeverNamesWhatIAmNotAllowedToSee() async {
        let api = FakeDriveApi()
        let file = driveFile("x", name: "修論.pdf", type: "application/pdf")
        api.items["x"] = DriveItemDetailOut(item: file, path: [DriveCrumb(id: "r", name: "研究室ドライブ")], locationKind: "workspace")
        var trashed = driveFile("t", name: "消したもの.pdf", type: "application/pdf")
        trashed.trashedAt = "2026-10-20T00:00:00Z"
        api.items["t"] = DriveItemDetailOut(item: trashed, path: [])
        let hub = DriveHub(api: api)
        var clock = Date(timeIntervalSince1970: 1000)
        hub.now = { clock }

        guard case .item(let detail) = await hub.resolveLink("x") else { return XCTFail("readable") }
        XCTAssertEqual(detail.item.name, "修論.pdf")
        _ = await hub.resolveLink("x")
        XCTAssertEqual(api.calls.filter { $0 == "item x" }.count, 1, "held for a minute")
        clock += 61
        _ = await hub.resolveLink("x")
        XCTAssertEqual(api.calls.filter { $0 == "item x" }.count, 2)

        let missing = await hub.resolveLink("gone")
        XCTAssertEqual(missing, .unreadable)
        let inTrash = await hub.resolveLink("t")
        XCTAssertEqual(inTrash, .unreadable, "an item in the trash shows as unreadable (the server answers it for the trash screen)")

        // A failure keeps the answer it had; without one the card says it could not load.
        api.itemError = ApiError.api(status: 503, code: "unavailable", message: "")
        clock += 61
        _ = await hub.resolveLink("x", force: true)
        if case .item = hub.linkState("x") {} else { XCTFail("kept") }
        let failed = await hub.resolveLink("new")
        XCTAssertEqual(failed, .failed)
    }

    func testAChangeInTheItemsFolderAsksTheCardAgain() async {
        let api = FakeDriveApi()
        api.items["x"] = DriveItemDetailOut(item: driveFile("x", name: "a.pdf", type: "application/pdf", parent: "f1"), path: [])
        let hub = DriveHub(api: api)
        _ = await hub.resolveLink("x")
        hub.applyEvent("drive.changed", .object(["location_id": .string("ws"), "folder_ids": .array([.string("f1")]), "seq": .number(9)]))
        _ = await hub.resolveLink("x")
        XCTAssertEqual(api.calls.filter { $0 == "item x" }.count, 2)
    }

    func testResolvingMyDriveAddsItToTheList() async throws {
        let api = FakeDriveApi()
        let hub = DriveHub(api: api)
        await hub.loadLocations()
        let mine = try await hub.resolve(channelId: nil)
        XCTAssertEqual(mine.kind, "user")
        XCTAssertEqual(hub.locations?.map(\.id), ["loc-me"])
    }
}

@MainActor
final class DriveFolderModelTests: XCTestCase {
    func testPagesAppendAndTheOrderReadsAgain() async {
        let api = FakeDriveApi()
        api.children["f"] = (1...5).map { driveFile("i\($0)", name: "メモ_\($0).txt", type: "text/plain", parent: "f") }
        let model = DriveFolderModel(folderId: "f", api: api)
        await model.load()
        XCTAssertEqual(model.items?.map(\.id), ["i1", "i2"])
        XCTAssertEqual(model.nextCursor, "2")
        await model.loadMore()
        await model.loadMore()
        XCTAssertEqual(model.items?.map(\.id), ["i1", "i2", "i3", "i4", "i5"])
        XCTAssertNil(model.nextCursor)
        await model.loadMore()  // nothing more
        XCTAssertEqual(api.calls.filter { $0.hasPrefix("children") }.count, 3)

        model.sort = .size
        model.descending = true
        await model.load()
        XCTAssertEqual(api.calls.last, "children f size desc -")
        XCTAssertEqual(model.items?.map(\.id), ["i1", "i2"], "a new order starts from its first page")
    }

    func testAFolderICannotReadAnyMoreIsGone() async {
        let api = FakeDriveApi()
        api.children["f"] = [driveFile("i1", name: "a", type: "text/plain", parent: "f")]
        api.paths["f"] = [DriveCrumb(id: "root", name: "研究室ドライブ"), DriveCrumb(id: "f", name: "論文")]
        let model = DriveFolderModel(folderId: "f", api: api)
        await model.load()
        XCTAssertEqual(model.rootId, "root")
        api.childrenError = ApiError.api(status: 404, code: "drive_item_not_found", message: "")
        await model.load()
        XCTAssertTrue(model.gone)
        XCTAssertNil(model.items)

        let failing = FakeDriveApi()
        failing.childrenError = ApiError.api(status: 500, code: "internal", message: "")
        let other = DriveFolderModel(folderId: "x", api: failing)
        await other.load()
        XCTAssertFalse(other.gone)
        XCTAssertNotNil(other.failure)
    }

    func testSeveralSignalsReadOnce() async throws {
        DriveFolderModel.reloadDelay = .milliseconds(50)
        defer { DriveFolderModel.reloadDelay = .milliseconds(300) }
        let api = FakeDriveApi()
        let model = DriveFolderModel(folderId: "f", api: api)
        model.reloadSoon()
        model.reloadSoon()
        model.reloadSoon()
        try await Task.sleep(for: .milliseconds(300))
        XCTAssertEqual(api.calls.filter { $0.hasPrefix("children") }.count, 1)
    }
}

@MainActor
final class DrivePlacesTests: XCTestCase {
    func testTheTileComesAfterFilesWhileTheServerHasTheDrive() {
        let threads = ThreadSummary(unreadCount: 0, mentionCount: 0)
        let without = HomeTile.tiles(threads: threads, drafts: 0, saved: 0, firedReminders: 0, navItems: nil)
        XCTAssertFalse(without.contains { $0.kind == .drive })
        let with = HomeTile.tiles(threads: threads, drafts: 0, saved: 0, firedReminders: 0, navItems: nil, drive: true).map(\.kind)
        XCTAssertEqual(with.firstIndex(of: .drive), with.firstIndex(of: .files).map { $0 + 1 })
        XCTAssertEqual(HomeTile(kind: .drive, count: nil, alert: false).selectionId, DriveLocationsView.selectionId)
        XCTAssertTrue(NavItems.implemented(attendance: false, drive: true).contains("drive"))
        XCTAssertFalse(NavItems.implemented(attendance: false).contains("drive"))
        // Hidden by my choice (on any device) stays hidden.
        let hidden = HomeTile.tiles(threads: threads, drafts: 0, saved: 0, firedReminders: 0, navItems: [NavItem(key: "drive", visible: false)], drive: true)
        XCTAssertFalse(hidden.contains { $0.kind == .drive })
    }

    func testOnlyChannelsHaveADriveTab() {
        let store = Store()
        for (id, type) in [("pub", "public"), ("dm", "dm")] {
            store.upsertChannel(ChannelOut(id: id, type: type, name: id, topic: nil, purpose: nil, archived: false, createdBy: nil, lastSeq: 0,
                                           lastMessageAt: nil, createdAt: "", updatedAt: "", membership: nil, dmUserIds: nil), isMember: true)
        }
        XCTAssertTrue(ChannelTab.tabs(for: store.channel("pub")!, drive: true).contains(.drive))
        XCTAssertFalse(ChannelTab.tabs(for: store.channel("pub")!).contains(.drive), "a server without the drive")
        XCTAssertFalse(ChannelTab.tabs(for: store.channel("dm")!, drive: true).contains(.drive))
        let tabs = ChannelTab.tabs(for: store.channel("pub")!, drive: true)
        XCTAssertEqual(tabs.firstIndex(of: .drive), tabs.firstIndex(of: .tasks).map { $0 + 1 })
    }

    func testAFolderOnTheStackIsGoneBackTo() {
        var nav = MainNavigation()
        nav.paths[.home] = [.list(DriveLocationsView.selectionId)]
        nav.openDriveFolder("root", on: .home)
        nav.openDriveFolder("a", on: .home)
        nav.openDriveFolder("b", on: .home)
        XCTAssertEqual(nav.paths[.home], [.list("drive"), .drive("root"), .drive("a"), .drive("b")])
        nav.openDriveFolder("root", on: .home)  // a step of the path
        XCTAssertEqual(nav.paths[.home], [.list("drive"), .drive("root")])
        nav.setLayout(.split, isDm: { _ in false })
        nav.openDriveFolder("c", on: .home)
        XCTAssertEqual(nav.split, [.list("drive"), .drive("root"), .drive("c")])
    }
}

/// The transfer to disk (URLSession's download task through the stub).
@MainActor
final class DriveDownloadTests: XCTestCase {
    private var session: URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubProtocol.self]
        return URLSession(configuration: configuration)
    }

    override func tearDown() {
        StubProtocol.handler = nil
        super.tearDown()
    }

    func testTheBytesGoToTheFile() async throws {
        let body = Data((0..<300_000).map { UInt8($0 % 251) })
        StubProtocol.handler = { request in
            XCTAssertNil(request.value(forHTTPHeaderField: "Authorization"), "a ticket's URL carries no bearer token")
            return (200, body)
        }
        let destination = FileManager.default.temporaryDirectory.appendingPathComponent("drive-test-\(UUID().uuidString)/計測データ.bin")
        defer { try? FileManager.default.removeItem(at: destination.deletingLastPathComponent()) }
        var seen: Int64 = 0
        try await DriveFiles.download(URL(string: "http://server/api/v1/drive/download/t")!, to: destination, session: session) { received, _ in
            seen = received
        }
        XCTAssertEqual(try Data(contentsOf: destination), body)
        _ = seen
    }

    func testAnErrorAnswerIsTheServersError() async {
        StubProtocol.handler = { _ in (404, Data(#"{"error":{"code":"drive_item_not_found","message":"gone"}}"#.utf8)) }
        let destination = FileManager.default.temporaryDirectory.appendingPathComponent("drive-test-\(UUID().uuidString)/x.bin")
        defer { try? FileManager.default.removeItem(at: destination.deletingLastPathComponent()) }
        do {
            try await DriveFiles.download(URL(string: "http://server/api/v1/drive/download/t")!, to: destination, session: session)
            XCTFail("refused")
        } catch let error as ApiError {
            XCTAssertEqual(error.code, "drive_item_not_found")
            XCTAssertFalse(FileManager.default.fileExists(atPath: destination.path))
        } catch {
            XCTFail("\(error)")
        }
    }

    func testTheTicketsPathIsOnTheServer() {
        XCTAssertEqual(DriveFiles.absolute("/api/v1/drive/download/abc", base: URL(string: "http://127.0.0.1:18766")!)?.absoluteString,
                       "http://127.0.0.1:18766/api/v1/drive/download/abc")
    }
}

/// The drive's calls on the wire (paths and query).
@MainActor
final class DriveApiTests: XCTestCase {
    override func tearDown() {
        StubProtocol.handler = nil
        super.tearDown()
    }

    func testTheListingAndSearchAsk() async throws {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubProtocol.self]
        let client = ApiClient(baseUrl: URL(string: "http://server")!, session: URLSession(configuration: configuration))
        client.accessToken = "t"
        var asked: [String] = []
        StubProtocol.handler = { request in
            asked.append("\(request.httpMethod ?? "") \(request.url!.path)?\(request.url!.query ?? "")")
            if request.url!.path.hasSuffix("/children") {
                return (200, Data(#"{"folder":{"id":"f","location_id":"w","parent_id":null,"kind":"folder","name":"研究室ドライブ","size_bytes":null,"content_type":null,"content_modified_at":null,"created_by":null,"created_at":"x","updated_by":null,"updated_at":"x","version_count":0,"file":null,"link_count":0},"path":[{"id":"f","name":"研究室ドライブ"}],"items":[],"next_cursor":null,"shared_above":0}"#.utf8))
            }
            return (200, Data(#"{"items":[],"next_cursor":null}"#.utf8))
        }
        let page = try await client.driveChildren(folderId: "f", sort: .modified, descending: true, cursor: "c+1")
        XCTAssertEqual(page.folder.name, "研究室ドライブ")
        _ = try await client.searchDrive(query: "修論 2026", locationId: "w", cursor: nil)
        XCTAssertEqual(asked[0], "GET /api/v1/drive/folders/f/children?sort=modified&order=desc&limit=100&cursor=c%2B1")
        XCTAssertEqual(asked[1], "GET /api/v1/search/drive?q=%E4%BF%AE%E8%AB%96%202026&limit=50&location_id=w&content=true")
    }
}

/// docs/DRIVE.md §29: a drive search hit inside a file — the pieces, the page, and an older server's answer.
final class DriveSnippetTests: XCTestCase {
    private let item = #"{"id":"a","location_id":"w","parent_id":"r","kind":"file","name":"報告.pdf","size_bytes":10,"content_type":"application/pdf","content_modified_at":null,"created_by":null,"created_at":"x","updated_by":null,"updated_at":"x","version_count":1,"file":null,"link_count":0}"#

    func testAHitInsideAFileReadsItsSnippet() throws {
        let json = #"{"items":[{"item":"# + item + #","path":[],"location_kind":"workspace","match":"content","snippet":[{"text":"…共振器の","hit":false},{"text":"品質係数","hit":true},{"text":"は高い…"}],"page":2}],"next_cursor":null,"keywords":["品質係数"]}"#
        let out = try JSON.snakeDecoder.decode(DriveSearchOut.self, from: Data(json.utf8))
        let hit = try XCTUnwrap(out.items.first)
        XCTAssertEqual(hit.match, "content")
        XCTAssertEqual(hit.page, 2)
        XCTAssertEqual(hit.snippet?.map(\.isHit), [false, true, false])
        XCTAssertEqual(hit.snippetText, "…共振器の品質係数は高い…")
        let line = try XCTUnwrap(DriveSnippetLine.text(hit))
        XCTAssertTrue(String(line.characters).hasSuffix("…共振器の品質係数は高い…"))
        let marked = line.runs.filter { $0.backgroundColor != nil }.map { String(line[$0.range].characters) }
        XCTAssertEqual(marked, ["品質係数"])
    }

    /// §29.6: a slide or a sheet of a file read from its package is labelled as one; no `page_kind` is a PDF page.
    func testSlidesAndSheetsAreLabelled() throws {
        func hit(_ extra: String) throws -> DriveSearchHitOut {
            let json = #"{"item":"# + item + #","path":[],"location_kind":"workspace","match":"content","snippet":[{"text":"x","hit":true}]"# + extra + "}"
            return try JSON.snakeDecoder.decode(DriveSearchHitOut.self, from: Data(json.utf8))
        }
        let slide = try hit(#","page":12,"page_kind":"slide""#)
        XCTAssertEqual(slide.pageKind, "slide")
        XCTAssertEqual(DriveSnippetLine.pageLabel(slide), tr("\(12) 枚目"))
        XCTAssertEqual(DriveSnippetLine.pageLabel(try hit(#","page":2,"page_kind":"sheet""#)), tr("シート \(2)"))
        XCTAssertEqual(DriveSnippetLine.pageLabel(try hit(#","page":3"#)), tr("\(3) ページ目"))
        XCTAssertNil(DriveSnippetLine.pageLabel(try hit(#","page":null,"page_kind":null"#)))
        let line = try XCTUnwrap(DriveSnippetLine.text(slide))
        XCTAssertTrue(String(line.characters).contains(tr("\(12) 枚目")))
    }

    func testANameHitOrAnOlderServerHasNoSnippet() throws {
        let json = #"{"items":[{"item":"# + item + #","path":[],"location_kind":"workspace"}],"next_cursor":null}"#
        let hit = try XCTUnwrap(try JSON.snakeDecoder.decode(DriveSearchOut.self, from: Data(json.utf8)).items.first)
        XCTAssertNil(hit.match)
        XCTAssertNil(hit.snippetText)
        XCTAssertNil(DriveSnippetLine.text(hit))
    }
}

/// CF3 (docs/CHANNEL_FILES.md §11, §12, §19.3): files posted in a channel, in its drive.
@MainActor
final class ChannelFilesTests: XCTestCase {
    /// The server's own JSON (CF1's MessageOut, pydantic's dump): a posted file in the drive, a purged one (a tombstone)
    /// and a plain attachment.
    static let message = #"{"id":"00000000-0000-0000-0000-000000000001","channel_id":"00000000-0000-0000-0000-000000000002","sender_id":"00000000-0000-0000-0000-000000000003","parent_id":null,"also_in_channel":false,"seq":7,"updated_seq":9,"client_msg_id":"00000000-0000-0000-0000-000000000004","type":"user","body":"資料です","mentioned_user_ids":[],"mention_all":false,"reactions":[],"attachments":[{"id":"00000000-0000-0000-0000-00000000000a","filename":"修論_v1.pdf","content_type":"application/pdf","size_bytes":1234,"width":null,"height":null,"has_thumbnail":false,"has_poster":false,"duration_ms":null,"status":"attached","created_at":"2026-10-28T06:02:00Z","preview":null,"drive":{"item_id":"00000000-0000-0000-0000-000000000014","version_id":"00000000-0000-0000-0000-00000000001e","version_number":1,"state":"available"}},{"id":"00000000-0000-0000-0000-00000000000b","filename":"修論_v1.pdf","content_type":"application/pdf","size_bytes":1234,"width":null,"height":null,"has_thumbnail":false,"has_poster":false,"duration_ms":null,"status":"attached","created_at":"2026-10-28T06:02:00Z","preview":null,"drive":{"item_id":null,"version_id":null,"version_number":null,"state":"deleted"}},{"id":"00000000-0000-0000-0000-00000000000c","filename":"修論_v1.pdf","content_type":"application/pdf","size_bytes":1234,"width":null,"height":null,"has_thumbnail":false,"has_poster":false,"duration_ms":null,"status":"attached","created_at":"2026-10-28T06:02:00Z","preview":null,"drive":null}],"reply_count":0,"last_reply_at":null,"reply_user_ids":[],"created_at":"2026-10-28T06:02:00Z","edited_at":null,"deleted":false,"pinned_at":null,"pinned_by":null,"poll":null,"priority":null,"ack_requested":false,"acks":[],"collection":null,"tasks":[],"system_event":null,"workflow":null,"call":null}"#

    private func attachment(_ drive: String?) throws -> AttachmentOut {
        let tail = drive.map { #","drive":"# + $0 } ?? ""
        let json = #"{"id":"a","filename":"f.pdf","content_type":"application/pdf","size_bytes":1,"width":null,"height":null,"has_thumbnail":false,"status":"attached","created_at":"2026-10-28T00:00:00Z""# + tail + "}"
        return try JSON.snakeDecoder.decode(AttachmentOut.self, from: Data(json.utf8))
    }

    func testTheServersMessageWithDriveReads() throws {
        let message = try JSON.snakeDecoder.decode(MessageOut.self, from: Data(Self.message.utf8))
        XCTAssertEqual(message.attachments.count, 3)
        XCTAssertEqual(message.attachments[0].drive,
                       AttachmentDriveOut(itemId: "00000000-0000-0000-0000-000000000014", versionId: "00000000-0000-0000-0000-00000000001e",
                                          versionNumber: 1, state: "available"))
        XCTAssertEqual(message.attachments[1].drive, AttachmentDriveOut(state: "deleted"))
        XCTAssertNil(message.attachments[2].drive)
        // Kept on the device as it came (the store's JSON), so an offline start shows the same states.
        let state = MessageState(message)
        let stored = try JSON.plainDecoder.decode(MessageState.self, from: JSON.plainEncoder.encode(state))
        XCTAssertEqual(stored.attachments.map(\.drive), message.attachments.map(\.drive))
    }

    func testAMessageWithoutDriveReadsAsBefore() throws {
        // A server before CF1, a DM: no `drive` at all.
        let older = Self.message.replacingOccurrences(
            of: #","drive":{"item_id":"00000000-0000-0000-0000-000000000014","version_id":"00000000-0000-0000-0000-00000000001e","version_number":1,"state":"available"}"#, with: "")
            .replacingOccurrences(of: #","drive":{"item_id":null,"version_id":null,"version_number":null,"state":"deleted"}"#, with: "")
            .replacingOccurrences(of: #","drive":null"#, with: "")
        XCTAssertFalse(older.contains("drive"))
        let message = try JSON.snakeDecoder.decode(MessageOut.self, from: Data(older.utf8))
        XCTAssertEqual(message.attachments.map(\.drive), [nil, nil, nil])
        XCTAssertEqual(message.attachments.map { ChannelFiles.look($0) }, [.plain, .plain, .plain])
        // A `drive` this build cannot read is no drive (the plain row), never a message that fails to read.
        XCTAssertNil(try attachment(#"{"state":7}"#).drive)
    }

    func testEachStateShowsItsOwnWay() throws {
        XCTAssertEqual(ChannelFiles.look(try attachment(nil)), .plain)
        XCTAssertEqual(ChannelFiles.look(try attachment(#"{"item_id":"i","version_id":"v","version_number":1,"state":"available"}"#)), .plain)
        XCTAssertEqual(ChannelFiles.look(try attachment(#"{"item_id":"i","version_id":"v","version_number":1,"state":"moved"}"#)), .moved(itemId: "i"))
        XCTAssertEqual(ChannelFiles.look(try attachment(#"{"item_id":"i","version_id":"v","version_number":1,"state":"trashed"}"#)),
                       .deleted(restoreId: "i"))
        XCTAssertEqual(ChannelFiles.look(try attachment(#"{"item_id":null,"version_id":null,"version_number":null,"state":"deleted"}"#)),
                       .deleted(restoreId: nil))
        // A state a later server adds: shown as a client before CF3 shows it.
        XCTAssertEqual(ChannelFiles.look(try attachment(#"{"item_id":"i","state":"archived"}"#)), .plain)
    }

    func testShowInDriveOffersTheFilesStillThere() throws {
        let files = [try attachment(#"{"item_id":"i1","state":"available"}"#), try attachment(#"{"item_id":"i2","state":"moved"}"#),
                     try attachment(#"{"item_id":"i3","state":"trashed"}"#), try attachment(nil)]
        XCTAssertEqual(ChannelFiles.driveItems(files).map(\.itemId), ["i1", "i2"])
        XCTAssertTrue(ChannelFiles.asksOnDelete(files))
        XCTAssertFalse(ChannelFiles.asksOnDelete([try attachment(nil), try attachment(#"{"state":"deleted"}"#)]))
    }

    func testTheComposerSaysSoWhereFilesGoToTheDrive() {
        func channel(_ type: String, _ own: Bool?) -> ChannelOut {
            ChannelOut(id: "c", type: type, name: "m2-seminar", topic: nil, purpose: nil, archived: false, createdBy: nil, lastSeq: 0,
                       lastMessageAt: nil, createdAt: "", updatedAt: "", membership: nil, dmUserIds: nil, filesToDrive: own)
        }
        let on = WorkspaceSettings(channelFilesToDrive: true), off = WorkspaceSettings(channelFilesToDrive: false)
        XCTAssertTrue(ChannelFiles.savesToDrive(channel("public", nil), settings: on))
        XCTAssertTrue(ChannelFiles.savesToDrive(channel("private", nil), settings: on))
        XCTAssertFalse(ChannelFiles.savesToDrive(channel("public", false), settings: on))
        XCTAssertTrue(ChannelFiles.savesToDrive(channel("public", true), settings: off))
        XCTAssertFalse(ChannelFiles.savesToDrive(channel("public", nil), settings: off))
        XCTAssertFalse(ChannelFiles.savesToDrive(channel("dm", nil), settings: on))
        XCTAssertFalse(ChannelFiles.savesToDrive(channel("group_dm", true), settings: on))
        // A server before CF1.
        XCTAssertFalse(ChannelFiles.savesToDrive(channel("public", nil), settings: WorkspaceSettings()))
        XCTAssertEqual(ChannelFiles.composerHint(channelName: "m2-seminar"), tr("#\("m2-seminar") のドライブの「投稿のファイル」に保存されます"))
        XCTAssertEqual(FilesToDriveChoice(nil), .workspace)
        XCTAssertEqual(FilesToDriveChoice(false).value, false)
        XCTAssertNil(FilesToDriveChoice.workspace.value)
    }

    func testTheWorkspaceSwitchAndTheChannelsAreRead() throws {
        let settings = try JSON.snakeDecoder.decode(WorkspaceSettings.self, from: Data(#"{"channel_files_to_drive":false}"#.utf8))
        XCTAssertEqual(settings.channelFilesToDrive, false)
        XCTAssertNil(try JSON.snakeDecoder.decode(WorkspaceSettings.self, from: Data("{}".utf8)).channelFilesToDrive)
        let channel = try JSON.snakeDecoder.decode(ChannelOut.self, from: Data(#"{"id":"c","type":"public","name":"n","topic":null,"purpose":null,"archived":false,"created_by":null,"last_seq":0,"created_at":"x","updated_at":"x","dm_user_ids":null,"files_to_drive":false,"files_to_drive_effective":false}"#.utf8))
        XCTAssertEqual(channel.filesToDrive, false)
        XCTAssertEqual(channel.filesToDriveEffective, false)
    }

    func testTheDeleteConfirmationsSwitch() {
        func file(_ trash: Bool, _ reason: String?) -> MessageDriveFileOut {
            MessageDriveFileOut(attachmentId: UUID().uuidString, itemId: "i", state: "available", trash: trash, reason: reason)
        }
        let mine = ChannelFiles.DeleteChoice([file(true, nil), file(true, nil), file(false, "changed")])
        XCTAssertEqual([mine.trash, mine.changed, mine.staying], [2, 1, 1])
        XCTAssertEqual(mine.toggleTitle, tr("ドライブの \(2) 件のファイルもゴミ箱に移す"))
        XCTAssertEqual(mine.note, tr("\(1) 件は投稿の後に変更されたため、ドライブに残ります。"))
        // Someone else's files (a moderator's delete keeps nothing back, but here: not mine): no switch, they stay.
        let others = ChannelFiles.DeleteChoice([file(false, "not_permitted")])
        XCTAssertNil(others.toggleTitle)
        XCTAssertEqual(others.note, tr("添付したファイルはチャンネルのドライブに残ります。"))
        XCTAssertEqual(ChannelFiles.DeleteChoice.parameter(trashing: true), "auto")
        XCTAssertEqual(ChannelFiles.DeleteChoice.parameter(trashing: false), "keep")
    }

    func testThePostsFolderIsNamedInMyLanguage() throws {
        let json = #"{"id":"00000000-0000-0000-0000-000000000028","location_id":"00000000-0000-0000-0000-000000000029","parent_id":"00000000-0000-0000-0000-00000000002a","kind":"folder","name":"投稿のファイル","size_bytes":null,"content_type":null,"content_modified_at":null,"created_by":"00000000-0000-0000-0000-000000000003","created_at":"2026-10-28T06:02:00Z","updated_by":"00000000-0000-0000-0000-000000000003","updated_at":"2026-10-28T06:02:00Z","version_count":0,"file":null,"link_count":0,"trashed_at":null,"trashed_by":null,"system_role":"channel_posts","posted":false,"posts":[{"message_id":"00000000-0000-0000-0000-000000000001","channel_id":"00000000-0000-0000-0000-000000000002","parent_id":null,"sender_id":"00000000-0000-0000-0000-000000000003","version_number":1,"posted_at":"2026-10-28T06:02:00Z"}]}"#
        let folder = try JSON.snakeDecoder.decode(DriveItemOut.self, from: Data(json.utf8))
        XCTAssertTrue(folder.isChannelPosts)
        XCTAssertFalse(folder.isPosted)
        XCTAssertEqual(folder.posts?.first?.senderId, "00000000-0000-0000-0000-000000000003")
        XCTAssertEqual(ChannelFiles.name(folder), tr("投稿のファイル"))
        // An item from a server before CF1: no role, no mark.
        let plain = FakeDriveApi().folder("投稿のファイル")
        XCTAssertFalse(plain.isChannelPosts)
        XCTAssertFalse(plain.isPosted)
        // Its step in a path: in a channel's drive, right under the root.
        let path = [DriveCrumb(id: "r", name: "m2-seminar"), DriveCrumb(id: "p", name: "投稿のファイル"), DriveCrumb(id: "m", name: "2026-10")]
        XCTAssertEqual(DriveRules.crumbs(path, kind: "channel").map(\.name), ["m2-seminar", tr("投稿のファイル"), "2026-10"])
        XCTAssertEqual(DriveRules.whereLabel(path, kind: "workspace"), tr("研究室ドライブ") + " › 投稿のファイル › 2026-10")
        let deeper = [DriveCrumb(id: "r", name: "m2-seminar"), DriveCrumb(id: "x", name: "資料"), DriveCrumb(id: "p", name: "投稿のファイル")]
        XCTAssertEqual(DriveRules.crumbs(deeper, kind: "channel").map(\.name), ["m2-seminar", "資料", "投稿のファイル"])
        // §19.4: a server that marks the step says so itself (the server's JSON).
        let detail = #"{"item":"# + json + #","path":[{"id":"r","name":"m2-seminar","system_role":null},{"id":"p","name":"投稿のファイル","system_role":"channel_posts"},{"id":"q","name":"投稿のファイル","system_role":null}],"location_kind":"channel"}"#
        let marked = try JSON.snakeDecoder.decode(DriveItemDetailOut.self, from: Data(detail.utf8))
        XCTAssertEqual(marked.path.map(\.systemRole), [nil, "channel_posts", nil])
        XCTAssertEqual(DriveRules.crumbs(marked.path, kind: "workspace").map(\.name), [tr("研究室ドライブ"), tr("投稿のファイル"), "投稿のファイル"])
    }

    func testAPostsLine() {
        let post = DrivePostOut(messageId: "m", channelId: "c", parentId: "p", senderId: "u", versionNumber: 1, postedAt: "2026-10-28T06:02:00Z")
        let line = ChannelFiles.postLine(post, sender: "三井", channel: "m2-seminar")
        XCTAssertTrue(line.hasPrefix("三井 · "))
        XCTAssertTrue(line.hasSuffix(tr("#\("m2-seminar")（スレッド）")))
        var top = post
        top.parentId = nil
        XCTAssertTrue(ChannelFiles.postLine(top, sender: "三井", channel: "m2-seminar").hasSuffix(" · #m2-seminar"))
        XCTAssertEqual(ChannelFiles.postLine(top, sender: "三井", channel: nil).components(separatedBy: " · ").count, 2)
    }

    func testTheCallsOnTheWire() async throws {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubProtocol.self]
        let client = ApiClient(baseUrl: URL(string: "http://server")!, session: URLSession(configuration: configuration))
        client.accessToken = "t"
        var asked: [String] = []
        StubProtocol.handler = { request in
            let body = request.httpBodyStream.map { stream -> String in
                stream.open()
                defer { stream.close() }
                var data = Data()
                var buffer = [UInt8](repeating: 0, count: 4096)
                while stream.hasBytesAvailable {
                    let read = stream.read(&buffer, maxLength: buffer.count)
                    if read <= 0 { break }
                    data.append(buffer, count: read)
                }
                return String(decoding: data, as: UTF8.self)
            } ?? request.httpBody.map { String(decoding: $0, as: UTF8.self) } ?? ""
            asked.append("\(request.httpMethod ?? "") \(request.url!.path)?\(request.url!.query ?? "") \(body)")
            let path = request.url!.path
            if path.hasSuffix("/drive-files") {
                return (200, Data(#"{"files":[{"attachment_id":"a","item_id":"i","state":"available","trash":true,"reason":null}]}"#.utf8))
            }
            if path.hasPrefix("/api/v1/messages/") { return (200, Data(ChannelFilesTests.message.utf8)) }
            if path.hasPrefix("/api/v1/channels/") {
                return (200, Data(#"{"id":"c","type":"public","name":"n","topic":null,"purpose":null,"archived":false,"created_by":null,"last_seq":0,"created_at":"x","updated_at":"x","dm_user_ids":null,"files_to_drive":null,"files_to_drive_effective":true}"#.utf8))
            }
            if path.hasSuffix("/restore") {
                return (200, Data(#"{"id":"i","location_id":"w","parent_id":"r","kind":"file","name":"f.pdf","size_bytes":1,"content_type":"application/pdf","content_modified_at":null,"created_by":null,"created_at":"x","updated_by":null,"updated_at":"x","version_count":1,"file":null,"link_count":0}"#.utf8))
            }
            return (200, Data(#"{"items":[],"next_cursor":null}"#.utf8))
        }
        let files = try await client.messageDriveFiles("m1")
        XCTAssertEqual(files.files.first?.trash, true)
        _ = try await client.deleteMessage(id: "m1", driveFiles: "keep")
        _ = try await client.deleteMessage(id: "m2")
        let channel = try await client.setChannelFilesToDrive(id: "c", value: nil)
        XCTAssertEqual(channel.filesToDriveEffective, true)
        _ = try await client.restoreDriveItem("i")
        _ = try await client.searchDrive(query: "q", locationId: nil, cursor: nil, origin: "uploads")
        _ = try await client.searchDrive(query: "q", locationId: nil, cursor: nil)
        XCTAssertEqual(asked[0], "GET /api/v1/messages/m1/drive-files? ")
        XCTAssertEqual(asked[1], "DELETE /api/v1/messages/m1?drive_files=keep ")
        XCTAssertEqual(asked[2], "DELETE /api/v1/messages/m2? ")
        XCTAssertEqual(asked[3], #"PATCH /api/v1/channels/c? {"files_to_drive":null}"#)
        XCTAssertTrue(asked[4].hasPrefix("POST /api/v1/drive/items/i/restore? "))
        XCTAssertEqual(asked[5], "GET /api/v1/search/drive?q=q&limit=50&origin=uploads&content=true ")
        XCTAssertEqual(asked[6], "GET /api/v1/search/drive?q=q&limit=50&content=true ")
    }

    func testOnlyWhoMayWriteTheChannelsDriveRestores() async {
        let api = FakeDriveApi()
        api.locations = [DriveLocationOut(id: "l1", kind: "channel", channelId: "c1", rootId: "r1", name: "a", canWrite: true),
                         DriveLocationOut(id: "l2", kind: "channel", channelId: "c2", rootId: "r2", name: "b", canWrite: false)]
        let hub = DriveHub(api: api)
        XCTAssertFalse(hub.canWriteChannelDrive("c1"))  // not read yet
        await hub.loadLocations()
        XCTAssertTrue(hub.canWriteChannelDrive("c1"))
        XCTAssertFalse(hub.canWriteChannelDrive("c2"))
        XCTAssertFalse(hub.canWriteChannelDrive("dm"))
    }

    /// The message's rows for a purged and a trashed file (light and dark), with the plain one above: no name, no
    /// picture, a thin outline (no coloured bar). Run with TEST_RUNNER_SNAPSHOT_DIR=<dir> to look at them.
    func testTheGoneFilesRows() throws {
        let controller = AppController()
        let message = try JSON.snakeDecoder.decode(MessageOut.self, from: Data(Self.message.utf8))
        var trashed = message.attachments[0]
        trashed.drive = AttachmentDriveOut(itemId: "i", versionId: "v", versionNumber: 1, state: "trashed")
        let view = AttachmentsView(attachments: [message.attachments[2], message.attachments[1], trashed], controller: controller, channelId: "c")
            .padding()
            .frame(width: 393, alignment: .leading)
        for style in [UIUserInterfaceStyle.light, .dark] {
            let host = UIHostingController(rootView: view)
            host.overrideUserInterfaceStyle = style
            host.view.backgroundColor = .systemBackground
            let size = host.sizeThatFits(in: CGSize(width: 393, height: 1000))
            host.view.frame = CGRect(origin: .zero, size: size)
            let window = UIWindow(frame: host.view.frame)
            window.rootViewController = host
            window.makeKeyAndVisible()
            host.view.layoutIfNeeded()
            RunLoop.current.run(until: Date().addingTimeInterval(0.3))
            let image = UIGraphicsImageRenderer(bounds: host.view.bounds).image { _ in
                _ = host.view.drawHierarchy(in: host.view.bounds, afterScreenUpdates: true)
            }
            window.isHidden = true
            XCTAssertGreaterThan(size.height, 60)
            if let dir = ProcessInfo.processInfo.environment["SNAPSHOT_DIR"], let data = image.pngData() {
                try data.write(to: URL(fileURLWithPath: dir).appendingPathComponent("channel-files-\(style == .dark ? "dark" : "light").png"))
            }
        }
    }
}

/// CF5 (docs/CHANNEL_FILES.md §12.4): files over the attachment limit from the composer go up into a drive and their
/// `/d/` links come into the draft.
@MainActor
final class ComposerDriveTests: XCTestCase {
    private func channel(_ type: String, own: Bool? = nil, archived: Bool = false) -> ChannelOut {
        ChannelOut(id: "c", type: type, name: "m2-seminar", topic: nil, purpose: nil, archived: archived, createdBy: nil, lastSeq: 0,
                   lastMessageAt: nil, createdAt: "", updatedAt: "", membership: nil, dmUserIds: nil, filesToDrive: own)
    }

    private func date(_ iso: String) -> Date { ISO8601DateFormatter().date(from: iso)! }

    func testWhereAFileOverTheLimitMayGo() {
        let on = WorkspaceSettings(channelFilesToDrive: true), off = WorkspaceSettings(channelFilesToDrive: false)
        XCTAssertEqual(ComposerDrive.plan(channel("public"), settings: on, driveAvailable: true), .channel(posts: true))
        XCTAssertEqual(ComposerDrive.plan(channel("private"), settings: on, driveAvailable: true), .channel(posts: true))
        XCTAssertEqual(ComposerDrive.plan(channel("public", own: true), settings: off, driveAvailable: true), .channel(posts: true))
        // The switch off: the channel drive's top (its members open the link there), not 「投稿のファイル」.
        XCTAssertEqual(ComposerDrive.plan(channel("public", own: false), settings: on, driveAvailable: true), .channel(posts: false))
        XCTAssertEqual(ComposerDrive.plan(channel("public"), settings: off, driveAvailable: true), .channel(posts: false))
        XCTAssertEqual(ComposerDrive.plan(channel("dm"), settings: on, driveAvailable: true), .myDrive)
        XCTAssertEqual(ComposerDrive.plan(channel("group_dm"), settings: off, driveAvailable: true), .myDrive)
        XCTAssertNil(ComposerDrive.plan(channel("public"), settings: on, driveAvailable: false), "no drive on the server")
        XCTAssertNil(ComposerDrive.plan(channel("dm"), settings: on, driveAvailable: false))
        XCTAssertNil(ComposerDrive.plan(channel("public", archived: true), settings: on, driveAvailable: true))
        // A server before CF1 files nothing into channel drives (their top, then); a DM still has マイドライブ.
        XCTAssertEqual(ComposerDrive.plan(channel("public"), settings: WorkspaceSettings(), driveAvailable: true), .channel(posts: false))
        XCTAssertEqual(ComposerDrive.plan(channel("dm"), settings: WorkspaceSettings(), driveAvailable: true), .myDrive)
    }

    func testTheMonthIsTheServersInTokyo() {
        XCTAssertEqual(ComposerDrive.monthName(date("2026-10-31T14:59:00Z")), "2026-10")
        XCTAssertEqual(ComposerDrive.monthName(date("2026-10-31T15:00:00Z")), "2026-11")
        XCTAssertEqual(ComposerDrive.monthName(date("2026-12-31T15:00:00Z")), "2027-01")
        XCTAssertEqual(ComposerDrive.monthName(date("2026-10-31T15:00:00Z"), zone: TimeZone(identifier: "UTC")!), "2026-10")
    }

    func testAWritableChannelDriveTakesItIntoThePostsFolderByItsRole() async throws {
        let api = FakeDriveApi()
        api.writable = ["c"]
        var albums = api.folder("albums-1", parent: "root-c")
        albums.systemRole = "albums"
        var named = api.folder("named", parent: "root-c")  // a plain folder under the stored name is not it
        named = DriveItemOut(id: named.id, locationId: named.locationId, parentId: named.parentId, kind: "folder", name: ChannelFiles.storedName)
        var posts = api.folder("posts-1", parent: "root-c")
        posts.systemRole = "channel_posts"
        api.children["root-c"] = [albums, named, api.folder("a"), posts]  // the special folder on the second page
        let resolved = try await ComposerDrive.resolve(.channel(posts: true), channel: channel("public"), api: api, now: date("2026-10-29T03:00:00Z"))
        XCTAssertEqual(resolved.destination, .channelPosts(channelName: "m2-seminar"))
        XCTAssertEqual(resolved.target, DriveUploadTarget(parentId: "posts-1", locationId: "loc-c",
                                                         label: "#m2-seminar › \(tr("投稿のファイル")) › 2026-10", relativeDir: "2026-10"))
        XCTAssertEqual(api.calls, ["resolve c", "children root-c name asc -", "children root-c name asc 2"])
    }

    /// No 「投稿のファイル」 yet (no file posted): the client cannot make the special folder, so the drive's top.
    func testWithoutThePostsFolderTheChannelDrivesTop() async throws {
        let api = FakeDriveApi()
        api.writable = ["c"]
        api.children["root-c"] = [api.folder("a")]
        let resolved = try await ComposerDrive.resolve(.channel(posts: true), channel: channel("private"), api: api)
        XCTAssertEqual(resolved.destination, .channelRoot(channelName: "m2-seminar"))
        XCTAssertEqual(resolved.target.parentId, "root-c")
        XCTAssertNil(resolved.target.relativeDir)
    }

    /// The switch off: the channel drive's top, without looking for 「投稿のファイル」.
    func testWithTheSwitchOffTheChannelDrivesTopUnlisted() async throws {
        let api = FakeDriveApi()
        api.writable = ["c"]
        var posts = api.folder("posts-1", parent: "root-c")
        posts.systemRole = "channel_posts"
        api.children["root-c"] = [posts]
        let resolved = try await ComposerDrive.resolve(.channel(posts: false), channel: channel("public", own: false), api: api)
        XCTAssertEqual(resolved.destination, .channelRoot(channelName: "m2-seminar"))
        XCTAssertEqual(resolved.target, DriveUploadTarget(parentId: "root-c", locationId: "loc-c", label: "#m2-seminar"))
        XCTAssertEqual(api.calls, ["resolve c"])
    }

    func testMyDriveForADmAndAChannelDriveINeedNotWrite() async throws {
        let api = FakeDriveApi()
        let readOnly = try await ComposerDrive.resolve(.channel(posts: true), channel: channel("public"), api: api)
        XCTAssertEqual(readOnly.destination, .myDrive(fromChannel: true))
        XCTAssertEqual(readOnly.target, DriveUploadTarget(parentId: "root-me", locationId: "loc-me", label: tr("マイドライブ")))
        XCTAssertEqual(api.calls, ["resolve c", "resolve me"], "a drive I cannot write to is not listed")
        let dmApi = FakeDriveApi()
        let dm = try await ComposerDrive.resolve(.myDrive, channel: channel("dm"), api: dmApi)
        XCTAssertEqual(dm.destination, .myDrive(fromChannel: false))
        XCTAssertEqual(dmApi.calls, ["resolve me"])
        XCTAssertTrue(ComposerDrive.explanation(dm.destination).contains(tr("ほかの人はリンクのファイルを開けません（ドライブで共有してください）。")))
        XCTAssertFalse(ComposerDrive.explanation(.channelPosts(channelName: "m2")).contains(tr("ほかの人はリンクのファイルを開けません（ドライブで共有してください）。")))
    }

    private func batch(_ id: String, account: String = "srv|me", composer: DriveUploadComposer?, jobs: [(String, DriveUploadState, String?, Bool?)]) -> DriveUploadBatch {
        DriveUploadBatch(id: id, serverUrl: "http://127.0.0.1:18766/", account: account, generation: 0,
                         target: DriveUploadTarget(parentId: "p", locationId: "l", label: "#m2"), createdAt: Date(),
                         jobs: jobs.map { name, state, item, linked in
                             var job = DriveUploadJob(id: "\(id)-\(name)", clientUploadId: "k-\(name)", name: name, size: 200_000_000, partsTotal: 12)
                             job.state = state
                             job.itemId = item
                             job.linked = linked
                             return job
                         },
                         composer: composer)
    }

    func testTheComposersRowsAndItsFinishedUploads() {
        let here = DriveUploadComposer(channelId: "c", parentId: nil)
        let batches = [
            batch("b1", composer: here, jobs: [("a.mov", .uploading, nil, nil), ("b.mov", .done, "i-b", nil), ("c.mov", .done, "i-c", true),
                                                ("d.mov", .cancelled, nil, nil), ("e.mov", .failed, nil, nil)]),
            batch("b2", composer: DriveUploadComposer(channelId: "c", parentId: "m1"), jobs: [("thread.mov", .done, "i-t", nil)]),
            batch("b3", composer: nil, jobs: [("drive.pdf", .done, "i-d", nil)]),
            batch("b4", account: "other|me", composer: here, jobs: [("theirs.mov", .done, "i-x", nil)]),
            // The share sheet's: posted by the processor, never put into a draft.
            batch("b5", composer: DriveUploadComposer(channelId: "c", parentId: nil, send: true), jobs: [("shared.mov", .done, "i-s", nil)]),
        ]
        XCTAssertEqual(ComposerDrive.rows(batches, account: "srv|me", composer: here).map(\.job.name), ["a.mov", "b.mov", "e.mov"])
        XCTAssertEqual(ComposerDrive.rows(batches, account: "srv|me", composer: DriveUploadComposer(channelId: "c", parentId: "m1")).map(\.job.name),
                       ["thread.mov"])
        XCTAssertTrue(ComposerDrive.rows(batches, account: nil, composer: here).isEmpty)
        XCTAssertEqual(ComposerDrive.finished(batches, account: "srv|me").map(\.job.name), ["b.mov", "thread.mov"])
    }

    func testTheLinkGoesAtTheEndOfTheDraftOnce() {
        let link = "http://127.0.0.1:18766/d/01a16063-9d83-753d-a072-1f33464eecfe"
        XCTAssertEqual(ComposerDrive.inserting(link, into: ""), link)
        XCTAssertEqual(ComposerDrive.inserting(link, into: "ゼミの録画です"), "ゼミの録画です\n" + link)
        XCTAssertEqual(ComposerDrive.inserting(link, into: "ゼミの録画です\n"), "ゼミの録画です\n" + link)
        XCTAssertEqual(ComposerDrive.inserting(link, into: "既に \(link) あり"), "既に \(link) あり")
    }

    func testFinishedUploadsPutTheirLinksIntoTheirDrafts() {
        let store = Store()
        store.setDraft("c") { $0.text = "録画を置きました" }
        let batches = [
            batch("b1", composer: DriveUploadComposer(channelId: "c", parentId: nil),
                  jobs: [("a.mov", .done, "01a16063-9d83-753d-a072-1f33464eecfe", nil), ("gone.mov", .done, nil, nil)]),
            batch("b2", composer: DriveUploadComposer(channelId: "c", parentId: "m1"), jobs: [("t.mov", .done, "00000000-0000-0000-0000-000000000001", nil)]),
        ]
        let unlinked = ComposerDrive.link(ComposerDrive.finished(batches, account: "srv|me"), store: store)
        XCTAssertEqual(unlinked, ["gone.mov"])
        XCTAssertEqual(store.draft("c").text, "録画を置きました\nhttp://127.0.0.1:18766/d/01a16063-9d83-753d-a072-1f33464eecfe")
        XCTAssertTrue(store.draft("c").isDirty, "the draft syncs to my other devices")
        XCTAssertEqual(store.draft("c", parentId: "m1").text, "http://127.0.0.1:18766/d/00000000-0000-0000-0000-000000000001")
        // Said again (another change before the mark is on disk): the link is not doubled.
        _ = ComposerDrive.link(ComposerDrive.finished(batches, account: "srv|me"), store: store)
        XCTAssertEqual(store.draft("c", parentId: "m1").text, "http://127.0.0.1:18766/d/00000000-0000-0000-0000-000000000001")
    }

    func testTheQuestionNamesTheFilesAndOffersTheSmallerCopyOnlyForVideos() {
        let resolved = ComposerDrive.Resolved(target: DriveUploadTarget(parentId: "p", locationId: "l", label: "#m2"),
                                              destination: .channelPosts(channelName: "m2"))
        var offer = ComposerDriveOffer(resolved: resolved)
        offer.add(.file(URL(fileURLWithPath: "/tmp/a.mov")), name: "a.mov", size: 150_000_000, video: URL(fileURLWithPath: "/tmp/x/a.mov"))
        XCTAssertTrue(offer.allVideos)
        offer.add(.file(URL(fileURLWithPath: "/tmp/b.zip")), name: "b.zip", size: 50_000_000, video: nil)
        XCTAssertFalse(offer.allVideos)
        XCTAssertEqual(offer.sources.count, 2)
        XCTAssertTrue(offer.message.contains("a.mov\nb.zip"))
        XCTAssertTrue(offer.message.contains(ComposerDrive.explanation(resolved.destination)))
    }
}
