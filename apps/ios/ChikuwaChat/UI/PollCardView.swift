import SwiftUI

/// A poll under a message (M14b): options with counts and bars; tapping votes, only its author can close it. M27: a
/// named poll says who voted for each option; an anonymous one says only how many.
struct PollCardView: View {
    let poll: PollOut
    let message: MessageState
    @Bindable var controller: AppController
    /// A channel read before joining (M27): nothing to vote with.
    var readOnly = false

    private var me: String? { controller.store.me?.id }
    private var total: Int { poll.total }
    /// Not an admin either (testers, 2026-09-29): the poll is its author's.
    private var canClose: Bool { !readOnly && poll.closedAt == nil && message.senderId == me }

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
                if poll.isAnonymous { Label("匿名", systemImage: "eye.slash").font(.caption2).foregroundStyle(.secondary) }
            }
            ForEach(Array(poll.options.enumerated()), id: \.offset) { index, option in
                let count = poll.count(index)
                let mine = poll.votedByMe(index, me: me)
                let share = total == 0 ? 0 : Double(count) / Double(total)
                Button {
                    Task { _ = await controller.vote(message, option: index, present: !mine) }
                } label: {
                    VStack(alignment: .leading, spacing: 3) {
                        HStack {
                            if mine { Image(systemName: "checkmark.circle.fill").foregroundStyle(Color.accentColor) }
                            Text(option).foregroundStyle(.primary)
                            Spacer()
                            Text("\(count)").font(.caption).foregroundStyle(.secondary)
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
                    .background(Color(.tertiarySystemBackground), in: RoundedRectangle(cornerRadius: 8))
                }
                .buttonStyle(.plain)
                .disabled(readOnly || poll.closedAt != nil || message.pending)
                voterLine(index)
            }
            HStack {
                Text(poll.closedAt != nil ? "締め切りました · \(total) 票" : "\(total) 票").font(.caption).foregroundStyle(.secondary)
                Spacer()
                if canClose { Button("締め切る") { Task { _ = await controller.closePoll(message) } }.font(.caption).frame(minHeight: 32) }
            }
        }
        .padding(10)
        // The card a shade off the page and the options a shade off the card, in light and in dark (the card was the
        // page's own colour in light mode: only its outline showed; audit 2026-09-29).
        .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(Color.secondary.opacity(0.2)))
        .padding(.top, 4)
    }

    /// Who voted for option `index`, a few names and a tap for everyone (a named poll with votes).
    @ViewBuilder
    private func voterLine(_ index: Int) -> some View {
        let names = PeopleList.names(poll.voters(index), store: controller.store)
        if !names.isEmpty {
            Menu {
                ForEach(Array(names.enumerated()), id: \.offset) { _, name in Text(name) }
            } label: {
                Text(PeopleList.compact(names)).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
            }
            .padding(.leading, 8)
            .accessibilityLabel("投票した人: " + names.joined(separator: "、"))
        }
    }
}
