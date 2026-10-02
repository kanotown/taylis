import Foundation

/// Why a conversation's canvas list is not there.
enum CanvasListFailure: Equatable {
    /// The server has no canvas API yet (the list answers 404).
    case unsupported
    /// Anything else (the network, 5xx …): 再読み込み tries again.
    case failed
}

/// M45: canvases on this device (CANVAS.md §4.4 / §4.6), as the desktop's CanvasHub (apps/desktop/src/sync/canvases.ts).
/// The conversation's list lives in the store (loaded when it opens and after reconnecting, kept current by canvas.*
/// events: the larger version wins); each canvas on screen, or with edits not saved yet, has a CanvasSaver. Unsaved edits
/// are kept in the store (SQLite), so a relaunch sends them with the same idempotency key.
@MainActor
final class CanvasHub {
    private let api: CanvasApi?
    private let store: Store
    private let clock: CanvasClock
    private let options: CanvasSaverOptions
    private var savers: [String: CanvasSaver] = [:]
    /// How many screens show each canvas: one nobody shows is dropped once it holds nothing unsaved.
    private var holds: [String: Int] = [:]

    init(api: CanvasApi?, store: Store, clock: CanvasClock? = nil, options: CanvasSaverOptions = .init()) {
        self.api = api
        self.store = store
        self.clock = clock ?? SystemCanvasClock()
        self.options = options
    }

    var available: Bool { api != nil }

    /// The conversation's canvases (when it opens, after reconnecting). A failure is kept for the tab (a server from
    /// before canvases, or 再読み込み) until the next try, which shows the spinner again; a list loaded before stays.
    func loadList(_ channelId: String) async {
        guard let api else { return }
        store.setCanvasListFailure(channelId, nil)
        do {
            store.setCanvases(channelId, try await api.listCanvases(channelId: channelId, trashed: false))
        } catch {
            print("could not load the canvases: \(error)")
            let failure = Self.listFailure(error)
            // M74: never loaded (offline since the app started): the canvases kept here stand in, to read offline.
            let kept = store.cachedCanvases(of: channelId)
            if failure == .failed, store.canvasesOf(channelId) == nil, !kept.isEmpty, CanvasSaver.retryable(error) {
                store.setCanvases(channelId, kept)
                return
            }
            store.setCanvasListFailure(channelId, failure)
        }
    }

    /// A 404 is the route missing (a server from before M45 says not_found), unless it is channel_not_found: a
    /// conversation I cannot see on a server that has canvases.
    static func listFailure(_ error: Error) -> CanvasListFailure {
        if case ApiError.api(404, let code, _) = error, code != "channel_not_found" { return .unsupported }
        return .failed
    }

    /// The saver of a canvas (made, and its unsaved edits restored, on first use).
    func saver(_ canvasId: String, channelId: String) -> CanvasSaver? {
        guard let api else { return nil }
        if let existing = savers[canvasId] { return existing }
        let saver = CanvasSaver(id: canvasId, channelId: channelId, api: api, clock: clock, options: options, restored: store.pendingCanvas(canvasId),
                                cached: store.cachedCanvas(canvasId))
        saver.persist = { [weak store] state in store?.setPendingCanvas(canvasId, state) }
        // M74 (CANVAS.md §19.1): the server's copy is kept to read offline; a 404 drops it.
        saver.received = { [weak store] canvas in store?.cacheCanvas(canvas) }
        saver.confirmed = { [weak store] in store?.touchCachedCanvas(canvasId) }
        saver.vanished = { [weak store] in store?.dropCachedCanvas(canvasId) }
        savers[canvasId] = saver
        saver.load()
        return saver
    }

    /// A screen shows the canvas; `release` lets go (saving what is typed, §4.4 「画面を閉じるとき」).
    func hold(_ canvasId: String, channelId: String) -> CanvasSaver? {
        let saver = saver(canvasId, channelId: channelId)
        holds[canvasId, default: 0] += 1
        return saver
    }

    func release(_ canvasId: String) {
        let left = (holds[canvasId] ?? 1) - 1
        holds[canvasId] = left > 0 ? left : nil
        guard let saver = savers[canvasId] else { return }
        Task {
            await saver.flush()
            self.dropIfIdle(canvasId)
        }
    }

    func current(_ canvasId: String) -> CanvasSaver? { savers[canvasId] }

    /// M73: a screen shows the canvas now (its mention needs no notice).
    func isShown(_ canvasId: String) -> Bool { holds[canvasId] != nil }

    private func dropIfIdle(_ canvasId: String) {
        guard let saver = savers[canvasId], holds[canvasId] == nil, !saver.unsaved else { return }
        saver.dispose()
        savers[canvasId] = nil
    }

    /// canvas.created / canvas.updated / canvas.deleted (§4.6).
    func applyEvent(_ event: String, _ data: JSONValue) {
        switch event {
        case "canvas.created":
            if let meta = try? data["canvas"]?.decode(CanvasMeta.self) { store.applyCanvasMeta(meta) }
        case "canvas.updated":
            guard let payload = try? data.decode(CanvasUpdatedEvent.self) else { return }
            store.applyCanvasMeta(payload.canvas)
            savers[payload.canvas.id]?.applyMeta(payload.canvas)
            savers[payload.canvas.id]?.remoteVersion(payload.canvas.version)
        case "canvas.deleted":
            guard let payload = try? data.decode(CanvasDeletedEvent.self) else { return }
            trashed(payload.canvasId, channelId: payload.channelId)
        default:
            break
        }
    }

    /// Moved to the trash (here or elsewhere): out of the list; an open one stops saving (its text stays to copy).
    func trashed(_ canvasId: String, channelId: String) {
        store.removeCanvas(channelId: channelId, canvasId: canvasId)
        if let saver = savers[canvasId] {
            saver.gone()
        }
        store.setPendingCanvas(canvasId, nil)
        store.dropCachedCanvas(canvasId) // M74
    }

    /// After (re)connecting: failed saves go out, open canvases are read again, edits kept from before a relaunch resume.
    func online() {
        guard api != nil else { return }
        for saver in savers.values { saver.online() }
        for (canvasId, pending) in store.pendingCanvases() where savers[canvasId] == nil {
            // Only conversations still mine (§4.6: leaving one drops its canvases).
            guard store.channel(pending.channelId)?.isMember == true else {
                store.setPendingCanvas(canvasId, nil)
                continue
            }
            guard let saver = saver(canvasId, channelId: pending.channelId) else { continue }
            Task {
                await saver.settled()
                self.dropIfIdle(canvasId)
            }
        }
    }

    /// Save everything typed now (the app goes to the background, sign-out).
    func flushAll() async {
        for saver in Array(savers.values) { await saver.flush() }
    }

    /// I left the conversation (or it was removed): its canvases and their savers go (§4.6).
    func removeChannel(_ channelId: String) {
        for (canvasId, saver) in savers where saver.channelId == channelId {
            saver.dispose()
            savers[canvasId] = nil
            holds[canvasId] = nil
        }
    }

    func stop() {
        for saver in savers.values { saver.dispose() }
        savers = [:]
        holds = [:]
    }
}
