package jp.chikuwachat.android

import jp.chikuwachat.android.api.Codec
import jp.chikuwachat.android.api.UserMe
import jp.chikuwachat.android.platform.PushMessage
import jp.chikuwachat.android.ui.ActivitySegment
import jp.chikuwachat.android.ui.MainNav
import jp.chikuwachat.android.ui.MainTab
import jp.chikuwachat.android.ui.MainTabs
import jp.chikuwachat.android.ui.Route
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** M192 (PUSH_NOTIFICATIONS.md §18): the summary push of the mentions and DMs that quiet hours or a pause held back. */
class DigestPushTest {
    @Test fun theSummaryHasNoConversationAndIsShownOnItsOwnKey() {
        val push = PushMessage.parse(
            mapOf(
                "kind" to "digest", "workspace_id" to "w1", "title" to "通知を止めていた間に",
                "body" to "メンション 3 件：田中 一郎、高橋 健太 ほか（#研究ミーティング、DM）", "badge" to "3", "collapse_key" to "digest",
            ),
        )!!
        assertTrue(push.isDigest)
        assertNull(push.channelId)
        assertTrue(push.shown)
        assertEquals("digest", push.notificationKey) // the next summary replaces it; a read of a conversation keeps it
        assertEquals("通知を止めていた間に", push.displayTitle)
        assertEquals(3, push.badge)
        assertNull(push.conversation) // a plain notification, not a person's message
        assertNull(push.lendingTarget)
        // Without the server's key, still one at a time.
        assertEquals("digest", PushMessage.parse(mapOf("kind" to "digest", "title" to "t", "body" to "b"))!!.notificationKey)
        assertFalse(PushMessage.parse(mapOf("kind" to "message", "channel_id" to "c1"))!!.isDigest)
    }

    @Test fun aTapLandsOnTheActivityTabAtItsRoot() {
        val start = MainTabs.selectSegment(MainTabs.tap(MainTabs.initial, MainTab.ACTIVITY).state, ActivitySegment.REACTIONS)
        val reading = MainTabs.update(start.copy(selected = MainTab.ACTIVITY)) { MainNav.openConversation(it, "c1") }
        val onHome = reading.copy(selected = MainTab.HOME)
        val landed = MainTabs.landActivity(onHome)
        assertEquals(MainTab.ACTIVITY, landed.selected)
        assertEquals(listOf(Route.Activity(ActivitySegment.ALL)), MainTabs.stack(landed))
        // The home tab's stack stays as it was.
        assertEquals(MainTabs.stack(onHome, MainTab.HOME), MainTabs.stack(landed, MainTab.HOME))
    }

    @Test fun userMeCarriesTheSettingFromM192On() {
        val base = """"id":"u1","username":"kano","display_name":"Kano","role":"member","created_at":"","updated_at":"","must_change_password":false"""
        assertNull(Codec.snake.decodeFromString(UserMe.serializer(), "{$base}").notifyDigest)
        assertEquals(false, Codec.snake.decodeFromString(UserMe.serializer(), "{$base,\"notify_digest\":false}").notifyDigest)
    }
}
