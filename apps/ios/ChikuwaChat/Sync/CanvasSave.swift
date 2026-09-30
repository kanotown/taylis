import Foundation
import Observation

/// M45: the canvas calls the save loop and the hub make (ApiClient and the test fakes).
@MainActor
protocol CanvasApi: AnyObject {
    func listCanvases(channelId: String, trashed: Bool) async throws -> [CanvasMeta]
    /// nil: `knownVersion` is still the current one (304).
    func getCanvas(id: String, knownVersion: Int?) async throws -> CanvasOut?
    func saveCanvas(id: String, _ save: CanvasSaveIn) async throws -> CanvasSaveOut
}

/// The pauses of the save loop (a real clock in the app; the tests move theirs by hand).
@MainActor
protocol CanvasClock: AnyObject {
    func sleep(_ seconds: TimeInterval) async
}

@MainActor
final class SystemCanvasClock: CanvasClock {
    func sleep(_ seconds: TimeInterval) async {
        try? await Task.sleep(nanoseconds: UInt64(max(0, seconds) * 1_000_000_000))
    }
}

/// The save loop's pauses (CANVAS.md §4.4).
struct CanvasSaverOptions {
    /// A save goes out when typing pauses this long.
    var debounce: TimeInterval = 2
    /// A canvas.updated while not editing is read again after this pause (bursts collapse).
    var refreshDebounce: TimeInterval = 0.5
    /// Waits before sending a failed save again; the last one repeats (as the desktop's).
    var retryDelays: [TimeInterval] = [1, 2, 5, 10, 30]
    var newId: () -> String = { UUID().uuidString.lowercased() }
}

/// The save on the wire: sent again as it is (same key, body and base) after a failure on the way.
struct CanvasInFlight: Codable, Equatable {
    var clientSaveId: String
    var sent: String
    var baseRevId: String
    var onConflict: CanvasOnConflict
}

/// What survives a restart of the app (the store's SQLite meta `canvas:<id>`), so edits made offline or a save lost on
/// the way go out after the next start with the same key.
struct CanvasPendingState: Codable, Equatable {
    var channelId: String
    var baseRevId: String
    var synced: String
    var text: String
    var version: Int
    var inFlight: CanvasInFlight?
}

/// Where the save loop of one canvas stands.
enum CanvasSaveStatus: String, Equatable {
    /// The first read has not answered yet.
    case loading
    /// The server holds what is on screen.
    case saved
    /// Typed; the save goes out when typing pauses.
    case editing
    /// A save is on the wire.
    case saving
    /// The save failed on the network and goes out again (same key).
    case offline
    /// The save failed with 429 / 5xx and goes out again (same key).
    case retrying
    /// Someone changed the same words: waiting for 自分の版 / 相手の版 / 両方残す.
    case conflict
    /// The version this was written on is gone (long offline): waiting for a choice.
    case expired
    /// Refused for good (403, 422, an archived conversation …); the text stays here.
    case blocked
    /// Moved to the trash, or no longer visible.
    case gone
}

/// The save loop of one open canvas (CANVAS.md §4.4 「クライアント側の規則」), the same state machine as the desktop's
/// (apps/desktop/src/sync/canvasSave.ts). The client holds no merge code: it sends the whole body with the version it
/// was written on (`baseRevId`) and an idempotency key (`clientSaveId`), and takes the server's (possibly merged) body
/// when nothing was typed meanwhile.
///
/// `synced` is the body of the version `baseRevId` names (the base of the next save), `text` what the editor holds
/// (dirty when they differ), `inFlight` the save on the wire. `text` is the stored form (`<@uuid>` mentions); the
/// editor shows `@name` and converts.
@MainActor
@Observable
final class CanvasSaver {
    let id: String
    let channelId: String
    private(set) var status: CanvasSaveStatus = .loading
    /// The server's canvas as last received (its body is the one of that moment).
    private(set) var canvas: CanvasOut?
    /// What the editor holds, in the stored form.
    private(set) var text = ""
    struct ConflictState: Equatable {
        let details: CanvasConflictDetails
        /// The version the refused save was written on: the choice is sent on it again.
        let baseRevId: String
    }
    private(set) var conflict: ConflictState?
    /// canvas_base_expired: the current canvas to compare with.
    private(set) var expired: CanvasOut?
    /// Why saving stopped (blocked / gone).
    @ObservationIgnored private(set) var error: Error?
    /// Bumped when the saver itself changed `text` (a merge, someone else's version, a tick): the editor takes it.
    private(set) var textRevision = 0
    /// The first read failed (not a 404: that is .gone): the screen offers 再読み込み instead of an empty canvas.
    private(set) var loadFailed = false
    /// Whether the editor can take a new text now (not while an IME composition is open). When it cannot, the merged
    /// body waits: the next save carries this text on the version that holds it, and the server merges again.
    @ObservationIgnored var canReplace: () -> Bool = { true }
    /// The unsaved state changed (nil: nothing to keep).
    @ObservationIgnored var persist: ((CanvasPendingState?) -> Void)?

    @ObservationIgnored private var synced = ""
    @ObservationIgnored private var baseRevId: String?
    @ObservationIgnored private var version = 0
    @ObservationIgnored private var inFlight: CanvasInFlight?
    @ObservationIgnored private var again = false
    @ObservationIgnored private var attempt = 0
    @ObservationIgnored private var loaded = false
    @ObservationIgnored private var disposed = false
    /// A merged body could not be put on screen: read the canvas again once the editor is idle.
    @ObservationIgnored private var stale = false
    @ObservationIgnored private var saveTimer: Task<Void, Never>?
    @ObservationIgnored private var retryTimer: Task<Void, Never>?
    @ObservationIgnored private var refreshTimer: Task<Void, Never>?
    @ObservationIgnored private var running: Task<Void, Never>?
    @ObservationIgnored private let api: CanvasApi
    @ObservationIgnored private let clock: CanvasClock
    @ObservationIgnored private let options: CanvasSaverOptions

    init(id: String, channelId: String, api: CanvasApi, clock: CanvasClock? = nil, options: CanvasSaverOptions = .init(),
         restored: CanvasPendingState? = nil) {
        self.id = id
        self.channelId = channelId
        self.api = api
        self.clock = clock ?? SystemCanvasClock()
        self.options = options
        if let restored {
            baseRevId = restored.baseRevId
            synced = restored.synced
            text = restored.text
            version = restored.version
            inFlight = restored.inFlight
        }
    }

    var dirty: Bool { text != synced }

    /// Anything not on the server yet (typed, on the wire, or waiting for a choice).
    var unsaved: Bool { dirty || inFlight != nil || conflict != nil || expired != nil }

    /// Whether a save is on the wire (tests, the screen).
    var busy: Bool { inFlight != nil }

    /// Resolves when the work started so far (a save, its current attempt, a read) has answered.
    func settled() async {
        var seen: Task<Void, Never>?
        while let current = running, current != seen {
            seen = current
            await current.value
        }
    }

    // MARK: loading and reading again

    /// The first read. A restored unsaved state keeps its text and goes on saving.
    func load() {
        track { await self.read(knownVersion: nil, first: true) }
    }

    /// 再読み込み after the first read failed.
    func reload() async {
        guard !disposed, !loaded else { return }
        loadFailed = false
        error = nil
        setStatus(.loading)
        load()
        await settled()
    }

    /// A canvas.updated (or a reconnect): read again unless something here is not saved yet (§4.4).
    func remoteVersion(_ newVersion: Int) {
        guard !disposed, newVersion > version else { return }
        scheduleRefresh(options.refreshDebounce)
    }

    /// Pull to refresh: read again now when nothing here is unsaved.
    func refresh() async {
        guard idleHere else { return }
        track { await self.read(knownVersion: self.version > 0 ? self.version : nil, first: false) }
        await settled()
    }

    /// After reconnecting: saves that failed go out now; an idle canvas is read again (If-None-Match).
    func online() {
        guard !disposed else { return }
        if !loaded {
            load()
            return
        }
        if inFlight != nil, retryTimer != nil {
            retryTimer?.cancel()
            retryTimer = nil
            track { await self.send() }
            return
        }
        if dirty {
            save()
            return
        }
        scheduleRefresh(0)
    }

    private func scheduleRefresh(_ delay: TimeInterval) {
        refreshTimer?.cancel()
        refreshTimer = Task { [weak self] in
            if delay > 0 { await self?.clock.sleep(delay) }
            guard let self, !Task.isCancelled else { return }
            self.refreshTimer = nil
            if self.idleHere { self.track { await self.read(knownVersion: self.version > 0 ? self.version : nil, first: false) } }
        }
    }

    /// Nothing typed, nothing on the wire, no choice open: a newer version may replace the text.
    private var idleHere: Bool {
        loaded && !disposed && !dirty && inFlight == nil && conflict == nil && expired == nil
    }

    private func read(knownVersion: Int?, first: Bool) async {
        let before = text
        let answer: CanvasOut?
        do {
            answer = try await api.getCanvas(id: id, knownVersion: knownVersion)
        } catch {
            if disposed { return }
            if first && !loaded, !Self.isNotFound(error) { loadFailed = true }
            if Self.retryable(error) {
                if first { setStatus(.offline) } // online() loads again
                return
            }
            stop(error)
            return
        }
        guard !disposed, let fresh = answer else { return }
        canvas = fresh
        if first && !loaded {
            loaded = true
            loadFailed = false
            version = max(version, fresh.version)
            guard baseRevId != nil else {
                adopt(fresh)
                setStatus(.saved)
                return
            }
            // A restored state (§4.4 「落ちても、オフラインでも同じ key で再送」): send what was on the wire, then the rest.
            if inFlight != nil {
                track { await self.send() }
                return
            }
            if dirty {
                save()
                return
            }
            if baseRevId != fresh.headRevId { adopt(fresh) }
            setStatus(.saved)
            return
        }
        // Typed (or saved) since the request went out: the next save merges instead.
        if text != before || !idleHere || !canReplace() {
            if idleHere && fresh.body != text { stale = true } // an IME composition: read again after it
            return
        }
        version = max(version, fresh.version)
        stale = false
        adopt(fresh)
        setStatus(.saved)
    }

    /// The server's version becomes the text (nothing unsaved here).
    private func adopt(_ fresh: CanvasOut) {
        baseRevId = fresh.headRevId
        synced = fresh.body
        if text != fresh.body {
            text = fresh.body
            textRevision += 1
        }
        persistState()
    }

    // MARK: editing and saving

    /// The editor's text changed: saved once typing pauses. `external`: the change came from elsewhere on the screen (a
    /// box ticked in the reading view), so the editor takes it like a merge.
    func edit(_ newText: String, external: Bool = false) {
        guard !disposed, newText != text else { return }
        text = newText
        if external { textRevision += 1 }
        if status == .blocked { error = nil } // an edit may fix it (a body that was too long)
        saveTimer?.cancel()
        saveTimer = Task { [weak self] in
            guard let delay = self?.options.debounce else { return }
            await self?.clock.sleep(delay)
            guard let self, !Task.isCancelled else { return }
            self.saveTimer = nil
            self.save()
        }
        if inFlight == nil && conflict == nil && expired == nil && status != .gone && status != .loading {
            setStatus(dirty ? .editing : .saved)
        }
    }

    /// Save now instead of after the pause (closing the canvas, the app going to the background, a tick).
    func flush() async {
        saveTimer?.cancel()
        saveTimer = nil
        save()
        await settled()
    }

    private func save(_ onConflict: CanvasOnConflict = .fail) {
        guard !disposed, loaded, let base = baseRevId else { return }
        if inFlight != nil {
            again = true // once this one answers
            persistState() // what was typed meanwhile survives a restart too
            return
        }
        if conflict != nil || expired != nil || status == .gone || (status == .blocked && error != nil) {
            persistState()
            return
        }
        guard dirty else {
            if stale && idleHere {
                track { await self.read(knownVersion: nil, first: false) }
            } else if status == .editing {
                setStatus(.saved)
            }
            return
        }
        inFlight = CanvasInFlight(clientSaveId: options.newId(), sent: text, baseRevId: base, onConflict: onConflict)
        persistState()
        track { await self.send() }
    }

    private func send() async {
        guard let flight = inFlight, !disposed else { return }
        setStatus(.saving)
        let answer: CanvasSaveOut
        do {
            answer = try await api.saveCanvas(id: id, CanvasSaveIn(baseRevId: flight.baseRevId, body: flight.sent,
                                                                   clientSaveId: flight.clientSaveId, onConflict: flight.onConflict))
        } catch {
            if inFlight == flight, !disposed { failed(flight, error) }
            return
        }
        guard inFlight == flight, !disposed else { return }
        landed(flight, answer)
    }

    private func landed(_ flight: CanvasInFlight, _ answer: CanvasSaveOut) {
        inFlight = nil
        attempt = 0
        canvas = answer.canvas
        version = max(version, answer.canvas.version)
        if text == flight.sent && canReplace() {
            // Nothing typed meanwhile: the head is the base, and a merge's result goes on screen.
            baseRevId = answer.canvas.headRevId
            synced = answer.canvas.body
            if text != answer.canvas.body {
                text = answer.canvas.body
                textRevision += 1
            }
            stale = false
        } else {
            // Typed on: the next save is written on the version holding exactly what was sent (§4.4).
            baseRevId = answer.submittedRevId
            synced = flight.sent
            if answer.canvas.body != flight.sent { stale = true }
        }
        persistState()
        setStatus(dirty ? .editing : .saved)
        if again {
            again = false
            save()
        } else if dirty && saveTimer == nil {
            save()
        }
    }

    private func failed(_ flight: CanvasInFlight, _ failure: Error) {
        switch failure {
        case CanvasSaveFailure.conflict(let details):
            inFlight = nil
            again = false
            attempt = 0
            canvas = details.head
            conflict = ConflictState(details: details, baseRevId: flight.baseRevId)
            setStatus(.conflict)
            persistState()
            return
        case CanvasSaveFailure.expired(let head):
            inFlight = nil
            again = false
            attempt = 0
            canvas = head
            expired = head
            setStatus(.expired)
            persistState()
            return
        default:
            break
        }
        if Self.retryable(failure) {
            // Kept as it is (same key, body and base) and sent again: never a second version (§4.4).
            if case ApiError.network = failure { setStatus(.offline) } else { setStatus(.retrying) }
            let delays = options.retryDelays
            var delay = delays.isEmpty ? 30 : delays[min(attempt, delays.count - 1)]
            if case CanvasSaveFailure.rateLimited(let seconds) = failure { delay = max(1, seconds) }
            attempt += 1
            retryTimer?.cancel()
            retryTimer = Task { [weak self] in
                await self?.clock.sleep(delay)
                guard let self, !Task.isCancelled else { return }
                self.retryTimer = nil
                self.track { await self.send() }
            }
            return
        }
        inFlight = nil
        again = false
        persistState()
        stop(failure)
    }

    /// Temporary failures: the network, 429, 5xx.
    static func retryable(_ error: Error) -> Bool {
        if case CanvasSaveFailure.rateLimited = error { return true }
        if let apiError = error as? ApiError { return apiError.isRetryable }
        return false
    }

    /// Refused for good: nothing more is sent until the text changes (403, 422) or at all (404: in the trash).
    private func stop(_ failure: Error) {
        error = failure
        setStatus(Self.isNotFound(failure) ? .gone : .blocked)
    }

    private static func isNotFound(_ error: Error) -> Bool {
        if case ApiError.api(let status, _, _) = error { return status == 404 }
        return false
    }

    // MARK: choices

    /// §4.4 409 canvas_conflict: send the text again on the same version with the choice for the overlapping words —
    /// ours (mine), theirs (the other version) or both (theirs, then mine quoted). A member who may only tick can only
    /// take theirs (the server refuses the others from them).
    func resolveConflict(_ choice: CanvasOnConflict) async {
        guard let current = conflict, !disposed, choice != .fail else { return }
        conflict = nil
        inFlight = CanvasInFlight(clientSaveId: options.newId(), sent: text, baseRevId: current.baseRevId, onConflict: choice)
        persistState()
        track { await self.send() }
        await settled()
    }

    /// §4.4 409 canvas_base_expired: "mine" saves this text over the current version (what others wrote since is
    /// replaced; it stays in the history), "theirs" drops this text for the current version.
    func resolveExpired(keepMine: Bool) async {
        guard let head = expired, !disposed else { return }
        expired = nil
        canvas = head
        version = max(version, head.version)
        baseRevId = head.headRevId
        synced = head.body
        if !keepMine {
            adopt(head)
            setStatus(.saved)
            return
        }
        persistState()
        save()
        await settled()
    }

    // MARK: the rest

    /// canvas.deleted (or a 404): nothing more is saved; the text stays on screen to be copied.
    func gone() {
        guard !disposed else { return }
        clearTimers()
        inFlight = nil
        error = ApiError.api(status: 404, code: "canvas_not_found", message: "Canvas not found")
        setStatus(.gone)
    }

    /// The metadata changed (the title, a setting) without a new body: the screen shows it.
    func applyMeta(_ meta: CanvasMeta) {
        guard !disposed else { return }
        if let canvas, meta.version < canvas.version { return }
        canvas = canvas?.with(meta: meta)
    }

    func dispose() {
        disposed = true
        clearTimers()
    }

    private func clearTimers() {
        for timer in [saveTimer, retryTimer, refreshTimer] { timer?.cancel() }
        saveTimer = nil
        retryTimer = nil
        refreshTimer = nil
    }

    /// Runs `work` after what is already running (one save or read at a time, in order).
    private func track(_ work: @escaping @MainActor () async -> Void) {
        let previous = running
        running = Task { @MainActor in
            await previous?.value
            await work()
        }
    }

    private func persistState() {
        guard let persist else { return }
        guard let base = baseRevId, dirty || inFlight != nil || conflict != nil || expired != nil else {
            persist(nil)
            return
        }
        persist(CanvasPendingState(channelId: channelId, baseRevId: base, synced: synced, text: text, version: version, inFlight: inFlight))
    }

    private func setStatus(_ next: CanvasSaveStatus) {
        if status != next { status = next }
    }
}
