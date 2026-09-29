package jp.chikuwachat.android

import androidx.compose.runtime.saveable.SaverScope
import jp.chikuwachat.android.platform.NotificationPermission
import jp.chikuwachat.android.sync.EngineStatus
import jp.chikuwachat.android.sync.MessageState
import jp.chikuwachat.android.sync.ReadAnchor
import jp.chikuwachat.android.sync.Store
import jp.chikuwachat.android.ui.ComposerLayout
import jp.chikuwachat.android.ui.ReadAnchorSaver
import jp.chikuwachat.android.ui.Timeline
import jp.chikuwachat.android.ui.TouchTarget
import jp.chikuwachat.android.ui.UnreadFilter
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** M28c: the pure parts of the Android audit fixes. */
class AndroidAuditTest {
    @Test fun theNotificationPermissionIsAskedOncePerDeviceOnAndroid13() {
        val prefs = MemoryStore()
        assertFalse(NotificationPermission.shouldAsk(prefs, sdk = 26, granted = false)) // before 13 there is nothing to ask
        assertFalse(NotificationPermission.shouldAsk(prefs, sdk = 34, granted = true))
        assertTrue(NotificationPermission.shouldAsk(prefs, sdk = 34, granted = false))
        NotificationPermission.markAsked(prefs)
        assertFalse(NotificationPermission.shouldAsk(prefs, sdk = 34, granted = false)) // refused: the settings show the way
    }

    @Test fun theUnreadFilterIsKeptOnTheDevice() {
        val prefs = MemoryStore()
        assertFalse(UnreadFilter.read(prefs))
        UnreadFilter.write(prefs, true)
        assertTrue(UnreadFilter.read(prefs))
        UnreadFilter.write(prefs, false)
        assertFalse(UnreadFilter.read(prefs))
        assertNull(prefs.values["sidebar.unreadOnly"]) // off leaves no key behind
    }

    @Test fun theComposerFoldsItsButtonsBelow460dp() {  // 400 until M30 added the template button
        assertTrue(ComposerLayout.compact(360f))
        assertTrue(ComposerLayout.compact(411f))
        assertTrue(ComposerLayout.compact(459f))
        assertFalse(ComposerLayout.compact(460f))
        assertFalse(ComposerLayout.compact(600f))
    }

    @Test fun anEmptyConversationSaysWhetherItsFirstPageIsOnItsWay() {
        assertEquals(Timeline.FirstPage.LOADING, Timeline.firstPage(null, EngineStatus.CONNECTING))
        assertEquals(Timeline.FirstPage.LOADING, Timeline.firstPage(null, EngineStatus.ONLINE))
        assertEquals(Timeline.FirstPage.OFFLINE, Timeline.firstPage(null, EngineStatus.OFFLINE))
        assertEquals(Timeline.FirstPage.EMPTY, Timeline.firstPage(0, EngineStatus.OFFLINE)) // a page came once: truly empty
        assertEquals(Timeline.FirstPage.EMPTY, Timeline.firstPage(12, EngineStatus.ONLINE))
    }

    @Test fun theReadAnchorSurvivesARecreationWithoutItsLanding() {
        val scope = SaverScope { true }
        val anchor = ReadAnchor(anchored = true, landing = true, readSeq = 130, held = 125, quiet = setOf("a", "b"))
        val saved = with(ReadAnchorSaver) { scope.save(anchor) }!!
        assertEquals(anchor.copy(landing = false), ReadAnchorSaver.restore(saved))
        val plain = ReadAnchor(readSeq = 7)
        assertEquals(plain, ReadAnchorSaver.restore(with(ReadAnchorSaver) { scope.save(plain) }!!))
        val emptyQuiet = ReadAnchor(quiet = emptySet())
        assertEquals(emptyQuiet, ReadAnchorSaver.restore(with(ReadAnchorSaver) { scope.save(emptyQuiet) }!!))
    }

    @Test fun aTouchTargetGrowsToTheMinimumWithinTheConstraints() {
        assertEquals(48, TouchTarget.grown(visible = 26, min = 48, max = 1000))
        assertEquals(60, TouchTarget.grown(visible = 60, min = 48, max = 1000)) // already large enough
        assertEquals(40, TouchTarget.grown(visible = 26, min = 48, max = 40)) // never beyond the constraints
        assertEquals(-11, TouchTarget.offset(26, 48)) // the grown node overflows the visible one on both sides
        assertEquals(11, TouchTarget.offset(48, 26)) // the visible control is centred in the grown node
    }

    @Test fun aQuietDraftWriteKeepsTheDraftWithoutAVersionBump() {
        val persistence = MemoryPersistence()
        val store = Store(persistence)
        val edited = ArrayList<String>()
        store.onDraftEdited = { channelId, parentId -> edited.add("$channelId:${parentId ?: ""}") }
        val before = store.version.value
        store.setDraft("c1", quiet = true) { it.copy(text = "typed") }
        assertEquals(before, store.version.value)
        assertEquals("typed", store.draft("c1").text)
        assertTrue(store.draft("c1").dirty)
        assertTrue(persistence.meta.getValue("draft:c1:").contains("typed")) // persisted like any draft
        assertEquals(listOf("c1:"), edited) // the sync still saves it after the pause
        store.notifyChanged()
        assertEquals(before + 1, store.version.value)
        store.setDraft("c1") { it.copy(text = "") }
        assertEquals(before + 2, store.version.value) // a plain write bumps as before
    }

    @Test fun heldRowsCountPendingOnesTowardsTheTrim() { // §7.7, like the desktop and iOS
        val store = Store()
        val row = MessageState(id = "m1", channelId = "c1", senderId = "u1", seq = 1, updatedSeq = 1, clientMsgId = null, body = "one", createdAt = "2026-09-29T00:00:00Z")
        store.upsertMessage(row)
        assertEquals(1, store.heldCount("c1"))
        store.putPlaceholder(MessageState.placeholder("k1", "c1", "me", "two", "2026-09-29T00:00:01Z", null, false, null, false))
        assertEquals(2, store.heldCount("c1"))
    }
}
