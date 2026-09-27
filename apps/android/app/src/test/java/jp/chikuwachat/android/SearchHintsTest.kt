package jp.chikuwachat.android

import jp.chikuwachat.android.ui.SearchHints
import org.junit.Assert.assertEquals
import org.junit.Test

class SearchHintsTest {
    @Test fun appendsAModifierOnce() { // M15h
        assertEquals("has:file ", SearchHints.append("", "has:file"))
        assertEquals("仕様 has:link ", SearchHints.append("仕様  ", "has:link"))
        assertEquals("仕様 has:link ", SearchHints.append("仕様 has:link ", "has:link"))
        assertEquals("仕様 from:@", SearchHints.append("仕様", "from:@"))
    }
}
