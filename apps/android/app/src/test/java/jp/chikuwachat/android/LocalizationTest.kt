package jp.chikuwachat.android

import java.util.Locale
import jp.chikuwachat.android.app.LanguageSync
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** docs/I18N.md: every UI string exists in Japanese (values/), English and Simplified Chinese, with the same placeholders. */
class LocalizationTest {
    private val ja = XmlStrings.load("values")
    private val en = XmlStrings.load("values-en")
    private val zh = XmlStrings.load("values-b+zh+Hans")
    private val fixed = XmlStrings.untranslatable()
    private val placeholder = Regex("""%(\d+\$)?[-#+ 0,(]*\d*(\.\d+)?[sdfx]""")

    private fun placeholders(text: String): List<String> = placeholder.findAll(text).map { it.value }.sorted().toList()

    @Test
    fun everyStringIsInEveryLanguage() {
        val keys = ja.strings.keys - fixed
        assertTrue("values/ has the UI strings", keys.size > 1000)
        for ((name, table) in listOf("en" to en, "zh-Hans" to zh)) {
            val missing = keys - table.strings.keys
            assertTrue("$name lacks ${missing.take(20)}", missing.isEmpty())
            val extra = table.strings.keys - ja.strings.keys
            assertTrue("$name has strings values/ does not: ${extra.take(20)}", extra.isEmpty())
            val untranslatedFixed = fixed intersect table.strings.keys
            assertTrue("$name translates fixed strings $untranslatedFixed", untranslatedFixed.isEmpty())
        }
    }

    @Test
    fun everyPluralIsInEveryLanguage() {
        for ((name, table) in listOf("en" to en, "zh-Hans" to zh)) {
            assertEquals("$name plurals", ja.plurals.keys, table.plurals.keys)
        }
        for ((key, items) in en.plurals) {
            assertTrue("en $key needs one and other", items.keys.containsAll(listOf("one", "other")))
        }
        for ((key, items) in ja.plurals) assertTrue("ja $key needs other", "other" in items)
        for ((key, items) in zh.plurals) assertTrue("zh $key needs other", "other" in items)
    }

    @Test
    fun translationsKeepThePlaceholders() {
        for ((key, text) in ja.strings) {
            val expected = placeholders(text)
            for ((name, table) in listOf("en" to en, "zh-Hans" to zh)) {
                val other = table.strings[key] ?: continue
                assertEquals("$name $key: $other", expected, placeholders(other))
            }
        }
        for ((key, items) in ja.plurals) {
            val expected = placeholders(items.getValue("other"))
            for ((name, table) in listOf("en" to en, "zh-Hans" to zh)) {
                val other = table.plurals[key]?.get("other") ?: continue
                assertEquals("$name $key: $other", expected, placeholders(other))
            }
        }
    }

    @Test
    fun noTranslationIsEmptyOrStillJapanese() {
        val kana = Regex("[\\u3040-\\u30ff]")
        for ((key, text) in en.strings) {
            assertTrue("en $key is empty", text.isNotBlank() || key in EN_BLANK_ALLOWED)
            // English has no kana (a few examples quote Japanese on purpose: a reading, a command word).
            if (kana.containsMatchIn(text)) assertTrue("en $key still has kana: $text", key in EN_KANA_ALLOWED)
        }
        for ((key, text) in zh.strings) {
            if (kana.containsMatchIn(text)) assertTrue("zh $key still has kana: $text", key in ZH_KANA_ALLOWED)
        }
    }

    @Test
    fun theDefaultResolverReadsJapanese() {
        assertEquals("ja", L10n.language)
        assertEquals("閉じる", L10n.str(R.string.common_close))
        assertEquals("ほか 3 箇所", L10n.str(R.string.canvas_pane_more, 3))
        assertEquals("2 人を追加しました", L10n.plural(R.plurals.app_controller_added_people, 2, 2))
    }

    @Test
    fun languagesResolveToTheSupportedOnes() {
        assertEquals("ja", L10n.languageOf(listOf(Locale.JAPAN)))
        assertEquals("en", L10n.languageOf(listOf(Locale.forLanguageTag("en-GB"))))
        assertEquals("zh-Hans", L10n.languageOf(listOf(Locale.forLanguageTag("zh-CN"))))
        assertEquals("zh-Hans", L10n.languageOf(listOf(Locale.forLanguageTag("zh-Hans-SG"))))
        // Traditional Chinese has no translation: the next language in the list, else Japanese.
        assertEquals("en", L10n.languageOf(listOf(Locale.forLanguageTag("zh-TW"), Locale.US)))
        assertEquals("ja", L10n.languageOf(listOf(Locale.FRANCE)))
        assertEquals("zh-Hans", AppLanguage.normalize("zh-Hans-CN"))
        assertEquals("en", AppLanguage.normalize("en-US"))
        assertNull(AppLanguage.normalize("zh-Hant"))
        assertNull(AppLanguage.normalize("fr"))
    }

    @Test
    fun weekdayNamesFollowTheLanguage() {
        assertEquals(listOf("月", "火", "水", "木", "金", "土", "日"), L10n.weekdaysMondayFirst)
        assertEquals("日", L10n.weekdaysSundayFirst.first())
    }

    @Test
    fun theLanguageFollowsWhicheverSideChanged() {
        val synced = { value: String? -> LanguageSync.Synced(value) }
        // First contact: the server's earlier choice wins; else this device's goes up; agreeing ones are only recorded.
        assertEquals(LanguageSync.Step.Apply("en"), LanguageSync.decide(null, "en", null))
        assertEquals(LanguageSync.Step.Push, LanguageSync.decide("zh-Hans", null, null))
        assertEquals(LanguageSync.Step.Record, LanguageSync.decide(null, null, null))
        assertEquals(LanguageSync.Step.Record, LanguageSync.decide("en", "en", null))
        // Changed here (offline, or in the system's per-app setting): sent up, whatever the server says.
        assertEquals(LanguageSync.Step.Push, LanguageSync.decide("en", "ja", synced("ja")))
        assertEquals(LanguageSync.Step.Push, LanguageSync.decide(null, "ja", synced("ja")))
        // Changed on another device: applied here (null = back to the device's language).
        assertEquals(LanguageSync.Step.Apply("zh-Hans"), LanguageSync.decide("ja", "zh-Hans", synced("ja")))
        assertEquals(LanguageSync.Step.Apply(null), LanguageSync.decide("en", null, synced("en")))
        assertEquals(LanguageSync.Step.None, LanguageSync.decide("en", "en", synced("en")))
    }

    private companion object {
        val EN_KANA_ALLOWED = setOf("you_screens_e_g", "commands_post_with")
        // 「2 週間ごと」: English says it before the number ("Every 2 weeks"), so nothing follows.
        val EN_BLANK_ALLOWED = setOf("calendar_event_form_every_suffix")
        val ZH_KANA_ALLOWED = setOf("you_screens_e_g", "commands_post_with")
    }
}
