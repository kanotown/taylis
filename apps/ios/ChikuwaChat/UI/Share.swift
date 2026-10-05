import Foundation

/// Sharing a message into another conversation (M13c): a comment, the original as a quote, its permalink.
enum Share {
    static func body(original: String, permalink: String, comment: String, maxQuote: Int = 300) -> String {
        let text = original.trimmingCharacters(in: .whitespacesAndNewlines)
        let clipped = text.count > maxQuote ? String(text.prefix(maxQuote)).trimmingCharacters(in: .whitespaces) + "…" : text
        let quote = (clipped.isEmpty ? tr("(添付ファイル)") : clipped).split(separator: "\n", omittingEmptySubsequences: false).map { "> " + $0 }.joined(separator: "\n")
        return [comment.trimmingCharacters(in: .whitespacesAndNewlines), quote, permalink].filter { !$0.isEmpty }.joined(separator: "\n")
    }
}
