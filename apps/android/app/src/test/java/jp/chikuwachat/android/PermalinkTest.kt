package jp.chikuwachat.android

import jp.chikuwachat.android.ui.Permalink
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

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
}
