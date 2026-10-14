import SwiftUI
import WidgetKit

// The 未読・メンション widget's faces (Widgets/UnreadWidget.swift configures it). Compiled into the app too, so the
// tests render them (InfoWidgetsTests). Names and counts only: no message text anywhere, and the names are marked
// privacy sensitive (hidden while the device is locked when the user does not allow widgets' data there).

struct UnreadTimelineEntry: TimelineEntry {
    let date: Date
    /// nil: nothing to show (nobody signed in yet, or the chosen workspace signed out).
    let snapshot: UnreadWidgetSnapshot?
    /// The workspace's row for the header.
    var workspace: Workspace? = nil
}

struct UnreadWidgetView: View {
    let entry: UnreadTimelineEntry
    let family: WidgetFamily

    var body: some View {
        content
            // Tapping outside a row opens the app in that workspace, as its icon (whose number this is) does.
            .widgetURL(WidgetLink.open(server: entry.snapshot?.serverUrl ?? entry.workspace?.serverUrl).url)
            .environment(\.locale, WidgetLanguage.locale)
            .dynamicTypeSize(...DynamicTypeSize.xLarge)
    }

    @ViewBuilder
    private var content: some View {
        switch family {
        case .accessoryCircular: UnreadCircularView(snapshot: entry.snapshot)
        case .accessoryRectangular: UnreadRectangularView(snapshot: entry.snapshot)
        case .accessoryInline: UnreadInlineView(snapshot: entry.snapshot)
        case .systemMedium: UnreadHomeView(snapshot: entry.snapshot, workspace: entry.workspace, medium: true)
        default: UnreadHomeView(snapshot: entry.snapshot, workspace: entry.workspace, medium: false)
        }
    }
}

/// A row's count: red as the app's badges.
typealias UnreadWidgetCount = WidgetCountPill

/// A conversation's picture: the other person's initials for a 1:1 DM, people for a group DM, 「@」 for a channel that
/// mentions me, 「#」 for one that counts otherwise.
struct UnreadRowIcon: View {
    let row: UnreadWidgetRow
    var size: CGFloat = 26
    @WidgetFullColor private var fullColor

    var body: some View {
        if let person = row.avatar {
            WidgetAvatar(person: person, size: size)
        } else {
            let symbol = row.isDm ? (row.group == false ? "person.fill" : "person.2.fill") : (row.mentions > 0 ? "at" : "number")
            let mention = !row.isDm && row.mentions > 0
            Image(systemName: symbol)
                .font(.system(size: size * (row.isDm && row.group != false ? 0.4 : 0.48), weight: .bold))
                .foregroundStyle(fullColor && mention ? Color.red : Color.secondary)
                .frame(width: size, height: size)
                .background {
                    let fill = fullColor && mention ? Color.red.opacity(0.13) : Color.primary.opacity(fullColor ? 0.07 : 0.14)
                    if row.isDm { Circle().fill(fill) } else { RoundedRectangle(cornerRadius: size * 0.28, style: .continuous).fill(fill) }
                }
                .widgetAccentable(mention)
                .accessibilityHidden(true)
        }
    }
}

/// 「@3・DM 4・スレッドなど 1」: what the count is made of (nil parts left out).
struct UnreadBreakdownLine: View {
    let breakdown: UnreadWidgetRules.Breakdown
    var vertical = false

    var body: some View {
        let layout = vertical ? AnyLayout(VStackLayout(alignment: .leading, spacing: 3)) : AnyLayout(HStackLayout(spacing: 8))
        layout {
            if breakdown.mentions > 0 { item("at", Text(verbatim: "\(breakdown.mentions)")) }
            if breakdown.dms > 0 { item("bubble.left.fill", Text("DM \(breakdown.dms)")) }
            // In one line (the small widget) the threads' icon says the words.
            if breakdown.others > 0 {
                item("bubble.left.and.text.bubble.right.fill", vertical ? Text("スレッドなど \(breakdown.others)") : Text(verbatim: "\(breakdown.others)"))
            }
        }
        .font(.caption.weight(.semibold))
        .foregroundStyle(.secondary)
        .lineLimit(1)
        .minimumScaleFactor(0.8)
    }

    private func item(_ symbol: String, _ text: Text) -> some View {
        HStack(spacing: 3) {
            Image(systemName: symbol).font(.caption2.weight(.bold)).imageScale(.small)
            text.monospacedDigit()
        }
    }
}

/// The home screen's small and medium widgets.
struct UnreadHomeView: View {
    let snapshot: UnreadWidgetSnapshot?
    var workspace: Workspace? = nil
    let medium: Bool
    @WidgetFullColor private var fullColor

    var body: some View {
        Group {
            if let snapshot {
                VStack(alignment: .leading, spacing: 0) {
                    WidgetHeader(workspace: workspace ?? Workspace(serverUrl: snapshot.serverUrl, name: snapshot.workspaceName, username: ""),
                                 name: snapshot.workspaceName) {
                        if let problem = snapshot.problem { WidgetProblemIcon(problem: problem) }
                    }
                    if medium { mediumBody(snapshot) } else { smallBody(snapshot) }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            } else {
                WidgetMessageFace.signIn(workspace, compact: !medium)
            }
        }
        .containerBackground(for: .widget) { Color(.systemBackground) }
    }

    // MARK: small: the number, what it is made of, the newest conversation

    @ViewBuilder
    private func smallBody(_ snapshot: UnreadWidgetSnapshot) -> some View {
        if snapshot.total == 0 {
            Spacer(minLength: 6)
            allRead(compact: true)
            Spacer(minLength: 6)
        } else {
            Spacer(minLength: 6)
            number(snapshot)
            Group {
                if let breakdown = UnreadWidgetRules.breakdown(snapshot) {
                    UnreadBreakdownLine(breakdown: breakdown)
                } else {
                    Text("メンション・DM").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                }
            }
            .padding(.top, 2)
            Spacer(minLength: 6)
            if let first = snapshot.rows.first, UnreadWidgetRules.rowsCurrent(snapshot) {
                Link(destination: WidgetLink.channel(id: first.id, server: snapshot.serverUrl).url) {
                    HStack(spacing: 6) {
                        UnreadRowIcon(row: first, size: 20)
                        Text(verbatim: first.name).font(.caption.weight(.semibold)).lineLimit(1).privacySensitive()
                        Spacer(minLength: 2)
                        WidgetCountPill(count: first.count)
                    }
                    .padding(.horizontal, 6)
                    .frame(height: 32)
                    .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(Color.primary.opacity(fullColor ? 0.05 : 0.1)))
                    .foregroundStyle(Color.primary)
                }
            }
        }
    }

    /// The big number and 「未読」 on its baseline.
    private func number(_ snapshot: UnreadWidgetSnapshot) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 5) {
            Text(verbatim: snapshot.total > 999 ? "999+" : "\(snapshot.total)")
                .font(.system(size: 44, weight: .bold, design: .rounded))
                .monospacedDigit()
                .lineLimit(1)
                .minimumScaleFactor(0.5)
                .widgetAccentable()
            Text("未読")
                .font(.subheadline.weight(.bold))
                .foregroundStyle(.secondary)
                .fixedSize()
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text("メンション・DM の未読 \(snapshot.total)"))
    }

    /// Nothing waits: a check and its words.
    private func allRead(compact: Bool) -> some View {
        let check = Image(systemName: "checkmark.circle.fill")
            .font(.system(size: compact ? 30 : 34, weight: .semibold))
            .foregroundStyle(fullColor ? Color.green : Color.primary)
            .widgetAccentable()
            .accessibilityHidden(true)
        return Group {
            if compact {
                VStack(alignment: .leading, spacing: 8) {
                    check
                    Text("未読はありません").font(.subheadline.weight(.semibold)).lineLimit(2)
                }
            } else {
                HStack(spacing: 12) {
                    check
                    VStack(alignment: .leading, spacing: 2) {
                        Text("未読はありません").font(.headline)
                        Text("メンションと DM はすべて読みました").font(.caption).foregroundStyle(.secondary)
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
    }

    // MARK: medium: the number on the left, the conversations on the right

    @ViewBuilder
    private func mediumBody(_ snapshot: UnreadWidgetSnapshot) -> some View {
        if snapshot.total == 0 {
            allRead(compact: false)
        } else {
            Spacer(minLength: 8)
            HStack(alignment: .top, spacing: 14) {
                VStack(alignment: .leading, spacing: 4) {
                    number(snapshot)
                    if let breakdown = UnreadWidgetRules.breakdown(snapshot) {
                        UnreadBreakdownLine(breakdown: breakdown, vertical: true)
                    } else {
                        // The server counted anew: what it is made of is not known until the app lists the rows again.
                        Text("メンション・DM").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                    }
                }
                .frame(width: 96, alignment: .leading)
                rows(snapshot).frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            }
        }
    }

    @ViewBuilder
    private func rows(_ snapshot: UnreadWidgetSnapshot) -> some View {
        let shown = Array(snapshot.rows.prefix(UnreadWidgetRules.mediumRows))
        if shown.isEmpty && snapshot.others > 0 && UnreadWidgetRules.hasRows(snapshot) {
            Link(destination: WidgetLink.open(server: snapshot.serverUrl).url) {
                HStack(spacing: 8) {
                    Image(systemName: "bubble.left.and.text.bubble.right.fill")
                        .font(.system(size: 11, weight: .bold))
                        .foregroundStyle(.secondary)
                        .frame(width: 26, height: 26)
                        .background(RoundedRectangle(cornerRadius: 7, style: .continuous).fill(Color.primary.opacity(0.07)))
                    Text("スレッドなど").font(.footnote.weight(.semibold))
                    Spacer(minLength: 4)
                    WidgetCountPill(count: snapshot.others)
                }
                .foregroundStyle(Color.primary)
            }
        } else if shown.isEmpty {
            // A workspace the app has not listed yet (or the server counted what the rows do not show).
            VStack(spacing: 6) {
                Image(systemName: "tray.full").font(.title3).foregroundStyle(.tertiary).accessibilityHidden(true)
                Text("会話はアプリで開くと表示されます").font(.caption).foregroundStyle(.secondary).multilineTextAlignment(.center)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            VStack(alignment: .leading, spacing: 4) {
                ForEach(shown) { row in
                    Link(destination: WidgetLink.channel(id: row.id, server: snapshot.serverUrl).url) { line(row).foregroundStyle(Color.primary) }
                }
                Spacer(minLength: 0)
                footer(snapshot, hidden: snapshot.rows.count - shown.count)
            }
        }
    }

    private func line(_ row: UnreadWidgetRow) -> some View {
        HStack(spacing: 8) {
            UnreadRowIcon(row: row, size: 26)
            VStack(alignment: .leading, spacing: 0) {
                Text(verbatim: row.name).font(.footnote.weight(.semibold)).lineLimit(1).privacySensitive()
                if let sender = row.lastSender {
                    Text(verbatim: sender).font(.caption2).foregroundStyle(.secondary).lineLimit(1).privacySensitive()
                }
            }
            Spacer(minLength: 4)
            WidgetCountPill(count: row.count)
        }
        .frame(maxWidth: .infinity, minHeight: 30, alignment: .leading)
        .contentShape(Rectangle())
    }

    /// 「ほか n 件」, 「スレッドなど n」 (followed threads' mentions and reminders, counted but not listed), and when the
    /// server's count no longer matches the app's rows, how old they are.
    @ViewBuilder
    private func footer(_ snapshot: UnreadWidgetSnapshot, hidden: Int) -> some View {
        let current = UnreadWidgetRules.rowsCurrent(snapshot)
        if hidden > 0 || !current {
            HStack(spacing: 6) {
                if hidden > 0 { Text("ほか \(hidden) 件") }
                if !current { Text("一覧は \(snapshot.rowsAt, style: .time) 時点") }
            }
            .font(.caption2)
            .foregroundStyle(.secondary)
            .lineLimit(1)
            .frame(maxWidth: .infinity, alignment: .trailing)
        }
    }
}

/// Lock screen, round: the count under a bell.
struct UnreadCircularView: View {
    let snapshot: UnreadWidgetSnapshot?

    var body: some View {
        ZStack {
            AccessoryWidgetBackground()
            VStack(spacing: 0) {
                Image(systemName: (snapshot?.total ?? 0) > 0 ? "bell.badge.fill" : "bell")
                    .font(.system(size: 13, weight: .semibold))
                    .widgetAccentable()
                if let snapshot {
                    Text(verbatim: snapshot.total > 99 ? "99+" : "\(snapshot.total)")
                        .font(.system(size: 20, weight: .bold, design: .rounded))
                        .monospacedDigit()
                        .minimumScaleFactor(0.6)
                }
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text("メンション・DM の未読 \(snapshot?.total ?? 0)"))
        .containerBackground(for: .widget) { Color.clear }
    }
}

/// Lock screen, rectangle: the count and the first conversations' names with their counts (no message text).
struct UnreadRectangularView: View {
    let snapshot: UnreadWidgetSnapshot?

    var body: some View {
        VStack(alignment: .leading, spacing: 1) {
            if let snapshot {
                HStack(spacing: 4) {
                    Image(systemName: snapshot.total > 0 ? "bell.badge.fill" : "bell").widgetAccentable()
                    Text("未読 \(snapshot.total)").monospacedDigit()
                }
                .font(.headline)
                if snapshot.total == 0 {
                    Text("未読はありません").font(.caption)
                } else if UnreadWidgetRules.rowsCurrent(snapshot) {
                    ForEach(snapshot.rows.prefix(UnreadWidgetRules.rectangularRows)) { row in
                        HStack(spacing: 4) {
                            Text(verbatim: row.name).lineLimit(1).privacySensitive()
                            Spacer(minLength: 2)
                            Text(verbatim: "\(row.count)").fontWeight(.semibold).monospacedDigit()
                        }
                        .font(.caption)
                    }
                } else {
                    Text(verbatim: snapshot.workspaceName).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                }
            } else {
                Label { Text("未読・メンション") } icon: { Image(systemName: "bell") }.font(.headline).widgetAccentable()
                Text("Taylis を開いてサインインしてください").font(.caption).lineLimit(2)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .containerBackground(for: .widget) { Color.clear }
    }
}

/// Lock screen, one line: 「未読 5」.
struct UnreadInlineView: View {
    let snapshot: UnreadWidgetSnapshot?

    var body: some View {
        Label {
            Text("未読 \(snapshot?.total ?? 0)")
        } icon: {
            Image(systemName: (snapshot?.total ?? 0) > 0 ? "bell.badge.fill" : "bell")
        }
    }
}

/// The widget gallery's picture and the placeholder.
enum UnreadWidgetSamples {
    static var snapshot: UnreadWidgetSnapshot {
        let rows = [
            UnreadWidgetRow(id: "c1", name: "#ゼミ", isDm: false, count: 2, mentions: 2, lastAt: "2026-10-14T05:00:00Z", lastSender: "Hanako"),
            UnreadWidgetRow(id: "c2", name: "Taro", isDm: true, count: 3, mentions: 0, lastAt: "2026-10-14T04:00:00Z",
                            avatar: WidgetPerson(id: "u2", name: "Taro", initials: "T", color: 0x2F7FA8), group: false),
            UnreadWidgetRow(id: "c3", name: "#general", isDm: false, count: 1, mentions: 1, lastAt: "2026-10-14T03:00:00Z", lastSender: "Jiro"),
        ]
        return UnreadWidgetSnapshot(serverUrl: "", account: "", workspaceName: "Taylis", userId: "me", total: 6, others: 0, rows: rows,
                                    rowsAt: .distantFuture, updatedAt: .distantFuture, problem: nil)
    }
}
