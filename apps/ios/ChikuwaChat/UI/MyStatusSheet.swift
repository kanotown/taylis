import SwiftUI

/// Where the quick status menu sends me: the presenter goes there once the sheet is gone.
enum MyStatusDestination: Equatable {
    case setStatus, editProfile, settings, attendanceBoard
}

extension View {
    /// Presents the quick status menu (MyStatusSheet) over this view, and goes where one of its rows pointed only once
    /// the sheet is gone: the 自分 sheet of the split cannot open while this one is still closing, and a tab switch
    /// under a closing sheet looked odd. Both presenters (MainView for the home's picture in either layout, YouView for
    /// the one at the top of 自分) share this; each says what the destinations mean where it is.
    func myStatusSheet(isPresented: Binding<Bool>, controller: AppController, showsSettings: Bool = true, showsAttendanceBoard: Bool = true,
                       go: @escaping (MyStatusDestination) -> Void) -> some View {
        modifier(MyStatusPresenter(controller: controller, shown: isPresented, showsSettings: showsSettings,
                                   showsAttendanceBoard: showsAttendanceBoard, go: go))
    }
}

private struct MyStatusPresenter: ViewModifier {
    @Bindable var controller: AppController
    @Binding var shown: Bool
    let showsSettings: Bool
    let showsAttendanceBoard: Bool
    let go: (MyStatusDestination) -> Void
    /// The row's destination, remembered until the sheet has closed.
    @State private var destination: MyStatusDestination?

    func body(content: Content) -> some View {
        content.sheet(isPresented: $shown, onDismiss: {
            guard let destination else { return }
            self.destination = nil
            go(destination)
        }) {
            MyStatusSheet(controller: controller, showsSettings: showsSettings, showsAttendanceBoard: showsAttendanceBoard) { destination = $0 }
        }
    }
}

/// The quick status menu (docs/PRESENCE.md §11.6 / §11.7), from my picture at the home's top left and at the top of
/// 自分: a sheet like the 在室状況 pill's. On top my picture with its dot, my name and the current state
/// (「取り込み中（〜15:30）」 with 「解除」); my custom status; the four choices — オンライン（自動）, 離席中, 取り込み中
/// (opens its lengths in place), オフライン表示 — each one tap, then the sheet closes; then 「ステータスを設定」,
/// 在室状況 (my states in place, while the board is on for me), 「プロフィールを編集」 and 設定. A refused choice (an
/// older server's 404, the network) keeps the sheet open with the reason in a line at its bottom.
struct MyStatusSheet: View {
    @Bindable var controller: AppController
    /// 設定 (the 自分 screen); off where the sheet is opened from that screen.
    var showsSettings = true
    /// 在室状況's 「在室状況を開く」.
    var showsAttendanceBoard = true
    let onGo: (MyStatusDestination) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var busy = false
    @State private var durationsShown = false
    @State private var attendanceShown = false
    @State private var fitted: CGFloat?
    @State private var detent: PresentationDetent = .large
    /// The last refusal's reason, shown in the sheet (the toast would be behind it); the next tap clears it.
    @State private var problem: String?

    private var store: Store { controller.store }
    private var me: UserMe? { store.currentMe ?? controller.me }

    var body: some View {
        NavigationStack {
            List {
                if let me {
                    let choice = PresenceRules.myChoice(me)
                    Section {
                        header(me, choice: choice)
                        if let status = activeStatus(me.asPublic) { customStatusRow(status) }
                    }
                    Section {
                        choiceRow(.auto, current: choice)
                        choiceRow(.away, current: choice)
                        dndRow(current: choice)
                        if durationsShown {
                            ForEach(DndDuration.allCases) { duration in durationRow(duration) }
                        }
                        choiceRow(.invisible, current: choice)
                    }
                    Section {
                        Button { go(.setStatus) } label: { YouRow(title: tr("ステータスを設定"), symbol: "face.smiling") }
                            .foregroundStyle(Color.primary)
                        attendanceRows(me)
                        Button { go(.editProfile) } label: { YouRow(title: tr("プロフィールを編集"), symbol: "person.crop.circle") }
                            .foregroundStyle(Color.primary)
                        if showsSettings {
                            Button { go(.settings) } label: { YouRow(title: tr("設定"), symbol: "gearshape") }
                                .foregroundStyle(Color.primary)
                        }
                    }
                }
            }
            .navigationTitle("自分のステータス")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("閉じる") { dismiss() } }
            }
            .safeAreaInset(edge: .bottom, spacing: 0) { SheetProblemLine(problem: problem) }
            .modifier(ContentHeightProbe { height in
                // Once, as the sheet opens (a later change, such as the lengths opening, would move it under the finger).
                guard fitted == nil, height > 0 else { return }
                fitted = height
                detent = .height(height)
            })
        }
        .presentationDetents(fitted.map { [.height($0), .large] } ?? [.large], selection: $detent)
    }

    // MARK: rows

    private func header(_ me: UserMe, choice: PresenceChoice) -> some View {
        HStack(spacing: 12) {
            AvatarView(id: me.id, name: me.displayName, size: 44, presence: store.presenceOf(me.id), showOffline: true)
            VStack(alignment: .leading, spacing: 2) {
                Text(me.displayName).font(.headline).lineLimit(1)
                Text(PresenceRules.myLine(me)).font(.subheadline).foregroundStyle(.secondary).lineLimit(1)
            }
            .accessibilityElement(children: .combine)
            Spacer(minLength: 8)
            if choice == .dnd {
                // Keyed: the catalog's 「解除」 is 「Unblock」 in English (the block list's).
                Button(tr(LocalizedStringResource("presence.clear", defaultValue: "解除"))) { endPause() }  // i18n-ignore: keyed (presence.clear)
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                    .disabled(busy)
                    .accessibilityHint("取り込み中を解除して通知を再開")
            }
        }
        .padding(.vertical, 2)
    }

    private func customStatusRow(_ status: (emoji: String, text: String)) -> some View {
        Button { go(.setStatus) } label: {
            HStack(spacing: 12) {
                if status.emoji.isEmpty {
                    Image(systemName: "face.smiling").foregroundStyle(.secondary).frame(width: 28)
                } else {
                    StatusGlyph(controller: controller, emoji: status.emoji, size: 20).frame(width: 28)
                }
                Text(status.text.isEmpty ? status.emoji : status.text).lineLimit(1)
                Spacer(minLength: 0)
            }
            .contentShape(Rectangle())
        }
        .foregroundStyle(Color.primary)
        .accessibilityLabel(tr("ステータス：\(status.emoji) \(status.text)"))
    }

    private func choiceFace(_ choice: PresenceChoice, current: PresenceChoice, trailing: some View = EmptyView()) -> some View {
        HStack(spacing: 12) {
            PresenceDot(style: PresenceDot.Style(look: choice.look, showOffline: true) ?? .offline, side: 12)
                .frame(width: 28)
            VStack(alignment: .leading, spacing: 1) {
                Text(choice.label)
                Text(choice.hint).font(.caption).foregroundStyle(.secondary)
            }
            Spacer(minLength: 8)
            if choice == current { Image(systemName: "checkmark").fontWeight(.semibold).foregroundStyle(Color.accentColor) }
            trailing
        }
        .contentShape(Rectangle())
    }

    private func choiceRow(_ choice: PresenceChoice, current: PresenceChoice) -> some View {
        Button { choose(choice) } label: { choiceFace(choice, current: current) }
            .foregroundStyle(Color.primary)
            .disabled(busy)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(choice.label + tr("、") + choice.hint)
            .accessibilityAddTraits(choice == current ? [.isButton, .isSelected] : .isButton)
    }

    /// 取り込み中: a tap opens its lengths below it (§11.2).
    private func dndRow(current: PresenceChoice) -> some View {
        Button { withAnimation { durationsShown.toggle() } } label: {
            choiceFace(.dnd, current: current, trailing: Image(systemName: "chevron.right")
                .font(.footnote.weight(.semibold)).foregroundStyle(.tertiary)
                .rotationEffect(.degrees(durationsShown ? 90 : 0)))
        }
        .foregroundStyle(Color.primary)
        .disabled(busy)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(PresenceChoice.dnd.label + tr("、") + PresenceChoice.dnd.hint)
        .accessibilityHint(durationsShown ? "" : tr("取り込み中にする長さを選びます"))
        .accessibilityAddTraits(current == .dnd ? [.isButton, .isSelected] : .isButton)
    }

    private func durationRow(_ duration: DndDuration) -> some View {
        Button { choose(.dnd, duration: duration) } label: {
            Text(duration.label).padding(.leading, 40).frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
        }
        .foregroundStyle(Color.primary)
        .disabled(busy)
        .accessibilityLabel(tr("取り込み中：\(duration.label)"))
    }

    /// 在室状況 (PRESENCE.md §7.1): my state, a tap opens my states in place (the pill's rule for the note), then
    /// 「在室状況を開く」. Not for guests, and only while the board is on.
    @ViewBuilder
    private func attendanceRows(_ me: UserMe) -> some View {
        let board = store.attendance
        if AttendanceRules.pillVisible(board: board, role: me.role), let board {
            let current = AttendanceRules.myState(board, me.id)
            let mine = AttendanceRules.entry(board, me.id)
            Button { withAnimation { attendanceShown.toggle() } } label: {
                HStack(spacing: 12) {
                    Image(systemName: "door.left.hand.open").foregroundStyle(Color.accentColor).frame(width: 28)
                    Text(current.map { tr("在室状況：\($0.label)") } ?? tr("在室状況を設定")).lineLimit(1)
                    Spacer(minLength: 8)
                    Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(.tertiary)
                        .rotationEffect(.degrees(attendanceShown ? 90 : 0))
                }
                .contentShape(Rectangle())
            }
            .foregroundStyle(Color.primary)
            if attendanceShown {
                ForEach(AttendanceRules.myChoices(board, me: me.id)) { state in
                    Button { chooseAttendance(state) } label: {
                        HStack(spacing: 10) {
                            AttendanceGlyph(controller: controller, state: state, size: 15)
                                .foregroundStyle(AttendancePalette.solid(state.color))
                                .frame(width: 22)
                            Text(state.label).lineLimit(1)
                            Spacer(minLength: 8)
                            if AttendanceRules.isSelected(state, mine: mine) {
                                Image(systemName: "checkmark").fontWeight(.semibold).foregroundStyle(Color.accentColor)
                            }
                        }
                        .padding(.leading, 40)
                        .contentShape(Rectangle())
                    }
                    .foregroundStyle(Color.primary)
                    .disabled(busy)
                    .accessibilityAddTraits(AttendanceRules.isSelected(state, mine: mine) ? [.isButton, .isSelected] : .isButton)
                }
                if showsAttendanceBoard {
                    Button { go(.attendanceBoard) } label: {
                        Text("在室状況を開く").padding(.leading, 40).frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
                    }
                }
            }
        }
    }

    // MARK: actions

    /// One tap changes it; the sheet closes once the server took it (a refusal shows the reason and stays).
    private func choose(_ choice: PresenceChoice, duration: DndDuration? = nil) {
        run { await controller.setMyPresence(choice, duration: duration) }
    }

    /// 「解除」: the pause alone ends (the settings' 「通知を再開」, PRESENCE.md §11.1), not 離席中 or 「在席を隠す」 chosen
    /// in the settings, which `auto` would clear too.
    private func endPause() {
        run { await controller.endMyPause() }
    }

    private func chooseAttendance(_ state: AttendanceStateOut) {
        run { await controller.switchMyAttendance(to: state) }
    }

    /// One change at a time: the sheet closes once the server took it, else it stays with the reason.
    private func run(_ change: @escaping () async -> Bool) {
        guard !busy else { return }
        busy = true
        problem = nil
        Task {
            let ok = await change()
            busy = false
            if ok { dismiss() } else { problem = controller.takeError() }
        }
    }

    private func go(_ destination: MyStatusDestination) {
        onGo(destination)
        dismiss()
    }
}

/// A sheet's own line for a refusal's reason, along its bottom edge (over the rows, so it shows whatever the sheet's
/// height and scroll): the toast (ErrorToast) is drawn behind a presented sheet. Nothing while there is none.
struct SheetProblemLine: View {
    let problem: String?

    var body: some View {
        if let problem {
            Text(problem)
                .font(.footnote)
                .foregroundStyle(.red)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 20)
                .padding(.vertical, 8)
                .background(.bar)
                .accessibilityIdentifier("sheet.problem")
        }
    }
}
