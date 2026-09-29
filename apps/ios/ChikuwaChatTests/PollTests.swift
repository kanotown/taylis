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
