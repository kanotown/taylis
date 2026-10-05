import Foundation

/// M15f: a conversation's link bar (ApiClient and the test fake).
@MainActor
protocol ChannelLinksApi: AnyObject {
    func channelLinks(channelId: String) async throws -> [ChannelLinkOut]
}

/// M112: the workspace's reservation pools (ApiClient and the test fake).
@MainActor
protocol ReservationsApi: AnyObject {
    func reservationPools() async throws -> [PoolOut]
}

/// M15d: the draft endpoints (ApiClient and the test fake).
@MainActor
protocol DraftApi: AnyObject {
    func saveDraft(channelId: String, parentId: String?, body: String) async throws -> DraftOut
    func deleteDraft(channelId: String, parentId: String?) async throws
}

/// M15d: keeps my drafts in step across my devices (SYNC_PROTOCOL.md §8 「下書きの同期」).
/// Local edits are saved a moment after typing pauses; while a draft has unsaved edits (dirty),
/// versions from other devices are ignored so that nothing typed here is lost.
@MainActor
final class DraftSync {
    private let api: DraftApi?
    private let store: Store
    private let isOnline: () -> Bool
    private let delay: TimeInterval
    private var timers: [String: Task<Void, Never>] = [:]
    private var running: Task<Void, Never>?

    init(api: DraftApi?, store: Store, isOnline: @escaping () -> Bool, delay: TimeInterval) {
        self.api = api
        self.store = store
        self.isOnline = isOnline
        self.delay = delay
    }

    private static func key(_ channelId: String, _ parentId: String?) -> String { "\(channelId):\(parentId ?? "")" }

    /// A local edit: save it once typing pauses (an emptied composer, e.g. after sending, right away).
    func edited(_ channelId: String, parentId: String?) {
        guard api != nil else { return }
        let key = Self.key(channelId, parentId)
        timers[key]?.cancel()
        let wait = store.draft(channelId, parentId: parentId).text.isEmpty ? 0 : delay
        timers[key] = Task { [weak self] in
            if wait > 0 { try? await Task.sleep(nanoseconds: UInt64(wait * 1_000_000_000)) }
            guard !Task.isCancelled, let self else { return }
            self.timers[key] = nil
            await self.push(channelId, parentId: parentId)
        }
    }

    /// Bootstrap: take the server's drafts, forget the ones sent or deleted elsewhere.
    func applyBootstrap(_ drafts: [DraftOut]) {
        for entry in store.draftEntries() where !entry.draft.isDirty && entry.draft.syncedAt == nil
            && !entry.draft.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && store.channel(entry.channelId)?.isMember == true {
            store.markDraftDirty(entry.channelId, parentId: entry.parentId) // written before drafts synced: this device's text wins
        }
        var onServer = Set<String>()
        for draft in drafts {
            onServer.insert(Self.key(draft.channelId, draft.parentId))
            store.applyRemoteDraft(draft.channelId, parentId: draft.parentId, body: draft.body, updatedAt: draft.updatedAt)
        }
        for entry in store.draftEntries() where !entry.draft.isDirty && entry.draft.syncedAt != nil
            && !onServer.contains(Self.key(entry.channelId, entry.parentId)) {
            store.applyRemoteDraft(entry.channelId, parentId: entry.parentId, body: nil, updatedAt: nil)
        }
    }

    func applyEvent(_ data: DraftUpdated) {
        store.applyRemoteDraft(data.channelId, parentId: data.parentId, body: data.deleted ? nil : data.body, updatedAt: data.updatedAt)
    }

    /// Save every draft edited while offline (after connecting), or now instead of after the pause.
    func flush() async {
        for timer in timers.values { timer.cancel() }
        timers = [:]
        for entry in store.draftEntries() where entry.draft.isDirty && store.channel(entry.channelId)?.isMember == true {
            await push(entry.channelId, parentId: entry.parentId)
        }
    }

    func idle() async { await running?.value }

    /// Saves run one at a time, in order.
    private func push(_ channelId: String, parentId: String?) async {
        let previous = running
        let task = Task { [weak self] in
            await previous?.value
            await self?.save(channelId, parentId: parentId)
        }
        running = task
        await task.value
    }

    private func save(_ channelId: String, parentId: String?) async {
        guard let api, isOnline() else { return } // stays dirty: flushed after reconnecting
        let draft = store.draft(channelId, parentId: parentId)
        guard draft.isDirty else { return }
        let text = draft.text
        do {
            if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                try await api.deleteDraft(channelId: channelId, parentId: parentId)
                store.markDraftSaved(channelId, parentId: parentId, text: text, updatedAt: nil)
            } else {
                let saved = try await api.saveDraft(channelId: channelId, parentId: parentId, body: text)
                store.markDraftSaved(channelId, parentId: parentId, text: text, updatedAt: saved.updatedAt)
            }
        } catch {
            // Refused for good (left the conversation, the thread is gone …): keep the text here only.
            if let apiError = error as? ApiError, !apiError.isRetryable {
                store.markDraftSaved(channelId, parentId: parentId, text: text, updatedAt: nil)
            }
        }
    }
}
