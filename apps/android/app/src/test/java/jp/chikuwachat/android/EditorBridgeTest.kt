package jp.chikuwachat.android

import jp.chikuwachat.android.editor.EditorBridge
import jp.chikuwachat.android.editor.EditorBridgeCodec
import jp.chikuwachat.android.editor.EditorBridgeRefused
import jp.chikuwachat.android.editor.EditorCommand
import jp.chikuwachat.android.editor.EditorTheme
import jp.chikuwachat.android.editor.NativeMessage
import jp.chikuwachat.android.editor.WebMessage
import kotlinx.serialization.builtins.serializer
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.File
import java.util.concurrent.CountDownLatch
import kotlin.concurrent.thread

/**
 * M153a (docs/WIKI.md §30.3 / §30.5): the Kotlin side of the editor bridge against apps/shared/mobile-editor/
 * bridge_messages.json — every native message decodes and encodes back to the fixture's JSON, every web message
 * decodes to its type, the refused examples are refused, the JavaScript call escapes what JSON and JS disagree on, and
 * the transport hands messages from the WebView's thread to the main thread in order.
 */
class EditorBridgeTest {
    private val fixture = run {
        val file = File("../../shared/mobile-editor/bridge_messages.json")
        check(file.isFile) { "apps/shared/mobile-editor/bridge_messages.json not found from ${File("").absolutePath}" }
        Json.parseToJsonElement(file.readText()).jsonObject
    }

    @Test fun theFixtureIsForThisBridgeVersion() {
        assertEquals(jp.chikuwachat.android.editor.EDITOR_BRIDGE_VERSION, fixture.getValue("version").jsonPrimitive.content.toInt())
    }

    @Test fun everyNativeMessageDecodesAndEncodesBackToTheFixture() {
        val examples = fixture.getValue("native_to_web").jsonArray
        assertEquals(15, examples.size)
        val types = HashSet<String>()
        for (example in examples) {
            val raw = example.toString()
            val message = EditorBridgeCodec.decodeNative(raw)
            types.add(example.jsonObject.getValue("type").jsonPrimitive.content)
            val again = Json.parseToJsonElement(EditorBridgeCodec.encode(message))
            assertEquals("the app sends ${example.jsonObject["type"]} as the fixture has it", example, again)
        }
        assertEquals(setOf("load", "replace", "setTheme", "setViewport", "insertImage", "providePeople", "providePages", "provideEmoji", "focus", "blur", "requestBody", "command"), types)
    }

    @Test fun theWholeTreeIsSentWithAnExplicitNullQuery() {
        // The editor checks `query === null` for the whole tree: an absent key would be a query of "undefined".
        val json = EditorBridgeCodec.encode(NativeMessage.ProvidePages(null, emptyList()))
        assertTrue(json, json.contains("\"query\":null"))
        // A field left at its null default is left out (the editor reads an absent title as "keep").
        val load = EditorBridgeCodec.encode(NativeMessage.Load("x"))
        assertEquals("""{"type":"load","body":"x"}""", load)
    }

    @Test fun everyWebMessageDecodesToItsType() {
        val examples = fixture.getValue("web_to_native").jsonArray
        assertEquals(12, examples.size)
        val seen = HashSet<String>()
        for (example in examples) {
            val type = example.jsonObject.getValue("type").jsonPrimitive.content
            val message = EditorBridgeCodec.decodeWeb(example.toString()).getOrElse { fail("$type: ${it.message}"); return }
            val back = EditorBridgeCodec.json.encodeToJsonElement(WebMessage.serializer(), message).jsonObject.getValue("type").jsonPrimitive.content
            assertEquals(type, back)
            seen.add(type)
            when (message) {
                is WebMessage.Ready -> assertEquals(1, message.version)
                is WebMessage.Changed -> assertTrue(message.dirty)
                is WebMessage.BodyRequested -> assertEquals(2, message.caretLine)
                is WebMessage.Caret -> assertEquals(2, message.line)
                is WebMessage.Height -> assertEquals(1240.0, message.px, 0.0)
                is WebMessage.NeedPeople -> assertEquals("ha", message.query)
                is WebMessage.NeedPages -> assertEquals("設計", message.query)
                is WebMessage.OpenLink -> assertTrue(message.url.startsWith("page:") || message.url.startsWith("https://"))
                is WebMessage.Log -> assertEquals("warn", message.level)
                WebMessage.PickImage, WebMessage.FocusTitle -> Unit
            }
        }
        assertEquals(setOf("ready", "changed", "bodyRequested", "caret", "height", "needPeople", "needPages", "pickImage", "openLink", "focusTitle", "log"), seen)
    }

    @Test fun whatCannotBeReadIsRefusedNotThrown() {
        for (example in fixture.getValue("refused").jsonArray) {
            val raw = example.jsonObject.getValue("raw")
            val text = if (raw is kotlinx.serialization.json.JsonPrimitive) raw.content else raw.toString()
            // The web direction: not JSON and an unknown type are refused the same way as the editor refuses them.
            val web = EditorBridgeCodec.decodeWeb(text)
            assertTrue("$text is refused by the app", web.isFailure && web.exceptionOrNull() is EditorBridgeRefused)
            // The app can never send the native examples the editor refuses: its own types stop them.
            val native = runCatching { EditorBridgeCodec.decodeNative(text) }
            assertTrue("$text cannot be made into a native message", native.isFailure)
        }
        // A web message with a wrong field is refused too.
        assertTrue(EditorBridgeCodec.decodeWeb("""{"type":"changed","body":1,"dirty":true}""").isFailure)
        // Unknown fields a newer bundle adds are ignored.
        assertEquals(WebMessage.Caret(4), EditorBridgeCodec.decodeWeb("""{"type":"caret","line":4,"extra":"x"}""").getOrThrow())
    }

    @Test fun theThemesAndCommandsAreTheEditors() {
        assertEquals(listOf("light", "dark", "system"), EditorTheme.entries.map { EditorBridgeCodec.json.encodeToJsonElement(EditorTheme.serializer(), it).jsonPrimitive.content })
        assertEquals(
            listOf("bold", "italic", "strike", "code", "h1", "h2", "h3", "bullet", "ordered", "task", "quote", "codeBlock", "divider", "link", "mention", "slash", "image", "table", "undo", "redo", "indent", "outdent"),
            EditorCommand.entries.map { EditorBridgeCodec.json.encodeToJsonElement(EditorCommand.serializer(), it).jsonPrimitive.content },
        )
    }

    @Test fun theJavaScriptCallCarriesTheJsonAsOneStringLiteral() {
        val body = "a \"quoted\" line\\with backslash\nnext\r\nline\ttab sep  絵文字 😀 </script>"
        val call = EditorBridgeCodec.receiveCall(NativeMessage.Load(body))
        assertTrue(call, call.startsWith("window.taylisEditor.receive(\"") && call.endsWith("\")"))
        // The literal is also valid JSON (JS and JSON string escapes agree once U+2028 / U+2029 are escaped).
        val literal = call.removePrefix("window.taylisEditor.receive(").removeSuffix(")")
        assertTrue(literal, !literal.contains(' ') && !literal.contains(' ') && !literal.contains('\n'))
        val json = Json.decodeFromString(String.serializer(), literal)
        assertEquals(NativeMessage.Load(body), EditorBridgeCodec.decodeNative(json))
    }

    @Test fun messagesPostedFromTheWebViewThreadReachTheListenerOnMainInOrder() {
        val main = ArrayList<Runnable>()
        val got = ArrayList<WebMessage>()
        val refused = ArrayList<String>()
        val evaluated = ArrayList<String>()
        val bridge = EditorBridge(port = { evaluated.add(it) }, main = { main.add(it) }, listener = { got.add(it) }, refused = { refused.add(it.message) })
        val latch = CountDownLatch(1)
        thread {
            bridge.post("""{"type":"ready","version":1}""")
            bridge.post("{not json")
            bridge.post("""{"type":"caret","line":2}""")
            latch.countDown()
        }
        latch.await()
        assertTrue(got.isEmpty()) // nothing until the main thread runs
        main.forEach { it.run() }
        assertEquals(listOf<WebMessage>(WebMessage.Ready(1), WebMessage.Caret(2)), got)
        assertEquals(1, refused.size)
        bridge.send(NativeMessage.Focus)
        assertEquals(listOf("window.taylisEditor.receive(\"{\\\"type\\\":\\\"focus\\\"}\")"), evaluated)
        assertEquals(1, bridge.sent)
    }
}
