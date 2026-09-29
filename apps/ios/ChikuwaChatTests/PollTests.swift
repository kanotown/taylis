import ImageIO
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

final class PollFormTests: XCTestCase {
    /// The phone's 「アンケートを作成」 checks what the web and Android check, in the same words.
    func testChecksTheQuestionAndTheOptions() {
        XCTAssertEqual(PollForm.problem(question: "", options: ["a", "b"]), "質問を入れてください")
        XCTAssertEqual(PollForm.problem(question: "いつ？", options: ["月曜", " "]), "選択肢を 2 つ以上入れてください")
        XCTAssertEqual(PollForm.problem(question: "いつ？", options: ["月曜", "月曜 "]), "同じ選択肢が重なっています")
        XCTAssertNil(PollForm.problem(question: "いつ？", options: ["月曜", "火曜", ""]))
    }
}

final class EmojiAnimationTests: XCTestCase {
    /// Testers, 2026-09-29: GIF emoji did not move. A GIF gives its frames and when each shows.
    func testAnAnimatedGifGivesItsFrames() throws {
        let data = NSMutableData()
        let destination = try XCTUnwrap(CGImageDestinationCreateWithData(data, "com.compuserve.gif" as CFString, 3, nil))
        for color in [UIColor.red, .green, .blue] {
            let image = UIGraphicsImageRenderer(size: CGSize(width: 16, height: 16)).image { context in
                color.setFill(); context.fill(CGRect(x: 0, y: 0, width: 16, height: 16))
            }
            CGImageDestinationAddImage(destination, image.cgImage!, [kCGImagePropertyGIFDictionary: [kCGImagePropertyGIFDelayTime: 0.2]] as CFDictionary)
        }
        XCTAssertTrue(CGImageDestinationFinalize(destination))
        let decoded = try XCTUnwrap(CustomEmoji.decode(data as Data))
        let animation = try XCTUnwrap(decoded.animation)
        XCTAssertEqual(animation.frames.count, 3)
        XCTAssertEqual(animation.duration, 0.6, accuracy: 0.01)
        XCTAssertTrue(animation.frame(at: 0.1) === animation.frames[0])
        XCTAssertTrue(animation.frame(at: 0.3) === animation.frames[1])
        XCTAssertTrue(animation.frame(at: 1.1) === animation.frames[2]) // the second loop
        let still = UIGraphicsImageRenderer(size: CGSize(width: 16, height: 16)).image { _ in }.pngData()!
        XCTAssertNil(try XCTUnwrap(CustomEmoji.decode(still)).animation)
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
