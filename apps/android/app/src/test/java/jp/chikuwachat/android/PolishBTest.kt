package jp.chikuwachat.android

import jp.chikuwachat.android.ui.CameraCapture
import jp.chikuwachat.android.ui.ComposerFormat
import jp.chikuwachat.android.ui.ComposerFormat.Result
import jp.chikuwachat.android.ui.ComposerText
import jp.chikuwachat.android.ui.Mentions
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.nio.file.Files
import java.time.LocalDateTime

/** 仕上げ B (MOBILE_POLISH C2 / C11, MUI-5): the composer's pure parts. The format cases are iOS ComposerFormatTests'. */
class PolishBTest {
    @Test fun inlineStylesWrapTheSelectionOrLeaveTheCursorBetweenTheMarks() {
        assertEquals(Result("今日は**晴れ**", 5, 7), ComposerFormat.BOLD.apply("今日は晴れ", 3, 5))
        assertEquals(Result("run ``", 5, 5), ComposerFormat.CODE.apply("run ", 4, 4))
        assertEquals(Result("~~abc~~", 2, 5), ComposerFormat.STRIKE.apply("abc", 0, 3))
        assertEquals(Result("a__", 2, 2), ComposerFormat.ITALIC.apply("a", 9, 9)) // out of range: at the end
        assertEquals(Result("**ab**c", 2, 4), ComposerFormat.BOLD.apply("abc", 2, 0)) // a selection made backwards
    }

    @Test fun aCodeBlockStartsOnItsOwnLine() {
        assertEquals(Result("見て\n```\n\n```", 7, 7), ComposerFormat.CODE_BLOCK.apply("見て", 2, 2))
        assertEquals(Result("```\nx = 1\n```", 4, 9), ComposerFormat.CODE_BLOCK.apply("x = 1", 0, 5))
    }

    @Test fun aLinkPutsTheCursorWhereTheAddressGoes() {
        assertEquals(Result("[資料](https://)", 13, 13), ComposerFormat.LINK.apply("資料", 0, 2))
        assertEquals(Result("[](https://)", 1, 1), ComposerFormat.LINK.apply("", 0, 0))
    }

    @Test fun lineStylesMarkEveryLineTheSelectionTouches() {
        assertEquals(Result("- 買うもの", 4, 4), ComposerFormat.BULLET.apply("買うもの", 2, 2))
        assertEquals(Result("1. a\n2. b\n3. c", 0, 14), ComposerFormat.NUMBERED.apply("a\nb\nc", 0, 5))
        assertEquals(Result("1. a\n2. b\nc", 0, 9), ComposerFormat.NUMBERED.apply("a\nb\nc", 0, 3)) // the lines it touches
        assertEquals(Result("前置き\n> 引用する", 7, 7), ComposerFormat.QUOTE.apply("前置き\n引用する", 5, 5))
        assertEquals(Result("## 今日の予定", 5, 5), ComposerFormat.HEADING.apply("今日の予定", 2, 2))
    }

    @Test fun thePlaceholderNamesTheConversation() {
        assertEquals("#audit-test へのメッセージ", ComposerText.placeholder("#audit-test", inThread = false))
        assertEquals("山田 花子 へのメッセージ", ComposerText.placeholder("山田 花子", inThread = false)) // a DM: the other's name
        assertEquals("スレッドに返信", ComposerText.placeholder("#audit-test", inThread = true))
        assertEquals("メッセージ", ComposerText.placeholder(null, inThread = false)) // not loaded yet
        assertEquals("メッセージ", ComposerText.placeholder("#", inThread = false))
    }

    @Test fun textGoesInAtTheCursorInPlaceOfTheSelection() {
        assertEquals(Result("ab🎉c", 4, 4), ComposerText.insert("abc", 2, 2, "🎉"))
        assertEquals(Result("a😀", 3, 3), ComposerText.insert("abc", 1, 3, "😀"))
        assertEquals(Result("abc/", 4, 4), ComposerText.insert("abc", 10, 10, "/")) // a stale selection: at the end
    }

    @Test fun theMentionButtonStartsAMentionTheCompletionsSee() {
        val afterWord = ComposerText.mention("thanks", 6, 6)
        assertEquals(Result("thanks @", 8, 8), afterWord)
        assertEquals("", Mentions.query(afterWord.text))
        assertEquals(Result("@", 1, 1), ComposerText.mention("", 0, 0))
        assertEquals(Result("よろしく@", 5, 5), ComposerText.mention("よろしく", 4, 4)) // Japanese before it is fine
        assertEquals("", Mentions.query("よろしく@"))
        assertEquals(Result("a @", 3, 3), ComposerText.mention("a ", 2, 2))
    }

    @Test fun theCameraPhotoIsNamedByTheTimeAndOldOnesAreCleared() {
        assertEquals("photo_20260930_221605.jpg", CameraCapture.fileName(LocalDateTime.of(2026, 9, 30, 22, 16, 5)))
        val cache = Files.createTempDirectory("cache").toFile()
        try {
            val old = File(cache, "camera/photo_old.jpg").apply { parentFile.mkdirs(); writeText("x"); setLastModified(System.currentTimeMillis() - 2 * 86_400_000L) }
            val recent = File(cache, "camera/photo_recent.jpg").apply { writeText("x") }
            val file = CameraCapture.newFile(cache, LocalDateTime.of(2026, 9, 30, 22, 16, 5))
            assertEquals(File(cache, "camera/photo_20260930_221605.jpg"), file)
            assertFalse(old.exists())
            assertTrue(recent.exists()) // may still be uploading
        } finally {
            cache.deleteRecursively()
        }
    }
}
