package jp.chikuwachat.android.ui

import jp.chikuwachat.android.sync.NotificationLevels.ALL
import jp.chikuwachat.android.sync.NotificationLevels.NONE
import jp.chikuwachat.android.R
import jp.chikuwachat.android.L10n

/** M35: the words for notification levels and the overall setting (the same as the iOS and web clients). */
object NotificationLabels {
    /** A conversation's level in its menu: 「すべてのメッセージ」 and so on. */
    fun label(level: String): String = when (level) {
        ALL -> L10n.str(R.string.notification_labels_all_messages)
        NONE -> L10n.str(R.string.common_dont_notify)
        else -> L10n.str(R.string.notification_labels_mentions_only)
    }

    /** The short form after 「通知: 」 in the conversation's ⋮ menu. */
    fun shortLabel(level: String): String = when (level) {
        ALL -> L10n.str(R.string.common_all)
        NONE -> L10n.str(R.string.common_dont_notify)
        else -> L10n.str(R.string.notification_labels_mentions_only)
    }

    /** The overall setting's choices in the 自分 tab. */
    fun overallLabel(overall: String): String = when (overall) {
        ALL -> L10n.str(R.string.notification_labels_all_new_messages)
        NONE -> L10n.str(R.string.common_none)
        else -> L10n.str(R.string.notification_labels_mentions_and_dms_only)
    }

    /** The first choice of a conversation's menu: follow the overall setting (sends level null). */
    fun defaultChoice(overall: String): String = L10n.str(R.string.notification_labels_default, overallLabel(overall))

    val OVERALL_FOOTNOTE: String get() = L10n.str(R.string.notification_labels_each_channels_setting_takes_priority_dms)
}
