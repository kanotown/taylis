package jp.chikuwachat.android

import jp.chikuwachat.android.api.Codec
import jp.chikuwachat.android.api.MessageOut
import jp.chikuwachat.android.sync.MessageState
import jp.chikuwachat.android.sync.toOut
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** The wire and persisted shapes of a message keep every field the UI needs. */
class MessageCodingTest {
    private val wire = """
        {"id": "m2", "channel_id": "c1", "sender_id": "u1", "parent_id": "m1", "also_in_channel": true, "seq": 7, "updated_seq": 8,
         "client_msg_id": null, "type": "user", "body": "📊 どこにする?", "mentioned_user_ids": [], "mention_all": false, "reactions": [],
         "attachments": [], "reply_count": 0, "last_reply_at": null, "created_at": "2026-09-27T04:00:00Z", "edited_at": null, "deleted": false,
         "pinned_at": null, "pinned_by": null,
         "poll": {"question": "どこにする?", "options": ["焼き鳥", "中華"], "multiple": false, "closed_at": null, "votes": [["u1"], []]}}
    """.trimIndent()

    @Test fun pollAndSharedReplySurviveDecodingPersistenceAndConversion() {
        val message = Codec.snake.decodeFromString(MessageOut.serializer(), wire)
        assertTrue(message.alsoInChannel)
        assertEquals(listOf("焼き鳥", "中華"), message.poll?.options)

        val state = MessageState.from(message)
        assertTrue(state.inTimeline)
        val persisted = Codec.plain.decodeFromString(MessageState.serializer(), Codec.plain.encodeToString(MessageState.serializer(), state))
        assertEquals(message.poll, persisted.poll)
        assertTrue(persisted.alsoInChannel)
        assertEquals(message.poll, persisted.toOut()?.poll) // thread rows built from the timeline keep the poll
        assertEquals(true, persisted.toOut()?.alsoInChannel)
    }
}
