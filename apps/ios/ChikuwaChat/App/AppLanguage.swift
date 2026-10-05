import Foundation
import Observation

/// The UI languages the app is translated into (Localizable.xcstrings: Japanese is the source, then English and
/// Simplified Chinese). The raw value is what the server's `UserMe.locale` and Accept-Language carry.
enum AppLanguage: String, CaseIterable, Identifiable, Codable {
    case ja
    case en
    case zhHans = "zh-Hans"

    var id: String { rawValue }

    /// Each language in its own words (the picker shows them untranslated, as iOS does).
    var nativeName: String {
        switch self {
        case .ja: "日本語"  // i18n-ignore
        case .en: "English"
        case .zhHans: "简体中文"  // i18n-ignore
        }
    }

    /// The language an identifier ("en-US", "zh-Hans-CN", "zh_CN", "ja-JP") is in; nil for one the app has no
    /// translation for (Traditional Chinese, French …).
    init?(identifier: String) {
        let id = identifier.replacingOccurrences(of: "_", with: "-").lowercased()
        if id == "ja" || id.hasPrefix("ja-") { self = .ja; return }
        if id == "en" || id.hasPrefix("en-") { self = .en; return }
        if id == "zh" || id.hasPrefix("zh-hans") || id == "zh-cn" || id == "zh-sg" { self = .zhHans; return }
        return nil
    }
}

/// The in-app language choice (自分 → 表示 → 言語), the same on every device through the server's `UserMe.locale`.
///
/// How it works, and why this way: iOS keeps an app's language in the app's own `AppleLanguages` default (the per-app
/// language in the iOS Settings writes exactly that) and reads it at launch for everything — `String(localized:)`, the
/// Info.plist usage texts (InfoPlist.xcstrings), the system's own buttons and pickers, `Locale.current`. So a choice is
/// written there too, and the next launch is in that language through the normal mechanism; a change made in the iOS
/// Settings is noticed at launch and taken as the choice. For the running app to switch at once (without a restart,
/// which iOS apps cannot do themselves), the texts are looked up in the chosen language explicitly: SwiftUI's
/// `Text("…")` / `Button("…")` … through `\.locale` (RootView sets it and rebuilds its screens), every other text
/// through `tr("…")` (a `LocalizedStringResource` with this locale), and dates and numbers are formatted with `locale`.
/// nil = 端末に合わせる (the device's languages; the server's null).
@Observable
final class UILanguage {
    static let shared = UILanguage()

    /// UserDefaults: "ja" / "en" / "zh-Hans"; absent = follow the device.
    static let storageKey = "uiLanguage"
    /// What this app last wrote into its `AppleLanguages`, to notice a change made in the iOS Settings since.
    private static let writtenKey = "uiLanguageWrittenAppleLanguages"
    private static let uploadKey = "uiLanguageNeedsUpload"

    /// The choice; nil follows the device.
    private(set) var choice: AppLanguage?
    /// The language the UI is in now.
    private(set) var effective: AppLanguage = .ja
    /// The device's language among ours (the one 端末に合わせる gives).
    private(set) var deviceLanguage: AppLanguage = .ja

    /// The locale for texts, dates and numbers: the UI language with the device's region.
    var locale: Locale { Self.locale(for: effective) }

    /// Accept-Language for every request: the language the UI is in.
    var acceptLanguage: String { effective.rawValue }

    private let defaults: UserDefaults
    /// Unit tests compare against the Japanese texts whatever the simulator's language: "follow the device" is Japanese.
    private let testing = ProcessInfo.processInfo.environment["XCTestConfigurationFilePath"] != nil

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        choice = defaults.string(forKey: Self.storageKey).flatMap(AppLanguage.init(rawValue:))
        // A language chosen in the iOS Settings (the per-app language) since we last wrote ours wins: the person
        // changed it there (a language we have no translation for, or none, is 端末に合わせる).
        if !testing, let bundleId = Bundle.main.bundleIdentifier {
            let own = defaults.persistentDomain(forName: bundleId)?["AppleLanguages"] as? [String]
            if own != defaults.stringArray(forKey: Self.writtenKey) {
                let external = own?.first.flatMap(AppLanguage.init(identifier:))
                if external != choice { defaults.set(true, forKey: Self.uploadKey) }
                choice = external
                if let external { defaults.set(external.rawValue, forKey: Self.storageKey) } else { defaults.removeObject(forKey: Self.storageKey) }
                if let own { defaults.set(own, forKey: Self.writtenKey) } else { defaults.removeObject(forKey: Self.writtenKey) }
            }
        }
        update()
    }

    /// The choice changed here (in the app or in the iOS Settings) and the server has not taken it yet: it is sent
    /// (again) instead of adopting the server's value. Kept across launches (offline changes).
    var needsUpload: Bool {
        get { access(keyPath: \.choice); return defaults.bool(forKey: Self.uploadKey) }
        set { defaults.set(newValue, forKey: Self.uploadKey) }
    }

    /// Choose a language (nil: follow the device), at once and for the next launches.
    func set(_ language: AppLanguage?) {
        guard language != choice else { return }
        needsUpload = true
        choice = language
        if let language {
            defaults.set(language.rawValue, forKey: Self.storageKey)
            if !testing {
                defaults.set([language.rawValue], forKey: "AppleLanguages")
                defaults.set([language.rawValue], forKey: Self.writtenKey)
            }
        } else {
            defaults.removeObject(forKey: Self.storageKey)
            if !testing {
                defaults.removeObject(forKey: "AppleLanguages")
                defaults.removeObject(forKey: Self.writtenKey)
            }
        }
        update()
    }

    /// The server's `locale` (`UserMe.locale`): adopted when it differs (chosen on another device).
    func adoptServerValue(_ raw: String?) {
        let language = raw.flatMap(AppLanguage.init(rawValue:))
        if raw != nil && language == nil { return }  // a language this build does not know
        set(language)
        needsUpload = false
    }

    private func update() {
        deviceLanguage = testing ? .ja : Self.deviceLanguage(defaults: defaults, ignoringAppOverride: choice != nil)
        effective = choice ?? deviceLanguage
        // The error texts (apps/shared/errors.json's tables) follow too.
        ErrorMessages.locale = effective.rawValue
    }

    static func locale(for language: AppLanguage) -> Locale {
        if let region = Locale.current.region?.identifier { return Locale(identifier: "\(language.rawValue)_\(region)") }
        return Locale(identifier: language.rawValue)
    }

    /// The first of the device's preferred languages that we have, else Japanese (the development language).
    /// `ignoringAppOverride`: our own `AppleLanguages` is the choice, not the device's, so read the global domain.
    static func deviceLanguage(defaults: UserDefaults, ignoringAppOverride: Bool) -> AppLanguage {
        let preferred: [String]
        if ignoringAppOverride {
            preferred = (defaults.persistentDomain(forName: UserDefaults.globalDomain)?["AppleLanguages"] as? [String]) ?? Locale.preferredLanguages
        } else {
            preferred = defaults.stringArray(forKey: "AppleLanguages") ?? Locale.preferredLanguages
        }
        return preferred.lazy.compactMap(AppLanguage.init(identifier:)).first ?? .ja
    }
}

/// A text of Localizable.xcstrings in the UI language (自分 → 表示 → 言語), which can change while the app runs: use it
/// for every text built outside SwiftUI's `Text("…")` / `Button("…")` …, instead of `String(localized:)`, which keeps
/// the language the app was launched in. The literal (with its interpolations) is the key, as for `String(localized:)`;
/// the compiler extracts it into the catalog (a `LocalizedStringResource` parameter).
func tr(_ resource: LocalizedStringResource) -> String {
    var resource = resource
    resource.locale = UILanguage.shared.locale
    return String(localized: resource)
}

/// Weekday names in the UI language (日 月 火 … / Sun Mon Tue … / 周日 周一 周二 …), from the locale's calendar.
enum AppDates {
    private static var calendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.locale = UILanguage.shared.locale
        return calendar
    }

    /// Short names, Sunday first (Calendar's weekday - 1).
    static var weekdaysSundayFirst: [String] { calendar.shortWeekdaySymbols }
    /// Full names, Sunday first (火曜日 / Tuesday / 星期二).
    static var weekdaysFullSundayFirst: [String] { calendar.weekdaySymbols }
    /// Short names, Monday first (0 = Monday).
    static var weekdaysMondayFirst: [String] {
        let names = weekdaysSundayFirst
        return Array(names[1...]) + [names[0]]
    }

    /// Between short weekday names in a run (「月火水」 / "Mon, Tue, Wed").
    static var weekdayRunSeparator: String { UILanguage.shared.effective == .ja ? "" : ", " }
}
