import SwiftUI

/// The lab roster (M23, DATA_MODEL.md lab_profiles): labels and the roster order, the same as the server's
/// (`GET /lab/roster`) and the desktop's (ui/roster.ts). Names compare by code point, as on the server, so every client
/// lists people alike.
enum Roster {
    static var affiliations: [(value: String, label: String)] { [("faculty", tr("教員")), ("student", tr("学生")), ("other", tr("その他")), ("alumni", tr("卒業生"))] }
    static var ranks: [(value: String, label: String)] { [
        ("professor", tr("教授")), ("associate_professor", tr("准教授")), ("lecturer", tr("講師")), ("assistant_professor", tr("助教")),
    ] }
    /// Roster order: from D3 down to B3.
    static let grades = ["D3", "D2", "D1", "M2", "M1", "B4", "B3"]
    /// The heading of the people off the roster, after everyone on it.
    static var othersHeading: String { tr("その他のメンバー") }

    private static let affiliationOrder = affiliations.map(\.value)
    private static let rankOrder = ranks.map(\.value)

    /// A known value's place; nil and values a newer server adds sort after the known ones.
    private static func place(_ values: [String], _ value: String?) -> Int {
        value.flatMap { values.firstIndex(of: $0) } ?? values.count
    }

    private static func step(_ profile: LabProfileOut) -> Int {
        switch profile.affiliation {
        case "faculty": return place(rankOrder, profile.rank)
        case "student": return place(grades, profile.grade)
        default: return 0
        }
    }

    /// -1 / 0 / 1 by Unicode scalar value, as Python compares str on the server. Swift's `<` on String compares
    /// canonical equivalents instead and could place a name elsewhere.
    static func codePointOrder(_ a: String, _ b: String) -> Int {
        var left = a.unicodeScalars.makeIterator()
        var right = b.unicodeScalars.makeIterator()
        while true {
            switch (left.next(), right.next()) {
            case (nil, nil): return 0
            case (nil, _): return -1
            case (_, nil): return 1
            case let (x?, y?): if x != y { return x.value < y.value ? -1 : 1 }
            }
        }
    }

    /// Where a person sorts (-1 / 0 / 1 against `b`): on the roster by affiliation, rank or grade, then reading (or display
    /// name) and username; off it after everyone on it, by display name and username.
    static func compareByRoster(_ a: UserPublic, _ b: UserPublic, _ roster: [String: LabProfileOut]) -> Int {
        guard let pa = roster[a.id], let pb = roster[b.id] else {
            if roster[a.id] != nil { return -1 }
            if roster[b.id] != nil { return 1 }
            let byName = codePointOrder(a.displayName, b.displayName)
            return byName != 0 ? byName : codePointOrder(a.username, b.username)
        }
        let byPlace = place(affiliationOrder, pa.affiliation) - place(affiliationOrder, pb.affiliation)
        if byPlace != 0 { return byPlace.signum() }
        let byStep = step(pa) - step(pb)
        if byStep != 0 { return byStep.signum() }
        let byName = codePointOrder(nameKey(pa, a), nameKey(pb, b))
        return byName != 0 ? byName : codePointOrder(a.username, b.username)
    }

    private static func nameKey(_ profile: LabProfileOut, _ user: UserPublic) -> String {
        if let reading = profile.reading, !reading.isEmpty { return reading }
        return user.displayName
    }

    /// A member list in roster order when either person is on the roster; pairs off it keep the list's own order
    /// (`otherwise`), so a workspace without a roster looks as before.
    static func sorted(_ people: [UserPublic], _ roster: [String: LabProfileOut], otherwise: (UserPublic, UserPublic) -> Bool) -> [UserPublic] {
        people.sorted { a, b in
            roster[a.id] != nil || roster[b.id] != nil ? compareByRoster(a, b, roster) < 0 : otherwise(a, b)
        }
    }

    /// The heading a person's line sits under in a roster-ordered list; nil off the roster.
    static func section(_ profile: LabProfileOut?) -> String? {
        guard let profile else { return nil }
        if profile.affiliation == "student" { return profile.grade ?? tr("学生") }
        return affiliations.first { $0.value == profile.affiliation }?.label
    }

    /// The short label for a line: 教授, M1, 卒業生 … (nil for an affiliation this version does not know).
    static func label(_ profile: LabProfileOut) -> String? {
        switch profile.affiliation {
        case "faculty": return ranks.first { $0.value == profile.rank }?.label ?? tr("教員")
        case "student": return profile.grade ?? tr("学生")
        default: return affiliations.first { $0.value == profile.affiliation }?.label
        }
    }

    /// 「指導教員: 加納」, or nil without one.
    static func supervisorLabel(_ profile: LabProfileOut, users: [String: UserPublic]) -> String? {
        guard let id = profile.supervisorId, let name = users[id]?.displayName else { return nil }
        return tr("指導教員: \(name)")
    }

    /// 「M1 · 指導教員: 加納」: the label and the supervisor, for the profile card (lists show the label as a badge).
    static func summary(_ profile: LabProfileOut, users: [String: UserPublic]) -> String {
        [label(profile), supervisorLabel(profile, users: users)].compactMap { $0 }.joined(separator: " · ")
    }

    /// How two titles compare: after NFKC, trimming and lower-casing (「ｄ１」 is 「D1」).
    private static func titleKey(_ text: String) -> String {
        text.precomposedStringWithCompatibilityMapping.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }

    /// The title (肩書) beside the roster label (LAB.md 「肩書と名簿」, cases in apps/shared/title-display.json): the
    /// roster's label (教授, M2 …) is shown wherever a title is; the title adds what the roster does not say (研究室長, TA).
    /// `extra`: the title, unless it is empty or the label again.
    static func titleParts(_ title: String?, _ profile: LabProfileOut?) -> (label: String?, extra: String?) {
        let label = profile.flatMap { Roster.label($0) }.flatMap { $0.isEmpty ? nil : $0 }
        let text = title?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !text.isEmpty else { return (label, nil) }
        if let label, titleKey(label) == titleKey(text) { return (label, nil) }
        return (label, text)
    }

    /// The title as shown: 「M2」, 「研究室長」, 「M2 · 研究室長」, or nil for nothing.
    static func displayTitle(_ title: String?, _ profile: LabProfileOut?) -> String? {
        let parts = titleParts(title, profile)
        let line = [parts.label, parts.extra].compactMap { $0 }.joined(separator: " · ")
        return line.isEmpty ? nil : line
    }

    /// What a list that shows the roster label as a badge adds after it: the title unless it is empty or the label again.
    static func titleExtra(_ title: String?, _ profile: LabProfileOut?) -> String? {
        titleParts(title, profile).extra
    }

    /// A run of people under one heading in the member directory.
    struct ListSection: Identifiable, Equatable {
        /// The run's position: a heading may come back further down for a grade this version does not know.
        let id: Int
        let title: String
        var people: [UserPublic]
    }

    /// A roster-ordered list cut under its headings (教員, D3 … B3, その他, 卒業生), then その他のメンバー for the rest.
    static func sections(_ people: [UserPublic], _ roster: [String: LabProfileOut]) -> [ListSection] {
        var result: [ListSection] = []
        for person in people {
            let title = section(roster[person.id]) ?? othersHeading
            if let last = result.indices.last, result[last].title == title {
                result[last].people.append(person)
            } else {
                result.append(ListSection(id: result.count, title: title, people: [person]))
            }
        }
        return result
    }
}

/// The roster label next to a name in member lists (M23).
struct RosterBadge: View {
    let profile: LabProfileOut

    var body: some View {
        if let label = Roster.label(profile) {
            Text(label)
                .font(.caption2)
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .fixedSize()
                .padding(.horizontal, 5)
                .padding(.vertical, 1)
                .overlay(Capsule().stroke(Color.secondary.opacity(0.5), lineWidth: 0.5))
        }
    }
}
