import SwiftUI

/// What an open conversation (or its thread) has on screen besides its route and its draft: the place in the list, the
/// keyboard, the tab, the page and the sheet over it. The phone's layout and the split (MOBILE_UI.md §13) build their
/// own conversation views, so a change of layout used to start them afresh: on the iPhone Duo every fold and unfold
/// (MOBILE_UI.md §26), on an iPad a rotation or a resize across the width the split needs.
struct ConversationCarry {
    var tab: ChannelTab = .messages
    /// The row the list is kept at (`keptRowId`): `UpsideDown.newest` (or nil) at the newest edge.
    var keptRowId: String?
    /// The input had the keyboard, or lost it just before the change (the change itself takes it away first).
    var composerFocused = false
    var composerBlurredAt: Date?
    /// The conversation's details page (pushed over it).
    var showInfo = false
    /// A message's sheet (its actions, reactions, …) and the conversation's own (a link, adding a member).
    var messageSheet: MessageSheet?
    var channelSheet: ChannelView.ChannelSheet?
    /// The folder open in the conversation's 「ドライブ」 tab.
    var driveFolderId: String?

    /// The input counts as having had the keyboard: it has it, or lost it at most `focusGrace` before the change.
    func hadKeyboard(at now: Date) -> Bool {
        composerFocused || composerBlurredAt.map { now.timeIntervalSince($0) < LayoutCarry.focusGrace } == true
    }
}

/// The hand-over between the two layouts' conversation views. The views write what they have as it changes (`update`);
/// MainView says when the layout changes (`layoutChanging`), which keeps what the front conversation and its thread
/// had; the new views take it once as they appear (`take`). Not observed: writing it redraws nothing.
final class LayoutCarry {
    struct Key: Hashable {
        let channelId: String
        let parentId: String?
    }

    /// How long a hand-over waits for the new layout's views.
    static let window: TimeInterval = 5
    /// How long after losing the keyboard the input still counts as having it (the change of size class takes it first).
    static let focusGrace: TimeInterval = 1.5

    private var live: [Key: ConversationCarry] = [:]
    private var handed: [Key: ConversationCarry] = [:]
    private var handedAt: Date?

    /// A conversation's (or a thread's, `parentId`) view records a change.
    func update(_ channelId: String, thread parentId: String? = nil, _ change: (inout ConversationCarry) -> Void) {
        change(&live[Key(channelId: channelId, parentId: parentId), default: ConversationCarry()])
    }

    /// What a view has recorded (tests).
    func current(_ channelId: String, thread parentId: String? = nil) -> ConversationCarry? {
        live[Key(channelId: channelId, parentId: parentId)]
    }

    /// A view opened afresh (not from a hand-over): what an earlier view of the same conversation recorded is gone.
    func reset(_ channelId: String, thread parentId: String? = nil) {
        live[Key(channelId: channelId, parentId: parentId)] = nil
    }

    /// The layout is about to change: the front conversation and its open thread hand over what they have.
    func layoutChanging(channelId: String?, parentId: String?, now: Date = Date()) {
        handed = [:]
        handedAt = now
        guard let channelId else { return }
        for key in [Key(channelId: channelId, parentId: nil)] + (parentId.map { [Key(channelId: channelId, parentId: $0)] } ?? []) {
            guard var carry = live[key] else { continue }
            carry.composerFocused = carry.hadKeyboard(at: now)
            carry.composerBlurredAt = nil
            handed[key] = carry
        }
    }

    /// A view of the new layout takes what its predecessor handed over, shortly after the change. Not used up: SwiftUI
    /// may build the new layout's view twice as it settles (measured on the iPhone Duo), and the second must not start
    /// afresh.
    func take(_ channelId: String, thread parentId: String? = nil, now: Date = Date()) -> ConversationCarry? {
        guard let at = handedAt, now.timeIntervalSince(at) < Self.window else { return nil }
        return handed[Key(channelId: channelId, parentId: parentId)]
    }
}

/// A conversation's (ChannelView) or a thread's (ThreadView, `parentId`) side of LayoutCarry: records what changes, and
/// as the view first appears takes what the other layout's view handed over (or, opened afresh, forgets what an earlier
/// view of it had). A thread has no tab, page or conversation sheet.
struct ConversationCarrier: ViewModifier {
    let controller: AppController
    let channelId: String
    var parentId: String? = nil
    var tab: Binding<ChannelTab>? = nil
    @Binding var keptRowId: String?
    var showInfo: Binding<Bool>? = nil
    @Binding var messageSheet: MessageSheet?
    var channelSheet: Binding<ChannelView.ChannelSheet?>? = nil
    /// Where the list is to be put back (the view's `position` takes it).
    @Binding var carriedRowId: String?
    @State private var took = false

    /// `AppController.composerFocus` of a conversation's input (its id) or a thread's.
    static func focusKey(_ channelId: String, thread parentId: String?) -> String {
        parentId.map { "\(channelId)/\($0)" } ?? channelId
    }

    private var carry: LayoutCarry { controller.layoutCarry }

    func body(content: Content) -> some View {
        content
            .onAppear {
                // Once: the navigation lets a view go and come back as it opens.
                guard !took else { return }
                took = true
                guard let handed = carry.take(channelId, thread: parentId) else {
                    carry.reset(channelId, thread: parentId)
                    return
                }
                carry.update(channelId, thread: parentId) { $0 = handed }
                if let row = handed.keptRowId, row != UpsideDown.newest { carriedRowId = row }
                tab?.wrappedValue = handed.tab
                showInfo?.wrappedValue = handed.showInfo
                if handed.composerFocused, handed.tab == .messages, !handed.showInfo, handed.messageSheet == nil, handed.channelSheet == nil {
                    controller.composerFocus = Self.focusKey(channelId, thread: parentId)
                }
                if handed.messageSheet != nil || handed.channelSheet != nil {
                    // Presented once the new layout's screens have settled (a sheet asked for during the change is lost).
                    Task {
                        try? await Task.sleep(for: .milliseconds(600))
                        messageSheet = handed.messageSheet
                        channelSheet?.wrappedValue = handed.channelSheet
                    }
                }
            }
            .onChange(of: tab?.wrappedValue) { _, tab in if let tab { carry.update(channelId) { $0.tab = tab } } }
            .onChange(of: keptRowId) { _, row in carry.update(channelId, thread: parentId) { $0.keptRowId = row } }
            .onChange(of: showInfo?.wrappedValue) { _, shown in carry.update(channelId) { $0.showInfo = shown ?? false } }
            .onChange(of: messageSheet) { _, sheet in carry.update(channelId, thread: parentId) { $0.messageSheet = sheet } }
            .onChange(of: channelSheet?.wrappedValue?.id) { _, _ in
                let sheet = channelSheet?.wrappedValue
                carry.update(channelId) { $0.channelSheet = sheet }
            }
    }
}
