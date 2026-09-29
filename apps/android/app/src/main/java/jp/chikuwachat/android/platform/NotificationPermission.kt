package jp.chikuwachat.android.platform

/**
 * M28c: when to ask for POST_NOTIFICATIONS (Android 13+). Once, after the first sign-in on this device: it was asked at
 * every start of the activity (a rotation included), and the system stops showing the dialog after two refusals, so the
 * settings show a refusal with the way to the system's page instead ([Notifier.permitted]).
 */
object NotificationPermission {
    private const val KEY = "notifications.asked"

    fun shouldAsk(store: KeyValueStore, sdk: Int, granted: Boolean): Boolean = sdk >= 33 && !granted && store.getString(KEY) == null

    fun markAsked(store: KeyValueStore) = store.putString(KEY, "1")
}
