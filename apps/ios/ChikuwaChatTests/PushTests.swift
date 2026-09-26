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
}
