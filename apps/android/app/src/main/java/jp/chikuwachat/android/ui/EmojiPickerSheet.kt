package jp.chikuwachat.android.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.DragInteraction
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
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
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.AutoAwesome
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.Schedule
import androidx.compose.material.icons.outlined.Search
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

/** One heading of the picker: 「よく使う」, a category, or 「カスタム」; `cells` are glyphs or `:name:` for custom emoji. */
data class EmojiSection(val key: String, val label: String, val cells: List<String>)

/** C9 / C10 (MOBILE_POLISH.md): what the emoji sheet lists, kept apart from the UI for tests. */
object EmojiPicker {
    const val FREQUENT = "frequent"
    const val CUSTOM = "custom"
    /** Two rows of the eight-column grid. */
    const val FREQUENT_MAX = 16
    private val CUSTOM_GLYPH = Regex("^:([^:\\s]+):$")

    fun customName(glyph: String): String? = CUSTOM_GLYPH.find(glyph)?.groupValues?.get(1)

    /**
     * 「よく使う」: this device's recently used emoji (QuickReactions' list, most recent first: reactions and emoji put in
     * the composer), as the web's 「最近」. A custom emoji only while it still exists.
     */
    fun frequent(recent: List<String>, customNames: Set<String>, max: Int = FREQUENT_MAX): List<String> =
        recent.filter { it.isNotEmpty() && (customName(it)?.let { name -> name in customNames } ?: true) }.distinct().take(max)

    /**
     * Browsing (no search words): 「よく使う」 first when there is any, then the categories, then 「カスタム」 (M100: the
     * ungrouped custom emoji), then a section per pack ([packSections]).
     */
    fun sections(recent: List<String>, customNames: List<String>, packs: List<EmojiSection> = emptyList()): List<EmojiSection> {
        val frequent = frequent(recent, customNames.toSet() + packs.flatMap { p -> p.cells.mapNotNull { customName(it) } })
        return buildList {
            if (frequent.isNotEmpty()) add(EmojiSection(FREQUENT, "よく使う", frequent))
            EmojiData.categories.forEach { (key, label) -> add(EmojiSection(key, label, EmojiData.all.filter { it.category == key }.map { it.glyph })) }
            if (customNames.isNotEmpty()) add(EmojiSection(CUSTOM, "カスタム", customNames.map { ":$it:" }))
            addAll(packs)
        }
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
    fun tabGlyph(key: String): String? = EmojiData.all.firstOrNull { it.category == key }?.glyph
}

private sealed interface PickerItem {
    val key: String
    data class Header(val section: EmojiSection) : PickerItem { override val key get() = "h:" + section.key }
    data class Cell(val section: String, val glyph: String) : PickerItem { override val key get() = "c:$section:$glyph" }
}

/**
 * The emoji picker (M11f), a sheet from the bottom as on iOS and Slack (C9; it was a centred dialog with three rows of
 * category chips): a search box, one scrolling row of category tabs, and every category in one list under its heading,
 * 「よく使う」 first (C10). A tab scrolls to its category; the tab follows the list. Search by shortcode / keyword (en + ja).
 */
@OptIn(ExperimentalMaterial3Api::class)
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
    val customNames = split.first
    val sections = remember(recent, split) { EmojiPicker.sections(recent, customNames, split.second) }
    val packById = remember(packs) { packs.associateBy { it.id } }
    val searching = query.isNotBlank()
    val items: List<PickerItem> = remember(sections, query, custom) {
        if (query.isNotBlank()) EmojiPicker.search(query, custom).distinct().map { PickerItem.Cell("search", it) }
        else sections.flatMap { section -> listOf(PickerItem.Header(section)) + section.cells.map { PickerItem.Cell(section.key, it) } }
    }
    val headerIndex = remember(items) { items.withIndex().filter { it.value is PickerItem.Header }.associate { (it.value as PickerItem.Header).section.key to it.index } }
    val grid = rememberLazyGridState()
    // The tab last tapped stays selected until the list is dragged: near the end the list cannot bring its heading to
    // the top, and the first visible row would name the category before it.
    var chosen by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(grid) { grid.interactionSource.interactions.collect { if (it is DragInteraction.Start) chosen = null } }
    val current by remember(items) {
        derivedStateOf {
            val first = grid.firstVisibleItemIndex
            chosen ?: headerIndex.entries.filter { it.value <= first }.maxByOrNull { it.value }?.key ?: sections.firstOrNull()?.key
        }
    }
    fun pick(glyph: String) {
        scope.launch { sheet.hide() }.invokeOnCompletion { onPick(glyph) }
    }

    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = sheet) {
        Column(Modifier.fillMaxWidth().fillMaxHeight().imePadding()) {
            OutlinedTextField(
                query, { query = it }, singleLine = true,
                placeholder = { Text("絵文字を検索 (例: tada、乾杯、ありがとう)") },
                leadingIcon = { Icon(Icons.Outlined.Search, contentDescription = null) },
                trailingIcon = if (query.isEmpty()) null else ({ IconButton(onClick = { query = "" }) { Icon(Icons.Outlined.Close, contentDescription = "検索語を消す") } }),
                shape = RoundedCornerShape(24.dp),
                modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp),
            )
            if (!searching) {
                // One row of icon tabs (it wrapped to three rows of chips).
                Row(
                    Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 12.dp, vertical = 6.dp),
                    horizontalArrangement = Arrangement.spacedBy(2.dp),
                ) {
                    sections.forEach { section ->
                        val selected = current == section.key
                        Box(
                            Modifier.size(44.dp).clip(CircleShape)
                                .background(if (selected) MaterialTheme.colorScheme.secondaryContainer else Color.Transparent)
                                .clickable { headerIndex[section.key]?.let { index -> chosen = section.key; scope.launch { grid.scrollToItem(index) } } }
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
            LazyVerticalGrid(
                columns = GridCells.Fixed(8), state = grid,
                modifier = Modifier.fillMaxWidth().weight(1f).padding(horizontal = 8.dp),
            ) {
                items(items, key = { it.key }, span = { item ->
                    when (item) {
                        is PickerItem.Header -> GridItemSpan(maxLineSpan)
                        is PickerItem.Cell -> {
                            // M100: a pack's illustrations take two cells; a text emoji as many as its pill needs.
                            val emoji = EmojiPicker.customName(item.glyph)?.let { customByName[it] }
                            when {
                                emoji == null -> GridItemSpan(1)
                                emoji.isText -> GridItemSpan(kotlin.math.ceil((28 * CustomEmoji.aspect(emoji) + 12) / 44f).toInt().coerceIn(1, maxLineSpan))
                                item.section.startsWith(EmojiPicker.PACK_PREFIX) -> GridItemSpan(2.coerceAtMost(maxLineSpan))
                                else -> GridItemSpan(1)
                            }
                        }
                    }
                }) { item ->
                    when (item) {
                        is PickerItem.Header -> Text(
                            item.section.label, style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier.padding(start = 8.dp, top = 12.dp, bottom = 4.dp),
                        )
                        is PickerItem.Cell -> {
                            val emoji = EmojiPicker.customName(item.glyph)?.let { customByName[it] }
                            val big = emoji != null && !emoji.isText && item.section.startsWith(EmojiPicker.PACK_PREFIX)
                            Box(
                                Modifier.height(if (big) 80.dp else 44.dp).fillMaxWidth().clip(RoundedCornerShape(8.dp)).clickable(onClickLabel = "選ぶ") { pick(item.glyph) }
                                    .semantics { contentDescription = emoji?.label ?: item.glyph },
                                contentAlignment = Alignment.Center,
                            ) {
                                if (emoji != null) {
                                    val image = version.let { images[emoji.id] }
                                    if (image == null) onNeedImage?.invoke(emoji)
                                    val box = when {
                                        big -> Modifier.size(64.dp)
                                        emoji.isText -> Modifier.height(28.dp).width((28 * CustomEmoji.aspect(emoji)).dp)
                                        else -> Modifier.size(28.dp)
                                    }
                                    if (image != null) EmojiImage(image, animations[emoji.id], contentDescription = null, modifier = box)
                                    else Text(item.glyph, style = MaterialTheme.typography.labelSmall, maxLines = 1)
                                } else {
                                    Text(item.glyph, fontSize = 26.sp, textAlign = TextAlign.Center)
                                }
                            }
                        }
                    }
                }
                if (searching && items.isEmpty()) {
                    item(span = { GridItemSpan(maxLineSpan) }) {
                        Text(
                            "見つかりません", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier.fillMaxWidth().padding(24.dp), textAlign = TextAlign.Center,
                        )
                    }
                }
            }
        }
    }
}
