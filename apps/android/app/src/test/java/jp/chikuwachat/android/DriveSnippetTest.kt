package jp.chikuwachat.android

import jp.chikuwachat.android.api.Codec
import jp.chikuwachat.android.api.DriveSearchHitOut
import jp.chikuwachat.android.api.DriveSearchOut
import jp.chikuwachat.android.ui.SEARCH_HIT
import jp.chikuwachat.android.ui.drivePageLabel
import jp.chikuwachat.android.ui.driveSnippet
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** docs/DRIVE.md §29: a drive search hit inside a file — the pieces, the page, and an older server's answer. */
class DriveSnippetTest {
    private val item = """{"id":"a","location_id":"w","parent_id":"r","kind":"file","name":"報告.pdf","size_bytes":10,""" +
        """"content_type":"application/pdf","created_at":"x","updated_at":"x","version_count":1,"file":null,"link_count":0}"""

    @Test
    fun aHitInsideAFileReadsItsSnippet() {
        val json = """{"items":[{"item":$item,"path":[],"location_kind":"workspace","match":"content",""" +
            """"snippet":[{"text":"…共振器の","hit":false},{"text":"品質係数","hit":true},{"text":"は高い…"}],"page":2}],""" +
            """"next_cursor":null,"keywords":["品質係数"]}"""
        val hit = Codec.snake.decodeFromString(DriveSearchOut.serializer(), json).items.single()
        assertEquals("content", hit.match)
        assertEquals(2, hit.page)
        assertEquals(listOf(false, true, false), hit.snippet?.map { it.hit })
        assertEquals("…共振器の品質係数は高い…", hit.snippetText)
        val line = driveSnippet(hit, "中身", "2 ページ目")!!
        assertEquals("中身 · 2 ページ目  …共振器の品質係数は高い…", line.text)
        val marked = line.spanStyles.filter { it.item == SEARCH_HIT }.map { line.text.substring(it.start, it.end) }
        assertEquals(listOf("品質係数"), marked)
    }

    /** §29.6: a slide or a sheet of a file read from its package is labelled as one; no `page_kind` is a PDF page. */
    @Test
    fun slidesAndSheetsAreLabelled() {
        fun hit(extra: String) = Codec.snake.decodeFromString(
            DriveSearchHitOut.serializer(),
            """{"item":$item,"path":[],"location_kind":"workspace","match":"content","snippet":[{"text":"x","hit":true}]$extra}""",
        )
        val slide = hit(""","page":12,"page_kind":"slide"""")
        assertEquals("slide", slide.pageKind)
        assertEquals(R.string.drive_search_slide, drivePageLabel(slide))
        assertEquals(R.string.drive_search_sheet, drivePageLabel(hit(""","page":2,"page_kind":"sheet"""")))
        assertEquals(R.string.drive_search_page, drivePageLabel(hit(""","page":3""")))
        assertNull(hit(""","page":null,"page_kind":null""").pageKind)
    }

    @Test
    fun aNameHitOrAnOlderServerHasNoSnippet() {
        val json = """{"items":[{"item":$item,"path":[],"location_kind":"workspace"}],"next_cursor":null}"""
        val hit = Codec.snake.decodeFromString(DriveSearchOut.serializer(), json).items.single()
        assertNull(hit.match)
        assertNull(hit.snippetText)
        assertNull(driveSnippet(hit, "中身", null))
    }
}
