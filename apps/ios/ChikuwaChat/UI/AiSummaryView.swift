import SwiftUI

/// M66 (docs/AI.md §6): the channel's 「要約」 choices (the header's ⋯ and the channel details).
struct AiSummaryMenu: View {
    let channelId: String
    let summarize: (AiSummaryRequest) -> Void

    var body: some View {
        Menu {
            Button("未読を要約", systemImage: "envelope.badge") { summarize(AiSummaryRequest(channelId: channelId, scope: .unread)) }
            Button("直近 1 日を要約", systemImage: "clock") { summarize(AiSummaryRequest(channelId: channelId, scope: .recent(days: 1))) }
            Button("直近 7 日を要約", systemImage: "calendar") { summarize(AiSummaryRequest(channelId: channelId, scope: .recent(days: 7))) }
        } label: {
            Label("要約", systemImage: "sparkles")
        }
        .accessibilityLabel("AI で要約")
    }
}

/// The 「AI」 mark of an AI bot (where other bots say 「BOT」).
struct AiBadge: View {
    var body: some View {
        Text("AI").font(.caption2).bold().foregroundStyle(Color.accentColor)
            .padding(.horizontal, 4).padding(.vertical, 1).background(Color.accentColor.opacity(0.15)).clipShape(RoundedRectangle(cornerRadius: 3))
            .accessibilityLabel("AI のボット")
    }
}

extension View {
    /// The summary sheet over this view while `request` is set; closing it forgets the run (docs/AI.md §2.3: only
    /// the one who asked sees it, and nothing is posted).
    func aiSummarySheet(_ controller: AppController, request: Binding<AiSummaryRequest?>) -> some View {
        sheet(item: request, onDismiss: { controller.aiHub?.closeSummary() }) { request in
            AiSummarySheet(controller: controller, hub: controller.aiHub ?? AiHub(api: nil), request: request)
        }
    }
}

/// The summary: progress while the run is pending / running, then its Markdown (as a message body is drawn), the
/// omitted rows' note, or what went wrong with 「もう一度」.
struct AiSummarySheet: View {
    @Bindable var controller: AppController
    let hub: AiHub
    let request: AiSummaryRequest
    @Environment(\.dismiss) private var dismiss
    @State private var copied = false

    /// The hub's session once it is this request's (or a retry of it); until then, starting.
    private var session: AiSummarySession {
        if let current = hub.summary, current.request.channelId == request.channelId, current.request.scope == request.scope { return current }
        return AiSummarySession(request: request)
    }

    private var subtitle: String? {
        guard let channel = controller.store.channel(request.channelId) else { return nil }
        return channelTitle(channel, store: controller.store)
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    if let subtitle {
                        Text(subtitle).font(.subheadline).foregroundStyle(.secondary)
                    }
                    content
                    Text("要約はあなたにだけ表示されます。会話には投稿されません。")
                        .font(.caption).foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(16)
            }
            .navigationTitle(AiRules.title(request.scope))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("閉じる") { dismiss() } }
                if case .done(let output, _) = session.phase, !output.isEmpty {
                    ToolbarItem(placement: .primaryAction) {
                        Button(copied ? "コピーしました" : "コピー") {
                            UIPasteboard.general.string = output
                            copied = true
                        }
                    }
                }
            }
        }
        .presentationDragIndicator(.visible)
    }

    @ViewBuilder
    private var content: some View {
        switch session.phase {
        case .starting:
            progress("要約を頼んでいます…")
        case .working(let running):
            progress(AiRules.progressText(running: running))
        case .done(let output, let omitted):
            if let note = AiRules.omittedNote(omitted) {
                Label(note, systemImage: "scissors").font(.footnote).foregroundStyle(.secondary)
            }
            if output.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                Text("要約することがありませんでした").foregroundStyle(.secondary)
            } else {
                MessageBodyView(text: output, users: controller.store.users, groups: controller.store.groups, internalBase: controller.api?.baseUrl)
                    .textSelection(.enabled)
            }
        case .failed(let message):
            VStack(alignment: .leading, spacing: 10) {
                Label(message, systemImage: "exclamationmark.triangle").foregroundStyle(.red)
                Button("もう一度") { Task { await hub.retrySummary() } }
                    .buttonStyle(.bordered)
            }
        }
    }

    private func progress(_ text: String) -> some View {
        HStack(spacing: 10) {
            ProgressView()
            Text(text).foregroundStyle(.secondary)
        }
        .padding(.vertical, 24)
        .frame(maxWidth: .infinity)
    }
}

/// M66: the channel details' AI section — the §4 notice while an AI bot is a member, and 「要約」.
struct AiChannelSection: View {
    let channelId: String
    /// AiRules.notice (nil: no AI bot here).
    let notice: String?
    let canSummarize: Bool
    let summarize: (AiSummaryRequest) -> Void

    var body: some View {
        if notice != nil || canSummarize {
            Section("AI") {
                if let notice {
                    Label(notice, systemImage: "sparkles").font(.footnote).foregroundStyle(.secondary)
                }
                if canSummarize { AiSummaryMenu(channelId: channelId, summarize: summarize) }
            }
        }
    }
}
