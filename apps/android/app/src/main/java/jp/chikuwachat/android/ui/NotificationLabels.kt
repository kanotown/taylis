package jp.chikuwachat.android.ui

import jp.chikuwachat.android.sync.NotificationLevels.ALL
import jp.chikuwachat.android.sync.NotificationLevels.NONE

/** M35: the words for notification levels and the overall setting (the same as the iOS and web clients). */
object NotificationLabels {
    /** A conversation's level in its menu: 「すべてのメッセージ」 and so on. */
    fun label(level: String): String = when (level) {
        ALL -> "すべてのメッセージ"
        NONE -> "通知しない"
        else -> "メンションのみ"
    }

    /** The short form after 「通知: 」 in the conversation's ⋮ menu. */
    fun shortLabel(level: String): String = when (level) {
        ALL -> "すべて"
        NONE -> "通知しない"
        else -> "メンションのみ"
    }

    /** The overall setting's choices in the 自分 tab. */
    fun overallLabel(overall: String): String = when (overall) {
        ALL -> "すべての新着メッセージ"
        NONE -> "なし"
        else -> "メンションと DM のみ"
    }

    /** The first choice of a conversation's menu: follow the overall setting (sends level null). */
    fun defaultChoice(overall: String): String = "既定 (${overallLabel(overall)})"

    const val OVERALL_FOOTNOTE = "チャンネルごとの設定が優先されます。DM は『なし』以外なら常に通知されます。"
}
