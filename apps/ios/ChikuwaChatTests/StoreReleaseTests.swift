import XCTest
@testable import ChikuwaChat

/// docs/STORE_RELEASE.md: what App Store Connect checks in the bundle.
final class StoreReleaseTests: XCTestCase {
    func testPrivacyManifestIsBundled() throws {
        let url = try XCTUnwrap(Bundle.main.url(forResource: "PrivacyInfo", withExtension: "xcprivacy"),
                                "PrivacyInfo.xcprivacy is not in the app's resources")
        let plist = try XCTUnwrap(
            PropertyListSerialization.propertyList(from: Data(contentsOf: url), format: nil) as? [String: Any])
        XCTAssertEqual(plist["NSPrivacyTracking"] as? Bool, false)
        let apis = try XCTUnwrap(plist["NSPrivacyAccessedAPITypes"] as? [[String: Any]])
        let userDefaults = apis.first { $0["NSPrivacyAccessedAPIType"] as? String == "NSPrivacyAccessedAPICategoryUserDefaults" }
        // CA92.1: the app's own defaults; 1C8F.1: the App Group's, shared with the Share Extension (MOBILE_UI.md §21).
        XCTAssertEqual(userDefaults?["NSPrivacyAccessedAPITypeReasons"] as? [String], ["CA92.1", "1C8F.1"])
        let collected = try XCTUnwrap(plist["NSPrivacyCollectedDataTypes"] as? [[String: Any]])
        XCTAssertFalse(collected.isEmpty)
        for entry in collected {
            XCTAssertEqual(entry["NSPrivacyCollectedDataTypeTracking"] as? Bool, false)
        }
    }

    func testVersionIsSemanticAndBuildIsAnInteger() {
        let info = Bundle.main.infoDictionary ?? [:]
        let version = info["CFBundleShortVersionString"] as? String ?? ""
        XCTAssertNotNil(version.wholeMatch(of: /\d+\.\d+\.\d+/), "CFBundleShortVersionString \(version) is not X.Y.Z")
        XCTAssertNotNil(Int(info["CFBundleVersion"] as? String ?? ""), "CFBundleVersion is not an integer")
    }

    /// PUSH_NOTIFICATIONS.md §16: the Notification Service Extension is embedded, and its version and build number are
    /// the app's (App Store Connect warns otherwise). Raise both Info.plist files (and project.yml) together.
    func testNotificationServiceExtensionIsEmbeddedWithTheAppsVersion() throws {
        let url = try XCTUnwrap(Bundle.main.builtInPlugInsURL?.appendingPathComponent("NotificationService.appex"))
        let appex = try XCTUnwrap(Bundle(url: url), "NotificationService.appex is not embedded")
        let app = Bundle.main.infoDictionary ?? [:]
        let ext = appex.infoDictionary ?? [:]
        XCTAssertEqual(ext["CFBundleShortVersionString"] as? String, app["CFBundleShortVersionString"] as? String)
        XCTAssertEqual(ext["CFBundleVersion"] as? String, app["CFBundleVersion"] as? String,
                       "raise CFBundleVersion in NotificationService/Info.plist too")
        XCTAssertEqual(appex.bundleIdentifier, "jp.chikuwachat.ios.NotificationService")
        let activities = app["NSUserActivityTypes"] as? [String] ?? []
        XCTAssertTrue(activities.contains("INSendMessageIntent"))
    }

    /// MOBILE_UI.md §21: the Share Extension is embedded with the app's version and build number, accepts files,
    /// pictures, videos, links and text, and names the same App Group and Keychain group as the app.
    func testShareExtensionIsEmbeddedWithTheAppsVersionAndGroups() throws {
        let url = try XCTUnwrap(Bundle.main.builtInPlugInsURL?.appendingPathComponent("ShareExtension.appex"))
        let appex = try XCTUnwrap(Bundle(url: url), "ShareExtension.appex is not embedded")
        let app = Bundle.main.infoDictionary ?? [:]
        let ext = appex.infoDictionary ?? [:]
        XCTAssertEqual(ext["CFBundleShortVersionString"] as? String, app["CFBundleShortVersionString"] as? String)
        XCTAssertEqual(ext["CFBundleVersion"] as? String, app["CFBundleVersion"] as? String,
                       "raise CFBundleVersion in ShareExtension/Info.plist too")
        XCTAssertEqual(appex.bundleIdentifier, "jp.chikuwachat.ios.ShareExtension")
        XCTAssertEqual(ext["TaylisAppGroup"] as? String, "group.jp.chikuwachat.ios")
        XCTAssertEqual(ext["TaylisAppGroup"] as? String, app["TaylisAppGroup"] as? String)
        XCTAssertEqual(ext["TaylisKeychainGroup"] as? String, app["TaylisKeychainGroup"] as? String)
        XCTAssertTrue((app["TaylisKeychainGroup"] as? String ?? "").hasSuffix(".jp.chikuwachat.ios.shared"))
        let extensionInfo = try XCTUnwrap(ext["NSExtension"] as? [String: Any])
        XCTAssertEqual(extensionInfo["NSExtensionPointIdentifier"] as? String, "com.apple.share-services")
        let rule = try XCTUnwrap((extensionInfo["NSExtensionAttributes"] as? [String: Any])?["NSExtensionActivationRule"] as? [String: Any])
        for key in ["NSExtensionActivationSupportsFileWithMaxCount", "NSExtensionActivationSupportsImageWithMaxCount",
                    "NSExtensionActivationSupportsMovieWithMaxCount", "NSExtensionActivationSupportsAttachmentsWithMaxCount"] {
            XCTAssertEqual(rule[key] as? Int, 10, key)
        }
        XCTAssertEqual(rule["NSExtensionActivationSupportsWebURLWithMaxCount"] as? Int, 1)
        XCTAssertEqual(rule["NSExtensionActivationSupportsText"] as? Bool, true)
    }
}
