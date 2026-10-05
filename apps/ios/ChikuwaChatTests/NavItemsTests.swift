import SwiftUI
import UIKit
import XCTest
@testable import ChikuwaChat

/// M111: the home tiles I chose (UserMe.nav_items) — the catalogue and the rule against apps/shared/nav-items.json (the
/// desktop's navItems.test.tsx and Android's NavItemsTest read it too), the tile row, and the setting's coding.
@MainActor
final class NavItemsFixtureTests: XCTestCase {
    private func render<V: View>(_ view: V, size: CGSize, name: String) throws -> UIImage {
        let window = UIWindow(frame: CGRect(origin: .zero, size: size))
        let host = UIHostingController(rootView: view)
        window.rootViewController = host
        window.makeKeyAndVisible()
        host.view.frame = window.bounds
        host.view.layoutIfNeeded()
        RunLoop.current.run(until: Date().addingTimeInterval(0.4))
        let image = UIGraphicsImageRenderer(bounds: window.bounds).image { context in window.layer.render(in: context.cgContext) }
        window.isHidden = true
        if let dir = ProcessInfo.processInfo.environment["SNAPSHOT_DIR"], let data = image.pngData() {
            try data.write(to: URL(fileURLWithPath: dir).appendingPathComponent(name))
        }
        return image
    }

    private struct Fixture: Decodable {
        struct Item: Decodable { let key: String; let label: String; let mobile_label: String?; let visible: Bool; let platforms: [String] }
        struct Case: Decodable { let name: String; let stored: [NavItem]?; let platform: String; let implemented: [String]; let full: [NavItem]; let shown: [NavItem] }
        struct Reorder: Decodable { let name: String; let stored: [NavItem]?; let platform: String; let implemented: [String]; let order: [String]; let full: [NavItem] }
        let items: [Item]
        let order: [String: [String]]
        let cases: [Case]
        let reorder: [Reorder]
    }

    private func fixture() throws -> Fixture {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("shared/nav-items.json")
        return try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: url))
    }

    func testCatalogueIsTheSharedOne() throws {
        let shared = try fixture()
        XCTAssertEqual(NavItems.catalogue.map(\.key), shared.items.map(\.key))
        for (entry, item) in zip(NavItems.catalogue, shared.items) {
            XCTAssertEqual(entry.label, item.label, item.key)
            XCTAssertEqual(entry.mobileLabel, item.mobile_label, item.key)
            XCTAssertEqual(entry.visible, item.visible, item.key)
            XCTAssertEqual(entry.platforms.map(\.rawValue), item.platforms, item.key)
        }
        XCTAssertEqual(NavItems.order[.desktop], shared.order["desktop"])
        XCTAssertEqual(NavItems.order[.mobile], shared.order["mobile"])
        // Every tile has its key in the catalogue, on the phones.
        for kind in HomeTile.Kind.allCases {
            XCTAssertTrue(shared.items.contains { $0.key == kind.navKey && $0.platforms.contains("mobile") }, kind.rawValue)
        }
    }

    func testTheSharedCases() throws {
        let shared = try fixture()
        for c in shared.cases {
            let platform = NavItems.Platform(rawValue: c.platform)!
            let full = NavItems.full(c.stored, platform: platform)
            XCTAssertEqual(full, c.full, c.name)
            XCTAssertEqual(NavItems.shown(full, platform: platform, implemented: c.implemented), c.shown, c.name)
        }
        for c in shared.reorder {
            let platform = NavItems.Platform(rawValue: c.platform)!
            XCTAssertEqual(NavItems.reorder(NavItems.full(c.stored, platform: platform), order: c.order, platform: platform, implemented: c.implemented),
                           c.full, c.name)
        }
    }

    func testTilesFollowMyListAndKeepTheirNumbers() {
        let threads = ThreadSummary(unreadCount: 3, mentionCount: 1)
        let defaults = HomeTile.tiles(threads: threads, drafts: 1, saved: 2, firedReminders: 0, navItems: nil)
        XCTAssertEqual(defaults.map(\.kind), HomeTile.tiles(threads: threads, drafts: 1, saved: 2, firedReminders: 0).map(\.kind))
        let mine = HomeTile.tiles(threads: threads, drafts: 1, saved: 2, firedReminders: 0, navItems: [
            NavItem(key: "calendar", visible: true), NavItem(key: "activity", visible: false), NavItem(key: "times-feed", visible: false),
            NavItem(key: "some-future-page", visible: true), NavItem(key: "threads", visible: true), NavItem(key: "files", visible: false),
        ])
        XCTAssertEqual(mine.map(\.kind), [.calendar, .threads, .drafts, .saved, .reminders, .tasks, .deadlines, .canvases])
        let tile = mine.first { $0.kind == .threads }!
        XCTAssertEqual(tile.count, 3)
        XCTAssertTrue(tile.alert)
    }

    func testSettingDecodesMissingNullAndList() throws {
        let base = #"{"id":"me","username":"kano","display_name":"Kano","role":"member","deactivated_at":null,"created_at":"","updated_at":"","email":null,"must_change_password":false"#
        let decode = { (json: String) in try JSON.snakeDecoder.decode(UserMe.self, from: Data(json.utf8)) }
        XCTAssertEqual(try decode(base + "}").navItems, .unsupported)
        XCTAssertEqual(try decode(base + #","nav_items":null}"#).navItems, .unset)
        XCTAssertEqual(try decode(base + #","nav_items":[{"key":"files","visible":false}]}"#).navItems, .chosen([NavItem(key: "files", visible: false)]))
        // The store's cache keeps the three apart.
        for setting in [NavItemsSetting.unsupported, .unset, .chosen([NavItem(key: "saved", visible: true)])] {
            var me = try decode(base + "}")
            me.navItems = setting
            let cached = try JSON.plainEncoder.encode(me)
            XCTAssertEqual(try JSON.plainDecoder.decode(UserMe.self, from: cached).navItems, setting)
        }
    }

    func testSettingsRender() throws {
        let controller = AppController()
        var me = UserMe(id: "me", username: "kano", displayName: "Kano", role: "member", deactivatedAt: nil, createdAt: "", updatedAt: "",
                        email: nil, mustChangePassword: false)
        me.navItems = .chosen([NavItem(key: "calendar", visible: true), NavItem(key: "files", visible: false)])
        controller.store.setMe(me)
        let image = try render(NavigationStack { HomeTilesSettingsView(controller: controller) }, size: CGSize(width: 393, height: 900), name: "home-tiles-settings.png")
        XCTAssertGreaterThan(image.size.width, 0)
    }
}
