package jp.chikuwachat.android

import jp.chikuwachat.android.platform.KeyValueStore

/** SharedPreferences stand-in for tests. */
class MemoryStore(initial: Map<String, String> = emptyMap()) : KeyValueStore {
    val values = HashMap(initial)
    override fun getString(key: String): String? = values[key]
    override fun putString(key: String, value: String?) {
        if (value == null) values.remove(key) else values[key] = value
    }
}
