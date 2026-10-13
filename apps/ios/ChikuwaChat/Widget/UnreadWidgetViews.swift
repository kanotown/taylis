import SwiftUI
import WidgetKit

// The 未読・メンション widget's faces (Widgets/UnreadWidget.swift configures it). Compiled into the app too, so the
// tests render them (UnreadWidgetTests). Names and counts only: no message text anywhere, and the names are marked
// privacy sensitive (hidden while the device is locked when the user does not allow widgets' data there).

struct UnreadTimelineEntry: TimelineEntry {
    let date: Date
    /// nil: the app has written none (nobody signed in yet).
    let snapshot: UnreadWidgetSnapshot?
}

struct UnreadWidgetView: View {
    let entry: UnreadTimelineEntry
    let family: WidgetFamily

    var body: some View {
        content
            // Tapping outside a row opens the app in that workspace, as its icon (whose number this is) does.
            .widgetURL(WidgetLink.open(server: entry.snapshot?.serverUrl).url)
            .environment(\.locale, WidgetLanguage.locale)
    }

    @ViewBuilder
    private var content: some View {
        switch family {
        case .accessoryCircular: UnreadCircularView(snapshot: entry.snapshot)
        case .accessoryRectangular: UnreadRectangularView(snapshot: entry.snapshot)
        case .accessoryInline: UnreadInlineView(snapshot: entry.snapshot)
        case .systemMedium: UnreadHomeView(snapshot: entry.snapshot, medium: true)
        default: UnreadHomeView(snapshot: entry.snapshot, medium: false)
        }
    }
}

/// A row's count: red as the app's badges.
struct UnreadWidgetCount: View {
    let count: Int

    var body: some View {
        Text(verbatim: count > 99 ? "99+" : "\(count)")
            .font(.caption2.weight(.bold))
            .monospacedDigit()
            .foregroundStyle(.white)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(Capsule().fill(Color.red))
    }
}

/// The home screen's small and medium widgets.
struct UnreadHomeView: View {
    let snapshot: UnreadWidgetSnapshot?
    let medium: Bool

    var body: some View {
        Group {
            if let snapshot {
                if medium {
                    HStack(alignment: .top, spacing: 12) {
                        summary(snapshot).frame(width: 104, alignment: .topLeading).frame(maxHeight: .infinity, alignment: .topLeading)
                        rows(snapshot).frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                    }
                } else {
                    summary(snapshot).frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                }
            } else {
                VStack(alignment: .leading, spacing: 6) {
                    Text(verbatim: "Taylis").font(.caption2.weight(.semibold)).foregroundStyle(.secondary)
                    Image(systemName: "bell").font(.title2).foregroundStyle(.secondary).accessibilityHidden(true)
                    Text("Taylis を開いてサインインしてください").font(.footnote).foregroundStyle(.secondary).lineLimit(3)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            }
        }
        .containerBackground(for: .widget) { Color(.systemBackground) }
    }

    /// The workspace, the count and what it counts.
    private func summary(_ snapshot: UnreadWidgetSnapshot) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(verbatim: snapshot.workspaceName).font(.caption2.weight(.semibold)).foregroundStyle(.secondary).lineLimit(1)
            Spacer(minLength: 0)
            HStack(alignment: .firstTextBaseline, spacing: 4) {
                Image(systemName: snapshot.total > 0 ? "bell.badge.fill" : "bell")
                    .font(.system(size: 18, weight: .semibold))
                    .foregroundStyle(snapshot.total > 0 ? Color.red : Color.secondary)
                    .accessibilityHidden(true)
                Text(verbatim: snapshot.total > 999 ? "999+" : "\(snapshot.total)")
                    .font(.system(size: 40, weight: .bold, design: .rounded))
                    .monospacedDigit()
                    .lineLimit(1)
                    .minimumScaleFactor(0.6)
            }
            Text(snapshot.total > 0 ? "メンション・DM の未読" : "未読はありません")
                .font(.caption.weight(.medium))
                .foregroundStyle(.secondary)
                .lineLimit(2)
            if !medium, let first = snapshot.rows.first, UnreadWidgetRules.rowsCurrent(snapshot) {
                Text(verbatim: first.name).font(.caption2).foregroundStyle(.secondary).lineLimit(1).privacySensitive()
            }
            Spacer(minLength: 0)
            if let problem = snapshot.problem { AttendanceWidgetProblemLine(problem: problem) }
        }
    }

    @ViewBuilder
    private func rows(_ snapshot: UnreadWidgetSnapshot) -> some View {
        let shown = Array(snapshot.rows.prefix(UnreadWidgetRules.mediumRows))
        VStack(alignment: .leading, spacing: 4) {
            if shown.isEmpty && snapshot.others > 0 {
                Spacer(minLength: 0)
                Link(destination: WidgetLink.open(server: snapshot.serverUrl).url) {
                    HStack(spacing: 6) {
                        Image(systemName: "bubble.left.and.text.bubble.right").font(.system(size: 11, weight: .bold)).foregroundStyle(.secondary)
                        Text("スレッドなど").font(.footnote.weight(.semibold))
                        Spacer(minLength: 4)
                        UnreadWidgetCount(count: snapshot.others)
                    }
                    .foregroundStyle(Color.primary)
                }
                Spacer(minLength: 0)
            } else if shown.isEmpty {
                Spacer(minLength: 0)
                Image(systemName: "checkmark.circle")
                    .font(.system(size: 34, weight: .light))
                    .foregroundStyle(.tertiary)
                    .frame(maxWidth: .infinity, alignment: .center)
                    .accessibilityHidden(true)
                Spacer(minLength: 0)
            } else {
                ForEach(shown) { row in
                    Link(destination: WidgetLink.channel(id: row.id, server: snapshot.serverUrl).url) { line(row).foregroundStyle(Color.primary) }
                }
                Spacer(minLength: 0)
                footer(snapshot, hidden: snapshot.rows.count - shown.count)
            }
        }
    }

    private func line(_ row: UnreadWidgetRow) -> some View {
        HStack(spacing: 6) {
            Image(systemName: row.isDm ? "person.fill" : (row.mentions > 0 ? "at" : "number"))
                .font(.system(size: 11, weight: .bold))
                .foregroundStyle(.secondary)
                .frame(width: 14)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 0) {
                Text(verbatim: row.name).font(.footnote.weight(.semibold)).lineLimit(1).privacySensitive()
                if let sender = row.lastSender {
                    Text(verbatim: sender).font(.caption2).foregroundStyle(.secondary).lineLimit(1).privacySensitive()
                }
            }
            Spacer(minLength: 4)
            UnreadWidgetCount(count: row.count)
        }
        .frame(maxWidth: .infinity, minHeight: 30, alignment: .leading)
        .contentShape(Rectangle())
    }

    /// 「ほか n 件」, 「スレッドなど n」 (followed threads' mentions and reminders, counted but not listed), and when the
    /// server's count no longer matches the app's rows, how old they are.
    @ViewBuilder
    private func footer(_ snapshot: UnreadWidgetSnapshot, hidden: Int) -> some View {
        let current = UnreadWidgetRules.rowsCurrent(snapshot)
        if hidden > 0 || !current || snapshot.others > 0 {
            HStack(spacing: 6) {
                if hidden > 0 { Text("ほか \(hidden) 件") }
                if snapshot.others > 0 { Text("スレッドなど \(snapshot.others)") }
                if !current { Text("一覧は \(snapshot.rowsAt, style: .time) 時点") }
            }
            .font(.caption2)
            .foregroundStyle(.secondary)
            .lineLimit(1)
        }
    }
}

/// Lock screen, round: the count.
struct UnreadCircularView: View {
    let snapshot: UnreadWidgetSnapshot?

    var body: some View {
        ZStack {
            AccessoryWidgetBackground()
            VStack(spacing: 0) {
                Image(systemName: (snapshot?.total ?? 0) > 0 ? "bell.badge.fill" : "bell").font(.system(size: 13, weight: .semibold))
                if let snapshot {
                    Text(verbatim: snapshot.total > 99 ? "99+" : "\(snapshot.total)")
                        .font(.system(size: 17, weight: .bold, design: .rounded))
                        .monospacedDigit()
                        .minimumScaleFactor(0.7)
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
                    Image(systemName: snapshot.total > 0 ? "bell.badge.fill" : "bell")
                    Text("未読 \(snapshot.total)").font(.headline).monospacedDigit()
                }
                if snapshot.total == 0 {
                    Text("未読はありません").font(.caption)
                } else if UnreadWidgetRules.rowsCurrent(snapshot) {
                    ForEach(snapshot.rows.prefix(UnreadWidgetRules.rectangularRows)) { row in
                        HStack(spacing: 4) {
                            Text(verbatim: row.name).lineLimit(1).privacySensitive()
                            Spacer(minLength: 2)
                            Text(verbatim: "\(row.count)").monospacedDigit()
                        }
                        .font(.caption)
                    }
                } else {
                    Text(verbatim: snapshot.workspaceName).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                }
            } else {
                Text("未読・メンション").font(.headline)
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
            UnreadWidgetRow(id: "c2", name: "Taro", isDm: true, count: 3, mentions: 0, lastAt: "2026-10-14T04:00:00Z"),
            UnreadWidgetRow(id: "c3", name: "#general", isDm: false, count: 1, mentions: 1, lastAt: "2026-10-14T03:00:00Z", lastSender: "Jiro"),
        ]
        return UnreadWidgetSnapshot(serverUrl: "", account: "", workspaceName: "Taylis", userId: "me", total: 6, others: 0, rows: rows,
                                    rowsAt: .distantFuture, updatedAt: .distantFuture, problem: nil)
    }
}
