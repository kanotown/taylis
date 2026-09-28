import SwiftUI
import UIKit
import XCTest
@testable import ChikuwaChat

/// M25: older pages load by themselves at the top of a conversation, and the reader's place is kept (OlderPaging).
@MainActor
final class OlderPagingTests: XCTestCase {
    /// A confirmed row as the server sends it: its rowKey (client_msg_id) is not its id (§10.3).
    private func row(_ seq: Int) -> MessageState {
        var message = MessageState(placeholderFor: "cmid-\(seq)", channelId: "c", senderId: "alice", body: "m\(seq)", createdAt: "2026-09-28T01:00:00Z")
        message.id = "id-\(seq)"
        message.seq = seq
        message.updatedSeq = seq
        message.pending = false
        return message
    }

    private func channel(hasOlder: Bool = true, synced: Int? = 120) -> ChannelState {
        let out = ChannelOut(id: "c", type: "public", name: "general", topic: nil, purpose: nil, archived: false, createdBy: nil, lastSeq: 120,
                             lastMessageAt: nil, createdAt: "", updatedAt: "", membership: nil, dmUserIds: nil)
        return ChannelState(channel: out, isMember: true, syncedSeq: synced, lastSeq: 120, hasOlder: hasOlder, oldestLoadedSeq: hasOlder ? 71 : 0)
    }

    private let top = CGRect(x: 0, y: 8, width: 369, height: 36) // the progress row, at rest at the top
    private let height: CGFloat = 638

    private func loads(_ channel: ChannelState? = nil, topRow: CGRect?? = nil, status: EngineStatus? = .online, focused: Bool = false,
                       placed: Bool = true, landing: Bool = false, busy: Bool = false, moving: Bool = false) -> Bool {
        OlderPaging.shouldLoad(channel ?? self.channel(), topRow: topRow ?? top, viewportHeight: height, status: status, focused: focused,
                               placed: placed, landing: landing, busy: busy, moving: moving)
    }

    func testTheTopRowOnScreenLoadsTheOlderPage() {
        XCTAssertTrue(loads())
        XCTAssertTrue(loads(topRow: CGRect(x: 0, y: -30, width: 369, height: 36))) // a few points of it are enough
    }

    func testNothingLoadsUntilTheTopRowIsReallyOnScreen() {
        // A list opened at the bottom of a full window: LazyVStack has not built the row, or built it above the screen.
        XCTAssertFalse(loads(topRow: .some(nil)))
        XCTAssertFalse(loads(topRow: CGRect(x: 0, y: -240, width: 369, height: 36)))
        XCTAssertFalse(loads(topRow: CGRect(x: 0, y: 700, width: 369, height: 36)))
        XCTAssertFalse(OlderPaging.shouldLoad(channel(), topRow: top, viewportHeight: 0, status: .online, focused: false, placed: true,
                                              landing: false, busy: false, moving: false)) // no layout yet
    }

    func testNotUnderTheReadersFingerNorWhileLandingOrBeforeThePlacement() {
        XCTAssertFalse(loads(moving: true))  // dragging or gliding: once it rests
        XCTAssertFalse(loads(landing: true)) // §10.1 4./6.: the landing on the first unread row goes first
        XCTAssertFalse(loads(placed: false)) // §10.1 4.: the placement may still be waiting for a catch-up
        XCTAssertFalse(loads(busy: true))    // a load (or 「最初の未読へ」) on its way, or the last one brought nothing
    }

    func testOnlyForTheNormalConversationWithAnOlderPageToRead() {
        XCTAssertFalse(loads(focused: true)) // the search context has its own rows
        XCTAssertFalse(loads(channel(hasOlder: false)))
        XCTAssertFalse(loads(channel(synced: nil))) // the window's newest page has not been read (§7.3)
        XCTAssertFalse(loads(status: .offline))
        XCTAssertFalse(loads(status: .connecting))
        XCTAssertFalse(OlderPaging.shouldLoad(nil, topRow: top, viewportHeight: height, status: .online, focused: false, placed: true,
                                              landing: false, busy: false, moving: false))
    }

    func testTheKeptRowIsTheTopmostShownInFullAndItsAnchorPutsItBack() throws {
        let rows = [row(71), row(72), row(73), row(74)]
        let frames: [String: CGRect] = [
            "id-71": CGRect(x: 0, y: -40, width: 369, height: 60),   // cut by the top edge
            "id-72": CGRect(x: 0, y: 20, width: 369, height: 87),
            "id-73": CGRect(x: 0, y: 107, width: 369, height: 50),
            "id-74": CGRect(x: 0, y: 900, width: 369, height: 50),   // built below the screen
        ]
        let kept = try XCTUnwrap(OlderPaging.keptRow(frames, rows: rows, viewportHeight: height))
        XCTAssertEqual(kept.rowKey, "cmid-72") // scrolled to by its list key, found by its id (§10.3)
        XCTAssertEqual(kept.rowId, "id-72")
        XCTAssertEqual(kept.minY, 20)
        XCTAssertEqual(kept.anchorY * (height - 87), 20, accuracy: 0.001)
    }

    func testTheRowThatWasFirstIsKeptOnlyWhenNoOtherCanBe() throws {
        // The page's last row may take its name and time away: the row below it is kept instead, so that change stays
        // above the reader's place (seen on the simulator: the rows below moved up by that line, 21 pt).
        let rows = [row(71), row(72)]
        let frames: [String: CGRect] = ["id-71": CGRect(x: 0, y: 60, width: 369, height: 130), "id-72": CGRect(x: 0, y: 190, width: 369, height: 87)]
        let kept = try XCTUnwrap(OlderPaging.keptRow(frames, rows: rows, viewportHeight: height, regrouped: "id-71"))
        XCTAssertEqual(kept.rowKey, "cmid-72")
        XCTAssertEqual(kept.anchorY * (height - 87), 190, accuracy: 0.001)
        let alone = try XCTUnwrap(OlderPaging.keptRow(["id-71": frames["id-71"]!], rows: rows, viewportHeight: height, regrouped: "id-71"))
        XCTAssertEqual(alone.rowKey, "cmid-71")
    }

    func testARowCoveringTheWholeListCanBeKeptAndOneCutByAnEdgeCannot() {
        let tall = CGRect(x: 0, y: -100, width: 369, height: 900) // longer than the list, covering it
        let kept = OlderPaging.keptRow(["id-1": tall], rows: [row(1)], viewportHeight: height)
        XCTAssertEqual(kept?.rowKey, "cmid-1")
        XCTAssertEqual((kept?.anchorY ?? -1) * (height - 900), -100, accuracy: 0.001)
        XCTAssertNil(OlderPaging.keptRow(["id-1": CGRect(x: 0, y: -100, width: 369, height: 500)], rows: [row(1)], viewportHeight: height))
        XCTAssertNil(OlderPaging.keptRow(["id-1": CGRect(x: 0, y: 400, width: 369, height: 500)], rows: [row(1)], viewportHeight: height))
        XCTAssertEqual(OlderPaging.keptRow(["id-1": CGRect(x: 0, y: 0, width: 369, height: height)], rows: [row(1)], viewportHeight: height)?.anchorY, 0)
        XCTAssertNil(OlderPaging.keptRow([:], rows: [row(1)], viewportHeight: height))
    }

    /// The mechanism ChannelView uses, in a list with its modifiers: in the update that puts a page in above, the row
    /// at the top is scrolled back from the frames of the layout before it, and again while a layout reports it
    /// elsewhere. Without that it lands about a page lower (1,100 pt here). LazyVStack settles it in a few layout passes
    /// as it measures the rows it estimated; one of them can reach the screen (a single frame in the app on the
    /// simulator).
    func testAPagePutInAboveLeavesTheRowAtTheTopWhereItWas() throws {
        let model = PagingModel(rows: (100...149).map(row))
        let size = CGSize(width: 393, height: 700)
        let scene = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first
        let window = scene.map { UIWindow(windowScene: $0) } ?? UIWindow(frame: CGRect(origin: .zero, size: size))
        window.frame = CGRect(origin: .zero, size: size)
        let host = UIHostingController(rootView: PagingList(model: model))
        window.rootViewController = host
        window.makeKeyAndVisible()
        defer { window.isHidden = true }
        host.view.frame = window.bounds
        host.view.layoutIfNeeded()
        spin(0.4)
        model.scrollTarget = "top" // the reader at the top of the window (twice: LazyVStack estimates the rows on the way)
        spin(0.4)
        model.scrollTarget = nil
        spin(0.05)
        model.scrollTarget = "top"
        spin(0.4)
        let before = try XCTUnwrap(model.frames["id-100"])
        XCTAssertGreaterThan(before.minY, 10) // below the progress row
        XCTAssertLessThan(before.minY, 100)

        model.keeping = true
        model.rows = (50...149).map(row) // the older page goes in above
        spin(0.05)
        XCTAssertEqual(try XCTUnwrap(model.frames["id-100"]).minY, before.minY, accuracy: 1) // back within a few layout passes
        spin(0.4)
        XCTAssertEqual(try XCTUnwrap(model.frames["id-100"]).minY, before.minY, accuracy: 1)
        XCTAssertNotNil(model.frames["id-99"]) // the new rows are right above it
    }

    private func spin(_ seconds: TimeInterval) { RunLoop.current.run(until: Date().addingTimeInterval(seconds)) }
}

@MainActor
@Observable
private final class PagingModel {
    var rows: [MessageState]
    var scrollTarget: String?
    @ObservationIgnored var keeping = false
    @ObservationIgnored var frames: [String: CGRect] = [:]
    @ObservationIgnored var viewportHeight: CGFloat = 0
    @ObservationIgnored var kept: OlderPaging.Kept?
    @ObservationIgnored var tries = 0

    init(rows: [MessageState]) { self.rows = rows }
}

private struct PagingFrames: PreferenceKey {
    static let defaultValue: [String: CGRect] = [:]
    static func reduce(value: inout [String: CGRect], nextValue: () -> [String: CGRect]) { value.merge(nextValue()) { _, latest in latest } }
}

/// ChannelView's list in short: rows of varying height keyed by rowKey, frames by id, the timeline's scroll anchor.
private struct PagingList: View {
    let model: PagingModel

    var body: some View {
        ScrollViewReader { proxy in
            GeometryReader { viewport in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        ProgressView().frame(maxWidth: .infinity).padding(.vertical, 8).id("top")
                        ForEach(model.rows, id: \.rowKey) { row in
                            Text(row.body).frame(maxWidth: .infinity, minHeight: CGFloat(40 + ((row.seq ?? 0) * 37) % 90), alignment: .topLeading)
                                .id(row.rowKey)
                                .background(GeometryReader { geometry in
                                    Color.clear.preference(key: PagingFrames.self, value: [row.id: geometry.frame(in: .named("paging"))])
                                })
                        }
                        Color.clear.frame(height: 1).id("bottom")
                    }
                    .padding(.vertical, 8)
                }
                .coordinateSpace(name: "paging")
                .modifier(TimelineScrollAnchor(landing: false))
                .onPreferenceChange(PagingFrames.self) { frames in
                    model.frames = frames
                    model.viewportHeight = viewport.size.height
                    if let kept = model.kept, frames[kept.rowId].map({ abs($0.minY - kept.minY) > 1 }) ?? true, model.tries < 4 {
                        model.tries += 1
                        proxy.scrollTo(kept.rowKey, anchor: UnitPoint(x: 0, y: kept.anchorY))
                    }
                }
                .onChange(of: model.rows.first?.id) { _, _ in
                    guard model.keeping, let kept = OlderPaging.keptRow(model.frames, rows: model.rows, viewportHeight: model.viewportHeight) else { return }
                    model.kept = kept
                    model.tries = 0
                    proxy.scrollTo(kept.rowKey, anchor: UnitPoint(x: 0, y: kept.anchorY))
                }
                .onChange(of: model.scrollTarget) { _, target in if let target { proxy.scrollTo(target, anchor: .top) } }
            }
        }
    }
}
