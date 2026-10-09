package jp.chikuwachat.android.ui

import jp.chikuwachat.android.L10n
import jp.chikuwachat.android.R
import jp.chikuwachat.android.api.UserMe
import jp.chikuwachat.android.api.UserPublic
import java.time.Instant
import java.time.OffsetDateTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** docs/PRESENCE.md §11.1: what the status menu offers, with the API's `status`. */
enum class PresenceChoice(val api: String, private val labelRes: Int, private val hintRes: Int, val look: String) {
    AUTO("auto", R.string.presence_choice_auto, R.string.presence_hint_auto, PresenceRules.ONLINE),
    AWAY("away", R.string.presence_choice_away, R.string.presence_hint_away, PresenceRules.AWAY),
    DND("dnd", R.string.presence_choice_dnd, R.string.presence_hint_dnd, PresenceRules.DND),
    INVISIBLE("invisible", R.string.presence_choice_invisible, R.string.presence_hint_invisible, PresenceRules.OFFLINE);

    val label: String get() = L10n.str(labelRes)
    val hint: String get() = L10n.str(hintRes)
}

/** docs/PRESENCE.md §11.2: 取り込み中's lengths, in the menu's order (the server works out the end in `tz`). */
enum class DndDuration(val api: String, private val labelRes: Int) {
    MINUTES_30("30m", R.string.presence_duration_30m),
    HOUR_1("1h", R.string.presence_duration_1h),
    HOURS_2("2h", R.string.presence_duration_2h),
    HOURS_4("4h", R.string.presence_duration_4h),
    TODAY("today", R.string.presence_duration_today),
    TOMORROW("tomorrow", R.string.presence_duration_tomorrow),
    FOREVER("forever", R.string.presence_duration_forever);

    val label: String get() = L10n.str(labelRes)
}

/**
 * The quick status menu's rules (docs/PRESENCE.md §11, the web's ui/presence.ts): 取り込み中 is `dnd_until` (the M12c
 * pause, public), オフライン表示 `presence_hidden` (L4), 離席中 `presence_manual: "away"`. Pure, tested in PresenceTest.
 */
object PresenceRules {
    const val ONLINE = "online"
    const val AWAY = "away"
    const val OFFLINE = "offline"
    /** The look of someone in 取り込み中: a red disc with a white bar (never sent in a `presence` frame). */
    const val DND = "dnd"

    /** A `dnd_until` at or after this means 「解除するまで」 (the server stores 9999-12-31T00:00:00Z). */
    val INDEFINITE_FROM: Instant = Instant.parse("9999-01-01T00:00:00Z")

    fun parse(iso: String?): Instant? = iso?.let { runCatching { OffsetDateTime.parse(it).toInstant() }.getOrNull() }

    fun isIndefinite(until: String?): Boolean = parse(until)?.let { !it.isBefore(INDEFINITE_FROM) } == true

    /** The manual pause still running, else null. Quiet hours are not 取り込み中 (they keep the 🔕 only). */
    fun dndUntil(until: String?, now: Instant = Instant.now()): Instant? = parse(until)?.takeIf { it.isAfter(now) }

    /** What an avatar shows (§11.5): 取り込み中 beats the connection (online, away and offline alike). */
    fun look(connection: String, until: String?, now: Instant = Instant.now()): String = if (dndUntil(until, now) != null) DND else connection

    /** My choice (§11.1): 取り込み中 > オフライン表示 > 離席中 > 自動 (an unknown `presence_manual` is automatic). */
    fun myChoice(me: UserMe?, now: Instant = Instant.now()): PresenceChoice = when {
        me == null -> PresenceChoice.AUTO
        dndUntil(me.dndUntil, now) != null -> PresenceChoice.DND
        me.presenceHidden -> PresenceChoice.INVISIBLE
        me.presenceManual == "away" -> PresenceChoice.AWAY
        else -> PresenceChoice.AUTO
    }

    /**
     * My own avatar's dot (the top bar, 「自分」, the menu's header): what I chose, or while automatic what the frames say
     * of me (offline then draws the hollow ring, so a lost connection shows too).
     */
    fun myLook(choice: PresenceChoice, connection: String): String = if (choice == PresenceChoice.AUTO) connection else choice.look

    /**
     * Me as the menu reads it (§11.6): my own fields from `me`, the public ones from `shared` (the users map) when that is
     * newer — user.updated from another of my devices arrives before GET /users/me answers.
     */
    fun currentMe(me: UserMe?, shared: UserPublic?): UserMe? {
        if (me == null || shared == null || shared.id != me.id || !newer(shared.updatedAt, me.updatedAt)) return me
        return me.copy(
            displayName = shared.displayName, title = shared.title, statusText = shared.statusText, statusEmoji = shared.statusEmoji,
            statusExpiresAt = shared.statusExpiresAt, dndUntil = shared.dndUntil, quietHours = shared.quietHours, updatedAt = shared.updatedAt,
        )
    }

    private fun newer(a: String, b: String): Boolean {
        val x = parse(a)
        val y = parse(b)
        return if (x != null && y != null) x.isAfter(y) else a > b
    }

    /** When the soonest running pause ends (one timer redraws then, §11.3); 「解除するまで」 never ends by itself. */
    fun nextDndEnd(untils: Iterable<String?>, now: Instant = Instant.now()): Instant? =
        untils.mapNotNull { dndUntil(it, now) }.filter { it.isBefore(INDEFINITE_FROM) }.minOrNull()

    private val HHMM = DateTimeFormatter.ofPattern("HH:mm")
    private val MD_HHMM = DateTimeFormatter.ofPattern("M/d HH:mm")

    /** 「15:30」 today, 「10/10 23:59」 another day, 「解除するまで」 for the indefinite pause (the device's zone). */
    fun endLabel(until: String, now: Instant = Instant.now(), zone: ZoneId = ZoneId.systemDefault()): String {
        if (isIndefinite(until)) return L10n.str(R.string.presence_until_cleared)
        val end = parse(until)?.atZone(zone) ?: return until
        return if (end.toLocalDate() == now.atZone(zone).toLocalDate()) end.format(HHMM) else end.format(MD_HHMM)
    }

    /** 「取り込み中（〜15:30）」 / 「取り込み中（解除するまで）」 (my menu, anyone's profile card). */
    fun dndLine(until: String, now: Instant = Instant.now(), zone: ZoneId = ZoneId.systemDefault()): String =
        if (isIndefinite(until)) L10n.str(R.string.presence_dnd_forever) else L10n.str(R.string.presence_dnd_until, endLabel(until, now, zone))

    /** The menu header's line: 「取り込み中（〜15:30）」, 「離席中」, 「オンライン（自動）」… */
    fun myLine(me: UserMe?, now: Instant = Instant.now(), zone: ZoneId = ZoneId.systemDefault()): String {
        val choice = myChoice(me, now)
        val until = me?.dndUntil
        return if (choice == PresenceChoice.DND && until != null) dndLine(until, now, zone) else choice.label
    }

    /** A person's presence in words (the profile card, the DM's subtitle): 取り込み中 with its end. */
    fun lookLabel(look: String, until: String?, now: Instant = Instant.now(), zone: ZoneId = ZoneId.systemDefault()): String =
        if (look == DND && until != null) dndLine(until, now, zone) else presenceLabel(look)

    /** PUT /users/me/presence's body (§11.4): 取り込み中 with its length and the device's zone, the others alone. */
    fun body(choice: PresenceChoice, duration: DndDuration? = null, tz: String = ZoneId.systemDefault().id): JsonObject = buildJsonObject {
        put("status", choice.api)
        if (choice == PresenceChoice.DND) {
            put("duration", (duration ?: DndDuration.FOREVER).api)
            put("tz", tz)
        }
    }

    /**
     * The menu header's 「解除」: PATCH /users/me's body that ends the pause and nothing else — Settings' 「再開」 (§11.1).
     * `{status: "auto"}` would also clear 離席中 and 「在席を隠す」 set separately in Settings (the review's finding).
     */
    fun clearPauseBody(): JsonObject = buildJsonObject { put("dnd_until", JsonNull) }
}
