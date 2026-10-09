import Foundation

// Models mirror the shared OpenAPI document (openapi/openapi.json); keys are snake_case on the wire.

struct UserPublic: Codable, Identifiable, Equatable, Hashable {
    let id: String
    let username: String
    let displayName: String
    let role: String
    let deactivatedAt: String?
    let createdAt: String
    let updatedAt: String
    /// Profile card (M11d); the server reports an expired status as nil.
    var title: String? = nil
    var statusText: String? = nil
    var statusEmoji: String? = nil
    var statusExpiresAt: String? = nil
    /// Do not disturb (M12c): a manual pause and the daily quiet hours (public, for 🔕 next to the name).
    var dndUntil: String? = nil
    var quietHours: QuietHours? = nil
    /// M14a: when the profile picture changed (nil = no picture); the cache key.
    var avatarUpdatedAt: String? = nil
    /// M98: what a bot is for; "feed" = a channel's feed bot (its link previews load by themselves, LinkPreviewRules).
    var botKind: String? = nil
}

/// A daily window (in the user's zone) during which pushes are held back (M12c).
struct QuietHours: Codable, Equatable, Hashable {
    var start: String
    var end: String
    var days: [Int]
    var tz: String
}

struct UserMe: Codable, Equatable {
    let id: String
    let username: String
    let displayName: String
    let role: String
    let deactivatedAt: String?
    let createdAt: String
    let updatedAt: String
    let email: String?
    let mustChangePassword: Bool
    var title: String? = nil
    var statusText: String? = nil
    var statusEmoji: String? = nil
    var statusExpiresAt: String? = nil
    var dndUntil: String? = nil
    var quietHours: QuietHours? = nil
    /// M12g: words that make a message count as a mention of me.
    var notifyKeywords: [String]? = nil
    var avatarUpdatedAt: String? = nil
    /// L4 (M31): others always see me as offline.
    var presenceHidden: Bool? = nil
    /// M35: what conversations without a level of their own notify me of ("all" / "mentions" / "none"); nil from
    /// servers before M35 (their per-type defaults are the same as "mentions").
    var notificationDefault: String? = nil
    var overallNotification: String { notificationDefault ?? "mentions" }
    /// M39: reactions to my messages as banners (pushes). nil from a server before M39 (no such setting there: the
    /// switch is hidden); off when absent.
    var notifyReactions: Bool? = nil
    var reactionBanners: Bool { notifyReactions ?? false }
    /// M48: false for an account made by Google sign-in (no password to change, no 2FA). nil from a server before M48,
    /// where every account has one.
    var hasPassword: Bool? = nil
    var passwordSet: Bool { hasPassword ?? true }
    /// M50: the long-press quick reactions I chose, the same on every device. A server before M50 leaves the key out
    /// (`.unsupported`: the setting is hidden); null is `.unset` (the recent-first rule).
    var quickReactions: QuickReactionsSetting = .unsupported
    /// M111: my home tiles (the desktop's sidebar items) in order, the same on every device (apps/shared/nav-items.json).
    /// A server before M111 leaves the key out (`.unsupported`: the setting is hidden, the tiles are the defaults); null
    /// is `.unset` (the defaults).
    var navItems: NavItemsSetting = .unsupported
    /// M56 (TASKS.md §5): task assignments and due dates as pushes (and in-app notices). nil from a server before M55
    /// (no tasks there: the switch is hidden, and so is 「タスクにする」); on when absent.
    var notifyTasks: Bool? = nil
    var taskNotices: Bool { notifyTasks ?? true }
    /// The UI language ("ja" / "en" / "zh-Hans"; null = follow the device), the same on every device. A server
    /// without it leaves the key out (`.unsupported`: the choice stays on this device).
    var locale: LocaleSetting = .unsupported

    var asPublic: UserPublic {
        UserPublic(id: id, username: username, displayName: displayName, role: role, deactivatedAt: deactivatedAt, createdAt: createdAt, updatedAt: updatedAt,
                   title: title, statusText: statusText, statusEmoji: statusEmoji, statusExpiresAt: statusExpiresAt,
                   dndUntil: dndUntil, quietHours: quietHours, avatarUpdatedAt: avatarUpdatedAt)
    }
}

/// M50: `UserMe.quick_reactions`, where a missing key (a server that does not know the field) differs from null (not
/// chosen). The overloads below let UserMe's synthesized coding tell the two apart, from the server and from the cache.
enum QuickReactionsSetting: Codable, Equatable {
    case unsupported
    case unset
    case chosen([String])

    /// The emoji I chose, in order; nil when none are (or the server has no such setting).
    var chosen: [String]? {
        if case .chosen(let list) = self { return list }
        return nil
    }

    var isSupported: Bool { self != .unsupported }

    /// Only reached as a bare value; inside UserMe the keyed overloads decide.
    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        self = container.decodeNil() ? .unset : .chosen(try container.decode([String].self))
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .unsupported, .unset: try container.encodeNil()
        case .chosen(let list): try container.encode(list)
        }
    }
}

extension KeyedDecodingContainer {
    func decode(_ type: QuickReactionsSetting.Type, forKey key: Key) throws -> QuickReactionsSetting {
        guard contains(key) else { return .unsupported }
        if try decodeNil(forKey: key) { return .unset }
        return .chosen(try decode([String].self, forKey: key))
    }
}

extension KeyedEncodingContainer {
    mutating func encode(_ value: QuickReactionsSetting, forKey key: Key) throws {
        switch value {
        case .unsupported: break  // left out, as the older server did
        case .unset: try encodeNil(forKey: key)
        case .chosen(let list): try encode(list, forKey: key)
        }
    }
}

/// M111: one sidebar item / home tile and whether it shows (UserMe.nav_items).
struct NavItem: Codable, Equatable, Hashable {
    var key: String
    var visible: Bool
}

/// M111: `UserMe.nav_items`; a missing key (a server before M111) differs from null (not customised), as M50's
/// QuickReactionsSetting.
enum NavItemsSetting: Codable, Equatable {
    case unsupported
    case unset
    case chosen([NavItem])

    /// My list as saved; nil when not customised (or the server has no such setting).
    var chosen: [NavItem]? {
        if case .chosen(let list) = self { return list }
        return nil
    }

    var isSupported: Bool { self != .unsupported }

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        self = container.decodeNil() ? .unset : .chosen(try container.decode([NavItem].self))
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .unsupported, .unset: try container.encodeNil()
        case .chosen(let list): try container.encode(list)
        }
    }
}

extension KeyedDecodingContainer {
    func decode(_ type: NavItemsSetting.Type, forKey key: Key) throws -> NavItemsSetting {
        guard contains(key) else { return .unsupported }
        if try decodeNil(forKey: key) { return .unset }
        return .chosen(try decode([NavItem].self, forKey: key))
    }
}

extension KeyedEncodingContainer {
    mutating func encode(_ value: NavItemsSetting, forKey key: Key) throws {
        switch value {
        case .unsupported: break
        case .unset: try encodeNil(forKey: key)
        case .chosen(let list): try encode(list, forKey: key)
        }
    }
}

/// `UserMe.locale`; a missing key (a server that does not know it) differs from null (follow the device).
enum LocaleSetting: Codable, Equatable {
    case unsupported
    case value(String?)

    var isSupported: Bool { self != .unsupported }

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        self = .value(container.decodeNil() ? nil : try container.decode(String.self))
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .unsupported, .value(nil): try container.encodeNil()
        case .value(let raw?): try container.encode(raw)
        }
    }
}

extension KeyedDecodingContainer {
    func decode(_ type: LocaleSetting.Type, forKey key: Key) throws -> LocaleSetting {
        guard contains(key) else { return .unsupported }
        if try decodeNil(forKey: key) { return .value(nil) }
        return .value(try decode(String.self, forKey: key))
    }
}

extension KeyedEncodingContainer {
    mutating func encode(_ value: LocaleSetting, forKey key: Key) throws {
        switch value {
        case .unsupported: break
        case .value(nil): try encodeNil(forKey: key)
        case .value(let raw?): try encode(raw, forKey: key)
        }
    }
}

/// A custom status (M11d) that has not expired: (emoji, text); nil otherwise.
func activeStatus(_ user: UserPublic?, now: Date = Date()) -> (emoji: String, text: String)? {
    guard let user else { return nil }
    let emoji = user.statusEmoji ?? ""
    let text = user.statusText ?? ""
    if emoji.isEmpty && text.isEmpty { return nil }
    if let expires = user.statusExpiresAt, let date = parseIsoDate(expires), date <= now { return nil }
    return (emoji, text)
}

struct DeviceOut: Codable, Equatable {
    let id: String
    let platform: String
    let deviceName: String?
    let appVersion: String?
    let enabled: Bool
    let disabledReason: String?
    let lastSeenAt: String?
    let createdAt: String
    let updatedAt: String
}

/// One signed-in device of mine (GET /auth/sessions, M40's ログイン中の端末): `current` is this device.
struct SessionOut: Codable, Equatable, Identifiable {
    let id: String
    let device: DeviceOut
    let current: Bool
    let lastIp: String?
    let createdAt: String
    let lastUsedAt: String
    let expiresAt: String
}

/// POST /users/me/test-notification (PUSH_NOTIFICATIONS.md §15): what happened on one device of mine.
struct TestNotificationDevice: Decodable, Equatable, Identifiable {
    let deviceId: String
    let deviceName: String?
    let platform: String
    let pushProvider: String
    let current: Bool
    /// sent / failed / no_token / not_configured / in_app / disabled.
    let status: String
    var detail: String? = nil
    var id: String { deviceId }
}

struct TestNotificationOut: Decodable, Equatable {
    let apnsConfigured: Bool
    let fcmConfigured: Bool
    let dndActive: Bool
    let sentCount: Int
    let devices: [TestNotificationDevice]
}

/// GET /auth/methods (M48): which sign-in buttons the login screen shows.
struct AuthMethodsOut: Decodable, Equatable {
    struct Provider: Decodable, Equatable {
        let enabled: Bool
        /// The Workspace domains the server accepts (missing before the field existed, empty when unrestricted).
        var domains: [String]? = nil
        /// The administrator's name for the organisation (SSO_GOOGLE_LABEL), shown instead of the domain.
        var label: String? = nil
    }

    var password: Bool? = nil
    var google: Provider? = nil
    var googleEnabled: Bool { google?.enabled == true }
    /// What the Google button says; nil when the server does not offer Google sign-in.
    var googleButton: GoogleButtonText? {
        guard let google, google.enabled else { return nil }
        return GoogleButtonText(domains: google.domains ?? [], label: google.label)
    }
}

/// The Google button's words (App Store guideline 4.8, SSO.md §6). A server restricted to Workspace domains names the
/// organisation (its label, else the first domain, 「など」 for several) over 「組織の Google Workspace アカウント」, so the
/// button reads as the organisation's login rather than a consumer one. Unrestricted, or an older server without
/// `domains`: 「Google でログイン」.
struct GoogleButtonText: Equatable {
    let title: String
    let subtitle: String?

    static var google: GoogleButtonText { GoogleButtonText(title: tr("Google でログイン"), subtitle: nil) }

    init(title: String, subtitle: String?) {
        self.title = title
        self.subtitle = subtitle
    }

    init(domains: [String], label: String?) {
        let domains = domains.filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
        guard let first = domains.first else {
            self = .google
            return
        }
        let label = label?.trimmingCharacters(in: .whitespaces) ?? ""
        let org = !label.isEmpty ? label : (domains.count > 1 ? tr("\(first) など") : first)
        self.init(title: tr("\(org) のアカウントでログイン"), subtitle: tr("組織の Google Workspace アカウント"))
    }
}

struct TokenResponse: Codable, Equatable {
    let accessToken: String
    let refreshToken: String
    let tokenType: String
    let expiresIn: Int
    let sessionId: String
    let device: DeviceOut
    let user: UserMe
}

struct MembershipOut: Codable, Equatable {
    let role: String
    let joinedAt: String
}

struct ChannelOut: Codable, Identifiable, Equatable {
    let id: String
    /// Changes when a channel is converted between public and private (M15b).
    var type: String
    let name: String?
    let topic: String?
    let purpose: String?
    var archived: Bool
    let createdBy: String?
    let lastSeq: Int
    /// Moved locally by top-level message.created events (SYNC_PROTOCOL.md §7.4) so the DM list reorders at once.
    var lastMessageAt: String?
    let createdAt: String
    let updatedAt: String
    var membership: MembershipOut?
    let dmUserIds: [String]?
    /// Filled by bootstrap for the requesting user (M8b); nil elsewhere.
    var readState: ReadStateOut? = nil
    /// Per-user notification preference; filled by bootstrap, kept locally across channel.updated events.
    var notification: NotificationPreferenceOut? = nil
    /// How many members the channel has (M11h); lists, single-channel responses and channel events carry it.
    var memberCount: Int? = nil
    /// M15a: "owners" = an announcement channel (only owners and admins start top-level posts).
    var postingPolicy: String? = nil
    /// M24: whose times (work log) this is; nil for other channels, and from servers before M24 that omit it.
    var timesOwnerId: String? = nil
    /// M49 (SYNC_PROTOCOL.md §7.8): the conversation's newest timeline message, for the DM list's preview. Only answers
    /// to a member carry it (bootstrap, GET /channels, GET /channels/{id}, POST /dms); elsewhere, and from servers before
    /// M49, it is nil, which means "not said" (the store keeps the one it holds) except in bootstrap ("no message").
    var lastMessage: LastMessageOut? = nil

    var isDm: Bool { type == "dm" || type == "group_dm" }
    var isAnnouncement: Bool { postingPolicy == "owners" }
    var isTimes: Bool { timesOwnerId != nil }
}

/// M49 (MOBILE_UI.md §7.1): a conversation's newest message as one line. The excerpt follows the push body's rule
/// (Timeline.excerpt, apps/shared/dm-preview.json); the prefix (「あなた: 」 / the sender's name) is the client's.
struct LastMessageOut: Codable, Equatable {
    let id: String
    let senderId: String
    /// "user", or "system" (shown without a prefix).
    let type: String
    let seq: Int
    let excerpt: String
    let hasAttachments: Bool
    let createdAt: String
}

struct NotificationPreferenceOut: Codable, Equatable {
    let channelId: String
    /// The level pushes use: the channel's own, or the one the server resolved from my overall setting (M35). Screens
    /// resolve again with the overall setting they hold (`ChannelState.pushLevel`), which may have changed since.
    let level: String
    let mutedUntil: String?
    /// M35: whether the channel has no level of its own. nil from servers before M35 (and rows stored before), whose
    /// `level` was the channel's own or its type's default and counted as its own in the unread rules.
    let reportedFollowsDefault: Bool?
    /// M35: muted until unmuted (false from older servers).
    let muted: Bool

    init(channelId: String, level: String, mutedUntil: String?, followsDefault: Bool? = nil, muted: Bool = false) {
        self.channelId = channelId
        self.level = level
        self.mutedUntil = mutedUntil
        self.reportedFollowsDefault = followsDefault
        self.muted = muted
    }

    /// The channel's own level (nil = it follows my overall setting): what the unread rules and the pickers use.
    var ownLevel: String? { reportedFollowsDefault == true ? nil : level }
    var followsDefault: Bool { ownLevel == nil }

    enum CodingKeys: String, CodingKey {
        case channelId, level, mutedUntil, muted
        case reportedFollowsDefault = "followsDefault"
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        channelId = try container.decode(String.self, forKey: .channelId)
        level = try container.decode(String.self, forKey: .level)
        mutedUntil = try container.decodeIfPresent(String.self, forKey: .mutedUntil)
        reportedFollowsDefault = try container.decodeIfPresent(Bool.self, forKey: .reportedFollowsDefault)
        muted = try container.decodeIfPresent(Bool.self, forKey: .muted) ?? false
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(channelId, forKey: .channelId)
        try container.encode(level, forKey: .level)
        try container.encode(mutedUntil, forKey: .mutedUntil)
        try container.encodeIfPresent(reportedFollowsDefault, forKey: .reportedFollowsDefault)
        try container.encode(muted, forKey: .muted)
    }
}

/// M35: which messages of a conversation notify me (PUSH_NOTIFICATIONS.md §4). Pushes only: the unread rules take the
/// channel's own level and mute (SYNC_PROTOCOL.md §10.5), never the overall setting.
enum NotificationRules {
    /// The server's `push_level`: the channel's own level if it has one; else nothing when my overall setting is
    /// "none", every message of a DM, mentions in someone else's times (M24), and my overall setting elsewhere.
    static func pushLevel(own: String?, isDm: Bool, othersTimes: Bool, overall: String) -> String {
        if let own { return own }
        if overall == "none" { return "none" }
        if isDm { return "all" }
        if othersTimes { return "mentions" }
        return overall
    }

    /// Where a new message sits: top-level, a reply only in its thread, or a reply also sent to the channel.
    enum Reply: String {
        case none
        case threadOnly = "thread_only"
        case alsoInChannel = "also_in_channel"
    }

    /// The facts about one message the rule looks at (apps/shared/notify-rules.json), for me.
    struct NotifyFacts: Equatable {
        var reply: Reply = .none
        /// In the reply's parent_thread.participant_ids (the thread's followers).
        var follower = false
        /// I unfollowed the thread by hand.
        var unfollowed = false
        /// My id in mentioned_user_ids (by name or group).
        var mentioned = false
        var mentionAll = false
        /// One of my notify_keywords is in the body.
        var keyword = false
        /// M88: the message's type; a system line ("system": the join / leave lines) never notifies.
        var type = "user"
    }

    /// Whether a message (not my own) notifies me at the conversation's resolved `level`, before DND, mute, read
    /// already and looking at it now (PUSH_NOTIFICATIONS.md §4; the server's PushPlanner handle + select_recipients,
    /// checked against apps/shared/notify-rules.json). A reply only in its thread is for its followers and those it
    /// addresses (at level all too), and never for someone who unfollowed it by hand.
    static func notifies(level: String, _ facts: NotifyFacts) -> Bool {
        if level == "none" || facts.type != "user" { return false }
        if facts.reply == .threadOnly && facts.unfollowed { return false }
        let involved = facts.mentionAll || facts.mentioned || facts.keyword || facts.follower
        if level == "mentions" && !involved { return false }
        if facts.reply == .threadOnly && !involved { return false }
        return true
    }

    /// The facts of a live message for me. `thread` is the event's parent_thread; `storedFollowing` my stored thread
    /// state's `following` for the reply's parent (used only when the event carries no parent_thread). The server
    /// follows the thread for everyone a reply mentions by id or by keyword unless they unfollowed it by hand, so such a
    /// reply that left me out of participant_ids means I unfollowed it.
    static func facts(of message: MessageOut, me: UserMe, thread: ParentThread?, storedFollowing: Bool?) -> NotifyFacts {
        var facts = NotifyFacts()
        facts.type = message.type
        facts.reply = message.parentId == nil ? .none : message.alsoInChannel ? .alsoInChannel : .threadOnly
        facts.mentioned = message.mentionedUserIds.contains(me.id)
        facts.mentionAll = message.mentionAll
        facts.keyword = NotifyKeywords.matches(message.body, me.notifyKeywords)
        if let thread {
            facts.follower = thread.participantIds.contains(me.id)
            facts.unfollowed = facts.reply == .threadOnly && (facts.mentioned || facts.keyword) && !facts.follower
        } else if facts.reply != .none {
            facts.follower = storedFollowing ?? false
        }
        return facts
    }

    /// The overall setting's name in the settings picker and in a channel's 「既定 (…)」.
    static func overallLabel(_ overall: String) -> String {
        switch overall {
        case "all": tr("すべての新着メッセージ")
        case "none": tr("なし")
        default: tr("メンションと DM のみ")
        }
    }

    /// A channel's (resolved) level in its menu label.
    static func levelLabel(_ level: String) -> String {
        switch level {
        case "all": tr("すべて")
        case "none": tr("通知しない")
        default: tr("メンションのみ")
        }
    }

    /// MOBILE_POLISH.md D1: the value of the channel details' one 「通知」 row: 「すべて」「メンション」「なし」, and
    /// 「· ミュート」 or 「· 15:30 までミュート」 while muted.
    static func rowValue(level: String, muted: Bool, timedMute: String?) -> String {
        let base = switch level {
        case "all": tr("すべて")
        case "none": tr("なし")
        default: tr("メンション")
        }
        if muted { return base + tr(" · ミュート") }
        if let timedMute { return base + " · " + timedMute }
        return base
    }

    /// The label of a conversation's notification menu: muted (until unmuted), a timed mute ("15:30 までミュート",
    /// `Timeline.muteLabel`), or the level it notifies me of.
    static func menuLabel(level: String, muted: Bool, timedMute: String?) -> String {
        if muted { return tr("通知：ミュート中") }
        if let timedMute { return tr("通知（\(timedMute)）") }
        return tr("通知：\(levelLabel(level))")
    }
}

struct ReadStateOut: Codable, Equatable {
    let lastReadSeq: Int
    let unreadCount: Int
    let mentionCount: Int
    /// M17: created_at of the oldest message counted in unread_count (nil when nothing is unread, or an older server).
    var firstUnreadAt: String? = nil
}

/// A poll on a message (M14b): who voted for each option; counts and "mine" are derived here.
struct PollOut: Codable, Equatable {
    let question: String
    let options: [String]
    var multiple: Bool = false
    var closedAt: String? = nil
    /// Who voted for each option (empty lists in an anonymous poll).
    var votes: [[String]] = []
    /// M27: nobody sees who voted. The next three are absent from a server before M27.
    var anonymous: Bool? = nil
    /// How many voted for each option.
    var counts: [Int]? = nil
    /// The options I voted for, in a response to me; nil in events, which keep what was known (SYNC_PROTOCOL.md §8).
    var mine: [Int]? = nil
    /// M53 (SCHEDULING.md): "choice" or "schedule"; absent from a server before M53 (a choice poll). The rest are a
    /// scheduling poll's, all absent before M53: the candidates (a time or a day each), the zone their labels were
    /// written in, the decision, the ○ △ × per candidate, who answered (first answer first), the comments and, in a
    /// response to me only (events: nil, kept like `mine`), my answers per candidate and my comment ("" = none).
    var kind: String? = nil
    var slots: [ScheduleSlotOut]? = nil
    var tz: String? = nil
    var decided: PollDecidedOut? = nil
    var answers: [SlotAnswersOut]? = nil
    var respondents: [String]? = nil
    var comments: [PollCommentOut]? = nil
    /// "yes" | "maybe" | "no" | nil per candidate (kept as text: an answer a later server adds never fails the message).
    var myAnswers: [String?]? = nil
    var myComment: String? = nil

    var isAnonymous: Bool { anonymous ?? false }
    var isSchedule: Bool { kind == "schedule" }

    /// Who voted for option `index` (none in an anonymous poll).
    func voters(_ index: Int) -> [String] { index < votes.count ? votes[index] : [] }

    func count(_ index: Int) -> Int {
        if let counts, index < counts.count { return counts[index] }
        return voters(index).count
    }

    var total: Int { options.indices.reduce(0) { $0 + count($1) } }

    /// Whether I voted for option `index`. A named poll's voters come with every change, events too (a kept `mine` can be
    /// a vote taken back on another device); an anonymous poll has only what the server told me.
    func votedByMe(_ index: Int, me: String?) -> Bool {
        if !isAnonymous { return me.map(voters(index).contains) ?? false }
        return mine?.contains(index) ?? false
    }

    /// An event's copy (the parts only responses to me carry are nil) with what `local` knew of them (§8).
    func keepingMyPart(of local: PollOut?) -> PollOut {
        guard let local else { return self }
        var poll = self
        if poll.mine == nil { poll.mine = local.mine }
        if poll.myAnswers == nil { poll.myAnswers = local.myAnswers }
        if poll.myComment == nil { poll.myComment = local.myComment }
        return poll
    }

    /// This poll with the parts a response to me (`response`) carries; nil when they change nothing.
    func withMyPart(of response: PollOut) -> PollOut? {
        var poll = self
        var changed = false
        if let mine = response.mine, mine != poll.mine { poll.mine = mine; changed = true }
        if let answers = response.myAnswers, answers != poll.myAnswers { poll.myAnswers = answers; changed = true }
        if let comment = response.myComment, comment != poll.myComment { poll.myComment = comment; changed = true }
        return changed ? poll : nil
    }
}

/// M53: one candidate of a scheduling poll: a time (UTC instants) or a whole day ("YYYY-MM-DD").
struct ScheduleSlotOut: Codable, Equatable {
    var startsAt: String? = nil
    var endsAt: String? = nil
    var date: String? = nil
}

/// M53: who said ○ / △ / × to one candidate, in the order they answered (empty lists in an anonymous poll), and how many.
struct SlotAnswersOut: Codable, Equatable {
    var yes: [String]? = nil
    var maybe: [String]? = nil
    var no: [String]? = nil
    var yesCount: Int? = nil
    var maybeCount: Int? = nil
    var noCount: Int? = nil
}

/// M53: the candidate decided, the event it made (none in a DM, or when decided without one), who and when.
struct PollDecidedOut: Codable, Equatable {
    let index: Int
    var eventId: String? = nil
    var by: String? = nil
    var at: String? = nil
}

/// M53: a comment on a scheduling poll; nobody's (nil) in an anonymous one.
struct PollCommentOut: Codable, Equatable {
    var userId: String? = nil
    let text: String
}

/// A body an edit replaced (M14c); the current body is the message's own.
struct MessageRevisionOut: Codable, Equatable {
    let body: String
    let writtenAt: String
    let replacedAt: String
}

struct ReactionOut: Codable, Equatable {
    let emoji: String
    let count: Int
    let userIds: [String]
}

struct AttachmentOut: Codable, Equatable, Identifiable {
    let id: String
    let filename: String
    let contentType: String
    let sizeBytes: Int64
    let width: Int?
    let height: Int?
    let hasThumbnail: Bool
    let status: String
    let createdAt: String
    /// M79: the server made a poster frame for this video (served at /thumbnail like a photo's thumbnail; a video's
    /// `hasThumbnail` stays false). Absent from servers before M79: false.
    var hasPoster: Bool = false
    /// M79: a video's length; nil when the server does not know it (or is older).
    var durationMs: Int? = nil
    /// M108 (docs/PREVIEWS.md): a PDF's or Office file's preview; nil without one (or from an older server).
    var preview: AttachmentPreviewOut? = nil

    /// A picture: it has a thumbnail. A video with one (its poster) stays a video (M38).
    var isImage: Bool { hasThumbnail && !isVideo }
    var isVideo: Bool { contentType.hasPrefix("video/") }
    /// M82: a video whose poster the server serves at /thumbnail.
    var showsServerPoster: Bool { isVideo && hasPoster }
}

extension AttachmentOut {
    /// By hand only so that `has_poster` may be missing (servers before M79); otherwise as synthesized.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        filename = try c.decode(String.self, forKey: .filename)
        contentType = try c.decode(String.self, forKey: .contentType)
        sizeBytes = try c.decode(Int64.self, forKey: .sizeBytes)
        width = try c.decodeIfPresent(Int.self, forKey: .width)
        height = try c.decodeIfPresent(Int.self, forKey: .height)
        hasThumbnail = try c.decode(Bool.self, forKey: .hasThumbnail)
        status = try c.decode(String.self, forKey: .status)
        createdAt = try c.decode(String.self, forKey: .createdAt)
        hasPoster = try c.decodeIfPresent(Bool.self, forKey: .hasPoster) ?? false
        durationMs = try c.decodeIfPresent(Int.self, forKey: .durationMs)
        preview = try c.decodeIfPresent(AttachmentPreviewOut.self, forKey: .preview)
    }
}

/// M108 (docs/PREVIEWS.md §5): `pending` (the card says 「プレビューを作成中…」), `ready` (the first page at
/// /preview/thumbnail, width × height pixels, every page at /preview/pdf) or `failed` (a plain file row).
struct AttachmentPreviewOut: Codable, Equatable {
    let status: String
    var pages: Int? = nil
    var width: Int? = nil
    var height: Int? = nil

    var isPending: Bool { status == "pending" }
    var isReady: Bool { status == "ready" }
}

struct MessageOut: Codable, Identifiable, Equatable {
    let id: String
    let channelId: String
    let senderId: String
    let seq: Int
    var updatedSeq: Int
    let clientMsgId: String?
    let body: String
    let createdAt: String
    let editedAt: String?
    let deleted: Bool
    var type: String = "user"
    var mentionedUserIds: [String] = []
    var mentionAll: Bool = false
    var reactions: [ReactionOut] = []
    var parentId: String? = nil
    /// M15c: a reply shown in the channel timeline as well as in its thread.
    var alsoInChannel: Bool = false
    var replyCount: Int = 0
    var lastReplyAt: String? = nil
    /// C3 (THREADS.md §3.1): who replied, most recent first, at most 5; older servers send none.
    var replyUserIds: [String] = []
    var attachments: [AttachmentOut] = []
    /// Pinned in the channel (M11c); both nil when not pinned.
    var pinnedAt: String? = nil
    var pinnedBy: String? = nil
    /// M14b: the poll, when the message carries one.
    var poll: PollOut? = nil
    /// M15e: "important" / "urgent", and who acknowledged a message that asked for it (oldest first).
    var priority: String? = nil
    var ackRequested: Bool = false
    var acks: [AckOut] = []
    /// L6 (M59): a recurring post that collects replies; nil otherwise and from older servers.
    var collection: CollectionOut? = nil
    /// L9 (M63): the shared tasks made from it (review requests, 「タスクにする」), oldest first; none from older servers.
    var tasks: [MessageTaskOut] = []
    /// M88 (MEMBERSHIP.md §1): what a `type = "system"` line says (the join / leave lines); nil otherwise and from older servers.
    var systemEvent: SystemEvent? = nil
    /// M95 (WORKFLOWS.md D4 / §8): the workflow whose form posted it; nil otherwise, from older servers, and when the field
    /// is missing or null.
    var workflow: MessageWorkflow? = nil
    /// M117 (docs/CALLS.md §5): the call it started (its card and 「参加する」); nil otherwise, once deleted, and from older servers.
    var call: MessageCall? = nil

    enum CodingKeys: String, CodingKey {
        case id, channelId, senderId, seq, updatedSeq, clientMsgId, body, createdAt, editedAt, deleted
        case type, mentionedUserIds, mentionAll, reactions, parentId, alsoInChannel, replyCount, lastReplyAt, replyUserIds, attachments, pinnedAt, pinnedBy, poll
        case priority, ackRequested, acks, collection, tasks, systemEvent, workflow, call
    }

    func mentions(_ userId: String) -> Bool { mentionAll || mentionedUserIds.contains(userId) }
    /// Addressed to me (SYNC_PROTOCOL.md §7.4): @channel, my name or group, or one of my notification keywords (M12g).
    /// The server keeps keyword hits to itself (they would show my keywords to everyone), so they are found here.
    func mentionsMe(_ me: UserMe) -> Bool { mentions(me.id) || NotifyKeywords.matches(body, me.notifyKeywords) }
    var isReply: Bool { parentId != nil }
}

/// M12g: the server's keyword rule, case-insensitive and anywhere in the body (the sender's own posts are left out
/// by the callers).
enum NotifyKeywords {
    static func matches(_ body: String, _ keywords: [String]?) -> Bool {
        guard let keywords, !keywords.isEmpty else { return false }
        let text = body.lowercased()
        return keywords.contains { !$0.isEmpty && text.contains($0.lowercased()) }
    }

    /// A text run cut where the keywords occur (case-insensitively, the longest first), each piece with whether it is
    /// one: the body highlights them, as on the web (M28d).
    static func pieces(_ text: String, _ keywords: [String]?) -> [(text: String, hit: Bool)] {
        let words = (keywords ?? []).map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
            .sorted { $0.count > $1.count }
        guard !words.isEmpty, !text.isEmpty else { return [(text, false)] }
        var pieces: [(String, Bool)] = []
        var rest = text[...]
        while !rest.isEmpty {
            var first: (Range<Substring.Index>, String)?
            for word in words {
                if let range = rest.range(of: word, options: [.caseInsensitive]), first.map({ range.lowerBound < $0.0.lowerBound }) ?? true {
                    first = (range, word)
                }
            }
            guard let (range, _) = first else {
                pieces.append((String(rest), false))
                break
            }
            if range.lowerBound > rest.startIndex { pieces.append((String(rest[..<range.lowerBound]), false)) }
            pieces.append((String(rest[range]), true))
            rest = rest[range.upperBound...]
        }
        return pieces
    }
}

/// The parent's thread fields after a reply changed them (SYNC_PROTOCOL.md §6).
struct ParentThread: Codable, Equatable {
    let id: String
    let replyCount: Int
    let lastReplyAt: String?
    let updatedSeq: Int
    var participantIds: [String] = []
    /// C3: the parent's repliers after the change; nil from an older server (the parent keeps the list it had).
    var replyUserIds: [String]? = nil

    enum CodingKeys: String, CodingKey { case id, replyCount, lastReplyAt, updatedSeq, participantIds, replyUserIds }

    init(id: String, replyCount: Int, lastReplyAt: String?, updatedSeq: Int, participantIds: [String] = [], replyUserIds: [String]? = nil) {
        self.id = id
        self.replyCount = replyCount
        self.lastReplyAt = lastReplyAt
        self.updatedSeq = updatedSeq
        self.participantIds = participantIds
        self.replyUserIds = replyUserIds
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        replyCount = try c.decode(Int.self, forKey: .replyCount)
        lastReplyAt = try c.decodeIfPresent(String.self, forKey: .lastReplyAt)
        updatedSeq = try c.decode(Int.self, forKey: .updatedSeq)
        participantIds = try c.decodeIfPresent([String].self, forKey: .participantIds) ?? []
        replyUserIds = try c.decodeIfPresent([String].self, forKey: .replyUserIds)
    }
}

extension MessageOut {
    /// The M8a fields are optional on the wire for older servers and in persisted rows.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        channelId = try c.decode(String.self, forKey: .channelId)
        senderId = try c.decode(String.self, forKey: .senderId)
        seq = try c.decode(Int.self, forKey: .seq)
        updatedSeq = try c.decode(Int.self, forKey: .updatedSeq)
        clientMsgId = try c.decodeIfPresent(String.self, forKey: .clientMsgId)
        body = try c.decode(String.self, forKey: .body)
        createdAt = try c.decode(String.self, forKey: .createdAt)
        editedAt = try c.decodeIfPresent(String.self, forKey: .editedAt)
        deleted = try c.decode(Bool.self, forKey: .deleted)
        type = try c.decodeIfPresent(String.self, forKey: .type) ?? "user"
        mentionedUserIds = try c.decodeIfPresent([String].self, forKey: .mentionedUserIds) ?? []
        mentionAll = try c.decodeIfPresent(Bool.self, forKey: .mentionAll) ?? false
        reactions = try c.decodeIfPresent([ReactionOut].self, forKey: .reactions) ?? []
        parentId = try c.decodeIfPresent(String.self, forKey: .parentId)
        alsoInChannel = try c.decodeIfPresent(Bool.self, forKey: .alsoInChannel) ?? false
        replyCount = try c.decodeIfPresent(Int.self, forKey: .replyCount) ?? 0
        lastReplyAt = try c.decodeIfPresent(String.self, forKey: .lastReplyAt)
        replyUserIds = try c.decodeIfPresent([String].self, forKey: .replyUserIds) ?? []
        attachments = try c.decodeIfPresent([AttachmentOut].self, forKey: .attachments) ?? []
        pinnedAt = try c.decodeIfPresent(String.self, forKey: .pinnedAt)
        pinnedBy = try c.decodeIfPresent(String.self, forKey: .pinnedBy)
        poll = try c.decodeIfPresent(PollOut.self, forKey: .poll)
        priority = try c.decodeIfPresent(String.self, forKey: .priority)
        ackRequested = try c.decodeIfPresent(Bool.self, forKey: .ackRequested) ?? false
        acks = try c.decodeIfPresent([AckOut].self, forKey: .acks) ?? []
        collection = try? c.decodeIfPresent(CollectionOut.self, forKey: .collection)
        tasks = MessageTaskOut.list(c, forKey: .tasks)
        systemEvent = try? c.decodeIfPresent(SystemEvent.self, forKey: .systemEvent)
        workflow = try? c.decodeIfPresent(MessageWorkflow.self, forKey: .workflow)
        call = try? c.decodeIfPresent(MessageCall.self, forKey: .call)
    }
}

/// M117 (docs/CALLS.md §5): `MessageOut.call`, the meeting room a message started; `startedBy` is its sender.
struct MessageCall: Codable, Equatable {
    let url: String
    let startedBy: String
}

/// M117 (docs/CALLS.md §4): `POST /channels/{id}/calls`, the room to open and the message that announces it.
struct CallOut: Codable {
    let url: String
    let message: MessageOut
}

/// M88 (MEMBERSHIP.md §1): a system line's event. `kind` stays a string: a kind this version does not know shows the
/// line's `body`. For member_joined / member_left `userIds` is `[actorId]`.
struct SystemEvent: Codable, Equatable {
    let kind: String
    let actorId: String
    var userIds: [String] = []

    init(kind: String, actorId: String, userIds: [String] = []) {
        self.kind = kind
        self.actorId = actorId
        self.userIds = userIds
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        kind = try c.decode(String.self, forKey: .kind)
        actorId = try c.decode(String.self, forKey: .actorId)
        userIds = try c.decodeIfPresent([String].self, forKey: .userIds) ?? []
    }

    enum CodingKeys: String, CodingKey { case kind, actorId, userIds }
}

/// M88 (MEMBERSHIP.md §3): the workspace's switches every client needs, from bootstrap and workspace.settings_updated.
/// Not persisted: an offline start uses the defaults (both on, as a server before M88 behaves) until the next bootstrap.
struct WorkspaceSettings: Codable, Equatable {
    var showMembershipMessages = true
    var previewBeforeJoin = true
    /// M93 (WORKSPACES.md §3.4): the workspace icon's version; nil = no icon (the letter tile).
    var iconVersion: String?
    /// The answer had `icon_version` (null or not); a server before M93 has none, and then the saved one stays.
    var hasIconVersion = false
    /// M117 (docs/CALLS.md §3): the 📞 shows only when true; false when missing (a server before M117) and before the
    /// first bootstrap.
    var callsEnabled = false
    /// The meeting service rooms are made on, for display only (the server makes the rooms); nil = calls off.
    var meetingBaseUrl: String?

    static let defaults = WorkspaceSettings()

    /// `iconVersion`: .none = the field is missing (a server before M93), .some(nil) = no icon.
    init(showMembershipMessages: Bool = true, previewBeforeJoin: Bool = true, iconVersion: String?? = .none,
         callsEnabled: Bool = false, meetingBaseUrl: String? = nil) {
        self.showMembershipMessages = showMembershipMessages
        self.previewBeforeJoin = previewBeforeJoin
        self.callsEnabled = callsEnabled
        self.meetingBaseUrl = meetingBaseUrl
        if case .some(let version) = iconVersion {
            self.iconVersion = version
            hasIconVersion = true
        }
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        showMembershipMessages = try c.decodeIfPresent(Bool.self, forKey: .showMembershipMessages) ?? true
        previewBeforeJoin = try c.decodeIfPresent(Bool.self, forKey: .previewBeforeJoin) ?? true
        hasIconVersion = c.contains(.iconVersion)
        iconVersion = try? c.decodeIfPresent(String.self, forKey: .iconVersion)
        callsEnabled = (try? c.decodeIfPresent(Bool.self, forKey: .callsEnabled)) ?? false
        meetingBaseUrl = try? c.decodeIfPresent(String.self, forKey: .meetingBaseUrl)
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(showMembershipMessages, forKey: .showMembershipMessages)
        try c.encode(previewBeforeJoin, forKey: .previewBeforeJoin)
        if hasIconVersion { try c.encode(iconVersion, forKey: .iconVersion) }
        try c.encode(callsEnabled, forKey: .callsEnabled)
        try c.encodeIfPresent(meetingBaseUrl, forKey: .meetingBaseUrl)
    }

    enum CodingKeys: String, CodingKey { case showMembershipMessages, previewBeforeJoin, iconVersion, callsEnabled, meetingBaseUrl }
}

/// M15e: one member's 「確認しました」.
struct AckOut: Codable, Equatable {
    let userId: String
    let ackedAt: String
}

struct HistoryOut: Codable {
    let channelLastSeq: Int
    let messages: [MessageOut]
    let hasMore: Bool
}

struct DeltaOut: Codable {
    let messages: [MessageOut]
    let nextSinceSeq: Int
    let hasMore: Bool
}

struct Limits: Codable {
    let maxMessageLength: Int
    let maxAttachmentBytes: Int
    let maxAttachmentsPerMessage: Int
}

struct BootstrapOut: Codable {
    let serverTime: String
    let me: UserMe
    let users: [UserPublic]
    let channels: [ChannelOut]
    let limits: Limits
    /// Followed threads with unread replies / mentions (THREADS.md §3); the 「スレッド」 badge.
    var threads: ThreadSummary? = nil
    /// Who is connected right now (SYNC_PROTOCOL.md §5.2 presence); users not listed are offline.
    var presence: [PresenceEntry]? = nil
    /// My saved messages (M11c): ids only, newest first; the list itself is GET /bookmarks.
    var bookmarks: [String]? = nil
    /// My starred channels (M12a) among `channels`.
    var favorites: [String]? = nil
    /// M118: the DMs and group DMs I pinned to the top, oldest pin first; nil from an older server (no pinning there).
    var dmPins: [String]? = nil
    /// M141: the DMs and group DMs I closed with no newer message since; nil from an older server (no closing there).
    var closedDms: [String]? = nil
    /// Custom emoji (M12f): the whole table; changes arrive as emoji.updated.
    var customEmoji: [CustomEmojiOut]? = nil
    /// M100: emoji packs in tab order; changes arrive as emoji_pack.updated.
    var emojiPacks: [EmojiPackOut]? = nil
    /// Post templates (M30): the workspace's, then mine; changes arrive as template.updated.
    var templates: [TemplateOut]? = nil
    /// User groups (M12k): every group with its members; changes arrive as group.updated.
    var groups: [GroupOut]? = nil
    /// The lab roster (M23) in roster order; changes arrive as roster.updated. Missing from older servers.
    var roster: [LabProfileOut]? = nil
    /// My sidebar sections (M14f); changes arrive as sidebar.updated.
    var sidebarSections: [SidebarSectionOut]? = nil
    /// The default sections' sorts (DATA_MODEL.md 「並べ替え」); nil from an older server (the defaults).
    var sidebarDefaults: [SidebarDefaultOut]? = nil
    /// My drafts shared by my devices (M15d); changes arrive as draft.updated.
    var drafts: [DraftOut]? = nil
    /// M39: the activity badge and read position; nil from a server before M39 (the activity tab stays at stage A).
    var activity: ActivitySummary? = nil
    /// M88 (MEMBERSHIP.md §3): nil from a server before M88 (both switches on).
    var workspaceSettings: WorkspaceSettings? = nil
    /// M104 (MODERATION.md §4): the people I blocked; changes arrive as block.updated. Nil from an older server.
    var blockedUserIds: [String]? = nil
    /// M122 (docs/WIKI.md §10): the wiki's change feed position (the tree is GET /wiki/tree); nil from a server without it.
    var wiki: WikiBootstrap? = nil
    /// M140 (docs/PRESENCE.md §4): the 在室状況 board; nil for guests, while it is off and from a server before M140.
    var attendance: AttendanceBoardOut? = nil
    /// M143 (docs/ACTIONS.md §7.1): the 操作ボタン I may press; nil for guests, while off and from a server before M143.
    var actions: ActionListOut? = nil
}

/// M39 (MOBILE_UI.md §6.4 / §7.2): one item of the activity, newest first. A mention of me, the reactions to one message
/// of mine (who and which emoji, one item per message), or someone's reply in a thread I follow. M77 (CANVAS.md §20):
/// a canvas that mentions me (`canvas_mention`, asked for with `include=canvas_mention`), with `canvas` and no message.
struct ActivityItem: Codable, Equatable, Identifiable {
    /// "mention" / "reaction" / "thread_reply" / "canvas_mention".
    let kind: String
    /// When it happened (a reaction item: its newest reaction); compared with the read position.
    let at: String
    /// The message (every kind but `canvas_mention`).
    let message: MessageOut?
    /// Who did it (a mention or a reply: its sender; a canvas: who saved it).
    let actorIds: [String]
    /// A reaction item's emoji (`:name:` for a custom one).
    var emojis: [String] = []
    /// A `canvas_mention` item's canvas (M77).
    var canvas: ActivityCanvas? = nil
    /// M112: a `reservation` item's notice (asked for with `include=reservation`).
    var reservation: ActivityReservation? = nil
    /// M122: a `page_mention` / `page_shared` item's page (asked for with `include=page_mention,page_shared`).
    var page: ActivityPage? = nil
    /// 2026-10-06 (MOBILE_UI.md §6.4): the server's verdict — read by the activity's read position, or (a mention or a
    /// thread reply) read in its conversation, or a done reservation to-do; since 2026-10-07 also opened since it
    /// happened. nil from a server before it.
    var read: Bool? = nil
    /// 2026-10-07 (MOBILE_UI.md §6.4): the server's id of the item (the message's for a mention, a reply or a reaction,
    /// else the canvas / page / reservation item's), which PUT /activity/items/read takes. nil from a server before it:
    /// an opened row is not sent and waits for the read position.
    var itemId: String? = nil
    /// Not sent: the list sets it when `read` says more than the read position does (read in its conversation, or
    /// opened; see ActivityRules.markingServerReads), so the dots follow it.
    var readOnServer = false

    /// One row per kind and message; a canvas item is its own (`canvas_mention:<item_id>`), a reservation notice too.
    var id: String {
        if let canvas { return "canvas_mention:\(canvas.itemId)" }
        if let reservation { return "reservation:\(reservation.itemId)" }
        if let page { return "\(kind):\(page.itemId)" }
        return "\(kind):\(message?.id ?? "")"
    }

    /// The conversation the row is in.
    var channelId: String? { canvas?.channelId ?? message?.channelId }

    enum CodingKeys: String, CodingKey { case kind, at, message, actorIds, emojis, canvas, reservation, page, read, itemId = "id" }

    init(kind: String, at: String, message: MessageOut?, actorIds: [String], emojis: [String] = [], canvas: ActivityCanvas? = nil,
         reservation: ActivityReservation? = nil, page: ActivityPage? = nil, itemId: String? = nil, read: Bool? = nil) {
        self.itemId = itemId
        self.read = read
        self.kind = kind
        self.at = at
        self.message = message
        self.actorIds = actorIds
        self.emojis = emojis
        self.canvas = canvas
        self.reservation = reservation
        self.page = page
    }

    /// A canvas item needs its canvas, every other kind its message: an item with neither (a kind of a newer server,
    /// or a malformed one) fails here, and the list leaves just that item out (ActivityListOut).
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        kind = try c.decode(String.self, forKey: .kind)
        at = try c.decode(String.self, forKey: .at)
        if kind == "canvas_mention" {
            canvas = try c.decode(ActivityCanvas.self, forKey: .canvas)
            message = nil
        } else if kind == "reservation" {
            reservation = try c.decode(ActivityReservation.self, forKey: .reservation)
            canvas = nil
            message = nil
        } else if kind == "page_mention" || kind == "page_shared" {
            page = try c.decode(ActivityPage.self, forKey: .page)
            canvas = nil
            message = nil
        } else {
            message = try c.decode(MessageOut.self, forKey: .message)
            canvas = nil
        }
        actorIds = try c.decodeIfPresent([String].self, forKey: .actorIds) ?? []
        emojis = try c.decodeIfPresent([String].self, forKey: .emojis) ?? []
        read = try c.decodeIfPresent(Bool.self, forKey: .read)
        itemId = try c.decodeIfPresent(String.self, forKey: .itemId)
    }
}

/// M77 (CANVAS.md §20.3): a `canvas_mention` item's canvas. `title` is the canvas's title now, `excerpt` one plain line
/// of the body as it was saved (the line that mentions me).
struct ActivityCanvas: Codable, Equatable {
    let itemId: String
    let canvasId: String
    let channelId: String
    var title: String = ""
    var excerpt: String = ""
    var revId: String? = nil

    init(itemId: String, canvasId: String, channelId: String, title: String = "", excerpt: String = "", revId: String? = nil) {
        self.itemId = itemId
        self.canvasId = canvasId
        self.channelId = channelId
        self.title = title
        self.excerpt = excerpt
        self.revId = revId
    }

    private enum CodingKeys: String, CodingKey { case itemId, canvasId, channelId, title, excerpt, revId }

    /// The ids are required (the row opens the canvas); the words read as empty when missing.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        itemId = try c.decode(String.self, forKey: .itemId)
        canvasId = try c.decode(String.self, forKey: .canvasId)
        channelId = try c.decode(String.self, forKey: .channelId)
        title = (try? c.decodeIfPresent(String.self, forKey: .title)) ?? ""
        excerpt = (try? c.decodeIfPresent(String.self, forKey: .excerpt)) ?? ""
        revId = try? c.decodeIfPresent(String.self, forKey: .revId)
    }
}

/// GET /activity: a page, the next page's cursor (nil at the end) and my read position. M77: the items are read one at
/// a time; one that does not decode is left out, so a bad item no longer fails the whole list.
struct ActivityListOut: Codable {
    let items: [ActivityItem]
    let nextCursor: String?
    let readAt: String

    init(items: [ActivityItem], nextCursor: String?, readAt: String) {
        self.items = items
        self.nextCursor = nextCursor
        self.readAt = readAt
    }

    private enum CodingKeys: String, CodingKey { case items, nextCursor, readAt }

    private struct Lenient: Decodable {
        let item: ActivityItem?
        init(from decoder: Decoder) throws { item = try? ActivityItem(from: decoder) }
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        items = try c.decode([Lenient].self, forKey: .items).compactMap(\.item)
        nextCursor = try c.decodeIfPresent(String.self, forKey: .nextCursor)
        readAt = try c.decode(String.self, forKey: .readAt)
    }
}

/// M39: the activity badge (bootstrap `activity`, GET /activity/summary, PUT /activity/read): the items after my read
/// position (at most 99), and whether a mention is among them.
struct ActivitySummary: Codable, Equatable {
    var readAt: String
    var unreadCount: Int
    var mentionUnread: Bool
}

/// A link pinned to the top of a conversation (M15f).
struct ChannelLinkOut: Codable, Equatable, Identifiable {
    let id: String
    let title: String
    let url: String
    let position: Int
    let createdBy: String
    let createdAt: String
}

/// A draft saved on the server (M15d): text only, one per composer.
struct DraftOut: Codable, Equatable {
    let channelId: String
    var parentId: String? = nil
    let body: String
    let updatedAt: String
}

/// draft.updated (M15d): saved or deleted (then `body` is empty) on one of my devices.
struct DraftUpdated: Codable, Equatable {
    let channelId: String
    var parentId: String? = nil
    let body: String
    let updatedAt: String
    let deleted: Bool
}

/// One of my sidebar sections (M14f); `channelIds` are the conversations placed in it. M26: `emoji` is its icon (an
/// emoji or a custom `:name:`), `collapsed` folds it up on all my devices.
struct SidebarSectionOut: Codable, Identifiable, Equatable {
    let id: String
    let name: String
    let position: Int
    var channelIds: [String] = []
    var emoji: String? = nil
    var collapsed = false
    /// DATA_MODEL.md 「並べ替え」: "name" / "recent" / "manual", and the hand-made order (conversation ids).
    var sort = "name"
    var manualOrder: [String] = []
}

/// The sort of a default section ("favorites", "channels", "dms"); the server always sends all three.
struct SidebarDefaultOut: Codable, Equatable {
    let key: String
    var sort: String
    var manualOrder: [String] = []
}

extension SidebarDefaultOut {
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        key = try c.decode(String.self, forKey: .key)
        sort = try c.decode(String.self, forKey: .sort)
        manualOrder = try c.decodeIfPresent([String].self, forKey: .manualOrder) ?? []
    }
}

extension SidebarSectionOut {
    /// The M26 fields are missing from a server before M26 and from rows saved by an older app.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = try c.decode(String.self, forKey: .name)
        position = try c.decode(Int.self, forKey: .position)
        channelIds = try c.decodeIfPresent([String].self, forKey: .channelIds) ?? []
        emoji = try c.decodeIfPresent(String.self, forKey: .emoji)
        collapsed = try c.decodeIfPresent(Bool.self, forKey: .collapsed) ?? false
        sort = try c.decodeIfPresent(String.self, forKey: .sort) ?? "name"
        manualOrder = try c.decodeIfPresent([String].self, forKey: .manualOrder) ?? []
    }
}

/// A named set of members that `@name` notifies (M12k).
struct GroupOut: Codable, Identifiable, Equatable {
    let id: String
    let name: String
    var description: String? = nil
    var memberIds: [String] = []
    let createdBy: String
    let createdAt: String
    let updatedAt: String
    /// M23: kept from the lab roster by the server (faculty, students, m1 …); administrators cannot edit it by hand.
    var managed: Bool = false

    enum CodingKeys: String, CodingKey { case id, name, description, memberIds, createdBy, createdAt, updatedAt, managed }
}

extension GroupOut {
    /// `managed` (M23) is missing from older servers; a synthesized decoder would reject the whole bootstrap for it.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = try c.decode(String.self, forKey: .name)
        description = try c.decodeIfPresent(String.self, forKey: .description)
        memberIds = try c.decodeIfPresent([String].self, forKey: .memberIds) ?? []
        createdBy = try c.decode(String.self, forKey: .createdBy)
        createdAt = try c.decode(String.self, forKey: .createdAt)
        updatedAt = try c.decode(String.self, forKey: .updatedAt)
        managed = try c.decodeIfPresent(Bool.self, forKey: .managed) ?? false
    }
}

/// One line of the lab roster (M23, DATA_MODEL.md lab_profiles): for display and grouping only, never for permissions.
/// `affiliation` (faculty | student | alumni | other), `rank` (faculty only) and `grade` (students only) stay strings so
/// a value a newer server adds still decodes; Roster sorts it after the known ones.
struct LabProfileOut: Codable, Equatable {
    let userId: String
    let affiliation: String
    var rank: String? = nil
    var grade: String? = nil
    /// The supervising teacher (someone on the roster as faculty).
    var supervisorId: String? = nil
    /// 研究テーマ and よみ: the person edits these on their own line (PATCH /lab/roster/me).
    var researchTopic: String? = nil
    var reading: String? = nil
    let updatedAt: String
}

/// A workspace emoji (M12f) used as `:name:` in text and reactions.
struct CustomEmojiOut: Codable, Identifiable, Equatable, Hashable {
    let id: String
    let name: String
    let contentType: String
    let width: Int
    let height: Int
    let createdBy: String
    let createdAt: String
    /// M100 (docs/EMOJI.md): "image" (older servers: none) or "text" (`label` drawn as a pill in `color`, no image).
    var kind: String? = nil
    /// The display name (the picker's name, 「おじぎ」); the text of a text emoji.
    var label: String? = nil
    var color: String? = nil
    /// Search terms for the picker and `:` completion (Japanese included).
    var keywords: [String]? = nil
    /// The pack (its own picker tab); nil = 「カスタム」.
    var packId: String? = nil
    var position: Int? = nil

    var isText: Bool { kind == "text" }
}

/// M100: a set of custom emoji with its own picker tab; its tab icon at GET /emoji/packs/{id}/tab when `tabVersion` is set.
struct EmojiPackOut: Codable, Identifiable, Equatable, Hashable {
    let id: String
    let name: String
    let position: Int
    var tabVersion: String? = nil
    let createdAt: String
    let updatedAt: String
}

/// A post template (M30, DATA_MODEL.md message_templates): the workspace's (scope "workspace") or my own ("user").
struct TemplateOut: Codable, Identifiable, Equatable, Hashable {
    let id: String
    let scope: String
    var ownerId: String? = nil
    let name: String
    let body: String
    let suggestIn: String
    let position: Int
    let createdAt: String
    let updatedAt: String
}

/// PUT / DELETE /users/{id}/block (M104, MODERATION.md §4).
struct BlockStateOut: Codable, Equatable {
    let userId: String
    let blocked: Bool
}

/// POST /messages/{id}/report (M104, MODERATION.md §3): my own report only.
struct ReportAck: Codable, Equatable {
    let id: String
    let messageId: String
    let reason: String
    let createdAt: String
}

/// POST /reports (M119, MODERATION.md §3.1): my own report (of a person, or general) only.
struct GeneralReportAck: Codable, Equatable {
    let id: String
    let category: String
    let userId: String?
    let createdAt: String
}

/// PUT / DELETE /channels/{id}/favorite (M12a).
struct FavoriteStateOut: Codable, Equatable {
    let channelId: String
    let favorite: Bool
}

/// M118 (DATA_MODEL.md conversation_pins): `PUT` / `DELETE /channels/{id}/dm-pin`.
struct DmPinStateOut: Codable, Equatable {
    let channelId: String
    let pinned: Bool
}

/// M141 (DATA_MODEL.md conversation_closes): `PUT` / `DELETE /channels/{id}/close`.
struct DmCloseStateOut: Codable, Equatable {
    let channelId: String
    let closed: Bool
    var closedAt: String? = nil
}

/// One row of POST /channels/read-all (M12a).
struct ChannelReadStateOut: Codable, Equatable {
    let channelId: String
    let lastReadSeq: Int
    let unreadCount: Int
    let mentionCount: Int
    var firstUnreadAt: String? = nil
}

struct BookmarkStateOut: Codable, Equatable {
    let messageId: String
    let bookmarked: Bool
}

struct BookmarkItem: Codable, Equatable {
    let message: MessageOut
    let createdAt: String
}

struct BookmarkListOut: Codable {
    let items: [BookmarkItem]
    let nextCursor: String?
}

/// GET /files (M11i): one attached file and where it was posted.
struct FileItem: Codable, Identifiable {
    let attachment: AttachmentOut
    let messageId: String
    let channelId: String
    let parentId: String?
    let uploaderId: String
    let attachedAt: String

    var id: String { attachment.id }
}

struct FileListOut: Codable {
    let items: [FileItem]
    let nextCursor: String?
}

/// A personal reminder about a message (M12e); `status` is pending | fired | done | cancelled.
struct ReminderOut: Codable, Identifiable, Equatable {
    let id: String
    let messageId: String
    let channelId: String
    let note: String?
    let preview: String
    let remindAt: String
    let status: String
    let firedAt: String?
    let createdAt: String
    /// L4 (M31): "ack" when a message's author asked me to acknowledge it; L6 (M59): "collect", a nudge after a recurring
    /// post's due time to a target who has not replied; "personal" (or missing) otherwise.
    var kind: String? = nil
}

/// A message the server posts later (M12d); `status` is pending | sent | failed | cancelled.
struct ScheduledOut: Codable, Identifiable, Equatable {
    let id: String
    let channelId: String
    let parentId: String?
    let clientMsgId: String
    let body: String
    let attachments: [AttachmentOut]
    let sendAt: String
    let status: String
    let error: String?
    let sentMessageId: String?
    let createdAt: String
}

/// GET /mentions (M11h): messages that mention me or everyone, newest first.
struct MentionListOut: Codable {
    let items: [MessageOut]
    let nextCursor: String?
}

struct PresenceEntry: Codable, Equatable {
    let userId: String
    let status: String
}

/// My relation to one thread (THREADS.md §3).
struct ThreadState: Codable, Equatable {
    let parentId: String
    let channelId: String
    var following: Bool
    var lastReadSeq: Int
    var unreadCount: Int
    var mentionCount: Int
    var replyCount: Int
    var lastReplyAt: String?
    /// Current followers: who gets thread.updated and the reply's push.
    var participantIds: [String]
}

struct ThreadItem: Codable, Equatable {
    let parent: MessageOut
    let state: ThreadState
    /// The newest live replies, oldest first (THREADS.md §5); nil from a server before the previews.
    var latestReplies: [MessageOut]? = nil
}

struct ThreadSummary: Codable, Equatable {
    var unreadCount: Int
    var mentionCount: Int
}

/// One thread a POST /threads/read-all moved (THREADS.md §3.2): its position and counts after the move.
struct ThreadReadStateOut: Codable, Equatable {
    let parentId: String
    let channelId: String
    let lastReadSeq: Int
    let unreadCount: Int
    let mentionCount: Int
}

/// POST /threads/read-all's answer and the threads.read_all event's data (THREADS.md §3.2, §4): `threads` lists only
/// the threads whose position moved; `summary` is the badge after it.
struct ThreadsReadAllOut: Codable, Equatable {
    let summary: ThreadSummary
    let threads: [ThreadReadStateOut]
}

struct ThreadListOut: Codable {
    let items: [ThreadItem]
    /// Pass back as `cursor` for the next page; nil when the page was empty.
    let nextCursor: String?
    let summary: ThreadSummary
}

struct MemberOut: Codable, Equatable {
    let userId: String
    let role: String
    let joinedAt: String
}

/// What an invite link offers before any account exists (M12h).
struct InvitePreviewOut: Codable, Equatable {
    let invitedBy: String
    let role: String
    let channels: [String]
    let expiresAt: String
    var passwordMinLength: Int = 8
    /// L7: the roster line (and times) the new account gets; nil without a preset or from an older server.
    var lab: InviteLabPreview? = nil
}

/// L7: what an invite's lab preset gives, for the acceptance screen.
struct InviteLabPreview: Codable, Equatable {
    let affiliation: String
    var rank: String? = nil
    var grade: String? = nil
    var supervisorName: String? = nil
    var times = false
}

/// Two-factor authentication (M12i).
struct TotpStatusOut: Codable, Equatable {
    let enabled: Bool
    var enabledAt: String? = nil
    var recoveryCodesLeft: Int = 0
}

struct TotpSetupOut: Codable, Equatable {
    let secret: String
    let otpauthUri: String
    let qrPngBase64: String
}

struct TotpEnabledOut: Codable, Equatable {
    let recoveryCodes: [String]
}

struct DeviceInfo: Encodable {
    let platform: String
    let deviceName: String?
    let appVersion: String?
}

struct ErrorEnvelope: Decodable {
    struct Inner: Decodable {
        let code: String
        let message: String
    }
    let error: Inner
}

struct SearchHit: Codable, Identifiable {
    let message: MessageOut
    let score: Double

    var id: String { message.id }
}

/// What the server understood from the query's modifiers (from: in: before: after: on:).
struct SearchFilters: Codable, Equatable {
    let text: String
    let fromUsername: String?
    let inChannel: String?
    let after: String?
    let before: String?
    /// Typed modifiers that named nothing the caller can see; the server then returns no hits.
    var unresolved: [String]? = nil
    /// M15h: the has: flags (file, link, pin, reaction, poll) and is:thread the server understood.
    var has: [String]? = nil
    var isThread: Bool? = nil
    /// L8 (M61): is:times (or the is_times parameter) was understood; nil from older servers.
    var isTimes: Bool? = nil
}

struct SearchOut: Codable {
    let hits: [SearchHit]
    let keywords: [String]
    var filters: SearchFilters? = nil
    let limit: Int
    let offset: Int
    let hasMore: Bool
    /// M16b: how many messages match; the server stops counting at 1,000 (`totalCapped`).
    var total: Int? = nil
    var totalCapped: Bool? = nil
    /// L8 (M61): the hits' channels I am not a member of (public times reached with is:times; an archived one is in
    /// no bootstrap), to name the hits and open their preview. nil from older servers.
    var channels: [ChannelOut]? = nil
}

/// GET /times/feed (L8, TIMES_FEED.md §3): the timeline posts of the times I follow, newest first; `nextCursor` is
/// opaque (null at the end).
struct TimesFeedOut: Codable, Equatable {
    let items: [MessageOut]
    let nextCursor: String?
}

/// GET /server (M16c): what the address serves; `product` is "chikuwachat" for a ChikuwaChat server.
struct ServerInfoOut: Codable, Equatable {
    var product: String? = nil
    let workspaceId: String
    let name: String
    var apiVersion: String? = nil
    /// M93 (WORKSPACES.md §3.4): the workspace icon's version (GET /server/icon?v=…); nil = none.
    var iconVersion: String? = nil
    /// The answer had `icon_version` (null or not); a server before M93 has none, and then the saved one stays.
    var hasIconVersion = false

    /// `iconVersion`: .none = the field is missing (a server before M93), .some(nil) = no icon.
    init(product: String? = nil, workspaceId: String, name: String, apiVersion: String? = nil, iconVersion: String?? = .none) {
        self.product = product
        self.workspaceId = workspaceId
        self.name = name
        self.apiVersion = apiVersion
        if case .some(let version) = iconVersion {
            self.iconVersion = version
            hasIconVersion = true
        }
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        product = try c.decodeIfPresent(String.self, forKey: .product)
        workspaceId = try c.decode(String.self, forKey: .workspaceId)
        name = try c.decode(String.self, forKey: .name)
        apiVersion = try c.decodeIfPresent(String.self, forKey: .apiVersion)
        hasIconVersion = c.contains(.iconVersion)
        iconVersion = try? c.decodeIfPresent(String.self, forKey: .iconVersion)
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encodeIfPresent(product, forKey: .product)
        try c.encode(workspaceId, forKey: .workspaceId)
        try c.encode(name, forKey: .name)
        try c.encodeIfPresent(apiVersion, forKey: .apiVersion)
        if hasIconVersion { try c.encode(iconVersion, forKey: .iconVersion) }
    }

    enum CodingKeys: String, CodingKey { case product, workspaceId, name, apiVersion, iconVersion }
}

/// GET /sync/summary (M16c): the badge and unread flag of a workspace that is not open.
struct UnreadSummaryOut: Codable, Equatable {
    let badge: Int
    let hasUnread: Bool
}

/// Open Graph data for a link (M11g); `status == "failed"` means the page gave nothing usable.
struct LinkPreviewOut: Codable, Equatable {
    let url: String
    let status: String
    let title: String?
    let description: String?
    let imageUrl: String?
    let siteName: String?
    let fetchedAt: String
}
