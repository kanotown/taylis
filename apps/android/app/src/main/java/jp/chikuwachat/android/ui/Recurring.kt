package jp.chikuwachat.android.ui

import jp.chikuwachat.android.api.CollectSpec
import jp.chikuwachat.android.api.CollectDue
import jp.chikuwachat.android.api.CollectionOut
import jp.chikuwachat.android.api.RecurringPostOut
import jp.chikuwachat.android.api.RecurringSchedule
import jp.chikuwachat.android.sync.ChannelState
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.putJsonObject
import java.time.Instant
import java.time.LocalDate
import java.time.OffsetDateTime
import java.time.ZoneId

/**
 * L6 (M60, RECURRING.md): recurring posts and their collections — the summaries, the form's draft and its checks, the
 * request bodies, and the collection chip under a post. The desktop's ui/recurring.ts, case for case
 * (apps/desktop/tests/recurring.test.ts is ported in RecurringTest). Pure: dates take the zone they are read in.
 */
object Recurring {
    /** 0 = Monday (the server's weekday numbers). */
    val WEEKDAY_LABELS = listOf("月", "火", "水", "木", "金", "土", "日")
    const val MAX_NAME = 40
    const val MAX_BODY = 4000
    const val MAX_AFTER_DAYS = 30
    /** The server keeps at most this many per channel (409 too_many_recurring_posts). */
    const val MAX_PER_CHANNEL = 20
    private val TIME = Regex("""^([01]\d|2[0-3]):([0-5]\d)$""")
    private val SPACES = Regex("""[\s　]+""")

    /** "09:00" → "9:00"; anything else as it is. */
    fun clockLabel(time: String): String {
        val match = TIME.matchEntire(time) ?: return time
        return "${match.groupValues[1].toInt()}:${match.groupValues[2]}"
    }

    /** A day of a month as the form and the list say it: 「1 日」, 「30 日 (ない月は末日)」, 「末日」. */
    fun dayLabel(day: Int): String = when {
        day == 31 -> "末日"
        day >= 29 -> "$day 日 (ない月は末日)"
        else -> "$day 日"
    }

    /** 「毎週 月・木 9:00」, 「毎日 9:00」, 「毎月 1 日 9:00」, 「毎月 末日 18:00」; the zone when it is not this device's. */
    fun scheduleSummary(schedule: RecurringSchedule, tz: String? = null, localTz: String? = null): String {
        val text = when (schedule.kind) {
            "weekly" -> {
                val days = schedule.weekdays.filter { it in 0..6 }.distinct().sorted()
                if (days.size == 7) "毎日 ${clockLabel(schedule.time)}"
                else "毎週 ${days.joinToString("・") { WEEKDAY_LABELS[it] }} ${clockLabel(schedule.time)}"
            }
            "monthly" -> "毎月 ${dayLabel(schedule.day)} ${clockLabel(schedule.time)}"
            // A kind a newer server added: its time at least.
            else -> "${clockLabel(schedule.time)} (このアプリでは表示できない予定)"
        }
        return if (!tz.isNullOrEmpty() && !localTz.isNullOrEmpty() && tz != localTz) "$text ($tz)" else text
    }

    /** Whether this app's form can edit the schedule (a kind a newer server added cannot be). */
    fun editable(post: RecurringPostOut): Boolean = post.schedule.kind == "weekly" || post.schedule.kind == "monthly"

    /** 「当日 18:00 締切」 / 「3 日後 18:00 締切」. */
    fun dueSummary(due: CollectDue): String =
        "${if (due.afterDays == 0) "当日" else "${due.afterDays} 日後"} ${clockLabel(due.time)} 締切"

    /** An ISO time from the server; null when unreadable. */
    fun instant(iso: String?): Instant? {
        if (iso.isNullOrEmpty()) return null
        return runCatching { OffsetDateTime.parse(iso).toInstant() }.getOrNull() ?: runCatching { Instant.parse(iso) }.getOrNull()
    }

    /** 「10/9 (金) 18:00」 in `zone`; empty when unreadable. */
    fun shortDateTime(iso: String?, zone: ZoneId = ZoneId.systemDefault()): String {
        val at = instant(iso)?.atZone(zone) ?: return ""
        return "${at.monthValue}/${at.dayOfMonth} (${WEEKDAY_LABELS[at.dayOfWeek.value - 1]}) ${at.hour}:${"%02d".format(at.minute)}"
    }

    /** Whom it collects from, as one line (names from the caller). */
    fun targetsSummary(spec: CollectSpec, groupName: (String) -> String?, userName: (String) -> String?): String {
        if (spec.targets.allMembers) return "チャンネルの全員"
        val names = spec.targets.groupIds.map { "@${groupName(it) ?: "グループ"}" } + spec.targets.userIds.map { userName(it) ?: "?" }
        return if (names.size > 4) names.take(4).joinToString("、") + " ほか ${names.size - 4}" else names.joinToString("、")
    }

    /** Owners and the administrators among the members of a channel (not a DM) manage its recurring posts (§7). */
    fun canManage(channel: ChannelState?, isAdmin: Boolean): Boolean {
        if (channel == null || !channel.isMember) return false
        if (channel.channel.type != "public" && channel.channel.type != "private") return false
        return isAdmin || channel.channel.membership?.role == "owner"
    }

    // --- the form's draft ----------------------------------------------------------------------------------------

    /** Today's weekday (Monday = 0) at 9:00; collecting off, due three days later at 18:00 when turned on. */
    fun emptyDraft(today: LocalDate = LocalDate.now()): RecurringDraft =
        RecurringDraft(weekdays = listOf(today.dayOfWeek.value - 1))

    fun draftFromPost(post: RecurringPostOut, today: LocalDate = LocalDate.now()): RecurringDraft {
        val base = emptyDraft(today)
        val schedule = post.schedule
        val collect = post.collect
        return base.copy(
            name = post.name,
            body = post.body,
            kind = if (schedule.kind == "monthly") "monthly" else "weekly",
            weekdays = if (schedule.kind == "weekly") schedule.weekdays else base.weekdays,
            day = if (schedule.kind == "monthly") schedule.day else base.day,
            time = schedule.time,
            collect = collect != null,
            allMembers = collect?.targets?.allMembers ?: false,
            groupIds = collect?.targets?.groupIds ?: emptyList(),
            userIds = collect?.targets?.userIds ?: emptyList(),
            afterDays = collect?.due?.afterDays ?: base.afterDays,
            dueTime = collect?.due?.time ?: base.dueTime,
        )
    }

    /** What keeps the draft from being saved, in words; null when it can be. The server checks the same. */
    fun problem(draft: RecurringDraft): String? {
        val name = draft.name.trim().split(SPACES).filter { it.isNotEmpty() }.joinToString(" ")
        if (name.isEmpty()) return "名前を入力してください"
        if (name.codePointCount(0, name.length) > MAX_NAME) return "名前は $MAX_NAME 文字までです"
        if (draft.body.isBlank()) return "本文を入力してください"
        if (draft.body.length > MAX_BODY) return "本文は $MAX_BODY 文字までです"
        if (draft.kind == "weekly" && draft.weekdays.isEmpty()) return "曜日を 1 つ以上選んでください"
        if (draft.kind == "monthly" && draft.day !in 1..31) return "日は 1〜31 で選んでください"
        if (!TIME.matches(draft.time)) return "時刻を選んでください"
        if (draft.collect) {
            if (!draft.allMembers && draft.groupIds.isEmpty() && draft.userIds.isEmpty()) return "提出する人を選んでください"
            if (draft.afterDays !in 0..MAX_AFTER_DAYS) return "締切は 0〜$MAX_AFTER_DAYS 日後で選んでください"
            if (!TIME.matches(draft.dueTime)) return "締切の時刻を選んでください"
        }
        return null
    }

    /** POST body; `tz` is this device's zone (the schedule's and the due time's). */
    fun createBody(draft: RecurringDraft, tz: String): JsonObject = buildJsonObject {
        put("name", draft.name.trim())
        put("body", draft.body)
        put("schedule", scheduleOf(draft))
        put("tz", tz)
        put("collect", collectOf(draft))
        put("enabled", true)
    }

    /** PATCH body: everything the form shows (the zone stays the post's; `collect: null` stops collecting). */
    fun updateBody(draft: RecurringDraft): JsonObject = buildJsonObject {
        put("name", draft.name.trim())
        put("body", draft.body)
        put("schedule", scheduleOf(draft))
        put("collect", collectOf(draft))
    }

    /** PATCH body of 止める / 再開. */
    fun enabledBody(enabled: Boolean): JsonObject = buildJsonObject { put("enabled", enabled) }

    /** Only the kind's own fields: the server refuses the other kind's (additionalProperties false). */
    private fun scheduleOf(draft: RecurringDraft): JsonObject = buildJsonObject {
        if (draft.kind == "weekly") {
            put("kind", "weekly")
            putJsonArray("weekdays") { draft.weekdays.distinct().sorted().forEach { add(it) } }
        } else {
            put("kind", "monthly")
            put("day", draft.day)
        }
        put("time", draft.time)
    }

    private fun collectOf(draft: RecurringDraft) = if (!draft.collect) JsonNull else buildJsonObject {
        putJsonObject("targets") {
            put("all_members", draft.allMembers)
            // 「チャンネルの全員」 sends no names.
            putJsonArray("group_ids") { if (!draft.allMembers) draft.groupIds.forEach { add(it) } }
            putJsonArray("user_ids") { if (!draft.allMembers) draft.userIds.forEach { add(it) } }
        }
        putJsonObject("due") {
            put("after_days", draft.afterDays)
            put("time", draft.dueTime)
        }
    }

    /** The body's placeholders as they would read today (the form's hint), with the template rule (M30). */
    fun placeholderHint(today: LocalDate = LocalDate.now()): String {
        val date = Templates.expand("{date}", today)
        val weekday = Templates.expand("{weekday}", today)
        val week = Templates.expand("{week}", today)
        return "{date} → $date、{weekday} → $weekday、{week} → 週番号 (例 $week)。投稿した日に置き換わります"
    }

    // --- the chip under a collecting post ------------------------------------------------------------------------

    /**
     * 「提出 7/10 · 締切 10/9 (金) 18:00」; `mine`: whether I (a target) have replied, null when I am not one; `overdue`:
     * the due time has passed; `complete`: everyone has submitted.
     */
    data class ChipState(val label: String, val mine: Mine?, val overdue: Boolean, val complete: Boolean)

    enum class Mine { PENDING, SUBMITTED }

    fun chip(collection: CollectionOut, meId: String?, now: Instant = Instant.now(), zone: ZoneId = ZoneId.systemDefault()): ChipState {
        val submitted = collection.submittedUserIds.size
        val isTarget = meId != null && meId in collection.targetUserIds
        val date = shortDateTime(collection.dueAt, zone)
        val due = instant(collection.dueAt)
        return ChipState(
            label = "提出 $submitted/${collection.targetCount}" + if (date.isNotEmpty()) " · 締切 $date" else "",
            mine = if (!isTarget) null else if (meId in collection.submittedUserIds) Mine.SUBMITTED else Mine.PENDING,
            overdue = due != null && !due.isAfter(now),
            complete = collection.targetCount > 0 && submitted >= collection.targetCount,
        )
    }

    /** The sheet's two lists: 提出済み and 未提出, each in the targets' order. */
    fun lists(collection: CollectionOut): Pair<List<String>, List<String>> {
        val done = collection.submittedUserIds.toSet()
        return collection.targetUserIds.filter { it in done } to collection.targetUserIds.filter { it !in done }
    }

    /** The reminders list's mark for a reminder someone else's action made (null for my own). */
    fun reminderBadge(kind: String): String? = when (kind) {
        "ack" -> "確認のお願い"
        "collect" -> "提出のお願い"
        else -> null
    }
}

/** The form's state (saved across a rotation as JSON). `kind` "weekly" / "monthly"; `weekdays` 0 = Monday. */
@Serializable
data class RecurringDraft(
    val name: String = "",
    val body: String = "",
    val kind: String = "weekly",
    val weekdays: List<Int> = emptyList(),
    val day: Int = 1,
    val time: String = "09:00",
    val collect: Boolean = false,
    val allMembers: Boolean = false,
    val groupIds: List<String> = emptyList(),
    val userIds: List<String> = emptyList(),
    val afterDays: Int = 3,
    val dueTime: String = "18:00",
)
