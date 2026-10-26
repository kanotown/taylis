package jp.chikuwachat.android.ui

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Inventory2
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.DatePicker
import androidx.compose.material3.DatePickerDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.SelectableDates
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberDatePickerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import java.text.Normalizer
import java.time.Instant
import java.time.LocalDate
import java.time.OffsetDateTime
import java.time.ZoneId
import java.time.ZoneOffset
import java.time.temporal.ChronoUnit
import java.util.UUID
import jp.chikuwachat.android.L10n
import jp.chikuwachat.android.R
import jp.chikuwachat.android.api.ActivityLending
import jp.chikuwachat.android.api.ApiException
import jp.chikuwachat.android.api.AttachmentOut
import jp.chikuwachat.android.api.ErrorTexts
import jp.chikuwachat.android.api.LendingApproversOut
import jp.chikuwachat.android.api.LendingCategoryOut
import jp.chikuwachat.android.api.LendingItemOut
import jp.chikuwachat.android.api.LendingLoanBriefOut
import jp.chikuwachat.android.api.LendingLoanOut
import jp.chikuwachat.android.api.LendingSettingsOut
import jp.chikuwachat.android.api.LendingSummaryOut
import jp.chikuwachat.android.app.AppController
import jp.chikuwachat.android.platform.LendingTarget
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * M172 (docs/LENDING.md §12.3, L6): the pure parts of 「備品」 on the phone — the tile's number, the words of a status, a
 * due date and an activity row, the dates a borrow or an extension may pick (in the workspace's zone, §8.1), the local
 * filter of the list, the teacher's choices and the errors worth their own sentence. Tested in LendingTest.
 */
object LendingRules {
    /** §12.1: my overdue loans, and for a keeper also the loans needing their attention (red when any). */
    fun tileCount(summary: LendingSummaryOut): Int =
        summary.myOverdueCount + if (summary.isKeeper) summary.keeperAttentionCount else 0

    /** The notification's key: the server's collapse key (one per loan; per item for one back from repair; one summary). */
    fun notificationKey(target: LendingTarget): String =
        target.loanId?.let { "lending:loan:$it" } ?: target.itemId?.let { "lending:item:$it" } ?: "lending:overdue"

    /** The bar's title: 「備品」 on the list, the item's name on its page and on a loan's (once read). */
    fun barTitle(route: Route.Lending, titles: Map<String, String>): String =
        (route.loanId ?: route.itemId)?.let { titles[it] } ?: L10n.str(R.string.lending_title)

    /** An activity row's headline: the item (「備品」 for the keepers' summary) and why I got it. */
    fun activityLead(item: ActivityLending): String {
        val name = item.itemName?.takeIf { it.isNotBlank() } ?: L10n.str(R.string.lending_title)
        val why = when (item.role) {
            "approver" -> L10n.str(R.string.lending_role_approver)
            "keeper" -> L10n.str(R.string.lending_role_keeper)
            "watcher" -> L10n.str(R.string.lending_role_watcher)
            else -> L10n.str(R.string.lending_role_borrower)
        }
        return L10n.str(R.string.lending_activity_lead, name, why)
    }

    /** The teacher's to-do is done (decided, or 14 days after the return; activity.updated names it before a reread). */
    fun activityDone(item: ActivityLending?, blanked: Set<String>): Boolean =
        item != null && item.role == "approver" && (item.done || item.itemId in blanked)

    /** Whether the row carries 「許可していない」 / 「確認した」: the teacher's open to-do of a loan. */
    fun showsDecision(item: ActivityLending, blanked: Set<String>): Boolean =
        item.role == "approver" && item.loanId != null && !activityDone(item, blanked)

    fun zone(settings: LendingSettingsOut?): ZoneId =
        runCatching { ZoneId.of(settings?.tz ?: "Asia/Tokyo") }.getOrDefault(ZoneId.of("Asia/Tokyo"))

    /** Today in the workspace's zone (the due dates' calendar, §8.1). */
    fun today(now: Instant, zone: ZoneId): LocalDate = now.atZone(zone).toLocalDate()

    fun date(iso: String?): LocalDate? = iso?.let { runCatching { LocalDate.parse(it.take(10)) }.getOrNull() }

    fun instant(iso: String?): Instant? = iso?.let {
        runCatching { Instant.parse(it) }.getOrNull() ?: runCatching { OffsetDateTime.parse(it).toInstant() }.getOrNull()
    }

    /** 「10/30 (木)」. */
    fun dayLabel(day: LocalDate): String = "${day.monthValue}/${day.dayOfMonth} (${L10n.weekdaysMondayFirst[day.dayOfWeek.value - 1]})"

    /** 「10/16」: a time (borrowed, returned) as its day in the workspace's zone. */
    fun shortDay(iso: String?, zone: ZoneId): String = instant(iso)?.atZone(zone)?.toLocalDate()?.let { "${it.monthValue}/${it.dayOfMonth}" } ?: ""

    /** 「10/30 (木) まで」, 「10/30 (木) まで · 2 日過ぎ」. */
    fun dueText(dueOn: String, overdueDays: Int): String {
        val day = date(dueOn)?.let(::dayLabel) ?: dueOn
        val until = L10n.str(R.string.lending_until, day)
        return if (overdueDays > 0) L10n.str(R.string.lending_due_overdue, until, overdueDays) else until
    }

    fun statusLabel(status: String): String = when (status) {
        "available" -> L10n.str(R.string.lending_status_available)
        "on_loan" -> L10n.str(R.string.lending_status_on_loan)
        "in_repair" -> L10n.str(R.string.lending_status_in_repair)
        "retired" -> L10n.str(R.string.lending_status_retired)
        else -> L10n.str(R.string.lending_unknown)
    }

    /** §12.2: a dot's colour (green available, blue on loan, grey in repair or retired; red once overdue). */
    fun statusColor(status: String, overdue: Boolean): Color = when {
        overdue -> Color(0xFFD32F2F)
        status == "available" -> Color(0xFF2E7D32)
        status == "on_loan" -> Color(0xFF1565C0)
        else -> Color(0xFF9E9E9E)
    }

    /** The dates a borrow may pick (§4.2): today … today + the item's max_days; the default is the latest. */
    fun borrowRange(item: LendingItemOut, today: LocalDate): ClosedRange<LocalDate> = today..today.plusDays(maxOf(0, item.maxDays).toLong())

    /** The dates the borrower may extend to (§6.5): the day after the current due date … latest_due_on; null when none. */
    fun extendRange(loan: LendingLoanOut): ClosedRange<LocalDate>? {
        val due = date(loan.dueOn) ?: return null
        val latest = date(loan.latestDueOn) ?: return null
        val first = due.plusDays(1)
        return if (latest < first) null else first..latest
    }

    /** 「あと 1 回延長できます」's number (null without the settings). */
    fun extensionsLeft(loan: LendingLoanOut, settings: LendingSettingsOut?): Int? =
        settings?.let { maxOf(0, it.maxExtensions - loan.extensionCount) }

    /** The list's local filter (§5.2: the app filters by category, status and text). */
    fun filter(items: List<LendingItemOut>, query: String, categoryId: String?, status: String?): List<LendingItemOut> {
        val words = normalize(query).split(' ').filter { it.isNotEmpty() }
        return items.filter { item ->
            (categoryId == null || item.categoryId == categoryId) &&
                (status == null || item.status == status) &&
                words.all { word -> normalize(item.name).contains(word) || normalize(item.code ?: "").contains(word) || normalize(item.location ?: "").contains(word) }
        }
    }

    private fun normalize(text: String): String = Normalizer.normalize(text, Normalizer.Form.NFKC).lowercase().trim()

    /** The teachers to choose from: my supervisor first, then the others by name; narrowed by [query]. */
    fun approverChoices(approvers: LendingApproversOut, name: (String) -> String, query: String = ""): List<String> {
        val words = normalize(query)
        val suggested = approvers.suggestedIds.filter { it in approvers.userIds }
        val rest = approvers.userIds.filter { it !in suggested }.sortedBy { normalize(name(it)) }
        return (suggested + rest).filter { words.isEmpty() || normalize(name(it)).contains(words) }
    }

    /** 「借りる」 can be sent: a date in range, a purpose, and (when needed) the mark and a teacher. */
    fun canSendBorrow(due: LocalDate?, range: ClosedRange<LocalDate>, purpose: String, needsPermission: Boolean, confirmed: Boolean, approverId: String?): Boolean =
        due != null && due in range && purpose.isNotBlank() && purpose.trim().length <= 200 &&
            (!needsPermission || (confirmed && approverId != null))

    /** Whether I am the teacher named and the decision is still open (the server checks the 14 days after a return again). */
    fun canDecide(loan: LendingLoanOut, me: String?, now: Instant): Boolean {
        if (!loan.permissionRequired || me == null || loan.approverId != me) return false
        val returned = instant(loan.returnedAt) ?: return true
        return now.isBefore(returned.plus(14, ChronoUnit.DAYS))
    }

    /** The permission line of a loan: 「申告（未確認）」, 「確認済み」, 「許可していないとされました」. */
    fun permissionText(state: String?): String? = when (state) {
        "claimed" -> L10n.str(R.string.lending_permission_claimed)
        "confirmed" -> L10n.str(R.string.lending_permission_confirmed)
        "denied" -> L10n.str(R.string.lending_permission_denied)
        else -> null
    }

    /**
     * A failure in my words: 409 lending_item_unavailable says who took it first (or that I have it already, §7.2) or why
     * it cannot be borrowed; the rest is the shared table (apps/shared/errors.json) and the network / server words.
     */
    fun errorText(error: Throwable, me: String?, name: (String) -> String): String {
        if (error is ApiException.Api && error.code == "lending_item_unavailable") {
            val details = error.details as? JsonObject
            fun field(key: String) = (details?.get(key) as? JsonPrimitive)?.takeIf { it.isString }?.content
            val borrower = field("borrower_id")
            val due = field("due_on")?.let(::date)?.let(::dayLabel)
            return when {
                borrower != null && borrower == me -> L10n.str(R.string.lending_already_yours)
                borrower != null && due != null -> L10n.str(R.string.lending_taken_first, name(borrower), due)
                field("status") == "in_repair" -> L10n.str(R.string.lending_unavailable_repair)
                else -> ErrorTexts.code(error.code) ?: ErrorTexts.unknown
            }
        }
        return when (error) {
            is ApiException.Api -> ErrorTexts.code(error.code) ?: ErrorTexts.status(error.status) ?: ErrorTexts.unknown
            is ApiException.Network -> ErrorTexts.network
            else -> ErrorTexts.unknown
        }
    }

    /** Whether a failure means the item changed under me (someone borrowed first): the page reads it again. */
    fun isConflict(error: Throwable): Boolean = error is ApiException.Api && error.status == 409

    /** The epoch millis Material's date picker uses for a day (UTC midnight), and back. */
    fun pickerMillis(day: LocalDate): Long = day.atStartOfDay(ZoneOffset.UTC).toInstant().toEpochMilli()
    fun pickerDay(millis: Long): LocalDate = Instant.ofEpochMilli(millis).atZone(ZoneOffset.UTC).toLocalDate()
}

/** The list's segments: 一覧 (the items), 貸出中 (who has what), 自分 (mine and the ones I was named for), 延滞 (keepers). */
private enum class LendingSegment(val label: Int) { ITEMS(R.string.lending_segment_items), ACTIVE(R.string.lending_segment_active), MINE(R.string.lending_segment_mine), OVERDUE(R.string.lending_segment_overdue) }

/** M172: 「備品」 — the list, an item or a loan (docs/LENDING.md §12.3). No ledger editing on the phones. */
@Composable
fun LendingPane(controller: AppController, version: Int, route: Route.Lending, onOpenItem: (String) -> Unit, onOpenLoan: (String) -> Unit) {
    // The settings: the zone of the due dates and the extension limit (read once the page opens if not yet known).
    LaunchedEffect(Unit) { if (controller.store.lendingSettings == null) controller.engine?.loadLendingSettings() }
    when {
        route.loanId != null -> LendingLoanPage(controller, version, route.loanId, onOpenItem)
        route.itemId != null -> LendingItemPage(controller, version, route.itemId, onOpenLoan)
        else -> LendingListPage(controller, version, route.overdue, onOpenItem, onOpenLoan)
    }
}

/** A read of the page's data: null while loading, the failure's words when it failed (with 再読み込み). */
private class Loaded<T>(val value: T?, val error: String?)

@Composable
private fun LoadFailed(text: String, onRetry: () -> Unit) {
    Column(Modifier.fillMaxWidth().padding(24.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        Text(text, color = MaterialTheme.colorScheme.onSurfaceVariant)
        TextButton(onClick = onRetry) { Text(stringResource(R.string.common_reload)) }
    }
}

@Composable
private fun Loading() {
    Text(stringResource(R.string.common_loading), modifier = Modifier.padding(16.dp), color = MaterialTheme.colorScheme.onSurfaceVariant)
}

@Composable
private fun SectionTitle(text: String) {
    Text(
        text, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold,
        modifier = Modifier.padding(start = 16.dp, end = 16.dp, top = 16.dp, bottom = 4.dp).semantics { heading() },
    )
}

/** A dot and the status's word (and who has it until when), never a card with a coloured bar (design taste). */
@Composable
private fun StatusLine(status: String, loan: LendingLoanBriefOut?, name: (String) -> String, note: String? = null) {
    val overdue = (loan?.overdueDays ?: 0) > 0
    Row(verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.size(8.dp).clip(CircleShape).background(LendingRules.statusColor(status, overdue)))
        Spacer(Modifier.width(6.dp))
        val text = buildString {
            append(LendingRules.statusLabel(status))
            if (loan != null && status == "on_loan") append(" · ").append(name(loan.borrowerId)).append(" ").append(LendingRules.dueText(loan.dueOn, loan.overdueDays))
            if (note != null && status != "on_loan") append(L10n.str(R.string.lending_paren, note))
        }
        Text(
            text, style = MaterialTheme.typography.bodySmall, maxLines = 2, overflow = TextOverflow.Ellipsis,
            color = if (overdue) LendingRules.statusColor(status, true) else MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

/** An item's picture (the attachment's thumbnail), or a quiet box with the equipment icon. */
@Composable
private fun LendingThumb(controller: AppController, photo: AttachmentOut?, size: Dp) {
    var bitmap by remember(photo?.id) { mutableStateOf<ImageBitmap?>(null) }
    if (photo != null && photo.hasThumbnail) LaunchedEffect(photo.id) { bitmap = fetchThumbnail(controller, photo.id) }
    val shape = RoundedCornerShape(8.dp)
    val image = bitmap
    if (image != null) {
        Image(image, contentDescription = null, contentScale = ContentScale.Crop, modifier = Modifier.size(size).clip(shape))
    } else {
        Box(Modifier.size(size).clip(shape).background(MaterialTheme.colorScheme.surfaceVariant), contentAlignment = Alignment.Center) {
            Icon(Icons.Outlined.Inventory2, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(size / 2))
        }
    }
}

private fun personName(controller: AppController, id: String): String =
    controller.store.users[id]?.displayName ?: L10n.str(R.string.lending_unknown)

@Composable
private fun LendingListPage(controller: AppController, version: Int, overdueFirst: Boolean, onOpenItem: (String) -> Unit, onOpenLoan: (String) -> Unit) {
    val store = controller.store
    val revision = store.lendingRevision
    val keeper = store.lendingSettings?.isKeeper == true || store.lending?.isKeeper == true
    var segment by rememberSaveable { mutableStateOf(if (overdueFirst) LendingSegment.OVERDUE else LendingSegment.ITEMS) }
    var query by rememberSaveable { mutableStateOf("") }
    var category by rememberSaveable { mutableStateOf<String?>(null) }
    var status by rememberSaveable { mutableStateOf<String?>(null) }
    var retry by remember { mutableIntStateOf(0) }
    var items by remember { mutableStateOf<Loaded<List<LendingItemOut>>>(Loaded(null, null)) }
    var categories by remember { mutableStateOf<List<LendingCategoryOut>>(emptyList()) }
    var loans by remember { mutableStateOf<Loaded<List<LendingLoanOut>>>(Loaded(null, null)) }
    var approved by remember { mutableStateOf<List<LendingLoanOut>>(emptyList()) }
    val name: (String) -> String = { personName(controller, it) }
    val me = store.me?.id
    val describe: (Throwable) -> String = { LendingRules.errorText(it, me, name) }
    LaunchedEffect(segment, revision, retry) {
        when (segment) {
            LendingSegment.ITEMS -> {
                controller.lendingCall { it.lendingItems() }
                    .onSuccess { items = Loaded(it, null) }.onFailure { items = Loaded(items.value, describe(it)) }
                controller.lendingCall { it.lendingCategories() }.onSuccess { categories = it }
                // 「自分の貸し出し」 over the list (§12.3).
                controller.lendingCall { it.lendingLoans("mine") }.onSuccess { loans = Loaded(it, null) }
            }
            LendingSegment.ACTIVE, LendingSegment.OVERDUE -> {
                val scope = if (segment == LendingSegment.ACTIVE) "active" else "overdue"
                loans = Loaded(null, null)
                controller.lendingCall { it.lendingLoans(scope) }
                    .onSuccess { loans = Loaded(it, null) }.onFailure { loans = Loaded(null, describe(it)) }
            }
            LendingSegment.MINE -> {
                loans = Loaded(null, null)
                controller.lendingCall { it.lendingLoans("mine") }
                    .onSuccess { loans = Loaded(it, null) }.onFailure { loans = Loaded(null, describe(it)) }
                controller.lendingCall { it.lendingLoans("approved") }.onSuccess { approved = it }
            }
        }
    }
    val segments = LendingSegment.entries.filter { it != LendingSegment.OVERDUE || keeper || segment == LendingSegment.OVERDUE }
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 32.dp)) {
        item(key = "segments") {
            Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 12.dp, vertical = 6.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                segments.forEach { value ->
                    FilterChip(selected = value == segment, onClick = { segment = value }, label = { Text(stringResource(value.label)) })
                }
            }
        }
        when (segment) {
            LendingSegment.ITEMS -> {
                item(key = "search") {
                    OutlinedTextField(
                        value = query, onValueChange = { query = it }, singleLine = true,
                        placeholder = { Text(stringResource(R.string.lending_search_placeholder)) },
                        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp),
                    )
                }
                if (categories.isNotEmpty()) item(key = "categories") {
                    Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 12.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        FilterChip(selected = category == null, onClick = { category = null }, label = { Text(stringResource(R.string.common_all)) })
                        categories.forEach { c -> FilterChip(selected = category == c.id, onClick = { category = if (category == c.id) null else c.id }, label = { Text(c.name) }) }
                    }
                }
                item(key = "statuses") {
                    Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 12.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        FilterChip(selected = status == null, onClick = { status = null }, label = { Text(stringResource(R.string.lending_status_any)) })
                        listOf("available", "on_loan", "in_repair").forEach { s ->
                            FilterChip(selected = status == s, onClick = { status = if (status == s) null else s }, label = { Text(LendingRules.statusLabel(s)) })
                        }
                    }
                }
                val mine = loans.value.orEmpty().filter { it.status == "active" && it.borrowerId == me }
                if (mine.isNotEmpty()) {
                    item(key = "mine-title") { SectionTitle(stringResource(R.string.lending_my_loans)) }
                    items(mine, key = { "m:" + it.id }) { loan -> LoanRow(loan, name, showBorrower = false) { onOpenLoan(loan.id) } }
                    item(key = "items-title") { SectionTitle(stringResource(R.string.lending_title)) }
                }
                val all = items.value
                when {
                    all == null && items.error != null -> item(key = "failed") { LoadFailed(items.error ?: "") { retry++ } }
                    all == null -> item(key = "loading") { Loading() }
                    else -> {
                        val shown = LendingRules.filter(all, query, category, status)
                        if (shown.isEmpty()) item(key = "empty") {
                            Text(
                                stringResource(if (all.isEmpty()) R.string.lending_no_items else R.string.lending_no_matches),
                                modifier = Modifier.padding(16.dp), color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                        items(shown, key = { "i:" + it.id }) { item ->
                            ItemRow(controller, item, categories.firstOrNull { it.id == item.categoryId }?.name, name) { onOpenItem(item.id) }
                            HorizontalDivider(Modifier.padding(start = 72.dp))
                        }
                    }
                }
            }
            LendingSegment.ACTIVE, LendingSegment.OVERDUE -> {
                val list = loans.value
                when {
                    list == null && loans.error != null -> item(key = "failed") { LoadFailed(loans.error ?: "") { retry++ } }
                    list == null -> item(key = "loading") { Loading() }
                    list.isEmpty() -> item(key = "empty") {
                        Text(stringResource(if (segment == LendingSegment.ACTIVE) R.string.lending_none_active else R.string.lending_none_overdue), modifier = Modifier.padding(16.dp), color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    else -> items(list, key = { "l:" + it.id }) { loan -> LoanRow(loan, name, showBorrower = true) { onOpenLoan(loan.id) } }
                }
            }
            LendingSegment.MINE -> {
                val list = loans.value
                when {
                    list == null && loans.error != null -> item(key = "failed") { LoadFailed(loans.error ?: "") { retry++ } }
                    list == null -> item(key = "loading") { Loading() }
                    else -> {
                        val active = list.filter { it.status == "active" }
                        val returned = list.filter { it.status != "active" }
                        item(key = "mine-title") { SectionTitle(stringResource(R.string.lending_my_loans)) }
                        if (active.isEmpty()) item(key = "mine-empty") { Text(stringResource(R.string.lending_none_mine), modifier = Modifier.padding(horizontal = 16.dp), color = MaterialTheme.colorScheme.onSurfaceVariant) }
                        items(active, key = { "m:" + it.id }) { loan -> LoanRow(loan, name, showBorrower = false) { onOpenLoan(loan.id) } }
                        if (approved.isNotEmpty()) {
                            item(key = "approved-title") { SectionTitle(stringResource(R.string.lending_asked_to_approve)) }
                            items(approved, key = { "a:" + it.id }) { loan -> LoanRow(loan, name, showBorrower = true) { onOpenLoan(loan.id) } }
                        }
                        if (returned.isNotEmpty()) {
                            item(key = "returned-title") { SectionTitle(stringResource(R.string.lending_recent_returns)) }
                            items(returned, key = { "r:" + it.id }) { loan -> LoanRow(loan, name, showBorrower = false) { onOpenLoan(loan.id) } }
                        }
                    }
                }
            }
        }
        item(key = "hint") {
            Text(
                stringResource(R.string.lending_managed_on_desktop), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(horizontal = 16.dp, vertical = 16.dp),
            )
        }
    }
}

@Composable
private fun ItemRow(controller: AppController, item: LendingItemOut, category: String?, name: (String) -> String, onClick: () -> Unit) {
    Row(Modifier.fillMaxWidth().clickable(onClick = onClick).padding(horizontal = 16.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
        LendingThumb(controller, item.photo, 44.dp)
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
            Text(item.name, style = MaterialTheme.typography.bodyLarge, maxLines = 1, overflow = TextOverflow.Ellipsis)
            val sub = listOfNotNull(item.code, category, item.location).joinToString(" · ")
            if (sub.isNotEmpty()) Text(sub, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.weight(1f, fill = false)) { StatusLine(item.status, item.loan, name, item.statusNote) }
                if (item.requiresPermission) Text("  🔑", style = MaterialTheme.typography.bodySmall)
            }
        }
    }
}

/** A loan in a list: the item, (who has it,) until when; overdue in red; returned with the day and 🔧 for an issue. */
@Composable
private fun LoanRow(loan: LendingLoanOut, name: (String) -> String, showBorrower: Boolean, onClick: () -> Unit) {
    val zone = ZoneId.systemDefault()
    Row(Modifier.fillMaxWidth().clickable(onClick = onClick).padding(horizontal = 16.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
        Text("📦", style = MaterialTheme.typography.titleMedium)
        Spacer(Modifier.width(10.dp))
        Column(Modifier.weight(1f)) {
            Text(listOfNotNull(loan.itemName, loan.itemCode).joinToString("  "), style = MaterialTheme.typography.bodyLarge, maxLines = 1, overflow = TextOverflow.Ellipsis)
            val line = if (loan.status == "active") {
                (if (showBorrower) name(loan.borrowerId) + "  " else "") + LendingRules.dueText(loan.dueOn, loan.overdueDays)
            } else {
                (if (showBorrower) name(loan.borrowerId) + "  " else "") + L10n.str(R.string.lending_returned_on, LendingRules.shortDay(loan.returnedAt, zone)) + if (loan.returnCondition == "issue") " 🔧" else ""
            }
            Text(
                line, style = MaterialTheme.typography.bodySmall, maxLines = 1, overflow = TextOverflow.Ellipsis,
                color = if (loan.status == "active" && loan.overdueDays > 0) LendingRules.statusColor("on_loan", true) else MaterialTheme.colorScheme.onSurfaceVariant,
            )
            LendingRules.permissionText(loan.permissionState)?.takeIf { showBorrower }?.let {
                Text("🔑 $it", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }
    HorizontalDivider(Modifier.padding(start = 48.dp))
}

@Composable
private fun LendingItemPage(controller: AppController, version: Int, itemId: String, onOpenLoan: (String) -> Unit) {
    val store = controller.store
    val revision = store.lendingRevision
    val me = store.me?.id
    val name: (String) -> String = { personName(controller, it) }
    var retry by remember { mutableIntStateOf(0) }
    var loaded by remember { mutableStateOf<Loaded<LendingItemOut>>(Loaded(null, null)) }
    var loan by remember { mutableStateOf<LendingLoanOut?>(null) }
    var category by remember { mutableStateOf<String?>(null) }
    var dialog by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    var message by remember { mutableStateOf<String?>(null) }
    var viewing by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val keeper = store.lendingSettings?.isKeeper == true
    LaunchedEffect(itemId, revision, retry) {
        controller.lendingCall { it.lendingItem(itemId) }.onSuccess { item ->
            loaded = Loaded(item, null)
            controller.lendingTitles[itemId] = item.name
            // My loan of it (return / extend need the loan's limits); a keeper may record a return.
            val brief = item.loan
            loan = if (brief != null && (brief.borrowerId == me || keeper)) controller.lendingCall { it.lendingLoan(brief.id) }.getOrNull() else null
            category = item.categoryId?.let { id -> controller.lendingCall { it.lendingCategories() }.getOrNull()?.firstOrNull { it.id == id }?.name }
        }.onFailure { loaded = Loaded(loaded.value, LendingRules.errorText(it, me, name)) }
    }
    val item = loaded.value
    if (item == null) {
        if (loaded.error != null) LoadFailed(loaded.error ?: "") { retry++ } else Loading()
        return
    }
    val mine = item.loan?.borrowerId == me && me != null
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(bottom = 32.dp)) {
        item.photo?.let { photo ->
            var bitmap by remember(photo.id) { mutableStateOf<ImageBitmap?>(null) }
            if (photo.hasThumbnail) LaunchedEffect(photo.id) { bitmap = fetchThumbnail(controller, photo.id) }
            bitmap?.let { image ->
                Image(
                    image, contentDescription = item.name, contentScale = ContentScale.Fit,
                    modifier = Modifier.fillMaxWidth().heightIn(max = 260.dp).padding(16.dp).clip(RoundedCornerShape(8.dp)).clickable { viewing = true },
                )
            }
            if (viewing) ImageViewer(photo, controller, onDismiss = { viewing = false })
        }
        Column(Modifier.padding(horizontal = 16.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            SelectionContainer { Text(item.name, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold) }
            val sub = listOfNotNull(item.code, category).joinToString(" · ")
            if (sub.isNotEmpty()) SelectionContainer { Text(sub, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant) }
            StatusLine(item.status, item.loan, name, item.statusNote)
            item.location?.let { Text(L10n.str(R.string.lending_location, it), style = MaterialTheme.typography.bodyMedium) }
            item.notes?.let { SelectionContainer { Text(it, style = MaterialTheme.typography.bodyMedium) } }
            if (item.requiresPermission) Text("🔑 " + stringResource(R.string.lending_requires_permission), style = MaterialTheme.typography.bodyMedium)
            Text(L10n.str(R.string.lending_max_days, item.maxDays), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            item.recentLoans.firstOrNull { it.status == "returned" }?.takeIf { it.returnCondition == "issue" && item.status != "on_loan" }?.let {
                Text("🔧 " + stringResource(R.string.lending_last_return_issue), style = MaterialTheme.typography.bodyMedium)
            }
        }
        message?.let { Text(it, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp)) }
        Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            if (item.status == "available" && !controller.isGuest) Button(onClick = { message = null; dialog = "borrow" }, enabled = !busy) { Text(stringResource(R.string.lending_borrow)) }
            if (mine && loan != null) {
                Button(onClick = { message = null; dialog = "return" }, enabled = !busy) { Text(stringResource(R.string.lending_return)) }
                OutlinedButton(onClick = { message = null; dialog = "extend" }, enabled = !busy && loan?.canExtend == true && loan?.let(LendingRules::extendRange) != null) { Text(stringResource(R.string.lending_extend)) }
            } else if (keeper && loan != null) {
                OutlinedButton(onClick = { message = null; dialog = "return" }, enabled = !busy) { Text(stringResource(R.string.lending_record_return)) }
            }
        }
        if (item.status == "on_loan" || item.status == "in_repair" || item.watching) {
            Row(
                Modifier.fillMaxWidth().selectable(selected = item.watching, enabled = !busy, role = Role.Checkbox, onClick = {
                    busy = true
                    scope.launch {
                        val on = !item.watching
                        controller.lendingCall { it.watchLending(item.id, on) }
                            .onSuccess { loaded = Loaded(item.copy(watching = on), null) }
                            .onFailure { message = LendingRules.errorText(it, me, name) }
                        busy = false
                    }
                }).padding(horizontal = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Checkbox(checked = item.watching, onCheckedChange = null, modifier = Modifier.padding(8.dp))
                Text(stringResource(R.string.lending_notify_when_returned), style = MaterialTheme.typography.bodyMedium)
            }
        }
        if (item.recentLoans.isNotEmpty()) {
            SectionTitle(stringResource(R.string.lending_recent_loans))
            val zone = ZoneId.systemDefault()
            item.recentLoans.forEach { brief ->
                Row(Modifier.fillMaxWidth().clickable { onOpenLoan(brief.id) }.padding(horizontal = 16.dp, vertical = 8.dp)) {
                    val line = if (brief.status == "active") {
                        L10n.str(R.string.lending_borrowed_line, LendingRules.shortDay(brief.borrowedAt, zone), name(brief.borrowerId), LendingRules.dueText(brief.dueOn, brief.overdueDays))
                    } else {
                        L10n.str(R.string.lending_returned_line, LendingRules.shortDay(brief.borrowedAt, zone), LendingRules.shortDay(brief.returnedAt, zone), name(brief.borrowerId)) +
                            if (brief.returnCondition == "issue") " 🔧" else ""
                    }
                    Text(line, style = MaterialTheme.typography.bodyMedium)
                }
            }
        }
    }
    val settings = store.lendingSettings
    when (dialog) {
        "borrow" -> BorrowDialog(controller, item, settings, onDismiss = { dialog = null }) { result ->
            dialog = null
            result.onFailure { if (LendingRules.isConflict(it)) retry++ }
        }
        "return" -> loan?.let { l -> ReturnDialog(controller, l, onBehalf = !mine, onDismiss = { dialog = null }) { dialog = null; retry++ } }
        "extend" -> loan?.let { l -> ExtendDialog(controller, l, settings, item.watcherCount, onDismiss = { dialog = null }) { dialog = null; retry++ } }
    }
}

@Composable
private fun LendingLoanPage(controller: AppController, version: Int, loanId: String, onOpenItem: (String) -> Unit) {
    val store = controller.store
    val revision = store.lendingRevision
    val me = store.me?.id
    val name: (String) -> String = { personName(controller, it) }
    var retry by remember { mutableIntStateOf(0) }
    var loaded by remember { mutableStateOf<Loaded<LendingLoanOut>>(Loaded(null, null)) }
    var watchers by remember { mutableIntStateOf(0) }
    var dialog by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(loanId, revision, retry) {
        controller.lendingCall { it.lendingLoan(loanId) }.onSuccess { loan ->
            loaded = Loaded(loan, null)
            controller.lendingTitles[loanId] = loan.itemName
            if (loan.status == "active" && loan.borrowerId == me) watchers = controller.lendingCall { it.lendingItem(loan.itemId) }.getOrNull()?.watcherCount ?: 0
        }.onFailure { loaded = Loaded(loaded.value, LendingRules.errorText(it, me, name)) }
    }
    val loan = loaded.value
    if (loan == null) {
        if (loaded.error != null) LoadFailed(loaded.error ?: "") { retry++ } else Loading()
        return
    }
    val zone = ZoneId.systemDefault()
    val mine = loan.borrowerId == me
    val keeper = store.lendingSettings?.isKeeper == true
    val active = loan.status == "active"
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(bottom = 32.dp)) {
        Column(Modifier.padding(horizontal = 16.dp, vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(
                listOfNotNull(loan.itemName, loan.itemCode).joinToString("  "), style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold,
                modifier = Modifier.clickable(onClickLabel = stringResource(R.string.lending_open_item)) { onOpenItem(loan.itemId) },
            )
            TextButton(onClick = { onOpenItem(loan.itemId) }, contentPadding = PaddingValues(0.dp)) { Text(stringResource(R.string.lending_open_item)) }
            LabeledLine(stringResource(R.string.lending_field_borrower), name(loan.borrowerId))
            LabeledLine(stringResource(R.string.lending_field_borrowed), LendingRules.shortDay(loan.borrowedAt, zone))
            if (active) {
                Text(
                    LendingRules.dueText(loan.dueOn, loan.overdueDays), style = MaterialTheme.typography.bodyLarge,
                    color = if (loan.overdueDays > 0) LendingRules.statusColor("on_loan", true) else MaterialTheme.colorScheme.onSurface,
                )
                if (loan.extensionCount > 0) Text(L10n.str(R.string.lending_extended_times, loan.extensionCount), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            } else {
                LabeledLine(stringResource(R.string.lending_field_returned), LendingRules.shortDay(loan.returnedAt, zone) + when (loan.returnCondition) {
                    "issue" -> L10n.str(R.string.lending_paren, L10n.str(R.string.lending_condition_issue)) + " 🔧"
                    "ok" -> L10n.str(R.string.lending_paren, L10n.str(R.string.lending_condition_ok))
                    else -> ""
                })
                loan.returnedBy?.takeIf { it != loan.borrowerId }?.let { LabeledLine(stringResource(R.string.lending_field_recorded_by), name(it)) }
                loan.returnNote?.let { LabeledLine(stringResource(R.string.lending_field_return_note), it) }
            }
            loan.purpose?.let { LabeledLine(stringResource(R.string.lending_field_purpose), it) }
            if (loan.permissionRequired && !loan.detailsHidden) {
                val approver = loan.approverId?.let(name) ?: L10n.str(R.string.lending_unknown)
                LabeledLine(stringResource(R.string.lending_field_approver), approver + (LendingRules.permissionText(loan.permissionState)?.let { L10n.str(R.string.lending_paren, it) } ?: ""))
                loan.permissionNote?.let { LabeledLine(stringResource(R.string.lending_field_teacher_note), it) }
            }
            if (loan.detailsHidden) Text(stringResource(R.string.lending_details_hidden), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            if (active && mine) {
                Button(onClick = { dialog = "return" }) { Text(stringResource(R.string.lending_return)) }
                OutlinedButton(onClick = { dialog = "extend" }, enabled = loan.canExtend && LendingRules.extendRange(loan) != null) { Text(stringResource(R.string.lending_extend)) }
            } else if (active && keeper) {
                OutlinedButton(onClick = { dialog = "return" }) { Text(stringResource(R.string.lending_record_return)) }
            }
        }
        if (LendingRules.canDecide(loan, me, Instant.now())) {
            SectionTitle(stringResource(R.string.lending_your_decision))
            Text(stringResource(R.string.lending_decision_hint), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(horizontal = 16.dp))
            Row(Modifier.padding(horizontal = 16.dp, vertical = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                if (loan.permissionState != "denied") OutlinedButton(onClick = { dialog = "denied" }) { Text(stringResource(R.string.lending_not_approved)) }
                if (loan.permissionState != "confirmed") TextButton(onClick = { dialog = "confirmed" }) { Text(stringResource(R.string.lending_confirm)) }
            }
        }
    }
    val settings = store.lendingSettings
    when (dialog) {
        "return" -> ReturnDialog(controller, loan, onBehalf = !mine, onDismiss = { dialog = null }) { dialog = null; retry++ }
        "extend" -> ExtendDialog(controller, loan, settings, watchers, onDismiss = { dialog = null }) { dialog = null; retry++ }
        "denied", "confirmed" -> LendingDecisionDialog(controller, loan.id, dialog ?: "confirmed", onDone = { dialog = null; retry++ }, onDismiss = { dialog = null })
    }
}

@Composable
private fun LabeledLine(label: String, value: String) {
    Row {
        Text(label, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.width(96.dp))
        SelectionContainer(Modifier.weight(1f)) { Text(value, style = MaterialTheme.typography.bodyMedium) }
    }
}

/** A date row of a dialog: 「返す日  10/30 (木) ▾」, opening the picker limited to [range]. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun DateField(label: String, day: LocalDate, range: ClosedRange<LocalDate>, onPick: (LocalDate) -> Unit) {
    var open by remember { mutableStateOf(false) }
    Row(Modifier.fillMaxWidth().clickable { open = true }.padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(label, style = MaterialTheme.typography.labelLarge, modifier = Modifier.width(104.dp))
        Text(LendingRules.dayLabel(day) + " ▾", style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.primary)
    }
    if (open) {
        val state = rememberDatePickerState(
            initialSelectedDateMillis = LendingRules.pickerMillis(day),
            yearRange = range.start.year..range.endInclusive.year,
            selectableDates = object : SelectableDates {
                override fun isSelectableDate(utcTimeMillis: Long): Boolean = LendingRules.pickerDay(utcTimeMillis) in range
                override fun isSelectableYear(year: Int): Boolean = year in range.start.year..range.endInclusive.year
            },
        )
        DatePickerDialog(
            onDismissRequest = { open = false },
            confirmButton = {
                TextButton(onClick = {
                    state.selectedDateMillis?.let { LendingRules.pickerDay(it) }?.takeIf { it in range }?.let(onPick)
                    open = false
                }) { Text(stringResource(R.string.lending_pick)) }
            },
            dismissButton = { TextButton(onClick = { open = false }) { Text(stringResource(R.string.common_cancel)) } },
        ) { DatePicker(state = state) }
    }
}

/**
 * 「借りる」 (§6.3, §12.2): the due date (the latest by default, nothing after it), the purpose, and for an item that needs
 * it 「教員の許可を得た」 with the teacher (my supervisor first). One `client_request_id` for the dialog: a retry after a
 * failure sends the same one, so the server makes one loan (§7.2). A 409 says who took it first; the item reads again.
 */
@Composable
private fun BorrowDialog(controller: AppController, item: LendingItemOut, settings: LendingSettingsOut?, onDismiss: () -> Unit, onDone: (Result<LendingLoanOut>) -> Unit) {
    val zone = LendingRules.zone(settings)
    val today = remember { LendingRules.today(Instant.now(), zone) }
    val range = remember(item.maxDays) { LendingRules.borrowRange(item, today) }
    val requestId = rememberSaveable { UUID.randomUUID().toString() }
    var due by remember { mutableStateOf(range.endInclusive) }
    var purpose by rememberSaveable { mutableStateOf("") }
    var confirmed by rememberSaveable { mutableStateOf(false) }
    var approverId by rememberSaveable { mutableStateOf<String?>(null) }
    var search by remember { mutableStateOf("") }
    var approvers by remember { mutableStateOf<LendingApproversOut?>(null) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    val me = controller.store.me?.id
    val name: (String) -> String = { personName(controller, it) }
    if (item.requiresPermission) LaunchedEffect(Unit) {
        controller.lendingCall { it.lendingApprovers() }.onSuccess { list ->
            approvers = list
            if (approverId == null) approverId = list.suggestedIds.firstOrNull { it in list.userIds }
        }.onFailure { error = LendingRules.errorText(it, me, name) }
    }
    val needsPermission = item.requiresPermission && approvers?.selfApproved != true
    AlertDialog(
        onDismissRequest = { if (!busy) onDismiss() },
        title = { Text(L10n.str(R.string.lending_borrow_title, item.name)) },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                DateField(stringResource(R.string.lending_due_date), due, range) { due = it }
                Text(L10n.str(R.string.lending_max_until, item.maxDays, LendingRules.dayLabel(range.endInclusive)), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                OutlinedTextField(
                    value = purpose, onValueChange = { purpose = it.take(200) }, singleLine = true,
                    label = { Text(stringResource(R.string.lending_purpose)) }, placeholder = { Text(stringResource(R.string.lending_purpose_placeholder)) },
                    modifier = Modifier.fillMaxWidth(),
                )
                if (item.requiresPermission) {
                    Text("🔑 " + stringResource(R.string.lending_requires_permission), style = MaterialTheme.typography.bodyMedium)
                    val list = approvers
                    when {
                        list == null && error == null -> Loading()
                        list?.selfApproved == true -> Text(stringResource(R.string.lending_self_approved), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        list != null -> {
                            Row(
                                Modifier.fillMaxWidth().selectable(selected = confirmed, role = Role.Checkbox, onClick = { confirmed = !confirmed }),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                Checkbox(checked = confirmed, onCheckedChange = null)
                                Spacer(Modifier.width(8.dp))
                                Text(stringResource(R.string.lending_teacher_approved), style = MaterialTheme.typography.bodyMedium)
                            }
                            Text(stringResource(R.string.lending_approver), style = MaterialTheme.typography.labelLarge)
                            if (list.userIds.size > 6) OutlinedTextField(
                                value = search, onValueChange = { search = it }, singleLine = true,
                                placeholder = { Text(stringResource(R.string.lending_approver_search)) }, modifier = Modifier.fillMaxWidth(),
                            )
                            val choices = LendingRules.approverChoices(list, name, search)
                            if (list.userIds.isEmpty()) Text(stringResource(R.string.lending_no_approvers), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
                            Column(Modifier.heightIn(max = 220.dp).verticalScroll(rememberScrollState())) {
                                choices.forEach { id ->
                                    Row(
                                        Modifier.fillMaxWidth().selectable(selected = approverId == id, role = Role.RadioButton, onClick = { approverId = id }),
                                        verticalAlignment = Alignment.CenterVertically,
                                    ) {
                                        RadioButton(selected = approverId == id, onClick = null)
                                        Spacer(Modifier.width(8.dp))
                                        Text(name(id) + if (id in list.suggestedIds) L10n.str(R.string.lending_paren, L10n.str(R.string.lending_supervisor)) else "", style = MaterialTheme.typography.bodyMedium)
                                    }
                                }
                            }
                            Text(stringResource(R.string.lending_approver_notified), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                }
                error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
            }
        },
        confirmButton = {
            TextButton(
                enabled = !busy && LendingRules.canSendBorrow(due, range, purpose, needsPermission, confirmed, approverId) && (!item.requiresPermission || approvers != null),
                onClick = {
                    busy = true
                    error = null
                    scope.launch {
                        val result = controller.lendingCall(changes = true) {
                            it.borrowLending(item.id, requestId, due.toString(), purpose.trim(), needsPermission && confirmed, if (needsPermission) approverId else null)
                        }
                        busy = false
                        result.onSuccess { onDone(result) }.onFailure { e ->
                            error = LendingRules.errorText(e, me, name)
                            // Someone took it first (or it went to repair): the item reads again behind the dialog.
                            if (LendingRules.isConflict(e)) controller.store.bumpLending()
                        }
                    }
                },
            ) { Text(stringResource(R.string.lending_borrow)) }
        },
        dismissButton = { TextButton(onClick = onDismiss, enabled = !busy) { Text(stringResource(R.string.common_cancel)) } },
    )
}

/** 「返す」 (§6.6): 問題なし / 問題あり, a note (required with 問題あり). A keeper recording it for someone is told who hears of it. */
@Composable
private fun ReturnDialog(controller: AppController, loan: LendingLoanOut, onBehalf: Boolean, onDismiss: () -> Unit, onDone: () -> Unit) {
    var condition by rememberSaveable { mutableStateOf("ok") }
    var note by rememberSaveable { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    val me = controller.store.me?.id
    val name: (String) -> String = { personName(controller, it) }
    AlertDialog(
        onDismissRequest = { if (!busy) onDismiss() },
        title = { Text(if (onBehalf) stringResource(R.string.lending_record_return) else L10n.str(R.string.lending_return_title, loan.itemName)) },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                if (onBehalf) Text(L10n.str(R.string.lending_record_return_hint, name(loan.borrowerId)), style = MaterialTheme.typography.bodyMedium)
                listOf("ok" to R.string.lending_condition_ok, "issue" to R.string.lending_condition_issue).forEach { (value, label) ->
                    Row(Modifier.fillMaxWidth().selectable(selected = condition == value, role = Role.RadioButton, onClick = { condition = value }), verticalAlignment = Alignment.CenterVertically) {
                        RadioButton(selected = condition == value, onClick = null)
                        Spacer(Modifier.width(8.dp))
                        Text(stringResource(label), style = MaterialTheme.typography.bodyMedium)
                    }
                }
                OutlinedTextField(
                    value = note, onValueChange = { note = it.take(500) }, minLines = 2,
                    label = { Text(stringResource(if (condition == "issue") R.string.lending_note_required else R.string.lending_note_optional)) },
                    placeholder = { Text(stringResource(if (condition == "issue") R.string.lending_issue_placeholder else R.string.lending_note_placeholder)) },
                    modifier = Modifier.fillMaxWidth(),
                )
                error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
            }
        },
        confirmButton = {
            TextButton(enabled = !busy && (condition == "ok" || note.isNotBlank()), onClick = {
                busy = true
                error = null
                scope.launch {
                    controller.lendingCall(changes = true) { it.returnLending(loan.id, condition, note.trim().ifEmpty { null }) }
                        .onSuccess { onDone() }.onFailure { error = LendingRules.errorText(it, me, name) }
                    busy = false
                }
            }) { Text(stringResource(if (onBehalf) R.string.lending_record_return else R.string.lending_return)) }
        },
        dismissButton = { TextButton(onClick = onDismiss, enabled = !busy) { Text(stringResource(R.string.common_cancel)) } },
    )
}

/** 「延長」 (§6.5): a new due date in range (the day after the current one … latest_due_on), the extensions left, who waits. */
@Composable
private fun ExtendDialog(controller: AppController, loan: LendingLoanOut, settings: LendingSettingsOut?, watchers: Int, onDismiss: () -> Unit, onDone: () -> Unit) {
    // The button is off without a range (callers check extendRange first); nothing to show then.
    val range = LendingRules.extendRange(loan) ?: return
    var due by remember { mutableStateOf(range.endInclusive) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    val me = controller.store.me?.id
    val name: (String) -> String = { personName(controller, it) }
    AlertDialog(
        onDismissRequest = { if (!busy) onDismiss() },
        title = { Text(L10n.str(R.string.lending_extend_title, loan.itemName)) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(L10n.str(R.string.lending_current_due, LendingRules.dueText(loan.dueOn, loan.overdueDays)), style = MaterialTheme.typography.bodyMedium)
                DateField(stringResource(R.string.lending_new_due_date), due, range) { due = it }
                LendingRules.extensionsLeft(loan, settings)?.let { left ->
                    Text(L10n.str(R.string.lending_extensions_left, left), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                if (watchers > 0) Text(L10n.str(R.string.lending_people_waiting, watchers), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
                error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
            }
        },
        confirmButton = {
            TextButton(enabled = !busy && due in range, onClick = {
                busy = true
                error = null
                scope.launch {
                    controller.lendingCall(changes = true) { it.extendLending(loan.id, due.toString()) }
                        .onSuccess { onDone() }.onFailure { error = LendingRules.errorText(it, me, name) }
                    busy = false
                }
            }) { Text(stringResource(R.string.lending_extend)) }
        },
        dismissButton = { TextButton(onClick = onDismiss, enabled = !busy) { Text(stringResource(R.string.common_cancel)) } },
    )
}

/**
 * The teacher's 「許可していない」 (asked first, with an optional word for the borrower) or 「確認した」 (§3.2, §5.3): only the
 * teacher named may press them (403 lending_not_approver otherwise). From the loan's page and from the activity row.
 */
@Composable
fun LendingDecisionDialog(controller: AppController, loanId: String, decision: String, onDone: () -> Unit, onDismiss: () -> Unit) {
    var note by rememberSaveable { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    val me = controller.store.me?.id
    val name: (String) -> String = { personName(controller, it) }
    val denied = decision == "denied"
    AlertDialog(
        onDismissRequest = { if (!busy) onDismiss() },
        title = { Text(stringResource(if (denied) R.string.lending_not_approved else R.string.lending_confirm)) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(stringResource(if (denied) R.string.lending_deny_question else R.string.lending_confirm_question), style = MaterialTheme.typography.bodyMedium)
                if (denied) OutlinedTextField(
                    value = note, onValueChange = { note = it.take(200) }, minLines = 2,
                    label = { Text(stringResource(R.string.lending_decision_note)) }, modifier = Modifier.fillMaxWidth(),
                )
                error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
            }
        },
        confirmButton = {
            TextButton(enabled = !busy, onClick = {
                busy = true
                error = null
                scope.launch {
                    controller.lendingCall(changes = true) { it.decideLending(loanId, decision, note.trim().ifEmpty { null }.takeIf { denied }) }
                        .onSuccess { onDone() }.onFailure { error = LendingRules.errorText(it, me, name) }
                    busy = false
                }
            }) { Text(stringResource(if (denied) R.string.lending_not_approved else R.string.lending_confirm)) }
        },
        dismissButton = { TextButton(onClick = onDismiss, enabled = !busy) { Text(stringResource(R.string.common_cancel)) } },
    )
}
