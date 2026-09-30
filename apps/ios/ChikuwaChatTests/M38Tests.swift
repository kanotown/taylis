import AVFoundation
import SwiftUI
import UIKit
import XCTest
@testable import ChikuwaChat

/// M38 (testers, 2026-09-30): quotes within the row, my own DM status, the home avatar's badge, videos in their shape
/// and closed with a swipe.
@MainActor
final class M38Tests: XCTestCase {
    // MARK: 1. message bodies stay within the row

    private func fittedSize(_ text: String, width: CGFloat, size: DynamicTypeSize = .large) -> CGSize {
        let host = UIHostingController(rootView: MessageBodyView(text: text, users: [:]).dynamicTypeSize(size))
        return host.sizeThatFits(in: CGSize(width: width, height: .greatestFiniteMagnitude))
    }

    func testQuotesWrapWithinTheRowAndKeepEveryLine() {
        let jp = "これはとても長い日本語の引用文です。引用の中の文章が画面の右端を越えて切れてしまうことがあるという報告があったので、折り返されるかどうかを確認するための文章を書いています。"
        let en = "This is a very long English quotation that should wrap within the width of the message row instead of running past the right edge."
        for size in [DynamicTypeSize.large, .xxxLarge] {
            for body in [jp, en, jp + " " + en] {
                let quote = fittedSize("> " + body, width: 280, size: size)
                let plain = fittedSize(body, width: 280, size: size)
                XCTAssertLessThanOrEqual(quote.width, 280.5, "\(size) \(body.prefix(8))")
                // Narrower by the bar, so at least as tall as the same text unquoted: no line is cut off.
                XCTAssertGreaterThanOrEqual(quote.height + 0.5, plain.height, "\(size) \(body.prefix(8))")
            }
        }
        let url = "> https://example.com/a/very/long/path/that/keeps/going/and/going/without/any/spaces/whatsoever/index.html"
        XCTAssertLessThanOrEqual(fittedSize(url, width: 280).width, 280.5)
        let code = "```\nlet averyveryverylongidentifier = someFunctionCall(withAnArgument: 1, andAnotherArgument: 2)\n```"
        XCTAssertLessThanOrEqual(fittedSize(code, width: 280).width, 280.5)
    }

    /// Whether a glyph is cut off at the body's right edge: a line longer than the width is drawn up to its last pixel
    /// column and no further (a line that fits keeps at least a side bearing's half point clear of it).
    private func inkAtRightEdge(_ text: String, width: CGFloat, size: DynamicTypeSize) -> Bool {
        let view = MessageBodyView(text: text, users: [:]).frame(width: width)
            .background(Color.white).environment(\.colorScheme, .light).dynamicTypeSize(size)
        let renderer = ImageRenderer(content: view)
        renderer.scale = 2
        guard let image = renderer.cgImage, let data = image.dataProvider?.data, let bytes = CFDataGetBytePtr(data) else {
            XCTFail("not rendered"); return false
        }
        let perPixel = image.bitsPerPixel / 8
        return (0..<image.height).contains { y in
            let pixel = bytes + y * image.bytesPerRow + (image.width - 1) * perPixel
            return pixel[0] < 200 || pixel[1] < 200 || pixel[2] < 200
        }
    }

    /// A table pasted from a chat keeps its tabs: SwiftUI's Text put the part after a tab at the tab stop but broke the
    /// line as if it were not there, and 「約 29 億」 ran past the right edge (tester, 2026-09-30, thread, text one size
    /// smaller than the default).
    func testTabbedLinesWrapWithinTheRow() {
        let rows = [["生成 (出力)", "約 2,400 万", "約 760 万", "約 3,150 万"],
                    ["新規に読んだ文脈 (キャッシュ書き込み)", "約 6,200 万", "約 9,000 万", "約 1.5 億"],
                    ["キャッシュからの再読み込み", "約 52 億", "約 29 億", "約 81 億"],
                    ["応答回数", "9,973", "12,538", "22,511"]]
        let prose = "ログに残っている使用量を足し合わせた概算です。このセッション 1 本 (9/25〜今日) と、そこから起動したサブエージェント 103 本分。"
        for width in stride(from: CGFloat(300), through: 340, by: 2) {
            XCTAssertFalse(inkAtRightEdge("> " + prose, width: width, size: .medium), "prose \(width)") // the check itself
        }
        for separator in ["\t", " \t", "\t\t"] {
            let table = rows.map { $0.joined(separator: separator) }
            for body in [table.map { "> " + $0 }.joined(separator: "\n"), table.joined(separator: "\n")] {
                for size in [DynamicTypeSize.medium, .large] {
                    for width in stride(from: CGFloat(300), through: 340, by: 2) {
                        XCTAssertFalse(inkAtRightEdge(body, width: width, size: size), "\(size) \(width) \(separator.debugDescription) \(body.prefix(4))")
                    }
                }
            }
        }
    }

    func testTableCellsWrapAtTheirCap() {
        XCTAssertEqual(CappedWidth.width(offered: nil, max: 200), 200) // a sideways scroll view offers any width
        XCTAssertEqual(CappedWidth.width(offered: .infinity, max: 200), 200)
        XCTAssertEqual(CappedWidth.width(offered: 120, max: 200), 120)
        XCTAssertEqual(CappedWidth.width(offered: 500, max: 200), 200)
        let table = "| 列A | 列B | とても長い列ヘッダーの名前 |\n|---|---|---|\n| 1 | 二 | これはとても長いセルの内容で横にはみ出すかもしれません |"
        // Two short columns and a wrapped long one fit in a phone's row: nothing to scroll.
        XCTAssertLessThanOrEqual(fittedSize(table, width: 300).width, 300.5)
    }

    // MARK: 3. my own DM row shows my status

    private func dm(_ id: String, _ users: [String]) -> ChannelState {
        let out = ChannelOut(id: id, type: users.count > 2 ? "group_dm" : "dm", name: nil, topic: nil, purpose: nil, archived: false, createdBy: nil,
                             lastSeq: 0, lastMessageAt: nil, createdAt: "2026-01-01T00:00:00Z", updatedAt: "", membership: nil, dmUserIds: users,
                             readState: nil, notification: nil)
        return ChannelState(channel: out, isMember: true, syncedSeq: nil, lastSeq: 0, lastReadSeq: 0, unreadCount: 0, mentionCount: 0, hasOlder: true)
    }

    func testDMRowStatusIsTheOtherPersonsOrMineWithMyself() {
        XCTAssertEqual(DMList.statusUserId(dm("a", ["me", "a"]), meId: "me"), "a")
        XCTAssertEqual(DMList.statusUserId(dm("notes", ["me"]), meId: "me"), "me")
        XCTAssertEqual(DMList.statusUserId(dm("notes", []), meId: "me"), "me")
        XCTAssertNil(DMList.statusUserId(dm("group", ["me", "a", "b"]), meId: "me"))
    }

    // MARK: 4. the home avatar's badge

    func testHomeAvatarBadgeShowsPresenceWhileConnectedElseTheConnection() {
        XCTAssertEqual(HomeAvatarBadge.of(status: .online, presence: "online", dnd: false), .online)
        XCTAssertEqual(HomeAvatarBadge.of(status: .online, presence: "away", dnd: false), .away)
        XCTAssertEqual(HomeAvatarBadge.of(status: .online, presence: "online", dnd: true), .dnd)
        XCTAssertEqual(HomeAvatarBadge.of(status: .online, presence: "offline", dnd: false), .none) // hidden presence
        // The offline indication the green dot gave is kept.
        XCTAssertEqual(HomeAvatarBadge.of(status: .offline, presence: "online", dnd: true), .offline)
        XCTAssertEqual(HomeAvatarBadge.of(status: .connecting, presence: "online", dnd: false), .connecting)
        XCTAssertTrue(HomeAvatarBadge.offline.disconnected)
        XCTAssertFalse(HomeAvatarBadge.away.disconnected)
        XCTAssertEqual(HomeAvatarBadge.of(status: .idle, presence: "online", dnd: false), .none)
    }

    // MARK: 5. videos

    func testVideoBoxKeepsTheVideosShape() {
        XCTAssertEqual(VideoFit.box(for: nil), CGSize(width: 240, height: 135)) // unknown: the old landscape box
        XCTAssertEqual(VideoFit.box(for: CGSize(width: 1920, height: 1080)), CGSize(width: 240, height: 135))
        XCTAssertEqual(VideoFit.box(for: CGSize(width: 1080, height: 1920)), CGSize(width: 135, height: 240)) // portrait
        XCTAssertEqual(VideoFit.box(for: CGSize(width: 720, height: 720)), CGSize(width: 240, height: 240))
        XCTAssertEqual(VideoFit.box(for: CGSize(width: 120, height: 90)), CGSize(width: 240, height: 180)) // small: as large as allowed
        XCTAssertEqual(VideoFit.box(for: CGSize(width: 100, height: 1000)), CGSize(width: 110, height: 240)) // very tall: kept wide enough
        XCTAssertEqual(VideoFit.box(for: CGSize(width: 3000, height: 100)), CGSize(width: 240, height: 90))
        XCTAssertEqual(VideoFit.box(for: CGSize(width: 0, height: 100)), VideoFit.unknown)
    }

    func testVideoShapeFromTheServerAndFromTheTrack() {
        let recorded = AttachmentOut(id: "v", filename: "v.mp4", contentType: "video/mp4", sizeBytes: 1, width: 1080, height: 1920,
                                     hasThumbnail: false, status: "attached", createdAt: "")
        XCTAssertEqual(VideoFit.recorded(recorded), CGSize(width: 1080, height: 1920))
        let unknown = AttachmentOut(id: "v", filename: "v.mp4", contentType: "video/mp4", sizeBytes: 1, width: nil, height: nil,
                                    hasThumbnail: true, status: "attached", createdAt: "")
        XCTAssertNil(VideoFit.recorded(unknown))
        XCTAssertFalse(unknown.isImage) // a video with a poster is still a video
        // A phone's portrait video: stored landscape, turned a quarter.
        let turned = VideoFit.displaySize(natural: CGSize(width: 1920, height: 1080), transform: CGAffineTransform(rotationAngle: .pi / 2))
        XCTAssertEqual(turned.width, 1080, accuracy: 0.5)
        XCTAssertEqual(turned.height, 1920, accuracy: 0.5)
        XCTAssertEqual(VideoFit.displaySize(natural: CGSize(width: 640, height: 360), transform: .identity), CGSize(width: 640, height: 360))
    }

    func testVideoClosesUpOrDownOnlyWithThePhotoViewersRelease() {
        XCTAssertEqual(ViewerDismiss.videoAxis(motion: CGPoint(x: 2, y: 14)), .vertical)
        XCTAssertEqual(ViewerDismiss.videoAxis(motion: CGPoint(x: -3, y: -14)), .vertical)
        XCTAssertNil(ViewerDismiss.videoAxis(motion: CGPoint(x: 14, y: 2))) // sideways: the player's timeline
        XCTAssertNil(ViewerDismiss.videoAxis(motion: .zero))
        XCTAssertTrue(ViewerDismiss.shouldClose(offset: 200, velocity: 0, extent: 800))
        XCTAssertTrue(ViewerDismiss.shouldClose(offset: -40, velocity: -1200, extent: 800)) // a flick up
        XCTAssertFalse(ViewerDismiss.shouldClose(offset: 60, velocity: 0, extent: 800))
    }

    func testVideoTrackSizeIsReadFromAFile() async throws {
        // A 2×4 frame movie written here: the header gives a portrait size.
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("m38-\(UUID().uuidString).mov")
        let writer = try AVAssetWriter(outputURL: url, fileType: .mov)
        let input = AVAssetWriterInput(mediaType: .video, outputSettings: [AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: 64, AVVideoHeightKey: 128])
        let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA, kCVPixelBufferWidthKey as String: 64, kCVPixelBufferHeightKey as String: 128])
        writer.add(input)
        XCTAssertTrue(writer.startWriting())
        writer.startSession(atSourceTime: .zero)
        var buffer: CVPixelBuffer?
        CVPixelBufferCreate(nil, 64, 128, kCVPixelFormatType_32BGRA, nil, &buffer)
        while !input.isReadyForMoreMediaData { try await Task.sleep(nanoseconds: 10_000_000) }
        XCTAssertTrue(adaptor.append(try XCTUnwrap(buffer), withPresentationTime: .zero))
        input.markAsFinished()
        await writer.finishWriting()
        defer { try? FileManager.default.removeItem(at: url) }
        let size = await VideoFit.naturalSize(of: url)
        XCTAssertEqual(size, CGSize(width: 64, height: 128))
    }
}
