package jp.chikuwachat.android.sync

import jp.chikuwachat.android.api.ApiException
import jp.chikuwachat.android.api.DatabaseOut
import jp.chikuwachat.android.api.DbRow
import jp.chikuwachat.android.api.DbRowRef
import jp.chikuwachat.android.api.DbView
import kotlinx.coroutines.CancellationException

/** M149: an embedded database as last read: its schema, the view shown and that view's first rows. */
data class EmbedRows(val database: DatabaseOut, val view: DbView?, val rows: List<DbRow>, val refs: Map<String, DbRowRef>)

/** What reading an embed came to. */
sealed interface EmbedLoad {
    data class Rows(val rows: EmbedRows) : EmbedLoad
    /** 403 / 404 / not a database: nothing of it is shown, not even the label. */
    data object Denied : EmbedLoad
    /** The network, the server, or a session that ended while the answer was on its way. */
    data object Failed : EmbedLoad
}

/**
 * The embeds read in one session (one [WikiHub]: one server and one account), by database and view: scrolling back to
 * an embed draws it at once (read again behind). [close] (the session ends: sign-out, another account or server)
 * empties it for good; an answer that comes after that is not kept, so nothing read as one account shows for another.
 */
class EmbedCache(private val max: Int = 32) {
    private val entries = object : LinkedHashMap<String, EmbedRows>(16, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, EmbedRows>?): Boolean = size > max
    }
    private var closed = false

    @get:Synchronized
    val isClosed: Boolean get() = closed

    @Synchronized fun get(key: String): EmbedRows? = if (closed) null else entries[key]

    /** False (nothing kept) once the session has ended. */
    @Synchronized fun put(key: String, value: EmbedRows): Boolean {
        if (closed) return false
        entries[key] = value
        return true
    }

    @Synchronized fun remove(key: String) { entries.remove(key) }

    @Synchronized fun close() {
        closed = true
        entries.clear()
    }

    companion object {
        fun key(pageId: String, viewId: String?): String = pageId + "#" + (viewId ?: "")

        /**
         * Reads an embed's database and its view's first [limit] rows into [cache]. An answer that comes after the
         * cache was closed (the session ended meanwhile) is [EmbedLoad.Failed], never rows.
         */
        suspend fun load(cache: EmbedCache, api: WikiDbApi, pageId: String, viewId: String?, limit: Int): EmbedLoad {
            val key = key(pageId, viewId)
            if (cache.isClosed) return EmbedLoad.Failed
            return try {
                val database = api.wikiDatabase(pageId)
                val view = WikiDb.viewOf(database, viewId)
                val answer = api.queryRows(pageId, view?.id, null, null, limit)
                val rows = EmbedRows(database, view, answer.rows.take(limit), answer.refs.associateBy { it.id })
                if (cache.put(key, rows)) EmbedLoad.Rows(rows) else EmbedLoad.Failed
            } catch (e: CancellationException) {
                throw e
            } catch (e: ApiException.Api) {
                if (e.status in 400..499 && e.status != 401 && e.status != 429) {
                    cache.remove(key)
                    EmbedLoad.Denied
                } else EmbedLoad.Failed
            } catch (e: Exception) {
                EmbedLoad.Failed
            }
        }
    }
}
