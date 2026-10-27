import SwiftUI
import UIKit

/// 「テーマの色」 (MOBILE_UI.md §27.2): the desktop's six palettes (apps/desktop/src/ui/theme.ts PALETTES), with the values of
/// apps/shared/palettes.json (ThemeTests keeps them equal). Order = the settings' order; the first is the default.
enum AppPalette: String, CaseIterable, Identifiable {
    case taylis, indigo, green, purple, rose, gray

    static let defaultPalette: AppPalette = .taylis
    var id: String { rawValue }

    /// As the desktop's `theme.palette.*` (ja / en / zh-Hans).
    var label: String {
        switch self {
        case .taylis: tr("Taylis（栗）")
        case .indigo: tr("藍")
        case .green: tr("緑")
        case .purple: tr("紫")
        case .rose: tr("紅")
        case .gray: tr("グレー")
        }
    }

    /// One mode's colours (0xRRGGBB), the names of palettes.json.
    struct Tones: Equatable {
        /// The desktop sidebar and its text (unused on the phone; kept so the table is the whole JSON).
        let sidebar: UInt32
        let sidebarFg: UInt32
        /// Text and lines: links, selected icons, toggles, checkmarks, mentions.
        let accent: UInt32
        /// The fill under white text: the send button, badges, chosen chips.
        let accentSolid: UInt32
        /// A light tint (selected rows).
        let accentSoft: UInt32
    }

    var light: Tones { Self.table[self]!.light }
    var dark: Tones { Self.table[self]!.dark }

    private static let table: [AppPalette: (light: Tones, dark: Tones)] = [
        .taylis: (Tones(sidebar: 0x3b2b21, sidebarFg: 0xefe7df, accent: 0x8f5530, accentSolid: 0x8f5530, accentSoft: 0xf6ece3),
                  Tones(sidebar: 0x1d1611, sidebarFg: 0xe1d7ce, accent: 0xdba67c, accentSolid: 0x8f5530, accentSoft: 0x3a2a1f)),
        .indigo: (Tones(sidebar: 0x2a2340, sidebarFg: 0xe0dce9, accent: 0x5050c8, accentSolid: 0x5050c8, accentSoft: 0xecebff),
                  Tones(sidebar: 0x14111c, sidebarFg: 0xd5d2df, accent: 0x9a9af5, accentSolid: 0x5050c8, accentSoft: 0x2a2a4a)),
        .green: (Tones(sidebar: 0x1e3a2f, sidebarFg: 0xedf4f0, accent: 0x2e7550, accentSolid: 0x2e7550, accentSoft: 0xe4f2ea),
                 Tones(sidebar: 0x111c17, sidebarFg: 0xcfded5, accent: 0x6fcf98, accentSolid: 0x2e7550, accentSoft: 0x1d3a2b)),
        .purple: (Tones(sidebar: 0x3a2150, sidebarFg: 0xeae2f1, accent: 0x7c3fb0, accentSolid: 0x7c3fb0, accentSoft: 0xf3eafb),
                  Tones(sidebar: 0x1a1124, sidebarFg: 0xdcd2e5, accent: 0xc39af0, accentSolid: 0x7c3fb0, accentSoft: 0x35224a)),
        .rose: (Tones(sidebar: 0x4a1e2c, sidebarFg: 0xf1e1e6, accent: 0xb02f50, accentSolid: 0xb02f50, accentSoft: 0xfbe9ee),
                Tones(sidebar: 0x1f1015, sidebarFg: 0xe4d1d7, accent: 0xf590a8, accentSolid: 0xb02f50, accentSoft: 0x4a1f2c)),
        .gray: (Tones(sidebar: 0x2c2e33, sidebarFg: 0xe6e8eb, accent: 0x4f5b6b, accentSolid: 0x4f5b6b, accentSoft: 0xeceef2),
                Tones(sidebar: 0x141518, sidebarFg: 0xd4d6da, accent: 0xa9b4c4, accentSolid: 0x556274, accentSoft: 0x2b2f36)),
    ]

    /// Light and dark in one UIColor (resolved by the traits wherever it is drawn).
    private func dynamic(_ value: KeyPath<Tones, UInt32>) -> UIColor {
        let light = Self.uiColor(self.light[keyPath: value]), dark = Self.uiColor(self.dark[keyPath: value])
        return UIColor { $0.userInterfaceStyle == .dark ? dark : light }
    }

    var uiAccent: UIColor { dynamic(\.accent) }
    var accent: Color { Color(uiColor: uiAccent) }
    var accentSolid: Color { Color(uiColor: dynamic(\.accentSolid)) }
    var accentSoft: Color { Color(uiColor: dynamic(\.accentSoft)) }

    static func uiColor(_ rgb: UInt32) -> UIColor {
        UIColor(red: CGFloat((rgb >> 16) & 0xff) / 255, green: CGFloat((rgb >> 8) & 0xff) / 255, blue: CGFloat(rgb & 0xff) / 255, alpha: 1)
    }
}

/// The colours a screen draws with, from the environment (`@Environment(\.themeColors)`): RootView puts the palette of
/// the workspace on screen there, with `.tint` and the accent colour (so `Color.accentColor` and every control follow).
/// `accent` for text and lines, `solid` for fills under white text, `soft` for selected rows.
struct ThemeColors: Equatable {
    var palette: AppPalette = .defaultPalette
    var accent: Color { palette.accent }
    var solid: Color { palette.accentSolid }
    var soft: Color { palette.accentSoft }
}

private struct ThemeColorsKey: EnvironmentKey {
    static let defaultValue = ThemeColors()
}

extension EnvironmentValues {
    var themeColors: ThemeColors {
        get { self[ThemeColorsKey.self] }
        set { self[ThemeColorsKey.self] = newValue }
    }
}

/// 「このワークスペースだけ」 / 「すべてのワークスペース」 (the desktop's ThemeScope "workspace" | "all").
enum ThemeScope: String, CaseIterable, Identifiable {
    case workspace, all
    var id: String { rawValue }

    var label: String {
        switch self {
        case .workspace: tr("このワークスペースだけ")
        case .all: tr("すべてのワークスペース")
        }
    }
}

/// The palette choices on this device (UserDefaults; not synced, as the desktop's localStorage): one for every
/// workspace and, as the desktop's `chikuwa.prefs.workspaceTheme`, a palette of its own per workspace (keyed by
/// `Workspace.serverUrl`). The pure rules (`resolve`, `choosing`) are what ThemeTests checks.
struct PaletteChoices: Equatable {
    /// Every workspace's palette (the fallback).
    var global: AppPalette = .defaultPalette
    /// The workspaces with a palette of their own.
    var own: [String: AppPalette] = [:]

    /// The palette a workspace shows: its own choice, else the one for every workspace (also with no workspace open).
    func resolve(_ workspace: String?) -> AppPalette {
        workspace.flatMap { own[$0] } ?? global
    }

    /// The scope the picker starts on: this workspace's own choice, or every workspace.
    func scope(_ workspace: String?) -> ThemeScope {
        workspace.flatMap { own[$0] } == nil ? .all : .workspace
    }

    /// After choosing `palette`: for this workspace only (others keep theirs), or for every workspace — then no
    /// workspace keeps one of its own (the desktop's writePalette). Without a workspace it is always every workspace.
    func choosing(_ palette: AppPalette, scope: ThemeScope, workspace: String?) -> PaletteChoices {
        var next = self
        if scope == .workspace, let workspace {
            next.own[workspace] = palette
        } else {
            next.global = palette
            next.own = [:]
        }
        return next
    }
}

/// 「ダークを真っ黒にする」 (MOBILE_UI.md §27.2): iOS's dark backgrounds are already black on a screen of its own, but
/// sheets, popovers and the iPad's split columns are drawn "elevated" (#1C1C1E, rows #2C2C2E). With the switch on they
/// keep the base level, so those become black too while cards, rows and fields keep their grey (#1C1C1E / #2C2C2E) and
/// stay apart from the black. Light is the same at either level.
///
/// The window's level (WindowThemer) covers the columns; a presentation sets its own elevated level below the window,
/// so every presented view controller is pinned too, as it appears (one exchanged `viewWillAppear`, installed the first
/// time the switch is on) and when the switch changes (the ones on screen).
enum BlackDark {
    /// The interface level the window and the presentations are pinned to; nil leaves it to UIKit (elevated sheets).
    static func level(black: Bool) -> UIUserInterfaceLevel? { black ? .base : nil }

    /// The switch as WindowThemer last put it on screen.
    private(set) static var enabled = false

    /// The background of a sheet or popover (`systemBackground` at the level it is pinned to).
    static func sheetBackground(dark: Bool, black: Bool) -> UIColor {
        UIColor.systemBackground.resolvedColor(with: traits(dark: dark, black: black, elevated: true))
    }

    /// A card or a row on that background (`secondarySystemBackground`).
    static func cardBackground(dark: Bool, black: Bool) -> UIColor {
        UIColor.secondarySystemBackground.resolvedColor(with: traits(dark: dark, black: black, elevated: true))
    }

    /// The traits of something UIKit presents elevated (a sheet), after the pinning.
    static func traits(dark: Bool, black: Bool, elevated: Bool) -> UITraitCollection {
        UITraitCollection { traits in
            traits.userInterfaceStyle = dark ? .dark : .light
            traits.userInterfaceLevel = level(black: black) ?? (elevated ? .elevated : .base)
        }
    }

    /// Puts the switch on a window and on what it presents now.
    static func apply(_ black: Bool, to window: UIWindow) {
        enabled = black
        if black { _ = installed }
        pin(&window.traitOverrides)
        var presented = window.rootViewController?.presentedViewController
        while let controller = presented {
            pin(&controller.traitOverrides)
            presented = controller.presentedViewController
        }
    }

    /// A view controller about to appear: a presented one (not a child) follows the switch.
    static func appearing(_ controller: UIViewController) {
        guard controller.presentingViewController != nil, controller.parent == nil else { return }
        pin(&controller.traitOverrides)
    }

    private static func pin(_ overrides: inout UITraitOverrides) {
        // Reading an override that is not set throws (UIKit's assertion): ask `contains` first.
        let pinned = overrides.contains(UITraitUserInterfaceLevel.self)
        if let level = level(black: enabled) {
            if !pinned || overrides.userInterfaceLevel != level { overrides.userInterfaceLevel = level }
        } else if pinned {
            overrides.remove(UITraitUserInterfaceLevel.self)
        }
    }

    /// `viewWillAppear` exchanged once with `UIViewController.blackDarkViewWillAppear` (which calls the original).
    private static let installed: Void = {
        guard let original = class_getInstanceMethod(UIViewController.self, #selector(UIViewController.viewWillAppear(_:))),
              let replacement = class_getInstanceMethod(UIViewController.self, #selector(UIViewController.blackDarkViewWillAppear(_:)))
        else { return }
        method_exchangeImplementations(original, replacement)
    }()
}

extension UIViewController {
    /// BlackDark's `viewWillAppear` (exchanged: the call below runs the original).
    @objc fileprivate func blackDarkViewWillAppear(_ animated: Bool) {
        blackDarkViewWillAppear(animated)
        BlackDark.appearing(self)
    }
}

/// The 表示 settings of this device: the palette choices and the black dark. RootView reads them (a change shows at
/// once); the 表示 screen writes them.
@Observable
final class ThemeSettings {
    static let shared = ThemeSettings()

    static let paletteKey = "chikuwa.palette"
    static let workspacePaletteKey = "chikuwa.workspacePalette"
    static let blackKey = "chikuwa.darkBlack"

    private(set) var choices: PaletteChoices
    var black: Bool {
        didSet { defaults.set(black, forKey: Self.blackKey) }
    }

    private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        var choices = PaletteChoices()
        if let raw = defaults.string(forKey: Self.paletteKey), let palette = AppPalette(rawValue: raw) { choices.global = palette }
        if let own = defaults.dictionary(forKey: Self.workspacePaletteKey) as? [String: String] {
            choices.own = own.compactMapValues(AppPalette.init(rawValue:))
        }
        self.choices = choices
        black = defaults.bool(forKey: Self.blackKey)
    }

    func choose(_ palette: AppPalette, scope: ThemeScope, workspace: String?) {
        write(choices.choosing(palette, scope: scope, workspace: workspace))
    }

    private func write(_ next: PaletteChoices) {
        choices = next
        if next.global == .defaultPalette { defaults.removeObject(forKey: Self.paletteKey) }
        else { defaults.set(next.global.rawValue, forKey: Self.paletteKey) }
        if next.own.isEmpty { defaults.removeObject(forKey: Self.workspacePaletteKey) }
        else { defaults.set(next.own.mapValues(\.rawValue), forKey: Self.workspacePaletteKey) }
    }
}

/// Puts the theme on the UIKit window under it: the tint (alerts, menus, UIKit views and text links) and, for
/// 「ダークを真っ黒にする」, the base interface level. One per window (RootView's background).
struct WindowThemer: UIViewRepresentable {
    let palette: AppPalette
    let black: Bool

    func makeUIView(context: Context) -> ThemerView { ThemerView() }

    func updateUIView(_ view: ThemerView, context: Context) {
        view.palette = palette
        view.black = black
        view.apply()
    }

    final class ThemerView: UIView {
        var palette: AppPalette = .defaultPalette
        var black = false

        override init(frame: CGRect) {
            super.init(frame: frame)
            isUserInteractionEnabled = false
            isHidden = true
        }

        required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

        override func didMoveToWindow() {
            super.didMoveToWindow()
            apply()
        }

        func apply() {
            guard let window else { return }
            window.tintColor = palette.uiAccent
            BlackDark.apply(black, to: window)
        }
    }
}

extension View {
    /// `.borderedProminent` fills a button with the tint under white text: the palette's fill colour there (dark mode's
    /// accent is a light colour for text and lines, too light under white).
    func prominentTint(_ on: Bool = true) -> some View { modifier(ProminentTint(on: on)) }
}

private struct ProminentTint: ViewModifier {
    @Environment(\.themeColors) private var colors
    let on: Bool

    func body(content: Content) -> some View {
        if on { content.tint(colors.solid) } else { content }
    }
}
