import Foundation
import Intents
import UserNotifications

// PUSH_NOTIFICATIONS.md §16: a message push becomes a communication notification (the sender's picture as the main
// image, the app icon small in its corner), like Messages, Slack or LINE. The Notification Service Extension
// (NotificationService/) does it; this file is compiled into both the extension and the app (so the tests reach it).
// Anything that fails or runs late leaves the notification as the server wrote it.

/// What a message push says about its sender and conversation (APNs keeps these outside `aps`).
struct CommunicationPush: Equatable, Sendable {
    let senderId: String
    let senderName: String
    /// The channel: one conversation per channel / DM, so iOS groups and ranks them like a chat app's.
    let conversationId: String
    /// A channel or a group DM (a group conversation named `groupName`); a 1:1 DM is the sender's own conversation.
    let isGroup: Bool
    let groupName: String?
    /// The signed, short-lived picture URL (no credentials needed); nil without a picture or with previews off.
    let avatarURL: URL?

    /// Nil for anything but a message push from a person (the notification then stays as it is).
    init?(userInfo: [AnyHashable: Any], title: String) {
        func text(_ key: String) -> String? {
            guard let value = userInfo[key] as? String else { return nil }
            let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
            return trimmed.isEmpty ? nil : trimmed
        }
        guard (text("kind") ?? "message") == "message", let senderId = text("sender_id"),
              let channelId = text("channel_id") else { return nil }
        self.senderId = senderId
        let type = text("channel_type") ?? "dm"
        isGroup = type != "dm"
        let heading = title.trimmingCharacters(in: .whitespacesAndNewlines)
        senderName = text("sender_name") ?? (isGroup || heading.isEmpty ? "?" : heading)
        conversationId = channelId
        groupName = isGroup ? (heading.isEmpty ? nil : heading) : nil
        avatarURL = text("sender_avatar_url").flatMap(URL.init(string:)).flatMap { url in
            ["https", "http"].contains(url.scheme?.lowercased() ?? "") && url.host != nil ? url : nil
        }
    }

    var sender: INPerson { person(image: nil) }

    func person(image: INImage?) -> INPerson {
        INPerson(personHandle: INPersonHandle(value: senderId, type: .unknown), nameComponents: nil, displayName: senderName,
                 image: image, contactIdentifier: nil, customIdentifier: senderId)
    }

    /// The incoming message as Siri / the notification system understand it. A group needs two or more recipients
    /// (me and the rest of the channel) for iOS to show it as a group named after the channel.
    func intent(image: INImage?, body: String) -> INSendMessageIntent {
        var recipients: [INPerson]?
        if isGroup {
            let me = INPerson(personHandle: INPersonHandle(value: "me", type: .unknown), nameComponents: nil, displayName: nil,
                              image: nil, contactIdentifier: nil, customIdentifier: "me", isMe: true, suggestionType: .none)
            let others = INPerson(personHandle: INPersonHandle(value: "channel:\(conversationId)", type: .unknown),
                                  nameComponents: nil, displayName: groupName, image: nil, contactIdentifier: nil,
                                  customIdentifier: "channel:\(conversationId)")
            recipients = [me, others]
        }
        return INSendMessageIntent(recipients: recipients, outgoingMessageType: .outgoingMessageText, content: body,
                                   speakableGroupName: groupName.map { INSpeakableString(spokenPhrase: $0) },
                                   conversationIdentifier: conversationId, serviceName: nil, sender: person(image: image),
                                   attachments: nil)
    }
}

enum CommunicationNotification {
    /// The picture may take this long; the extension has about 30 seconds in all.
    static let avatarTimeout: TimeInterval = 5
    /// The server sends 256px PNGs (tens of kilobytes); anything far larger is not a picture of ours.
    static let maxAvatarBytes = 1_000_000

    /// The notification with the sender's picture (their initials when they have none or it does not load) as a
    /// communication notification; `content` itself
    /// when the push is not a person's message or iOS refuses (no entitlement, an older system…).
    static func update(_ content: UNNotificationContent,
                       load: @Sendable (URL) async -> Data? = fetchAvatar) async -> UNNotificationContent {
        guard let push = CommunicationPush(userInfo: content.userInfo, title: content.title) else { return content }
        let image = INImage(imageData: await senderPicture(push, load: load))
        let intent = push.intent(image: image, body: content.body)
        let interaction = INInteraction(intent: intent, response: nil)
        interaction.direction = .incoming
        try? await interaction.donate()
        do {
            return try content.updating(from: intent)
        } catch {
            return content
        }
    }

    /// The sender's picture when the push has its URL and it loads, else their default avatar (initials on their
    /// colour, as in the app: InitialsAvatar), so the notification never shows only the app icon (§16.1).
    static func senderPicture(_ push: CommunicationPush, load: @Sendable (URL) async -> Data?) async -> Data {
        if let url = push.avatarURL, let data = await load(url) { return data }
        return InitialsAvatar.png(id: push.senderId, name: push.senderName)
    }

    /// The picture's bytes, or nil (any error, a non-image answer, too large or too slow).
    @Sendable static func fetchAvatar(_ url: URL) async -> Data? {
        var request = URLRequest(url: url, cachePolicy: .useProtocolCachePolicy, timeoutInterval: avatarTimeout)
        request.setValue("image/png", forHTTPHeaderField: "Accept")
        guard let (data, response) = try? await URLSession.shared.data(for: request),
              let http = response as? HTTPURLResponse, http.statusCode == 200,
              (http.mimeType ?? "").hasPrefix("image/"), !data.isEmpty, data.count <= maxAvatarBytes else { return nil }
        return data
    }
}
