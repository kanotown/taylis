package jp.chikuwachat.android

import jp.chikuwachat.android.ui.Links
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class LinksTest {
    @Test fun firstLinkOutsideCodeWithTrailingPunctuationTrimmed() {
        assertEquals("https://example.com/a?b=1", Links.first("see https://example.com/a?b=1, then https://other.test"))
        assertEquals("https://example.com/x", Links.first("日本語の文 https://example.com/x。"))
        assertEquals("https://example.com/paren", Links.first("(https://example.com/paren)"))
        assertNull(Links.first("`https://code.example.com` and ```\nhttps://fenced.example.com\n``` none"))
        assertNull(Links.first("no links here"))
        assertEquals("https://example.com/md", Links.first("[label](https://example.com/md)"))
    }
}
