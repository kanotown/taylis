import SwiftUI

/// A poll under a message (M14b): options with counts and bars; tapping votes, only its author can close it.
struct PollCardView: View {
    let poll: PollOut
    let message: MessageState
    @Bindable var controller: AppController

    private var me: String? { controller.store.me?.id }
    private var total: Int { poll.votes.reduce(0) { $0 + $1.count } }
    /// Not an admin either (testers, 2026-09-29): the poll is its author's.
    private var canClose: Bool { poll.closedAt == nil && message.senderId == me }

    /// The server makes a poll's text 「📊 質問」 for previews, pushes and search (DATA_MODEL.md); under it the card shows
    /// the question again, and testers saw it twice in a row (2026-09-29). Text the author wrote stays.
    static func hidesBody(_ body: String, poll: PollOut?) -> Bool {
        guard let poll else { return false }
        return body.trimmingCharacters(in: .whitespacesAndNewlines) == "📊 \(poll.question)".trimmingCharacters(in: .whitespacesAndNewlines)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Text("📊 " + poll.question).font(.subheadline.weight(.semibold))
                if poll.multiple { Text("複数選択可").font(.caption2).foregroundStyle(.secondary) }
            }
            ForEach(Array(poll.options.enumerated()), id: \.offset) { index, option in
                let voters = index < poll.votes.count ? poll.votes[index] : []
                let mine = me.map(voters.contains) ?? false
                let share = total == 0 ? 0 : Double(voters.count) / Double(total)
                Button {
                    Task { _ = await controller.vote(message, option: index, present: !mine) }
                } label: {
                    VStack(alignment: .leading, spacing: 3) {
                        HStack {
                            if mine { Image(systemName: "checkmark.circle.fill").foregroundStyle(Color.accentColor) }
                            Text(option).foregroundStyle(.primary)
                            Spacer()
                            Text("\(voters.count)").font(.caption).foregroundStyle(.secondary)
                        }
                        GeometryReader { geometry in
                            ZStack(alignment: .leading) {
                                Capsule().fill(Color.secondary.opacity(0.15))
                                Capsule().fill(mine ? Color.accentColor : Color.secondary.opacity(0.5)).frame(width: geometry.size.width * share)
                            }
                        }
                        .frame(height: 5)
                    }
                    .padding(.horizontal, 8).padding(.vertical, 6)
                    .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 8))
                }
                .buttonStyle(.plain)
                .disabled(poll.closedAt != nil || message.pending)
            }
            HStack {
                Text(poll.closedAt != nil ? "締め切りました · \(total) 票" : "\(total) 票").font(.caption).foregroundStyle(.secondary)
                Spacer()
                if canClose { Button("締め切る") { Task { _ = await controller.closePoll(message) } }.font(.caption) }
            }
        }
        .padding(10)
        .background(Color(.tertiarySystemBackground), in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(Color.secondary.opacity(0.2)))
        .padding(.top, 4)
    }
}
