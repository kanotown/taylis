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
        XCTAssertEqual(userDefaults?["NSPrivacyAccessedAPITypeReasons"] as? [String], ["CA92.1"])
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
}
