package jp.chikuwachat.android.platform

import java.io.File
import java.security.MessageDigest
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * One custom emoji picture (or a pack's tab icon) of one workspace (docs/EMOJI.md, image cache). [version] names the picture:
 * the server's image version when it sends one ([immutable]: never asked again), else a stand-in made of what the list
 * says about the picture (type and size), which is asked again in the background once it is a day old (the server's
 * `max-age`). [path] is where the server serves it.
 */
data class EmojiImageKey(val serverUrl: String, val id: String, val version: String, val immutable: Boolean, val path: String) {
    val memoryKey: String get() = "$serverUrl|$id|$version"
}

/**
 * The pictures on disk (in the app's cache directory, which the system may also empty): one folder per server (its
 * URL hashed, so workspaces never mix), one file per emoji holding the time it was fetched and the bytes as served.
 * Least recently used files go once all of them pass [maxBytes]. A server's folder goes when its session ends.
 */
class EmojiDiskCache(private val root: File, private val maxBytes: Long = 32L * 1024 * 1024, private val clock: () -> Long = System::currentTimeMillis) {
    class Hit(val bytes: ByteArray, val fetchedAt: Long)

    private var total = -1L
    /** Bumped when a server's folder is emptied: a fetch that started before does not write into it afterwards. */
    private val generations = HashMap<String, Int>()

    fun folder(serverUrl: String): File = File(root, sha256(serverUrl).take(32))

    private fun file(key: EmojiImageKey): File = File(folder(key.serverUrl), safe(key.id) + "@" + safe(key.version))

    @Synchronized fun generation(serverUrl: String): Int = generations[serverUrl] ?: 0

    @Synchronized fun read(key: EmojiImageKey): Hit? {
        val file = file(key)
        if (!file.isFile) return null
        val data = try { file.readBytes() } catch (_: Exception) { return null }
        if (data.size <= HEADER || !data.copyOfRange(0, 4).contentEquals(MAGIC)) {
            remove(file)
            return null
        }
        var fetchedAt = 0L
        for (i in 4 until HEADER) fetchedAt = (fetchedAt shl 8) or (data[i].toLong() and 0xff)
        file.setLastModified(clock()) // least recently used goes first
        return Hit(data.copyOfRange(HEADER, data.size), fetchedAt)
    }

    /** Keeps [bytes] as [key]'s picture (another version of the same emoji goes); false when the server was cleared since [generation]. */
    @Synchronized fun write(key: EmojiImageKey, bytes: ByteArray, generation: Int): Boolean {
        if (generation != generation(key.serverUrl)) return false
        val folder = folder(key.serverUrl)
        if (!folder.isDirectory && !folder.mkdirs()) return false
        val target = file(key)
        val prefix = safe(key.id) + "@"
        folder.listFiles()?.filter { it.name.startsWith(prefix) && it.name != target.name }?.forEach { remove(it) }
        val fetchedAt = clock()
        val header = ByteArray(HEADER)
        MAGIC.copyInto(header)
        for (i in 0 until 8) header[HEADER - 1 - i] = (fetchedAt ushr (8 * i)).toByte()
        val part = File(folder, target.name + ".part")
        try {
            part.outputStream().use { it.write(header); it.write(bytes) }
            val old = if (target.isFile) target.length() else 0L
            if (!part.renameTo(target)) { part.delete(); return false }
            target.setLastModified(fetchedAt)
            if (total >= 0) total += target.length() - old
        } catch (_: Exception) {
            part.delete()
            return false
        }
        trim()
        return true
    }

    /** Sign-out or removal of the workspace: its pictures go. */
    @Synchronized fun clear(serverUrl: String) {
        generations[serverUrl] = generation(serverUrl) + 1
        folder(serverUrl).deleteRecursively()
        total = -1L
    }

    @Synchronized fun sizeOnDisk(): Long {
        if (total < 0) total = files().sumOf { it.length() }
        return total
    }

    private fun trim() {
        if (sizeOnDisk() <= maxBytes) return
        for (file in files().sortedBy { it.lastModified() }) {
            if (total <= maxBytes) break
            remove(file)
        }
    }

    private fun remove(file: File) {
        val size = file.length()
        if (file.delete() && total >= 0) total -= size
    }

    private fun files(): List<File> = root.listFiles()?.filter { it.isDirectory }?.flatMap { dir -> dir.listFiles()?.filter { it.isFile && !it.name.endsWith(".part") } ?: emptyList() } ?: emptyList()

    companion object {
        private val MAGIC = byteArrayOf('E'.code.toByte(), 'M'.code.toByte(), 'J'.code.toByte(), '1'.code.toByte())
        private const val HEADER = 12

        fun sha256(text: String): String = MessageDigest.getInstance("SHA-256").digest(text.toByteArray()).joinToString("") { "%02x".format(it) }

        private fun safe(part: String): String = if (part.all { it.isLetterOrDigit() || it == '-' || it == '_' }) part else sha256(part).take(24)
    }
}

/** A least-recently-used map that holds at most [maxSize] by [sizeOf] (android.util.LruCache needs the device; this one tests on the JVM). */
class SizedLru<V : Any>(private val maxSize: Long, private val sizeOf: (V) -> Long) {
    private val map = LinkedHashMap<String, V>(16, 0.75f, true)
    private var size = 0L

    @Synchronized operator fun get(key: String): V? = map[key]

    @Synchronized operator fun set(key: String, value: V) {
        map.put(key, value)?.let { size -= sizeOf(it) }
        size += sizeOf(value)
        val iterator = map.entries.iterator()
        while (size > maxSize && iterator.hasNext()) {
            val eldest = iterator.next()
            if (eldest.key == key) continue
            size -= sizeOf(eldest.value)
            iterator.remove()
        }
    }

    @Synchronized fun removeWhere(predicate: (String) -> Boolean) {
        val iterator = map.entries.iterator()
        while (iterator.hasNext()) {
            val entry = iterator.next()
            if (predicate(entry.key)) { size -= sizeOf(entry.value); iterator.remove() }
        }
    }

    @Synchronized fun keys(): Set<String> = map.keys.toSet()
}

/**
 * Custom emoji pictures, fast (docs/EMOJI.md, image cache, user report 2026-10-15: they loaded slowly every time): decoded ones
 * from memory (kept across workspace switches and new stores), else from disk, else from the server. The server is
 * asked at most [concurrency] at a time, the latest wish first (what was just scrolled into view), each picture once
 * however many places wait for it. Decoding happens on [decodeDispatcher], at the size it is drawn ([decode]).
 */
class EmojiImageLoader<T : Any>(
    private val disk: EmojiDiskCache,
    private val scope: CoroutineScope,
    private val fetch: suspend (EmojiImageKey) -> ByteArray,
    private val decode: (ByteArray) -> T?,
    sizeOf: (T) -> Long,
    memoryBytes: Long,
    private val concurrency: Int = 4,
    private val io: CoroutineDispatcher = Dispatchers.IO,
    private val decodeDispatcher: CoroutineDispatcher = Dispatchers.Default,
    private val clock: () -> Long = System::currentTimeMillis,
    private val maxAgeMs: Long = 24L * 60 * 60 * 1000,
) {
    private val memory = SizedLru(memoryBytes, sizeOf)
    private val lock = Any()
    private val inflight = HashMap<String, Deferred<T?>>()
    private val revalidating = HashSet<String>()
    private val waiting = ArrayDeque<CompletableDeferred<Unit>>()
    private var running = 0

    /** The decoded picture when it is in memory (no work started). */
    fun cached(key: EmojiImageKey): T? = memory[key.memoryKey]

    /**
     * The picture of [key], or null when it could not be had (a later call tries again). [onUpdate] gets a newer
     * picture when an old cached one turned out to have changed on the server.
     */
    suspend fun image(key: EmojiImageKey, onUpdate: ((T) -> Unit)? = null): T? {
        memory[key.memoryKey]?.let { return it }
        val job = synchronized(lock) {
            inflight[key.memoryKey] ?: scope.async { produce(key, onUpdate) }.also { job ->
                inflight[key.memoryKey] = job
                job.invokeOnCompletion { synchronized(lock) { if (inflight[key.memoryKey] === job) inflight.remove(key.memoryKey) } }
            }
        }
        return job.await()
    }

    /** The bytes as served (the page editor draws them itself), from disk or the server. */
    suspend fun bytes(key: EmojiImageKey): ByteArray? {
        withContext(io) { disk.read(key) }?.let { return it.bytes }
        return try { download(key, urgent = true) } catch (e: CancellationException) { throw e } catch (_: Exception) { null }
    }

    /** A workspace's session ended: its pictures go from memory and disk; fetches under way do not put them back. */
    fun clear(serverUrl: String) {
        val prefix = "$serverUrl|"
        memory.removeWhere { it.startsWith(prefix) }
        disk.clear(serverUrl)
    }

    private suspend fun produce(key: EmojiImageKey, onUpdate: ((T) -> Unit)?): T? {
        val generation = disk.generation(key.serverUrl)
        val hit = withContext(io) { disk.read(key) }
        if (hit != null) {
            val image = withContext(decodeDispatcher) { decode(hit.bytes) }
            if (image != null) {
                remember(key, image, generation)
                if (!key.immutable && clock() - hit.fetchedAt > maxAgeMs) revalidate(key, hit.bytes, onUpdate)
                return image
            }
        }
        val bytes = try { download(key, urgent = true, generation) } catch (e: CancellationException) { throw e } catch (_: Exception) { return null }
        val image = withContext(decodeDispatcher) { decode(bytes) } ?: return null
        remember(key, image, generation)
        return image
    }

    private fun remember(key: EmojiImageKey, image: T, generation: Int) {
        if (disk.generation(key.serverUrl) == generation) memory[key.memoryKey] = image
    }

    /** A day-old picture of a server that names no versions: asked again after everything else; a changed one replaces it. */
    private fun revalidate(key: EmojiImageKey, old: ByteArray, onUpdate: ((T) -> Unit)?) {
        if (!synchronized(lock) { revalidating.add(key.memoryKey) }) return
        scope.launch {
            try {
                val generation = disk.generation(key.serverUrl)
                val bytes = download(key, urgent = false, generation)
                if (bytes.contentEquals(old)) return@launch
                val image = withContext(decodeDispatcher) { decode(bytes) } ?: return@launch
                if (disk.generation(key.serverUrl) != generation) return@launch
                memory[key.memoryKey] = image
                onUpdate?.invoke(image)
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                // the cached picture stays; the next start asks again
            } finally { synchronized(lock) { revalidating.remove(key.memoryKey) } }
        }
    }

    private suspend fun download(key: EmojiImageKey, urgent: Boolean, generation: Int = disk.generation(key.serverUrl)): ByteArray {
        val bytes = slot(urgent) { fetch(key) }
        withContext(io) { disk.write(key, bytes, generation) }
        return bytes
    }

    /** At most [concurrency] requests at a time; the latest urgent one goes next, background checks last. */
    private suspend fun <R> slot(urgent: Boolean, block: suspend () -> R): R {
        val ticket = CompletableDeferred<Unit>()
        synchronized(lock) {
            if (running < concurrency) { running++; ticket.complete(Unit) } else if (urgent) waiting.addLast(ticket) else waiting.addFirst(ticket)
        }
        try {
            ticket.await()
        } catch (e: CancellationException) {
            val queued = synchronized(lock) { waiting.remove(ticket) }
            if (!queued) release()
            throw e
        }
        try { return block() } finally { release() }
    }

    private fun release() {
        val next = synchronized(lock) { waiting.removeLastOrNull().also { if (it == null) running-- } }
        next?.complete(Unit)
    }
}
