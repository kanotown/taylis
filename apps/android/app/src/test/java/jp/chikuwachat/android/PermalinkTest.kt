package jp.chikuwachat.android

import jp.chikuwachat.android.api.Codec
import jp.chikuwachat.android.ui.MessageLinkContext
import jp.chikuwachat.android.ui.Permalink
import jp.chikuwachat.android.ui.PermalinkJump
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class PermalinkTest {
    private val id = "01a0df3f-14b2-7d1a-8759-53c8a8d8a198"

    @Test fun buildsWithoutDoublingSlashes() {
        assertEquals("https://chat.example.com/m/$id", Permalink.url("https://chat.example.com/", id))
        assertEquals("http://10.0.2.2:8000/m/$id", Permalink.url("http://10.0.2.2:8000", id))
    }

    @Test fun recognisesOnlyOurServerAndWellFormedIds() {
        assertEquals(id, Permalink.messageId("https://chat.example.com", "https://chat.example.com/m/$id"))
        assertEquals(id, Permalink.messageId("https://chat.example.com/", "HTTPS://CHAT.EXAMPLE.COM/m/${id.uppercase()}?x=1#y"))
        assertEquals(id, Permalink.messageId("https://chat.example.com", "https://chat.example.com/m/$id/extra"))
        assertNull(Permalink.messageId("https://chat.example.com", "https://chat.example.com/m/not-an-id"))
        assertNull(Permalink.messageId("https://chat.example.com", "https://other.example.com/m/$id"))
        assertNull(Permalink.messageId("https://chat.example.com", "https://chat.example.com/files/$id"))
    }

    @Test fun recognisesEventLinksTheSameWay() {
        assertEquals("https://chat.example.com/e/$id", Permalink.eventUrl("https://chat.example.com/", id))
        assertEquals(id, Permalink.eventId("https://chat.example.com", "https://chat.example.com/e/$id"))
        assertEquals(id, Permalink.eventId("https://chat.example.com/", "HTTPS://CHAT.EXAMPLE.COM/e/${id.uppercase()}?x=1#y"))
        assertEquals(id, Permalink.eventId("https://chat.example.com", "https://chat.example.com/e/$id#top"))
        assertNull(Permalink.eventId("https://chat.example.com", "https://chat.example.com/e/not-an-id"))
        assertNull(Permalink.eventId("https://chat.example.com", "https://other.example.com/e/$id"))
        // Each kind of link is only its own.
        assertNull(Permalink.eventId("https://chat.example.com", "https://chat.example.com/m/$id"))
        assertNull(Permalink.messageId("https://chat.example.com", "https://chat.example.com/e/$id"))
        assertNull(Permalink.canvasId("https://chat.example.com", "https://chat.example.com/e/$id"))
    }

    /** User report 2026-10-21: a link to another message of the open thread scrolls the thread there. */
    @Test fun aLinkInsideTheOpenThreadStaysInIt() {
        val thread = MessageLinkContext.Thread("c1", "p1")
        assertEquals(PermalinkJump.Thread("p1"), PermalinkJump.of("c1", "r9", "p1", thread)) // an older or newer reply
        assertEquals(PermalinkJump.Thread("p1"), PermalinkJump.of("c1", "p1", null, thread)) // its parent
        assertEquals(PermalinkJump.Open, PermalinkJump.of("c1", "r2", "p2", thread)) // another thread
        assertEquals(PermalinkJump.Open, PermalinkJump.of("c1", "m1", null, thread)) // a top-level message
        assertEquals(PermalinkJump.Open, PermalinkJump.of("c2", "r9", "p1", thread)) // another conversation
    }

    @Test fun aLinkInsideTheTimelineStaysInIt() {
        val timeline = MessageLinkContext.Timeline("c1")
        assertEquals(PermalinkJump.Timeline, PermalinkJump.of("c1", "m1", null, timeline))
        assertEquals(PermalinkJump.Open, PermalinkJump.of("c1", "r1", "p1", timeline)) // a reply opens its thread
        assertEquals(PermalinkJump.Open, PermalinkJump.of("c2", "m1", null, timeline))
        assertEquals(PermalinkJump.Open, PermalinkJump.of("c1", "m1", null, null)) // a canvas, the search
    }

    /**
     * 2026-11-05: links to the server's things as every client recognises them (apps/shared/message-links.json): http and
     * https alike, the default port written out or not, the server's path, the UUID then the end or `/` `?` `#`.
     */
    @Test fun theSharedLinkCases() {
        val file = File("../../shared/message-links.json")
        check(file.isFile) { "apps/shared/message-links.json not found from ${File("").absolutePath}" }
        val cases = Codec.plain.parseToJsonElement(file.readText()).jsonObject["cases"]!!.jsonArray
        assertTrue(cases.size > 20)
        for (case in cases) {
            val c = case.jsonObject
            val name = c["name"]!!.jsonPrimitive.content
            val base = c["base"]!!.jsonPrimitive.content
            val url = c["url"]!!.jsonPrimitive.content
            val expected = c["id"]!!.takeUnless { it is JsonNull }?.jsonPrimitive?.content
            val actual = when (val kind = c["kind"]!!.jsonPrimitive.content) {
                "m" -> Permalink.messageId(base, url)
                "c" -> Permalink.canvasId(base, url)
                "p" -> Permalink.pageId(base, url)
                "e" -> Permalink.eventId(base, url)
                "d" -> Permalink.driveId(base, url)
                "eq" -> Permalink.equipmentId(base, url)
                else -> error("unknown kind $kind")
            }
            assertEquals(name, expected, actual)
        }
    }
}
