import SwiftUI

/// The profile picture when the user has one (M14a), else initials on a colour derived from the user id.
struct AvatarView: View {
    let id: String
    let name: String
    var size: CGFloat = 36
    /// "online" / "away" adds the status dot (SYNC_PROTOCOL.md §5.2); nil or "offline" shows none.
    var presence: String? = nil

    var body: some View {
        face
            .frame(width: size, height: size)
            .overlay(alignment: .bottomTrailing) {
                if let presence, presence != "offline" {
                    Circle()
                        .fill(presence == "online" ? Color.green : Color.orange)
                        .frame(width: size * 0.3, height: size * 0.3)
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

func presenceLabel(_ status: String) -> String {
    switch status {
    case "online": return tr("オンライン")
    case "away": return tr("離席中")
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
