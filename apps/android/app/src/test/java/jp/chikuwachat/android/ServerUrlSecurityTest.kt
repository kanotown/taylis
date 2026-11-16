package jp.chikuwachat.android

import jp.chikuwachat.android.api.Codec
import jp.chikuwachat.android.app.ServerUrlSecurity
import jp.chikuwachat.android.app.Workspaces
import jp.chikuwachat.android.ui.InsecureServerPrompt
import jp.chikuwachat.android.ui.Invite
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * M190 (SECURITY.md §6.1): the server URL classes against apps/shared/server-url-security.json (through the login
 * form's normalization), and the confirmation the login form, the Google button and an invite link go through: asked
 * for plain HTTP to a server on the internet, not for https or a LAN server, and never remembered.
 */
class ServerUrlSecurityTest {
    private fun cases(section: String): List<JsonObject> {
        val file = File("../../shared/server-url-security.json")
        check(file.isFile) { "apps/shared/server-url-security.json not found from ${File("").absolutePath}" }
        return Codec.plain.parseToJsonElement(file.readText()).jsonObject[section]!!.jsonArray.map { it.jsonObject }
    }

    private fun JsonObject.text(key: String) = this[key]!!.jsonPrimitive.content

    @Test
    fun theSharedInputs() {
        val cases = cases("inputs")
        assertTrue(cases.size > 30)
        for (case in cases) {
            val name = "${case.text("name")}: ${case.text("input")}"
            val normalized = Workspaces.normalizeServerUrl(case.text("input"))
            if (case.text("expect") == "invalid") {
                assertNull(name, normalized)
                continue
            }
            assertNotNull("$name was refused", normalized)
            assertEquals("$name → $normalized", case.text("expect"), ServerUrlSecurity.classify(normalized!!).name.lowercase())
        }
    }

    @Test
    fun theSharedHosts() {
        val cases = cases("hosts")
        assertTrue(cases.size > 30)
        for (case in cases) {
            assertEquals(case.text("host"), case.text("expect"), ServerUrlSecurity.classifyHost(case.text("host")).name.lowercase())
        }
    }

    @Test
    fun theHttpsVariantAndAnInviteLinksServer() {
        assertEquals("https://chat.example.com:8080/taylis", ServerUrlSecurity.https("http://chat.example.com:8080/taylis"))
        assertEquals("https://chat.example.com", ServerUrlSecurity.https("HTTP://chat.example.com"))
        assertEquals("https://chat.example.com", ServerUrlSecurity.https("https://chat.example.com"))
        val token = "Zy9_-abcdefghijklmnopqrstuvwxyz0123456789ABC"
        assertEquals(ServerUrlSecurity.INSECURE, ServerUrlSecurity.classify(Invite.parse("http://chat.example.com:8000/invite/$token")!!.server))
        assertEquals(ServerUrlSecurity.LOCAL, ServerUrlSecurity.classify(Invite.parse("http://192.168.1.10:8000/invite/$token")!!.server))
        assertEquals(ServerUrlSecurity.INSECURE, ServerUrlSecurity.classify("not a url"))
    }

    // --- the confirmation (LoginScreen, InviteScreen) ------------------------------------------------

    @Test
    fun httpAcrossTheInternetWaitsForTheChoice() {
        val prompt = InsecureServerPrompt()
        val signedIn = mutableListOf<String>()
        prompt.check("http://Chat.Example.com:8080/") { signedIn += it }
        val request = prompt.pending
        assertNotNull("the dialog is shown", request)
        assertEquals("http://chat.example.com:8080", request!!.url)
        assertEquals("nothing goes to the server before the choice", emptyList<String>(), signedIn)

        prompt.useHttps(request)
        assertNull(prompt.pending)
        assertEquals(listOf("https://chat.example.com:8080"), signedIn)

        // Not remembered: the next sign-in asks again; 「このまま接続」 goes on with the address as typed.
        prompt.check("http://Chat.Example.com:8080/") { signedIn += it }
        prompt.continueAnyway(prompt.pending!!)
        assertEquals(listOf("https://chat.example.com:8080", "http://Chat.Example.com:8080/"), signedIn)

        // 「キャンセル」: nothing.
        prompt.check("http://203.0.113.5") { signedIn += it }
        assertNotNull(prompt.pending)
        prompt.cancel()
        assertNull(prompt.pending)
        assertEquals(2, signedIn.size)
    }

    @Test
    fun httpsAndLanServersAreNotAsked() {
        val prompt = InsecureServerPrompt()
        for (server in listOf("http://192.168.1.10:8000", "http://localhost:8000", "http://taylis:8000", "http://100.101.102.103", "https://chat.example.com",
            "chat.example.com", "", "http://user@chat.example.com")) {
            val signedIn = mutableListOf<String>()
            prompt.check(server) { signedIn += it }
            assertNull(server, prompt.pending)
            assertEquals(server, listOf(server), signedIn)
        }
    }
}
