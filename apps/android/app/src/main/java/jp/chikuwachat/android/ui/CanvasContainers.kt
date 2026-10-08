package jp.chikuwachat.android.ui

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.KeyboardArrowRight
import androidx.compose.material.icons.outlined.Lock
import androidx.compose.material.icons.outlined.TableChart
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import jp.chikuwachat.android.L10n
import jp.chikuwachat.android.R
import jp.chikuwachat.android.api.ApiException
import jp.chikuwachat.android.api.DatabaseOut
import jp.chikuwachat.android.api.DbRow
import jp.chikuwachat.android.api.DbRowRef
import jp.chikuwachat.android.api.DbView
import jp.chikuwachat.android.app.AppController
import jp.chikuwachat.android.sync.PageLabel
import jp.chikuwachat.android.sync.WikiDb
import kotlinx.coroutines.CancellationException

/*
 * M149 (docs/WIKI.md §22.5): the canvas dialect's containers and embedded databases on the phone. A callout is a tinted
 * box with its icon; a toggle a row with a chevron and its title, closed until tapped (open or closed per device: the
 * body never changes); an embedded database the database's title, the view's name and its first 5 rows as compact
 * cards with 「開く」. What they hold is drawn by the caller's block renderer (the canvas's boxes tick with their lines).
 */

/** A callout's tint: subtle in both themes (Notion's palette, as the desktop's styles.css `.md-callout`). */
@Composable
fun calloutBackground(tone: CalloutTone): Color {
    val dark = MaterialTheme.colorScheme.surface.luminance() < 0.5f
    return when (tone) {
        CalloutTone.GRAY -> if (dark) Color(0xFF2F2F2F) else Color(0xFFF1F1EF)
        CalloutTone.YELLOW -> if (dark) Color(0xFF3B3420) else Color(0xFFFBF3DB)
        CalloutTone.RED -> if (dark) Color(0xFF3E2527) else Color(0xFFFDEBEC)
        CalloutTone.GREEN -> if (dark) Color(0xFF233127) else Color(0xFFEDF3EC)
        CalloutTone.BLUE -> if (dark) Color(0xFF1F2D39) else Color(0xFFE7F3F8)
    }
}

/** `::: callout 💡`: the icon (a custom `:name:` drawn as the app's emoji) at the start, the content beside it. */
@Composable
fun CalloutBox(block: BodyBlock.Callout, inline: BodyInline, content: @Composable (BodyBlock) -> Unit) {
    val shape = RoundedCornerShape(8.dp)
    Row(
        Modifier.fillMaxWidth().padding(vertical = 4.dp).clip(shape).background(calloutBackground(block.tone), shape)
            .padding(horizontal = 12.dp, vertical = 10.dp),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        block.icon?.let { icon ->
            Text(
                inline.build(listOf(BodyToken.Text(icon))), inlineContent = inline.inlineContent,
                style = MaterialTheme.typography.titleMedium, maxLines = 1,
                modifier = Modifier.widthIn(min = 22.dp, max = 72.dp).clearAndSetSemantics { contentDescription = L10n.str(R.string.docs_block_callout) },
            )
        }
        Column(Modifier.weight(1f)) {
            block.blocks.forEach { content(it) }
        }
    }
}

/**
 * `::: toggle 見出し`: closed until tapped; open or closed on this device only (kept across scrolling and rotation by the
 * opener's line, never written into the body).
 */
@Composable
fun ToggleBox(block: BodyBlock.Toggle, inline: BodyInline, content: @Composable (BodyBlock) -> Unit) {
    var open by rememberSaveable(block.line) { mutableStateOf(false) }
    val turn by animateFloatAsState(if (open) 90f else 0f, label = "toggle")
    val expanded = stringResource(R.string.home_screen_expanded)
    val collapsed = stringResource(R.string.home_screen_collapsed)
    Column(Modifier.fillMaxWidth().padding(vertical = 2.dp)) {
        Row(
            Modifier.fillMaxWidth().clip(RoundedCornerShape(6.dp))
                .clickable(role = Role.Button, onClickLabel = if (open) collapsed else expanded) { open = !open }
                .semantics { stateDescription = if (open) expanded else collapsed }
                .heightIn(min = 40.dp).padding(vertical = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(
                Icons.AutoMirrored.Outlined.KeyboardArrowRight, contentDescription = null,
                tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(22.dp).rotate(turn),
            )
            Spacer(Modifier.width(4.dp))
            Text(
                if (block.title.isEmpty()) inline.build(listOf(BodyToken.Text(stringResource(R.string.docs_block_toggle)))) else inline.build(block.title),
                inlineContent = inline.inlineContent,
                style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.Medium,
                color = if (block.title.isEmpty()) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.onSurface,
                modifier = Modifier.weight(1f),
            )
        }
        if (open) {
            Column(Modifier.fillMaxWidth().padding(start = 26.dp)) {
                block.blocks.forEach { content(it) }
            }
        }
    }
}

/** What an embedded database shows: loading, its rows, one I cannot read (never its label or name), or unreachable. */
private sealed interface EmbedState {
    data object Loading : EmbedState
    data object Denied : EmbedState
    data object Unreachable : EmbedState
    data class Ready(val database: DatabaseOut, val view: DbView?, val rows: List<DbRow>, val refs: Map<String, DbRowRef>) : EmbedState
}

/** The rows read this session, by database and view: scrolling back to an embed draws it at once (refreshed behind). */
private object EmbedCache {
    private val entries = object : LinkedHashMap<String, EmbedState.Ready>(16, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, EmbedState.Ready>?): Boolean = size > 32
    }

    @Synchronized fun get(key: String): EmbedState.Ready? = entries[key]

    @Synchronized fun put(key: String, value: EmbedState.Ready) { entries[key] = value }

    @Synchronized fun remove(key: String) { entries.remove(key) }
}

/** The rows an embed shows on a phone (WIKI.md §22.5). */
const val EMBED_ROWS = 5

/** A view's name; an unnamed one is called by its type (表 / カレンダー / ボード / リスト / ギャラリー). */
fun embedViewName(view: DbView?): String {
    if (view == null) return L10n.str(R.string.docs_db_table)
    if (view.name.isNotBlank()) return view.name
    return L10n.str(
        when (view.type) {
            "calendar" -> R.string.docs_db_calendar
            "board" -> R.string.docs_block_view_board
            "list" -> R.string.docs_block_view_list
            "gallery" -> R.string.docs_block_view_gallery
            else -> R.string.docs_db_table
        },
    )
}

/**
 * `![label](page:<id>#view=<view>)`: the database's title (from the wiki, never the label), the view's name and its first
 * [EMBED_ROWS] rows as compact cards; 「開く」 or a tap opens the database (a row's card opens the row). A database I
 * cannot read (403 / 404 / not a database) is 「アクセスできないページ」 only.
 */
@Composable
fun EmbeddedDatabase(block: BodyBlock.Embed, controller: AppController) {
    val key = block.pageId + "#" + (block.viewId ?: "")
    var state by remember(key) { mutableStateOf<EmbedState>(EmbedCache.get(key) ?: EmbedState.Loading) }
    val links = LocalPageLinks.current
    val hub = controller.wiki
    LaunchedEffect(key) {
        hub?.resolve(listOf(block.pageId))
        val api = hub?.dbApi
        if (api == null) {
            if (state !is EmbedState.Ready) state = EmbedState.Unreachable
            return@LaunchedEffect
        }
        state = try {
            val database = api.wikiDatabase(block.pageId)
            val view = WikiDb.viewOf(database, block.viewId)
            val rows = api.queryRows(block.pageId, view?.id, null, null, EMBED_ROWS)
            EmbedState.Ready(database, view, rows.rows.take(EMBED_ROWS), rows.refs.associateBy { it.id }).also { EmbedCache.put(key, it) }
        } catch (e: CancellationException) {
            throw e
        } catch (e: ApiException.Api) {
            // 403 / 404 (and a page that is not a database): nothing of it is shown, not even the label.
            if (e.status in 400..499 && e.status != 401 && e.status != 429) {
                EmbedCache.remove(key)
                EmbedState.Denied
            } else state as? EmbedState.Ready ?: EmbedState.Unreachable
        } catch (e: Exception) {
            state as? EmbedState.Ready ?: EmbedState.Unreachable
        }
    }
    val label = links?.label?.invoke(block.pageId)
    val open: (() -> Unit)? = links?.let { l -> { l.open(block.pageId) } }
    val shape = RoundedCornerShape(10.dp)
    val frame = Modifier.fillMaxWidth().padding(vertical = 4.dp).clip(shape)
        .border(1.dp, MaterialTheme.colorScheme.outlineVariant, shape)
    when (val shown = state) {
        EmbedState.Loading -> Box(
            frame.height(EMBED_PLACEHOLDER_HEIGHT).background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.4f))
                .semantics { contentDescription = L10n.str(R.string.docs_block_loading_database) },
        )
        EmbedState.Denied -> Hidden(frame)
        EmbedState.Unreachable -> {
            if (label is PageLabel.Hidden) Hidden(frame)
            else Row(frame.padding(horizontal = 12.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Outlined.TableChart, null, tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(20.dp))
                Spacer(Modifier.width(8.dp))
                Column(Modifier.weight(1f)) {
                    (label as? PageLabel.Known)?.let { Text(titleOf(it), style = MaterialTheme.typography.titleSmall, maxLines = 1, overflow = TextOverflow.Ellipsis) }
                    Text(stringResource(R.string.docs_db_load_failed), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                if (open != null) TextButton(onClick = open) { Text(stringResource(R.string.common_open)) }
            }
        }
        is EmbedState.Ready -> {
            if (label is PageLabel.Hidden) {
                Hidden(frame)
                return
            }
            val ctx = DbUi.context(controller, shown.refs)
            val firstProp = remember(shown) { WikiDb.cardProps(shown.database, shown.view, max = 1).firstOrNull() }
            val title = (label as? PageLabel.Known)?.let(::titleOf)
            Column(
                frame.then(if (open != null) Modifier.clickable(onClick = open) else Modifier)
                    .padding(start = 12.dp, end = 4.dp, top = 6.dp, bottom = 8.dp),
            ) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Icon(Icons.Outlined.TableChart, stringResource(R.string.docs_block_embedded_database), tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(20.dp))
                    Spacer(Modifier.width(8.dp))
                    Column(Modifier.weight(1f)) {
                        if (title != null) Text(title, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.semantics { heading() })
                        Text(embedViewName(shown.view), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                    if (open != null) TextButton(onClick = open) { Text(stringResource(R.string.common_open)) }
                }
                Spacer(Modifier.height(4.dp))
                if (shown.rows.isEmpty()) {
                    Text(stringResource(R.string.docs_db_empty), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(vertical = 6.dp))
                }
                Column(Modifier.padding(end = 8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    shown.rows.forEach { row ->
                        val value = firstProp?.let { WikiDb.cellText(it, row, ctx) }?.takeIf { it.isNotBlank() }
                        val rowShape = RoundedCornerShape(6.dp)
                        Row(
                            Modifier.fillMaxWidth().clip(rowShape).background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.5f), rowShape)
                                .then(if (links != null) Modifier.clickable { links.open(row.id) } else Modifier)
                                .heightIn(min = 36.dp).padding(horizontal = 10.dp, vertical = 6.dp),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(8.dp),
                        ) {
                            row.icon?.takeIf { it.isNotBlank() }?.let { Text(it, style = MaterialTheme.typography.bodyMedium) }
                            Text(row.title.ifBlank { ctx.untitled }, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                            if (value != null) Text(value, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.widthIn(max = 140.dp))
                        }
                    }
                }
            }
        }
    }
}

/** The loading placeholder's height: about a card with a few rows, so the page moves little when it comes. */
private val EMBED_PLACEHOLDER_HEIGHT = 168.dp

private fun titleOf(label: PageLabel.Known): String =
    (label.icon?.takeIf { it.isNotBlank() }?.let { "$it " } ?: "") + label.title.ifBlank { L10n.str(R.string.docs_untitled) }

/** 「アクセスできないページ」: nothing else (not the label, not a name). */
@Composable
private fun Hidden(modifier: Modifier) {
    Row(modifier.padding(horizontal = 12.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
        Icon(Icons.Outlined.Lock, null, tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(18.dp))
        Spacer(Modifier.width(8.dp))
        Text(stringResource(R.string.docs_db_hidden_rows), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

/** An embed outside the canvas's renderer (no controller): a link-like line with the page's current title. */
@Composable
fun EmbedLine(block: BodyBlock.Embed) {
    val links = LocalPageLinks.current
    val label = links?.label?.invoke(block.pageId)
    Text(
        if (label is PageLabel.Hidden) stringResource(R.string.docs_db_hidden_rows) else DocLinkText.page(label, null),
        style = MaterialTheme.typography.bodyMedium,
        color = if (links != null && label !is PageLabel.Hidden) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.padding(vertical = 2.dp).then(
            if (links != null && label !is PageLabel.Hidden) Modifier.clickable(role = Role.Button) { links.open(block.pageId) } else Modifier,
        ),
    )
}
