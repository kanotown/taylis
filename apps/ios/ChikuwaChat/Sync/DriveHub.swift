import Foundation

/// M166 (docs/DRIVE.md §14, §26): the drive on the phone. Nothing of it is kept on the device (§14): the open folder is
/// read from the API, and the events only say "read again". The hub holds whether the server has the drive at all (the
/// home tile and the channel tab show only then), the list of drives, a signal per folder bumped by `drive.changed`
/// (seq-ordered per drive, an older one dropped), one bumped on every reconnect (events may have been missed), and the
/// `/d/<id>` cards' answers for a minute.
@MainActor
@Observable
final class DriveHub {
    /// What a `/d/<id>` link shows: the item now, 「表示できないファイル」 (404: no access, in the trash or gone — the
    /// server does not say which), or that it could not be read (tap to try again).
    enum LinkState: Equatable {
        case item(DriveItemDetailOut)
        case unreadable
        case failed
    }

    /// How long a card's answer is used before it is asked again (the desktop's `controller.driveLink`).
    static let linkTTL: TimeInterval = 60

    /// The server answered GET /drive/locations (a server before M160 answers 404: no drive anywhere on the phone).
    private(set) var available = false
    private(set) var locations: [DriveLocationOut]?
    private(set) var locationsFailure: String?
    /// Bumped per folder named by a `drive.changed`: an open folder whose signal moved reads again.
    private(set) var folderSignals: [String: Int] = [:]
    /// Bumped on every bootstrap after the first (a reconnect): open folders read again.
    private(set) var reconnects = 0
    private(set) var links: [String: LinkState] = [:]

    @ObservationIgnored private let api: DriveApi?
    @ObservationIgnored private var lastSeq: [String: Int] = [:]
    @ObservationIgnored private var linkTimes: [String: Date] = [:]
    @ObservationIgnored private var resolving: [String: Task<LinkState, Never>] = [:]
    @ObservationIgnored private var bootstraps = 0
    @ObservationIgnored var now: () -> Date = Date.init

    init(api: DriveApi?) {
        self.api = api
    }

    // MARK: the drives

    /// After every bootstrap: whether the server has the drive, and the drives again.
    func bootstrap() async {
        bootstraps += 1
        if bootstraps > 1 {
            reconnects += 1
            // A card may be stale after a gap (renamed, trashed, my access changed): ask again when shown.
            linkTimes.removeAll()
        }
        await loadLocations()
    }

    func loadLocations() async {
        guard let api else { return }
        do {
            locations = try await api.driveLocations()
            available = true
            locationsFailure = nil
        } catch let error as ApiError {
            if case .api(let status, _, _) = error, status == 404 || status == 405 {
                available = false  // an older server: no drive
                locations = nil
            } else {
                locationsFailure = ErrorMessages.text(for: error)
            }
        } catch {
            locationsFailure = ErrorMessages.text(for: error)
        }
    }

    func location(_ id: String) -> DriveLocationOut? { locations?.first { $0.id == id } }

    /// マイドライブ or a channel's drive, made on first use; the list learns it.
    func resolve(channelId: String?) async throws -> DriveLocationOut {
        guard let api else { throw ApiError.network(URLError(.notConnectedToInternet)) }
        let location = try await api.resolveDrive(channelId: channelId)
        if var list = locations {
            if let index = list.firstIndex(where: { $0.id == location.id }) { list[index] = location } else { list.append(location) }
            locations = list
        }
        return location
    }

    func signal(_ folderId: String) -> Int { folderSignals[folderId] ?? 0 }

    // MARK: events (§14)

    func applyEvent(_ event: String, _ data: JSONValue) {
        switch event {
        case "drive.changed":
            guard let locationId = data["location_id"]?.stringValue else { return }
            let seq = data["seq"].flatMap { if case .number(let n) = $0 { Int(n) } else { nil } }
            if let seq {
                // A duplicate or an older event (they may come twice or out of order) changes nothing.
                if let last = lastSeq[locationId], seq <= last { return }
                lastSeq[locationId] = seq
            }
            var folders: [String] = []
            if case .array(let ids)? = data["folder_ids"] { folders = ids.compactMap(\.stringValue) }
            for id in folders { folderSignals[id, default: 0] += 1 }
            // A card of an item in a changed folder (or the folder itself) asks again when next shown.
            let touched = Set(folders)
            for (id, state) in links {
                if case .item(let detail) = state, touched.contains(detail.item.parentId ?? "") || touched.contains(id) { linkTimes[id] = nil }
            }
        case "drive.location.updated":
            Task { await loadLocations() }
        default:
            break
        }
    }

    // MARK: `/d/<id>` cards (§13.1, D6 §25)

    /// The answer held for the card (also an expired one, shown while asked again).
    func linkState(_ id: String) -> LinkState? { links[id] }

    /// The item behind a link: the held answer within `linkTTL`, else GET /drive/items/{id} once (concurrent cards share
    /// the request). 404 is 「表示できないファイル」, an item in the trash too (its name never shows).
    @discardableResult
    func resolveLink(_ id: String, force: Bool = false) async -> LinkState {
        if !force, let state = links[id], let at = linkTimes[id], now().timeIntervalSince(at) < Self.linkTTL { return state }
        if let running = resolving[id] { return await running.value }
        guard let api else { return .failed }
        let task = Task { () -> LinkState in
            do {
                let detail = try await api.driveItem(id)
                return detail.item.trashedAt == nil ? .item(detail) : .unreadable
            } catch let error as ApiError {
                if case .api(let status, _, _) = error, status == 404 { return .unreadable }
                return .failed
            } catch {
                return .failed
            }
        }
        resolving[id] = task
        let state = await task.value
        resolving[id] = nil
        // A failure keeps an earlier answer on screen (the card says so only without one).
        if state != .failed || links[id] == nil { links[id] = state }
        linkTimes[id] = state == .failed ? nil : now()
        return state
    }
}
