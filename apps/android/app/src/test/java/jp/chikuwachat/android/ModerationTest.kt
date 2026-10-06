package jp.chikuwachat.android

import jp.chikuwachat.android.api.BootstrapOut
import jp.chikuwachat.android.api.Codec
import jp.chikuwachat.android.sync.MessageState
import jp.chikuwachat.android.sync.Store
import jp.chikuwachat.android.ui.Moderation
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** M104 (docs/MODERATION.md): 「報告する」's offer, the folded rows of blocked people, the block list from the bootstrap. */
class ModerationTest {
    private fun message(sender: String, pending: Boolean = false, deleted: Boolean = false, type: String = "user") = MessageState(
        id = "m-1", channelId = "ch", senderId = sender, seq = if (pending) null else 1, updatedSeq = 1, clientMsgId = "c-1",
        body = "hi", createdAt = "2026-10-05T00:00:00Z", deleted = deleted, pending = pending, type = type,
    )

    @Test fun reportIsOfferedOnSomeoneElsesStoredMessage() {
        assertTrue(Moderation.canReport(message("bob"), "alice"))
        assertFalse(Moderation.canReport(message("alice"), "alice"))
        assertFalse(Moderation.canReport(message("bob", pending = true), "alice"))
        assertFalse(Moderation.canReport(message("bob", deleted = true), "alice"))
        assertFalse(Moderation.canReport(message("bob", type = "system"), "alice"))
        assertEquals(listOf("child_safety", "spam", "harassment", "inappropriate", "other"), Moderation.reasons.map { it.first })
    }

    @Test fun aBlockedSendersRowFoldsUntilShown() {
        assertFalse(Moderation.folds(message("bob"), emptySet(), shown = false))
        assertTrue(Moderation.folds(message("bob"), setOf("bob"), shown = false))
        assertFalse(Moderation.folds(message("bob"), setOf("bob"), shown = true))
        assertFalse(Moderation.folds(message("bob", deleted = true), setOf("bob"), shown = false))
    }

    @Test fun storeKeepsTheBlockList() {
        val store = Store()
        store.replaceBlocked(listOf("bob", "carol"))
        assertTrue(store.isBlocked("bob"))
        store.setBlocked("bob", false)
        assertFalse(store.isBlocked("bob"))
        assertEquals(setOf("carol"), store.blockedUsers.toSet())
    }

    @Test fun bootstrapCarriesTheBlockListAndToleratesItsAbsence() {
        val base = """
            {"server_time":"2026-10-05T00:00:00Z",
             "me":{"id":"u","username":"bob","display_name":"Bob","role":"member","created_at":"","updated_at":"","must_change_password":false},
             "users":[],"channels":[],"limits":{"max_message_length":1,"max_attachment_bytes":1,"max_attachments_per_message":1}
        """.trimIndent()
        val with = Codec.snake.decodeFromString(BootstrapOut.serializer(), "$base,\"blocked_user_ids\":[\"x\"]}")
        assertEquals(listOf("x"), with.blockedUserIds)
        val without = Codec.snake.decodeFromString(BootstrapOut.serializer(), "$base}")
        assertEquals(emptyList<String>(), without.blockedUserIds)
    }
}
