package jp.chikuwachat.android

import jp.chikuwachat.android.ui.keywordRanges
import org.junit.Assert.assertEquals
import org.junit.Test

class SearchHighlightTest {
    @Test fun findsEveryOccurrenceCaseInsensitivelyAndMergesOverlaps() {
        assertEquals(listOf(0 to 5, 12 to 17), keywordRanges("Tokyo rain, tokyo sun", listOf("tokyo")))
        assertEquals(listOf(0 to 5), keywordRanges("東京の天気", listOf("東京", "の天", "天気")))
        assertEquals(emptyList<Pair<Int, Int>>(), keywordRanges("nothing", listOf("", "zzz")))
    }
}
