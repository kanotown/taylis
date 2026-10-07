package jp.chikuwachat.android.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.DragInteraction
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.grid.rememberLazyGridState
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.AutoAwesome
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.Schedule
import androidx.compose.material.icons.outlined.Search
import androidx.compose.material3.BottomSheetDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import jp.chikuwachat.android.api.CustomEmojiOut
import jp.chikuwachat.android.api.EmojiPackOut
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.width
import jp.chikuwachat.android.sync.Store
import kotlinx.coroutines.launch
import jp.chikuwachat.android.R
import jp.chikuwachat.android.L10n
import androidx.compose.ui.res.stringResource

/** One heading of the picker: 「よく使う」, a category, or 「カスタム」; `cells` are glyphs or `:name:` for custom emoji. */
data class EmojiSection(val key: String, val label: String, val cells: List<String>)

/** C9 / C10 (MOBILE_POLISH.md): what the emoji sheet lists, kept apart from the UI for tests. */
object EmojiPicker {
    const val FREQUENT = "frequent"
    const val CUSTOM = "custom"
    /** Two rows of the eight-column grid. */
    const val FREQUENT_MAX = 16
    private val CUSTOM_GLYPH = Regex("^:([^:\\s]+):$")

    fun customName(glyph: String): String? = if (!glyph.startsWith(':')) null else CUSTOM_GLYPH.find(glyph)?.groupValues?.get(1)

    /**
     * 「よく使う」: this device's recently used emoji (QuickReactions' list, most recent first: reactions and emoji put in
     * the composer), as the web's 「最近」. A custom emoji only while it still exists.
     */
    fun frequent(recent: List<String>, customNames: Set<String>, max: Int = FREQUENT_MAX): List<String> =
        recent.filter { it.isNotEmpty() && (customName(it)?.let { name -> name in customNames } ?: true) }.distinct().take(max)

    /**
     * Browsing (no search words), one list as in Slack: 「よく使う」 first when there is any, then 「カスタム」 (M100: the
     * ungrouped custom emoji), then a section per pack ([customAndPacks]), then the standard categories.
     */
    fun sections(recent: List<String>, customNames: List<String>, packs: List<EmojiSection> = emptyList()): List<EmojiSection> {
        val frequent = frequent(recent, customNames.toSet() + packs.flatMap { p -> p.cells.mapNotNull { customName(it) } })
        return buildList {
            if (frequent.isNotEmpty()) add(EmojiSection(FREQUENT, L10n.str(R.string.emoji_picker_sheet_frequently_used), frequent))
            if (customNames.isNotEmpty()) add(EmojiSection(CUSTOM, L10n.str(R.string.common_custom), customNames.map { ":$it:" }))
            addAll(packs)
            EmojiData.categories.forEach { (key, label) -> add(EmojiSection(key, label, standardCells[key].orEmpty())) }
        }
    }

    /** The standard emoji by category, worked out once (the sheet rebuilds its sections on every open). */
    private val standardCells: Map<String, List<String>> by lazy { EmojiData.all.groupBy({ it.category }, { it.glyph }) }

    /** Where each section's heading sits in the browsing grid, which lists a heading and then its cells. */
    fun headerIndices(sections: List<EmojiSection>): IntArray {
        var at = 0
        return IntArray(sections.size) { i -> at.also { at += 1 + sections[i].cells.size } }
    }

    /** The section (its position in the list) that grid item [index] belongs to: the last heading at or above it. */
    fun sectionAt(headers: IntArray, index: Int): Int {
        if (headers.isEmpty()) return -1
        val i = headers.binarySearch(index)
        return if (i >= 0) i else (-i - 2).coerceAtLeast(0)
    }

    const val PACK_PREFIX = "pack:"

    /** M100: 「カスタム」's names (no pack, or a pack this device does not know) and a section per pack, in pack order. */
    fun customAndPacks(custom: Collection<CustomEmojiOut>, packs: List<EmojiPackOut>): Pair<List<String>, List<EmojiSection>> {
        val known = packs.map { it.id }.toSet()
        val ungrouped = custom.filter { it.packId == null || it.packId !in known }.map { it.name }.sorted()
        val sections = packs.map { pack ->
            val cells = custom.filter { it.packId == pack.id }.sortedWith(compareBy({ it.position }, { it.name })).map { ":${it.name}:" }
            EmojiSection(PACK_PREFIX + pack.id, pack.name, cells)
        }.filter { it.cells.isNotEmpty() }
        return ungrouped to sections
    }

    /** M100: search words find custom emoji by name, label and keywords first, then the standard ones. */
    fun search(query: String, custom: Collection<CustomEmojiOut>): List<String> {
        val q = query.trim()
        if (q.isEmpty()) return emptyList()
        return CustomEmoji.candidates(q, custom, limit = 40).map { ":${it.name}:" } + Emoji.search(q.lowercase()).map { it.glyph }
    }

    /** Search words: matching custom emoji (by name) first, then the standard ones (shortcode, then keywords). */
    fun search(query: String, customNames: List<String>): List<String> {
        val q = query.trim().lowercase()
        if (q.isEmpty()) return emptyList()
        return customNames.filter { it.contains(q) }.map { ":$it:" } + Emoji.search(q).map { it.glyph }
    }

    /** The glyph a category's tab shows (its first emoji). */
    fun tabGlyph(key: String): String? = standardCells[key]?.firstOrNull()
}

/**
 * The emoji picker (M11f), a sheet from the bottom as on iOS and Slack (C9; it was a centred dialog with three rows of
 * category chips): a search box, one scrolling row of tabs, and every section in one continuous grid under its heading,
 * which sticks to the top while its section scrolls by (as in Slack): 「よく使う」, 「カスタム」 and the packs, then the
 * standard categories. A tab jumps to its section's heading; the selected tab follows the first visible section. Search
 * by shortcode / keyword (en + ja) lists the hits as one flat grid. Each opening starts at the top.
 */
@OptIn(ExperimentalMaterial3Api::class, ExperimentalFoundationApi::class)
@Composable
fun EmojiPickerSheet(
    onDismiss: () -> Unit,
    onPick: (String) -> Unit,
    /** This device's recent emoji, most recent first (QuickReactions.read). */
    recent: List<String> = emptyList(),
    /**
     * M12f: the custom emoji (under 「カスタム」, found by name; a pick hands back `:name:`) and their images, animated
     * ones moving. The sheet follows the store's version itself: an image that arrives while it is open shows at once.
     */
    store: Store,
    onNeedImage: ((CustomEmojiOut) -> Unit)? = null,
    /** M100: a pack's tab icon is needed (AppController.loadPackTab). */
    onNeedPackTab: ((EmojiPackOut) -> Unit)? = null,
    /** M50: standard emoji only (no 「カスタム」, none in 「よく使う」 or the results), for the quick reactions' slots. */
    plainOnly: Boolean = false,
) {
    val version by store.version.collectAsState()
    val custom = remember(version, plainOnly) { if (plainOnly) emptyList() else store.customEmoji.values.toList() }
    val images = store.emojiImages
    val animations = store.emojiAnimations
    val sheet = rememberModalBottomSheetState()
    val scope = rememberCoroutineScope()
    var query by remember { mutableStateOf("") }
    val customByName = remember(custom) { custom.associateBy { it.name } }
    // M100: a section (and tab) per pack after 「カスタム」, which keeps the ungrouped ones.
    val packs = remember(version, plainOnly) { if (plainOnly) emptyList() else store.sortedEmojiPacks() }
    val split = remember(custom, packs) { EmojiPicker.customAndPacks(custom, packs) }
    val sections = remember(recent, split) { EmojiPicker.sections(recent, split.first, split.second) }
    val headers = remember(sections) { EmojiPicker.headerIndices(sections) }
    val packById = remember(packs) { packs.associateBy { it.id } }
    val searching = query.isNotBlank()
    val results = remember(query, custom) { if (query.isBlank()) emptyList() else EmojiPicker.search(query, custom).distinct() }
    val grid = rememberLazyGridState()
    // New search words (or none) start the grid at the top again.
    LaunchedEffect(query.trim()) { grid.scrollToItem(0) }
    // The tab last tapped stays selected until the list is dragged: near the end the list cannot bring its heading to
    // the top, and the first visible row would name the section before it.
    var chosen by remember { mutableStateOf<Int?>(null) }
    LaunchedEffect(grid) { grid.interactionSource.interactions.collect { if (it is DragInteraction.Start) chosen = null } }
    val current by remember(headers) { derivedStateOf { chosen ?: EmojiPicker.sectionAt(headers, grid.firstVisibleItemIndex) } }
    val tabs = rememberLazyListState()
    // The tab row keeps the selected tab in view as the list scrolls through many sections.
    LaunchedEffect(current, searching) {
        if (searching || current < 0) return@LaunchedEffect
        val info = tabs.layoutInfo
        val tab = info.visibleItemsInfo.firstOrNull { it.index == current }
        if (tab == null || tab.offset < info.viewportStartOffset || tab.offset + tab.size > info.viewportEndOffset) {
            tabs.animateScrollToItem((current - 2).coerceAtLeast(0))
        }
    }
    fun pick(glyph: String) {
        scope.launch { sheet.hide() }.invokeOnCompletion { onPick(glyph) }
    }
    /** M100: a pack's illustrations take two cells; a text emoji as many as its pill needs; the rest one. */
    fun span(section: String, glyph: String, maxLineSpan: Int): GridItemSpan {
        val emoji = EmojiPicker.customName(glyph)?.let { customByName[it] } ?: return GridItemSpan(1)
        return when {
            emoji.isText -> GridItemSpan(kotlin.math.ceil((28 * CustomEmoji.aspect(emoji) + 12) / 44f).toInt().coerceIn(1, maxLineSpan))
            section.startsWith(EmojiPicker.PACK_PREFIX) -> GridItemSpan(2.coerceAtMost(maxLineSpan))
            else -> GridItemSpan(1)
        }
    }
    val chooseLabel = stringResource(R.string.emoji_picker_sheet_choose)
    val headerBackground = BottomSheetDefaults.ContainerColor

    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = sheet) {
        Column(Modifier.fillMaxWidth().fillMaxHeight().imePadding()) {
            OutlinedTextField(
                query, { query = it }, singleLine = true,
                placeholder = { Text(stringResource(R.string.emoji_picker_sheet_search_emoji_e_g_tada_cheers)) },
                leadingIcon = { Icon(Icons.Outlined.Search, contentDescription = null) },
                trailingIcon = if (query.isEmpty()) null else ({ IconButton(onClick = { query = "" }) { Icon(Icons.Outlined.Close, contentDescription = stringResource(R.string.emoji_picker_sheet_clear_search)) } }),
                shape = RoundedCornerShape(24.dp),
                modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp),
            )
            if (!searching) {
                // One row of icon tabs (it wrapped to three rows of chips).
                LazyRow(
                    state = tabs,
                    modifier = Modifier.fillMaxWidth(),
                    contentPadding = PaddingValues(horizontal = 12.dp, vertical = 6.dp),
                    horizontalArrangement = Arrangement.spacedBy(2.dp),
                ) {
                    itemsIndexed(sections, key = { _, section -> section.key }) { index, section ->
                        val selected = current == index
                        Box(
                            Modifier.size(44.dp).clip(CircleShape)
                                .background(if (selected) MaterialTheme.colorScheme.secondaryContainer else Color.Transparent)
                                .clickable { chosen = index; scope.launch { grid.scrollToItem(headers[index]) } }
                                .semantics { contentDescription = section.label; role = Role.Tab; this.selected = selected },
                            contentAlignment = Alignment.Center,
                        ) {
                            val pack = if (section.key.startsWith(EmojiPicker.PACK_PREFIX)) packById[section.key.removePrefix(EmojiPicker.PACK_PREFIX)] else null
                            when {
                                section.key == EmojiPicker.FREQUENT -> Icon(Icons.Outlined.Schedule, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
                                section.key == EmojiPicker.CUSTOM -> Icon(Icons.Outlined.AutoAwesome, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
                                pack != null -> {
                                    // The pack's tab icon, else its first emoji (M100).
                                    val tab = pack.tabVersion?.let { version.let { _ -> store.packTabImages["${pack.id}:$it"] } }
                                    if (tab == null) onNeedPackTab?.invoke(pack)
                                    val first = EmojiPicker.customName(section.cells.first())?.let { customByName[it] }
                                    val firstImage = first?.let { version.let { _ -> images[it.id] } }
                                    if (tab == null && first != null && firstImage == null) onNeedImage?.invoke(first)
                                    when {
                                        tab != null -> Image(tab, contentDescription = null, modifier = Modifier.size(30.dp))
                                        firstImage != null -> Image(firstImage, contentDescription = null, modifier = Modifier.size(28.dp))
                                        else -> Text(pack.name.take(2), style = MaterialTheme.typography.labelSmall)
                                    }
                                }
                                else -> Text(EmojiPicker.tabGlyph(section.key) ?: "?", fontSize = 20.sp)
                            }
                        }
                    }
                }
            } else {
                Box(Modifier.height(8.dp))
            }
            @Composable
            fun Cell(section: String, glyph: String) {
                val emoji = EmojiPicker.customName(glyph)?.let { customByName[it] }
                val big = emoji != null && !emoji.isText && section.startsWith(EmojiPicker.PACK_PREFIX)
                Box(
                    Modifier.height(if (big) 80.dp else 44.dp).fillMaxWidth().clip(RoundedCornerShape(8.dp)).clickable(onClickLabel = chooseLabel) { pick(glyph) }
                        .semantics { contentDescription = emoji?.label ?: glyph },
                    contentAlignment = Alignment.Center,
                ) {
                    if (emoji != null) {
                        // Custom images load only when their cell comes into view.
                        val image = version.let { images[emoji.id] }
                        if (image == null) onNeedImage?.invoke(emoji)
                        val box = when {
                            big -> Modifier.size(64.dp)
                            emoji.isText -> Modifier.height(28.dp).width((28 * CustomEmoji.aspect(emoji)).dp)
                            else -> Modifier.size(28.dp)
                        }
                        if (image != null) EmojiImage(image, animations[emoji.id], contentDescription = null, modifier = box)
                        else Text(glyph, style = MaterialTheme.typography.labelSmall, maxLines = 1)
                    } else {
                        Text(glyph, fontSize = 26.sp, textAlign = TextAlign.Center)
                    }
                }
            }
            LazyVerticalGrid(
                columns = GridCells.Fixed(8), state = grid,
                modifier = Modifier.fillMaxWidth().weight(1f).padding(horizontal = 8.dp),
            ) {
                if (searching) {
                    items(results, key = { "s:$it" }, contentType = { if (it.startsWith(':')) "custom" else "emoji" }, span = { span("search", it, maxLineSpan) }) { Cell("search", it) }
                    if (results.isEmpty()) {
                        item(span = { GridItemSpan(maxLineSpan) }) {
                            Text(
                                stringResource(R.string.common_nothing_found), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                                modifier = Modifier.fillMaxWidth().padding(24.dp), textAlign = TextAlign.Center,
                            )
                        }
                    }
                } else {
                    sections.forEach { section ->
                        // The heading sticks to the top while its section scrolls by; opaque so the cells pass under it.
                        stickyHeader(key = "h:" + section.key, contentType = "header") {
                            Text(
                                section.label, style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant,
                                modifier = Modifier.fillMaxWidth().background(headerBackground).padding(start = 8.dp, top = 10.dp, bottom = 4.dp)
                                    .semantics { heading() },
                            )
                        }
                        val key = section.key
                        items(section.cells, key = { "c:$key:$it" }, contentType = { if (it.startsWith(':')) "custom" else "emoji" }, span = { span(key, it, maxLineSpan) }) { Cell(key, it) }
                    }
                }
            }
        }
    }
}
