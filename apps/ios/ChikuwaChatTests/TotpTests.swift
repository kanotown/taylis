import XCTest
@testable import ChikuwaChat

final class TotpTests: XCTestCase {
    func testNormalisesAndRecognisesAppCodes() {
        XCTAssertEqual(Totp.normalize(" 123 456 "), "123456")
        XCTAssertTrue(Totp.isCode("123 456"))
        XCTAssertFalse(Totp.isCode("abcde-fghjk"))
        XCTAssertFalse(Totp.isCode("12345"))
    }

    func testExplainsFailuresInWords() {
        XCTAssertEqual(Totp.errorText(ApiError.api(status: 422, code: "invalid_totp", message: "Invalid two-factor code")), "認証コードが違います")
        XCTAssertEqual(Totp.errorText(ApiError.api(status: 422, code: "invalid_password", message: "Invalid password")), "パスワードが違います")
        XCTAssertNil(Totp.errorText(ApiError.api(status: 500, code: "server_error", message: "boom")))
    }

    func testDecodesTheQrImageAndFormatsRecoveryCodes() {
        // A 1x1 PNG.
        let png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="
        XCTAssertNotNil(Totp.qrImage(base64: png))
        XCTAssertNil(Totp.qrImage(base64: "not base64!"))
        XCTAssertEqual(Totp.recoveryCodesText(["abcde-fghjk", "mnpqr-stuvw"]), "taylis の回復コード (各 1 回だけ使えます)\n\nabcde-fghjk\nmnpqr-stuvw")
    }
}
