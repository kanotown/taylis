import SwiftUI
import UIKit
import XCTest
@testable import ChikuwaChat

/// 「テーマの色」, the black dark and the per-workspace colours (MOBILE_UI.md §27.2).
final class ThemeTests: XCTestCase {
    private struct PalettesFile: Decodable {
        let order: [String]
        let palettes: [String: [String: [String: String]]]
    }

    private func palettesFile() throws -> PalettesFile {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("shared/palettes.json")
        return try JSONDecoder().decode(PalettesFile.self, from: Data(contentsOf: url))
    }

    private func hex(_ value: UInt32) -> String { String(format: "#%06x", value) }

    func testPalettesEqualTheSharedJson() throws {
        let file = try palettesFile()
        XCTAssertEqual(AppPalette.allCases.map(\.rawValue), file.order, "the settings' order")
        XCTAssertEqual(AppPalette.defaultPalette.rawValue, file.order.first)
        for palette in AppPalette.allCases {
            let modes = try XCTUnwrap(file.palettes[palette.rawValue])
            for (mode, tones) in [("light", palette.light), ("dark", palette.dark)] {
                let json = try XCTUnwrap(modes[mode], "\(palette) \(mode)")
                let swift = ["sidebar": tones.sidebar, "sidebar-fg": tones.sidebarFg, "accent": tones.accent,
                             "accent-solid": tones.accentSolid, "accent-soft": tones.accentSoft].mapValues(hex)
                XCTAssertEqual(swift, json.mapValues { $0.lowercased() }, "\(palette) \(mode)")
            }
        }
    }

    func testLabelsAsTheDesktop() {
        XCTAssertEqual(AppPalette.allCases.map(\.label), ["Taylis（栗）", "藍", "緑", "紫", "紅", "グレー"])
        XCTAssertEqual(ThemeScope.allCases.map(\.label), ["このワークスペースだけ", "すべてのワークスペース"])
    }

    func testDynamicColoursFollowTheMode() {
        let light = UITraitCollection(userInterfaceStyle: .light), dark = UITraitCollection(userInterfaceStyle: .dark)
        XCTAssertEqual(AppPalette.green.uiAccent.resolvedColor(with: light), AppPalette.uiColor(0x2e7550))
        XCTAssertEqual(AppPalette.green.uiAccent.resolvedColor(with: dark), AppPalette.uiColor(0x6fcf98))
    }

    func testWorkspaceChoiceFallsBackToTheCommonOne() {
        let a = "https://a.example", b = "https://b.example"
        var choices = PaletteChoices()
        XCTAssertEqual(choices.resolve(a), .taylis, "the default")
        XCTAssertEqual(choices.resolve(nil), .taylis)
        XCTAssertEqual(choices.scope(a), .all)

        choices = choices.choosing(.indigo, scope: .all, workspace: a)
        XCTAssertEqual(choices.resolve(a), .indigo)
        XCTAssertEqual(choices.resolve(b), .indigo)

        choices = choices.choosing(.green, scope: .workspace, workspace: a)
        XCTAssertEqual(choices.resolve(a), .green, "its own")
        XCTAssertEqual(choices.resolve(b), .indigo, "the others keep the common one")
        XCTAssertEqual(choices.scope(a), .workspace)
        XCTAssertEqual(choices.scope(b), .all)

        choices = choices.choosing(.rose, scope: .workspace, workspace: b)
        choices = choices.choosing(.gray, scope: .all, workspace: b)
        XCTAssertEqual(choices.resolve(a), .gray, "every workspace: no workspace keeps its own")
        XCTAssertEqual(choices.resolve(b), .gray)
        XCTAssertTrue(choices.own.isEmpty)

        // Without a workspace (signed out) a choice is for every workspace.
        XCTAssertEqual(PaletteChoices().choosing(.purple, scope: .workspace, workspace: nil).global, .purple)
    }

    func testSettingsAreKeptOnTheDevice() throws {
        let defaults = try XCTUnwrap(UserDefaults(suiteName: "ThemeTests"))
        defaults.removePersistentDomain(forName: "ThemeTests")
        defer { defaults.removePersistentDomain(forName: "ThemeTests") }
        let settings = ThemeSettings(defaults: defaults)
        settings.choose(.green, scope: .workspace, workspace: "https://a.example")
        settings.choose(.indigo, scope: .workspace, workspace: "https://b.example")
        settings.black = true
        let again = ThemeSettings(defaults: defaults)
        XCTAssertEqual(again.choices.resolve("https://a.example"), .green)
        XCTAssertEqual(again.choices.resolve("https://b.example"), .indigo)
        XCTAssertEqual(again.choices.resolve("https://c.example"), .taylis)
        XCTAssertTrue(again.black)
        // The default is not written; every workspace clears the own ones.
        again.choose(.taylis, scope: .all, workspace: "https://a.example")
        XCTAssertNil(defaults.object(forKey: ThemeSettings.paletteKey))
        XCTAssertNil(defaults.object(forKey: ThemeSettings.workspacePaletteKey))
    }

    func testBlackDarkKeepsSheetsBlackAndCardsGrey() {
        func hex(_ color: UIColor) -> String {
            var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
            color.getRed(&r, green: &g, blue: &b, alpha: &a)
            return String(format: "#%02x%02x%02x", Int(round(r * 255)), Int(round(g * 255)), Int(round(b * 255)))
        }
        XCTAssertEqual(BlackDark.level(black: true), .base)
        XCTAssertNil(BlackDark.level(black: false))
        // Dark: a sheet is grey (#1c1c1e) unless black; its cards stay a step lighter than it either way.
        XCTAssertEqual(hex(BlackDark.sheetBackground(dark: true, black: false)), "#1c1c1e")
        XCTAssertEqual(hex(BlackDark.sheetBackground(dark: true, black: true)), "#000000")
        XCTAssertEqual(hex(BlackDark.cardBackground(dark: true, black: true)), "#1c1c1e")
        XCTAssertNotEqual(hex(BlackDark.cardBackground(dark: true, black: true)), hex(BlackDark.sheetBackground(dark: true, black: true)))
        // Light is the same either way.
        XCTAssertEqual(hex(BlackDark.sheetBackground(dark: false, black: true)), hex(BlackDark.sheetBackground(dark: false, black: false)))
    }
}
