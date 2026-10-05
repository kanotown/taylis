import Foundation

/// Slash commands (M13b): a few Slack-style shortcuts that map onto existing actions, client-side only.
enum SlashCommands {
    struct Command: Identifiable, Equatable {
        let name: String
        let usage: String
        let description: String
        /// Not available in a DM.
        var channelOnly = false
        var id: String { name }
    }

    struct Parsed: Equatable {
        let name: String
        let args: String
        let known: Bool
    }

    /// The slash command typed in Japanese (not translated: it is what people type).
    static let scheduleName = "日程"  // i18n-ignore

    static var all: [Command] { [
        Command(name: "status", usage: tr("/status [絵文字] 文"), description: tr("ステータスを設定 (/status clear で消す)")),
        Command(name: "dnd", usage: "/dnd 30m | 1h | 2h | 4h | tomorrow | off", description: tr("通知を一時停止")),
        Command(name: "topic", usage: tr("/topic 文"), description: tr("チャンネルのトピックを変更"), channelOnly: true),
        Command(name: "invite", usage: tr("/invite @名前 …"), description: tr("メンバーを追加"), channelOnly: true),
        Command(name: "leave", usage: "/leave", description: tr("チャンネルから退出"), channelOnly: true),
        Command(name: "join", usage: tr("/join #チャンネル"), description: tr("公開チャンネルに参加")),
        Command(name: "dm", usage: tr("/dm @名前"), description: tr("ダイレクトメッセージを開く")),
        Command(name: "mute", usage: "/mute [1h | 8h | tomorrow]", description: tr("この会話の通知を止める")),
        Command(name: "unmute", usage: "/unmute", description: tr("この会話の通知を再開")),
        Command(name: "me", usage: tr("/me 文"), description: tr("動作を斜体で投稿")),
        Command(name: "shrug", usage: tr("/shrug [文]"), description: tr("¯\\_(ツ)_/¯ を添えて投稿")),
        Command(name: "poll", usage: tr("/poll 質問 | 選択肢 | 選択肢 …"), description: tr("投票を作る")),
        // M54 (SCHEDULING.md): a scheduling poll; the form opens, with the dates (and times) typed after it as candidates.
        Command(name: scheduleName, usage: tr("/日程 [題名] 日付 …"), description: tr("日程調整を作る (候補に ○ △ × で答える)")),
        Command(name: "help", usage: "/help", description: tr("コマンド一覧")),
    ] }

    /// In a code span, so the underscores do not read as italics (the light markdown has no escapes).
    static let shrug = "`¯\\_(ツ)_/¯`"  // i18n-ignore

    // M30: any script, so `/日報` (a template) and `/日程` are commands too.
    private static let pattern = try! NSRegularExpression(pattern: #"^/([\p{L}\p{N}_-]+)(?:\s+([\s\S]*))?$"#)
    private static let prefixPattern = try! NSRegularExpression(pattern: #"^/([\p{L}\p{N}_-]*)$"#)
    private static let durationPattern = try! NSRegularExpression(pattern: #"^(\d{1,3})\s*(m|min|h|hour|hours|d|day|days)$"#)
    private static let shortcodePattern = try! NSRegularExpression(pattern: #"^:[a-z0-9_+-]+:$"#)

    /// `/name args` at the start of the text; nil when the text is not a command at all.
    static func parse(_ text: String) -> Parsed? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let ns = trimmed as NSString
        guard let match = pattern.firstMatch(in: trimmed, range: NSRange(location: 0, length: ns.length)) else { return nil }
        let name = ns.substring(with: match.range(at: 1)).lowercased()
        let args = match.range(at: 2).location == NSNotFound ? "" : ns.substring(with: match.range(at: 2)).trimmingCharacters(in: .whitespacesAndNewlines)
        return Parsed(name: name, args: args, known: all.contains { $0.name == name })
    }

    /// Commands whose name starts with what was typed (`/`, `/st` …); empty once a space follows.
    static func candidates(_ text: String) -> [Command] {
        guard let prefix = typedPrefix(text) else { return [] }
        return all.filter { $0.name.hasPrefix(prefix) }
    }

    /// What follows the `/` while a command's name is being typed; nil otherwise.
    static func typedPrefix(_ text: String) -> String? {
        let ns = text as NSString
        guard let match = prefixPattern.firstMatch(in: text, range: NSRange(location: 0, length: ns.length)) else { return nil }
        return ns.substring(with: match.range(at: 1)).lowercased()
    }

    static func tomorrowMorning(now: Date = Date(), calendar: Calendar = .current) -> Date {
        let next = calendar.date(byAdding: .day, value: 1, to: now) ?? now
        return calendar.date(bySettingHour: 8, minute: 0, second: 0, of: next) ?? next
    }

    /// `30m`, `1h`, `2d`, `tomorrow` (08:00) → when a pause ends; nil for anything else.
    static func duration(_ arg: String, now: Date = Date()) -> Date? {
        let word = arg.trimmingCharacters(in: .whitespaces).lowercased()
        if word == "tomorrow" || word == "明日" { return tomorrowMorning(now: now) }  // i18n-ignore
        let ns = word as NSString
        guard let match = durationPattern.firstMatch(in: word, range: NSRange(location: 0, length: ns.length)),
              let amount = Double(ns.substring(with: match.range(at: 1))) else { return nil }
        let unit = ns.substring(with: match.range(at: 2)).first!
        let seconds: Double = unit == "m" ? 60 : unit == "h" ? 3600 : 86_400
        return now.addingTimeInterval(amount * seconds)
    }

    /// The optional leading emoji (a glyph or `:shortcode:`) and the text of `/status`.
    static func splitStatus(_ args: String) -> (emoji: String?, text: String) {
        let trimmed = args.trimmingCharacters(in: .whitespaces)
        guard let first = trimmed.split(separator: " ", maxSplits: 1, omittingEmptySubsequences: true).first else { return (nil, "") }
        let token = String(first)
        let rest = trimmed.dropFirst(token.count).trimmingCharacters(in: .whitespaces)
        let ns = token as NSString
        if shortcodePattern.firstMatch(in: token, range: NSRange(location: 0, length: ns.length)) != nil {
            return (Emoji.replaceShortcodes(token), rest)
        }
        let isEmoji = token.unicodeScalars.allSatisfy { scalar in
            scalar.properties.isEmojiPresentation || scalar.properties.isEmojiModifier || scalar.value == 0xFE0F || scalar.value == 0x200D
                || (scalar.properties.isEmoji && scalar.value > 0x2000)
        }
        return isEmoji ? (token, rest) : (nil, trimmed)
    }
}
