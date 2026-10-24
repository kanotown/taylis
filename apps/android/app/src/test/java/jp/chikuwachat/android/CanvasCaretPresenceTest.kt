package jp.chikuwachat.android

import jp.chikuwachat.android.api.Codec
import jp.chikuwachat.android.sync.CanvasCaret
import jp.chikuwachat.android.sync.CanvasCaretThrottle
import jp.chikuwachat.android.sync.CanvasCarets
import jp.chikuwachat.android.sync.CanvasEditor
import jp.chikuwachat.android.sync.CanvasEditors
import jp.chikuwachat.android.sync.CanvasPresenceOut
import jp.chikuwachat.android.sync.CanvasPresenceSender
import jp.chikuwachat.android.sync.ClientFrame
import jp.chikuwachat.android.sync.ServerFrame
import jp.chikuwachat.android.ui.CanvasMarkers
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** CANVAS.md §25: the others' carets in a canvas — the frames, the sender's pace, the editor's throttle, the positions. */
class CanvasCaretPresenceTest {
    @Test fun aCaretThatOnlyMovedGoesOutAfter250MsTheSameOneWaitsForTheRefresh() {
        val sender = CanvasPresenceSender()
        val a = CanvasCaret(2, 5)
        val b = CanvasCaret(2, 6)
        assertEquals(CanvasPresenceOut("c1", true, "議題", a), sender.next("c1", true, "議題", 0, a))
        assertNull(sender.next("c1", true, "議題", 100, b)) // too soon
        assertEquals(CanvasPresenceOut("c1", true, "議題", b), sender.next("c1", true, "議題", 300, b))
        assertNull(sender.next("c1", true, "議題", 5_000, b)) // unchanged: the 20 s refresh only
        assertEquals(CanvasPresenceOut("c1", true, "議題", b), sender.next("c1", true, "議題", 20_300, b))
        // A stop carries no caret.
        assertEquals(CanvasPresenceOut("c1", false, null), sender.next("c1", false, null, 20_400))
    }

    @Test fun theEditorsThrottleSendsAtMostEvery300MsAndTheLastPositionAlways() {
        val throttle = CanvasCaretThrottle()
        assertEquals(0L, throttle.moved(1_000)) // the first move goes out at once
        assertNull(throttle.moved(1_010)) // already on its way (it reads the caret when it goes)
        throttle.sent(1_000)
        assertEquals(250L, throttle.moved(1_050)) // the next one waits for the 300 ms
        assertNull(throttle.moved(1_100))
        assertNull(throttle.moved(1_290)) // typing on: still the one scheduled (trailing edge: the last position)
        throttle.sent(1_300)
        assertEquals(0L, throttle.moved(2_000)) // after a pause: at once
        throttle.reset() // blur: nothing on its way
        assertEquals(0L, throttle.moved(2_010))
    }

    @Test fun framesCarryTheCaretBothWays() {
        val out = Codec.plain.parseToJsonElement(ClientFrame.canvasPresence(CanvasPresenceOut("c1", true, null, CanvasCaret(3, 7)))).jsonObject
        val caret = out["caret"]!!.jsonObject
        assertEquals(3, caret["line"]!!.jsonPrimitive.int)
        assertEquals(7, caret["column"]!!.jsonPrimitive.int)
        // None known, or a stop: left out (an older server reads the frame as before).
        assertFalse(Codec.plain.parseToJsonElement(ClientFrame.canvasPresence(CanvasPresenceOut("c1", true, null))).jsonObject.containsKey("caret"))
        assertFalse(Codec.plain.parseToJsonElement(ClientFrame.canvasPresence(CanvasPresenceOut("c1", false, null, CanvasCaret(1, 1)))).jsonObject.containsKey("caret"))

        assertEquals(
            ServerFrame.CanvasPresence("c1", "ch", "u2", true, null, CanvasCaret(4, 0)),
            ServerFrame.parse("""{"type":"canvas_presence","canvas_id":"c1","channel_id":"ch","user_id":"u2","editing":true,"section":null,"caret":{"line":4,"column":0}}"""),
        )
        // Null, broken or negative: no caret; a stop never has one.
        assertNull((ServerFrame.parse("""{"type":"canvas_presence","canvas_id":"c1","user_id":"u2","editing":true,"caret":null}""") as ServerFrame.CanvasPresence).caret)
        assertNull((ServerFrame.parse("""{"type":"canvas_presence","canvas_id":"c1","user_id":"u2","editing":true,"caret":{"line":"x"}}""") as ServerFrame.CanvasPresence).caret)
        assertNull((ServerFrame.parse("""{"type":"canvas_presence","canvas_id":"c1","user_id":"u2","editing":true,"caret":{"line":-1,"column":0}}""") as ServerFrame.CanvasPresence).caret)
        assertNull((ServerFrame.parse("""{"type":"canvas_presence","canvas_id":"c1","user_id":"u2","editing":false,"caret":{"line":1,"column":0}}""") as ServerFrame.CanvasPresence).caret)
    }

    @Test fun theCaretIsKeptWithThePresenceEntry() {
        val editors = CanvasEditors()
        assertTrue(editors.note("c1", "bob", true, null, 0, CanvasCaret(1, 2)))
        assertEquals(listOf(CanvasEditor("bob", null, CanvasCaret(1, 2))), editors.of("c1", 10))
        editors.note("c1", "bob", true, null, 100, CanvasCaret(1, 3))
        assertEquals(CanvasCaret(1, 3), editors.of("c1", 200).single().caret)
        editors.note("c1", "bob", false, null, 300)
        assertEquals(emptyList<CanvasEditor>(), editors.of("c1", 300))
    }

    @Test fun positionsGoBetweenTheStoredBodyAndTheShownText() {
        val uuid = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b"
        val stored = "# 議事録\n- <@$uuid> さんへ\n- [ ] 予稿 <!--task:0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c-->\nend"
        val markers = CanvasMarkers.Table()
        fun decode(text: String) = markers.hide(text.replace("<@$uuid>", "@bob"))
        fun encode(text: String) = CanvasMarkers.stripStandIns(text).replace("@bob", "<@$uuid>")
        val shown = decode(stored)
        // Their caret after 「さん」 on the mention's line: the column through the mention as shown here.
        val theirs = CanvasCaret(1, "- <@$uuid> さん".length)
        val at = CanvasCarets.shownOffset(stored, shown, 0, theirs, ::decode)!!
        assertEquals("- @bob さん", shown.substring(shown.indexOf("- @bob"), at))
        // Mine at the same place goes out in the stored terms.
        assertEquals(theirs, CanvasCarets.storedCaret(shown, at, 0, ::encode))
        // Past the line's end: clamped to the line. A line not shown here: none.
        val far = CanvasCarets.shownOffset(stored, shown, 0, CanvasCaret(3, 99), ::decode)!!
        assertEquals(shown.length, far)
        assertNull(CanvasCarets.shownOffset(stored, shown, 0, CanvasCaret(9, 0), ::decode))
        // A section's editor shows lines 2… only.
        val section = shown.split("\n").drop(2).joinToString("\n")
        assertEquals(2, CanvasCarets.shownOffset(stored, section, 2, CanvasCaret(2, 2), ::decode))
        assertNull(CanvasCarets.shownOffset(stored, section, 2, CanvasCaret(1, 0), ::decode))
        assertEquals(CanvasCaret(3, 1), CanvasCarets.storedCaret(section, section.indexOf("end") + 1, 2, ::encode))
    }

    @Test fun aPersonKeepsTheirColour() {
        assertEquals(CanvasCarets.color("u1"), CanvasCarets.color("u1"))
        assertTrue(CanvasCarets.COLORS.contains(CanvasCarets.color("0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b")))
        // The desktop's hash (caretColor in ui/remoteCarets.tsx): "a" is 97 → 97 % 8 = 1.
        assertEquals(CanvasCarets.COLORS[1], CanvasCarets.color("a"))
    }
}
