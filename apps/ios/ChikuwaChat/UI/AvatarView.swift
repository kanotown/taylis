import SwiftUI

/// The profile picture when the user has one (M14a), else initials on a colour derived from the user id.
struct AvatarView: View {
    let id: String
    let name: String
    var size: CGFloat = 36
    /// The dot (SYNC_PROTOCOL.md §5.2, PRESENCE.md §11.5): "online" / "away" / "dnd" (取り込み中: a red disc; it
    /// had a white bar until 2026-10-13), "offline" a hollow grey ring (since 2026-10-13; it showed none before); nil
    /// shows none (a bot, a group DM, no one to show).
    var presence: String? = nil
    /// nil as the grey ring too (my own picture, PRESENCE.md §11.6).
    var showOffline = false

    var body: some View {
        let style = PresenceDot.Style(look: presence, showOffline: showOffline)
        // The dot sits in a hole cut out of the picture (badgeHole), the ring's width wider all round: what is behind
        // the picture (a row, a selected row, a grouped cell, a sheet, a bar) is the ring, and the picture never shows
        // through the dot where a sheet or bar blends what it draws (iOS 26 glass). Sizes: PresenceDotRule.
        let rule = PresenceDotRule(avatar: size)
        face
            .frame(width: size, height: size)
            .badgeHole(dot: style == nil ? 0 : rule.side, gap: style == nil ? 0 : rule.ring, offset: rule.shift)
            .overlay(alignment: .bottomTrailing) {
                if let style {
                    PresenceDot(style: style, side: rule.side, stroke: rule.ring)
                        .offset(x: rule.shift, y: rule.shift)
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

/// The presence dot's sizes on a picture `avatar` pt wide (docs/PRESENCE.md §11.9, the same rule as Desktop / Web and
/// Android): the dot with its ring is about two fifths of the picture, 10 to 20 pt (18–26 pt pictures 10, 30 pt 11,
/// 36 pt 14, 40 pt 15, 56 pt and up 20); the ring is three twentieths of it to the nearest half point (1.5 / 2 / 2.5 / 3),
/// and it reaches a fifth of itself (at least 2 pt) past the corner, three tenths on pictures of 20 pt or less so it
/// keeps clear of the initials. Until 2026-10-23 the colour was 0.3 × the picture − 2 pt in a 2 pt ring (4.6 pt of colour
/// on the home's 22 pt DM pictures).
struct PresenceDotRule: Equatable {
    /// The dot's diameter with its ring.
    let diameter: CGFloat
    /// The ring (the hole's gap around the colour, and the offline ring's grey stroke).
    let ring: CGFloat
    /// How far the dot's outer edge reaches past the picture's corner.
    let overhang: CGFloat

    init(avatar size: CGFloat) {
        let dot = min(20, max(10, (size * 0.38).rounded()))
        diameter = dot
        ring = (dot * 3 / 10).rounded() / 2
        overhang = size <= 20 ? (dot * 0.3).rounded() : max(2, (dot * 0.2).rounded())
    }

    /// The colour's diameter (inside the ring).
    var side: CGFloat { diameter - ring * 2 }
    /// How far the colour circle moves down and right from the picture's bottom-trailing corner.
    var shift: CGFloat { overhang - ring }
}

/// A message's sender picture with their presence dot (PRESENCE.md §11.5) in the message lists: conversations and DMs,
/// threads, the channel preview, the times feed, followed threads and search results. Its own view so that it alone
/// reads the presence: a presence or 取り込み中 change redraws these pictures, not the rows (MessageRow is `.equatable()`
/// and skips its body), and the upside-down conversation keeps its layout (the dot is an overlay, the hole a mask).
/// Hidden from VoiceOver like every picture here: the row reads the sender's name.
struct SenderAvatar: View {
    let id: String
    let name: String
    var size: CGFloat = 36
    let store: Store

    var body: some View {
        AvatarView(id: id, name: name, size: size, presence: Self.look(id, store: store))
    }

    /// The sender's dot: none for a bot (an incoming webhook posts as one, the AI bot is one), else the store's look
    /// (online / away / dnd, or offline's hollow ring).
    static func look(_ userId: String, store: Store) -> String? { store.dotLook(userId) }
}

/// The presence dot alone (an avatar's corner, the quick status menu's choices): green, orange, 取り込み中's red disc
/// plain (as on Desktop / Web; no white bar since 2026-10-13), or offline's grey ring (hollow: the hole under it shows
/// what is behind the picture, so it reads as a white circle in light mode).
struct PresenceDot: View {
    enum Style: Equatable {
        case online, away, dnd, offline

        /// The dot for a look: "offline" the grey ring; none (nil) draws nothing unless `showOffline`.
        init?(look: String?, showOffline: Bool = false) {
            switch look {
            case "online": self = .online
            case "away": self = .away
            case "dnd": self = .dnd
            case .some: self = .offline
            case nil:
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
    /// The offline ring's stroke (a picture's dot passes its ring width, PresenceDotRule); nil: a fifth of the side.
    var stroke: CGFloat? = nil

    var body: some View {
        Group {
            if style == .offline {
                // Hollow: on a picture the hole under it (badgeHole) shows what is behind, like the ring around it.
                Circle().strokeBorder(style.color, lineWidth: stroke ?? max(1.5, side * 0.2))
            } else {
                Circle().fill(style.color)
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
