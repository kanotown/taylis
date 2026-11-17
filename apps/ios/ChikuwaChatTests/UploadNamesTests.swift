import XCTest
@testable import ChikuwaChat

/// Files without a real name get a time name; the cases the desktop and Android share (apps/shared/upload-names.json).
final class UploadNamesTests: XCTestCase {
    private struct Vectors: Decodable {
        struct NameCase: Decodable { let name: String; let kind: String; let ext: String; let time: String; let index: Int; let expected: String }
        struct Step: Decodable { let kind: String; let ext: String; let time: String; let expected: String }
        struct Sequence: Decodable { let name: String; let steps: [Step] }
        struct KindCase: Decodable { let mime: String; let kind: String }
        let names: [NameCase]
        let sequences: [Sequence]
        let kinds: [KindCase]
        let unnamed: [String]
        let named: [String]
    }

    private func vectors() throws -> Vectors {
        // The repository's own file (the simulator reads the Mac's disk).
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("shared/upload-names.json")
        return try JSONDecoder().decode(Vectors.self, from: Data(contentsOf: url))
    }

    /// "2026-11-17T09:05:03" as that wall-clock time in the simulator's time zone.
    private func local(_ time: String) -> Date {
        let parts = time.split(whereSeparator: { $0 == "-" || $0 == "T" || $0 == ":" }).compactMap { Int($0) }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = .current
        return calendar.date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2], hour: parts[3], minute: parts[4], second: parts[5]))!
    }

    func testSharedNames() throws {
        let v = try vectors()
        XCTAssertGreaterThan(v.names.count, 5)
        for c in v.names {
            XCTAssertEqual(UploadNames.name(kind: c.kind, ext: c.ext, at: local(c.time), index: c.index), c.expected, c.name)
        }
    }

    func testSharedSequences() throws {
        for sequence in try vectors().sequences {
            let namer = UploadNamer()
            XCTAssertEqual(sequence.steps.map { namer.next(kind: $0.kind, ext: $0.ext, at: local($0.time)) }, sequence.steps.map(\.expected), sequence.name)
        }
    }

    func testSharedKindsAndUnnamed() throws {
        let v = try vectors()
        for c in v.kinds { XCTAssertEqual(UploadNames.kind(mime: c.mime), c.kind, c.mime) }
        XCTAssertGreaterThan(v.unnamed.count, 10)
        XCTAssertGreaterThan(v.named.count, 10)
        for name in v.unnamed { XCTAssertTrue(UploadNames.isUnnamed(name), name) }
        for name in v.named { XCTAssertFalse(UploadNames.isUnnamed(name), name) }
    }

    /// Whatever calendar the phone shows (和暦), the name is Gregorian with ASCII digits.
    func testStampIsGregorianWhateverTheCalendar() {
        var japanese = Calendar(identifier: .japanese)
        japanese.timeZone = .current
        let date = japanese.date(from: DateComponents(era: 236, year: 8, month: 11, day: 17, hour: 9, minute: 5, second: 3))!
        XCTAssertEqual(UploadNames.stamp(date), "20261117_090503")
    }

    /// The camera's and the library's names go through the one counter: two in a second differ.
    func testNextCountsWithinTheSecond() {
        let date = local("2026-11-17T09:05:03")
        let namer = UploadNamer()
        XCTAssertEqual(namer.next(kind: "photo", ext: "jpg", at: date), "photo_20261117_090503.jpg")
        XCTAssertEqual(namer.next(kind: "photo", ext: "heic", at: date), "photo_20261117_090503_2.heic")
    }
}
