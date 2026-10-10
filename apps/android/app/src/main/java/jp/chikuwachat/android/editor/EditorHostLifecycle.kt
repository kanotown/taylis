package jp.chikuwachat.android.editor

import jp.chikuwachat.android.sync.CanvasCancel
import jp.chikuwachat.android.sync.CanvasTimers

/**
 * M153a (docs/WIKI.md §30.5): which editing session the one WebView of a page screen talks to, and when the WebView may
 * go (ui/MobileEditor.kt's MobileEditorHost holds one; plain Kotlin so the order of things is tested on the JVM).
 *
 * Leaving the editor (`detach`, the switch to reading or Markdown) and the page screen going (`release`) both ask the
 * editor for its body first: what is typed in the last 300 ms is only in the WebView. Two states, kept apart:
 *  - **closing** (`release` came): no new session; the final `requestBody` still goes out and its answer still comes in
 *    and reaches the page's save loop. The WebView is destroyed once no leaving session waits any more.
 *  - **destroyed**: the WebView is gone (destroyed here, or its render process died and no new one is read):
 *    nothing goes out or comes in. A render process that died while a new WebView reads the page again is [pageLost].
 * `detach` and `release` give the same ending in either order. A session whose answer does not come within [graceMs]
 * gives up ([EditorSession.giveUp]): the loop keeps and saves what it has, nothing is discarded.
 *
 * Runs on the main thread.
 */
class EditorHostLifecycle(
    private val timers: CanvasTimers,
    /** Destroys the WebView (once). */
    private val destroyWebView: () -> Unit,
    private val graceMs: Long = LEAVE_GRACE_MS,
    private val warn: (String) -> Unit = {},
) {
    /** The session editing now. */
    var current: EditorSession? = null
        private set
    /** Sessions left (by `detach` or `release`) whose last body is still asked for, oldest first. */
    private val leaving = ArrayList<Pair<EditorSession, CanvasCancel>>()
    private val whenClosed = ArrayList<() -> Unit>()

    /** `release` came: the page screen is gone. */
    var closing = false
        private set
    /** The WebView is gone: nothing more is sent to it or taken from it. */
    var destroyed = false
        private set

    /** A session left behind still waits for its last body (a merge must wait for it too: its body is older). */
    val leavingAwaitsBody: Boolean get() = leaving.any { it.first.awaitingBody }

    /** Whether a message may go to the WebView. */
    val canSend: Boolean get() = !destroyed

    /**
     * The page's session starts (`ready` already come: [readyVersion], replayed so `load` goes out now). False when
     * the host is closing or gone (the screen then uses the Markdown editor).
     */
    fun attach(next: EditorSession, readyVersion: Int?): Boolean {
        if (closing || destroyed) {
            next.end()
            return false
        }
        current?.takeIf { it !== next }?.let { leave(it) }
        current = next
        next.start()
        readyVersion?.let { next.onWeb(WebMessage.Ready(it)) }
        return true
    }

    /** The session is left (reading, Markdown, the composable going): its last body is asked for first. */
    fun detach(session: EditorSession) {
        if (current !== session) return // already left (release came first) or never attached
        current = null
        leave(session)
    }

    /**
     * The page screen goes: the session editing now is left as by [detach]; the WebView is destroyed once every leaving
     * session has its body (or gave up). [onClosed] runs then (the page's save loop may be let go after it).
     */
    fun release(onClosed: () -> Unit = {}) {
        if (destroyed) {
            closing = true
            onClosed()
            return
        }
        whenClosed.add(onClosed)
        if (closing) return
        closing = true
        current?.let {
            current = null
            leave(it)
        }
        closeIfDone()
    }

    /**
     * The render process died and the host reads the page again in a new WebView (review v0.1.49 #2): what was asked of
     * the old page will not be answered. Leaving sessions give up (the loop keeps and saves what it has) and end; the
     * session editing now sends nothing until the new page's `ready`, when its body goes in again.
     */
    fun pageLost() {
        if (destroyed) return
        val left = leaving.toList()
        leaving.clear()
        left.forEach { (session, timer) ->
            timer.cancel()
            session.giveUp()
            session.end()
        }
        current?.pageLost()
        closeIfDone()
    }

    /** The render process died and no new page is read (the host destroyed the WebView): what is known stands. */
    fun webViewGone() {
        if (destroyed) return
        destroyed = true
        val left = leaving.toList()
        leaving.clear()
        left.forEach { (session, timer) ->
            timer.cancel()
            session.giveUp()
            session.end()
        }
        current?.giveUp() // the screen goes back to Markdown; it detaches the session then
        runClosed()
    }

    /**
     * A message from the editor: the session it is for (null: none, or the WebView is gone). A `bodyRequested` goes to
     * the session that asked under its `id` (none: dropped — asked before a reload, or given up); without an id (bridge
     * version 1) it answers the oldest request still open — a leaving session's came before anything the next sent.
     */
    fun route(message: WebMessage): EditorSession? {
        if (destroyed) return null
        val id = when (message) {
            is WebMessage.BodyRequested -> message.id
            is WebMessage.BodyUnavailable -> message.id
            else -> return current ?: leaving.lastOrNull()?.first
        }
        if (id != null) return (leaving.map { it.first } + listOfNotNull(current)).firstOrNull { it.waitsFor(id) }
        return leaving.firstOrNull { it.first.awaitingBody }?.first ?: current
    }

    /**
     * After [route]'s session took the message: a leaving session that has its body is done. A page that answered it
     * has no editor (`loaded: false`: it lost it unseen) gets the body of the session editing now again.
     */
    fun delivered(target: EditorSession, message: WebMessage? = null) {
        if (message is WebMessage.BodyUnavailable) current?.takeIf { it.loaded }?.load()
        val entry = leaving.firstOrNull { it.first === target } ?: return
        if (target.awaitingBody) return
        finish(entry)
    }

    private fun leave(session: EditorSession) {
        if (destroyed || !session.loaded) {
            session.giveUp()
            session.end()
            return
        }
        session.requestBody(flush = true)
        if (!session.awaitingBody) {
            session.end()
            return
        }
        lateinit var entry: Pair<EditorSession, CanvasCancel>
        val timer = timers.schedule(graceMs) {
            if (leaving.none { it === entry }) return@schedule
            warn("the editor did not answer requestBody within $graceMs ms: the last body the loop has is kept and saved")
            session.giveUp()
            finish(entry)
        }
        entry = session to timer
        leaving.add(entry)
    }

    private fun finish(entry: Pair<EditorSession, CanvasCancel>) {
        if (!leaving.remove(entry)) return
        entry.second.cancel()
        entry.first.end()
        closeIfDone()
    }

    private fun closeIfDone() {
        if (!closing || destroyed || leaving.isNotEmpty()) return
        destroyed = true
        destroyWebView()
        runClosed()
    }

    private fun runClosed() {
        if (!closing) return
        val callbacks = whenClosed.toList()
        whenClosed.clear()
        callbacks.forEach { it() }
    }

    companion object {
        /** How long a `requestBody` sent while leaving may take before the session gives up (keeping what is known). */
        const val LEAVE_GRACE_MS = 1_000L
    }
}
