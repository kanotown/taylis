import SwiftUI
import WidgetKit

// The pieces every widget face shares (WIDGETS.md): the header (the workspace's tile and name), people's initials, the
// count pill, the sign-in face, and how a face draws in the home screen's tinted and clear modes (iOS 18+), where the
// system draws everything in one tint: colour fills then turn into white blobs, so the faces swap them for outlines
// and soft fills of the primary colour and mark their key glyphs and numbers `widgetAccentable()`.

extension EnvironmentValues {
    /// The tests draw a face as the tinted / clear home screen draws it (the system's value cannot be set).
    @Entry var widgetModeOverride: WidgetRenderingMode? = nil
}

/// Whether the face is drawn in full colour (false: the tinted or clear home screen, or the lock screen).
@propertyWrapper
struct WidgetFullColor: DynamicProperty {
    @Environment(\.widgetRenderingMode) private var system
    @Environment(\.widgetModeOverride) private var override

    init() {}

    var wrappedValue: Bool { (override ?? system) == .fullColor }
}

/// The faces' measures: the system's 16 pt margins around them, one header height, one gap under it.
enum WidgetMetrics {
    static let header: CGFloat = 18
    static let gapUnderHeader: CGFloat = 10
}

extension Color {
    /// A colour readable as text on the widget's background: the solid badge colours (700-level) are lightened in dark
    /// mode.
    static func widgetInk(_ rgb: UInt32, dark: Bool) -> Color {
        guard dark else { return Color(rgb: rgb) }
        func lift(_ c: UInt32) -> Double { let v = Double(c) / 255; return v + (1 - v) * 0.5 }
        return Color(red: lift((rgb >> 16) & 0xFF), green: lift((rgb >> 8) & 0xFF), blue: lift(rgb & 0xFF))
    }
}

/// A person as the app draws one without a picture: initials on the colour of their id (InitialsAvatar), so the widgets
/// need neither the users nor the pictures.
struct WidgetPerson: Codable, Equatable, Hashable, Identifiable {
    let id: String
    let name: String
    let initials: String
    /// 0xRRGGBB.
    let color: UInt32

    /// Someone the snapshot has no name for (joined after the app wrote it): a grey 「?」.
    static func unknown(_ id: String) -> WidgetPerson { WidgetPerson(id: id, name: "", initials: "?", color: 0x8E8E93) }
}

/// A person's round tile.
struct WidgetAvatar: View {
    let person: WidgetPerson
    var size: CGFloat = 22
    @WidgetFullColor private var fullColor

    var body: some View {
        Text(verbatim: person.initials)
            .font(.system(size: size * (person.initials.count > 1 ? 0.36 : 0.44), weight: .bold))
            .lineLimit(1)
            .minimumScaleFactor(0.6)
            .foregroundStyle(fullColor ? Color.white : Color.primary)
            .frame(width: size, height: size)
            .background(Circle().fill(fullColor ? Color(rgb: person.color) : Color.primary.opacity(0.22)))
            .accessibilityHidden(true)
    }
}

/// Overlapping round tiles, the last 「+n」 when more people than `limit` are there.
struct WidgetFacePile: View {
    let people: [WidgetPerson]
    var limit = 4
    var size: CGFloat = 22
    @Environment(\.colorScheme) private var scheme
    @WidgetFullColor private var fullColor

    var body: some View {
        let shown = people.count > limit ? Array(people.prefix(limit - 1)) : people
        let rest = people.count - shown.count
        // Overlapping in full colour (a ring of the background between the tiles); apart in the tinted modes, where
        // the translucent tiles would show through each other.
        HStack(spacing: fullColor ? -size * 0.28 : 2) {
            ForEach(shown) { person in
                WidgetAvatar(person: person, size: size).overlay(ring)
            }
            if rest > 0 {
                Text(verbatim: "+\(rest)")
                    .font(.system(size: size * 0.4, weight: .bold, design: .rounded))
                    .monospacedDigit()
                    .lineLimit(1)
                    .minimumScaleFactor(0.6)
                    .foregroundStyle(.secondary)
                    .frame(width: size, height: size)
                    .background(Circle().fill(Color.primary.opacity(fullColor ? 0.1 : 0.16)))
                    .overlay(ring)
            }
        }
        .accessibilityHidden(true)
    }

    /// A ring of the background between the tiles (in full colour; the tinted modes have no background to show).
    private var ring: some View {
        Circle().strokeBorder(fullColor ? Color(.systemBackground) : Color.clear, lineWidth: 1.5)
    }
}

/// The workspace's tile in the header: its icon when the app has kept it (WidgetWorkspaceIcons), else its initials on
/// its colour (the app's switcher and the desktop rail); Taylis's 「T」 before anyone signed in.
struct WidgetWorkspaceMark: View {
    let workspace: Workspace?
    let name: String
    var size: CGFloat = WidgetMetrics.header
    @WidgetFullColor private var fullColor

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: size * 0.28, style: .continuous)
        Group {
            if let workspace, let icon = WidgetWorkspaceIcons.image(for: workspace) {
                iconImage(icon).frame(width: size, height: size).clipShape(shape)
            } else {
                let colorKey = workspace?.colorKey ?? name
                Text(verbatim: Workspaces.initials(name))
                    .font(.system(size: size * 0.5, weight: .heavy, design: .rounded))
                    .lineLimit(1)
                    .minimumScaleFactor(0.5)
                    .foregroundStyle(fullColor ? Color.white : Color.primary)
                    .frame(width: size, height: size)
                    .background(shape.fill(fullColor ? Color(rgb: Workspaces.paletteHex[Workspaces.paletteIndex(colorKey)]) : Color.primary.opacity(0.22)))
            }
        }
        .accessibilityHidden(true)
    }

    @ViewBuilder
    private func iconImage(_ icon: UIImage) -> some View {
        if #available(iOS 18.0, *) {
            Image(uiImage: icon).resizable().widgetAccentedRenderingMode(.desaturated).scaledToFill()
        } else {
            Image(uiImage: icon).resizable().scaledToFill()
        }
    }
}

/// Every widget's first line: the workspace's tile and name, then what the widget adds on the right (the day, a
/// problem's sign).
struct WidgetHeader<Trailing: View>: View {
    let workspace: Workspace?
    let name: String
    @ViewBuilder var trailing: Trailing

    var body: some View {
        HStack(spacing: 6) {
            WidgetWorkspaceMark(workspace: workspace, name: name)
            Text(verbatim: name)
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
                .lineLimit(1)
            Spacer(minLength: 4)
            trailing
        }
        .frame(height: WidgetMetrics.header)
    }
}

extension WidgetHeader where Trailing == EmptyView {
    init(workspace: Workspace?, name: String) {
        self.init(workspace: workspace, name: name) { EmptyView() }
    }
}

/// The sign of a failed refresh in a header: orange, its words for VoiceOver.
struct WidgetProblemIcon: View {
    let problem: WidgetProblem

    var body: some View {
        Image(systemName: problem == .offline ? "wifi.exclamationmark" : "exclamationmark.triangle.fill")
            .font(.caption2.weight(.bold))
            .foregroundStyle(.orange)
            .accessibilityLabel(Text(problem.words))
    }
}

extension WidgetProblem {
    var words: LocalizedStringKey {
        switch self {
        case .offline: "更新できません"
        case .signedOut: "サインインし直してください"
        case .refused: "変更できませんでした"
        }
    }
}

/// A count in a pill: red as the app's badges (an outlined number in the tinted modes).
struct WidgetCountPill: View {
    let count: Int
    @WidgetFullColor private var fullColor

    var body: some View {
        Text(verbatim: count > 99 ? "99+" : "\(count)")
            .font(.caption2.weight(.bold))
            .monospacedDigit()
            .lineLimit(1)
            .foregroundStyle(fullColor ? Color.white : Color.primary)
            .padding(.horizontal, 6)
            .frame(minWidth: 22, minHeight: 18)
            .background(Capsule().fill(fullColor ? Color.red : Color.primary.opacity(0.18)))
            .widgetAccentable()
    }
}

/// The face without anything to show yet: the header, a glyph in a soft circle and what to do (sign in, the board is
/// off).
struct WidgetMessageFace: View {
    let workspace: Workspace?
    let name: String
    let symbol: String
    let text: Text
    var compact = false
    /// The small face's first line (`text` under it), when `text` is too long for one.
    var detail: Text? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            WidgetHeader(workspace: workspace, name: name)
            Spacer(minLength: 6)
            HStack(alignment: .center, spacing: 10) {
                Image(systemName: symbol)
                    .font(.system(size: 18, weight: .semibold))
                    .foregroundStyle(.secondary)
                    .frame(width: 40, height: 40)
                    .background(Circle().fill(Color.primary.opacity(0.07)))
                    .widgetAccentable()
                    .accessibilityHidden(true)
                if !compact {
                    text.font(.footnote.weight(.medium)).foregroundStyle(.secondary).lineLimit(3).fixedSize(horizontal: false, vertical: true)
                }
            }
            if compact {
                (detail ?? text).font(.footnote.weight(.bold)).lineLimit(2).fixedSize(horizontal: false, vertical: true)
                    .padding(.top, 10)
                if detail != nil {
                    text.font(.caption).foregroundStyle(.secondary).lineLimit(2).padding(.top, 2)
                }
            }
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}

extension WidgetMessageFace {
    /// Nothing to show: nobody signed in yet, or the chosen workspace signed out (its tile and name in the header).
    static func signIn(_ workspace: Workspace?, compact: Bool) -> WidgetMessageFace {
        compact
            ? WidgetMessageFace(workspace: workspace, name: workspace?.name ?? WidgetNames.product, symbol: "person.crop.circle.badge.exclamationmark",
                                text: Text("Taylis を開いてください"), compact: true, detail: Text("サインインが必要です"))
            : WidgetMessageFace(workspace: workspace, name: workspace?.name ?? WidgetNames.product, symbol: "person.crop.circle.badge.exclamationmark",
                                text: Text("Taylis を開いてサインインしてください"))
    }
}

/// The header's name when there is no snapshot: the chosen workspace's (signed out), else Taylis.
enum WidgetNames {
    static let product = "Taylis"
}
