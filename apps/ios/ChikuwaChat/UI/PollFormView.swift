import SwiftUI

/// The server's limits (messages/schemas.py PollCreate): 2-10 options of 1-80 characters, a question of 1-200.
enum PollForm {
    static let maxOptions = 10

    /// What is wrong before sending, in the words the form shows (the web's pollProblem, Android's PollForm); nil when
    /// it can go.
    static func problem(question: String, options: [String]) -> String? {
        let filled = options.map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        if question.trimmingCharacters(in: .whitespaces).isEmpty { return "質問を入れてください" }
        if filled.count < 2 { return "選択肢を 2 つ以上入れてください" }
        if Set(filled.map { $0.lowercased() }).count != filled.count { return "同じ選択肢が複数あります" }
        return nil
    }
}

/// 「アンケートを作成」 on the phone (testers, 2026-09-29; the web and Android had it): a question, 2-10 options, and
/// whether one person may pick several. `/poll 質問 | A | B` still makes a single-answer poll at once.
struct PollFormView: View {
    let controller: AppController
    let channelId: String
    let parentId: String?
    @Environment(\.dismiss) private var dismiss
    @State private var question: String
    @State private var options: [String]
    @State private var multiple: Bool
    /// M27: who voted is shown to nobody.
    @State private var anonymous = false
    @State private var busy = false
    @State private var tried = false
    @State private var error: String?

    private var problem: String? { PollForm.problem(question: question, options: options) }

    /// M30: `/日程` alone opens the form filled in (a question, the next weekdays, several answers each).
    init(controller: AppController, channelId: String, parentId: String?, question: String = "", options: [String] = ["", ""],
         multiple: Bool = false) {
        self.controller = controller
        self.channelId = channelId
        self.parentId = parentId
        _question = State(initialValue: question)
        _options = State(initialValue: options.count >= 2 ? options : options + Array(repeating: "", count: 2 - options.count))
        _multiple = State(initialValue: multiple)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("質問") {
                    TextField("例: 次回のミーティングはいつにしますか？", text: $question, axis: .vertical)
                        .onChange(of: question) { _, value in if value.count > 200 { question = String(value.prefix(200)) } }
                }
                Section("選択肢") {
                    ForEach(options.indices, id: \.self) { index in
                        HStack {
                            TextField("選択肢 \(index + 1)", text: Binding(
                                get: { index < options.count ? options[index] : "" },
                                set: { value in if index < options.count { options[index] = String(value.prefix(80)) } }))
                            if options.count > 2 {
                                Button { options.remove(at: index) } label: {
                                    Image(systemName: "minus.circle.fill").foregroundStyle(.red)
                                }
                                .buttonStyle(.plain)
                                .accessibilityLabel("選択肢 \(index + 1) を削除")
                            }
                        }
                    }
                    if options.count < PollForm.maxOptions {
                        Button("選択肢を追加", systemImage: "plus") { options.append("") }
                    }
                }
                Section {
                    Toggle("複数選択を許可する", isOn: $multiple)
                    Toggle(isOn: $anonymous) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("匿名にする")
                            Text("誰が投票したかを表示しません").font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
                if let message = error ?? (tried ? problem : nil) {
                    Text(message).font(.footnote).foregroundStyle(.red)
                }
            }
            .navigationTitle("アンケートを作成")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("キャンセル") { dismiss() }.disabled(busy) }
                ToolbarItem(placement: .confirmationAction) { Button(busy ? "作成中…" : "作成", action: create).disabled(busy) }
            }
        }
        .interactiveDismissDisabled(busy)
    }

    private func create() {
        tried = true
        error = nil
        guard problem == nil, !busy else { return }
        busy = true
        let filled = options.map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        Task {
            let made = await controller.createPoll(channelId: channelId, parentId: parentId, question: question.trimmingCharacters(in: .whitespaces),
                                                   options: filled, multiple: multiple, anonymous: anonymous)
            busy = false
            if made {
                dismiss()
            } else {
                // Said here: the toast is under this sheet.
                error = controller.error ?? ErrorMessages.unknown
                controller.error = nil
            }
        }
    }
}
