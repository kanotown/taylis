import SwiftUI

/// Message body format (DATA_MODEL.md "本文の形式"): plain text plus a small inline subset.
enum BodyToken: Equatable {
    case text(String)
    case bold(String)
    case italic(String)
    case code(String)
    case codeBlock(String)
    case link(String)
    case mention(String)
    case mentionAll(String)
    case newline
}

enum BodyTokenizer {
    private static let pattern = try! NSRegularExpression(
        pattern: #"(```([\s\S]*?)```)|(`([^`\n]+)`)|(\*([^*\n]+)\*)|(_([^_\n]+)_)|(<@([0-9a-f-]{36})>)|(<!(channel|here)>)|(https?://[^\s<>]+)|(\n)"#)

    static func tokenize(_ body: String) -> [BodyToken] {
        var tokens: [BodyToken] = []
        let ns = body as NSString
        var last = 0
        for match in pattern.matches(in: body, range: NSRange(location: 0, length: ns.length)) {
            if match.range.location > last { tokens.append(.text(ns.substring(with: NSRange(location: last, length: match.range.location - last)))) }
            func group(_ index: Int) -> String? {
                let range = match.range(at: index)
                return range.location == NSNotFound ? nil : ns.substring(with: range)
            }
            if group(1) != nil { tokens.append(.codeBlock((group(2) ?? "").trimmingCharacters(in: CharacterSet(charactersIn: "\n")))) }
            else if group(3) != nil { tokens.append(.code(group(4) ?? "")) }
            else if group(5) != nil { tokens.append(.bold(group(6) ?? "")) }
            else if group(7) != nil { tokens.append(.italic(group(8) ?? "")) }
            else if group(9) != nil { tokens.append(.mention(group(10) ?? "")) }
            else if group(11) != nil { tokens.append(.mentionAll(group(12) ?? "")) }
            else if let url = group(13) { tokens.append(.link(url)) }
            else { tokens.append(.newline) }
            last = match.range.location + match.range.length
        }
        if last < ns.length { tokens.append(.text(ns.substring(from: last))) }
        return tokens
    }
}

struct MessageBodyView: View {
    let text: String
    let users: [String: UserPublic]

    var body: some View {
        let tokens = BodyTokenizer.tokenize(text)
        VStack(alignment: .leading, spacing: 4) {
            ForEach(Array(splitIntoLines(tokens).enumerated()), id: \.offset) { _, line in
                if line.count == 1, case .codeBlock(let code) = line[0] {
                    Text(code).font(.system(.body, design: .monospaced)).padding(6).background(Color.secondary.opacity(0.15)).cornerRadius(4)
                } else {
                    line.reduce(Text("")) { $0 + render($1) }
                }
            }
        }
        .textSelection(.enabled)
    }

    private func splitIntoLines(_ tokens: [BodyToken]) -> [[BodyToken]] {
        var lines: [[BodyToken]] = [[]]
        for token in tokens {
            switch token {
            case .newline: lines.append([])
            case .codeBlock: lines.append([token]); lines.append([])
            default: lines[lines.count - 1].append(token)
            }
        }
        return lines.filter { !$0.isEmpty }
    }

    private func render(_ token: BodyToken) -> Text {
        switch token {
        case .text(let text): return Text(text)
        case .bold(let text): return Text(text).bold()
        case .italic(let text): return Text(text).italic()
        case .code(let text): return Text(text).font(.system(.body, design: .monospaced))
        case .codeBlock(let text): return Text(text).font(.system(.body, design: .monospaced))
        case .link(let url):
            var attributed = AttributedString(url)
            attributed.link = URL(string: url)
            return Text(attributed)
        case .mention(let userId): return Text("@" + (users[userId]?.displayName ?? "unknown")).foregroundStyle(.blue)
        case .mentionAll(let target): return Text("@" + target).foregroundStyle(.blue)
        case .newline: return Text("\n")
        }
    }
}
