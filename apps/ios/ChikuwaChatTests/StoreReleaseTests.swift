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
}
