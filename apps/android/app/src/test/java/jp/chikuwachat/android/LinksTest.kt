package jp.chikuwachat.android

import jp.chikuwachat.android.api.AiAgentPublic
import jp.chikuwachat.android.api.AiStatusOut
import androidx.compose.ui.platform.UriHandler
import jp.chikuwachat.android.ui.LinkPreviewPolicy
import jp.chikuwachat.android.ui.Links
import jp.chikuwachat.android.ui.SafeLinks
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
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

    @Test fun siteLabelIsTheSiteNameAsGivenElseTheHost() {
        assertEquals("GitHub", Links.siteLabel("GitHub", "https://github.com/a/b"))
        assertEquals("example.com", Links.siteLabel(null, "https://example.com/page?x=1"))
        assertEquals("www.example.com", Links.siteLabel("  ", "https://www.example.com/"))
        assertNull(Links.siteLabel(null, "not a url"))
    }

    // Review v0.1.18 #5: an AI bot's reply never fetches its link preview by itself.
    private val status = AiStatusOut(available = true, agents = listOf(AiAgentPublic("a1", botUserId = "ai-bot", name = "Chikuwa AI")))

    @Test fun anAiBotsLinkIsNotPreviewedByItself() {
        assertFalse(LinkPreviewPolicy.autoLoads("ai-bot", "bot", status))
        assertFalse(LinkPreviewPolicy.autoLoads("ai-bot", null, status)) // the user row not loaded yet: the status decides
    }

    @Test fun aPersonsAndAWebhooksLinksArePreviewed() {
        assertTrue(LinkPreviewPolicy.autoLoads("alice", "member", status))
        assertFalse(LinkPreviewPolicy.autoLoads("hook", "bot", status)) // any bot waits for a tap (same on all clients)
        assertTrue(LinkPreviewPolicy.autoLoads("alice", "member", AiStatusOut())) // a server without AI
        assertTrue(LinkPreviewPolicy.autoLoads("alice", "member", null))
        assertTrue(LinkPreviewPolicy.autoLoads("alice", null, null))
    }

    @Test fun anyBotWaitsWhileTheAiStatusIsNotRead() {
        assertFalse(LinkPreviewPolicy.autoLoads("ai-bot", "bot", null))
        assertFalse(LinkPreviewPolicy.autoLoads("hook", "bot", null))
        // M98: a channel's feed bot loads its cards by itself; another kind of bot and an AI agent never do.
        assertTrue(LinkPreviewPolicy.autoLoads("rss", "bot", null, "feed"))
        assertTrue(LinkPreviewPolicy.autoLoads("rss", "bot", status, "feed"))
        assertFalse(LinkPreviewPolicy.autoLoads("hook", "bot", status, "other"))
        assertFalse(LinkPreviewPolicy.autoLoads("ai-bot", "bot", status, "feed"))
    }

    /**
     * 2026-11-16 (a hostile-server review): a URL from the server (a pinned link, a URL cell, a call's room, a preview's
     * picture) opens only over http(s) (mailto where the screen means an address); intent:, file:, content: and other
     * apps' schemes never reach ACTION_VIEW.
     */
    @Test fun onlyWebAddressesOpen() {
        for (url in listOf("https://example.com", "HTTP://example.com/a", "https://meet.jit.si/room-1")) {
            assertTrue(url, SafeLinks.isWeb(url))
            assertTrue(url, SafeLinks.canOpen(url, mail = true))
        }
        for (url in listOf(
            "intent://scan/#Intent;scheme=zxing;package=com.example;end", "file:///data/data/jp.chikuwachat.android/shared_prefs/a.xml",
            "content://jp.chikuwachat.android.files/x", "javascript:alert(1)", "jar:file:///a!/b", "ftp://example.com/x",
            "market://details?id=x", "tel:123", "https:example.com", "https://", " https://example.com", "", "example.com",
        )) {
            assertFalse(url, SafeLinks.isWeb(url))
            assertFalse(url, SafeLinks.canOpen(url, mail = true))
        }
        assertFalse(SafeLinks.isWeb("mailto:lab@example.ac.jp"))
        assertTrue(SafeLinks.canOpen("mailto:lab@example.ac.jp", mail = true))
        val opened = ArrayList<String>()
        val handler = object : UriHandler { override fun openUri(uri: String) { opened += uri } }
        assertFalse(SafeLinks.open(handler, "intent://x#Intent;end"))
        assertTrue(SafeLinks.open(handler, "https://example.com/a"))
        assertEquals(listOf("https://example.com/a"), opened)
        val failing = object : UriHandler { override fun openUri(uri: String) = throw IllegalStateException("no browser") }
        assertFalse(SafeLinks.open(failing, "https://example.com/a"))
    }
}
