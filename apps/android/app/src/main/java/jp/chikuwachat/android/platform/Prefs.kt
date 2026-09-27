package jp.chikuwachat.android.platform

import android.content.Context
import androidx.core.content.edit

/** Plain (not secret) settings by key: the workspace list and recent searches (WORKSPACES.md §4). */
interface KeyValueStore {
    fun getString(key: String): String?
    fun putString(key: String, value: String?)
}

/** SharedPreferences: small, synchronous to read (a push may need the list before the app has started). */
class SharedPrefsStore(context: Context, name: String = "chikuwa_prefs") : KeyValueStore {
    private val prefs = context.getSharedPreferences(name, Context.MODE_PRIVATE)

    override fun getString(key: String): String? = prefs.getString(key, null)

    override fun putString(key: String, value: String?) {
        prefs.edit { if (value == null) remove(key) else putString(key, value) }
    }
}
