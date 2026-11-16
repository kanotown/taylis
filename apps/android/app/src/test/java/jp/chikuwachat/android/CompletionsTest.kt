package jp.chikuwachat.android

import jp.chikuwachat.android.api.CustomEmojiOut
import jp.chikuwachat.android.api.UserPublic
import jp.chikuwachat.android.ui.ComposerFormat.Result
import jp.chikuwachat.android.ui.Completions
import jp.chikuwachat.android.ui.Emoji
import jp.chikuwachat.android.ui.Mentions
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** M187: the `@` and `:` completions the composer and 「メッセージを編集」 share. */
class CompletionsTest {
    private val alice = UserPublic("00000000-0000-7000-8000-000000000001", "alice", "Alice", "member", null, "", "")
    private val users = listOf(alice)
    private fun custom(name: String, label: String? = null, keywords: List<String> = emptyList()) =
        CustomEmojiOut(name, name, "image/png", 64, 64, "u", "", label = label, keywords = keywords)
    private val emoji = listOf(custom("tada-ckw", label = "ちくわ やった"), custom("hpd-bow", label = "おじぎ", keywords = listOf("ありがとう")))
    private fun people(query: String) = Mentions.candidates(query, users)

    @Test fun anAtNameOffersPeopleAndNoEmoji() {
        val hits = Completions.find("確認 @al", emoji, ::people)
        assertEquals(listOf("alice"), hits.mentions.map { it.username })
        assertTrue(hits.emoji.isEmpty())
    }

    @Test fun aColonOffersTheCustomEmojiFirstThenTheStandardOnesEightAtMost() {
        val hits = Completions.find("やった :tad", emoji, { error("no @ typed: the people are not ranked") })
        assertTrue(hits.mentions.isEmpty())
        assertEquals(":tada-ckw:", hits.emoji.first().glyph)
        assertEquals("custom", hits.emoji.first().category)
        assertEquals("ちくわ やった", hits.emoji.first().keywords)
        assertTrue(hits.emoji.drop(1).any { it.glyph == "🎉" })
        assertTrue(Completions.find(":a", emoji, ::people).emoji.isEmpty()) // a standard name needs two letters
        assertEquals(Completions.EMOJI_LIMIT, Completions.find(":sm", emoji, ::people).emoji.size)
        // M100: by label and keyword too.
        assertEquals(":hpd-bow:", Completions.find("：ありがとう", emoji, ::people).emoji.first().glyph)
    }

    @Test fun anAtNameNobodyHasLeavesTheEmojiToTheColon() {
        assertTrue(Completions.find("@zz", emoji, ::people).isEmpty)
        assertTrue(Completions.find("plain text", emoji, ::people).isEmpty)
    }

    /** The edit dialog reads up to the cursor; a selected range offers nothing. */
    @Test fun theTypedTextEndsAtTheCursor() {
        assertEquals("確認 @al", Completions.typed("確認 @al を見て", 6, 6))
        assertEquals("", Completions.typed("確認 @al を見て", 3, 6))
        assertEquals("abc", Completions.typed("abc", 9, 9)) // past the end: the whole text
    }

    @Test fun aCompletionInTheMiddleKeepsTheRest() {
        val text = "確認 @al を見て"
        val at = text.indexOf(" を")
        val done = Completions.mention(text, at, "alice")
        assertEquals("確認 @alice を見て", done.text) // one space: the one after the cursor stays
        assertEquals(Result(done.text, "確認 @alice".length, "確認 @alice".length), done)
        val party = "やった :tad!"
        val glyph = Completions.emoji(party, party.indexOf("!"), "🎉")
        assertEquals("やった 🎉 !", glyph.text)
        assertEquals("やった 🎉 ".length, glyph.start)
    }

    /** At the end (the composer: the whole draft), exactly what Mentions.complete / Emoji.complete give, the cursor after. */
    @Test fun atTheEndItIsTheComposersCompletion() {
        val draft = "確認 @al"
        assertEquals(Result(Mentions.complete(draft, "alice"), "確認 @alice ".length, "確認 @alice ".length), Completions.mention(draft, draft.length, "alice"))
        val party = "やった :tad"
        val done = Emoji.complete(party, ":tada-ckw:")
        assertEquals("やった :tada-ckw: ", done)
        assertEquals(Result(done, done.length, done.length), Completions.emoji(party, party.length, ":tada-ckw:"))
    }
}
