import SwiftUI

/// The profile picture when the user has one (M14a), else initials on a colour derived from the user id.
struct AvatarView: View {
    let id: String
    let name: String
    var size: CGFloat = 36
    /// The dot (SYNC_PROTOCOL.md §5.2, PRESENCE.md §11.5): "online" / "away" / "dnd" (取り込み中: a red disc with a
    /// white bar); nil or "offline" shows none.
    var presence: String? = nil
    /// "offline" as a grey ring (my own picture while I appear offline, PRESENCE.md §11.6).
    var showOffline = false

    var body: some View {
        let style = PresenceDot.Style(look: presence, showOffline: showOffline)
        // The dot sits in a hole cut out of the picture (badgeHole), 2 pt wider all round: what is behind the picture
        // (a row, a selected row, a grouped cell, a sheet, a bar) is the ring, and the picture never shows through the
        // dot where a sheet or bar blends what it draws (iOS 26 glass).
        let side = size * 0.3 - 2
        let shift = size * 0.08 - 1
        face
            .frame(width: size, height: size)
            .badgeHole(dot: style == nil ? 0 : side, gap: style == nil ? 0 : 2, offset: shift)
            .overlay(alignment: .bottomTrailing) {
                if let style {
                    PresenceDot(style: style, side: side)
                        .offset(x: shift, y: shift)
                }
            }
            .accessibilityHidden(true)
    }

    /// The profile picture (M14a) when it is cached, else initials on a colour derived from the id (InitialsAvatar, the
    /// rule every client shares).
    @ViewBuilder
    private var face: some View {
        if let image = AvatarCache.shared.image(for: id) {
            Image(uiImage: image)
                .resizable()
                .scaledToFill()
                .frame(width: size, height: size)
                .clipShape(RoundedRectangle(cornerRadius: size / 4, style: .continuous))
        } else {
            Text(Timeline.initials(name))
                .font(.system(size: size * 0.42, weight: .bold))
                .foregroundStyle(.white)
                .frame(width: size, height: size)
                .background(Color(uiColor: InitialsAvatar.color(id)), in: RoundedRectangle(cornerRadius: size / 4, style: .continuous))
        }
    }
}

/// The presence dot alone (an avatar's corner, the quick status menu's choices): green, orange, 取り込み中's red disc
/// with a white bar (as on Desktop / Web), or a grey ring.
struct PresenceDot: View {
    enum Style: Equatable {
        case online, away, dnd, offline

        /// The dot for a look; "offline" (or none) draws nothing unless `showOffline`.
        init?(look: String?, showOffline: Bool = false) {
            switch look {
            case "online": self = .online
            case "away": self = .away
            case "dnd": self = .dnd
            default:
                guard showOffline else { return nil }
                self = .offline
            }
        }

        var color: Color {
            switch self {
            case .online: .green
            case .away: .orange
            case .dnd: .red
            case .offline: .gray
            }
        }
    }

    let style: Style
    var side: CGFloat = 10

    var body: some View {
        Group {
            if style == .offline {
                // Hollow: on a picture the hole under it (badgeHole) shows what is behind, like the ring around it.
                Circle().strokeBorder(style.color, lineWidth: max(1.5, side * 0.2))
            } else {
                Circle().fill(style.color)
                    .overlay {
                        if style == .dnd {
                            Capsule().fill(Color.white).frame(width: side * 0.62, height: max(1.5, side * 0.2))
                        }
                    }
            }
        }
        .frame(width: side, height: side)
        .accessibilityHidden(true)
    }
}

extension View {
    /// Cuts a round hole out of this view at its bottom-trailing corner for a badge drawn there: a badge of diameter
    /// `dot`, aligned bottom-trailing and moved by `offset` down and right, gets a hole `gap` wider all round, so the
    /// badge's ring is whatever is behind this view. A drawn ring in one colour (systemBackground) did not match grouped
    /// rows in dark mode or sheets, and a badge drawn over the picture let the picture show through it where iOS 26's
    /// glass sheets and bars blend what they draw. `dot` 0 and `gap` 0 cut nothing.
    func badgeHole(dot: CGFloat, gap: CGFloat, offset: CGFloat) -> some View {
        mask {
            Rectangle()
                .overlay(alignment: .bottomTrailing) {
                    Circle()
                        .frame(width: dot + gap * 2, height: dot + gap * 2)
                        .offset(x: offset + gap, y: offset + gap)
                        .blendMode(.destinationOut)
                }
                .compositingGroup()
        }
    }
}

func presenceLabel(_ status: String) -> String {
    switch status {
    case "online": return tr("オンライン")
    case "away": return tr("離席中")
    case "dnd": return tr("取り込み中")
    default: return tr("オフライン")
    }
}

/// "#" / "🔒" glyph for a channel so lists have a consistent left rail.
struct ChannelGlyph: View {
    let channel: ChannelOut
    var size: CGFloat = 36

    var body: some View {
        Text(channel.type == "private" ? "🔒" : "#")
            .font(.system(size: size * 0.5, weight: .semibold))
            .foregroundStyle(.secondary)
            .frame(width: size, height: size)
            .background(Color(.secondarySystemFill), in: RoundedRectangle(cornerRadius: size / 4, style: .continuous))
            .accessibilityHidden(true)
    }
}
