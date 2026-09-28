package jp.chikuwachat.android

import jp.chikuwachat.android.ui.PollForm
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** The poll form's checks, the same words and rules as the desktop's pollProblem. */
class PollFormTest {
    @Test fun checksTheQuestionAndTheOptions() {
        assertEquals("質問を入れてください", PollForm.problem("", listOf("a", "b")))
        assertEquals("選択肢を 2 つ以上入れてください", PollForm.problem("いつ？", listOf("月曜", " ")))
        assertEquals("同じ選択肢が重なっています", PollForm.problem("いつ？", listOf("月曜", "月曜 ")))
        assertNull(PollForm.problem("いつ？", listOf("月曜", "火曜", ""))) // blank rows are left out
    }
}
