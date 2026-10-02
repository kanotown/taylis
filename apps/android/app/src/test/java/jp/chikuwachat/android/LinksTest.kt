package jp.chikuwachat.android

import jp.chikuwachat.android.api.AiAgentPublic
import jp.chikuwachat.android.api.AiStatusOut
import jp.chikuwachat.android.ui.LinkPreviewPolicy
import jp.chikuwachat.android.ui.Links
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
    }
}
