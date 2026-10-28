import ImageIO
import UIKit
import UniformTypeIdentifiers
import XCTest
@testable import ChikuwaChat

/// AL3 (docs/ALBUMS.md §18.4): an album server in memory.
@MainActor
final class FakeAlbumApi: AlbumApi {
    var album = AlbumOut(folderId: "al", photoCount: 0)
    var photos: [DriveItemOut] = []
    var pageSize = 2
    var error: Error?
    var lists: [AlbumListEntryOut] = []
    var listError: Error?
    private(set) var calls: [String] = []

    func albums(locationId: String?, cursor: String?) async throws -> AlbumListOut {
        calls.append("albums \(locationId ?? "-") \(cursor ?? "-")")
        if let listError { throw listError }
        let start = Int(cursor ?? "0") ?? 0
        let page = Array(lists.dropFirst(start).prefix(pageSize))
        return AlbumListOut(items: page, nextCursor: start + pageSize < lists.count ? String(start + pageSize) : nil)
    }

    func album(_ folderId: String, sort: AlbumSort?, descending: Bool?, cursor: String?) async throws -> AlbumDetailOut {
        calls.append("album \(folderId) \(sort?.rawValue ?? "-") \(descending.map { $0 ? "desc" : "asc" } ?? "-") \(cursor ?? "-")")
        if let error { throw error }
        let start = Int(cursor ?? "0") ?? 0
        let page = Array(photos.dropFirst(start).prefix(pageSize))
        let folder = DriveItemOut(id: folderId, locationId: "ws", parentId: "root", kind: "folder", name: "学会", album: album)
        return AlbumDetailOut(folder: folder, album: album, path: [DriveCrumb(id: "root", name: "研究室ドライブ")], locationKind: "workspace",
                              canWrite: true, items: page, nextCursor: start + pageSize < photos.count ? String(start + pageSize) : nil,
                              folderCount: 1, otherCount: 2)
    }

    func createAlbum(_ draft: AlbumDraft, clientOpId: String) async throws -> AlbumCreatedOut {
        calls.append("create \(draft.name) \(draft.locationId ?? "-")")
        let folder = DriveItemOut(id: "new", locationId: draft.locationId ?? "ws", kind: "folder", name: draft.name)
        return AlbumCreatedOut(folder: folder, album: AlbumOut(folderId: "new"))
    }

    func addToAlbum(_ folderId: String, attachmentIds: [String], itemIds: [String], clientOpId: String) async throws -> AlbumAddOut {
        calls.append("add \(folderId) \(attachmentIds.joined(separator: ","))")
        return AlbumAddOut(results: attachmentIds.map { AlbumAddResult(sourceId: $0, ok: true, action: "copied") })
    }
}

func photo(_ id: String, taken: String? = nil, modified: String? = nil, created: String = "2026-10-01T00:00:00Z", type: String = "image/jpeg",
           thumbnail: Bool = true, durationMs: Int? = nil) -> DriveItemOut {
    DriveItemOut(id: id, locationId: "ws", parentId: "al", kind: "file", name: "\(id).jpg", sizeBytes: 1000, contentType: type,
                 contentModifiedAt: modified, createdAt: created, updatedAt: created, versionCount: 1,
                 file: DriveFileOut(attachmentId: "a-\(id)", versionId: "v-\(id)", hasThumbnail: thumbnail && !type.hasPrefix("video/"),
                                    hasPoster: type.hasPrefix("video/"), durationMs: durationMs, takenAt: taken, hasLocation: false,
                                    hasDisplay: thumbnail && !type.hasPrefix("video/")))
}

@MainActor
final class AlbumRulesTests: XCTestCase {
    private var tokyo: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "Asia/Tokyo")!
        return calendar
    }
    private let now = ISO8601DateFormatter().date(from: "2026-10-29T03:00:00Z")!

    func testTheGridIsHeadedByCaptureDayInTheDevicesZone() {
        let items = [
            photo("1", taken: "2026-09-16T09:12:00+09:00"),
            photo("2", taken: "2026-09-16T23:30:00+09:00"),
            // 15:30 UTC on the 16th is the 17th in Tokyo.
            photo("3", taken: "2026-09-16T15:30:00Z"),
            // No capture time: the file's own time, then when it was added.
            photo("4", modified: "2026-09-17T10:00:00+09:00"),
            photo("5", created: "2025-03-01T01:00:00Z"),
        ]
        let sections = AlbumRules.sections(items, sort: .taken, now: now, calendar: tokyo)
        XCTAssertEqual(sections.map(\.id), ["2026-09-16", "2026-09-17", "2025-03-01"])
        XCTAssertEqual(sections.map { $0.items.map(\.id) }, [["1", "2"], ["3", "4"], ["5"]])
        XCTAssertEqual(sections[0].title, "9月16日（水）")
        XCTAssertEqual(sections[2].title, "2025年3月1日（土）")
    }

    func testOtherOrdersHaveNoHeadingsAndADayComingTwiceKeepsDistinctIds() {
        let items = [photo("1", taken: "2026-09-16T09:00:00+09:00"), photo("2", taken: "2026-09-17T09:00:00+09:00"),
                     photo("3", taken: "2026-09-16T10:00:00+09:00")]
        XCTAssertEqual(AlbumRules.sections(items, sort: .name, calendar: tokyo).map(\.id), ["all"])
        XCTAssertNil(AlbumRules.sections(items, sort: .added, calendar: tokyo).first?.title)
        XCTAssertEqual(AlbumRules.sections(items, sort: .taken, now: now, calendar: tokyo).map(\.id), ["2026-09-16", "2026-09-17", "2026-09-16#1"])
        XCTAssertEqual(AlbumRules.sections([], sort: .taken), [])
    }

    func testTheDatesAreTheEventsElseThePhotosRange() {
        var album = AlbumOut(folderId: "a", startsOn: "2026-09-16", endsOn: "2026-09-19",
                             takenFrom: "2026-09-15T09:00:00+09:00", takenTo: "2026-09-20T09:00:00+09:00", photoCount: 312, videoCount: 8)
        XCTAssertEqual(AlbumRules.dateRange(album, calendar: tokyo), "2026/9/16〜9/19")
        XCTAssertEqual(AlbumRules.summary(album, calendar: tokyo), "312 枚 · 動画 8 本 · 2026/9/16〜9/19")
        album.endsOn = nil
        XCTAssertEqual(AlbumRules.dateRange(album, calendar: tokyo), "2026/9/16")
        album.startsOn = nil
        XCTAssertEqual(AlbumRules.dateRange(album, calendar: tokyo), "2026/9/15〜9/20")
        album.takenTo = "2027-01-02T09:00:00+09:00"
        XCTAssertEqual(AlbumRules.dateRange(album, calendar: tokyo), "2026/9/15〜2027/1/2")
        album.takenFrom = nil
        XCTAssertNil(AlbumRules.dateRange(album, calendar: tokyo))
        album.videoCount = 0
        XCTAssertEqual(AlbumRules.summary(album, calendar: tokyo), "312 枚")
    }

    func testThreeColumnsOnAPhoneMoreOnAnIPadAndTheDuosInnerScreen() {
        XCTAssertEqual(AlbumRules.columns(width: 402), 3)
        XCTAssertEqual(AlbumRules.columns(width: 466), 3)   // iPhone Duo outside
        XCTAssertEqual(AlbumRules.columns(width: 669), 5)   // iPhone Duo inside, held upright (the phone layout)
        XCTAssertEqual(AlbumRules.columns(width: 1032), 6)  // iPad 13" detail column
        XCTAssertEqual(AlbumRules.columns(width: 2000), 8)
    }

    func testAMessagesPhotosAndVideosStillThere() {
        func attachment(_ id: String, _ type: String, thumbnail: Bool = true, state: String? = nil) -> AttachmentOut {
            AttachmentOut(id: id, filename: id, contentType: type, sizeBytes: 1, width: nil, height: nil, hasThumbnail: thumbnail,
                          status: "attached", createdAt: "", drive: state.map { AttachmentDriveOut(itemId: "i", state: $0) })
        }
        let all = [attachment("p", "image/jpeg"), attachment("v", "video/mp4", thumbnail: false), attachment("pdf", "application/pdf", thumbnail: true),
                   attachment("heic", "image/heic", thumbnail: false), attachment("gone", "image/png", state: "trashed"),
                   attachment("purged", "image/png", state: "deleted"), attachment("moved", "image/png", state: "moved")]
        XCTAssertEqual(AlbumRules.messageMedia(all).map(\.id), ["p", "v", "heic", "moved"])
    }

    func testANewAlbumFromAMessageIsNamedByItsChannelAndDay() {
        XCTAssertEqual(AlbumRules.defaultName(channelName: "学会", postedAt: "2026-09-16T01:00:00Z", calendar: tokyo), "#学会 2026-09-16")
        XCTAssertEqual(AlbumRules.defaultName(channelName: nil, postedAt: "2026-09-16T20:00:00Z", calendar: tokyo), "2026-09-17")
    }

    func testTheConversationsDriveComesFirstAndOnlyWritablePlaces() {
        func entry(_ id: String, _ location: String) -> AlbumListEntryOut {
            AlbumListEntryOut(folder: DriveItemOut(id: id, locationId: location, kind: "folder", name: id), album: AlbumOut(folderId: id),
                              path: [], locationKind: "workspace")
        }
        let entries = [entry("a", "ws"), entry("b", "ch"), entry("c", "readonly"), entry("d", "ch")]
        let picked = AlbumRules.pickable(entries, writable: { $0 != "readonly" }, channelLocationId: "ch")
        XCTAssertEqual(picked.map(\.id), ["b", "d", "a"])
        XCTAssertEqual(AlbumRules.pickable(entries, writable: { _ in true }, channelLocationId: nil).map(\.id), ["a", "b", "c", "d"])
    }

    func testTheNoticeAfterAddingSaysWhatFailed() {
        let ok = AlbumAddResult(sourceId: "1", ok: true, action: "moved")
        let failed = AlbumAddResult(sourceId: "2", ok: false, error: "attachment_not_found")
        XCTAssertEqual(AlbumRules.addedNotice(AlbumAddOut(results: [ok, ok]), album: "学会"), "2 枚をアルバム「学会」に追加しました")
        XCTAssertEqual(AlbumRules.addedNotice(AlbumAddOut(results: [ok, failed]), album: "学会"), "1 枚をアルバム「学会」に追加しました（1 枚は追加できませんでした）")
        XCTAssertEqual(AlbumRules.addedNotice(AlbumAddOut(results: [failed]), album: "学会"), "アルバムに追加できませんでした")
    }

    func testTheListChoiceIsKeptPerAlbum() {
        let defaults = UserDefaults(suiteName: "AlbumRulesTests")!
        defaults.removePersistentDomain(forName: "AlbumRulesTests")
        XCTAssertFalse(AlbumListPreference.showsList("a", defaults: defaults))
        AlbumListPreference.set("a", list: true, defaults: defaults)
        AlbumListPreference.set("b", list: true, defaults: defaults)
        AlbumListPreference.set("a", list: false, defaults: defaults)
        XCTAssertFalse(AlbumListPreference.showsList("a", defaults: defaults))
        XCTAssertTrue(AlbumListPreference.showsList("b", defaults: defaults))
    }

    func testSavingSaysHowManyAndWhenItIsNotAllowed() {
        XCTAssertEqual(PhotoLibrarySaver.message(.saved(3, failed: 0)), "3 件を写真アプリに保存しました")
        XCTAssertEqual(PhotoLibrarySaver.message(.saved(2, failed: 1)), "2 件を写真アプリに保存しました（1 件は保存できませんでした）")
        XCTAssertEqual(PhotoLibrarySaver.message(.saved(0, failed: 2)), "写真アプリに保存できませんでした")
        XCTAssertTrue(PhotoLibrarySaver.message(.denied).contains("写真を追加のみ"))
    }
}

@MainActor
final class SlideshowRulesTests: XCTestCase {
    private let items = [photo("1"), photo("v", type: "video/mp4", durationMs: 12_000), photo("2"), photo("heic", type: "image/heic", thumbnail: false),
                         photo("long", type: "video/quicktime", durationMs: 600_000), photo("3")]

    func testInOrderFromTheChosenPhotoWrappingRound() {
        XCTAssertEqual(SlideshowRules.sequence(items, skipVideos: false, random: false).map(\.id), ["1", "v", "2", "long", "3"])
        XCTAssertEqual(SlideshowRules.sequence(items, skipVideos: false, random: false, start: "2").map(\.id), ["2", "long", "3", "1", "v"])
        XCTAssertEqual(SlideshowRules.sequence(items, skipVideos: true, random: false).map(\.id), ["1", "2", "3"])
        // A HEIC without a thumbnail or display size is left out (nothing to show).
        XCTAssertEqual(SlideshowRules.sequence(items, skipVideos: true, random: true, shuffle: { $0.reversed() }).map(\.id), ["3", "2", "1"])
    }

    func testAPhotoStaysTheIntervalAVideoToItsEndAtMostAMinute() {
        XCTAssertEqual(SlideshowRules.duration(items[0], interval: 5), 5)
        XCTAssertEqual(SlideshowRules.duration(items[1], interval: 5), 12)
        XCTAssertEqual(SlideshowRules.duration(items[4], interval: 5), 60)
        XCTAssertEqual(SlideshowRules.duration(photo("x", type: "video/mp4"), interval: 3), 60)
    }

    func testStepsWrapAndTheNextTwoAreReadAhead() {
        XCTAssertEqual(SlideshowRules.next(4, count: 5), 0)
        XCTAssertEqual(SlideshowRules.previous(0, count: 5), 4)
        XCTAssertEqual(SlideshowRules.ahead(3, count: 5), [4, 0])
        XCTAssertEqual(SlideshowRules.ahead(0, count: 2), [1])
        XCTAssertEqual(SlideshowRules.ahead(0, count: 1), [])
        XCTAssertEqual(SlideshowRules.next(0, count: 0), 0)
    }
}

@MainActor
final class AlbumModelTests: XCTestCase {
    func testPagesAndAReloadKeepsWhatWasScrolledTo() async {
        let api = FakeAlbumApi()
        api.photos = (1...5).map { photo("\($0)") }
        let model = AlbumModel(folderId: "al", api: api)
        await model.load()
        XCTAssertEqual(model.items?.map(\.id), ["1", "2"])
        XCTAssertEqual(model.detail?.canWrite, true)
        XCTAssertEqual(model.detail?.folderCount, 1)
        await model.loadMore()
        XCTAssertEqual(model.items?.count, 4)
        await model.load()
        XCTAssertEqual(model.items?.map(\.id), ["1", "2", "3", "4"])
        XCTAssertEqual(api.calls.suffix(2), ["album al - - -", "album al - - 2"])
        await model.loadAll()
        XCTAssertEqual(model.items?.count, 5)
        XCTAssertNil(model.nextCursor)
    }

    func testTheAlbumsOwnOrderUnlessChosenHere() async {
        let api = FakeAlbumApi()
        api.album = AlbumOut(folderId: "al", sort: "name", sortOrder: "desc")
        let model = AlbumModel(folderId: "al", api: api)
        await model.load()
        XCTAssertEqual(model.shownSort, .name)
        XCTAssertTrue(model.shownDescending)
        model.sort = .taken
        model.descending = false
        await model.load()
        XCTAssertEqual(api.calls.last, "album al taken asc -")
        XCTAssertEqual(model.shownSort, .taken)
    }

    func testNoLongerAnAlbumOrGone() async {
        let api = FakeAlbumApi()
        api.photos = [photo("1")]
        let model = AlbumModel(folderId: "al", api: api)
        await model.load()
        api.error = ApiError.api(status: 404, code: "drive_album_not_found", message: "")
        await model.load()
        XCTAssertEqual(model.gone, .notAlbum)
        XCTAssertNotNil(model.items)
        api.error = ApiError.api(status: 404, code: "drive_item_not_found", message: "")
        await model.load()
        XCTAssertEqual(model.gone, .gone)
        XCTAssertNil(model.items)
        XCTAssertEqual(model.rootId, "root")
    }

    func testAFailureFirstShowsWhyAndALaterOneKeepsThePhotos() async {
        let api = FakeAlbumApi()
        api.error = ApiError.network(URLError(.notConnectedToInternet))
        let model = AlbumModel(folderId: "al", api: api)
        await model.load()
        XCTAssertNotNil(model.failure)
        api.error = nil
        api.photos = [photo("1")]
        await model.load()
        XCTAssertNil(model.failure)
        api.error = ApiError.network(URLError(.timedOut))
        await model.load()
        XCTAssertEqual(model.items?.map(\.id), ["1"])
        XCTAssertNil(model.failure)
    }

    func testASignalReadsAgainOnceAfterTheLast() async throws {
        AlbumModel.reloadDelay = .milliseconds(30)
        defer { AlbumModel.reloadDelay = .milliseconds(300) }
        let api = FakeAlbumApi()
        let model = AlbumModel(folderId: "al", api: api)
        model.reloadSoon()
        model.reloadSoon()
        model.reloadSoon()
        try await Task.sleep(for: .milliseconds(200))
        XCTAssertEqual(api.calls.filter { $0.hasPrefix("album") }.count, 1)
    }

    func testTheListPagesAndAnOldServerHasNoAlbums() async {
        let api = FakeAlbumApi()
        api.lists = (1...3).map { AlbumListEntryOut(folder: DriveItemOut(id: "f\($0)", locationId: "ws", kind: "folder", name: "\($0)"),
                                                     album: AlbumOut(folderId: "f\($0)"), path: [], locationKind: "workspace") }
        let list = AlbumListModel(api: api)
        await list.load()
        XCTAssertEqual(list.available, true)
        XCTAssertEqual(list.entries?.count, 2)
        await list.loadMore()
        XCTAssertEqual(list.entries?.map(\.id), ["f1", "f2", "f3"])
        api.listError = ApiError.api(status: 404, code: "not_found", message: "")
        let old = AlbumListModel(api: api)
        await old.load()
        XCTAssertEqual(old.available, false)
        XCTAssertNil(old.failure)
    }

    func testAnAlbumsBandCountsThePicksNotStagedYet() {
        let center = DriveUploadCenter(processor: nil)
        XCTAssertNil(center.progress(parentId: "al", account: "a"))
        center.expect(300, parentId: "al")
        XCTAssertEqual(center.progress(parentId: "al", account: "a")?.total, 300)
        XCTAssertEqual(center.progress(parentId: "al", account: "a")?.done, 0)
        center.expect(-300, parentId: "al")
        XCTAssertNil(center.progress(parentId: "al", account: "a"))
    }
}

@MainActor
final class AlbumDecodingTests: XCTestCase {
    func testTheAlbumScreensAnswer() throws {
        let json = """
        {"folder": {"id": "f", "location_id": "l", "parent_id": "p", "kind": "folder", "name": "学会", "created_at": "", "updated_at": "",
                    "version_count": 0, "link_count": 0,
                    "album": {"folder_id": "f", "description": "名古屋", "cover": {"item_id": "i1", "attachment_id": "a1"}, "cover_item_id": null,
                              "sort": "taken", "sort_order": "asc", "starts_on": "2026-09-16", "ends_on": null, "taken_from": null, "taken_to": null,
                              "photo_count": 2, "video_count": 1, "size_bytes": 1234, "preview_attachment_ids": ["a1"], "created_by": null,
                              "created_at": "2026-10-29T00:00:00Z", "updated_at": "2026-10-29T00:00:00Z"}},
         "album": {"folder_id": "f", "description": "", "cover": null, "cover_item_id": null, "sort": "name", "sort_order": "desc",
                   "starts_on": null, "ends_on": null, "taken_from": null, "taken_to": null, "photo_count": 0, "video_count": 0,
                   "size_bytes": 0, "preview_attachment_ids": [], "created_by": null, "created_at": "", "updated_at": ""},
         "path": [{"id": "r", "name": "研究室ドライブ"}], "location_kind": "workspace", "can_write": false,
         "items": [{"id": "i1", "location_id": "l", "parent_id": "f", "kind": "file", "name": "IMG_1.jpg", "created_at": "", "updated_at": "",
                    "version_count": 1, "link_count": 0,
                    "file": {"attachment_id": "a1", "version_id": "v1", "width": 4032, "height": 3024, "has_thumbnail": true, "has_poster": false,
                             "duration_ms": null, "preview": null, "taken_at": "2026-09-16T09:12:00+09:00", "has_location": true,
                             "has_display": true, "display_width": 2048, "display_height": 1536}}],
         "next_cursor": null, "folder_count": 0, "other_count": 3, "shared_above": 0}
        """
        let out = try JSON.snakeDecoder.decode(AlbumDetailOut.self, from: Data(json.utf8))
        XCTAssertTrue(out.folder.isAlbum)
        XCTAssertEqual(out.folder.album?.cover?.attachmentId, "a1")
        XCTAssertEqual(out.album.sort, "name")
        XCTAssertEqual(out.items.first?.file?.takenAt, "2026-09-16T09:12:00+09:00")
        XCTAssertEqual(out.items.first?.file?.hasLocation, true)
        XCTAssertEqual(out.items.first?.file?.displayWidth, 2048)
        XCTAssertEqual(out.otherCount, 3)
    }

    func testAnOlderServersItemsAndAttachments() throws {
        let item = try JSON.snakeDecoder.decode(DriveItemOut.self, from: Data("""
        {"id": "f", "location_id": "l", "kind": "folder", "name": "x", "created_at": "", "updated_at": "", "version_count": 0, "link_count": 0}
        """.utf8))
        XCTAssertFalse(item.isAlbum)
        let attachment = try JSON.snakeDecoder.decode(AttachmentOut.self, from: Data("""
        {"id": "a", "filename": "x.jpg", "content_type": "image/jpeg", "size_bytes": 1, "width": null, "height": null, "has_thumbnail": true,
         "status": "attached", "created_at": ""}
        """.utf8))
        XCTAssertFalse(attachment.hasDisplay)
    }
}

final class PhotoTranscodeTests: XCTestCase {
    private func folder() throws -> URL {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("transcode-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    private func image() -> CGImage {
        UIGraphicsImageRenderer(size: CGSize(width: 40, height: 30), format: { let f = UIGraphicsImageRendererFormat(); f.scale = 1; return f }())
            .image { context in UIColor.red.setFill(); context.fill(CGRect(x: 0, y: 0, width: 40, height: 30)) }.cgImage!
    }

    private func write(_ type: UTType, to url: URL) -> Bool {
        guard let out = CGImageDestinationCreateWithURL(url as CFURL, type.identifier as CFString, 1, nil) else { return false }
        let properties: [CFString: Any] = [
            kCGImagePropertyOrientation: 6,
            kCGImagePropertyExifDictionary: [kCGImagePropertyExifDateTimeOriginal: "2026:09:16 09:12:00"],
            kCGImagePropertyGPSDictionary: [kCGImagePropertyGPSLatitude: 35.17, kCGImagePropertyGPSLatitudeRef: "N",
                                           kCGImagePropertyGPSLongitude: 136.88, kCGImagePropertyGPSLongitudeRef: "E"],
        ]
        CGImageDestinationAddImage(out, image(), properties as CFDictionary)
        return CGImageDestinationFinalize(out)
    }

    func testAJpegGoesAsItIs() throws {
        let url = try folder().appendingPathComponent("IMG_1.JPG")
        XCTAssertTrue(write(.jpeg, to: url))
        let out = try XCTUnwrap(PhotoTranscode.uploadable(url))
        XCTAssertEqual(out.url, url)
        XCTAssertEqual(out.name, "IMG_1.jpg")
    }

    func testAHeicBecomesAJpegKeepingItsTimeLocationAndOrientation() throws {
        let url = try folder().appendingPathComponent("IMG_2.HEIC")
        guard write(.heic, to: url) else { throw XCTSkip("no HEIC encoder here") }
        let out = try XCTUnwrap(PhotoTranscode.uploadable(url))
        XCTAssertEqual(out.name, "IMG_2.jpg")
        XCTAssertFalse(FileManager.default.fileExists(atPath: url.path))
        let source = try XCTUnwrap(CGImageSourceCreateWithURL(out.url as CFURL, nil))
        XCTAssertEqual(CGImageSourceGetType(source) as String?, UTType.jpeg.identifier)
        let properties = try XCTUnwrap(CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any])
        let exif = properties[kCGImagePropertyExifDictionary] as? [CFString: Any]
        XCTAssertEqual(exif?[kCGImagePropertyExifDateTimeOriginal] as? String, "2026:09:16 09:12:00")
        XCTAssertNotNil(properties[kCGImagePropertyGPSDictionary])
        XCTAssertEqual(properties[kCGImagePropertyOrientation] as? Int, 6)
    }

    func testNoImageAtAll() throws {
        let url = try folder().appendingPathComponent("notes.txt")
        try Data("hello".utf8).write(to: url)
        XCTAssertNil(PhotoTranscode.uploadable(url))
    }
}

@MainActor
final class AlbumViewerTests: XCTestCase {
    func testAZoomPastTheDisplaySizesPixelsAsksForTheOriginal() {
        let page = ImagePageView(frame: CGRect(x: 0, y: 0, width: 400, height: 800))
        page.layoutIfNeeded()
        // A 2048 × 1536 display size on a 400 pt screen at 3x: 1200 px shown, enough until zoomed past ~1.7x.
        let display = UIGraphicsImageRenderer(size: CGSize(width: 2048, height: 1536), format: { let f = UIGraphicsImageRendererFormat(); f.scale = 1; return f }())
            .image { _ in }
        page.state = .shown(display)
        XCTAssertFalse(page.needsMorePixels(screenScale: 3))
        page.scrollView.setZoomScale(1.5, animated: false)
        XCTAssertFalse(page.needsMorePixels(screenScale: 3))
        page.scrollView.setZoomScale(2.5, animated: false)
        XCTAssertTrue(page.needsMorePixels(screenScale: 3))
        // The original of the same shape replaces it where it is (the zoom stays).
        let original = UIGraphicsImageRenderer(size: CGSize(width: 4032, height: 3024), format: { let f = UIGraphicsImageRendererFormat(); f.scale = 1; return f }())
            .image { _ in }
        page.upgrade(original)
        XCTAssertEqual(page.imageView.image?.size.width, 4032)
        XCTAssertEqual(page.scrollView.zoomScale, 2.5, accuracy: 0.01)
        XCTAssertFalse(page.needsMorePixels(screenScale: 3))
    }
}
