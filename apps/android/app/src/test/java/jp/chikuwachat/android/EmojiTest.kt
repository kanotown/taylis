package jp.chikuwachat.android

import jp.chikuwachat.android.ui.Emoji
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class EmojiTest {
    @Test fun replacesKnownShortcodesOnly() {
        assertEquals("done 🎉 👍", Emoji.replaceShortcodes("done :tada: :+1:"))
        assertEquals("time is 10:30 and :unknown_thing: stays", Emoji.replaceShortcodes("time is 10:30 and :unknown_thing: stays"))
        assertEquals("no colons", Emoji.replaceShortcodes("no colons"))
        assertEquals("🍱", Emoji.byShortcode("bento")?.glyph)
    }

    @Test fun queryAndCompletion() {
        assertEquals("ta", Emoji.query("hello :ta"))
        assertNull(Emoji.query("hello :t"))
        assertNull(Emoji.query("10:30"))
        assertEquals("sm", Emoji.query("(:sm"))
        assertNull(Emoji.query("hello :tada: done"))
        assertEquals("hi 🎉 ", Emoji.complete("hi :tad", "🎉"))
        assertTrue(Emoji.candidates("ta").first().shortcode.startsWith("ta"))
        assertEquals("🍱", Emoji.candidates("弁当").first().glyph)
        assertTrue(Emoji.search("").size > 200)
        assertTrue(Emoji.search("乾杯").map { it.glyph }.contains("🍻"))
    }
}
