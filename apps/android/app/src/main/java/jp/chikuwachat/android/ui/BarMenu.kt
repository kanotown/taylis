package jp.chikuwachat.android.ui

/** A row of the app bar's ⋮ (outside the home, which has its own menu). */
enum class BarMenuItem {
    READ_ALL_ACTIVITY, FAVORITE, NOTIFICATIONS, DETAILS, ADD_MEMBER,
    /** L8 (TIMES_FEED.md §7): the Times feed's 「すべて既読にする」 and 「自分の times に書く」 / 「自分の times を作る」. */
    READ_ALL_TIMES, MY_TIMES,
}

/**
 * 仕上げ A (MOBILE_POLISH.md C6): the ⋮ lists only what belongs to the screen it is on. A conversation: お気に入り,
 * 通知, チャンネル情報 and (a channel I can add people to) メンバーを追加; the activity tab: its own 「すべて既読」.
 * The app-wide actions (DM, メンバー一覧, チャンネルを作成 / 探す, 新しいセクション, すべて既読にする, 設定, ログアウト)
 * are the home's ⋮ and the 自分 tab's; elsewhere (a thread, the details page, the DM tab, the home's lists) the ⋮ has
 * nothing and is not shown.
 */
object BarMenu {
    /**
     * `conversation`: a joined conversation's own page is on screen (its timeline or one of its tabs, not its thread
     * or its details page). `channel`: it is a channel, not a DM. `activityFeed`: the activity tab's feed is on screen.
     * `timesFeed` (L8): the Times feed is; `myTimes`: 「自分の times」 is offered there (I have one, or may make one).
     */
    fun items(conversation: Boolean, channel: Boolean, archived: Boolean, activityFeed: Boolean, timesFeed: Boolean = false, myTimes: Boolean = false): List<BarMenuItem> = when {
        conversation -> buildList {
            add(BarMenuItem.FAVORITE)
            add(BarMenuItem.NOTIFICATIONS)
            add(BarMenuItem.DETAILS)
            if (channel && !archived) add(BarMenuItem.ADD_MEMBER)
        }
        activityFeed -> listOf(BarMenuItem.READ_ALL_ACTIVITY)
        timesFeed -> listOfNotNull(BarMenuItem.READ_ALL_TIMES, BarMenuItem.MY_TIMES.takeIf { myTimes })
        else -> emptyList()
    }
}
