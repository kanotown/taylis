import XCTest
@testable import ChikuwaChat

/// LAB.md 「肩書と名簿」: the roster label is shown as the title, once; the cases the desktop and Android share
/// (apps/shared/title-display.json).
final class TitleDisplayTests: XCTestCase {
    private struct Vectors: Decodable {
        struct Line: Decodable { let affiliation: String; let rank: String?; let grade: String? }
        struct Case: Decodable { let name: String; let roster: Line?; let title: String?; let display: String?; let extra: String? }
        let cases: [Case]
    }

    private func vectors() throws -> Vectors {
        // The repository's own file (the simulator reads the Mac's disk).
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("shared/title-display.json")
        return try JSONDecoder().decode(Vectors.self, from: Data(contentsOf: url))
    }

    func testSharedCases() throws {
        let v = try vectors()
        XCTAssertGreaterThan(v.cases.count, 10)
        for c in v.cases {
            let line = c.roster.map { LabProfileOut(userId: "u", affiliation: $0.affiliation, rank: $0.rank, grade: $0.grade, updatedAt: "") }
            XCTAssertEqual(Roster.displayTitle(c.title, line), c.display, c.name)
            XCTAssertEqual(Roster.titleExtra(c.title, line), c.extra, c.name)
        }
    }
}
