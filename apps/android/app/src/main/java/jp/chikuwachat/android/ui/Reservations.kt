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
import androidx.compose.foundation.lazy.rememberLazyListState
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
import jp.chikuwachat.android.R
import jp.chikuwachat.android.L10n
import androidx.compose.ui.res.stringResource

/**
 * M112 (docs/RESERVATIONS.md §6): the pure parts of 「予約」 — the booking choices, a day's hours, my reservations, the
 * operators' to-do and the words (the web's ui/reservationPools.ts). Times are the device's (`zone`).
 */
object ReservationRules {
    private val HOUR: Duration = Duration.ofHours(1)
    private val WEEKDAYS: List<String> get() = L10n.weekdaysMondayFirst

    private fun time(iso: String?): Instant? = iso?.let { runCatching { Instant.parse(it) }.getOrNull() ?: runCatching { java.time.OffsetDateTime.parse(it).toInstant() }.getOrNull() }

    fun days(now: Instant, horizonDays: Int, zone: ZoneId): List<LocalDate> {
        val today = now.atZone(zone).toLocalDate()
        return (0..horizonDays).map { today.plusDays(it.toLong()) }
    }

    /** 「今日」 「明日」 or 「10/7 (水)」. */
    fun dayLabel(day: LocalDate, now: Instant, zone: ZoneId): String {
        val diff = ChronoUnit.DAYS.between(now.atZone(zone).toLocalDate(), day)
        return when (diff) {
            0L -> L10n.str(R.string.common_today)
            1L -> L10n.str(R.string.reservations_tomorrow)
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
        return L10n.str(R.string.reservations_time_span, prefix, hm(start, zone), hm(end, zone))
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

    enum class Limit { MAX, FULL, HORIZON }

    /** The dialog's default length: the pool's max_hours, or the longest that fits from `start`, and why it stops. */
    data class DurationDefault(val hours: Int, val limit: Limit, val at: Instant?)

    fun durationDefault(pool: PoolOut, start: Instant, now: Instant, zone: ZoneId): DurationDefault {
        val hours = durations(pool, start, now, zone).size
        if (hours >= pool.maxHours) return DurationDefault(hours, Limit.MAX, null)
        val at = start.plus(HOUR.multipliedBy(hours.toLong()))
        val pastHorizon = at.plus(HOUR) > horizonEnd(pool, now, zone)
        return DurationDefault(hours, if (pastHorizon) Limit.HORIZON else Limit.FULL, at)
    }

    /** Why the default is shorter than the maximum (null when it is the maximum). */
    fun limitText(fit: DurationDefault, pool: PoolOut, start: Instant, zone: ZoneId): String? {
        val at = fit.at ?: return null
        if (fit.hours <= 0) return null
        return when (fit.limit) {
            Limit.MAX -> null
            Limit.FULL -> {
                val day = at.atZone(zone).toLocalDate()
                val whenText = if (day == start.atZone(zone).toLocalDate()) hm(at, zone) else "${dayLabel(day, start, zone)} ${hm(at, zone)}"
                L10n.str(R.string.reservations_limit_full, whenText, fit.hours)
            }
            Limit.HORIZON -> L10n.str(R.string.reservations_limit_horizon, pool.horizonDays, fit.hours)
        }
    }

    /**
     * My one active reservation in the pool (one per person and pool, docs/RESERVATIONS.md §1): while there is one,
     * 「予約する」 and 「今すぐ」 are off (the server answers 409 reservation_already_active). Read from the lists when the
     * server does not name it.
     */
    fun active(pool: PoolOut, me: String?): ReservationOut? {
        val rows = pool.holders + pool.waiting + live(pool)
        pool.myActiveId?.let { id -> return rows.firstOrNull { it.id == id } }
        return rows.firstOrNull { it.userId == me }
    }

    /** 「予約 10/7 (水) 13:00〜16:00」, 「今すぐ · 順番待ち」, 「今すぐ · 利用中」. */
    fun activeText(row: ReservationOut, now: Instant, zone: ZoneId): String {
        val head = if (row.kind == "booking" && row.startAt != null) L10n.str(R.string.reservations_active_booking, span(row.startAt, row.endAt, now, zone))
            else L10n.str(R.string.reservations_walkin_label)
        val state = when (row.status) {
            "waiting" -> L10n.str(R.string.reservations_waiting_state)
            "holding" -> L10n.str(R.string.reservations_in_use)
            "returning" -> L10n.str(R.string.reservations_returned_2)
            else -> null
        }
        return state?.let { "$head · $it" } ?: head
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
            "assign" -> row.until?.let { L10n.str(R.string.reservations_available_until_waiting_for_an_operator, whenText(it, now, zone)) } ?: L10n.str(R.string.reservations_available_waiting_for_an_operator_to)
            "swap" -> if (row.ready) L10n.str(R.string.reservations_an_operator_will_assign_it_shortly) else L10n.str(R.string.reservations_it_will_be_assigned_after_the)
            else -> L10n.str(R.string.reservations_number_in_line, row.position ?: "?")
        }
        if (row.status == "returning") return L10n.str(R.string.reservations_returned_waiting_for_an_operator_to)
        row.evictAt?.let { return L10n.str(R.string.reservations_will_be_removed_after, whenText(it, now, zone)) }
        return row.guaranteeUntil?.let { L10n.str(R.string.reservations_in_use_guaranteed_until, whenText(it, now, zone)) } ?: L10n.str(R.string.reservations_in_use)
    }

    fun bookingText(row: ReservationOut, now: Instant, zone: ZoneId): String {
        val s = span(row.startAt, row.endAt, now, zone)
        return when (row.status) {
            "holding" -> L10n.str(R.string.reservations_in_use_2, s)
            "returning" -> L10n.str(R.string.reservations_returned, s)
            else -> if (time(row.startAt)?.let { it <= now } == true) L10n.str(R.string.reservations_started_waiting_for_an_operator_to, s) else s
        }
    }

    /** To-dos due now in the pools I operate (the tile's number). */
    fun todoCount(pools: List<PoolOut>): Int = pools.sumOf { pool -> pool.todos.count { !it.upcoming } }

    fun row(pool: PoolOut, id: String?): ReservationOut? =
        id?.let { pool.holders.firstOrNull { r -> r.id == it } ?: pool.waiting.firstOrNull { r -> r.id == it } ?: pool.bookings.firstOrNull { r -> r.id == it } }

    private val REASONS get() = mapOf("free" to L10n.str(R.string.reservations_available), "returned" to L10n.str(R.string.reservations_returned_2), "booking_ended" to L10n.str(R.string.reservations_booking_ended), "guarantee_over" to L10n.str(R.string.reservations_guaranteed_time_ended))

    fun todoLine(todo: ReservationTodo, pool: PoolOut, name: (String) -> String, now: Instant, zone: ZoneId): String {
        fun who(id: String?): String {
            val row = row(pool, id) ?: return L10n.str(R.string.reservations_unknown)
            return row.email?.let { L10n.str(R.string.reservations_person_with_email, name(row.userId), it) } ?: L10n.str(R.string.reservations_person, name(row.userId))
        }
        val target = row(pool, todo.assignId)
        val booked = if (target?.kind == "booking") L10n.str(R.string.reservations_booking, span(target.startAt, target.endAt, now, zone)) else ""
        val head = if (todo.upcoming) L10n.str(R.string.reservations_from, whenText(todo.dueAt, now, zone)) else ""
        val reason = REASONS[todo.reason] ?: ""
        return when (todo.action) {
            "assign" -> L10n.str(R.string.reservations_assign_to, head, who(todo.assignId), booked)
            "swap" -> L10n.str(R.string.reservations_remove_and_assign_to, head, who(todo.removeId), who(todo.assignId), reason, booked)
            else -> L10n.str(R.string.reservations_remove, head, who(todo.removeId), reason)
        }
    }

    fun todoButton(todo: ReservationTodo): String = when (todo.action) {
        "assign" -> L10n.str(R.string.reservations_assigned)
        "remove" -> L10n.str(R.string.reservations_removed)
        else -> L10n.str(R.string.reservations_swapped)
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
    val name: (String) -> String = { id -> store.users[id]?.displayName ?: L10n.str(R.string.reservations_unknown) }
    if (pools == null) {
        Text(stringResource(R.string.common_loading), modifier = Modifier.padding(16.dp), color = MaterialTheme.colorScheme.onSurfaceVariant)
        return
    }
    if (pools.isEmpty()) {
        Text(stringResource(R.string.reservations_no_reservation_slots_an_administrator), modifier = Modifier.padding(16.dp), color = MaterialTheme.colorScheme.onSurfaceVariant)
        return
    }
    val listState = rememberLazyListState()
    // The list's keys in order (the same as the items below), to scroll to one of my rows (「自分の予約を見る」).
    val keys = pools.flatMap { pool ->
        val mine = ReservationRules.mine(pool, store.me?.id)
        listOf("h:" + pool.id) + mine.bookings.map { "b:" + it.id } + listOfNotNull(mine.walkin?.let { "w:" + it.id }) +
            (if (pool.canOperate) listOf("t:" + pool.id) + pool.todos.map { "todo:" + pool.id + it.key } else emptyList()) + listOf("d:" + pool.id)
    }
    LazyColumn(Modifier.fillMaxSize(), state = listState, contentPadding = PaddingValues(bottom = 32.dp)) {
        pools.forEach { pool ->
            val mine = ReservationRules.mine(pool, store.me?.id)
            // One active reservation per person and pool: while I have one, both buttons are off and say why.
            val active = ReservationRules.active(pool, store.me?.id)
            item(key = "h:" + pool.id) {
                Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp)) {
                    Text(
                        "🎫 ${pool.name}" + if (!pool.enabled) stringResource(R.string.reservations_paused) else "",
                        style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold, modifier = Modifier.semantics { heading() },
                    )
                    Text(stringResource(R.string.reservations_slots_up_to_hours_per_booking, pool.capacity, pool.maxHours), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Row(Modifier.padding(top = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Button(onClick = { booking = pool }, enabled = pool.enabled && !busy && active == null && !controller.isGuest) { Text(stringResource(R.string.reservations_book)) }
                        if (mine.walkin == null) {
                            OutlinedButton(onClick = { run { controller.reservePool(pool.id) } }, enabled = pool.enabled && !busy && active == null && !controller.isGuest) { Text(stringResource(R.string.reservations_now_join_the_line)) }
                        }
                    }
                    active?.let { row ->
                        Text(
                            stringResource(R.string.reservations_already_active, ReservationRules.activeText(row, now, zone)),
                            Modifier.padding(top = 6.dp), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        TextButton(onClick = {
                            val index = keys.indexOf((if (row.kind == "walkin") "w:" else "b:") + row.id)
                            if (index >= 0) scope.launch { listState.animateScrollToItem(index) }
                        }, contentPadding = PaddingValues(0.dp)) { Text(stringResource(R.string.reservations_show_mine), style = MaterialTheme.typography.bodySmall) }
                    }
                }
            }
            items(mine.bookings, key = { "b:" + it.id }) { row ->
                Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text(ReservationRules.bookingText(row, now, zone), Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium)
                    if (row.status == "booked" || row.status == "holding") {
                        TextButton(onClick = { run { controller.extendReservation(row.id) } }, enabled = row.canExtend && !busy) { Text(stringResource(R.string.reservations_extend)) }
                    }
                    if (row.status == "booked") {
                        TextButton(onClick = { confirm = Confirm(L10n.str(R.string.reservations_cancel_this_booking), L10n.str(R.string.reservations_cancel_booking)) { controller.reservationAction(row.id, "cancel") } }, enabled = !busy) { Text(stringResource(R.string.reservations_cancel_booking)) }
                    } else if (row.status == "holding") {
                        TextButton(onClick = { confirm = Confirm(L10n.str(R.string.reservations_done_using_it_an_operator_will), L10n.str(R.string.reservations_return)) { controller.reservationAction(row.id, "return") } }, enabled = !busy) { Text(stringResource(R.string.reservations_return)) }
                    }
                }
            }
            mine.walkin?.let { row ->
                item(key = "w:" + row.id) {
                    Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                        Text(stringResource(R.string.reservations_now) + ReservationRules.walkinText(row, pool, now, zone), Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium)
                        if (row.status == "waiting") TextButton(onClick = { run { controller.reservationAction(row.id, "cancel") } }, enabled = !busy) { Text(stringResource(R.string.reservations_cancel_booking)) }
                        if (row.status == "holding") {
                            TextButton(onClick = { confirm = Confirm(L10n.str(R.string.reservations_done_using_it_an_operator_will), L10n.str(R.string.reservations_return)) { controller.reservationAction(row.id, "return") } }, enabled = !busy) { Text(stringResource(R.string.reservations_return)) }
                        }
                    }
                }
            }
            if (pool.canOperate) {
                item(key = "t:" + pool.id) {
                    Text(stringResource(R.string.reservations_operator_tasks), style = MaterialTheme.typography.titleSmall, modifier = Modifier.padding(start = 16.dp, top = 12.dp, bottom = 4.dp))
                    if (pool.todos.isEmpty()) Text(stringResource(R.string.reservations_nothing_right_now), modifier = Modifier.padding(horizontal = 16.dp), color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                items(pool.todos, key = { "todo:" + pool.id + it.key }) { todo ->
                    val early = todo.upcoming && (ReservationRules.row(pool, todo.assignId)?.startAt?.let { runCatching { Instant.parse(it) }.getOrNull() }?.let { Duration.between(now, it).toMinutes() > 10 } ?: false)
                    Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            if (todo.upcoming) Text(stringResource(R.string.reservations_soon), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.primary)
                            SelectionContainer { Text(ReservationRules.todoLine(todo, pool, name, now, zone), style = MaterialTheme.typography.bodyMedium) }
                        }
                        Spacer(Modifier.width(8.dp))
                        Button(onClick = {
                            when (todo.action) {
                                "assign" -> todo.assignId?.let { id -> run { controller.reservationAction(id, "assign") } }
                                "remove" -> todo.removeId?.let { id -> run { controller.reservationAction(id, "remove") } }
                                else -> {
                                    val out = todo.removeId; val into = todo.assignId
                                    if (out != null && into != null) confirm = Confirm(L10n.str(R.string.reservations_did_you_swap_them_in_the), L10n.str(R.string.reservations_swapped)) { controller.swapReservations(pool.id, out, into) }
                                }
                            }
                        }, enabled = !busy && !early) { Text(ReservationRules.todoButton(todo)) }
                    }
                }
            }
            item(key = "d:" + pool.id) {
                val day = days.value[pool.id] ?: now.atZone(zone).toLocalDate()
                Column(Modifier.fillMaxWidth().padding(top = 12.dp)) {
                    Text(stringResource(R.string.reservations_availability, pool.name), style = MaterialTheme.typography.titleSmall, modifier = Modifier.padding(start = 16.dp, bottom = 4.dp))
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
                            Text(hour.rows.joinToString(stringResource(R.string.common_list_separator)) { name(it.userId) + if (it.kind == "walkin") L10n.str(R.string.reservations_now_2) else "" }, style = MaterialTheme.typography.bodySmall, maxLines = 2)
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
            dismissButton = { TextButton(onClick = { confirm = null }) { Text(stringResource(R.string.common_cancel)) } },
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
    // A length picked by hand (kept while it fits); null = the default (the maximum, or the longest that fits).
    var hours by remember { mutableStateOf<Int?>(null) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val starts = ReservationRules.starts(pool, day, now, zone)
    val chosenStart = start?.takeIf { s -> starts.any { it.start == s && !it.full } } ?: starts.firstOrNull { !it.full }?.start
    val durations = chosenStart?.let { ReservationRules.durations(pool, it, now, zone) } ?: emptyList()
    val chosenHours = hours?.takeIf { it in durations } ?: durations.lastOrNull() ?: 1
    val limit = chosenStart?.let { s -> ReservationRules.limitText(ReservationRules.durationDefault(pool, s, now, zone), pool, s, zone) }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.reservations_book_2, pool.name)) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    ReservationRules.days(now, pool.horizonDays, zone).forEach { d ->
                        FilterChip(selected = d == day, onClick = { day = d; start = null }, label = { Text(ReservationRules.dayLabel(d, now, zone)) })
                    }
                }
                Text(stringResource(R.string.common_start), style = MaterialTheme.typography.labelMedium)
                Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    starts.forEach { choice ->
                        FilterChip(
                            selected = choice.start == chosenStart, enabled = !choice.full, onClick = { start = choice.start },
                            label = { Text(ReservationRules.hm(choice.start, zone) + if (choice.full) stringResource(R.string.reservations_full) else "") },
                        )
                    }
                }
                if (starts.none { !it.full }) Text(stringResource(R.string.reservations_no_free_times_on_this_day), color = MaterialTheme.colorScheme.onSurfaceVariant)
                Text(stringResource(R.string.reservations_duration), style = MaterialTheme.typography.labelMedium)
                Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    durations.forEach { h -> FilterChip(selected = h == chosenHours, onClick = { hours = h }, label = { Text(stringResource(R.string.common_h, h)) }) }
                }
                limit?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
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
                        if (out != null) onDismiss() else error = controller.error ?: L10n.str(R.string.reservations_couldnt_book)
                    }
                },
            ) { Text(stringResource(R.string.reservations_book)) }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text(stringResource(R.string.common_cancel)) } },
    )
}
