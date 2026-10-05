package jp.chikuwachat.android

import android.app.Application
import android.content.res.Configuration
import jp.chikuwachat.android.app.AppController

class ChikuwaApp : Application() {
    /** Process-wide controller: outlives activity recreation (rotation) and keeps the socket open. */
    val controller: AppController by lazy { AppController(this) }

    override fun onCreate() {
        super.onCreate()
        // docs/I18N.md: the UI language before anything reads a string outside composition.
        AppLanguage.init(this)
    }

    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        // The device's language, or (Android 13+) the system's per-app language setting, may have changed.
        controller.languageMayHaveChanged()
    }
}
