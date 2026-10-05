import SwiftUI

/// M71: what the 「AI に聞く」 sheet opens on.
enum AskSheetMode: String, Identifiable {
    case answer, history

    var id: String { rawValue }
}

/// M71: GET /ai/ask/target as read for one question (`key`: the question and the conversation). `target` nil: it could
/// not be told (a server without 「AI に聞く」, a failure) and the entry stays hidden.
struct AskTargetRead: Equatable {
    let key: String
    let target: AiAskTargetOut?
}

/// M71 (docs/AI.md §13.6, as the desktop's AskPanel): the 「AI に聞く」 row at the top of the message results. The button,
/// the line saying where the question goes (or, in red, why it cannot be asked, the button then disabled), 「履歴」, and
/// while a question is followed, a way back to its answer and × to forget it.
struct AiAskBar: View {
    let hub: AiHub
    let target: AiAskTargetOut?
    let canAsk: Bool
    let onAsk: () -> Void
    let onSheet: (AskSheetMode) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 10) {
                Button(action: onAsk) {
                    Label("AI に聞く", systemImage: "sparkles").font(.subheadline.weight(.semibold))
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.small)
                .disabled(!canAsk)
                Spacer(minLength: 0)
                Button { onSheet(.history) } label: {
                    Label("履歴", systemImage: "clock.arrow.circlepath").font(.subheadline)
                }
                .buttonStyle(.borderless)
                .accessibilityLabel("過去の質問")
            }
            if let target, let line = AskRules.targetLine(target) {
                Text(line).font(.footnote).foregroundStyle(target.available ? Color.secondary : Color.red)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let session = hub.ask {
                HStack(spacing: 8) {
                    Button { onSheet(.answer) } label: {
                        Label { Text("「\(session.question)」の答え\(Self.state(session.phase))").lineLimit(1) } icon: { Image(systemName: "text.bubble") }
                            .font(.subheadline)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.borderless)
                    Button { hub.closeAsk() } label: { Image(systemName: "xmark").font(.footnote) }
                        .buttonStyle(.borderless)
                        .tint(.secondary)
                        .accessibilityLabel("AI の答えを閉じる")
                }
            }
        }
        .padding(.vertical, 4)
    }

    private static func state(_ phase: AiAskSession.Phase) -> String {
        switch phase {
        case .starting, .working: return tr(" (作成中)")
        case .done: return ""
        case .failed: return tr(" (失敗)")
        }
    }
}

/// M71: the answer — the question, progress while the run looks for messages and writes, then the Markdown answer whose
/// [n] open the cited messages, the omitted private hits' note, the sources (sender, conversation, date, excerpt), that
/// only I see it, and the provider and model. 「履歴」 lists my past questions (GET /ai/runs?kind=ask).
struct AiAskSheet: View {
    @Bindable var controller: AppController
    let hub: AiHub
    var startInHistory = false
    /// A cited message (an [n] or a source row): shown in its conversation (its thread for a reply).
    let onOpen: (AiSourceOut) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var showingHistory: Bool?
    @State private var history: [AiRunOut]?
    @State private var historyFailed = false
    @State private var copied = false

    private var store: Store { controller.store }
    private var inHistory: Bool { showingHistory ?? (startInHistory || hub.ask == nil) }

    var body: some View {
        NavigationStack {
            Group {
                if inHistory { historyList } else { answer }
            }
            .navigationTitle(inHistory ? "過去の質問" : "AI に聞く")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("閉じる") { dismiss() } }
                if inHistory {
                    if hub.ask != nil {
                        ToolbarItem(placement: .primaryAction) { Button("答え") { showingHistory = false } }
                    }
                } else {
                    if case .done(let output, _, _) = hub.ask?.phase, !output.isEmpty {
                        ToolbarItem(placement: .primaryAction) {
                            Button(copied ? "コピーしました" : "コピー") {
                                UIPasteboard.general.string = output
                                copied = true
                            }
                        }
                    }
                    ToolbarItem(placement: .primaryAction) {
                        Button { showingHistory = true } label: { Label("履歴", systemImage: "clock.arrow.circlepath") }
                            .accessibilityLabel("過去の質問")
                    }
                }
            }
        }
        .presentationDragIndicator(.visible)
        .task(id: inHistory) {
            guard inHistory else { return }
            historyFailed = false
            if let runs = await hub.askHistory() { history = runs } else if history == nil { historyFailed = true }
        }
    }

    // MARK: the answer

    private var answer: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                if let session = hub.ask {
                    Text("「\(session.question)」").font(.headline).fixedSize(horizontal: false, vertical: true)
                    content(session)
                }
                Text(AskRules.footer).font(.caption).foregroundStyle(.secondary)
                if let caption = hub.ask?.run.flatMap(AiRules.runCaption) {
                    Text(caption).font(.caption2).foregroundStyle(.secondary)
                        .accessibilityLabel("送り先: \(caption)")
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(16)
        }
    }

    @ViewBuilder
    private func content(_ session: AiAskSession) -> some View {
        switch session.phase {
        case .starting:
            progress(AskRules.startingText)
        case .working(let running):
            progress(AskRules.progressText(running: running))
        case .done(let output, let omitted, let sources):
            if output.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                Text("答えがありませんでした").foregroundStyle(.secondary)
            } else {
                let base = controller.api?.baseUrl
                MessageBodyView(text: AskRules.linkCitations(output, sources: sources, base: base), users: store.users, groups: store.groups,
                                internalBase: base, customEmoji: store.customEmoji, citations: true)
                    .environment(\.openURL, OpenURLAction { url in
                        guard url.scheme == Permalink.scheme, let id = url.host else { return .systemAction } // outside links: no preview
                        if let source = AskRules.source(messageId: id, in: sources) { onOpen(source) } else { Task { await controller.openPermalink(id) } }
                        return .handled
                    })
            }
            if let note = AskRules.omittedNote(omitted) {
                Label(note, systemImage: "lock").font(.footnote).foregroundStyle(.secondary)
            }
            if !sources.isEmpty { sourceList(sources) }
        case .failed(let message):
            VStack(alignment: .leading, spacing: 10) {
                Label(message, systemImage: "exclamationmark.triangle").foregroundStyle(.red)
                if !session.request.question.isEmpty {
                    Button("もう一度") { Task { await hub.retryAsk() } }
                        .buttonStyle(.bordered)
                }
            }
        }
    }

    private func sourceList(_ sources: [AiSourceOut]) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("出典").font(.footnote.weight(.semibold)).foregroundStyle(.secondary)
            ForEach(sources, id: \.n) { source in
                Button { onOpen(source) } label: { sourceRow(source) }
                    .buttonStyle(.plain)
            }
        }
    }

    private func sourceRow(_ source: AiSourceOut) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text("[\(source.n)]").font(.footnote.weight(.semibold)).foregroundStyle(Color.accentColor)
            VStack(alignment: .leading, spacing: 2) {
                Text(sourceMeta(source)).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                Text(source.excerpt).font(.footnote).foregroundStyle(.primary).lineLimit(2)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .padding(.vertical, 6)
        .padding(.horizontal, 8)
        .background(Color.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 8))
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityHint("このメッセージを開きます")
    }

    private func sourceMeta(_ source: AiSourceOut) -> String {
        let sender = store.users[source.senderId]?.displayName ?? "?"
        let conversation = store.channel(source.channelId).map { channelTitle($0, store: store) } ?? tr("会話")
        return [sender, conversation + (source.parentId != nil ? tr(" · スレッド") : ""), Timeline.fullLabel(source.createdAt)]
            .filter { !$0.isEmpty }
            .joined(separator: " · ")
    }

    private func progress(_ text: String) -> some View {
        HStack(spacing: 10) {
            ProgressView()
            Text(text).foregroundStyle(.secondary)
        }
        .padding(.vertical, 24)
        .frame(maxWidth: .infinity)
    }

    // MARK: past questions

    private var historyList: some View {
        List {
            if let history {
                if history.isEmpty {
                    Text("まだ質問していません").foregroundStyle(.secondary)
                }
                ForEach(history, id: \.id) { run in
                    Button {
                        hub.showAskRun(run)
                        showingHistory = false
                    } label: {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(run.question ?? tr("(質問)")).lineLimit(2).foregroundStyle(.primary)
                            Text(Timeline.fullLabel(run.createdAt) + (run.status == "failed" ? tr(" · 失敗") : run.isFinished ? "" : tr(" · 作成中")))
                                .font(.caption).foregroundStyle(.secondary)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .contentShape(Rectangle())
                    }
                    .foregroundStyle(.primary)
                }
            } else if historyFailed {
                Text("過去の質問を読み込めませんでした").foregroundStyle(.red)
            } else {
                HStack(spacing: 8) {
                    ProgressView()
                    Text("読み込んでいます…").foregroundStyle(.secondary)
                }
            }
        }
        .listStyle(.insetGrouped)
    }
}
