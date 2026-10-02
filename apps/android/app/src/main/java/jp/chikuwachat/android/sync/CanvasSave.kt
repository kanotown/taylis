package jp.chikuwachat.android.sync

import jp.chikuwachat.android.api.ApiException
import jp.chikuwachat.android.api.CanvasConflictDetails
import jp.chikuwachat.android.api.CanvasMeta
import jp.chikuwachat.android.api.CanvasOut
import jp.chikuwachat.android.api.CanvasSaveOut
import jp.chikuwachat.android.api.Codec
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonPrimitive
import java.util.UUID

/**
 * - LOADING: the first GET has not answered yet
 * - SAVED: the server holds what is on screen
 * - EDITING: typed, the save goes out when typing pauses
 * - SAVING: a save is on the wire
 * - OFFLINE / RETRYING: the save failed on the network / with 429 or 5xx and goes out again (same key)
 * - CONFLICT: someone changed the same words; waiting for 自分の版 / 相手の版 / 両方残す
 * - EXPIRED: the version this was written on is gone (long offline); waiting for a choice
 * - BLOCKED: refused for good (403, 422, an archived conversation …); the text stays here
 * - GONE: the canvas was moved to the trash (or cannot be seen any more)
 */
enum class CanvasSaveStatus { LOADING, SAVED, EDITING, SAVING, OFFLINE, RETRYING, CONFLICT, EXPIRED, BLOCKED, GONE }

/** The save on the wire: sent again as it is (same key, body and base) after a network failure, 429 or 5xx. */
@Serializable
data class CanvasInFlight(val clientSaveId: String, val sent: String, val baseRevId: String, val onConflict: String = "fail")

/** What survives the process (kept in the Room store's meta under "canvas:<id>"), so a restart sends it with the same key. */
@Serializable
data class CanvasPendingState(
    val channelId: String,
    val baseRevId: String,
    val synced: String,
    val text: String,
    val version: Long,
    val inFlight: CanvasInFlight? = null,
)

/** The version the refused save was written on: the choice is sent on it again. */
data class CanvasConflictState(val details: CanvasConflictDetails, val baseRevId: String)

/** A timer that can be taken back (the app's runs on the main scope; the tests' on a hand-driven clock). */
fun interface CanvasCancel {
    fun cancel()
}

fun interface CanvasTimers {
    fun schedule(delayMs: Long, action: () -> Unit): CanvasCancel
}

data class CanvasSaverOptions(
    /** §4.4: a save goes out when typing pauses this long. */
    val debounceMs: Long = 2_000,
    /** §4.4: a canvas.updated while not editing is read again after this pause (bursts collapse). */
    val refreshDebounceMs: Long = 500,
    /** Waits before sending a failed save again; the last one repeats (M43's 1 → 2 → 5 → 10 → 30 s). */
    val retryDelaysMs: List<Long> = listOf(1_000, 2_000, 5_000, 10_000, 30_000),
    val newId: () -> String = { UUID.randomUUID().toString() },
    /** Null: timers on the saver's scope (`delay`). */
    val timers: CanvasTimers? = null,
    /** M74: where the canvas copies are read (the app: Dispatchers.IO, see EngineOptions; null: on the caller's thread). */
    val io: CoroutineDispatcher? = null,
    /** M74: the clock of the copies' `fetchedAt`. */
    val now: () -> Long = { System.currentTimeMillis() },
)

/**
 * The save loop of one open canvas (CANVAS.md §4.4 「クライアント側の規則」), the same state machine as the desktop's
 * src/sync/canvasSave.ts. The client holds no merge code: it sends the whole body with the version it was written on
 * (`base_rev_id`) and an idempotency key (`client_save_id`), and takes the server's (possibly merged) body when nothing
 * was typed meanwhile.
 *
 * State: `synced` is the body of the version `baseRevId` names (the base of the next save), [text] what the editor
 * holds (dirty when they differ), `inFlight` the save on the wire. [text] is the stored form (`<@uuid>` mentions); the
 * editor shows and edits `@name` and converts (ui/CanvasPane.kt).
 *
 * Runs on the scope's thread (the app's main thread); the work it starts is tracked so tests can wait for it.
 */
class CanvasSaver(
    val id: String,
    val channelId: String,
    private val api: CanvasSaveApi,
    private val scope: CoroutineScope,
    private val options: CanvasSaverOptions = CanvasSaverOptions(),
    restored: CanvasPendingState? = null,
    /** M74: the last copy kept on this device (read once, before the first GET): shown while the server cannot answer. */
    private val cached: (suspend () -> CachedCanvas?)? = null,
    /** M74: the server answered with this canvas (keep it as the copy), or null: it is gone or out of reach (drop it). */
    private val remember: ((CanvasOut?) -> Unit)? = null,
    /** The unsaved state changed (null: nothing to keep). */
    private val persist: ((CanvasPendingState?) -> Unit)? = null,
) {
    var status = CanvasSaveStatus.LOADING
        private set
    /** The server's canvas as last received (its body is the one of that moment). */
    var canvas: CanvasOut? = null
        private set
    /** What the editor holds, in the stored form. */
    var text = ""
        private set
    var conflict: CanvasConflictState? = null
        private set
    /** canvas_base_expired: the current canvas to compare with. */
    var expired: CanvasOut? = null
        private set
    /** Why saving stopped (BLOCKED / GONE). */
    var error: Throwable? = null
        private set
    /** Why the first read failed (cleared when [load] tries again): the screen offers 再読み込み, not an empty canvas. */
    var loadError: Throwable? = null
        private set
    /**
     * M74: the screen shows the copy kept on this device, read from the server at this moment, and the server has not
     * answered since (null once it has). With [unreachable] the screen says so (CanvasOffline.notice).
     */
    var cachedAt: Long? = null
        private set
    /** M74: the last try to reach the server about this canvas failed for now (the network, 5xx …). */
    var unreachable = false
        private set
    private val _revision = MutableStateFlow(0)
    /** Bumped on every change (Compose collects it). */
    val revision: StateFlow<Int> = _revision
    /** Bumped when the saver itself changed [text] (a merge or someone else's version): the editor takes it. */
    var textRevision = 0
        private set
    /**
     * Whether the editor can take a new text now (not while an IME composition is open). When it cannot, the merged body
     * waits: the next save carries this text on the version that holds it, and the server merges again.
     */
    var canReplace: () -> Boolean = { true }

    private var synced = ""
    private var baseRevId: String? = null
    private var version = 0L
    private var inFlight: CanvasInFlight? = null
    private var again = false
    private var attempt = 0
    private var loaded = false
    private var loading = false
    private var cacheTried = false
    /**
     * M74: the last canvas the server gave whole (its body, version and head belong together). [canvas] may carry newer
     * metadata over an older body (applyMeta), so the copy is never taken from it.
     */
    private var lastWhole: CanvasOut? = null
    private var disposed = false
    /** A merged body could not be put on screen: read the canvas again once the editor is idle. */
    private var stale = false
    private var saveTimer: CanvasCancel? = null
    private var retryTimer: CanvasCancel? = null
    private var refreshTimer: CanvasCancel? = null
    private val jobs = LinkedHashSet<Job>()

    init {
        if (restored != null) {
            baseRevId = restored.baseRevId
            synced = restored.synced
            text = restored.text
            version = restored.version
            inFlight = restored.inFlight
        }
    }

    val dirty: Boolean get() = text != synced

    /** Anything not on the server yet (typed, on the wire, or waiting for a choice). */
    val unsaved: Boolean get() = dirty || inFlight != null || conflict != null || expired != null

    val busy: Boolean get() = inFlight != null

    /** Waits until the work started so far (a save, its retries' current attempt, a read) has answered (tests, sign-out). */
    suspend fun settled() {
        while (true) {
            val job = jobs.firstOrNull { it.isActive } ?: return
            job.join()
        }
    }

    // --- loading and reading again ---------------------------------------------------------

    /**
     * The first read (again after it failed). A restored unsaved state keeps its text and goes on saving. M74: the copy
     * kept on this device comes first (shown, and edited, at once); the server is then asked whether it is still the
     * current one (If-None-Match), and unsaved edits go out on its head.
     */
    fun load() {
        if (disposed || loaded || loading) return
        if (loadError != null) {
            loadError = null
            error = null
            setStatus(CanvasSaveStatus.LOADING)
        }
        loading = true
        track {
            try {
                if (!cacheTried) {
                    cacheTried = true
                    val copy = cached?.let { source ->
                        try {
                            source()
                        } catch (e: CancellationException) {
                            throw e
                        } catch (_: Exception) {
                            null
                        }
                    }
                    if (copy != null) showCopy(copy)
                }
                if (disposed) return@track
                if (loaded) confirmCopy() else read(null, first = true)
            } finally {
                loading = false
            }
        }
    }

    /** M74: the kept copy is what the server last said; a restored unsaved state keeps its own base and text. */
    private fun showCopy(copy: CachedCanvas) {
        if (disposed || loaded || copy.canvas.id != id) return
        val got = copy.canvas
        canvas = got
        lastWhole = got
        cachedAt = copy.fetchedAt
        loaded = true
        version = maxOf(version, got.version)
        if (baseRevId == null) {
            baseRevId = got.headRevId
            synced = got.body
            text = got.body
            textRevision += 1
        }
        setStatus(if (unsaved) CanvasSaveStatus.EDITING else CanvasSaveStatus.SAVED)
    }

    /** M74: after showing the copy: what was kept goes out, or the server says whether the copy is current. */
    private suspend fun confirmCopy() {
        when {
            inFlight != null -> send()
            dirty -> save()
            idleHere() -> read(version.takeIf { it > 0 }, first = false)
        }
    }

    /** M74: the server answered with the canvas (or that ours is current): no longer only the kept copy. */
    private fun reached(got: CanvasOut?) {
        cachedAt = null
        unreachable = false
        if (got != null) lastWhole = got
        // A 304 vouches for the version asked about: the copy is rewritten (its time) only when it is that one.
        val current = got ?: lastWhole?.takeIf { it.version == version } ?: return
        remember?.invoke(current)
    }

    /** A canvas.updated (or a reconnect): read again unless something here is not saved yet (§4.4). */
    fun remoteVersion(version: Long) {
        if (disposed || version <= this.version) return
        scheduleRefresh()
    }

    /** After reconnecting: saves that failed go out now; an idle canvas is read again (If-None-Match). */
    fun online() {
        if (disposed) return
        if (!loaded) {
            load()
            return
        }
        val retry = retryTimer
        if (inFlight != null && retry != null) {
            retry.cancel()
            retryTimer = null
            track { send() }
            return
        }
        if (dirty) {
            save()
            return
        }
        scheduleRefresh(0)
    }

    private fun scheduleRefresh(delayMs: Long = options.refreshDebounceMs) {
        refreshTimer?.cancel()
        refreshTimer = schedule(delayMs) {
            refreshTimer = null
            if (idleHere()) track { read(version.takeIf { it > 0 }, first = false) }
        }
    }

    /** Nothing typed, nothing on the wire, no choice open: a newer version may replace the text. */
    private fun idleHere(): Boolean = loaded && !disposed && !dirty && inFlight == null && conflict == null && expired == null

    private suspend fun read(knownVersion: Long?, first: Boolean) {
        val before = text
        val got = try {
            api.getCanvas(id, knownVersion)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Throwable) {
            if (disposed) return
            if (first && !loaded) loadError = e
            if (temporary(e)) {
                if (first) setStatus(CanvasSaveStatus.OFFLINE) // online() loads again
                else if (cachedAt != null) {
                    // M74: the kept copy stays on screen (and editable), saying how old it is.
                    unreachable = true
                    if (idleHere()) setStatus(CanvasSaveStatus.OFFLINE) else emit()
                }
                return
            }
            if (e is ApiException.Api && (e.status == 403 || e.status == 404)) remember?.invoke(null) // M74: not to be shown any more
            if (cachedAt != null && !first) {
                // M74: the copy was all there was: the screen says why it cannot be read (or that it is in the trash).
                cachedAt = null
                unreachable = false
                loaded = false // 再読み込み reads it again from the start
                loadError = e
            }
            stop(e)
            return
        }
        if (disposed) return
        if (got == null) {
            // 304: what is here is current.
            if (cachedAt != null || unreachable) {
                reached(null)
                if (status == CanvasSaveStatus.OFFLINE && idleHere()) setStatus(CanvasSaveStatus.SAVED) else emit()
            }
            return
        }
        canvas = got
        reached(got)
        if (first && !loaded) {
            loaded = true
            version = maxOf(version, got.version)
            if (baseRevId == null) {
                adopt(got)
                setStatus(CanvasSaveStatus.SAVED)
                return
            }
            // A restored state (§4.4 「落ちても、オフラインでも同じ key で再送」): send what was on the wire, then the rest.
            if (inFlight != null) {
                track { send() }
                return
            }
            if (dirty) {
                save()
                return
            }
            if (baseRevId != got.headRevId) adopt(got)
            setStatus(CanvasSaveStatus.SAVED)
            return
        }
        // Typed (or saved) since the request went out: the next save merges instead.
        if (text != before || !idleHere() || !canReplace()) {
            if (idleHere() && got.body != text) stale = true // an IME composition: read again after it
            emit()
            return
        }
        version = maxOf(version, got.version)
        stale = false
        adopt(got)
        setStatus(CanvasSaveStatus.SAVED)
    }

    /** The server's version becomes the text (nothing unsaved here). */
    private fun adopt(got: CanvasOut) {
        baseRevId = got.headRevId
        synced = got.body
        if (text != got.body) {
            text = got.body
            textRevision += 1
        }
        persistState()
    }

    // --- editing and saving ---------------------------------------------------------------------

    /**
     * The editor's text changed: saved once typing pauses. `external`: the change came from elsewhere on the screen (a
     * box ticked in the reading view), so the editor takes it like a merge.
     */
    fun edit(next: String, external: Boolean = false) {
        if (disposed || next == text) return
        text = next
        if (external) textRevision += 1
        if (status == CanvasSaveStatus.BLOCKED) error = null // an edit may fix it (a body that was too long)
        saveTimer?.cancel()
        saveTimer = schedule(options.debounceMs) {
            saveTimer = null
            save()
        }
        if (inFlight == null && conflict == null && expired == null && status != CanvasSaveStatus.GONE) {
            setStatus(if (dirty) CanvasSaveStatus.EDITING else CanvasSaveStatus.SAVED)
        } else {
            emit()
        }
        persistState()
    }

    /**
     * The editor can take a new text again (an IME composition ended). A merged body that had to wait for it is read now
     * when nothing is left to save; otherwise the next save brings it (M46: a composition committed without changing
     * the text — 「けんきゅう」 kept as kana — left someone else's edit off the screen until the next keystroke).
     */
    fun replaceable() {
        if (stale && idleHere() && canReplace()) track { read(null, first = false) }
    }

    /** Save now instead of after the pause (leaving the canvas, the app going to the background, a tick). */
    fun flush() {
        saveTimer?.cancel()
        saveTimer = null
        save()
    }

    private fun save(onConflict: String = "fail") {
        val base = baseRevId
        if (disposed || !loaded || base == null) return
        if (inFlight != null) {
            again = true // once this one answers
            return
        }
        if (conflict != null || expired != null || status == CanvasSaveStatus.GONE || (status == CanvasSaveStatus.BLOCKED && error != null)) return
        if (!dirty) {
            if (stale && idleHere()) track { read(null, first = false) }
            else if (status == CanvasSaveStatus.EDITING) setStatus(CanvasSaveStatus.SAVED)
            return
        }
        inFlight = CanvasInFlight(options.newId(), text, base, onConflict)
        persistState()
        track { send() }
    }

    private suspend fun send() {
        val flight = inFlight ?: return
        if (disposed) return
        setStatus(CanvasSaveStatus.SAVING)
        val answer = try {
            api.saveCanvas(id, flight.baseRevId, flight.sent, flight.clientSaveId, flight.onConflict)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Throwable) {
            if (inFlight === flight && !disposed) failed(flight, e)
            return
        }
        if (inFlight !== flight || disposed) return
        landed(flight, answer)
    }

    private fun landed(flight: CanvasInFlight, answer: CanvasSaveOut) {
        inFlight = null
        attempt = 0
        canvas = answer.canvas
        reached(answer.canvas)
        version = maxOf(version, answer.canvas.version)
        if (text == flight.sent && canReplace()) {
            // Nothing typed meanwhile: the head is the base, and a merge's result goes on screen.
            baseRevId = answer.canvas.headRevId
            synced = answer.canvas.body
            if (text != answer.canvas.body) {
                text = answer.canvas.body
                textRevision += 1
            }
            stale = false
        } else {
            // Typed on: the next save is written on the version holding exactly what was sent (§4.4).
            baseRevId = answer.submittedRevId
            synced = flight.sent
            if (answer.canvas.body != flight.sent) stale = true
        }
        persistState()
        setStatus(if (dirty) CanvasSaveStatus.EDITING else CanvasSaveStatus.SAVED)
        if (again) {
            again = false
            save()
        } else if (dirty && saveTimer == null) {
            save()
        }
    }

    private fun failed(flight: CanvasInFlight, e: Throwable) {
        if (e is ApiException.Api && e.status == 409 && (e.code == "canvas_conflict" || e.code == "canvas_base_expired")) {
            inFlight = null
            again = false
            attempt = 0
            val details = e.details?.let { runCatching { Codec.snake.decodeFromJsonElement(CanvasConflictDetails.serializer(), it) }.getOrNull() }
            if (details != null) {
                canvas = details.head
                reached(details.head)
            }
            when {
                e.code == "canvas_conflict" && details != null -> {
                    conflict = CanvasConflictState(details, flight.baseRevId)
                    setStatus(CanvasSaveStatus.CONFLICT)
                }
                details != null -> {
                    expired = details.head
                    setStatus(CanvasSaveStatus.EXPIRED)
                }
                else -> stop(e)
            }
            persistState()
            return
        }
        if (temporary(e)) {
            // Kept as it is (same key, body and base) and sent again: never a second version (§4.4).
            if (cachedAt != null) unreachable = true
            setStatus(if (e is ApiException.Network) CanvasSaveStatus.OFFLINE else CanvasSaveStatus.RETRYING)
            val delays = options.retryDelaysMs
            val wait = retryAfterMs(e) ?: delays.getOrElse(minOf(attempt, delays.size - 1)) { 30_000L }
            attempt += 1
            retryTimer?.cancel()
            retryTimer = schedule(wait) {
                retryTimer = null
                track { send() }
            }
            return
        }
        inFlight = null
        again = false
        persistState()
        stop(e)
    }

    /** Refused for good: nothing more is sent until the text changes (403, 422) or at all (404: in the trash). */
    private fun stop(e: Throwable) {
        error = e
        setStatus(if (e is ApiException.Api && e.status == 404) CanvasSaveStatus.GONE else CanvasSaveStatus.BLOCKED)
    }

    // --- choices --------------------------------------------------------------------------------

    /**
     * §4.4 409 canvas_conflict: send the text again on the same version with the choice for the overlapping words —
     * "ours" (mine), "theirs" (the other version) or "both" (theirs, then mine quoted). A member who may only tick can
     * only take theirs (the server refuses the others from them).
     */
    fun resolveConflict(choice: String) {
        val open = conflict ?: return
        if (disposed || choice == "fail") return
        conflict = null
        inFlight = CanvasInFlight(options.newId(), text, open.baseRevId, choice)
        persistState()
        track { send() }
    }

    /**
     * §4.4 409 canvas_base_expired: "mine" saves this text over the current version (what others wrote since is
     * replaced; it stays in the history), "theirs" drops this text for the current version.
     */
    fun resolveExpired(mine: Boolean) {
        val head = expired ?: return
        if (disposed) return
        expired = null
        canvas = head
        version = maxOf(version, head.version)
        baseRevId = head.headRevId
        synced = head.body
        if (!mine) {
            adopt(head)
            setStatus(CanvasSaveStatus.SAVED)
            return
        }
        persistState()
        save()
    }

    // --- the rest ----------------------------------------------------------------------------------

    /** canvas.deleted: nothing more is saved; the text stays on screen to be copied. */
    fun gone() {
        if (disposed) return
        clearTimers()
        inFlight = null
        cachedAt = null
        unreachable = false
        error = ApiException.Api(404, "canvas_not_found", "Canvas not found")
        setStatus(CanvasSaveStatus.GONE)
    }

    /** The metadata changed (the title, a setting) without a new body: the screen shows it. */
    fun applyMeta(meta: CanvasMeta) {
        if (disposed) return
        val current = canvas
        if (current != null && meta.version < current.version) return
        canvas = current?.withMeta(meta) ?: return
        emit()
    }

    fun dispose() {
        disposed = true
        clearTimers()
    }

    private fun clearTimers() {
        saveTimer?.cancel()
        retryTimer?.cancel()
        refreshTimer?.cancel()
        saveTimer = null
        retryTimer = null
        refreshTimer = null
    }

    private fun track(work: suspend () -> Unit) {
        val job = scope.launch { work() }
        if (job.isActive) {
            jobs.add(job)
            job.invokeOnCompletion { jobs.remove(job) }
        }
    }

    private fun schedule(delayMs: Long, action: () -> Unit): CanvasCancel {
        options.timers?.let { return it.schedule(delayMs, action) }
        val job = scope.launch {
            delay(delayMs)
            action()
        }
        return CanvasCancel { job.cancel() }
    }

    private fun persistState() {
        val sink = persist ?: return
        val base = baseRevId
        if (base == null || (!dirty && inFlight == null && conflict == null && expired == null)) {
            sink(null)
            return
        }
        sink(CanvasPendingState(channelId, base, synced, text, version, inFlight))
    }

    private fun setStatus(value: CanvasSaveStatus) {
        status = value
        emit()
    }

    private fun emit() {
        _revision.value = _revision.value + 1
    }

    companion object {
        /** Worth sending again as it was: the network, 429, 5xx, or a 401 the reconnect renews (never a second version). */
        fun temporary(e: Throwable): Boolean =
            e is ApiException.Network || (e is ApiException.Api && (e.status == 429 || e.status >= 500 || e.status == 401))

        /** 429's details carry `retry_after_seconds` (server/app/core/errors.py rate_limited). */
        fun retryAfterMs(e: Throwable): Long? {
            if (e !is ApiException.Api || e.status != 429) return null
            val seconds = (e.details as? JsonObject)?.get("retry_after_seconds")?.jsonPrimitive?.intOrNull ?: return null
            return maxOf(1_000L, seconds * 1_000L)
        }
    }
}
