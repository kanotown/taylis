import SwiftUI

/// A long attachment / file name is shortened in its middle so the extension stays visible
/// (「研究報告書_最終版_修正…2026年度.pdf」, 2026-10-07). The split rule and its cases are shared with the desktop and
/// Android (apps/shared/file-name-ellipsis.json): `ext` from the last dot (not a leading one, at most 8 characters, no
/// whitespace), `tail` the stem's last 6 code points when the stem is longer than 12 (never starting inside a
/// character). A single line uses `.truncationMode(.middle)` on the whole name (`fileNameTruncation()`); a small tile
/// with two lines puts the stem on the first and the extension on the second (`FileNameTwoLines`).
enum FileNameEllipsis {
    struct Parts: Equatable {
        let head: String
        let tail: String
        let ext: String
        var stem: String { head + tail }
    }

    private static let maxExt = 8
    private static let tailLength = 6
    private static let tailFrom = 12
    private static let zwj: UInt32 = 0x200D

    private static func extendsPrevious(_ scalar: Unicode.Scalar) -> Bool {
        let cp = scalar.value
        if cp == zwj || (0xFE00...0xFE0F).contains(cp) || (0xE0100...0xE01EF).contains(cp) || (0x1F3FB...0x1F3FF).contains(cp)
            || (0xE0020...0xE007F).contains(cp) || (0x1160...0x11FF).contains(cp) { return true }
        switch scalar.properties.generalCategory {
        case .nonspacingMark, .spacingMark, .enclosingMark: return true
        default: return false
        }
    }

    private static func regionalIndicator(_ scalar: Unicode.Scalar) -> Bool { (0x1F1E6...0x1F1FF).contains(scalar.value) }

    private static func string(_ scalars: ArraySlice<Unicode.Scalar>) -> String {
        var view = String.UnicodeScalarView()
        view.append(contentsOf: scalars)
        return String(view)
    }

    static func split(_ name: String) -> Parts {
        let cps = Array(name.unicodeScalars)
        guard let dot = cps.lastIndex(of: ".") else { return Parts(head: name, tail: "", ext: "") }
        let extLength = cps.count - 1 - dot
        if dot <= 0 || extLength < 1 || extLength > maxExt || cps[(dot + 1)...].contains(where: { $0.properties.isWhitespace }) {
            return Parts(head: name, tail: "", ext: "")
        }
        let stem = cps[..<dot]
        let ext = string(cps[dot...])
        if stem.count <= tailFrom { return Parts(head: string(stem), tail: "", ext: ext) }
        var start = stem.count - tailLength
        while start > 0 {
            if extendsPrevious(stem[start]) || stem[start - 1].value == zwj { start -= 1; continue }
            if regionalIndicator(stem[start]) {
                var before = 0
                while start - 1 - before >= 0 && regionalIndicator(stem[start - 1 - before]) { before += 1 }
                if before % 2 == 1 { start -= 1; continue }
            }
            break
        }
        return Parts(head: string(stem[..<start]), tail: string(stem[start...]), ext: ext)
    }

    /// How one line of `name` truncates: in the middle when it has an extension, else at the end.
    static func truncation(_ name: String) -> Text.TruncationMode { split(name).ext.isEmpty ? .tail : .middle }
}

extension View {
    /// One line of a file name that keeps its extension visible (FileNameEllipsis). VoiceOver reads the whole name.
    func fileNameLine(_ name: String) -> some View {
        lineLimit(1).truncationMode(FileNameEllipsis.truncation(name))
    }
}

/// A small tile's two lines (the composer's pending files, a photo that failed): the stem on the first, cut in its
/// middle, the extension on the second; a name without an extension keeps two lines cut at the end. Read as one name.
struct FileNameTwoLines: View {
    let name: String

    var body: some View {
        let parts = FileNameEllipsis.split(name)
        if parts.ext.isEmpty {
            Text(name).lineLimit(2)
        } else {
            VStack(spacing: 0) {
                Text(parts.stem).lineLimit(1).truncationMode(.middle)
                Text(parts.ext).lineLimit(1)
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(name)
        }
    }
}
