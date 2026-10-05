package jp.chikuwachat.android.app

/**
 * docs/I18N.md: which side of the UI language changed. The device keeps, per account, the last value it and the server
 * agreed on ([Synced]); against it a difference on this device (a choice made offline, or in the system's per-app
 * setting) is sent to the server, and a difference on the server (another device) is applied here. Values are
 * "ja" / "en" / "zh-Hans", null for the device's language.
 */
object LanguageSync {
    /** The last agreed value (its `language` null = the device's); a missing Synced = never synced with this account. */
    data class Synced(val language: String?)

    sealed interface Step {
        /** Send this device's choice to the server. */
        data object Push : Step
        /** Take the server's choice. */
        data class Apply(val language: String?) : Step
        /** Both agree already: only remember it. */
        data object Record : Step
        data object None : Step
    }

    fun decide(local: String?, server: String?, synced: Synced?): Step = when {
        // First contact with this account: a choice already on the server wins, else this device's is saved there.
        synced == null -> when {
            server != null && server != local -> Step.Apply(server)
            server == null && local != null -> Step.Push
            else -> Step.Record
        }
        synced.language != local -> Step.Push
        server != local -> Step.Apply(server)
        else -> Step.None
    }
}
