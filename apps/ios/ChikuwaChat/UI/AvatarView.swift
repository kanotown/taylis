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
        face
            .frame(width: size, height: size)
            .overlay(alignment: .bottomTrailing) {
                if let style = PresenceDot.Style(look: presence, showOffline: showOffline) {
                    PresenceDot(style: style, side: size * 0.3)
                        .overlay(Circle().stroke(Color(.systemBackground), lineWidth: 2))
                        .offset(x: size * 0.08, y: size * 0.08)
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
                Circle().strokeBorder(style.color, lineWidth: max(1.5, side * 0.2))
                    .background(Circle().fill(Color(.systemBackground)))
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
