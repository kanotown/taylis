package jp.chikuwachat.android

import jp.chikuwachat.android.api.PollOut
import jp.chikuwachat.android.ui.PollForm
import jp.chikuwachat.android.ui.pollHidesBody
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The poll form's checks, the same words and rules as the desktop's pollProblem. */
class PollFormTest {
    @Test fun checksTheQuestionAndTheOptions() {
        assertEquals("質問を入れてください", PollForm.problem("", listOf("a", "b")))
        assertEquals("選択肢を 2 つ以上入れてください", PollForm.problem("いつ？", listOf("月曜", " ")))
        assertEquals("同じ選択肢が重なっています", PollForm.problem("いつ？", listOf("月曜", "月曜 ")))
        assertNull(PollForm.problem("いつ？", listOf("月曜", "火曜", ""))) // blank rows are left out
    }

    @Test fun thePollsTextIsLeftOutWhenTheServerMadeItFromTheQuestion() { // testers, 2026-09-29: the question twice
        val poll = PollOut("ランチはどこ?", listOf("そば", "カレー"))
        assertTrue(pollHidesBody("📊 ランチはどこ?", poll))
        assertFalse(pollHidesBody("明日のランチを決めたいです", poll)) // written by the author
        assertFalse(pollHidesBody("📊 ランチはどこ?", null))
    }
}
