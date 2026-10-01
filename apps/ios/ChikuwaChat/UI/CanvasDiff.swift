import Foundation

/// M58: the history's comparison of two versions of a canvas (CANVAS.md §4.9 「現在の版との行単位の差分」), ported from the
/// desktop's `ui/canvasDiff.ts`: lines added and removed (Myers' diff, common head and tail trimmed first), and inside a
/// line only touched up the words that changed. Words are cut as the server's merge cuts them (merge.py): spaces, one
/// punctuation mark, or a run of one script — kanji, hiragana, katakana, letters and digits. Display only: merging stays
/// on the server. Lengths are UTF-16 (the desktop's string lengths).
enum CanvasDiff {
    enum Kind: Equatable { case same, add, del }

    struct WordPiece: Equatable {
        var text: String
        var changed: Bool
    }

    struct Line: Equatable {
        var kind: Kind
        var text: String
        /// 1-based line numbers in the older / newer text.
        var oldNo: Int?
        var newNo: Int?
        /// A touched-up line: which words changed (a removed line's old words, an added line's new ones).
        var words: [WordPiece]? = nil
    }

    enum Row: Equatable {
        case line(Line)
        /// A stretch of kept lines folded into 「… n 行 …」.
        case skip(Int)
    }

    struct Op: Equatable {
        var kind: Kind
        var a: Int
        var b: Int
    }

    /// Beyond this many edits the middle is taken as replaced as a whole (a pasted-over document): still correct, less fine.
    static let maxEdits = 3_000

    /// Myers' O((N+M)·D) shortest edit script between `a` and `b`, common head and tail trimmed first.
    static func editScript<T: Equatable>(_ a: [T], _ b: [T], maxEdits: Int = maxEdits) -> [Op] {
        var head = 0
        while head < a.count && head < b.count && a[head] == b[head] { head += 1 }
        var tail = 0
        while tail < a.count - head && tail < b.count - head && a[a.count - 1 - tail] == b[b.count - 1 - tail] { tail += 1 }
        var ops = (0..<head).map { Op(kind: .same, a: $0, b: $0) }
        let n = a.count - head - tail
        let m = b.count - head - tail
        ops += middleScript(a, b, offset: head, n: n, m: m, maxEdits: maxEdits)
        for i in 0..<tail { ops.append(Op(kind: .same, a: head + n + i, b: head + m + i)) }
        return ops
    }

    private static func middleScript<T: Equatable>(_ a: [T], _ b: [T], offset off: Int, n: Int, m: Int, maxEdits: Int) -> [Op] {
        func removeAll() -> [Op] {
            (0..<n).map { Op(kind: .del, a: off + $0, b: -1) } + (0..<m).map { Op(kind: .add, a: -1, b: off + $0) }
        }
        if n == 0 || m == 0 { return removeAll() }
        let max = Swift.min(n + m, Swift.max(1, maxEdits))
        let size = 2 * max + 1
        var v = [Int](repeating: 0, count: size)
        // The frontier before each step, only the part the walk back reads (k − 1 … k + 1 for |k| ≤ d): O(D²) memory.
        var trace: [(lo: Int, at: [Int])] = []
        var found = -1
        search: for d in 0...max {
            let lo = Swift.max(0, max - d - 1)
            trace.append((lo, Array(v[lo..<Swift.min(size, max + d + 2)])))
            var k = -d
            while k <= d {
                let down = k == -d || (k != d && v[max + k - 1] < v[max + k + 1])
                var x = down ? v[max + k + 1] : v[max + k - 1] + 1
                var y = x - k
                while x < n && y < m && a[off + x] == b[off + y] {
                    x += 1
                    y += 1
                }
                v[max + k] = x
                if x >= n && y >= m {
                    found = d
                    break search
                }
                k += 2
            }
        }
        if found < 0 { return removeAll() }
        // Walk back through the saved frontiers.
        var ops: [Op] = []
        var x = n
        var y = m
        var d = found
        while d > 0 {
            let frame = trace[d]
            func at(_ k: Int) -> Int { frame.at[max + k - frame.lo] }
            let k = x - y
            let down = k == -d || (k != d && at(k - 1) < at(k + 1))
            let prevK = down ? k + 1 : k - 1
            let prevX = at(prevK)
            let prevY = prevX - prevK
            while x > prevX && y > prevY {
                x -= 1
                y -= 1
                ops.append(Op(kind: .same, a: off + x, b: off + y))
            }
            if down {
                y -= 1
                ops.append(Op(kind: .add, a: -1, b: off + y))
            } else {
                x -= 1
                ops.append(Op(kind: .del, a: off + x, b: -1))
            }
            d -= 1
        }
        while x > 0 && y > 0 {
            x -= 1
            y -= 1
            ops.append(Op(kind: .same, a: off + x, b: off + y))
        }
        return ops.reversed()
    }

    private static let wordPattern = try! NSRegularExpression(
        pattern: #"\n|[^\S\n]+|[\p{Script=Han}々〆ヶ]+|\p{Script=Hiragana}+|[\p{Script=Katakana}ー]+|[\p{L}\p{N}_]+|."#)

    /// A line cut into words as the server's merge cuts it.
    static func words(_ text: String) -> [String] {
        let ns = text as NSString
        return wordPattern.matches(in: text, range: NSRange(location: 0, length: ns.length)).map { ns.substring(with: $0.range) }
    }

    private static func length(_ text: String) -> Int { text.utf16.count }

    /// The words that changed between a removed line and the line that took its place, or nil when the two share too
    /// little to be read as one line touched up (then they show as a plain removal and addition).
    static func wordDiff(_ before: String, _ after: String) -> (before: [WordPiece], after: [WordPiece])? {
        let a = words(before)
        let b = words(after)
        if a.count + b.count > 2_000 { return nil }
        let ops = editScript(a, b, maxEdits: 400)
        let same = ops.filter { $0.kind == .same }.reduce(0) { $0 + length(a[$1.a]) }
        let longer = Swift.max(length(before), length(after))
        if longer == 0 || Double(same) / Double(longer) < 0.4 { return nil }
        func pieces(_ kind: Kind) -> [WordPiece] {
            var out: [WordPiece] = []
            for op in ops {
                if op.kind == .same {
                    push(&out, kind == .del ? a[op.a] : b[op.b], changed: false)
                } else if op.kind == kind {
                    push(&out, kind == .del ? a[op.a] : b[op.b], changed: true)
                }
            }
            return out
        }
        return (pieces(.del), pieces(.add))
    }

    private static func push(_ out: inout [WordPiece], _ text: String, changed: Bool) {
        if let last = out.last, last.changed == changed {
            out[out.count - 1].text += text
        } else {
            out.append(WordPiece(text: text, changed: changed))
        }
    }

    /// Every line of `after` against `before`: kept, removed or added, with the changed words of lines touched up.
    static func lines(_ before: String, _ after: String) -> [Line] {
        let a = before.isEmpty ? [] : before.components(separatedBy: "\n")
        let b = after.isEmpty ? [] : after.components(separatedBy: "\n")
        let ops = editScript(a, b)
        var out: [Line] = []
        var i = 0
        while i < ops.count {
            let op = ops[i]
            if op.kind == .same {
                out.append(Line(kind: .same, text: a[op.a], oldNo: op.a + 1, newNo: op.b + 1))
                i += 1
                continue
            }
            // A run of removals and additions: paired in order for the word view.
            var dels: [Line] = []
            var adds: [Line] = []
            while i < ops.count && ops[i].kind != .same {
                let o = ops[i]
                if o.kind == .del {
                    dels.append(Line(kind: .del, text: a[o.a], oldNo: o.a + 1, newNo: nil))
                } else {
                    adds.append(Line(kind: .add, text: b[o.b], oldNo: nil, newNo: o.b + 1))
                }
                i += 1
            }
            for p in 0..<Swift.min(dels.count, adds.count) {
                guard let pair = wordDiff(dels[p].text, adds[p].text) else { continue }
                dels[p].words = pair.before
                adds[p].words = pair.after
            }
            out += dels + adds
        }
        return out
    }

    /// The changed lines with `context` lines around them; longer stretches of kept lines fold into a 「… n 行 …」 row.
    static func rows(_ lines: [Line], context: Int = 3) -> [Row] {
        var keep = [Bool](repeating: false, count: lines.count)
        for (index, line) in lines.enumerated() where line.kind != .same {
            for k in Swift.max(0, index - context)...Swift.min(lines.count - 1, index + context) { keep[k] = true }
        }
        var rows: [Row] = []
        var skipped = 0
        for (index, line) in lines.enumerated() {
            if keep[index] {
                if skipped > 0 { rows.append(.skip(skipped)) }
                skipped = 0
                rows.append(.line(line))
            } else {
                skipped += 1
            }
        }
        if skipped > 0 { rows.append(.skip(skipped)) }
        return rows
    }

    /// 「+3 −1」 counts of a comparison.
    static func counts(_ rows: [Row]) -> (added: Int, removed: Int) {
        var added = 0
        var removed = 0
        for case .line(let line) in rows {
            if line.kind == .add { added += 1 } else if line.kind == .del { removed += 1 }
        }
        return (added, removed)
    }
}
