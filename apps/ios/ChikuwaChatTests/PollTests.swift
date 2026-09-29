import XCTest
@testable import ChikuwaChat

final class PollTests: XCTestCase {
    /// Testers, 2026-09-29: the question came twice in a row (the server's 「📊 質問」 text, then the card).
    func testThePollsTextIsLeftOutWhenTheServerMadeItFromTheQuestion() {
        let poll = PollOut(question: "ランチはどこ?", options: ["そば", "カレー"])
        XCTAssertTrue(PollCardView.hidesBody("📊 ランチはどこ?", poll: poll))
        XCTAssertFalse(PollCardView.hidesBody("明日のランチを決めたいです", poll: poll))  // written by the author
        XCTAssertFalse(PollCardView.hidesBody("📊 ランチはどこ?", poll: nil))
    }
}

final class CustomEmojiSizeTests: XCTestCase {
    /// The cached copy is drawn tall, then shown at any height from the same pixels (a heading's emoji grows).
    func testTheCachedImageShowsAtTheHeightAsked() {
        let source = UIGraphicsImageRenderer(size: CGSize(width: 64, height: 32)).image { context in
            UIColor.orange.setFill(); context.fill(CGRect(x: 0, y: 0, width: 64, height: 32))
        }
        let stored = CustomEmoji.inlineImage(source)
        XCTAssertEqual(stored.size.height, CustomEmoji.storedHeight, accuracy: 0.01)
        XCTAssertEqual(stored.size.width, CustomEmoji.storedHeight * 2, accuracy: 0.5)
        let body = CustomEmoji.sized(stored, height: 20), heading = CustomEmoji.sized(stored, height: 32)
        XCTAssertEqual(body.size.height, 20, accuracy: 0.01)
        XCTAssertEqual(body.size.width, 40, accuracy: 0.5)
        XCTAssertEqual(heading.size.height, 32, accuracy: 0.01)
        XCTAssertEqual(heading.cgImage?.height, stored.cgImage?.height) // no new drawing
    }
}
