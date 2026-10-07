package jp.chikuwachat.android.ui

import jp.chikuwachat.android.api.NavItem
import jp.chikuwachat.android.R
import jp.chikuwachat.android.L10n

/**
 * M111 (MOBILE_UI.md §14): which home tiles show and in what order, mine on every device (UserMe.nav_items). The
 * catalogue, the default orders and the rule are apps/shared/nav-items.json (NavItemsTest checks this copy against it).
 */
object NavItems {
    enum class Platform(val key: String) { DESKTOP("desktop"), MOBILE("mobile") }

    data class Entry(val key: String, val label: String, val mobileLabel: String? = null, val visible: Boolean, val platforms: List<Platform>)

    private val BOTH = listOf(Platform.DESKTOP, Platform.MOBILE)

    val catalogue: List<Entry> get() = listOf(
        Entry("threads", L10n.str(R.string.common_thread), visible = true, platforms = BOTH),
        Entry("activity", L10n.str(R.string.common_activity), visible = true, platforms = listOf(Platform.DESKTOP)),
        Entry("times-feed", "Times", visible = true, platforms = listOf(Platform.MOBILE)),
        Entry("drafts", L10n.str(R.string.common_drafts), visible = true, platforms = BOTH),
        Entry("saved", L10n.str(R.string.common_saved), mobileLabel = L10n.str(R.string.common_save), visible = true, platforms = BOTH),
        Entry("reminders", L10n.str(R.string.common_reminders), visible = true, platforms = BOTH),
        Entry("files", L10n.str(R.string.common_files), visible = true, platforms = BOTH),
        Entry("canvases", L10n.str(R.string.common_canvas), visible = true, platforms = BOTH),
        Entry("docs", L10n.str(R.string.docs_title), visible = true, platforms = BOTH),
        Entry("calendar", L10n.str(R.string.common_calendar), visible = true, platforms = BOTH),
        Entry("tasks", L10n.str(R.string.common_tasks), visible = true, platforms = BOTH),
        Entry("deadlines", L10n.str(R.string.common_deadlines), visible = true, platforms = BOTH),
        Entry("reservations", L10n.str(R.string.common_reservations), visible = true, platforms = BOTH),
        // M140 (docs/PRESENCE.md): only while the workspace has the board on (not drawn by this app yet).
        Entry("attendance", L10n.str(R.string.common_attendance), visible = true, platforms = BOTH),
    )

    val order: Map<Platform, List<String>> = mapOf(
        Platform.DESKTOP to listOf("threads", "activity", "drafts", "reminders", "files", "canvases", "docs", "calendar", "tasks", "deadlines", "reservations", "saved", "times-feed", "attendance"),
        Platform.MOBILE to listOf("threads", "times-feed", "drafts", "saved", "reminders", "calendar", "tasks", "deadlines", "reservations", "files", "canvases", "docs", "activity", "attendance"),
    )

    /**
     * The tiles this app has (「予約」 joins when its page exists). アクティビティ is the bottom tab (and the tablet rail's),
     * never a tile, so it cannot be hidden here.
     */
    val implemented: List<String> get() = HomeTile.entries.map { it.navKey }

    private val byKey = catalogue.associateBy { it.key }

    /** The tile's name (the phones' shorter one where it differs). */
    fun label(key: String): String = byKey[key]?.let { it.mobileLabel ?: it.label } ?: key

    /**
     * Everything I have, in my order: not customised (null), the platform's default order and visibility; else my items (a
     * repeated key counts once, unknown keys kept), then each catalogue item I never saved, in the default order, with its
     * default visibility. What a change saves, so the desktop's and newer clients' items survive.
     */
    fun full(stored: List<NavItem>?, platform: Platform = Platform.MOBILE): List<NavItem> {
        val keys = order[platform].orEmpty()
        fun defaults(list: List<String>) = list.map { NavItem(it, byKey[it]?.visible ?: true) }
        if (stored == null) return defaults(keys)
        val seen = mutableSetOf<String>()
        val out = stored.filter { seen.add(it.key) }
        return out + defaults(keys.filter { it !in seen })
    }

    /** The items of [full] this app lists (in the catalogue, on the platform, implemented here), with their switch. */
    fun shown(full: List<NavItem>, platform: Platform = Platform.MOBILE, implemented: List<String> = this.implemented): List<NavItem> =
        full.filter { byKey[it.key]?.platforms?.contains(platform) == true && it.key in implemented }

    /** The settings' new order of the shown items: they take the slots of [full] they had, in that order. */
    fun reorder(full: List<NavItem>, keys: List<String>, platform: Platform = Platform.MOBILE, implemented: List<String> = this.implemented): List<NavItem> {
        val editable = shown(full, platform, implemented).map { it.key }.toSet()
        val items = full.associateBy { it.key }
        val queue = keys.filter { it in editable }.iterator()
        return full.map { item -> if (item.key in editable && queue.hasNext()) items.getValue(queue.next()) else item }
    }

    fun setVisible(full: List<NavItem>, key: String, visible: Boolean): List<NavItem> =
        full.map { if (it.key == key) it.copy(visible = visible) else it }

    /** Moves one shown item [by] places (−1 up, +1 down) among the shown ones. */
    fun move(full: List<NavItem>, key: String, by: Int): List<NavItem> {
        val keys = shown(full).map { it.key }.toMutableList()
        val from = keys.indexOf(key)
        val to = from + by
        if (from < 0 || to !in keys.indices) return full
        keys.removeAt(from)
        keys.add(to, key)
        return reorder(full, keys)
    }

    /** The tiles to draw, in my order. */
    fun tileKeys(stored: List<NavItem>?): List<String> = shown(full(stored)).filter { it.visible }.map { it.key }
}
