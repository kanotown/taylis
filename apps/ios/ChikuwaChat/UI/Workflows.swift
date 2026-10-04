import Foundation

/// M95 (docs/WORKFLOWS.md §3 and §8): the pure parts of a workflow's form on the phone — the defaults, the value checks
/// and the preview. The server renders the message that is posted (server/app/modules/workflows/render.py); the preview
/// and the checks follow the same rules, held to them by apps/shared/workflows.json (the desktop's ui/workflows.ts and
/// Android read the same cases). Defaults are filled here, on the device that opens the form.
enum Workflows {
    /// A field's value in the form: text (short, long, select, date, time, datetime), people, or a checkbox.
    enum Value: Equatable {
        case text(String)
        case users([String])
        case flag(Bool)

        var json: JSONValue {
            switch self {
            case .text(let text): return .string(text)
            case .users(let ids): return .array(ids.map(JSONValue.string))
            case .flag(let on): return .bool(on)
            }
        }

        var text: String { if case .text(let text) = self { return text } else { return "" } }
        var users: [String] { if case .users(let ids) = self { return ids } else { return [] } }
        var flag: Bool { if case .flag(let on) = self { return on } else { return false } }
    }

    static let defaultEmoji = "⚡"
    static let maxText = 200
    static let maxTextarea = 4000
    static let maxUsers = 20
    static let weekdays = ["月", "火", "水", "木", "金", "土", "日"]  // 0 = Monday

    /// `details.fields` reasons, in the desktop's words.
    static func errorText(_ reason: String) -> String {
        switch reason {
        case "required": return "入力してください"
        case "too_long": return "長すぎます"
        case "not_an_option": return "選択肢から選んでください"
        case "user_not_found": return "選べない人が含まれています"
        default: return "形式が正しくありません"
        }
    }

    private static let placeholder = try! NSRegularExpression(pattern: #"\{\{\s*([^{}\s]+)\s*\}\}"#)
    private static let keyPattern = try! NSRegularExpression(pattern: #"^[\p{L}\p{N}_]{1,30}$"#)

    private static func nfc(_ text: String) -> String { text.precomposedStringWithCanonicalMapping }
    private static func length(_ text: String) -> Int { text.unicodeScalars.count }

    static func validKey(_ key: String) -> Bool {
        guard key == nfc(key), !key.contains("\n") else { return false }
        return keyPattern.firstMatch(in: key, range: NSRange(location: 0, length: (key as NSString).length)) != nil
    }

    // MARK: shapes

    private static func digits(_ text: Substring, _ count: Int) -> Int? {
        guard text.count == count, text.allSatisfy({ $0.isASCII && $0.isNumber }) else { return nil }
        return Int(text)
    }

    /// `YYYY-MM-DD` that names a real day.
    static func parseDate(_ value: String) -> Templates.Day? {
        let parts = value.split(separator: "-", omittingEmptySubsequences: false)
        guard parts.count == 3, let y = digits(parts[0], 4), let m = digits(parts[1], 2), let d = digits(parts[2], 2) else { return nil }
        return Templates.Day.make(y, m, d)
    }

    /// `HH:MM`, 00:00–23:59.
    static func validTime(_ value: String) -> Bool {
        let parts = value.split(separator: ":", omittingEmptySubsequences: false)
        guard parts.count == 2, let h = digits(parts[0], 2), let m = digits(parts[1], 2) else { return false }
        return h <= 23 && m <= 59
    }

    /// `YYYY-MM-DDTHH:MM` split into its date and time; nil when it is not one.
    static func parseDatetime(_ value: String) -> (date: String, time: String)? {
        let parts = value.split(separator: "T", omittingEmptySubsequences: false)
        guard parts.count == 2, parseDate(String(parts[0])) != nil, validTime(String(parts[1])) else { return nil }
        return (String(parts[0]), String(parts[1]))
    }

    static func isoDay(_ day: Templates.Day) -> String { String(format: "%04d-%02d-%02d", day.year, day.month, day.day) }

    /// 「2026年7月28日 (火)」 for `YYYY-MM-DD`; "" when it is not a date.
    static func dateLabel(_ value: String) -> String {
        guard let day = parseDate(value) else { return "" }
        return "\(day.year)年\(day.month)月\(day.day)日 (\(weekdays[day.weekdayIndex]))"
    }

    static func emptyValue(_ field: WorkflowField) -> Value {
        field.type == "user" ? .users([]) : field.type == "checkbox" ? .flag(false) : .text("")
    }

    static func isBlank(_ field: WorkflowField, _ value: Value) -> Bool {
        switch value {
        case .flag(let on): return !on
        case .users(let ids): return ids.isEmpty
        case .text(let text): return field.type == "checkbox" ? true : text.isEmpty
        }
    }

    // MARK: checks (the server's _clean_one)

    private static func removingControls(_ text: String) -> String {
        var scalars = String.UnicodeScalarView()
        for scalar in text.unicodeScalars {
            let v = scalar.value
            if v <= 0x08 || v == 0x0B || v == 0x0C || (0x0E...0x1F).contains(v) || v == 0x7F { continue }
            scalars.append(scalar)
        }
        return String(scalars)
    }

    /// The value in its stored shape, or the reason it is refused.
    private static func cleanOne(_ field: WorkflowField, _ raw: JSONValue?) -> Result<Value, CleanError> {
        guard let raw, raw != .null else { return .success(emptyValue(field)) }
        switch field.type {
        case "checkbox":
            if case .bool(let on) = raw { return .success(.flag(on)) }
            return .failure(CleanError("invalid"))
        case "user":
            let items: [JSONValue]
            if case .string = raw { items = [raw] } else if case .array(let list) = raw { items = list } else { return .failure(CleanError("invalid")) }
            var ids: [String] = []
            for item in items {
                guard case .string(let text) = item else { return .failure(CleanError("invalid")) }
                guard text.count == 36, UUID(uuidString: text) != nil else { return .failure(CleanError("invalid")) }
                let id = text.lowercased()
                if !ids.contains(id) { ids.append(id) }
            }
            if ids.count > (field.multiple ? maxUsers : 1) { return .failure(CleanError("too_long")) }
            return .success(.users(ids))
        default:
            guard case .string(let text) = raw else { return .failure(CleanError("invalid")) }
            var value = removingControls(text.replacingOccurrences(of: "\r\n", with: "\n"))
            if field.type == "text" {
                value = value.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
                return length(value) > maxText ? .failure(CleanError("too_long")) : .success(.text(value))
            }
            value = value.trimmingCharacters(in: .whitespacesAndNewlines)
            if field.type == "textarea" { return length(value) > maxTextarea ? .failure(CleanError("too_long")) : .success(.text(value)) }
            if value.isEmpty { return .success(.text("")) }
            switch field.type {
            case "select": return field.options.contains(value) ? .success(.text(value)) : .failure(CleanError("not_an_option"))
            case "date": return parseDate(value) == nil ? .failure(CleanError("invalid")) : .success(.text(value))
            case "time": return validTime(value) ? .success(.text(value)) : .failure(CleanError("invalid"))
            case "datetime": return parseDatetime(value) == nil ? .failure(CleanError("invalid")) : .success(.text(value))
            default: return .success(.text(value))
            }
        }
    }

    struct CleanError: Error, Equatable {
        let reason: String
        init(_ reason: String) { self.reason = reason }
    }

    enum Checked: Equatable {
        case ok([String: Value])
        case invalid([String: String])
    }

    /// Every field's value in its stored shape, or a reason per key (unknown keys included).
    static func clean(_ fields: [WorkflowField], _ values: [String: JSONValue]) -> Checked {
        var errors: [String: String] = [:]
        let known = Set(fields.map(\.key))
        for key in values.keys where !known.contains(key) { errors[key] = "invalid" }
        var cleaned: [String: Value] = [:]
        for field in fields {
            switch cleanOne(field, values[field.key]) {
            case .failure(let error):
                errors[field.key] = error.reason
            case .success(let value):
                if field.required && isBlank(field, value) { errors[field.key] = "required" } else { cleaned[field.key] = value }
            }
        }
        return errors.isEmpty ? .ok(cleaned) : .invalid(errors)
    }

    /// The form's values as they are sent.
    static func clean(_ fields: [WorkflowField], form: [String: Value]) -> Checked { clean(fields, form.mapValues(\.json)) }

    // MARK: rendering (§3.2)

    /// A typed value cannot call anyone: `<@…` and `<!…` lose their `<`.
    static func escape(_ value: String) -> String {
        value.replacingOccurrences(of: "<@", with: "＜@").replacingOccurrences(of: "<!", with: "＜!")
    }

    static func format(_ field: WorkflowField, _ value: Value?) -> String {
        switch field.type {
        case "checkbox": return value?.flag == true ? "はい" : "いいえ"
        case "user": return (value?.users ?? []).map { "<@\($0)>" }.joined(separator: " ")
        default: break
        }
        guard let text = value?.text, !text.isEmpty else { return "" }
        switch field.type {
        case "date": return dateLabel(text)
        case "datetime": return parseDatetime(text).map { "\(dateLabel($0.date)) \($0.time)" } ?? ""
        case "time": return text
        default: return escape(text)
        }
    }

    /// Review v0.1.30 #4: `trusted[i]` says whether UTF-16 unit `i` came from the template or a user field. A `<`
    /// followed by `@`, `!` or `#` starts a token up to the next `>` (just those two units when no `>` follows); when
    /// any of it was typed, the `<` becomes U+FF1C, so no mention is put together from a value and its surroundings
    /// (the server's `_neutralize`).
    static func neutralize(_ units: [UInt16], trusted: [Bool]) -> String {
        let lt: UInt16 = 0x3C, gt: UInt16 = 0x3E, sigils: Set<UInt16> = [0x40, 0x21, 0x23]
        var out = units
        var i = 0
        while i + 1 < units.count {
            if units[i] == lt && sigils.contains(units[i + 1]) {
                var end = i + 1
                if let close = units[(i + 2)...].firstIndex(of: gt) { end = close }
                if trusted[i...end].contains(false) { out[i] = 0xFF1C }
            }
            i += 1
        }
        return String(decoding: out, as: UTF16.self)
    }

    /// The message body: lines whose placeholders are all empty are left out; replaced once (the server's render).
    /// Mentions only from the template and user fields.
    static func render(_ template: String, fields: [WorkflowField], values: [String: Value]) -> String {
        var texts: [String: String] = [:]
        for field in fields { texts[nfc(field.key)] = format(field, values[field.key] ?? emptyValue(field)) }
        let userKeys = Set(fields.filter { $0.type == "user" }.map { nfc($0.key) })
        var units: [UInt16] = []
        var trusted: [Bool] = []
        func emit(_ piece: String, _ isTrusted: Bool) {
            let added = Array(piece.utf16)
            units += added
            trusted += Array(repeating: isTrusted, count: added.count)
        }
        var started = false
        for line in template.replacingOccurrences(of: "\r\n", with: "\n").components(separatedBy: "\n") {
            let ns = line as NSString
            let matches = placeholder.matches(in: line, range: NSRange(location: 0, length: ns.length))
            let keys = matches.map { nfc(ns.substring(with: $0.range(at: 1))) }
            if !keys.isEmpty && keys.allSatisfy({ texts[$0] == "" }) { continue }
            if started { emit("\n", true) }
            started = true
            var last = 0
            for (match, key) in zip(matches, keys) {
                emit(ns.substring(with: NSRange(location: last, length: match.range.location - last)), true)
                if let text = texts[key] {
                    emit(text, userKeys.contains(key))
                } else {
                    emit(ns.substring(with: match.range), true)
                }
                last = match.range.location + match.range.length
            }
            emit(ns.substring(from: last), true)
        }
        return neutralize(units, trusted: trusted).trimmingCharacters(in: CharacterSet(charactersIn: "\n"))
    }

    /// The preview while the form is being filled: each field that does not check out yet counts as empty.
    static func preview(_ template: String, fields: [WorkflowField], values: [String: Value]) -> String {
        var cleaned: [String: Value] = [:]
        for field in fields {
            switch cleanOne(field, values[field.key]?.json) {
            case .success(let value): cleaned[field.key] = value
            case .failure: cleaned[field.key] = emptyValue(field)
            }
        }
        return render(template, fields: fields, values: cleaned)
    }

    // MARK: defaults (§3.1)

    /// What a field starts with: `today` is the device's date, `me` my id.
    static func defaultValue(_ field: WorkflowField, today: Templates.Day, me: String?) -> Value {
        guard let spec = field.defaultValue else { return emptyValue(field) }
        func withTime(_ day: Templates.Day) -> Value {
            .text(field.type == "datetime" ? "\(isoDay(day))T\(spec.time ?? "09:00")" : isoDay(day))
        }
        switch spec.kind {
        case "me":
            if field.type == "user", let me { return .users([me]) }
            return emptyValue(field)
        case "today":
            return withTime(today)
        case "next_weekday":
            guard let weekday = spec.weekday else { return emptyValue(field) }
            return withTime(today.adding(days: ((weekday - today.weekdayIndex) % 7 + 7) % 7))
        case "literal":
            if field.type == "checkbox" { return .flag(spec.value == .bool(true)) }
            if case .string(let text)? = spec.value { return .text(text) }
            return emptyValue(field)
        default:
            return emptyValue(field)
        }
    }

    static func initialValues(_ fields: [WorkflowField], today: Templates.Day, me: String?) -> [String: Value] {
        Dictionary(fields.map { ($0.key, defaultValue($0, today: today, me: me)) }, uniquingKeysWith: { first, _ in first })
    }

    // MARK: the menu and `/`

    private static func fold(_ text: String) -> String { nfc(text).lowercased() }
    private static func collapse(_ text: String) -> String { text.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ") }

    /// The workflow `/name` or `/wf name` opens: `name` and `args` as SlashCommands.parse read them. A name with spaces
    /// opens only through `/wf`. nil when neither names one.
    static func command(name: String, args: String, in workflows: [WorkflowOut]) -> WorkflowOut? {
        if name == "wf" {
            let wanted = fold(collapse(args))
            return wanted.isEmpty ? nil : workflows.first { fold($0.name) == wanted }
        }
        guard args.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
        return workflows.first { fold($0.name) == fold(name) }
    }

    /// `/` candidates: workflows whose name starts with what follows `/` (no space yet) or `/wf `.
    static func candidates(_ text: String, in workflows: [WorkflowOut]) -> [WorkflowOut] {
        let lower = text.lowercased()
        if lower.hasPrefix("/wf"), let first = text.dropFirst(3).first, first.isWhitespace {
            let rest = String(text.dropFirst(3))
            let prefix = fold(String(rest.drop(while: { $0.isWhitespace })).replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression))
            return workflows.filter { fold($0.name).hasPrefix(prefix) }
        }
        guard let prefix = SlashCommands.typedPrefix(text) else { return [] }
        return workflows.filter { !$0.name.contains(where: { $0.isWhitespace }) && fold($0.name).hasPrefix(fold(prefix)) }
    }

    /// How a candidate is typed: `/name`, or `/wf name` for a name with spaces.
    static func commandText(_ workflow: WorkflowOut) -> String {
        workflow.name.contains(where: { $0.isWhitespace }) ? "/wf \(workflow.name)" : "/\(workflow.name)"
    }

    /// Why I cannot submit it, for the menu; nil when I can (the desktop's runBlockedText). `target`: 「#送り先」.
    static func runBlockedText(_ workflow: WorkflowOut, target: String) -> String? {
        switch workflow.runBlocked {
        case "disabled": return "停止中"
        case "archived": return "\(target) はアーカイブ済みです"
        case "not_a_member": return "\(target) に参加すると使えます"
        case "posting_restricted": return "\(target) はオーナーと管理者だけが投稿できます"
        default: return nil
        }
    }
}
