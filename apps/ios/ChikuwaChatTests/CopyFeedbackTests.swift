import UIKit
import XCTest
@testable import ChikuwaChat

/// 2026-10-08: a copy button puts the text on the pasteboard and says so in the app's toast (iOS itself says nothing).
@MainActor
final class CopyFeedbackTests: XCTestCase {
    func testCopySaysCopiedInTheToast() {
        let controller = AppController()
        let pasteboard = UIPasteboard.withUniqueName()
        defer { UIPasteboard.remove(withName: pasteboard.name) }
        controller.copyToClipboard("Tmp-pass-1", pasteboard: pasteboard)
        XCTAssertEqual(pasteboard.string, "Tmp-pass-1")
        XCTAssertEqual(controller.notice, tr("コピーしました"))
    }

    func testCopyNamesWhatWasCopied() {
        let controller = AppController()
        let pasteboard = UIPasteboard.withUniqueName()
        defer { UIPasteboard.remove(withName: pasteboard.name) }
        controller.copyToClipboard("hello", notice: tr("テキストをコピーしました"), pasteboard: pasteboard)
        XCTAssertEqual(pasteboard.string, "hello")
        XCTAssertEqual(controller.notice, tr("テキストをコピーしました"))
    }
}
