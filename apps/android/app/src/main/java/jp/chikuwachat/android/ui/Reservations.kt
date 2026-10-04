package jp.chikuwachat.android.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.ConfirmationNumber
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import java.time.Instant
import jp.chikuwachat.android.api.PoolOut
import jp.chikuwachat.android.api.ReservationOut
import jp.chikuwachat.android.app.AppController
import jp.chikuwachat.android.sync.ChannelState
import kotlinx.coroutines.launch

/** M99 (docs/RESERVATIONS.md §6): the pure parts of a channel's reservation pools (the chip's and the card's words). */
object ReservationRules {
    sealed interface Mine {
        data object None : Mine
        data class Waiting(val row: ReservationOut) : Mine
        data class Holding(val row: ReservationOut) : Mine
        data class Returning(val row: ReservationOut) : Mine
    }

    /** My request in the pool, if any. */
    fun mine(pool: PoolOut): Mine {
        val id = pool.myReservationId ?: return Mine.None
        pool.holders.firstOrNull { it.id == id }?.let { return if (it.status == "returning") Mine.Returning(it) else Mine.Holding(it) }
        pool.waiting.firstOrNull { it.id == id }?.let { return Mine.Waiting(it) }
        return Mine.None
    }

    /** 「2/3 · 待ち 1」. */
    fun summary(pool: PoolOut): String {
        val base = "${pool.holders.size}/${pool.capacity}"
        return if (pool.waiting.isEmpty()) base else "$base · 待ち ${pool.waiting.size}"
    }

    /** What my chip says about me (empty when I am not in the pool). */
    fun myStatus(pool: PoolOut, whenText: (String?) -> String = { Recurring.shortDateTime(it) }): String = when (val mine = mine(pool)) {
        Mine.None -> ""
        is Mine.Waiting -> "待ち ${mine.row.position ?: "?"} 番目"
        is Mine.Returning -> "返却中"
        is Mine.Holding -> when {
            mine.row.evictAt != null -> "${whenText(mine.row.evictAt)} 以降に外されます"
            mine.row.guaranteeUntil != null -> "利用中 (保証 ${whenText(mine.row.guaranteeUntil)} まで)"
            else -> "利用中"
        }
    }

    /** Whether my chip should stand out: I am about to lose the seat, or a seat is ready for me. */
    fun urgent(pool: PoolOut): Boolean = when (val mine = mine(pool)) {
        is Mine.Holding -> mine.row.evictAt != null
        is Mine.Waiting -> mine.row.ready
        else -> false
    }

    /** The line under a waiting member. */
    fun waiterLine(row: ReservationOut, pool: PoolOut, name: (String) -> String, whenText: (String?) -> String = { Recurring.shortDateTime(it) }): String {
        val since = "${whenText(row.requestedAt)} に予約"
        return when (row.step) {
            "assign" -> "$since · 空きあり (担当者の割り当て待ち)"
            "swap" -> {
                val holder = pool.holders.firstOrNull { it.id == row.pairId }
                val who = holder?.let { "${name(it.userId)} さん" } ?: "前の人"
                when {
                    holder?.status == "returning" -> "$since · ${who}の返却分 (担当者が外し次第)"
                    row.ready -> "$since · ${who}と入れ替えできます"
                    holder?.evictAt != null -> "$since · ${who}の後 (${whenText(holder.evictAt)} 以降)"
                    else -> "$since · ${who}の後"
                }
            }
            else -> "$since · 保証時間が過ぎる人を待っています"
        }
    }

    /** The line under a holder. */
    fun holderLine(row: ReservationOut, whenText: (String?) -> String = { Recurring.shortDateTime(it) }): String =
        listOfNotNull(row.assignedAt?.let { "${whenText(it)} から" }, row.guaranteeUntil?.let { "保証 ${whenText(it)} まで" }).joinToString(" · ")

    /** A holder's state at a glance; `danger` for the ones about to go. */
    fun holderBadge(row: ReservationOut, pool: PoolOut, now: Instant = Instant.now(), whenText: (String?) -> String = { Recurring.shortDateTime(it) }): Pair<String, Boolean>? {
        if (row.status == "returning") return "返却済み · 外し待ち" to false
        if (row.evictAt != null) return if (row.ready) "入れ替えできます" to true else "${whenText(row.evictAt)} 以降に外す" to true
        if (pool.nextEvictId == row.id) return "次に外す" to false
        val until = Recurring.instant(row.guaranteeUntil)
        if (until != null && !until.isAfter(now)) return "保証時間終了" to false
        return null
    }

    /** Before the guarantee ends: 「外した」 asks louder. */
    fun early(row: ReservationOut, now: Instant = Instant.now()): Boolean {
        if (row.status != "holding" || row.evictAt != null) return false
        val until = Recurring.instant(row.guaranteeUntil) ?: return false
        return until.isAfter(now)
    }
}

/** The channel's pools as chips at the top of the conversation; nothing when it has none. A chip opens the pool's card. */
@Composable
fun ReservationChipRow(controller: AppController, channel: ChannelState, version: Int) {
    val pools = remember(version, channel.id) {
        controller.store.poolsOf(channel.id).filter { it.enabled || it.holders.isNotEmpty() || it.waiting.isNotEmpty() }
    }
    var openId by remember(channel.id) { mutableStateOf<String?>(null) }
    if (pools.isNotEmpty()) {
        Row(
            Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 12.dp, vertical = 2.dp),
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            pools.forEach { pool ->
                val status = ReservationRules.myStatus(pool)
                AssistChip(
                    onClick = { openId = pool.id },
                    leadingIcon = { Icon(Icons.Outlined.ConfirmationNumber, contentDescription = null, modifier = Modifier.size(16.dp)) },
                    label = {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(pool.name, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            Spacer(Modifier.width(4.dp))
                            Text(ReservationRules.summary(pool), color = MaterialTheme.colorScheme.onSurfaceVariant)
                            if (status.isNotEmpty()) {
                                Spacer(Modifier.width(4.dp))
                                Text(
                                    "· $status",
                                    color = if (ReservationRules.urgent(pool)) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.primary,
                                    maxLines = 1,
                                )
                            }
                        }
                    },
                )
            }
        }
        HorizontalDivider()
    }
    val open = openId?.let { id -> controller.store.poolsOf(channel.id).firstOrNull { it.id == id } }
    if (openId != null && open != null) ReservationSheet(controller, channel, open) { openId = null }
}

private data class Confirm(val text: String, val label: String, val destructive: Boolean = false, val run: suspend () -> Unit)

/** One pool's card: holders, the queue, my status and buttons; operators also assign / remove / swap / cancel. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ReservationSheet(controller: AppController, channel: ChannelState, pool: PoolOut, onDismiss: () -> Unit) {
    val sheet = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    val scope = rememberCoroutineScope()
    var busy by remember { mutableStateOf(false) }
    var confirm by remember { mutableStateOf<Confirm?>(null) }
    fun name(userId: String) = controller.store.users[userId]?.displayName ?: "(不明)"
    fun run(block: suspend () -> Unit) {
        if (busy) return
        busy = true
        scope.launch { try { block() } finally { busy = false } }
    }
    val operate = pool.canOperate && !channel.channel.archived

    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = sheet) {
        Column(
            Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).navigationBarsPadding().padding(horizontal = 20.dp).padding(bottom = 24.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Text(pool.name, style = MaterialTheme.typography.titleMedium)
            MineRow(controller, channel, pool, busy, ::run) { confirm = it }
            Text("利用中 ${pool.holders.size}/${pool.capacity}", style = MaterialTheme.typography.labelLarge)
            if (pool.holders.isEmpty()) Text("いません", color = MaterialTheme.colorScheme.onSurfaceVariant)
            pool.holders.forEach { row ->
                PersonRow(row, name(row.userId), row.id == pool.myReservationId, ReservationRules.holderLine(row), ReservationRules.holderBadge(row, pool)) {
                    if (operate) {
                        val early = ReservationRules.early(row)
                        val action = {
                            confirm = Confirm(
                                if (early) "${name(row.userId)} さんはまだ保証時間内です。管理画面で外しましたか？" else "${name(row.userId)} さんを管理画面で外しましたか？",
                                "外した", destructive = early,
                            ) { controller.reservationAction(row.id, "remove") }
                        }
                        if (row.ready) Button(onClick = action, enabled = !busy) { Text("外した") }
                        else OutlinedButton(onClick = action, enabled = !busy) { Text("外した") }
                    }
                }
            }
            Text("待ち ${pool.waiting.size} 人", style = MaterialTheme.typography.labelLarge)
            if (pool.waiting.isEmpty()) Text("いません", color = MaterialTheme.colorScheme.onSurfaceVariant)
            pool.waiting.forEach { row ->
                val holder = if (row.step == "swap") pool.holders.firstOrNull { it.id == row.pairId } else null
                PersonRow(row, name(row.userId), row.id == pool.myReservationId, ReservationRules.waiterLine(row, pool, ::name), null) {
                    if (operate) {
                        Column(horizontalAlignment = Alignment.End) {
                            if (row.step == "assign") {
                                Button(onClick = { run { controller.reservationAction(row.id, "assign") } }, enabled = !busy) { Text("割り当てた") }
                            }
                            if (holder != null && row.ready) {
                                Button(onClick = {
                                    confirm = Confirm("管理画面で ${name(holder.userId)} さんを外して ${name(row.userId)} さんを割り当てましたか？", "入れ替えた") {
                                        controller.swapReservations(pool.id, holder.id, row.id)
                                    }
                                }, enabled = !busy) { Text("入れ替えた") }
                            }
                            if (row.id != pool.myReservationId) {
                                TextButton(onClick = {
                                    confirm = Confirm("${name(row.userId)} さんの予約を取り消しますか？ 本人に知らせます。", "取り消す", destructive = true) {
                                        controller.reservationAction(row.id, "cancel")
                                    }
                                }, enabled = !busy) { Text("取り消す") }
                            }
                        }
                    }
                }
            }
            Text(
                "割り当てから ${pool.minHours} 時間は外されません。過ぎた後に待つ人がいれば、保証の終わりが早い人から ${pool.graceMinutes} 分の猶予の後に入れ替えます。" +
                    if (pool.canOperate) " 担当者の操作は、管理画面で実際に変えた後に押してください。" else "",
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
    confirm?.let { which ->
        AlertDialog(
            onDismissRequest = { confirm = null },
            text = { Text(which.text) },
            confirmButton = {
                TextButton(onClick = { confirm = null; run { which.run() } }) {
                    Text(which.label, color = if (which.destructive) MaterialTheme.colorScheme.error else Color.Unspecified)
                }
            },
            dismissButton = { TextButton(onClick = { confirm = null }) { Text("キャンセル") } },
        )
    }
}

@Composable
private fun MineRow(controller: AppController, channel: ChannelState, pool: PoolOut, busy: Boolean, run: (suspend () -> Unit) -> Unit, ask: (Confirm) -> Unit) {
    val canReserve = pool.enabled && channel.isMember && !channel.channel.archived && !controller.isGuest
    Column(
        Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape(10.dp)).padding(horizontal = 12.dp, vertical = 8.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            when (val mine = ReservationRules.mine(pool)) {
                ReservationRules.Mine.None -> {
                    Text(if (pool.enabled) "予約していません" else "この枠は今は予約を受け付けていません", Modifier.weight(1f))
                    if (canReserve) Button(onClick = { run { controller.reservePool(pool.id) } }, enabled = !busy) { Text("予約する") }
                }
                is ReservationRules.Mine.Waiting -> {
                    Text("予約中: 待ち ${mine.row.position ?: "?"} 番目" + if (mine.row.step == "assign") " (空きあり)" else "", Modifier.weight(1f))
                    OutlinedButton(onClick = { run { controller.reservationAction(mine.row.id, "cancel") } }, enabled = !busy) { Text("取り消す") }
                }
                is ReservationRules.Mine.Holding -> {
                    Text(mine.row.guaranteeUntil?.let { "利用中 · 保証 ${Recurring.shortDateTime(it)} まで" } ?: "利用中", Modifier.weight(1f))
                    OutlinedButton(onClick = {
                        ask(Confirm("「${pool.name}」を返却しますか？ 担当者が外します。", "返却する") { controller.reservationAction(mine.row.id, "return") })
                    }, enabled = !busy) { Text("返却する") }
                }
                is ReservationRules.Mine.Returning -> Text("返却しました。担当者が外すのを待っています", Modifier.weight(1f))
            }
        }
        val holding = ReservationRules.mine(pool) as? ReservationRules.Mine.Holding
        holding?.row?.evictAt?.let {
            Text("待っている人がいます。${Recurring.shortDateTime(it)} 以降に担当者が外します", color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
        }
    }
}

@Composable
private fun PersonRow(row: ReservationOut, name: String, mine: Boolean, line: String, badge: Pair<String, Boolean>?, buttons: @Composable () -> Unit) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.Top) {
        Avatar(row.userId, name, size = 28.dp)
        Spacer(Modifier.width(10.dp))
        Column(Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(name, fontWeight = FontWeight.Medium)
                if (mine) Text("(自分)", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                row.position?.let { Text("$it 番目", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                badge?.let { (text, danger) ->
                    val tone = if (danger) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.primary
                    Text(
                        text, color = tone, style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.Bold,
                        modifier = Modifier.background(tone.copy(alpha = 0.12f), RoundedCornerShape(50)).padding(horizontal = 6.dp, vertical = 2.dp),
                    )
                }
            }
            row.email?.let { SelectionContainer { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) } }
            Text(line, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        buttons()
    }
}
