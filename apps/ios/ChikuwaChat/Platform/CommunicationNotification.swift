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
    /// The workspace that sent it (`workspace_id`; nil from a server without one).
    let workspaceId: String?
    /// The channel within its workspace (`<workspace_id>:<channel_id>`, WORKSPACES.md §7): one conversation per channel /
    /// DM, so iOS groups and ranks them like a chat app's. Also the notification's thread.
    let conversationId: String
    /// A channel or a group DM (a group conversation named `groupName`); a 1:1 DM is the sender's own conversation.
    let isGroup: Bool
    let groupName: String?
    /// The signed, short-lived picture URL (no credentials needed); nil without a picture or with previews off. Fetched
    /// only from its workspace's own address (`CommunicationNotification.avatarURL(of:in:)`).
    var avatarURL: URL?

    /// An id of a workspace's channel or person as the system keeps it (2026-11-16): prefixed with the workspace, so
    /// another server's channel or person with the same id is not grouped with it (or cleared with it).
    static func scoped(_ id: String, workspaceId: String?) -> String {
        workspaceId.map { "\($0):\(id)" } ?? id
    }

    /// The sender as the system keeps them (the person's id within the workspace).
    var senderKey: String { Self.scoped(senderId, workspaceId: workspaceId) }

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
        workspaceId = text("workspace_id")
        conversationId = Self.scoped(channelId, workspaceId: workspaceId)
        groupName = isGroup ? (heading.isEmpty ? nil : heading) : nil
        avatarURL = text("sender_avatar_url").flatMap(URL.init(string:)).flatMap { url in
            ["https", "http"].contains(url.scheme?.lowercased() ?? "") && url.host != nil ? url : nil
        }
    }

    var sender: INPerson { person(image: nil) }

    func person(image: INImage?) -> INPerson {
        INPerson(personHandle: INPersonHandle(value: senderKey, type: .unknown), nameComponents: nil, displayName: senderName,
                 image: image, contactIdentifier: nil, customIdentifier: senderKey)
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
    /// `workspaces`: the list the app keeps in the App Group (nil: read it there).
    static func update(_ content: UNNotificationContent, workspaces: [SavedWorkspace]? = nil,
                       load: @Sendable (URL) async -> Data? = fetchAvatar) async -> UNNotificationContent {
        guard var push = CommunicationPush(userInfo: content.userInfo, title: content.title) else { return content }
        push.avatarURL = avatarURL(of: push, in: workspaces ?? savedWorkspaces())
        let image = INImage(imageData: await senderPicture(push, load: load))
        let intent = push.intent(image: image, body: content.body)
        let interaction = INInteraction(intent: intent, response: nil)
        interaction.direction = .incoming
        try? await interaction.donate()
        // The thread within the workspace (WORKSPACES.md §7): the server's thread-id is the bare channel id.
        var updatable = content
        if push.workspaceId != nil, let scoped = content.mutableCopy() as? UNMutableNotificationContent {
            scoped.threadIdentifier = push.conversationId
            updatable = scoped
        }
        do {
            return try updatable.updating(from: intent)
        } catch {
            return updatable
        }
    }

    /// The sender's picture when the push has its URL and it loads, else their default avatar (initials on their
    /// colour, as in the app: InitialsAvatar), so the notification never shows only the app icon (§16.1).
    static func senderPicture(_ push: CommunicationPush, load: @Sendable (URL) async -> Data?) async -> Data {
        if let url = push.avatarURL, let data = await load(url) { return data }
        return InitialsAvatar.png(id: push.senderId, name: push.senderName)
    }

    // MARK: whose picture may be fetched (2026-11-16, a hostile-server review)

    /// A workspace as the app keeps it in the App Group (SharedContainer `share.workspaces`, the app's Workspace JSON):
    /// only what the extension needs.
    struct SavedWorkspace: Decodable, Equatable {
        let serverUrl: String
        var workspaceId: String?
    }

    /// The workspaces the app saved for its extensions; none when the App Group cannot be read.
    static func savedWorkspaces() -> [SavedWorkspace] {
        let group = (Bundle.main.object(forInfoDictionaryKey: "TaylisAppGroup") as? String) ?? "group.jp.chikuwachat.ios"
        guard let data = UserDefaults(suiteName: group)?.data(forKey: "share.workspaces") else { return [] }
        return (try? JSONDecoder().decode([SavedWorkspace].self, from: data)) ?? []
    }

    /// The push's picture URL when it may be fetched: exactly one saved workspace has the push's workspace_id, and the URL
    /// is on that workspace's own address (scheme, host and port) under its `/api/v1/users/` path, with no user or
    /// password. Anything else (no or an ambiguous id, another host, another path) shows the initials instead: the URL
    /// is the server's, and the extension fetched whatever it named (any host, any size).
    static func avatarURL(of push: CommunicationPush, in workspaces: [SavedWorkspace]) -> URL? {
        guard let url = push.avatarURL, let id = push.workspaceId else { return nil }
        let matches = workspaces.filter { $0.workspaceId == id }
        guard matches.count == 1, let base = URLComponents(string: matches[0].serverUrl),
              let own = URLComponents(url: url, resolvingAgainstBaseURL: false),
              own.user == nil, own.password == nil, origin(own) != nil, origin(own) == origin(base) else { return nil }
        let prefix = base.percentEncodedPath.replacingOccurrences(of: "/+$", with: "", options: .regularExpression) + "/api/v1/users/"
        let path = own.percentEncodedPath
        // No segment that climbs out (`..`, or one spelled with escapes) on the way.
        let climbs = path.split(separator: "/", omittingEmptySubsequences: false).contains { segment in
            let lower = segment.lowercased()
            return lower == "." || lower == ".." || lower.contains("%2e") || lower.contains("%2f") || lower.contains("%5c") || lower.contains("\\")
        }
        guard !climbs, path.hasPrefix(prefix), path.count > prefix.count else { return nil }
        return url
    }

    /// "https://host:port" lower-cased, the default port left out; nil without an http(s) scheme or a host.
    private static func origin(_ components: URLComponents) -> String? {
        guard let scheme = components.scheme?.lowercased(), scheme == "https" || scheme == "http",
              let host = components.host?.lowercased(), !host.isEmpty else { return nil }
        let port = components.port.flatMap { (scheme == "https" && $0 == 443) || (scheme == "http" && $0 == 80) ? nil : $0 }
        return "\(scheme)://\(host)" + (port.map { ":\($0)" } ?? "")
    }

    /// The picture's bytes, or nil (any error, a redirect, a non-image answer, too large or too slow). Read as they
    /// come and given up past `maxAvatarBytes` or `avatarTimeout` (it read the whole answer first, however large).
    @Sendable static func fetchAvatar(_ url: URL) async -> Data? {
        var request = URLRequest(url: url, cachePolicy: .useProtocolCachePolicy, timeoutInterval: avatarTimeout)
        request.setValue("image/png", forHTTPHeaderField: "Accept")
        guard let (bytes, response) = try? await URLSession.shared.bytes(for: request, delegate: NoRedirects()),
              let http = response as? HTTPURLResponse, http.statusCode == 200, (http.mimeType ?? "").hasPrefix("image/"),
              http.expectedContentLength <= Int64(maxAvatarBytes) else { return nil }
        guard let data = try? await collect(bytes, limit: maxAvatarBytes, deadline: Date().addingTimeInterval(avatarTimeout)),
              !data.isEmpty else { return nil }
        return data
    }

    /// The bytes of `sequence`, or nil once there are more than `limit` of them or `deadline` passed.
    static func collect<S: AsyncSequence>(_ sequence: S, limit: Int, deadline: Date = .distantFuture) async throws -> Data? where S.Element == UInt8 {
        var data = Data()
        for try await byte in sequence {
            guard data.count < limit, Date() < deadline else { return nil }
            data.append(byte)
        }
        return data
    }

    /// The picture is fetched from the URL the push names, never from where it redirects.
    private final class NoRedirects: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
        func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                        newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
            completionHandler(nil)
        }
    }
}
