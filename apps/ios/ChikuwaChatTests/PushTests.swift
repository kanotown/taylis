import XCTest
@testable import ChikuwaChat

final class PushTests: XCTestCase {
    func testDeviceTokenHex() {
        XCTAssertEqual(Data([0x00, 0xab, 0xff]).hexString, "00abff")
    }

    func testProvisioningProfileEnvironment() {
        XCTAssertEqual(PushEnvironment.parse("<plist><dict><key>aps-environment</key>\n<string>development</string></dict></plist>"), "sandbox")
        XCTAssertEqual(PushEnvironment.parse("<key>aps-environment</key><string>production</string>"), "production")
        XCTAssertEqual(PushEnvironment.parse("<key>get-task-allow</key><true/>"), "sandbox")
    }

    func testStoreBuildsWithoutAProfileUseProduction() {
        // App Store / TestFlight builds have no embedded.mobileprovision: a sandbox registration would lose every push.
        XCTAssertEqual(PushEnvironment.resolve(profile: nil), "production")
        XCTAssertEqual(PushEnvironment.resolve(profile: "<key>aps-environment</key><string>development</string>"), "sandbox")
    }
}
