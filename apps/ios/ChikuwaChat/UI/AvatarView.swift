import SwiftUI

/// Initials on a colour derived from the user id; no image uploads in v1.
struct AvatarView: View {
    let id: String
    let name: String
    var size: CGFloat = 36

    var body: some View {
        Text(Timeline.initials(name))
            .font(.system(size: size * 0.42, weight: .bold))
            .foregroundStyle(.white)
            .frame(width: size, height: size)
            .background(Color(hue: Timeline.hue(id), saturation: 0.55, brightness: 0.72), in: RoundedRectangle(cornerRadius: size / 4, style: .continuous))
            .accessibilityHidden(true)
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
