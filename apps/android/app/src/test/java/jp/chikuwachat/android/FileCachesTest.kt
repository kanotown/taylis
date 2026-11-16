package jp.chikuwachat.android

import jp.chikuwachat.android.platform.FileCaches
import jp.chikuwachat.android.ui.DownloadCache
import jp.chikuwachat.android.ui.WorkspaceImageCaches
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.nio.file.Files

/**
 * 2026-11-16 (a hostile-server review): downloaded files and pictures are kept per workspace, a file is reused only when
 * this process downloaded it (never on its size alone), and a sign-out takes the workspace's files with it.
 */
class FileCachesTest {
    private val a = "https://a.example.com"
    private val b = "https://b.example.com"

    private fun withCache(block: (File) -> Unit) {
        val dir = Files.createTempDirectory("cache").toFile()
        try { block(dir) } finally { dir.deleteRecursively() }
    }

    @Test fun eachWorkspaceHasItsOwnFolder() = withCache { cache ->
        val inA = File(FileCaches.downloads(cache, a), DownloadCache.path("0190a8c2-7d3e-7b1a-9c4e-1f2a3b4c5d6e", "資料.pdf"))
        val inB = File(FileCaches.downloads(cache, b), DownloadCache.path("0190a8c2-7d3e-7b1a-9c4e-1f2a3b4c5d6e", "資料.pdf"))
        assertNotEquals(inA, inB)
        assertTrue(inA.path.startsWith(File(cache, "downloads").path)) // still under the FileProvider's downloads/
        assertEquals(16, FileCaches.serverFolder(a).length)
        assertFalse(FileCaches.downloads(cache, a).path.contains("example")) // no address in clear on disk
        assertNotEquals(FileCaches.previews(cache, a), FileCaches.previews(cache, b))
    }

    @Test fun aFileIsReusedOnlyWhenThisProcessDownloadedIt() = withCache { cache ->
        val file = File(FileCaches.downloads(cache, a), "id/clip.mp4").apply { parentFile!!.mkdirs(); writeBytes(ByteArray(300)) }
        // The right size alone (planted, or left from before) is not enough.
        assertFalse(FileCaches.reusable(file, 300))
        FileCaches.markComplete(file)
        assertTrue(FileCaches.reusable(file, 300))
        assertFalse(FileCaches.reusable(file, 301))
        assertFalse(FileCaches.reusable(file, null))
        file.writeBytes(ByteArray(301)) // changed since
        assertFalse(FileCaches.reusable(file, 301))
    }

    @Test fun aSignOutTakesTheWorkspacesFiles() = withCache { cache ->
        val inA = File(FileCaches.downloads(cache, a), "id/a.pdf").apply { parentFile!!.mkdirs(); writeText("a") }
        val previewA = File(FileCaches.previews(cache, a), "id/preview.pdf").apply { parentFile!!.mkdirs(); writeText("a") }
        val inB = File(FileCaches.downloads(cache, b), "id/b.pdf").apply { parentFile!!.mkdirs(); writeText("b") }
        FileCaches.markComplete(inA)
        FileCaches.forget(cache, a)
        assertFalse(inA.exists())
        assertFalse(previewA.exists())
        assertTrue(inB.exists())
        // Downloaded again later: not reused from the old record.
        inA.parentFile!!.mkdirs(); inA.writeText("a")
        assertFalse(FileCaches.reusable(inA, 1))
    }

    @Test fun theOldLayoutAndUnlistedWorkspacesArePruned() = withCache { cache ->
        val legacy = File(cache, "downloads/0190a8c2-7d3e-7b1a-9c4e-1f2a3b4c5d6e/a.pdf").apply { parentFile!!.mkdirs(); writeText("x") }
        val legacyDrive = File(cache, "downloads/drive/v1/b.pdf").apply { parentFile!!.mkdirs(); writeText("x") }
        val legacyPreview = File(cache, "previews/0190a8c2-7d3e-7b1a-9c4e-1f2a3b4c5d6e/preview.pdf").apply { parentFile!!.mkdirs(); writeText("x") }
        val listed = File(FileCaches.downloads(cache, a), "id/a.pdf").apply { parentFile!!.mkdirs(); writeText("a") }
        val removed = File(FileCaches.downloads(cache, b), "id/b.pdf").apply { parentFile!!.mkdirs(); writeText("b") }
        val camera = File(cache, "camera/photo.jpg").apply { parentFile!!.mkdirs(); writeText("c") }
        FileCaches.prune(cache, listOf(a))
        assertFalse(legacy.exists())
        assertFalse(legacyDrive.exists())
        assertFalse(legacyPreview.exists())
        assertFalse(removed.exists())
        assertTrue(listed.exists())
        assertTrue(camera.exists()) // not a download
    }

    @Test fun picturesInMemoryAreKeptByServerAndPath() {
        val path = "/api/v1/attachments/0190a8c2-7d3e-7b1a-9c4e-1f2a3b4c5d6e/display"
        assertNotEquals(WorkspaceImageCaches.keyOf(a, path), WorkspaceImageCaches.keyOf(b, path))
        assertEquals(WorkspaceImageCaches.keyOf(a, path), WorkspaceImageCaches.keyOf(a, path))
    }
}
