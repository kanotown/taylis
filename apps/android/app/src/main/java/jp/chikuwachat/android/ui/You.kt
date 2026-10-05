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
import jp.chikuwachat.android.R
import jp.chikuwachat.android.L10n

/**
 * M40 (MOBILE_UI.md §6.5): a screen of the 自分 tab, pushed over its list ([Route.Settings]). The list's order is
 * [listed]; [PASSWORD] opens from [ACCOUNT].
 */
enum class SettingsPage(private val titleRes: Int) {
    STATUS(R.string.common_update_status),
    QUIET_HOURS(R.string.common_quiet_hours),
    NOTIFICATIONS(R.string.common_notifications),
    APPEARANCE(R.string.you_appearance),
    PROFILE(R.string.common_edit_profile),
    ACCOUNT(R.string.you_account),
    PASSWORD(R.string.common_change_password),
    WORKSPACES(R.string.common_workspaces),
    ADMIN(R.string.common_admin),
    ;

    val title: String get() = L10n.str(titleRes)

    companion object {
        /** The rows under 「おやすみ時間」, in the list's order (「管理」 for admins only). */
        fun listed(isAdmin: Boolean): List<SettingsPage> =
            listOf(NOTIFICATIONS, APPEARANCE, PROFILE, ACCOUNT, WORKSPACES) + if (isAdmin) listOf(ADMIN) else emptyList()
    }
}

/** 「通知を一時停止」's choices (MOBILE_UI.md §6.5); [RESUME] only while paused. */
enum class PauseChoice(private val labelRes: Int) {
    MINUTES_30(R.string.common_30_minutes),
    HOUR_1(R.string.common_1_hour),
    HOURS_2(R.string.common_2_hours),
    TOMORROW_8(R.string.you_tomorrow_8_00),
    CUSTOM(R.string.you_pick_date_and_time),
    RESUME(R.string.common_resume);

    val label: String get() = L10n.str(labelRes)
}

/** M40: the appearance, kept on this device (not on the server): the system's, or always light / dark. */
enum class Appearance(private val labelRes: Int, val stored: String?) {
    SYSTEM(R.string.you_follow_device, null),
    LIGHT(R.string.you_light, "light"),
    DARK(R.string.you_dark, "dark"),
    ;

    val label: String get() = L10n.str(labelRes)

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

/** M47: 「連続した投稿をまとめる」, kept on this device (not on the server); off leaves no key behind. */
object PostGrouping {
    private const val KEY = "group_posts"

    fun read(store: KeyValueStore): Boolean = store.getString(KEY) == "on"

    fun write(store: KeyValueStore, on: Boolean) = store.putString(KEY, if (on) "on" else null)
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
        PauseChoice.CUSTOM -> requireNotNull(picked) { "PauseChoice.CUSTOM needs the picked time" }.toInstant().toString()
        PauseChoice.RESUME -> null
    }

    /** A picked end of the pause is at least a minute ahead (the dialog may stay open past it). */
    fun customPauseValid(picked: ZonedDateTime?, now: ZonedDateTime = ZonedDateTime.now()): Boolean = picked != null && picked.isAfter(now.plusMinutes(1))

    /** The list row's value: 「オフ」, or 「15:30 まで」 / 「明日 08:00 まで」 / 「10/2 09:00 まで」. */
    fun pauseSummary(dndUntil: String?, now: Instant = Instant.now(), zone: ZoneId = ZoneId.systemDefault()): String {
        val until = parse(dndUntil)?.takeIf { it.isAfter(now) } ?: return L10n.str(R.string.common_off)
        val end = until.atZone(zone)
        val today = now.atZone(zone).toLocalDate()
        val time = end.format(HHMM)
        return when (end.toLocalDate()) {
            today -> L10n.str(R.string.common_until, time)
            today.plusDays(1) -> L10n.str(R.string.you_until_tomorrow, time)
            else -> L10n.str(R.string.common_until, end.format(DateTimeFormatter.ofPattern("M/d")) + " " + time)
        }
    }

    // --- おやすみ時間 ---

    /** The list row's value: 「22:00〜07:00」 (with its days when not every day), or 「オフ」. */
    fun quietSummary(hours: QuietHours?): String = hours?.let(Dnd::label) ?: L10n.str(R.string.common_off)

    /** Why the quiet-hours form cannot be saved; null when it can. */
    fun quietHoursProblem(on: Boolean, start: String, end: String, days: Set<Int>): String? = when {
        !on -> null
        !TIME.matches(start) || !TIME.matches(end) -> L10n.str(R.string.you_enter_times_as_hh_mm)
        start == end -> L10n.str(R.string.you_the_start_and_end_must_be)
        days.isEmpty() -> L10n.str(R.string.common_choose_at_least_one_day_of)
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
            "desktop" -> L10n.str(R.string.common_desktop)
            "web" -> L10n.str(R.string.you_web_browser)
            else -> session.device.platform
        }

    /** 「たった今」 / 「5 分前」 / 「今日 14:05」 / 「昨日 21:40」 / 「9月28日」 / 「2025年12月1日」. */
    fun lastUsedLabel(iso: String?, now: Instant = Instant.now(), zone: ZoneId = ZoneId.systemDefault()): String {
        val at = parse(iso) ?: return ""
        val minutes = ChronoUnit.MINUTES.between(at, now)
        if (minutes < 1) return L10n.str(R.string.you_just_now)
        if (minutes < 60) return L10n.str(R.string.you_min_ago, minutes)
        val local = at.atZone(zone)
        val today = now.atZone(zone).toLocalDate()
        return when {
            local.toLocalDate() == today -> L10n.str(R.string.you_today) + local.format(HHMM)
            local.toLocalDate() == today.minusDays(1) -> L10n.str(R.string.you_yesterday) + local.format(HHMM)
            local.year == today.year -> local.format(DateTimeFormatter.ofPattern(L10n.str(R.string.you_month_day_pattern), L10n.locale))
            else -> local.format(DateTimeFormatter.ofPattern(L10n.str(R.string.common_mmm_d_yyyy)))
        }
    }

    private val HHMM = DateTimeFormatter.ofPattern("HH:mm")
    private val TIME = Regex("^([01]\\d|2[0-3]):[0-5]\\d$")
    private val ALL_DAYS = (0..6).toList()

    private fun parse(iso: String?): Instant? = iso?.let { raw -> runCatching { OffsetDateTime.parse(raw).toInstant() }.getOrNull() ?: runCatching { Instant.parse(raw) }.getOrNull() }
}
