import SwiftUI
import XCTest
@testable import ChikuwaChat

/// A long file name keeps its extension visible; the cases the desktop and Android share
/// (apps/shared/file-name-ellipsis.json).
final class FileNameEllipsisTests: XCTestCase {
    private struct Vectors: Decodable {
        struct Case: Decodable { let name: String; let input: String; let head: String; let tail: String; let ext: String }
        let cases: [Case]
    }

    private func vectors() throws -> Vectors {
        // The repository's own file (the simulator reads the Mac's disk).
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("shared/file-name-ellipsis.json")
        return try JSONDecoder().decode(Vectors.self, from: Data(contentsOf: url))
    }

    func testSharedCases() throws {
        let v = try vectors()
        XCTAssertGreaterThan(v.cases.count, 20)
        for c in v.cases {
            let parts = FileNameEllipsis.split(c.input)
            XCTAssertEqual(parts, FileNameEllipsis.Parts(head: c.head, tail: c.tail, ext: c.ext), c.name)
            // Scalars, not Characters: a split never changes the name's code points.
            XCTAssertEqual(Array((parts.head + parts.tail + parts.ext).unicodeScalars), Array(c.input.unicodeScalars), c.name)
        }
    }

    func testTruncatesInTheMiddleOnlyWithAnExtension() {
        XCTAssertEqual(FileNameEllipsis.truncation("研究報告書_最終版_修正済み_2026年度.pdf"), .middle)
        XCTAssertEqual(FileNameEllipsis.truncation(".env"), .tail)
        XCTAssertEqual(FileNameEllipsis.truncation("README"), .tail)
    }
}
