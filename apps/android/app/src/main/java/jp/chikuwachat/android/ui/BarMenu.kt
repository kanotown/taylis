package jp.chikuwachat.android.ui

/** A row of the app bar's ⋮ (outside the home, which has its own menu). */
enum class BarMenuItem {
    FAVORITE, NOTIFICATIONS, DETAILS, ADD_MEMBER,
    /** L8 (TIMES_FEED.md §7): the Times feed's 「すべて既読にする」 and 「自分の times に書く」 / 「自分の times を作る」. */
    READ_ALL_TIMES, MY_TIMES,
    /** M66 (docs/AI.md §6): 「要約」 (未読 / 直近 1 日 / 直近 7 日) in a conversation, 「このスレッドを要約」 in a thread. */
    SUMMARIZE, SUMMARIZE_THREAD,
    /** M69 (CALENDAR.md §10.9): the calendar's 「カレンダーを購読 (iCal)」. */
    CALENDAR_FEEDS,
    /** M141 (SYNC_PROTOCOL.md §7.9): 「会話を閉じる」 in a DM or group DM, while the server closes them. */
    CLOSE_DM,
}

/**
 * 仕上げ A (MOBILE_POLISH.md C6): the ⋮ lists only what belongs to the screen it is on. A conversation: お気に入り,
 * 通知, チャンネル情報 and (a channel I can add people to) メンバーを追加 (the activity tab has none since 2026-10-07: its header holds 「すべて既読にする」).
 * The app-wide actions (DM, メンバー一覧, チャンネルを作成 / 探す, 新しいセクション, すべて既読にする, 設定, ログアウト)
 * are the home's ⋮ and the 自分 tab's; elsewhere (a thread, the details page, the DM tab, the home's lists) the ⋮ has
 * nothing and is not shown. M66: 「要約」 joins a conversation's ⋮ and 「このスレッドを要約」 makes a thread's, while the server
 * takes summaries.
 */
object BarMenu {
    /**
     * `conversation`: a joined conversation's own page is on screen (its timeline or one of its tabs, not its thread
     * or its details page). `channel`: it is a channel, not a DM. `activityFeed`: the activity tab's feed is on screen.
     * `timesFeed` (L8): the Times feed is; `myTimes`: 「自分の times」 is offered there (I have one, or may make one).
     * `thread` (M66): a joined conversation's thread is on screen; `summaries`: the server takes summaries (GET /ai/status).
     * `calendar` (M69): the calendar is on screen (and the server has one).
     */
    fun items(
        conversation: Boolean, channel: Boolean, archived: Boolean, activityFeed: Boolean, timesFeed: Boolean = false, myTimes: Boolean = false,
        thread: Boolean = false, summaries: Boolean = false, calendar: Boolean = false, closeDm: Boolean = false,
    ): List<BarMenuItem> = when {
        calendar -> listOf(BarMenuItem.CALENDAR_FEEDS)
        conversation -> buildList {
            add(BarMenuItem.FAVORITE)
            add(BarMenuItem.NOTIFICATIONS)
            add(BarMenuItem.DETAILS)
            if (summaries) add(BarMenuItem.SUMMARIZE)
            if (channel && !archived) add(BarMenuItem.ADD_MEMBER)
            if (!channel && closeDm) add(BarMenuItem.CLOSE_DM)
        }
        thread -> listOfNotNull(BarMenuItem.SUMMARIZE_THREAD.takeIf { summaries })
        activityFeed -> emptyList() // 2026-10-07 (MOBILE_UI.md §6.4): 「すべて既読にする」 is the feed's own header button now
        timesFeed -> listOfNotNull(BarMenuItem.READ_ALL_TIMES, BarMenuItem.MY_TIMES.takeIf { myTimes })
        else -> emptyList()
    }
}
