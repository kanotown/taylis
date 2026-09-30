package jp.chikuwachat.android.ui

import jp.chikuwachat.android.api.QuietHours
import jp.chikuwachat.android.api.SessionOut
import jp.chikuwachat.android.platform.KeyValueStore
import java.time.Instant
import java.time.OffsetDateTime
import java.time.ZoneId
import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter
import java.time.temporal.ChronoUnit

/**
 * M40 (MOBILE_UI.md §6.5): a screen of the 自分 tab, pushed over its list ([Route.Settings]). The list's order is
 * [listed]; [PASSWORD] opens from [ACCOUNT].
 */
enum class SettingsPage(val title: String) {
    STATUS("ステータスを更新"),
    QUIET_HOURS("おやすみ時間"),
    NOTIFICATIONS("通知"),
    APPEARANCE("表示"),
    PROFILE("プロフィールを編集"),
    ACCOUNT("アカウント"),
    PASSWORD("パスワードの変更"),
    WORKSPACES("ワークスペース"),
    ADMIN("管理"),
    ;

    companion object {
        /** The rows under 「おやすみ時間」, in the list's order (「管理」 for admins only). */
        fun listed(isAdmin: Boolean): List<SettingsPage> =
            listOf(NOTIFICATIONS, APPEARANCE, PROFILE, ACCOUNT, WORKSPACES) + if (isAdmin) listOf(ADMIN) else emptyList()
    }
}

/** 「通知を一時停止」's choices (MOBILE_UI.md §6.5); [RESUME] only while paused. */
enum class PauseChoice(val label: String) {
    MINUTES_30("30 分"),
    HOUR_1("1 時間"),
    HOURS_2("2 時間"),
    TOMORROW_8("明日 8:00"),
    CUSTOM("日時を指定"),
    RESUME("再開"),
}

/** M40: the appearance, kept on this device (not on the server): the system's, or always light / dark. */
enum class Appearance(val label: String, val stored: String?) {
    SYSTEM("端末に合わせる", null),
    LIGHT("ライト", "light"),
    DARK("ダーク", "dark"),
    ;

    /** Whether the app is dark, given the system's own setting. */
    fun isDark(systemDark: Boolean): Boolean = when (this) {
        SYSTEM -> systemDark
        LIGHT -> false
        DARK -> true
    }

    companion object {
        private const val KEY = "appearance"

        fun read(store: KeyValueStore): Appearance = entries.firstOrNull { it.stored != null && it.stored == store.getString(KEY) } ?: SYSTEM

        /** The system's default leaves no key behind. */
        fun write(store: KeyValueStore, value: Appearance) = store.putString(KEY, value.stored)
    }
}

/** M40: the pure parts of the 自分 tab (tested in YouTest). */
object YouSettings {
    /** From this width (dp) the tab is two panes: the list, and the chosen screen beside it. */
    const val TWO_PANE_MIN_WIDTH = 600f

    fun twoPane(widthDp: Float): Boolean = widthDp >= TWO_PANE_MIN_WIDTH

    /** The second line under my name: 「@yamada · M2」. */
    fun handle(username: String, title: String?): String = "@$username" + (title?.trim()?.takeIf { it.isNotEmpty() }?.let { " · $it" } ?: "")

    // --- 通知を一時停止 (dnd_until) ---

    fun paused(dndUntil: String?, now: Instant = Instant.now()): Boolean = parse(dndUntil)?.isAfter(now) == true

    fun pauseChoices(paused: Boolean): List<PauseChoice> = PauseChoice.entries.filter { paused || it != PauseChoice.RESUME }

    /**
     * The `dnd_until` a choice sends: an ISO instant, or null to resume. [PauseChoice.CUSTOM] sends the time picked in
     * its dialog (`picked`).
     */
    fun dndUntil(choice: PauseChoice, now: ZonedDateTime = ZonedDateTime.now(), picked: ZonedDateTime? = null): String? = when (choice) {
        PauseChoice.MINUTES_30 -> Dnd.pauseUntil("30m", now)
        PauseChoice.HOUR_1 -> Dnd.pauseUntil("1h", now)
        PauseChoice.HOURS_2 -> Dnd.pauseUntil("2h", now)
        PauseChoice.TOMORROW_8 -> Dnd.pauseUntil("tomorrow", now)
        PauseChoice.CUSTOM -> requireNotNull(picked) { "日時を指定 needs the picked time" }.toInstant().toString()
        PauseChoice.RESUME -> null
    }

    /** A picked end of the pause is at least a minute ahead (the dialog may stay open past it). */
    fun customPauseValid(picked: ZonedDateTime?, now: ZonedDateTime = ZonedDateTime.now()): Boolean = picked != null && picked.isAfter(now.plusMinutes(1))

    /** The list row's value: 「オフ」, or 「15:30 まで」 / 「明日 08:00 まで」 / 「10/2 09:00 まで」. */
    fun pauseSummary(dndUntil: String?, now: Instant = Instant.now(), zone: ZoneId = ZoneId.systemDefault()): String {
        val until = parse(dndUntil)?.takeIf { it.isAfter(now) } ?: return "オフ"
        val end = until.atZone(zone)
        val today = now.atZone(zone).toLocalDate()
        val time = end.format(HHMM)
        return when (end.toLocalDate()) {
            today -> "$time まで"
            today.plusDays(1) -> "明日 $time まで"
            else -> end.format(DateTimeFormatter.ofPattern("M/d")) + " $time まで"
        }
    }

    // --- おやすみ時間 ---

    /** The list row's value: 「22:00〜07:00」 (with its days when not every day), or 「オフ」. */
    fun quietSummary(hours: QuietHours?): String = hours?.let(Dnd::label) ?: "オフ"

    /** Why the quiet-hours form cannot be saved; null when it can. */
    fun quietHoursProblem(on: Boolean, start: String, end: String, days: Set<Int>): String? = when {
        !on -> null
        !TIME.matches(start) || !TIME.matches(end) -> "時刻は HH:mm で指定してください"
        start == end -> "開始と終了を別の時刻にしてください"
        days.isEmpty() -> "曜日を 1 つ以上選んでください"
        else -> null
    }

    /** The form's quiet hours as the server takes them (null = off); the days in order. */
    fun quietHours(on: Boolean, start: String, end: String, days: Set<Int>, zone: String): QuietHours? =
        if (on) QuietHours(start, end, days.sorted(), zone) else null

    /** Whether the form differs from what is saved (days in any order are the same). */
    fun quietHoursChanged(saved: QuietHours?, draft: QuietHours?): Boolean = when {
        saved == null || draft == null -> (saved == null) != (draft == null)
        else -> saved.start != draft.start || saved.end != draft.end || saved.tz != draft.tz ||
            saved.days.ifEmpty { ALL_DAYS }.toSet() != draft.days.ifEmpty { ALL_DAYS }.toSet()
    }

    // --- ログイン中の端末 (GET /auth/sessions) ---

    /** This device first, then the most recently used. */
    fun orderedSessions(sessions: List<SessionOut>): List<SessionOut> =
        sessions.sortedWith(compareByDescending<SessionOut> { it.current }.thenByDescending { parse(it.lastUsedAt) ?: Instant.EPOCH })

    /** Only the other devices can be signed out from here (this one signs out with 「ログアウト」). */
    fun canSignOut(session: SessionOut): Boolean = !session.current

    /** The device's name as it signed in, else its platform. */
    fun deviceLabel(session: SessionOut): String =
        session.device.deviceName?.trim()?.takeIf { it.isNotEmpty() } ?: when (session.device.platform) {
            "ios" -> "iPhone / iPad"
            "android" -> "Android"
            "desktop" -> "デスクトップ"
            "web" -> "Web ブラウザ"
            else -> session.device.platform
        }

    /** 「たった今」 / 「5 分前」 / 「今日 14:05」 / 「昨日 21:40」 / 「9月28日」 / 「2025年12月1日」. */
    fun lastUsedLabel(iso: String?, now: Instant = Instant.now(), zone: ZoneId = ZoneId.systemDefault()): String {
        val at = parse(iso) ?: return ""
        val minutes = ChronoUnit.MINUTES.between(at, now)
        if (minutes < 1) return "たった今"
        if (minutes < 60) return "$minutes 分前"
        val local = at.atZone(zone)
        val today = now.atZone(zone).toLocalDate()
        return when {
            local.toLocalDate() == today -> "今日 " + local.format(HHMM)
            local.toLocalDate() == today.minusDays(1) -> "昨日 " + local.format(HHMM)
            local.year == today.year -> local.format(DateTimeFormatter.ofPattern("M月d日"))
            else -> local.format(DateTimeFormatter.ofPattern("yyyy年M月d日"))
        }
    }

    private val HHMM = DateTimeFormatter.ofPattern("HH:mm")
    private val TIME = Regex("^([01]\\d|2[0-3]):[0-5]\\d$")
    private val ALL_DAYS = (0..6).toList()

    private fun parse(iso: String?): Instant? = iso?.let { raw -> runCatching { OffsetDateTime.parse(raw).toInstant() }.getOrNull() ?: runCatching { Instant.parse(raw) }.getOrNull() }
}
