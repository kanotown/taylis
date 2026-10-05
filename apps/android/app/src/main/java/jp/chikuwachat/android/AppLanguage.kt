package jp.chikuwachat.android

import android.app.LocaleManager
import android.content.Context
import android.content.res.Configuration
import android.content.res.Resources
import android.os.Build
import android.os.LocaleList
import java.util.Locale

/**
 * The UI language (docs/I18N.md): Japanese, English or Simplified Chinese, or the device's (null). From Android 13 it is
 * the per-app language the system keeps ([LocaleManager], so the system's 「アプリの言語」 setting is the same switch;
 * res/xml/locales_config.xml lists the choices). Before 13 the app keeps it and applies it to its activities itself
 * ([wrap]). The user's `locale` on the server follows it (AppController.reconcileLanguage).
 */
object AppLanguage {
    private const val PREFS = "chikuwa_prefs"
    private const val KEY = "app_language"

    /** The chosen language ("ja" / "en" / "zh-Hans"), or null to follow the device. */
    @Volatile var chosen: String? = null
        private set

    @Volatile private var cached: Pair<String, Resources>? = null

    /** At start: reads the choice and installs the resources [L10n] reads outside composition. */
    fun init(context: Context) {
        val app = context.applicationContext
        chosen = read(app)
        L10n.install(L10n.AndroidResolver { resources(app) })
    }

    /** Reads the choice again (the system's per-app setting may have changed it). True when it changed. */
    fun refresh(context: Context): Boolean {
        val now = read(context.applicationContext)
        if (now == chosen) return false
        chosen = now
        return true
    }

    /** Applies a choice (null: the device's language). From Android 13 the system recreates the activities itself. */
    fun choose(context: Context, language: String?) {
        val value = language?.let(::normalize)
        if (Build.VERSION.SDK_INT >= 33) {
            context.getSystemService(LocaleManager::class.java)?.applicationLocales =
                value?.let { LocaleList.forLanguageTags(it) } ?: LocaleList.getEmptyLocaleList()
        } else {
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().apply {
                if (value == null) remove(KEY) else putString(KEY, value)
            }.apply()
        }
        chosen = value
    }

    /** One of [L10n.SUPPORTED] for a language tag ("zh-Hans-CN" → "zh-Hans"); null for anything else. */
    fun normalize(tag: String): String? {
        val locale = Locale.forLanguageTag(tag)
        return when (locale.language) {
            "ja", "en" -> locale.language
            "zh" -> if (L10n.languageOf(listOf(locale)) == "zh-Hans") "zh-Hans" else null
            else -> null
        }
    }

    private fun read(context: Context): String? =
        if (Build.VERSION.SDK_INT >= 33) {
            context.getSystemService(LocaleManager::class.java)?.applicationLocales
                ?.takeIf { !it.isEmpty }?.get(0)?.toLanguageTag()?.let(::normalize)
        } else {
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY, null)?.let(::normalize)
        }

    /** The app's resources in the effective language (the device's when nothing is chosen). */
    fun resources(app: Context): Resources {
        val language = chosen ?: return app.resources
        cached?.let { (tag, res) -> if (tag == language) return res }
        val res = app.createConfigurationContext(configured(app.resources.configuration, language)).resources
        cached = language to res
        return res
    }

    /** Before Android 13: an activity's context in the chosen language (attachBaseContext). */
    fun wrap(base: Context): Context {
        if (Build.VERSION.SDK_INT >= 33) return base
        val language = base.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY, null)?.let(::normalize) ?: return base
        return base.createConfigurationContext(configured(base.resources.configuration, language))
    }

    private fun configured(base: Configuration, language: String): Configuration =
        Configuration(base).apply { setLocales(LocaleList.forLanguageTags(language)) }
}
