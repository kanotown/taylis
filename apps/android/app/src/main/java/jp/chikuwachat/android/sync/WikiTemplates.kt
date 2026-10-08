package jp.chikuwachat.android.sync

import jp.chikuwachat.android.api.ApiException
import jp.chikuwachat.android.api.CanvasTemplateOut
import jp.chikuwachat.android.api.DatabaseOut
import jp.chikuwachat.android.api.DbTemplateRef
import jp.chikuwachat.android.api.PageDuplicateOut
import jp.chikuwachat.android.api.PageItem
import jp.chikuwachat.android.api.PageOut
import jp.chikuwachat.android.api.WikiTemplatesOut
import kotlinx.coroutines.delay
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/*
 * M146 (docs/WIKI.md §22.3, §24.3): templates and duplicating on the phone. A new page starts blank, from a built-in
 * template (`template_key`) or from a template page (`template_page_id`), with this device's zone (`tz`) for the
 * variables; an empty page can 「テンプレートから始める」 (apply-template). A database's 「＋ 新規」 sends nothing for its
 * default template, `template_id` for another, `blank: true` for none. 「複製」 puts the copy beside the original, or —
 * when that place is not mine to change (403 page_edit_restricted) — at the top level once asked. Every create is sent
 * with one key (a retry after a lost answer is one page, not two). Saving as / unsetting a template stays on a computer.
 */

/** Where a new page's content comes from. */
sealed interface PageTemplateChoice {
    data object Blank : PageTemplateChoice
    data class Builtin(val key: String) : PageTemplateChoice
    data class Page(val id: String) : PageTemplateChoice
}

/** What a new row starts from: the database's default (nothing sent), one template, or nothing at all. */
sealed interface RowTemplateChoice {
    data object Default : RowTemplateChoice
    data object Blank : RowTemplateChoice
    data class Template(val id: String) : RowTemplateChoice
}

/** The template endpoints (WIKI.md §24.1), apart from [WikiApi] (ApiClient has all of them). */
interface WikiTemplatesApi {
    suspend fun wikiTemplates(): WikiTemplatesOut
    /** An empty page takes a template's body (and its title and icon when it has none); 409 wiki_page_not_empty otherwise. */
    suspend fun applyWikiTemplate(pageId: String, template: PageTemplateChoice, tz: String?, clientSaveId: String): PageOut
    /** The copy beside the original, or (`topLevel`) at the top level. */
    suspend fun duplicateWikiPage(pageId: String, topLevel: Boolean, clientSaveId: String): PageDuplicateOut
}

/** The request bodies as the server reads them (snake_case; a field left out means "the server decides"). */
object WikiRequests {
    fun createPage(parentId: String?, title: String?, access: String, tz: String?, clientSaveId: String, template: PageTemplateChoice?): JsonObject =
        buildJsonObject {
            parentId?.let { put("parent_id", it) }
            title?.let { put("title", it) }
            if (parentId == null) put("access", access)
            tz?.let { put("tz", it) }
            putTemplate(template)
            put("client_save_id", clientSaveId)
        }

    fun applyTemplate(template: PageTemplateChoice, tz: String?, clientSaveId: String): JsonObject = buildJsonObject {
        putTemplate(template)
        tz?.let { put("tz", it) }
        put("client_save_id", clientSaveId)
    }

    private fun kotlinx.serialization.json.JsonObjectBuilder.putTemplate(template: PageTemplateChoice?) {
        when (template) {
            is PageTemplateChoice.Builtin -> put("template_key", template.key)
            is PageTemplateChoice.Page -> put("template_page_id", template.id)
            PageTemplateChoice.Blank, null -> Unit
        }
    }

    fun createRow(title: String, props: JsonObject, clientSaveId: String, template: RowTemplateChoice, tz: String?): JsonObject = buildJsonObject {
        put("title", title)
        put("props", props)
        when (template) {
            RowTemplateChoice.Default -> Unit
            RowTemplateChoice.Blank -> put("blank", true)
            is RowTemplateChoice.Template -> put("template_id", template.id)
        }
        tz?.let { put("tz", it) }
        put("client_save_id", clientSaveId)
    }

    /** Beside the original: no `parent_id` at all; the top level: `"parent_id": null` (WIKI.md §24.1). */
    fun duplicate(topLevel: Boolean, clientSaveId: String): JsonObject = buildJsonObject {
        if (topLevel) put("parent_id", JsonNull)
        put("client_save_id", clientSaveId)
    }
}

/** The banner over a template: a page template, or a database's row template. */
enum class TemplateBanner { PAGE, ROW }

/** What 「複製」 came to: the copy, or the place beside the original is not mine (ask about the top level). */
sealed interface DuplicateOutcome {
    data class Made(val out: PageDuplicateOut) : DuplicateOutcome
    data object NeedsTopLevel : DuplicateOutcome
}

object WikiTemplates {
    /** The gallery: built-in ones (in the server's order, without hidden ones) and the template pages I can read. */
    data class Gallery(val builtins: List<CanvasTemplateOut>, val pages: List<PageItem>) {
        val isEmpty: Boolean get() = builtins.isEmpty() && pages.isEmpty()
    }

    fun gallery(out: WikiTemplatesOut): Gallery = Gallery(
        out.builtins.filter { !it.hidden }.sortedBy { it.position },
        out.pages.filter { it.deletedAt == null },
    )

    fun banner(page: PageOut?): TemplateBanner? = when {
        page == null || !page.isTemplate -> null
        page.kind == "row" -> TemplateBanner.ROW
        page.kind == "page" -> TemplateBanner.PAGE
        else -> null
    }

    /** 「テンプレートから始める」: an editor's empty page (not a database, not a row). */
    fun canStartFromTemplate(canEdit: Boolean, kind: String, body: String): Boolean = canEdit && kind == "page" && body.isBlank()

    /** The row ＋ list: the default first, then the others (the server's order: oldest first). */
    fun rowTemplates(database: DatabaseOut?): List<DbTemplateRef> {
        val all = database?.templates.orEmpty()
        val default = all.firstOrNull { it.id == database?.defaultTemplateId } ?: return all
        return listOf(default) + all.filter { it.id != default.id }
    }

    /** What the sheet picks first: the default template when there is one, else blank (null). */
    fun initialRowTemplate(database: DatabaseOut?): String? =
        database?.defaultTemplateId?.takeIf { id -> database.templates.any { it.id == id } }

    /**
     * The choice sent for what was picked (null: blank). The default goes as nothing (the server picks it), blank as
     * `blank: true` only when there is a default to skip.
     */
    fun rowChoice(selected: String?, database: DatabaseOut?): RowTemplateChoice {
        val default = initialRowTemplate(database)
        return when {
            selected == null -> if (default == null) RowTemplateChoice.Default else RowTemplateChoice.Blank
            selected == default -> RowTemplateChoice.Default
            else -> RowTemplateChoice.Template(selected)
        }
    }

    // --- a row template's dynamic values (WIKI.md §22.3: {"start": "@today"}, ["@me", …]) ---------------------

    const val TODAY = "@today"
    const val ME = "@me"

    fun isToday(value: JsonElement?): Boolean = when (value) {
        is JsonPrimitive -> value.isString && value.content == TODAY
        is JsonObject -> (value["start"] as? JsonPrimitive)?.takeIf { it.isString }?.content == TODAY
        else -> false
    }

    fun hasMe(value: JsonElement?): Boolean = (value as? JsonArray)?.any { (it as? JsonPrimitive)?.content == ME } == true

    /** 「複製」: one key for the request and its retries; a 403 beside the original asks about the top level (pages only). */
    suspend fun duplicate(
        api: WikiTemplatesApi, pageId: String, kind: String, topLevel: Boolean, key: String,
        wait: suspend (Int) -> Unit = { delay(1_000L * it) },
    ): DuplicateOutcome = try {
        DuplicateOutcome.Made(CanvasRequests.sameKey(key, wait = wait) { k -> api.duplicateWikiPage(pageId, topLevel, k) })
    } catch (e: ApiException.Api) {
        if (!topLevel && kind == "page" && e.status == 403 && e.code == "page_edit_restricted") DuplicateOutcome.NeedsTopLevel else throw e
    }
}
