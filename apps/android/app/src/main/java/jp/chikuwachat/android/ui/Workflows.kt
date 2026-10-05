package jp.chikuwachat.android.ui

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import jp.chikuwachat.android.api.ApiException
import jp.chikuwachat.android.api.MessageOut
import jp.chikuwachat.android.api.WorkflowField
import jp.chikuwachat.android.api.WorkflowOut
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.text.Normalizer
import java.time.LocalDate
import java.util.UUID
import jp.chikuwachat.android.R
import jp.chikuwachat.android.L10n

/** One field's value in the form: text (also dates, times and choices), people, or a checkbox. */
sealed interface FieldValue {
    data class Text(val text: String) : FieldValue
    data class Users(val ids: List<String>) : FieldValue
    data class Flag(val on: Boolean) : FieldValue

    fun toJson(): JsonElement = when (this) {
        is Text -> JsonPrimitive(text)
        is Users -> JsonArray(ids.map { JsonPrimitive(it) })
        is Flag -> JsonPrimitive(on)
    }
}

/**
 * Workflows (M95, docs/WORKFLOWS.md §8; the desktop's ui/workflows.ts): the form's checks, its preview and its defaults.
 * The server renders the message that is posted (server/app/modules/workflows/render.py); these follow the same rules,
 * held to them by apps/shared/workflows.json. Defaults are filled here, with this device's date.
 */
object Workflows {
    const val MAX_TEXT = 200
    const val MAX_TEXTAREA = 4000
    const val MAX_USERS = 20
    /** The mark when a workflow has no emoji of its own. */
    const val DEFAULT_EMOJI = "⚡"
    /** How long a channel's list is kept before it is read again (§4: devices keep it a minute). */
    const val CACHE_MS = 60_000L

    private val WEEKDAYS: List<String> get() = L10n.weekdaysMondayFirst // 0 = Monday

    val VALUE_ERROR_TEXT get() = mapOf(
        "required" to L10n.str(R.string.workflows_required),
        "invalid" to L10n.str(R.string.workflows_invalid_format),
        "too_long" to L10n.str(R.string.workflows_too_long),
        "not_an_option" to L10n.str(R.string.workflows_choose_from_the_options),
        "user_not_found" to L10n.str(R.string.workflows_includes_people_who_cant_be_chosen),
    )

    // JavaScript's `\s` spelled out: the JVM's `\s` is ASCII only, and Android's ICU patterns refuse `(?U)`.
    private const val WS = "\\t\\n\\u000B\\f\\r \\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF"
    private val PLACEHOLDER = Regex("\\{\\{[$WS]*([^{}$WS]+)[$WS]*\\}\\}")
    private val KEY = Regex("""^[\p{L}\p{N}_]{1,30}$""")
    private val DATE = Regex("""^([0-9]{4})-([0-9]{2})-([0-9]{2})$""")
    private val TIME = Regex("""^([01][0-9]|2[0-3]):([0-5][0-9])$""")
    private val DATETIME = Regex("""^([0-9]{4}-[0-9]{2}-[0-9]{2})T(([01][0-9]|2[0-3]):([0-5][0-9]))$""")
    private val UUID_PATTERN = Regex("""^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$""")
    private val CONTROL = Regex("[\\x00-\\x08\\x0b\\x0c\\x0e-\\x1f\\x7f]")
    private val SPACES = Regex("[$WS]+")
    private val MENTION_START = Regex("<(?=[@!])")
    private val COMMAND_PREFIX = Regex("""^/([\p{L}\p{N}_-]*)$""")
    private val WF_PREFIX = Regex("^/wf[$WS]+([\\s\\S]*)$", RegexOption.IGNORE_CASE)

    private fun nfc(text: String): String = Normalizer.normalize(text, Normalizer.Form.NFC)
    private fun length(text: String): Int = text.codePointCount(0, text.length)

    fun validKey(key: String): Boolean = key == nfc(key) && KEY.matches(key)

    /** The keys of `{{key}}`, in order of first appearance. */
    fun placeholders(template: String): List<String> =
        PLACEHOLDER.findAll(template).map { nfc(it.groupValues[1]) }.distinct().toList()

    private fun parseDate(value: String): LocalDate? {
        val g = DATE.matchEntire(value)?.groupValues ?: return null
        return runCatching { LocalDate.of(g[1].toInt(), g[2].toInt(), g[3].toInt()) }.getOrNull()
    }

    private fun weekdayOf(date: LocalDate): Int = date.dayOfWeek.value - 1 // 0 = Monday

    /** 「2026年7月28日 (火)」 for `YYYY-MM-DD`; "" when it is not a date. */
    fun dateLabel(value: String): String {
        val day = parseDate(value) ?: return ""
        return L10n.str(R.string.workflows_long_date, day.year, day.monthValue, day.dayOfMonth, WEEKDAYS[weekdayOf(day)])
    }

    private fun validDatetime(value: String): Boolean {
        val g = DATETIME.matchEntire(value)?.groupValues ?: return false
        return parseDate(g[1]) != null
    }

    fun emptyValue(field: WorkflowField): FieldValue = when (field.type) {
        "user" -> FieldValue.Users(emptyList())
        "checkbox" -> FieldValue.Flag(false)
        else -> FieldValue.Text("")
    }

    /** The value in its stored shape, or the reason it is refused (the server's _clean_one); `raw` as sent (JSON). */
    private fun cleanOne(field: WorkflowField, raw: JsonElement?): Pair<FieldValue?, String?> {
        if (raw == null || raw is JsonNull) return emptyValue(field) to null
        val kind = field.type
        if (kind == "checkbox") {
            val on = (raw as? JsonPrimitive)?.takeIf { !it.isString }?.booleanOrNull ?: return null to "invalid"
            return FieldValue.Flag(on) to null
        }
        if (kind == "user") {
            val items: List<JsonElement> = when (raw) {
                is JsonPrimitive -> listOf(raw)
                is JsonArray -> raw
                else -> return null to "invalid"
            }
            val ids = ArrayList<String>()
            for (item in items) {
                val text = (item as? JsonPrimitive)?.takeIf { it.isString }?.content ?: return null to "invalid"
                if (!UUID_PATTERN.matches(text)) return null to "invalid"
                val id = text.lowercase()
                if (id !in ids) ids += id
            }
            if (ids.size > (if (field.multiple) MAX_USERS else 1)) return null to "too_long"
            return FieldValue.Users(ids) to null
        }
        val string = (raw as? JsonPrimitive)?.takeIf { it.isString }?.content ?: return null to "invalid"
        var value = CONTROL.replace(string.replace("\r\n", "\n"), "")
        if (kind == "text") {
            value = value.split(SPACES).filter { it.isNotEmpty() }.joinToString(" ")
            return if (length(value) > MAX_TEXT) null to "too_long" else FieldValue.Text(value) to null
        }
        value = value.trim()
        if (kind == "textarea") return if (length(value) > MAX_TEXTAREA) null to "too_long" else FieldValue.Text(value) to null
        if (value.isEmpty()) return FieldValue.Text("") to null
        val error = when (kind) {
            "select" -> if (value in field.options) null else "not_an_option"
            "date" -> if (parseDate(value) == null) "invalid" else null
            "time" -> if (!TIME.matches(value)) "invalid" else null
            "datetime" -> if (!validDatetime(value)) "invalid" else null
            else -> null
        }
        return if (error != null) null to error else FieldValue.Text(value) to null
    }

    fun isBlank(field: WorkflowField, value: FieldValue?): Boolean = when (value) {
        is FieldValue.Flag -> !value.on
        is FieldValue.Text -> value.text.isEmpty()
        is FieldValue.Users -> value.ids.isEmpty()
        null -> true
    }

    /** Every field's value in its stored shape (`values`), or a reason per key (`errors`, unknown keys included). */
    data class Cleaned(val values: Map<String, FieldValue>?, val errors: Map<String, String>?)

    fun cleanValues(fields: List<WorkflowField>, values: Map<String, JsonElement>): Cleaned {
        val errors = LinkedHashMap<String, String>()
        val known = fields.map { it.key }.toSet()
        for (key in values.keys) if (key !in known) errors[key] = "invalid"
        val cleaned = LinkedHashMap<String, FieldValue>()
        for (field in fields) {
            val (value, error) = cleanOne(field, values[field.key])
            if (error != null || value == null) { errors[field.key] = error ?: "invalid"; continue }
            if (field.required && isBlank(field, value)) { errors[field.key] = "required"; continue }
            cleaned[field.key] = value
        }
        return if (errors.isNotEmpty()) Cleaned(null, errors) else Cleaned(cleaned, null)
    }

    /** The form's values, as JSON for [cleanValues] and the request. */
    fun json(values: Map<String, FieldValue>): Map<String, JsonElement> = values.mapValues { it.value.toJson() }

    /** A typed value cannot call anyone: `<@…` and `<!…` lose their `<`. */
    // i18n: keep (a full-width bracket that defuses a mention)
    fun escapeText(value: String): String = MENTION_START.replace(value, "＜")

    fun formatValue(field: WorkflowField, value: FieldValue?): String {
        if (field.type == "checkbox") return if ((value as? FieldValue.Flag)?.on == true) L10n.str(R.string.workflows_yes) else L10n.str(R.string.workflows_no)
        if (field.type == "user") return (value as? FieldValue.Users)?.ids.orEmpty().joinToString(" ") { "<@$it>" }
        val text = (value as? FieldValue.Text)?.text.orEmpty()
        if (text.isEmpty()) return ""
        return when (field.type) {
            "date" -> dateLabel(text)
            "datetime" -> DATETIME.matchEntire(text)?.groupValues?.let { g -> if (parseDate(g[1]) != null) "${dateLabel(g[1])} ${g[2]}" else "" } ?: ""
            "time" -> text
            else -> escapeText(text)
        }
    }

    /**
     * Review v0.1.30 #4: `trusted[i]` says whether `text[i]` came from the template or a user field. A `<` followed by
     * `@`, `!` or `#` starts a token up to the next `>` (just those two characters when no `>` follows); when any of it
     * was typed, the `<` becomes U+FF1C, so no mention is put together from a value and its surroundings (the server's
     * `_neutralize`).
     */
    private fun neutralize(text: String, trusted: List<Boolean>): String {
        val out = StringBuilder(text)
        for (i in 0 until text.length - 1) {
            if (text[i] != '<' || text[i + 1] !in "@!#") continue
            val close = text.indexOf('>', i + 2)
            val end = if (close == -1) i + 1 else close
            if ((i..end).any { !trusted[it] }) out.setCharAt(i, '＜')
        }
        return out.toString()
    }

    /**
     * The message body: lines whose placeholders are all empty are left out; replaced once (the server's render).
     * Mentions only from the template and user fields.
     */
    fun render(template: String, fields: List<WorkflowField>, values: Map<String, FieldValue>): String {
        val texts = fields.associate { it.key to formatValue(it, values[it.key] ?: emptyValue(it)) }
        val userKeys = fields.filter { it.type == "user" }.map { it.key }.toSet()
        val out = StringBuilder()
        val trusted = ArrayList<Boolean>()
        fun emit(piece: String, isTrusted: Boolean) {
            out.append(piece)
            repeat(piece.length) { trusted += isTrusted }
        }
        var started = false
        for (line in template.replace("\r\n", "\n").split("\n")) {
            val keys = PLACEHOLDER.findAll(line).map { nfc(it.groupValues[1]) }.toList()
            if (keys.isNotEmpty() && keys.all { key -> texts[key]?.isEmpty() ?: false }) continue
            if (started) emit("\n", true)
            started = true
            var at = 0
            for (match in PLACEHOLDER.findAll(line)) {
                emit(line.substring(at, match.range.first), true)
                val key = nfc(match.groupValues[1])
                val text = texts[key]
                if (text == null) emit(match.value, true) else emit(text, key in userKeys)
                at = match.range.last + 1
            }
            emit(line.substring(at), true)
        }
        return neutralize(out.toString(), trusted).trim('\n')
    }

    /** The preview while the form is being filled: each field that does not check out yet counts as empty. */
    fun renderPreview(template: String, fields: List<WorkflowField>, values: Map<String, FieldValue>): String {
        val cleaned = fields.associate { field -> field.key to (cleanOne(field, values[field.key]?.toJson()).first ?: emptyValue(field)) }
        return render(template, fields, cleaned)
    }

    /** What a field starts with (§3.1): `today` is this device's date, `me` my id. */
    fun defaultValue(field: WorkflowField, today: LocalDate, me: String?): FieldValue {
        val spec = field.default ?: return emptyValue(field)
        fun withTime(date: LocalDate): FieldValue =
            FieldValue.Text(if (field.type == "datetime") "${date}T${spec.time ?: "09:00"}" else date.toString())
        return when (spec.kind) {
            "me" -> if (field.type == "user" && me != null) FieldValue.Users(listOf(me)) else emptyValue(field)
            "today" -> withTime(today)
            "next_weekday" -> {
                val weekday = spec.weekday ?: return emptyValue(field)
                withTime(today.plusDays(((weekday - weekdayOf(today) + 7) % 7).toLong()))
            }
            "literal" -> {
                val literal = spec.value as? JsonPrimitive
                if (field.type == "checkbox") FieldValue.Flag(literal?.takeIf { !it.isString }?.booleanOrNull == true)
                else literal?.takeIf { it.isString }?.contentOrNull?.let { FieldValue.Text(it) } ?: emptyValue(field)
            }
            else -> emptyValue(field)
        }
    }

    fun initialValues(fields: List<WorkflowField>, today: LocalDate, me: String?): Map<String, FieldValue> =
        fields.associate { it.key to defaultValue(it, today, me) }

    private fun fold(text: String): String = nfc(text).lowercase()

    /**
     * The workflow `/name` or `/wf name` opens: `name` and `args` as [SlashCommands.parse] read them. A name with spaces
     * opens only through `/wf`. Null when neither names one. Built-in commands and templates come first (the composer).
     */
    fun findCommand(name: String, args: String, workflows: List<WorkflowOut>): WorkflowOut? {
        if (name == "wf") {
            val wanted = fold(args.trim().replace(SPACES, " "))
            return if (wanted.isEmpty()) null else workflows.firstOrNull { fold(it.name) == wanted }
        }
        if (args.isNotBlank()) return null
        return workflows.firstOrNull { fold(it.name) == fold(name) }
    }

    /** `/` candidates: workflows whose name starts with what follows `/` (no space yet) or `/wf `. */
    fun candidates(text: String, workflows: List<WorkflowOut>): List<WorkflowOut> {
        WF_PREFIX.matchEntire(text)?.let { match ->
            val prefix = fold(match.groupValues[1].replace(SPACES, " ").trimStart())
            return workflows.filter { fold(it.name).startsWith(prefix) }
        }
        val match = COMMAND_PREFIX.matchEntire(text) ?: return emptyList()
        val prefix = fold(match.groupValues[1])
        return workflows.filter { !SPACES.containsMatchIn(it.name) && fold(it.name).startsWith(prefix) }
    }

    /** Whether the text may still become a workflow command (the composer reads the list only then). */
    fun mayBeCommand(text: String): Boolean = text.startsWith("/")

    /** Why I cannot submit it, for the menu (the desktop's runBlockedText); null when I can. `target` is 「#送り先」. */
    fun runBlockedText(runBlocked: String?, target: String): String? = when (runBlocked) {
        "disabled" -> L10n.str(R.string.common_paused)
        "archived" -> L10n.str(R.string.workflows_is_archived, target)
        "not_a_member" -> L10n.str(R.string.workflows_join_to_use_it, target)
        "posting_restricted" -> L10n.str(R.string.workflows_only_owners_and_administrators_can_post, target)
        else -> null
    }

    /** A channel's list kept for [CACHE_MS] (the menu, `/` and the details page read it each time they open). */
    class ListCache(private val clock: () -> Long = { System.currentTimeMillis() }) {
        private val rows = HashMap<String, Pair<Long, List<WorkflowOut>>>()

        fun get(channelId: String): List<WorkflowOut>? = rows[channelId]?.takeIf { clock() - it.first < CACHE_MS }?.second
        fun put(channelId: String, list: List<WorkflowOut>) { rows[channelId] = clock() to list }
        fun clear() = rows.clear()
    }
}

/**
 * One open form (§8 4.): its values, the server's per-field errors, and one `client_msg_id` made when the form opens and
 * kept until it closes, so 投稿 pressed again after a failure (the first request may have gone through) never posts twice:
 * the server answers the retry with the message already made. Lives in the AppController, so a rotation keeps it.
 */
class WorkflowSession(
    val workflow: WorkflowOut,
    /** The conversation it was opened from: posting elsewhere says where it went. */
    val here: String?,
    today: LocalDate,
    me: String?,
    val clientMsgId: String = UUID.randomUUID().toString(),
) {
    var values by mutableStateOf(Workflows.initialValues(workflow.fields, today, me))
        private set
    var errors by mutableStateOf<Map<String, String>>(emptyMap())
        private set
    var problem by mutableStateOf<String?>(null)
        private set
    var busy by mutableStateOf(false)
        private set

    fun set(key: String, value: FieldValue) {
        values = values + (key to value)
        if (key in errors) errors = errors - key
        problem = null
    }

    /** The request's body: the key and the checked values. */
    fun body(cleaned: Map<String, FieldValue>): JsonObject = buildJsonObject {
        put("client_msg_id", JsonPrimitive(clientMsgId))
        put("values", JsonObject(Workflows.json(cleaned)))
    }

    /**
     * Checks the values here, then posts them with the form's one key. The message on success; null when the values do not
     * check out or the server refused (`errors` from `details.fields`, `problem` in words) — the form stays open.
     */
    suspend fun submit(post: suspend (workflowId: String, body: JsonObject) -> MessageOut, describe: (Throwable) -> String): MessageOut? {
        if (busy) return null
        val checked = Workflows.cleanValues(workflow.fields, Workflows.json(values))
        val cleaned = checked.values
        if (cleaned == null) {
            errors = checked.errors.orEmpty()
            problem = L10n.str(R.string.workflows_check_what_you_entered)
            return null
        }
        busy = true
        try {
            return post(workflow.id, body(cleaned))
        } catch (e: CancellationException) {
            throw e
        } catch (e: Throwable) {
            if (e is ApiException.Api && e.code == "workflow_values_invalid") errors = fieldErrors(e.details)
            problem = describe(e)
            return null
        } finally {
            busy = false
        }
    }

    companion object {
        /** `details.fields` of a workflow_values_invalid: a reason per key. */
        fun fieldErrors(details: JsonElement?): Map<String, String> =
            runCatching { details?.jsonObject?.get("fields")?.jsonObject?.mapValues { it.value.jsonPrimitive.content } }.getOrNull().orEmpty()
    }
}
