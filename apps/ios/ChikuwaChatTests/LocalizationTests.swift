import XCTest
@testable import ChikuwaChat

/// The UI language: every catalog text has its English and Simplified Chinese, the translations keep the format
/// arguments, the in-app choice switches the strings at once, and `UserMe.locale` keeps "missing" apart from null.
final class LocalizationTests: XCTestCase {
    private static let languages = ["en", "zh-Hans"]

    private func catalog(_ name: String) throws -> [String: [String: Any]] {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("ChikuwaChat/Resources/\(name).xcstrings")
        let json = try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any]
        XCTAssertEqual(json?["sourceLanguage"] as? String, "ja")
        return try XCTUnwrap(json?["strings"] as? [String: [String: Any]])
    }

    /// The texts of one language: the string unit's value, or every plural / device variation's.
    private func values(_ entry: [String: Any], _ language: String) -> [String] {
        guard let localization = (entry["localizations"] as? [String: Any])?[language] as? [String: Any] else { return [] }
        var out: [String] = []
        if let unit = localization["stringUnit"] as? [String: Any], let value = unit["value"] as? String, !value.isEmpty { out.append(value) }
        if let variations = localization["variations"] as? [String: [String: [String: Any]]] {
            for cases in variations.values {
                for variant in cases.values {
                    if let value = (variant["stringUnit"] as? [String: Any])?["value"] as? String { out.append(value) }
                }
            }
        }
        return out
    }

    private static let japanese = try! NSRegularExpression(pattern: "[\\u3040-\\u30ff\\u3400-\\u9fff]")
    private func hasJapanese(_ text: String) -> Bool {
        Self.japanese.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)) != nil
    }

    func testEveryCatalogKeyHasEnglishAndChinese() throws {
        for name in ["Localizable", "InfoPlist"] {
            var missing: [String] = []
            for (key, entry) in try catalog(name) where entry["shouldTranslate"] as? Bool != false {
                for language in Self.languages where values(entry, language).isEmpty { missing.append("\(language): \(key)") }
            }
            XCTAssertEqual(missing.sorted(), [], "\(name): \(missing.count) missing translation(s)")
        }
    }

    /// Keys without Japanese (symbols, names, "%@") are not translated; a Japanese one always is.
    func testOnlyTextsWithoutJapaneseAreLeftUntranslated() throws {
        let skipped = try catalog("Localizable").filter { $0.value["shouldTranslate"] as? Bool == false }.map(\.key)
        XCTAssertEqual(skipped.filter(hasJapanese).sorted(), [])
    }

    /// %@ / %lld / %1$@ … in a translation are the key's arguments: same kinds, same count (a wrong one crashes or
    /// prints garbage).
    func testTranslationsKeepTheFormatArguments() throws {
        let specifier = try NSRegularExpression(pattern: "%(?:(\\d+)\\$)?(?:ll|l)?([@dDuUxXoOfeEgGcCsSp])")
        func arguments(_ text: String) -> [String] {
            var positional: [Int: String] = [:]
            var sequential: [String] = []
            for match in specifier.matches(in: text, range: NSRange(text.startIndex..., in: text)) {
                let kind = String(text[Range(match.range(at: 2), in: text)!])
                let normalized = kind == "@" ? "@" : (["f", "e", "E", "g", "G"].contains(kind) ? "f" : "d")
                if let r = Range(match.range(at: 1), in: text), let index = Int(text[r]) { positional[index] = normalized } else { sequential.append(normalized) }
            }
            if positional.isEmpty { return sequential }
            return positional.keys.sorted().map { positional[$0]! }
        }
        var bad: [String] = []
        for (key, entry) in try catalog("Localizable") where entry["shouldTranslate"] as? Bool != false {
            let expected = arguments(key.replacingOccurrences(of: "%%", with: ""))
            for language in Self.languages {
                for value in values(entry, language) {
                    let got = arguments(value.replacingOccurrences(of: "%%", with: ""))
                    // A plural variation may leave its count out ("one item").
                    if got != expected && !(Set(got).isSubset(of: Set(expected)) && got.count < expected.count && (entry["localizations"] as? [String: Any]).map { ($0[language] as? [String: Any])?["variations"] != nil } == true) {
                        bad.append("\(language): \(key) → \(value)")
                    }
                }
            }
        }
        XCTAssertEqual(bad.sorted(), [])
    }

    func testTheChoiceSwitchesTheStringsAtOnce() {
        let language = UILanguage.shared
        let before = language.choice
        defer { language.set(before) }
        language.set(.en)
        XCTAssertEqual(language.acceptLanguage, "en")
        XCTAssertEqual(tr("キャンセル"), "Cancel")
        language.set(.zhHans)
        XCTAssertEqual(language.acceptLanguage, "zh-Hans")
        XCTAssertEqual(tr("キャンセル"), "取消")
        XCTAssertEqual(AppDates.weekdaysSundayFirst.count, 7)
        language.set(.ja)
        XCTAssertEqual(tr("キャンセル"), "キャンセル")
        XCTAssertEqual(AppDates.weekdaysSundayFirst.first, "日")
        XCTAssertEqual(AppDates.weekdaysMondayFirst.first, "月")
    }

    func testLanguageFromIdentifiers() {
        XCTAssertEqual(AppLanguage(identifier: "ja-JP"), .ja)
        XCTAssertEqual(AppLanguage(identifier: "en-US"), .en)
        XCTAssertEqual(AppLanguage(identifier: "en"), .en)
        XCTAssertEqual(AppLanguage(identifier: "zh-Hans-CN"), .zhHans)
        XCTAssertEqual(AppLanguage(identifier: "zh_CN"), .zhHans)
        XCTAssertNil(AppLanguage(identifier: "zh-Hant-TW"))
        XCTAssertNil(AppLanguage(identifier: "fr-FR"))
    }

    func testUserMeLocaleKeepsMissingApartFromNull() throws {
        func decode(_ extra: String) throws -> UserMe {
            let json = """
            {"id":"u1","username":"kano","display_name":"加納","role":"member","deactivated_at":null,"created_at":"2026-10-05T00:00:00Z",
             "updated_at":"2026-10-05T00:00:00Z","email":null,"must_change_password":false\(extra)}
            """
            return try JSON.snakeDecoder.decode(UserMe.self, from: Data(json.utf8))
        }
        XCTAssertEqual(try decode("").locale, .unsupported)
        XCTAssertEqual(try decode(#","locale":null"#).locale, .value(nil))
        XCTAssertEqual(try decode(#","locale":"zh-Hans""#).locale, .value("zh-Hans"))
        // The cache keeps it.
        let me = try decode(#","locale":"en""#)
        XCTAssertEqual(try JSON.plainDecoder.decode(UserMe.self, from: JSON.plainEncoder.encode(me)).locale, .value("en"))
    }
}
