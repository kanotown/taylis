package jp.chikuwachat.android

import android.content.res.Resources
import androidx.annotation.PluralsRes
import androidx.annotation.StringRes
import java.time.DayOfWeek
import java.time.format.TextStyle
import java.util.Locale
import java.util.ServiceLoader

/**
 * The UI text outside composition (docs/I18N.md): ViewModels, controllers, pure rule objects and notifications read
 * their strings here instead of from a Context. Composables use `stringResource`.
 *
 * The app installs an Android [Resolver] at start (and again when the language changes); JVM unit tests have no
 * Android resources and get one through [ServiceLoader] (the test source set parses res/values*.xml), so a test reads
 * the Japanese default text the same way the app does.
 */
object L10n {
    /** The languages the UI is translated into (BCP-47), the server's `locale` values. Japanese is the default. */
    val SUPPORTED = listOf("ja", "en", "zh-Hans")
    const val DEFAULT = "ja"

    interface Resolver {
        fun string(@StringRes id: Int): String
        fun plural(@PluralsRes id: Int, count: Int): String
        /** The effective UI language: one of [SUPPORTED]. */
        val language: String
    }

    @Volatile private var resolver: Resolver? = null

    fun install(value: Resolver) {
        resolver = value
    }

    private fun current(): Resolver = resolver
        ?: ServiceLoader.load(Resolver::class.java).firstOrNull()?.also { resolver = it }
        ?: error("L10n: no resolver installed")

    /** The string `id`, formatted with `args` (positional `%1$s`) when there are any. */
    fun str(@StringRes id: Int, vararg args: Any?): String {
        val text = current().string(id)
        return if (args.isEmpty()) text else String.format(locale, text, *args)
    }

    fun plural(@PluralsRes id: Int, count: Int, vararg args: Any?): String {
        val text = current().plural(id, count)
        return if (args.isEmpty()) text else String.format(locale, text, *args)
    }

    /** The effective UI language ("ja" / "en" / "zh-Hans"): the Accept-Language header and the date formats. */
    val language: String get() = current().language

    val locale: Locale get() = Locale.forLanguageTag(language)

    /** A weekday's short name in the UI language: 「月」, "Mon", 「周一」. */
    fun weekdayShort(day: DayOfWeek): String = day.getDisplayName(TextStyle.SHORT, locale)

    /** Monday-first short weekday names (index 0 = Monday). */
    val weekdaysMondayFirst: List<String> get() = DayOfWeek.entries.map(::weekdayShort)

    /** Sunday-first short weekday names (index 0 = Sunday), as Japanese wall calendars and the month grid. */
    val weekdaysSundayFirst: List<String> get() = weekdaysMondayFirst.let { listOf(it[6]) + it.subList(0, 6) }

    /** The supported language a locale list resolves to: the first supported entry, else Japanese (values/ is Japanese). */
    fun languageOf(locales: List<Locale>): String {
        for (locale in locales) {
            when (locale.language) {
                "ja" -> return "ja"
                "en" -> return "en"
                "zh" -> {
                    val script = locale.script
                    val hans = script == "Hans" || (script.isEmpty() && locale.country !in setOf("TW", "HK", "MO"))
                    if (hans) return "zh-Hans"
                }
            }
        }
        return DEFAULT
    }

    /** The Android resolver: the app's resources in the effective language ([resources] is read on every call). */
    class AndroidResolver(private val resources: () -> Resources) : Resolver {
        override fun string(id: Int): String = resources().getString(id)
        override fun plural(id: Int, count: Int): String = resources().getQuantityString(id, count)
        override val language: String
            get() {
                val list = resources().configuration.locales
                return languageOf((0 until list.size()).map { list[it] })
            }
    }
}
