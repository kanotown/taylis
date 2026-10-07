import SwiftUI
import UIKit
import XCTest
@testable import ChikuwaChat

/// 在室状況 icons and the quick switch (docs/PRESENCE.md §2.1, §7.1, §9.1): the catalogue against
/// apps/shared/attendance-icons.json, the icon → emoji → name fallback, the form's icon, when the pill shows and how
/// it fits, and the sheet's one-tap switch.
@MainActor
final class AttendanceIconsTests: XCTestCase {
    private struct Fixture: Decodable {
        struct Icon: Decodable { let key: String; let sf: String; let label: [String: String] }
        let icons: [Icon]
        let defaults: [String: String]
    }

    private func fixture() throws -> Fixture {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("shared/attendance-icons.json")
        return try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: url))
    }

    private func state(_ id: String, _ label: String, kind: String = "on_site", owner: String? = nil, icon: String? = nil, emoji: String? = nil,
                       color: String = "gray", position: Int = 0) -> AttendanceStateOut {
        AttendanceStateOut(id: id, ownerId: owner, label: label, emoji: emoji, icon: icon, color: color, kind: kind, position: position)
    }

    // MARK: the catalogue

    func testCatalogueIsTheSharedOne() throws {
        let shared = try fixture()
        XCTAssertEqual(AttendanceIcons.catalogue.map(\.key), shared.icons.map(\.key))  // the picker's order too
        for (icon, file) in zip(AttendanceIcons.catalogue, shared.icons) {
            XCTAssertEqual(icon.sf, file.sf, file.key)
            XCTAssertEqual(icon.label, file.label, file.key)
            for language in AppLanguage.allCases {
                XCTAssertEqual(AttendanceIcons.label(file.key, language: language), file.label[language.rawValue], "\(file.key) \(language)")
            }
        }
        XCTAssertEqual(AttendanceIcons.defaults, shared.defaults)
        XCTAssertEqual(Set(AttendanceIcons.defaults.keys), Set(AttendanceRules.kinds))
    }

    func testEverySymbolExistsOnThisSystem() {
        for icon in AttendanceIcons.catalogue {
            XCTAssertNotNil(UIImage(systemName: icon.sf), icon.sf)
        }
    }

    func testDecodesTheIconAndItsAbsence() throws {
        let json = """
        [{"id": "s1", "owner_id": null, "label": "在室", "icon": "in_room", "emoji": "🟢", "color": "green", "kind": "in_room", "position": 0, "archived": false},
         {"id": "s2", "owner_id": null, "label": "古い", "emoji": null, "color": "gray", "kind": "gone", "position": 1, "archived": false}]
        """
        let states = try JSON.snakeDecoder.decode([AttendanceStateOut].self, from: Data(json.utf8))
        XCTAssertEqual(states[0].icon, "in_room")
        XCTAssertNil(states[1].icon)  // an older server
    }

    // MARK: icon → emoji → name

    func testGlyphFallsBackToTheEmojiThenNothing() {
        XCTAssertEqual(AttendanceIcons.glyph(state("a", "在室", icon: "in_room", emoji: "🟢")), .symbol("door.left.hand.open"))
        XCTAssertEqual(AttendanceIcons.glyph(state("b", "未来", icon: "teleport", emoji: "🛸")), .emoji("🛸"))  // a key added later
        XCTAssertEqual(AttendanceIcons.glyph(state("c", "会議", emoji: ":meeting:")), .emoji(":meeting:"))
        XCTAssertEqual(AttendanceIcons.glyph(state("d", "その他", emoji: "  ")), .none)
        XCTAssertEqual(AttendanceIcons.glyph(state("e", "その他", icon: "teleport")), .none)
        XCTAssertNil(AttendanceIcons.symbol(nil))
        XCTAssertEqual(AttendanceIcons.symbol("lab"), "flask")
        XCTAssertEqual(AttendanceIcons.label("teleport"), "teleport")
    }

    func testPlainTextHasTheEmojiOnlyWithoutAnIcon() {
        XCTAssertEqual(AttendanceRules.stateText(state("a", "在室", icon: "in_room", emoji: "🟢")), "在室")
        XCTAssertEqual(AttendanceRules.stateText(state("b", "未来", icon: "teleport", emoji: "🛸")), "🛸 未来")
        XCTAssertEqual(AttendanceRules.stateText(state("c", "学外")), "学外")
    }

    // MARK: the own-state form

    func testANewStatesIconFollowsItsKindUntilPicked() {
        XCTAssertEqual(AttendanceRules.formIcon(picked: nil, kind: "off_site"), "off_site")
        XCTAssertEqual(AttendanceRules.formIcon(picked: nil, kind: "gone"), "gone")
        XCTAssertEqual(AttendanceRules.formIcon(picked: .some("meeting"), kind: "off_site"), "meeting")
        XCTAssertNil(AttendanceRules.formIcon(picked: .some(nil), kind: "off_site"))  // 「なし」
    }

    func testTheFormSendsTheIconOrNull() {
        let form = AttendanceStateForm(label: "会議", icon: "meeting", emoji: nil, color: "purple", kind: "on_site")
        XCTAssertEqual(form.json, .object(["label": .string("会議"), "icon": .string("meeting"), "emoji": .null, "color": .string("purple"),
                                           "kind": .string("on_site")]))
        let none = AttendanceStateForm(label: "会議", emoji: "🗣️", color: "gray", kind: "on_site")
        guard case .object(let fields) = none.json else { return XCTFail("not an object") }
        XCTAssertEqual(fields["icon"], JSONValue.null)
    }

    // MARK: the pill

    func testThePillShowsOnlyForMembersWhileOn() {
        let on = AttendanceBoardOut(enabled: true, states: [], entries: [])
        XCTAssertTrue(AttendanceRules.pillVisible(board: on, role: "member"))
        XCTAssertTrue(AttendanceRules.pillVisible(board: on, role: "admin"))
        XCTAssertFalse(AttendanceRules.pillVisible(board: on, role: "guest"))
        XCTAssertFalse(AttendanceRules.pillVisible(board: on, role: "bot"))
        XCTAssertFalse(AttendanceRules.pillVisible(board: on, role: nil))
        XCTAssertFalse(AttendanceRules.pillVisible(board: nil, role: "member"))
        XCTAssertFalse(AttendanceRules.pillVisible(board: AttendanceBoardOut(enabled: false, states: [], entries: []), role: "member"))
    }

    func testThePillsFaceAndVoiceOver() {
        let off = state("off", "学外", kind: "off_site", icon: "off_site", color: "purple")
        let board = AttendanceBoardOut(enabled: true, states: [off], entries: [
            AttendanceEntryOut(userId: "me", stateId: "off", since: "2026-10-07T09:00:00Z", note: nil),
        ])
        XCTAssertEqual(AttendanceRules.myState(board, "me")?.id, "off")
        XCTAssertNil(AttendanceRules.myState(board, "other"))
        XCTAssertNil(AttendanceRules.myState(nil, "me"))
        XCTAssertEqual(AttendanceRules.pillAccessibilityLabel(off), "在室状況：学外")
        XCTAssertEqual(AttendanceRules.pillAccessibilityLabel(nil), "在室状況")
        XCTAssertEqual(AttendanceRules.pillText("学外"), "学外")
        XCTAssertEqual(AttendanceRules.pillText("12345678"), "12345678")
        XCTAssertEqual(AttendanceRules.pillText("とても長い状態の名前です"), "とても長い状態…")
    }

    func testThePillGivesWayBeforeTheName() {
        // Room for both: whole.
        XCTAssertEqual(AttendanceRules.pillMode(room: 300, nameNatural: 120, nameMin: 70, full: 90), .full)
        // Not for the whole pill: only its icon (the name may be cut to its 4 characters).
        XCTAssertEqual(AttendanceRules.pillMode(room: 200, nameNatural: 120, nameMin: 70, full: 90), .icon)
        XCTAssertEqual(AttendanceRules.pillMode(room: 104, nameNatural: 160, nameMin: 70, full: 90), .icon)
        // Not even that: no pill.
        XCTAssertEqual(AttendanceRules.pillMode(room: 100, nameNatural: 160, nameMin: 70, full: 90), .hidden)
        // A short name is never cut below itself.
        XCTAssertEqual(AttendanceRules.pillMode(room: 70, nameNatural: 30, nameMin: 30, full: 90), .icon)
        // Not laid out yet.
        XCTAssertEqual(AttendanceRules.pillMode(room: 0, nameNatural: 160, nameMin: 70, full: 90), .full)
        // The header's room: the bar less the picture and ⋯ on both sides.
        XCTAssertEqual(AttendanceRules.headerRoom(barWidth: 402), 266)
        XCTAssertEqual(AttendanceRules.headerRoom(barWidth: 0), 0)
        XCTAssertEqual(AttendanceRules.headerRoom(barWidth: 100), 0)
    }

    /// The quick switch sheet opens tall enough for its whole list (「在室状況を開く」 was under a medium sheet's edge).
    func testTheQuickSheetFitsItsList() {
        // The list, the navigation bar above and the home indicator below, rounded up.
        XCTAssertEqual(AttendanceRules.quickSheetHeight(contentHeight: 440.4, topInset: 88, bottomInset: 34), 563)
        // A home button iPhone (no inset below).
        XCTAssertEqual(AttendanceRules.quickSheetHeight(contentHeight: 445, topInset: 88, bottomInset: 0), 533)
        // Not laid out yet: no height (the sheet stays at medium until measured).
        XCTAssertEqual(AttendanceRules.quickSheetHeight(contentHeight: 0, topInset: 88, bottomInset: 34), 0)
        XCTAssertEqual(AttendanceRules.quickSheetHeight(contentHeight: 400, topInset: -10, bottomInset: 0), 400)
    }

    // MARK: the sheet's one-tap switch

    private static func body(_ request: URLRequest) -> [String: JSONValue] {
        var data = request.httpBody ?? Data()
        if data.isEmpty, let stream = request.httpBodyStream {
            stream.open()
            defer { stream.close() }
            var buffer = [UInt8](repeating: 0, count: 4096)
            while stream.hasBytesAvailable {
                let read = stream.read(&buffer, maxLength: buffer.count)
                if read <= 0 { break }
                data.append(buffer, count: read)
            }
        }
        if case .object(let object)? = try? JSON.plainDecoder.decode(JSONValue.self, from: data) { return object }
        return [:]
    }

    private func controller(answer: @escaping (URLRequest, [String: JSONValue]) -> (Int, Data)) -> AppController {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubProtocol.self]
        let client = ApiClient(baseUrl: URL(string: "http://server")!, session: URLSession(configuration: configuration))
        client.accessToken = "access"
        StubProtocol.handler = { request in answer(request, Self.body(request)) }
        let controller = AppController()
        controller.api = client
        controller.store.setMe(UserMe(id: "me", username: "me", displayName: "Me", role: "member", deactivatedAt: nil, createdAt: "", updatedAt: "",
                                      email: nil, mustChangePassword: false))
        controller.store.setAttendance(AttendanceBoardOut(enabled: true, states: [
            state("room", "在室", kind: "in_room", icon: "in_room", color: "green"),
            state("off", "学外", kind: "off_site", icon: "off_site", color: "purple", position: 1),
        ], entries: [AttendanceEntryOut(userId: "me", stateId: "room", since: "2026-10-07T09:00:00Z", note: "3 号室")]))
        return controller
    }

    private static func entry(_ body: [String: JSONValue]) -> Data {
        let state = if case .string(let id)? = body["state_id"] { id } else { "" }
        let note = if case .string(let text)? = body["note"] { "\"\(text)\"" } else { "null" }
        return Data(#"{"user_id": "me", "state_id": "\#(state)", "since": "2026-10-07T10:00:00Z", "note": \#(note), "source": "app"}"#.utf8)
    }

    func testATapSwitchesAtOnceAndAnotherStateDropsTheNote() async {
        var sent: [[String: JSONValue]] = []
        let controller = controller { request, body in
            XCTAssertEqual(request.httpMethod, "PUT")
            XCTAssertEqual(request.url?.path, "/api/v1/attendance/me")
            sent.append(body)
            return (200, Self.entry(body))
        }
        let board = controller.store.attendance!
        // The same state keeps my note.
        let same = await controller.switchMyAttendance(to: board.states[0])
        XCTAssertTrue(same)
        XCTAssertEqual(sent.last, ["state_id": .string("room"), "note": .string("3 号室")])
        // Another one starts without it; my row is replaced at once (the sheet closes on true).
        let other = await controller.switchMyAttendance(to: board.states[1])
        XCTAssertTrue(other)
        XCTAssertEqual(sent.last, ["state_id": .string("off"), "note": .null])
        XCTAssertEqual(AttendanceRules.myState(controller.store.attendance, "me")?.label, "学外")
        XCTAssertEqual(AttendanceRules.pillAccessibilityLabel(AttendanceRules.myState(controller.store.attendance, "me")), "在室状況：学外")
        XCTAssertNil(controller.error)
    }

    func testARefusedSwitchKeepsTheSheetOpenAndSaysWhy() async {
        let controller = controller { _, _ in
            (403, Data(#"{"error": {"code": "guest_restricted", "message": "no"}}"#.utf8))
        }
        let ok = await controller.switchMyAttendance(to: controller.store.attendance!.states[1])
        XCTAssertFalse(ok)
        XCTAssertNotNil(controller.error)
        XCTAssertEqual(AttendanceRules.myState(controller.store.attendance, "me")?.id, "room")
    }

    // MARK: the solid badge (PRESENCE.md §2.2, apps/shared/attendance-badge-colors.json)

    private struct BadgePalette: Decodable {
        let fg: String
        let min_text_contrast: Double
        let min_icon_contrast: Double
        let colors: [String: String]
    }

    private func badgePalette() throws -> (BadgePalette, [String]) {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("shared/attendance-badge-colors.json")
        let data = try Data(contentsOf: url)
        // The keys in the file's order (a Swift dictionary has none).
        let text = String(decoding: data, as: UTF8.self)
        let colorsPart = text.components(separatedBy: "\"colors\"").last ?? ""
        let keys = try NSRegularExpression(pattern: #""(\w+)"\s*:"#).matches(in: colorsPart, range: NSRange(colorsPart.startIndex..., in: colorsPart))
            .map { String(colorsPart[Range($0.range(at: 1), in: colorsPart)!]) }
        return (try JSONDecoder().decode(BadgePalette.self, from: data), keys)
    }

    private func rgb(_ hex: String) -> UInt32 { UInt32(hex.dropFirst(), radix: 16)! }

    func testTheBadgePaletteIsTheSharedOne() throws {
        let (shared, order) = try badgePalette()
        XCTAssertEqual(AttendancePalette.badgeForeground, rgb(shared.fg))
        XCTAssertEqual(AttendancePalette.badgeColors, shared.colors.mapValues(rgb))
        // Every colour key a state may have (the text emoji palette's), in the swatches' order.
        XCTAssertEqual(order, SectionLetterIcon.colors.map(\.key))
        XCTAssertEqual(Set(order), Set(CustomEmoji.textPalette.keys))
        XCTAssertEqual(AttendancePalette.solidRGB("nonsense"), rgb(shared.colors["gray"]!))
    }

    func testWhiteOnEveryShadeMeetsWCAGAA() throws {
        let (shared, _) = try badgePalette()
        XCTAssertEqual(AttendancePalette.contrast(0xFFFFFF, 0x000000), 21, accuracy: 0.0001)
        XCTAssertGreaterThanOrEqual(shared.min_text_contrast, 4.5)
        XCTAssertGreaterThanOrEqual(shared.min_icon_contrast, 3)
        for (key, shade) in AttendancePalette.badgeColors {
            let ratio = AttendancePalette.contrast(AttendancePalette.badgeForeground, shade)
            XCTAssertGreaterThanOrEqual(ratio, shared.min_text_contrast, key)
            XCTAssertGreaterThanOrEqual(ratio, shared.min_icon_contrast, key)
        }
    }

    /// The chip draws as the solid shade in light and dark alike.
    func testTheChipIsSolidInBothThemes() throws {
        let yellow = state("y", "学内", icon: "on_site", color: "yellow")
        for scheme in [ColorScheme.light, .dark] {
            let renderer = ImageRenderer(content: AttendanceChip(controller: AppController(), state: yellow, large: true).environment(\.colorScheme, scheme))
            renderer.scale = 1
            let image = try XCTUnwrap(renderer.cgImage)
            let pixel = try XCTUnwrap(Self.pixel(image, x: 3, y: image.height / 2))
            let shade = AttendancePalette.solidRGB("yellow")
            XCTAssertEqual(Double(pixel.r), Double((shade >> 16) & 0xFF), accuracy: 3, "\(scheme)")
            XCTAssertEqual(Double(pixel.g), Double((shade >> 8) & 0xFF), accuracy: 3, "\(scheme)")
            XCTAssertEqual(Double(pixel.b), Double(shade & 0xFF), accuracy: 3, "\(scheme)")
        }
    }

    /// Switching between states whose names are as long must not move the home header's pill (2026-10-07): each symbol
    /// sits in the same box, so the pill's size is the same for all of them.
    func testThePillKeepsItsSizeAcrossSameLengthStates() {
        let controller = AppController()
        let states = [
            state("a", "在室", kind: "in_room", icon: "in_room", color: "green"),
            state("b", "学内", kind: "on_site", icon: "on_site", color: "blue"),
            state("c", "学外", kind: "off_site", icon: "off_site", color: "purple"),
            state("d", "帰宅", kind: "gone", icon: "gone", color: "red"),
            state("e", "会議", icon: "meeting", color: "orange"),
            state("f", "授業", icon: "class", color: "pink"),
        ]
        for iconOnly in [false, true] {
            let sizes = states.map { state in
                UIHostingController(rootView: AttendancePillFace(controller: controller, state: state, iconOnly: iconOnly))
                    .sizeThatFits(in: CGSize(width: 1000, height: 200))
            }
            XCTAssertEqual(Set(sizes.map(\.width)).count, 1, "iconOnly \(iconOnly): \(sizes)")
            XCTAssertEqual(Set(sizes.map(\.height)).count, 1, "iconOnly \(iconOnly): \(sizes)")
        }
    }

    private static func pixel(_ image: CGImage, x: Int, y: Int) -> (r: UInt8, g: UInt8, b: UInt8)? {
        var data = [UInt8](repeating: 0, count: 4)
        guard let context = CGContext(data: &data, width: 1, height: 1, bitsPerComponent: 8, bytesPerRow: 4,
                                      space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
        else { return nil }
        context.draw(image, in: CGRect(x: -x, y: -(image.height - 1 - y), width: image.width, height: image.height))
        return (data[0], data[1], data[2])
    }
}
