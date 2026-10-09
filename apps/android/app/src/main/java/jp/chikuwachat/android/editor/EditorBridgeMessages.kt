package jp.chikuwachat.android.editor

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json

/*
 * M153a (docs/WIKI.md §30.3 / §30.5): the messages of the bridge between the app and the page editor bundled in
 * assets/editor (the Kotlin copy of apps/shared/mobile-editor/src/bridge.ts; one example of every message is in
 * apps/shared/mobile-editor/bridge_messages.json, which EditorBridgeTest reads). The JSON `type` tells the messages
 * apart. The app sends [NativeMessage]s with `window.taylisEditor.receive(<JSON string>)` and receives [WebMessage]s
 * as JSON strings through the `TaylisBridge.post` JavaScript interface.
 */

/** Bumped in bridge.ts when a message changes shape; `ready` carries the bundle's, and the app refuses another one. */
const val EDITOR_BRIDGE_VERSION = 1

@Serializable
enum class EditorTheme {
    @SerialName("light") LIGHT,
    @SerialName("dark") DARK,
    @SerialName("system") SYSTEM,
}

/** A native toolbar's buttons (`command`): the editor's own formatting actions (bridge.ts EDITOR_COMMANDS). */
@Serializable
enum class EditorCommand {
    @SerialName("bold") BOLD,
    @SerialName("italic") ITALIC,
    @SerialName("strike") STRIKE,
    @SerialName("code") CODE,
    @SerialName("h1") H1,
    @SerialName("h2") H2,
    @SerialName("h3") H3,
    @SerialName("bullet") BULLET,
    @SerialName("ordered") ORDERED,
    @SerialName("task") TASK,
    @SerialName("quote") QUOTE,
    @SerialName("codeBlock") CODE_BLOCK,
    @SerialName("divider") DIVIDER,
    @SerialName("link") LINK,
    @SerialName("mention") MENTION,
    @SerialName("slash") SLASH,
    @SerialName("image") IMAGE,
    @SerialName("table") TABLE,
    @SerialName("undo") UNDO,
    @SerialName("redo") REDO,
    @SerialName("indent") INDENT,
    @SerialName("outdent") OUTDENT,
}

/** A person or a group `@` offers; `<@id>` chips show their names. The directory's own field name, `display_name`. */
@Serializable
data class BridgePerson(
    val id: String,
    /** What is typed after `@` (a group's name for a group). */
    val username: String,
    @SerialName("display_name") val displayName: String,
    /** "user" (the default) or "group". */
    val kind: String? = null,
    /** An AI bot (the 「AI」 badge). */
    val ai: Boolean? = null,
    /** A group's size, for its row. */
    val members: Int? = null,
    val description: String? = null,
)

/** A page `[[`, `@` and ⌘K offer, and the icon / title of `[label](page:id)` chips. */
@Serializable
data class BridgePage(val id: String, val title: String, val icon: String? = null, val kind: String? = null)

/** A custom emoji of the workspace: `:name:` is drawn from `url` (an image) or as a text pill (`kind` "text", `color`). */
@Serializable
data class BridgeEmoji(
    val name: String,
    val url: String? = null,
    val label: String? = null,
    val kind: String? = null,
    val color: String? = null,
    val width: Int? = null,
    val height: Int? = null,
)

/** App → editor. */
@Serializable
sealed class NativeMessage {
    /**
     * A page's body into a new editor. `caretLine`: the body line to put the caret on (from the Markdown editor).
     * `attachmentUrl`: where `![alt](attachment:<id>)` images load from, `{id}` standing for the id.
     */
    @Serializable
    @SerialName("load")
    data class Load(
        val body: String,
        val title: String? = null,
        val theme: EditorTheme? = null,
        val readOnly: Boolean? = null,
        val caretLine: Int? = null,
        val locale: String? = null,
        val attachmentUrl: String? = null,
    ) : NativeMessage()

    /** The body as the server now holds it (a merge): only the changed blocks are replaced, never during an IME composition. */
    @Serializable
    @SerialName("replace")
    data class Replace(val body: String) : NativeMessage()

    @Serializable
    @SerialName("setTheme")
    data class SetTheme(val theme: EditorTheme) : NativeMessage()

    /** What the keyboard covers in CSS px (0 when the WebView is resized above it, as on Android with adjustResize). */
    @Serializable
    @SerialName("setViewport")
    data class SetViewport(val keyboardHeight: Int, val safeBottom: Int? = null) : NativeMessage()

    /** The answer to `pickImage`: an image block at the caret. `url`: this image's own URL when not the template's. */
    @Serializable
    @SerialName("insertImage")
    data class InsertImage(val attachmentId: String, val url: String? = null, val alt: String? = null) : NativeMessage()

    /** The whole directory `@` offers (sent before `load`, and again when it changes). */
    @Serializable
    @SerialName("providePeople")
    data class ProvidePeople(val people: List<BridgePerson>) : NativeMessage()

    /** The answer to `needPages` for `query`; `query` null is the whole tree (the editor then filters by itself). */
    @Serializable
    @SerialName("providePages")
    data class ProvidePages(val query: String?, val pages: List<BridgePage>) : NativeMessage()

    @Serializable
    @SerialName("provideEmoji")
    data class ProvideEmoji(val emoji: List<BridgeEmoji>) : NativeMessage()

    @Serializable
    @SerialName("focus")
    data object Focus : NativeMessage()

    @Serializable
    @SerialName("blur")
    data object Blur : NativeMessage()

    /** The body as the editor holds it now, answered at once with `bodyRequested` (leaving, switching to Markdown). */
    @Serializable
    @SerialName("requestBody")
    data object RequestBody : NativeMessage()

    /** A native toolbar's button. */
    @Serializable
    @SerialName("command")
    data class Command(val name: EditorCommand) : NativeMessage()
}

/** Editor → app. */
@Serializable
sealed class WebMessage {
    /** The page is up and listening: `load` may follow. */
    @Serializable
    @SerialName("ready")
    data class Ready(val version: Int) : WebMessage()

    /** The body changed (typing paused 300 ms, or the editor lost the focus). `dirty`: differs from the last load / replace. */
    @Serializable
    @SerialName("changed")
    data class Changed(val body: String, val dirty: Boolean) : WebMessage()

    @Serializable
    @SerialName("bodyRequested")
    data class BodyRequested(val body: String, val dirty: Boolean, val caretLine: Int) : WebMessage()

    /** The body line the caret's block starts on (when the editor loses the focus). */
    @Serializable
    @SerialName("caret")
    data class Caret(val line: Int) : WebMessage()

    /** The document's height in CSS px, when it changed. */
    @Serializable
    @SerialName("height")
    data class Height(val px: Double) : WebMessage()

    /** `@` opened or its query changed; the app may send `providePeople` again. */
    @Serializable
    @SerialName("needPeople")
    data class NeedPeople(val query: String) : WebMessage()

    /** `[[`, `@` or ⌘K look for pages: answered with `providePages` for the same query. */
    @Serializable
    @SerialName("needPages")
    data class NeedPages(val query: String) : WebMessage()

    /** The image button / `/画像`: the app picks a picture, uploads it and sends `insertImage`. */
    @Serializable
    @SerialName("pickImage")
    data object PickImage : WebMessage()

    /** A link, page chip or file chip was tapped: `https://…`, `page:<id>` or `attachment:<id>`. */
    @Serializable
    @SerialName("openLink")
    data class OpenLink(val url: String) : WebMessage()

    /** ↑ on the body's first line: the app may focus the title. */
    @Serializable
    @SerialName("focusTitle")
    data object FocusTitle : WebMessage()

    /** A line for the app's log (an error in the page, a refused message, a refused action). */
    @Serializable
    @SerialName("log")
    data class Log(val level: String, val message: String, val detail: String? = null) : WebMessage()
}

/** A web message the app could not take, and why (never thrown at the bridge: it is logged). */
class EditorBridgeRefused(val raw: String, override val message: String) : Exception(message)

object EditorBridgeCodec {
    /**
     * `type` tells the messages apart. Nulls are written out (`providePages.query` null means the whole tree: the
     * editor checks for null, not for an absent key), while a field left at its null default is left out.
     */
    val json: Json = Json {
        classDiscriminator = "type"
        ignoreUnknownKeys = true
        explicitNulls = true
        encodeDefaults = false
    }

    fun encode(message: NativeMessage): String = json.encodeToString(NativeMessage.serializer(), message)

    /** For the tests: the fixture's native messages as the app would send them. */
    fun decodeNative(raw: String): NativeMessage = json.decodeFromString(NativeMessage.serializer(), raw)

    /** A web message from `TaylisBridge.post`, or [EditorBridgeRefused] (not JSON, an unknown type, a wrong field). */
    fun decodeWeb(raw: String): Result<WebMessage> = try {
        Result.success(json.decodeFromString(WebMessage.serializer(), raw))
    } catch (e: SerializationException) {
        Result.failure(EditorBridgeRefused(raw, e.message ?: "not a web message"))
    } catch (e: IllegalArgumentException) {
        Result.failure(EditorBridgeRefused(raw, e.message ?: "not a web message"))
    }

    /** The JavaScript the WebView evaluates to hand a message over: the JSON as one string literal. */
    fun receiveCall(message: NativeMessage): String = "window.taylisEditor.receive(" + jsStringLiteral(encode(message)) + ")"

    /**
     * A JavaScript string literal of `text` (double-quoted). JSON's escapes, plus U+2028 / U+2029 (line terminators in
     * older engines) and every other control character as `\uXXXX`.
     */
    fun jsStringLiteral(text: String): String {
        val out = StringBuilder(text.length + 16)
        out.append('"')
        for (c in text) {
            when {
                c == '"' -> out.append("\\\"")
                c == '\\' -> out.append("\\\\")
                c == '\n' -> out.append("\\n")
                c == '\r' -> out.append("\\r")
                c == '\t' -> out.append("\\t")
                c < ' ' || c == ' ' || c == ' ' -> out.append("\\u").append(String.format("%04x", c.code))
                else -> out.append(c)
            }
        }
        out.append('"')
        return out.toString()
    }
}
