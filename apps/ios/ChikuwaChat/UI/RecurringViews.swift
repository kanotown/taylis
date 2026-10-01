import SwiftUI

/// L6 (M60, RECURRING.md §5, the phone column): a channel's 「定期投稿」 in its details — the list (name, schedule, next
/// time, collecting or not, paused) every member reads, and for the channel's owners and the administrators among its
/// members the full-screen form (add / edit), 今すぐ投稿, 止める / 再開 and 削除 (asked first). As the web's
/// RecurringPostList: the list is read each time the details open (its changes send no events).
struct RecurringPostsSection: View {
    @Bindable var controller: AppController
    let channel: ChannelState
    /// Tests pass a fake; the app uses the controller's client.
    var api: RecurringApi?
    /// Tests pass the channel's members for the form.
    var memberIds: [String]?

    enum Rows: Equatable { case loading, failed, ready([RecurringPostOut]) }

    @State private var rows: Rows = .loading
    @State private var editing: RecurringFormTarget?
    @State private var deleting: RecurringPostOut?
    @State private var busy: String?
    /// The outcome of the last action, under the list.
    @State private var result: (ok: Bool, text: String)?
    @State private var reload = 0

    private var client: RecurringApi? { api ?? controller.api }
    private var manage: Bool { RecurringRules.canManage(channel, isAdmin: controller.isAdmin) && !channel.channel.archived }
    private var localTz: String { CalendarDates.zoneId }
    private var count: Int { if case .ready(let list) = rows { list.count } else { 0 } }

    var body: some View {
        Section {
            switch rows {
            case .loading:
                HStack(spacing: 8) { ProgressView(); Text("読み込み中…").foregroundStyle(.secondary) }
            case .failed:
                Text("読み込めませんでした").foregroundStyle(.red)
            case .ready(let list):
                if list.isEmpty {
                    Text("定期投稿はありません。" + (manage ? "毎週のスレッド (週報など) をボットが立て、返信で提出を集められます。" : ""))
                        .font(.subheadline).foregroundStyle(.secondary)
                }
                ForEach(list) { post in
                    if manage {
                        Menu { actions(post) } label: { RecurringPostRow(post: post, summary: summary(post), busy: busy == post.id) }
                            .buttonStyle(.plain)
                            .accessibilityHint("操作を表示")
                    } else {
                        RecurringPostRow(post: post, summary: summary(post), busy: false)
                    }
                }
            }
            if let result {
                Text(result.text).font(.footnote).foregroundStyle(result.ok ? Color.secondary : Color.red)
            }
            if manage {
                Button("定期投稿を追加", systemImage: "plus") { editing = .new }
                    .disabled(rows == .failed || count >= RecurringRules.maxPerChannel)
            }
        } header: {
            Text("定期投稿")
        }
        .task(id: "\(channel.id):\(reload)") { await load() }
        .fullScreenCover(item: $editing) { target in
            RecurringPostForm(controller: controller, channel: channel, target: target, api: client, memberIds: memberIds) { saved in
                result = (true, saved)
                reload += 1
            }
        }
        .alert("「\(deleting?.name ?? "")」を削除しますか？", isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }),
               presenting: deleting) { post in
            Button("キャンセル", role: .cancel) {}
            Button("削除", role: .destructive) { act(post, done: "削除しました") { try await $0.deleteRecurringPost(id: post.id) } }
        } message: { _ in Text("これまでの投稿と提出状況は残ります。") }
    }

    @ViewBuilder
    private func actions(_ post: RecurringPostOut) -> some View {
        Button("今すぐ投稿", systemImage: "paperplane") { act(post, done: "投稿しました") { _ = try await $0.runRecurringPost(id: post.id) } }
        if post.enabled {
            Button("止める", systemImage: "pause.circle") {
                act(post, done: "止めました") { _ = try await $0.updateRecurringPost(id: post.id, RecurringPostPatch(enabled: false)) }
            }
        } else {
            Button("再開", systemImage: "play.circle") {
                act(post, done: "再開しました") { _ = try await $0.updateRecurringPost(id: post.id, RecurringPostPatch(enabled: true)) }
            }
        }
        Button("編集", systemImage: "pencil") { editing = .post(post) }
        Button("削除", systemImage: "trash", role: .destructive) { deleting = post }
    }

    private func summary(_ post: RecurringPostOut) -> RecurringPostRow.Summary {
        let store = controller.store
        let collect = post.collect.map { spec in
            "回収: " + RecurringRules.targetsSummary(spec, groupName: { store.groups[$0]?.name }, userName: { store.users[$0]?.displayName })
                + " · " + RecurringRules.dueSummary(spec.due)
        }
        return .init(schedule: RecurringRules.scheduleSummary(post.schedule, tz: post.tz, localTz: localTz),
                     next: post.enabled && !post.nextRunAt.isEmpty ? "次回 " + RecurringRules.shortDateTime(post.nextRunAt) : nil,
                     collect: collect ?? "回収なし")
    }

    private func load() async {
        guard let client else { return }
        do {
            rows = .ready(try await client.recurringPosts(channelId: channel.id))
        } catch {
            rows = .failed // a server before M59 too
        }
    }

    private func act(_ post: RecurringPostOut, done: String, _ call: @escaping (RecurringApi) async throws -> Void) {
        guard let client, busy == nil else { return }
        busy = post.id
        result = nil
        Task {
            do {
                try await call(client)
                result = (true, done)
                reload += 1
            } catch {
                result = (false, controller.describe(error))
            }
            busy = nil
        }
    }
}

/// One recurring post in the list.
struct RecurringPostRow: View {
    struct Summary: Equatable {
        let schedule: String
        let next: String?
        let collect: String
    }

    let post: RecurringPostOut
    let summary: Summary
    var busy = false

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "calendar.badge.clock")
                .foregroundStyle(post.enabled ? Color.accentColor : Color.secondary)
                .frame(width: 24)
                .padding(.top, 1)
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(post.name).font(.body.weight(.semibold)).foregroundStyle(Color.primary).lineLimit(1)
                    if !post.enabled {
                        Text("停止中").font(.caption2.bold()).foregroundStyle(.secondary)
                            .padding(.horizontal, 5).padding(.vertical, 1)
                            .background(Color.secondary.opacity(0.15), in: RoundedRectangle(cornerRadius: 4))
                    }
                    Spacer(minLength: 0)
                    if busy { ProgressView().controlSize(.small) }
                }
                Text(summary.schedule + (summary.next.map { " · " + $0 } ?? "")).font(.footnote).foregroundStyle(.secondary)
                Text(summary.collect).font(.footnote).foregroundStyle(.secondary).lineLimit(2)
            }
        }
        .padding(.vertical, 2)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }
}

/// What the form opens: a new post, or one to edit.
enum RecurringFormTarget: Identifiable, Hashable {
    case new
    case post(RecurringPostOut)

    var id: String {
        switch self {
        case .new: "new"
        case .post(let post): post.id
        }
    }
}

/// The full-screen form (RECURRING.md §5; the web's dialog): 名前, 本文 (with what the placeholders become), 毎週 (weekdays)
/// or 毎月 (a day) and the time, and 回収 — whom (チャンネルの全員, groups, people) and the due time (N days after, at a
/// time). A new post takes this device's zone; an edited one keeps its own (named when it differs).
struct RecurringPostForm: View {
    @Bindable var controller: AppController
    let channel: ChannelState
    let post: RecurringPostOut?
    var api: RecurringApi?
    var memberIds: [String]?
    /// Says what was done (the list shows it).
    var onSaved: (String) -> Void = { _ in }
    @State private var draft: RecurringDraft
    @State private var busy = false
    @State private var error: String?
    @State private var touched = false
    @State private var members: [String]?
    @Environment(\.dismiss) private var dismiss

    init(controller: AppController, channel: ChannelState, target: RecurringFormTarget, api: RecurringApi?, memberIds: [String]? = nil,
         onSaved: @escaping (String) -> Void = { _ in }) {
        self.controller = controller
        self.channel = channel
        self.api = api
        self.memberIds = memberIds
        self.onSaved = onSaved
        switch target {
        case .new:
            post = nil
            _draft = State(initialValue: RecurringDraft.empty())
        case .post(let post):
            self.post = post
            _draft = State(initialValue: RecurringDraft(post: post))
        }
    }

    private var localTz: String { CalendarDates.zoneId }
    private var zone: String { post?.tz ?? localTz }
    private var title: String { post == nil ? "定期投稿を追加" : "定期投稿を編集" }
    private var store: Store { controller.store }

    /// The channel's people who can submit (bots never do).
    private var people: [String]? {
        (memberIds ?? members)?.filter { store.users[$0]?.role != "bot" }
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("週報", text: $draft.name)
                        .onChange(of: draft.name) { _, _ in error = nil }
                } header: {
                    Text("名前 (ボットの表示名)")
                }
                Section {
                    TextField("**週報 {date}**\nこのスレッドに今週の進捗を返信してください", text: $draft.body, axis: .vertical)
                        .lineLimit(4...12)
                        .onChange(of: draft.body) { _, _ in error = nil }
                } header: {
                    Text("本文")
                } footer: {
                    Text(RecurringRules.placeholderHint())
                }
                scheduleSection
                collectSection
                if let shown = error ?? (touched ? draft.problem : nil) {
                    Section { Text(shown).foregroundStyle(.red).font(.footnote) }
                }
            }
            .environment(\.timeZone, CalendarDates.zone)
            .environment(\.locale, Locale(identifier: "ja_JP"))
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("キャンセル") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(post == nil ? "追加" : "保存") { Task { await save() } }
                        .disabled(busy || (api ?? controller.api) == nil)
                }
            }
            .interactiveDismissDisabled(busy)
            .task { await loadMembers() }
        }
    }

    @ViewBuilder
    private var scheduleSection: some View {
        Section {
            Picker("繰り返し", selection: $draft.kind) {
                Text("毎週").tag(RecurringDraft.Kind.weekly)
                Text("毎月").tag(RecurringDraft.Kind.monthly)
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            if draft.kind == .weekly {
                HStack(spacing: 0) {
                    ForEach(Array(RecurringRules.weekdayLabels.enumerated()), id: \.offset) { day, label in
                        let on = draft.weekdays.contains(day)
                        Button { draft.weekdays = draft.toggledWeekday(day) } label: {
                            Text(label)
                                .font(.subheadline.weight(.semibold))
                                .foregroundStyle(on ? Color.white : Color.primary)
                                .frame(width: 38, height: 38)
                                .background(on ? Color.accentColor : Color.secondary.opacity(0.12), in: Circle())
                        }
                        .buttonStyle(.plain)
                        .frame(maxWidth: .infinity)
                        .accessibilityLabel("\(label)曜日")
                        .accessibilityAddTraits(on ? [.isSelected] : [])
                    }
                }
                .padding(.vertical, 2)
            } else {
                Picker("日", selection: $draft.day) {
                    ForEach(1...31, id: \.self) { day in Text(RecurringRules.dayLabel(day)).tag(day) }
                }
            }
            DatePicker("時刻", selection: timeBinding(\.time), displayedComponents: .hourAndMinute)
        } header: {
            Text("繰り返し")
        } footer: {
            if zone != localTz { Text("時刻は \(zone) の時刻です") }
        }
    }

    @ViewBuilder
    private var collectSection: some View {
        Section {
            Toggle("返信で提出を集める", isOn: $draft.collect)
        } footer: {
            Text("スレッドに返信した人が提出済みになり、締切を過ぎたら未提出の人にだけリマインドします。")
        }
        if draft.collect {
            Section {
                Toggle(isOn: $draft.allMembers) {
                    VStack(alignment: .leading, spacing: 1) {
                        Text("チャンネルの全員")
                        Text("投稿の時点のメンバー").font(.caption).foregroundStyle(.secondary)
                    }
                }
                if !draft.allMembers {
                    NavigationLink {
                        TaskAssigneePicker(controller: controller, memberIds: people, selected: $draft.userIds, title: "提出する人")
                    } label: {
                        LabeledContent("人") {
                            Text(peopleSummary).lineLimit(2)
                        }
                    }
                }
            } header: {
                Text("提出する人")
            } footer: {
                if !draft.allMembers { Text("グループと選んだ人を合わせた、投稿の時点のチャンネルのメンバーが対象です。") }
            }
            let groups = store.groups.values.sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
            if !draft.allMembers && !groups.isEmpty {
                Section("グループ") {
                    ForEach(groups) { group in
                        let on = draft.groupIds.contains(group.id)
                        Button {
                            if on { draft.groupIds.removeAll { $0 == group.id } } else { draft.groupIds.append(group.id) }
                        } label: {
                            HStack {
                                Text("@" + group.name).foregroundStyle(Color.primary)
                                Text("\(group.memberIds.count) 人").font(.caption).foregroundStyle(.secondary)
                                Spacer(minLength: 0)
                                if on { Image(systemName: "checkmark").font(.body.weight(.semibold)).foregroundStyle(Color.accentColor) }
                            }
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityAddTraits(on ? [.isSelected] : [])
                    }
                }
            }
            Section("締切") {
                Picker("締切の日", selection: $draft.afterDays) {
                    ForEach(0...RecurringRules.maxAfterDays, id: \.self) { n in Text(n == 0 ? "投稿した日" : "\(n) 日後").tag(n) }
                }
                DatePicker("締切の時刻", selection: timeBinding(\.dueTime), displayedComponents: .hourAndMinute)
            }
        }
    }

    private var peopleSummary: String {
        draft.userIds.isEmpty ? "なし" : draft.userIds.map { store.users[$0]?.displayName ?? "?" }.joined(separator: "、")
    }

    /// "HH:MM" in the draft as a time of today for the picker (the zone does not matter: only the clock is read back).
    private func timeBinding(_ key: WritableKeyPath<RecurringDraft, String>) -> Binding<Date> {
        Binding(get: {
            let text = draft[keyPath: key]
            let hour = RecurringRules.isTime(text) ? Int(text.prefix(2)) ?? 9 : 9
            let minute = RecurringRules.isTime(text) ? Int(text.suffix(2)) ?? 0 : 0
            return CalendarDates.local.date(bySettingHour: hour, minute: minute, second: 0, of: Date()) ?? Date()
        }, set: { date in
            let p = CalendarDates.local.dateComponents([.hour, .minute], from: date)
            draft[keyPath: key] = String(format: "%02d:%02d", p.hour ?? 0, p.minute ?? 0)
            error = nil
        })
    }

    private func loadMembers() async {
        guard memberIds == nil, members == nil, let client = api ?? controller.api else { return }
        do {
            members = try await client.members(channelId: channel.id).map(\.userId)
        } catch {
            self.error = controller.describe(error)
        }
    }

    private func save() async {
        touched = true
        guard let client = api ?? controller.api, !busy else { return }
        if let problem = draft.problem {
            error = problem
            return
        }
        busy = true
        defer { busy = false }
        do {
            if let post {
                _ = try await client.updateRecurringPost(id: post.id, draft.update)
            } else {
                _ = try await client.createRecurringPost(channelId: channel.id, draft.create(tz: localTz))
            }
            onSaved("保存しました")
            dismiss()
        } catch {
            self.error = controller.describe(error)
        }
    }
}

// MARK: the collection under a post

/// Under a collecting post: 「提出 7/10 · 締切 10/9 (金) 18:00」, with 「未提出」 (amber; red after the due time) when I owe
/// one or 「提出済み」; a tap opens who has and has not (`MessageSheet.collection`).
struct CollectionChipView: View {
    let collection: CollectionOut
    let meId: String?
    /// nil: shown without the tap (a preview).
    var onOpen: (() -> Void)?

    var body: some View {
        // The due time passes while the conversation is open: read the clock again each minute.
        TimelineView(.everyMinute) { context in
            let chip = RecurringRules.chip(collection, meId: meId, now: context.date)
            Button { onOpen?() } label: { face(chip) }
                .buttonStyle(.plain)
                .disabled(onOpen == nil)
                .accessibilityLabel(chip.accessibilityLabel)
                .accessibilityHint(onOpen == nil ? "" : "提出状況を表示")
        }
        .padding(.top, 2)
    }

    private func face(_ chip: RecurringRules.Chip) -> some View {
        let pending = chip.mine == .pending
        let alert: Color = chip.overdue ? .red : .orange
        return HStack(spacing: 5) {
            Image(systemName: chip.complete ? "checkmark.seal.fill" : "tray.and.arrow.up")
                .font(.caption)
                .foregroundStyle(chip.complete ? Color.green : Color.secondary)
            Text(chip.label).font(.caption.weight(.medium)).foregroundStyle(Color.primary).lineLimit(1)
            if pending {
                Text("未提出").font(.caption2.bold()).foregroundStyle(.white)
                    .padding(.horizontal, 5).padding(.vertical, 1)
                    .background(alert, in: RoundedRectangle(cornerRadius: 4))
            } else if chip.mine == .submitted {
                Text("提出済み").font(.caption2.bold()).foregroundStyle(Color.accentColor)
                    .padding(.horizontal, 5).padding(.vertical, 1)
                    .background(Color.accentColor.opacity(0.14), in: RoundedRectangle(cornerRadius: 4))
            }
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 5)
        .background(pending ? alert.opacity(0.10) : Color.clear, in: RoundedRectangle(cornerRadius: 7))
        .overlay(RoundedRectangle(cornerRadius: 7).strokeBorder(pending ? alert.opacity(0.55) : Color.secondary.opacity(0.3)))
        .contentShape(Rectangle())
    }
}

/// 「提出状況」: 提出済み and 未提出 with avatars (any member may look: the thread shows who replied anyway). Live: the
/// conversation hands it the message as it is now.
struct CollectionStatusView: View {
    let message: MessageState
    @Bindable var controller: AppController
    var now: Date? = nil
    @Environment(\.dismiss) private var dismiss

    private var store: Store { controller.store }

    var body: some View {
        NavigationStack {
            List {
                if let collection = message.collection {
                    let lists = RecurringRules.lists(collection)
                    let chip = RecurringRules.chip(collection, meId: store.me?.id, now: now ?? Date())
                    Section {
                        Text(chip.label + (chip.overdue ? " (締切を過ぎました)" : "")).font(.subheadline).foregroundStyle(.secondary)
                    }
                    Section("提出済み \(lists.submitted.count) 人") {
                        if lists.submitted.isEmpty { Text("まだいません").foregroundStyle(.secondary) }
                        ForEach(lists.submitted, id: \.self) { person($0) }
                    }
                    Section {
                        if lists.missing.isEmpty { Text("全員が提出しました").foregroundStyle(.secondary) }
                        ForEach(lists.missing, id: \.self) { person($0) }
                    } header: {
                        Text("未提出 \(lists.missing.count) 人")
                    } footer: {
                        Text("スレッドに返信すると提出済みになります。"
                             + (collection.remindedAt != nil ? "締切後、未提出の人にリマインドしました。" : "締切を過ぎると、未提出の人にだけリマインドが届きます。"))
                    }
                } else {
                    Text("この投稿は提出を集めていません").foregroundStyle(.secondary)
                }
            }
            .navigationTitle("提出状況")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("閉じる") { dismiss() } } }
        }
        .presentationDetents([.medium, .large])
    }

    private func person(_ id: String) -> some View {
        let name = store.users[id]?.displayName ?? "?"
        return HStack(spacing: 10) {
            AvatarView(id: id, name: name, size: 28)
            Text(name)
            if id == store.me?.id { Text("(自分)").font(.caption).foregroundStyle(.secondary) }
        }
    }
}
