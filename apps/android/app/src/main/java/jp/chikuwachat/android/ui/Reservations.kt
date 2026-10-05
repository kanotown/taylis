package jp.chikuwachat.android.ui

import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import java.time.Duration
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.temporal.ChronoUnit
import jp.chikuwachat.android.api.PoolOut
import jp.chikuwachat.android.api.ReservationOut
import jp.chikuwachat.android.api.ReservationTodo
import jp.chikuwachat.android.app.AppController
import kotlinx.coroutines.launch

/**
 * M112 (docs/RESERVATIONS.md §6): the pure parts of 「予約」 — the booking choices, a day's hours, my reservations, the
 * operators' to-do and the words (the web's ui/reservationPools.ts). Times are the device's (`zone`).
 */
object ReservationRules {
    private val HOUR: Duration = Duration.ofHours(1)
    private val WEEKDAYS = listOf("月", "火", "水", "木", "金", "土", "日")

    private fun time(iso: String?): Instant? = iso?.let { runCatching { Instant.parse(it) }.getOrNull() ?: runCatching { java.time.OffsetDateTime.parse(it).toInstant() }.getOrNull() }

    fun days(now: Instant, horizonDays: Int, zone: ZoneId): List<LocalDate> {
        val today = now.atZone(zone).toLocalDate()
        return (0..horizonDays).map { today.plusDays(it.toLong()) }
    }

    /** 「今日」 「明日」 or 「10/7 (水)」. */
    fun dayLabel(day: LocalDate, now: Instant, zone: ZoneId): String {
        val diff = ChronoUnit.DAYS.between(now.atZone(zone).toLocalDate(), day)
        return when (diff) {
            0L -> "今日"
            1L -> "明日"
            else -> "${day.monthValue}/${day.dayOfMonth} (${WEEKDAYS[day.dayOfWeek.value - 1]})"
        }
    }

    fun hm(instant: Instant, zone: ZoneId): String = instant.atZone(zone).let { "%02d:%02d".format(it.hour, it.minute) }

    /** 「13:00」 today, else 「10/7 (水) 13:00」. */
    fun whenText(iso: String, now: Instant, zone: ZoneId): String {
        val at = time(iso) ?: return ""
        val day = at.atZone(zone).toLocalDate()
        return if (day == now.atZone(zone).toLocalDate()) hm(at, zone) else "${dayLabel(day, now, zone)} ${hm(at, zone)}"
    }

    /** 「13:00〜16:00」 today, else 「10/7 (水) 13:00〜16:00」. */
    fun span(startIso: String?, endIso: String?, now: Instant, zone: ZoneId): String {
        val start = time(startIso) ?: return ""
        val end = time(endIso) ?: return ""
        val day = start.atZone(zone).toLocalDate()
        val prefix = if (day == now.atZone(zone).toLocalDate()) "" else dayLabel(day, now, zone) + " "
        return "$prefix${hm(start, zone)}〜${hm(end, zone)}"
    }

    /** Bookings still counting (booked or on a seat). */
    fun live(pool: PoolOut): List<ReservationOut> = pool.bookings.filter { it.status in setOf("booked", "holding", "returning") }

    private fun promised(pool: PoolOut, start: Instant, end: Instant, now: Instant): Int {
        var count = live(pool).count { b ->
            val s = time(b.startAt); val e = time(b.endAt)
            s != null && e != null && s < end && e > start
        }
        val from = if (start > now) start else now
        count += pool.holders.count { h ->
            h.kind == "walkin" && h.status == "holding" && (time(h.guaranteeUntil)?.let { it > from } ?: false) && from < end
        }
        return count
    }

    /** Whether every hour of [start, start + hours) has a seat left (the server's check, as far as the app knows). */
    fun fits(pool: PoolOut, start: Instant, hours: Int, now: Instant): Boolean =
        (0 until hours).all { i ->
            val from = start.plus(HOUR.multipliedBy(i.toLong()))
            promised(pool, from, from.plus(HOUR), now) + 1 <= pool.capacity
        }

    fun horizonEnd(pool: PoolOut, now: Instant, zone: ZoneId): Instant =
        now.atZone(zone).toLocalDate().plusDays(pool.horizonDays + 1L).atStartOfDay(zone).toInstant()

    data class StartChoice(val start: Instant, val full: Boolean)

    /** The starts on `day`: every hour from the current one (today) on. */
    fun starts(pool: PoolOut, day: LocalDate, now: Instant, zone: ZoneId): List<StartChoice> {
        val hourNow = now.atZone(zone).truncatedTo(ChronoUnit.HOURS).toInstant()
        val limit = horizonEnd(pool, now, zone)
        return (0 until 24).mapNotNull { h ->
            val start = day.atStartOfDay(zone).plusHours(h.toLong())
            if (start.toLocalDate() != day) return@mapNotNull null
            val at = start.toInstant()
            if (at < hourNow || at >= limit) null else StartChoice(at, !fits(pool, at, 1, now))
        }
    }

    /** How long a booking from `start` can be: 1 h up to max_hours, stopping at the first full hour and the horizon. */
    fun durations(pool: PoolOut, start: Instant, now: Instant, zone: ZoneId): List<Int> {
        val out = mutableListOf<Int>()
        val limit = horizonEnd(pool, now, zone)
        for (hours in 1..maxOf(1, pool.maxHours)) {
            if (start.plus(HOUR.multipliedBy(hours.toLong())) > limit || !fits(pool, start, hours, now)) break
            out += hours
        }
        return out
    }

    data class HourRow(val start: Instant, val rows: List<ReservationOut>)

    /** The hours of `day` with their bookings and walk-ins (from assignment to the end of the guarantee, or now). */
    fun hours(pool: PoolOut, day: LocalDate, now: Instant, zone: ZoneId): List<HourRow> {
        val spans = mutableListOf<Triple<ReservationOut, Instant, Instant>>()
        pool.bookings.forEach { b -> val s = time(b.startAt); val e = time(b.endAt); if (s != null && e != null) spans += Triple(b, s, e) }
        pool.holders.filter { it.kind == "walkin" }.forEach { h ->
            val s = time(h.assignedAt) ?: return@forEach
            val until = time(h.guaranteeUntil)?.takeIf { it > now } ?: now
            spans += Triple(h, s, until)
        }
        return (0 until 24).map { h ->
            val start = day.atStartOfDay(zone).plusHours(h.toLong()).toInstant()
            val end = start.plus(HOUR)
            HourRow(start, spans.filter { it.second < end && it.third > start }.map { it.first })
        }
    }

    data class Mine(val walkin: ReservationOut?, val bookings: List<ReservationOut>)

    fun mine(pool: PoolOut, me: String?): Mine =
        Mine((pool.holders + pool.waiting).firstOrNull { it.id == pool.myReservationId }, live(pool).filter { it.userId == me })

    fun walkinText(row: ReservationOut, pool: PoolOut, now: Instant, zone: ZoneId): String {
        if (row.status == "waiting") return when (row.step) {
            "assign" -> row.until?.let { "空きあり (〜${whenText(it, now, zone)} まで) · 担当者の割り当て待ち" } ?: "空きあり · 担当者の割り当て待ち"
            "swap" -> if (row.ready) "まもなく担当者が割り当てます" else "前の人の保証時間の後に割り当てられます"
            else -> "順番待ち ${row.position ?: "?"} 番目"
        }
        if (row.status == "returning") return "返却済み · 担当者が外すのを待っています"
        row.evictAt?.let { return "${whenText(it, now, zone)} 以降に外されます" }
        return row.guaranteeUntil?.let { "利用中 (〜${whenText(it, now, zone)} まで保証)" } ?: "利用中"
    }

    fun bookingText(row: ReservationOut, now: Instant, zone: ZoneId): String {
        val s = span(row.startAt, row.endAt, now, zone)
        return when (row.status) {
            "holding" -> "$s · 利用中"
            "returning" -> "$s · 返却済み"
            else -> if (time(row.startAt)?.let { it <= now } == true) "$s · 開始 (担当者の割り当て待ち)" else s
        }
    }

    /** To-dos due now in the pools I operate (the tile's number). */
    fun todoCount(pools: List<PoolOut>): Int = pools.sumOf { pool -> pool.todos.count { !it.upcoming } }

    fun row(pool: PoolOut, id: String?): ReservationOut? =
        id?.let { pool.holders.firstOrNull { r -> r.id == it } ?: pool.waiting.firstOrNull { r -> r.id == it } ?: pool.bookings.firstOrNull { r -> r.id == it } }

    private val REASONS = mapOf("free" to "空きあり", "returned" to "返却済み", "booking_ended" to "予約時間が終了", "guarantee_over" to "保証時間が終了")

    fun todoLine(todo: ReservationTodo, pool: PoolOut, name: (String) -> String, now: Instant, zone: ZoneId): String {
        fun who(id: String?): String {
            val row = row(pool, id) ?: return "(不明)"
            return row.email?.let { "${name(row.userId)} さん ($it)" } ?: "${name(row.userId)} さん"
        }
        val target = row(pool, todo.assignId)
        val booked = if (target?.kind == "booking") " · 予約 ${span(target.startAt, target.endAt, now, zone)}" else ""
        val head = if (todo.upcoming) "${whenText(todo.dueAt, now, zone)} から: " else ""
        val reason = REASONS[todo.reason] ?: ""
        return when (todo.action) {
            "assign" -> "$head${who(todo.assignId)} に割り当てる$booked"
            "swap" -> "$head${who(todo.removeId)} を外して ${who(todo.assignId)} に割り当てる ($reason)$booked"
            else -> "$head${who(todo.removeId)} を外す ($reason)"
        }
    }

    fun todoButton(todo: ReservationTodo): String = when (todo.action) {
        "assign" -> "割り当てた"
        "remove" -> "外した"
        else -> "入れ替えた"
    }
}

private data class Confirm(val text: String, val label: String, val run: suspend () -> Unit)

/** 「予約」: per pool mine, 予約する / 今すぐ, the operators' to-do and a day's hours. Settings are on the desktop / web. */
@Composable
fun ReservationsPane(controller: AppController, version: Int) {
    val store = controller.store
    LaunchedEffect(Unit) { controller.engine?.loadReservationPools() }
    val pools = remember(version) { store.reservationPools }
    val zone = remember { ZoneId.systemDefault() }
    val now = remember(version) { Instant.now() }
    val scope = rememberCoroutineScope()
    var busy by remember { mutableStateOf(false) }
    var confirm by remember { mutableStateOf<Confirm?>(null) }
    var booking by remember { mutableStateOf<PoolOut?>(null) }
    val days = remember { mutableStateOf<Map<String, LocalDate>>(emptyMap()) }
    fun run(call: suspend () -> Unit) {
        if (busy) return
        busy = true
        scope.launch { try { call() } finally { busy = false } }
    }
    val name: (String) -> String = { id -> store.users[id]?.displayName ?: "(不明)" }
    if (pools == null) {
        Text("読み込み中…", modifier = Modifier.padding(16.dp), color = MaterialTheme.colorScheme.onSurfaceVariant)
        return
    }
    if (pools.isEmpty()) {
        Text("予約の枠はありません (枠は管理者が Desktop / Web で作ります)", modifier = Modifier.padding(16.dp), color = MaterialTheme.colorScheme.onSurfaceVariant)
        return
    }
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 32.dp)) {
        pools.forEach { pool ->
            val mine = ReservationRules.mine(pool, store.me?.id)
            item(key = "h:" + pool.id) {
                Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp)) {
                    Text(
                        "🎫 ${pool.name}" + if (!pool.enabled) " (停止中)" else "",
                        style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold, modifier = Modifier.semantics { heading() },
                    )
                    Text("${pool.capacity} 枠 · 予約は 1 回 ${pool.maxHours} 時間まで、2 週間先まで、1 人 2 件まで", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Row(Modifier.padding(top = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Button(onClick = { booking = pool }, enabled = pool.enabled && !busy && mine.bookings.size < 2 && !controller.isGuest) { Text("予約する") }
                        if (mine.walkin == null) {
                            OutlinedButton(onClick = { run { controller.reservePool(pool.id) } }, enabled = pool.enabled && !busy && !controller.isGuest) { Text("今すぐ (順番待ち)") }
                        }
                    }
                }
            }
            items(mine.bookings, key = { "b:" + it.id }) { row ->
                Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text(ReservationRules.bookingText(row, now, zone), Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium)
                    if (row.status == "booked" || row.status == "holding") {
                        TextButton(onClick = { run { controller.extendReservation(row.id) } }, enabled = row.canExtend && !busy) { Text("延長") }
                    }
                    if (row.status == "booked") {
                        TextButton(onClick = { confirm = Confirm("この予約を取り消しますか？", "取り消す") { controller.reservationAction(row.id, "cancel") } }, enabled = !busy) { Text("取り消す") }
                    } else if (row.status == "holding") {
                        TextButton(onClick = { confirm = Confirm("使い終わりましたか？ 担当者に外してもらいます。", "返却する") { controller.reservationAction(row.id, "return") } }, enabled = !busy) { Text("返却する") }
                    }
                }
            }
            mine.walkin?.let { row ->
                item(key = "w:" + row.id) {
                    Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                        Text("今すぐ: " + ReservationRules.walkinText(row, pool, now, zone), Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium)
                        if (row.status == "waiting") TextButton(onClick = { run { controller.reservationAction(row.id, "cancel") } }, enabled = !busy) { Text("取り消す") }
                        if (row.status == "holding") {
                            TextButton(onClick = { confirm = Confirm("使い終わりましたか？ 担当者に外してもらいます。", "返却する") { controller.reservationAction(row.id, "return") } }, enabled = !busy) { Text("返却する") }
                        }
                    }
                }
            }
            if (pool.canOperate) {
                item(key = "t:" + pool.id) {
                    Text("担当者の作業", style = MaterialTheme.typography.titleSmall, modifier = Modifier.padding(start = 16.dp, top = 12.dp, bottom = 4.dp))
                    if (pool.todos.isEmpty()) Text("今はありません", modifier = Modifier.padding(horizontal = 16.dp), color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                items(pool.todos, key = { "todo:" + pool.id + it.key }) { todo ->
                    val early = todo.upcoming && (ReservationRules.row(pool, todo.assignId)?.startAt?.let { runCatching { Instant.parse(it) }.getOrNull() }?.let { Duration.between(now, it).toMinutes() > 10 } ?: false)
                    Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            if (todo.upcoming) Text("まもなく", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.primary)
                            SelectionContainer { Text(ReservationRules.todoLine(todo, pool, name, now, zone), style = MaterialTheme.typography.bodyMedium) }
                        }
                        Spacer(Modifier.width(8.dp))
                        Button(onClick = {
                            when (todo.action) {
                                "assign" -> todo.assignId?.let { id -> run { controller.reservationAction(id, "assign") } }
                                "remove" -> todo.removeId?.let { id -> run { controller.reservationAction(id, "remove") } }
                                else -> {
                                    val out = todo.removeId; val into = todo.assignId
                                    if (out != null && into != null) confirm = Confirm("管理画面で入れ替えましたか？", "入れ替えた") { controller.swapReservations(pool.id, out, into) }
                                }
                            }
                        }, enabled = !busy && !early) { Text(ReservationRules.todoButton(todo)) }
                    }
                }
            }
            item(key = "d:" + pool.id) {
                val day = days.value[pool.id] ?: now.atZone(zone).toLocalDate()
                Column(Modifier.fillMaxWidth().padding(top = 12.dp)) {
                    Text("${pool.name} の空き", style = MaterialTheme.typography.titleSmall, modifier = Modifier.padding(start = 16.dp, bottom = 4.dp))
                    Row(Modifier.horizontalScroll(rememberScrollState()).padding(horizontal = 12.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        ReservationRules.days(now, pool.horizonDays, zone).forEach { d ->
                            FilterChip(selected = d == day, onClick = { days.value = days.value + (pool.id to d) }, label = { Text(ReservationRules.dayLabel(d, now, zone)) })
                        }
                    }
                    val hourNow = now.atZone(zone).truncatedTo(ChronoUnit.HOURS).toInstant()
                    ReservationRules.hours(pool, day, now, zone).filter { it.start >= hourNow || it.rows.isNotEmpty() }.forEach { hour ->
                        Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 2.dp)) {
                            Text(ReservationRules.hm(hour.start, zone), Modifier.width(52.dp), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            Text(
                                "${hour.rows.size}/${pool.capacity}", Modifier.width(40.dp), style = MaterialTheme.typography.labelMedium,
                                color = if (hour.rows.size >= pool.capacity) Color(0xFFD32F2F) else MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                            Text(hour.rows.joinToString("、") { name(it.userId) + if (it.kind == "walkin") " (今すぐ)" else "" }, style = MaterialTheme.typography.bodySmall, maxLines = 2)
                        }
                    }
                    HorizontalDivider(Modifier.padding(top = 12.dp))
                }
            }
        }
    }
    confirm?.let { which ->
        AlertDialog(
            onDismissRequest = { confirm = null },
            text = { Text(which.text) },
            confirmButton = { TextButton(onClick = { confirm = null; run { which.run() } }) { Text(which.label) } },
            dismissButton = { TextButton(onClick = { confirm = null }) { Text("キャンセル") } },
        )
    }
    booking?.let { pool -> BookingDialog(controller, pool, now, zone, onDismiss = { booking = null }) }
}

/** 「予約する」: a day, a start on the hour (full hours marked) and how long. */
@Composable
private fun BookingDialog(controller: AppController, pool: PoolOut, now: Instant, zone: ZoneId, onDismiss: () -> Unit) {
    val scope = rememberCoroutineScope()
    var day by remember { mutableStateOf(now.atZone(zone).toLocalDate()) }
    var start by remember { mutableStateOf<Instant?>(null) }
    var hours by remember { mutableStateOf(1) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val starts = ReservationRules.starts(pool, day, now, zone)
    val chosenStart = start?.takeIf { s -> starts.any { it.start == s && !it.full } } ?: starts.firstOrNull { !it.full }?.start
    val durations = chosenStart?.let { ReservationRules.durations(pool, it, now, zone) } ?: emptyList()
    val chosenHours = if (hours in durations) hours else durations.lastOrNull() ?: 1
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("${pool.name} を予約") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    ReservationRules.days(now, pool.horizonDays, zone).forEach { d ->
                        FilterChip(selected = d == day, onClick = { day = d; start = null }, label = { Text(ReservationRules.dayLabel(d, now, zone)) })
                    }
                }
                Text("開始", style = MaterialTheme.typography.labelMedium)
                Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    starts.forEach { choice ->
                        FilterChip(
                            selected = choice.start == chosenStart, enabled = !choice.full, onClick = { start = choice.start },
                            label = { Text(ReservationRules.hm(choice.start, zone) + if (choice.full) " (満)" else "") },
                        )
                    }
                }
                if (starts.none { !it.full }) Text("この日は空いている時間がありません", color = MaterialTheme.colorScheme.onSurfaceVariant)
                Text("時間", style = MaterialTheme.typography.labelMedium)
                Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    durations.forEach { h -> FilterChip(selected = h == chosenHours, onClick = { hours = h }, label = { Text("$h 時間") }) }
                }
                error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
            }
        },
        confirmButton = {
            TextButton(
                enabled = !busy && chosenStart != null && durations.isNotEmpty(),
                onClick = {
                    val at = chosenStart ?: return@TextButton
                    busy = true
                    scope.launch {
                        val out = controller.bookReservation(pool.id, at, chosenHours)
                        busy = false
                        if (out != null) onDismiss() else error = controller.error ?: "予約できませんでした"
                    }
                },
            ) { Text("予約する") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("キャンセル") } },
    )
}
