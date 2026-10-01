import SwiftUI
import UIKit
import XCTest
@testable import ChikuwaChat

final class LinksTests: XCTestCase {
    func testFirstLinkOutsideCodeWithTrailingPunctuationTrimmed() {
        XCTAssertEqual(Links.first(in: "see https://example.com/a?b=1, then https://other.test"), "https://example.com/a?b=1")
        XCTAssertEqual(Links.first(in: "日本語の文 https://example.com/x。"), "https://example.com/x")
        XCTAssertEqual(Links.first(in: "(https://example.com/paren)"), "https://example.com/paren")
        XCTAssertNil(Links.first(in: "`https://code.example.com` and ```\nhttps://fenced.example.com\n``` none"))
        XCTAssertNil(Links.first(in: "no links here"))
        XCTAssertEqual(Links.first(in: "[label](https://example.com/md)"), "https://example.com/md")
    }
}

/// A row keeps its height while what it shows comes in (testers, 2026-10-01: opening a conversation, the rows jumped as
/// link cards and photos arrived and grew their rows). The row asks for its link's preview itself (audit 2026-09-30: the
/// card's own task never ran) and holds the card's frame until it comes; a photo holds its recorded shape.
@MainActor
final class LinkPreviewRowTests: XCTestCase {
    private var window: UIWindow?
    private var host: UIHostingController<AnyView>?

    override func tearDown() {
        window?.isHidden = true
        window = nil
        host = nil
        StubProtocol.handler = nil
    }

    private static let python = #"""
        {"url":"https://www.python.org/","status":"ok","title":"Welcome to Python.org","description":"The official home",
         "image_url":null,"site_name":"Python.org","fetched_at":"2026-09-30T00:00:00Z"}
        """#

    private func controller() -> AppController {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubProtocol.self]
        let api = ApiClient(baseUrl: URL(string: "http://server")!, session: URLSession(configuration: configuration))
        api.accessToken = "a"
        let controller = AppController(defaults: UserDefaults(suiteName: "link-preview-\(UUID().uuidString)")!)
        controller.api = api
        controller.store.setMe(UserMe(id: "me", username: "kano", displayName: "Kano", role: "member", deactivatedAt: nil, createdAt: "", updatedAt: "",
                                      email: nil, mustChangePassword: false))
        return controller
    }

    private func message(_ body: String, attachments: [AttachmentOut] = []) -> MessageState {
        var message = MessageState(placeholderFor: "k1", channelId: "c1", senderId: "me", body: body, createdAt: "2026-09-30T10:50:00Z")
        message.id = "m1"
        message.seq = 1
        message.updatedSeq = 1
        message.pending = false
        message.attachments = attachments
        return message
    }

    /// The view's height in a window, as in the conversation (in a stack with other rows: hosted alone, the empty card
    /// still ran its task).
    private func show<Content: View>(_ view: Content, width: CGFloat = 393) -> () -> CGFloat {
        let size = CGSize(width: width, height: 700)
        let scene = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first
        let window = scene.map { UIWindow(windowScene: $0) } ?? UIWindow(frame: CGRect(origin: .zero, size: size))
        window.frame = CGRect(origin: .zero, size: size)
        let host = UIHostingController(rootView: AnyView(VStack(alignment: .leading, spacing: 0) {
            Text("above")
            view
            Text("below")
            Spacer()
        }))
        window.rootViewController = host
        window.makeKeyAndVisible()
        self.window = window
        self.host = host
        host.view.frame = window.bounds
        host.view.layoutIfNeeded()
        let fits = CGSize(width: size.width, height: UIView.layoutFittingCompressedSize.height)
        return {
            host.view.layoutIfNeeded()
            return host.sizeThatFits(in: fits).height
        }
    }

    private func spin(_ seconds: TimeInterval = 0.3, until done: () -> Bool = { true }) {
        let deadline = Date().addingTimeInterval(3)
        while !done() && Date() < deadline { RunLoop.current.run(until: Date().addingTimeInterval(0.05)) }
        RunLoop.current.run(until: Date().addingTimeInterval(seconds))
    }

    func testTheRowAsksForItsLinksPreviewAndHoldsTheCardsFrameUntilItComes() throws {
        let link = "https://www.python.org/"
        var asked: [String] = []
        StubProtocol.handler = { request in
            guard request.url?.path == "/api/v1/link-previews" else { return (404, Data(#"{"detail":"Not Found"}"#.utf8)) }
            let url = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "url" }?.value
            DispatchQueue.main.async { asked.append(url ?? "") }
            return (200, Data(Self.python.utf8))
        }
        let controller = controller()
        let plain = show(MessageRow(message: message("Python の公式サイト"), controller: controller).equatable())()
        let height = show(MessageRow(message: message("Python の公式サイト \(link)"), controller: controller).equatable())
        let before = height()
        XCTAssertNil(controller.linkPreviews[link], "measured before the preview came")

        spin(until: { controller.linkPreviews[link] != nil })

        XCTAssertEqual(asked, [link], "the row asks the server for its link's preview, once")
        XCTAssertEqual(controller.linkPreviews[link]??.title, "Welcome to Python.org")
        XCTAssertGreaterThan(before, plain + 60, "the card's frame is under the message from the start")
        XCTAssertEqual(height(), before, accuracy: 0.5, "the card fills the frame: the row does not grow")
    }

    func testARowLeavingTheScreenDoesNotCancelThePreviewAnotherRowWaitsFor() throws {
        // The landing scrolls the newest rows away: the row that asked first goes, another with the same link stays.
        let link = "https://www.python.org/"
        var asks = 0
        StubProtocol.handler = { _ in
            DispatchQueue.main.async { asks += 1 }
            Thread.sleep(forTimeInterval: 0.3)
            return (200, Data(Self.python.utf8))
        }
        let controller = controller()
        let first = Task { await controller.loadLinkPreview(link) }
        spin(0.1)
        let second = Task { await controller.loadLinkPreview(link) }
        first.cancel()
        spin(until: { controller.linkPreviews[link] != nil })
        XCTAssertEqual(controller.linkPreviewSlot(link), .card(try XCTUnwrap(controller.linkPreviews[link] ?? nil)))
        XCTAssertEqual(controller.linkPreviews[link]??.title, "Welcome to Python.org")
        XCTAssertEqual(asks, 1, "one request for both rows")
        second.cancel()
    }

    func testAPageWithoutAPreviewLeavesNoCardAndIsNotAskedAgain() throws {
        let link = "https://example.com/plain"
        var asks = 0
        StubProtocol.handler = { _ in
            DispatchQueue.main.async { asks += 1 }
            return (200, Data(#"{"url":"https://example.com/plain","status":"failed","title":null,"description":null,"image_url":null,"site_name":null,"fetched_at":"2026-09-30T00:00:00Z"}"#.utf8))
        }
        let controller = controller()
        let plain = show(MessageRow(message: message("見て"), controller: controller).equatable())()
        let height = show(MessageRow(message: message("見て \(link)"), controller: controller).equatable())
        spin(until: { controller.linkPreviews[link] != nil })
        XCTAssertEqual(controller.linkPreviewSlot(link), .none)
        XCTAssertLessThan(height(), plain + 30, "no card")
        Task { await controller.loadLinkPreview(link) }
        spin()
        XCTAssertEqual(asks, 1)
    }

    func testAPhotoHoldsItsRecordedShapeWhileItLoads() throws {
        // A 1600 × 900 photo: its thumbnail comes in after the row was laid out.
        let thumbnail = UIGraphicsImageRenderer(size: CGSize(width: 400, height: 225)).pngData { context in
            UIColor.orange.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 400, height: 225))
        }
        var served = 0
        StubProtocol.handler = { request in
            guard request.url?.path.hasSuffix("/thumbnail") == true else { return (404, Data()) }
            Thread.sleep(forTimeInterval: 0.3)
            DispatchQueue.main.async { served += 1 }
            return (200, thumbnail)
        }
        let photo = AttachmentOut(id: "a1", filename: "wide.png", contentType: "image/png", sizeBytes: 1000, width: 1600, height: 900,
                                  hasThumbnail: true, status: "ready", createdAt: "2026-09-30T00:00:00Z")
        let controller = controller()
        let height = show(MessageRow(message: message("写真", attachments: [photo]), controller: controller).equatable())
        let before = height()
        XCTAssertEqual(served, 0, "measured while loading")
        spin(until: { served > 0 })
        XCTAssertEqual(height(), before, accuracy: 0.5, "the photo fills the frame it had while loading")
        XCTAssertEqual(ImageFit.box(16.0 / 9.0), CGSize(width: 280, height: 157.5))
    }
}

final class LinkPreviewSlotTests: XCTestCase {
    private let preview = LinkPreviewOut(url: "https://a.test/", status: "ok", title: "A", description: nil, imageUrl: nil, siteName: nil,
                                         fetchedAt: "2026-09-30T00:00:00Z")

    func testTheSlotIsTheCardItsFrameOrNothing() {
        XCTAssertEqual(LinkPreviewSlot.of(.some(preview), failed: false), .card(preview))
        XCTAssertEqual(LinkPreviewSlot.of(.some(preview), failed: true), .card(preview), "a kept card stays when asking again fails")
        XCTAssertEqual(LinkPreviewSlot.of(.some(nil), failed: false), .none)
        XCTAssertEqual(LinkPreviewSlot.of(nil, failed: false), .placeholder)
        XCTAssertEqual(LinkPreviewSlot.of(nil, failed: true), .none, "offline: no frame that stays empty")
    }

    func testAKeptPreviewIsAskedForAgainAfterTheServersOwnCacheTime() {
        let now = Date(timeIntervalSince1970: 1_000_000_000)
        XCTAssertTrue(LinkPreviewSlot.stale(savedAt: nil, ok: true, now: now))
        XCTAssertFalse(LinkPreviewSlot.stale(savedAt: now.addingTimeInterval(-6 * 86400), ok: true, now: now))
        XCTAssertTrue(LinkPreviewSlot.stale(savedAt: now.addingTimeInterval(-8 * 86400), ok: true, now: now))
        XCTAssertFalse(LinkPreviewSlot.stale(savedAt: now.addingTimeInterval(-3600), ok: false, now: now))
        XCTAssertTrue(LinkPreviewSlot.stale(savedAt: now.addingTimeInterval(-2 * 86400), ok: false, now: now))
    }

    func testTheCardIsOneHeightWhateverThePageGivesAndWhileItComes() {
        let full = LinkPreviewOut(url: "https://a.test/", status: "ok", title: String(repeating: "とても長い題名 ", count: 10),
                                  description: String(repeating: "長い説明文です。", count: 20), imageUrl: "https://a.test/i.png",
                                  siteName: "A site", fetchedAt: "")
        let bare = LinkPreviewOut(url: "https://a.test/", status: "ok", title: "A", description: nil, imageUrl: nil, siteName: nil, fetchedAt: "")
        for size in [DynamicTypeSize.small, .large, .accessibility1] {
            let heights = [full, bare, nil].map { preview in
                let host = UIHostingController(rootView: LinkPreviewCard(preview: preview, url: "https://a.test/").dynamicTypeSize(size))
                return host.sizeThatFits(in: CGSize(width: 320, height: UIView.layoutFittingCompressedSize.height)).height
            }
            XCTAssertEqual(heights[0], heights[1], accuracy: 0.5, "\(size)")
            XCTAssertEqual(heights[0], heights[2], accuracy: 0.5, "\(size): the frame while it comes")
        }
    }

    @MainActor
    func testPreviewsAreKeptWithTheAccountButAFailedRequestIsNot() throws {
        let path = FileManager.default.temporaryDirectory.appendingPathComponent("previews-\(UUID().uuidString).db").path
        defer { for suffix in ["", "-wal", "-shm"] { try? FileManager.default.removeItem(atPath: path + suffix) } }
        let persistence = try SQLitePersistence(db: SQLiteDatabase(path: path))
        defer { persistence.close() }
        let writer = Store(persistence: persistence)
        writer.setLinkPreview("https://a.test/", preview)
        writer.setLinkPreview("https://none.test/", nil)
        writer.setLinkPreviewFailed("https://offline.test/")
        XCTAssertFalse(writer.linkPreviewWanted("https://a.test/"))
        XCTAssertFalse(writer.linkPreviewWanted("https://offline.test/"), "not again this session")
        XCTAssertTrue(writer.linkPreviewWanted("https://new.test/"))

        let reader = Store(persistence: persistence)
        reader.load()
        XCTAssertEqual(reader.linkPreviews["https://a.test/"], .some(preview))
        XCTAssertEqual(reader.linkPreviews["https://none.test/"], .some(nil))
        XCTAssertNil(reader.linkPreviews["https://offline.test/"])
        XCTAssertTrue(reader.linkPreviewWanted("https://offline.test/"), "asked again after a restart")
        XCTAssertTrue(reader.linkPreviewWanted("https://a.test/", now: Date().addingTimeInterval(8 * 86400)))
    }

    @MainActor
    func testOnlyTheNewestPreviewsStay() throws {
        let path = FileManager.default.temporaryDirectory.appendingPathComponent("previews-\(UUID().uuidString).db").path
        defer { for suffix in ["", "-wal", "-shm"] { try? FileManager.default.removeItem(atPath: path + suffix) } }
        let persistence = try SQLitePersistence(db: SQLiteDatabase(path: path))
        defer { persistence.close() }
        let writer = Store(persistence: persistence)
        let start = Date()
        for i in 0..<(LinkPreviewSlot.kept + 3) { writer.setLinkPreview("https://\(i).test/", nil, at: start.addingTimeInterval(Double(i))) }
        let reader = Store(persistence: persistence)
        reader.load()
        XCTAssertEqual(reader.linkPreviews.count, LinkPreviewSlot.kept)
        XCTAssertNil(reader.linkPreviews["https://0.test/"])
        XCTAssertNotNil(reader.linkPreviews["https://\(LinkPreviewSlot.kept + 2).test/"])
        XCTAssertEqual(try persistence.loadAll().meta.keys.filter { $0.hasPrefix(Store.previewPrefix) }.count, LinkPreviewSlot.kept)
    }
}

@MainActor
final class VideoSizesTests: XCTestCase {
    private var saved: UserDefaults!

    override func setUp() {
        saved = VideoSizes.defaults
        VideoSizes.defaults = UserDefaults(suiteName: "video-sizes-\(UUID().uuidString)")!
        VideoSizes.reset()
    }

    override func tearDown() {
        VideoSizes.defaults = saved
        VideoSizes.reset()
    }

    func testAVideosShapeIsKnownAgainAfterARestart() {
        VideoSizes.note("v1", CGSize(width: 1080, height: 1920))
        VideoSizes.reset() // a new launch
        XCTAssertEqual(VideoSizes.size("v1"), CGSize(width: 1080, height: 1920))
        XCTAssertNil(VideoSizes.size("v2"))
    }

    func testOnlyTheNewestShapesStay() {
        for i in 0..<(VideoSizes.kept + 2) { VideoSizes.note("v\(i)", CGSize(width: 16, height: 9)) }
        VideoSizes.note("v0", CGSize(width: 9, height: 16)) // gone already: noted again as the newest
        VideoSizes.reset()
        XCTAssertNil(VideoSizes.size("v1"))
        XCTAssertNil(VideoSizes.size("v2"))
        XCTAssertEqual(VideoSizes.size("v0"), CGSize(width: 9, height: 16))
        XCTAssertEqual(VideoSizes.size("v\(VideoSizes.kept + 1)"), CGSize(width: 16, height: 9))
    }
}
