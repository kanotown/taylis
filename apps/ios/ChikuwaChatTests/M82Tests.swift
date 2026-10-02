import XCTest
@testable import ChikuwaChat

/// M82 (the phone half of M79): video tiles from the server's size, length and poster; older servers as before.
@MainActor
final class M82Tests: XCTestCase {
    private func video(width: Int? = nil, height: Int? = nil, hasPoster: Bool = false, durationMs: Int? = nil,
                       sizeBytes: Int64 = 1_992_294) -> AttachmentOut {
        AttachmentOut(id: "v", filename: "clip.mp4", contentType: "video/mp4", sizeBytes: sizeBytes, width: width, height: height,
                      hasThumbnail: false, status: "attached", createdAt: "", hasPoster: hasPoster, durationMs: durationMs)
    }

    // MARK: decoding

    func testAnOldServersAttachmentDecodesWithoutPosterOrLength() throws {
        let json = #"{"id":"v","filename":"clip.mp4","content_type":"video/mp4","size_bytes":1024,"width":null,"height":null,"#
            + #""has_thumbnail":false,"status":"attached","created_at":"2026-10-02T00:00:00Z"}"#
        let old = try JSON.snakeDecoder.decode(AttachmentOut.self, from: Data(json.utf8))
        XCTAssertFalse(old.hasPoster)
        XCTAssertNil(old.durationMs)
        XCTAssertTrue(old.isVideo)
        XCTAssertFalse(old.isImage)
        let model = VideoTileModel(attachment: old)
        XCTAssertFalse(model.fetchesPoster)
        XCTAssertTrue(model.readsVideoOnDevice(posterFailed: false)) // as before M82: the device's copy, if any
        XCTAssertEqual(model.box(), VideoFit.unknown)
        XCTAssertEqual(model.caption, "1 KB")
    }

    func testANewServersVideoDecodesItsPosterLengthAndSize() throws {
        let json = #"{"id":"v","filename":"clip.mov","content_type":"video/quicktime","size_bytes":1992294,"width":1080,"height":1920,"#
            + #""has_thumbnail":false,"has_poster":true,"duration_ms":42000,"status":"attached","created_at":"2026-10-02T00:00:00Z"}"#
        let new = try JSON.snakeDecoder.decode(AttachmentOut.self, from: Data(json.utf8))
        XCTAssertTrue(new.hasPoster)
        XCTAssertEqual(new.durationMs, 42000)
        XCTAssertFalse(new.isImage) // has_thumbnail stays false for videos; a poster never makes it a photo
        XCTAssertTrue(new.showsServerPoster)
        // Kept as it came through the store's snapshot (the cache of a conversation).
        let again = try JSON.snakeDecoder.decode(AttachmentOut.self, from: JSON.snakeEncoder.encode(new))
        XCTAssertEqual(again, new)
        let plain = try JSON.plainDecoder.decode(AttachmentOut.self, from: JSON.plainEncoder.encode(new))
        XCTAssertEqual(plain, new)
    }

    // MARK: tile model

    func testTheTileHasTheServersShapeFromTheFirstLayout() {
        let portrait = VideoTileModel(attachment: video(width: 1080, height: 1920, hasPoster: true))
        XCTAssertEqual(portrait.box(), CGSize(width: 135, height: 240))
        // Nothing found later (a poster's or the file's size, a remembered one) moves the box the server gave.
        XCTAssertEqual(portrait.box(found: CGSize(width: 1920, height: 1080), remembered: CGSize(width: 1, height: 1)), CGSize(width: 135, height: 240))
        // Without the server's size: what this device found, else what it remembered, else the old landscape box.
        let unknown = VideoTileModel(attachment: video())
        XCTAssertEqual(unknown.shape(found: CGSize(width: 720, height: 720), remembered: CGSize(width: 1080, height: 1920)), CGSize(width: 720, height: 720))
        XCTAssertEqual(unknown.shape(remembered: CGSize(width: 1080, height: 1920)), CGSize(width: 1080, height: 1920))
        XCTAssertEqual(unknown.box(), VideoFit.unknown)
        XCTAssertEqual(VideoTileModel(attachment: video(width: 0, height: 0)).box(), VideoFit.unknown)
    }

    func testThePosterComesFromTheServerAndTheDeviceOnlyFallsBack() {
        let withPoster = VideoTileModel(attachment: video(width: 1920, height: 1080, hasPoster: true))
        XCTAssertTrue(withPoster.fetchesPoster)
        XCTAssertFalse(withPoster.readsVideoOnDevice(posterFailed: false))
        XCTAssertTrue(withPoster.readsVideoOnDevice(posterFailed: true)) // the poster did not load
        let without = VideoTileModel(attachment: video(width: 1920, height: 1080))
        XCTAssertFalse(without.fetchesPoster)
        XCTAssertTrue(without.readsVideoOnDevice(posterFailed: false))
        // has_poster on something that is no video (it should not happen) does not make a video tile fetch it.
        let file = AttachmentOut(id: "f", filename: "a.pdf", contentType: "application/pdf", sizeBytes: 1, width: nil, height: nil,
                                 hasThumbnail: false, status: "attached", createdAt: "", hasPoster: true)
        XCTAssertFalse(file.showsServerPoster)
    }

    func testTheLengthReadsAsOnDesktop() {
        XCTAssertNil(VideoDuration.text(nil))
        XCTAssertNil(VideoDuration.text(-5))
        XCTAssertEqual(VideoDuration.text(0), "0:00")
        XCTAssertEqual(VideoDuration.text(1), "0:01") // more than nothing, under a second
        XCTAssertEqual(VideoDuration.text(400), "0:01")
        XCTAssertEqual(VideoDuration.text(7_000), "0:07")
        XCTAssertEqual(VideoDuration.text(7_499), "0:07")
        XCTAssertEqual(VideoDuration.text(7_500), "0:08")
        XCTAssertEqual(VideoDuration.text(59_600), "1:00")
        XCTAssertEqual(VideoDuration.text(754_000), "12:34")
        XCTAssertEqual(VideoDuration.text(3_723_000), "1:02:03")
        XCTAssertEqual(VideoTileModel(attachment: video(durationMs: 42_000)).caption, "0:42 · 1.9 MB")
        XCTAssertEqual(VideoTileModel(attachment: video()).caption, "1.9 MB")
    }

    // MARK: message.updated (change = "attachments")

    func testALaterPosterReplacesTheMessageAndAnUnknownChangeDoesToo() async throws {
        let server = FakeServer()
        let alice = server.addUser("alice")
        let bob = server.addUser("bob")
        let channel = server.createChannel("動画", ownerId: alice.id)
        server.join(channel.id, bob.id)
        let store = Store()
        var options = EngineOptions()
        options.reconnectMin = 0
        options.sleep = { _ in }
        options.random = { 0.5 }
        let engine = SyncEngine(api: server.api(for: bob.id), connect: server.connector(for: bob.id), wsUrl: URL(string: "ws://fake")!, store: store,
                                getAccessToken: { "token" }, options: options)
        engine.isActive = { false }
        await engine.start()
        await engine.openChannel(channel.id)
        await settle(engine)

        let (post, _) = try server.post(channelId: channel.id, senderId: alice.id, body: "撮った", attachmentIds: ["v"])
        await settle(engine)
        XCTAssertEqual(store.message(channel.id, id: post.id)?.attachments.first?.hasPoster, false)

        let probed = video(width: 1080, height: 1920, hasPoster: true, durationMs: 7_000)
        let updated = try XCTUnwrap(server.setAttachments(channelId: channel.id, messageId: post.id, [probed]))
        await settle(engine)
        XCTAssertEqual(store.message(channel.id, id: post.id)?.attachments, [probed])
        XCTAssertEqual(store.channel(channel.id)?.syncedSeq, updated.updatedSeq)

        // A change this build does not know is still just the whole message, replaced.
        let later = video(width: 1080, height: 1920, hasPoster: true, durationMs: 8_000)
        let newer = try XCTUnwrap(server.setAttachments(channelId: channel.id, messageId: post.id, [later], change: "something_new"))
        await settle(engine)
        XCTAssertEqual(store.message(channel.id, id: post.id)?.attachments, [later])
        XCTAssertEqual(store.channel(channel.id)?.syncedSeq, newer.updatedSeq)
        XCTAssertEqual(engine.status, .online)
        engine.stop()
    }

    private func settle(_ engine: SyncEngine) async {
        for _ in 0..<50 {
            await engine.idle()
            await Task.yield()
        }
    }
}
