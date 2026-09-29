package jp.chikuwachat.android.platform

import android.content.Context
import android.util.Log
import androidx.room.Dao
import androidx.room.Database
import androidx.room.Entity
import androidx.room.Index
import androidx.room.PrimaryKey
import androidx.room.Query
import androidx.room.Room
import androidx.room.RoomDatabase
import androidx.room.Upsert
import jp.chikuwachat.android.api.Codec
import jp.chikuwachat.android.api.UserPublic
import jp.chikuwachat.android.sync.ChannelState
import jp.chikuwachat.android.sync.MessageState
import jp.chikuwachat.android.sync.OutboxItem
import jp.chikuwachat.android.sync.Persistence
import jp.chikuwachat.android.sync.Snapshot
import java.security.MessageDigest
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.TimeUnit

// Rows hold JSON blobs (like the desktop and iOS stores): the schema only needs the keys used for lookups.

@Entity(tableName = "meta")
data class MetaRow(@PrimaryKey val key: String, val value: String)

@Entity(tableName = "users")
data class UserRow(@PrimaryKey val id: String, val json: String)

@Entity(tableName = "channels")
data class ChannelRow(@PrimaryKey val id: String, val json: String)

@Entity(tableName = "messages", indices = [Index("channelId")])
data class MessageRow(@PrimaryKey val id: String, val channelId: String, val json: String)

@Entity(tableName = "outbox")
data class OutboxRow(@PrimaryKey val clientMsgId: String, val json: String)

@Dao
interface LocalDao {
    @Query("SELECT * FROM meta") fun meta(): List<MetaRow>
    @Upsert fun putMeta(row: MetaRow)
    @Query("DELETE FROM meta WHERE `key` = :key") fun deleteMeta(key: String)

    @Query("SELECT * FROM users") fun users(): List<UserRow>
    @Upsert fun putUser(row: UserRow)

    @Query("SELECT * FROM channels") fun channels(): List<ChannelRow>
    @Query("SELECT COUNT(*) FROM channels WHERE id = :id") fun countChannel(id: String): Int
    @Upsert fun putChannel(row: ChannelRow)
    @Query("DELETE FROM channels WHERE id = :id") fun deleteChannel(id: String)

    @Query("SELECT * FROM messages") fun messages(): List<MessageRow>
    @Upsert fun putMessage(row: MessageRow)
    @Query("DELETE FROM messages WHERE id = :id") fun deleteMessage(id: String)
    @Query("DELETE FROM messages WHERE id IN (:ids)") fun deleteMessages(ids: List<String>)
    @Query("DELETE FROM messages WHERE channelId = :channelId") fun clearMessages(channelId: String)

    @Query("SELECT * FROM outbox") fun outbox(): List<OutboxRow>
    @Upsert fun putOutbox(row: OutboxRow)
    @Query("DELETE FROM outbox WHERE clientMsgId = :clientMsgId") fun deleteOutbox(clientMsgId: String)
}

@Database(entities = [MetaRow::class, UserRow::class, ChannelRow::class, MessageRow::class, OutboxRow::class], version = RoomPersistence.SCHEMA_VERSION, exportSchema = false)
abstract class LocalDatabase : RoomDatabase() {
    abstract fun dao(): LocalDao
}

/**
 * Write-through store persistence. Writes are applied in order on one background thread so the
 * store never blocks the UI; loadAll() runs synchronously and must be called off the main thread.
 */
class RoomPersistence private constructor(private val db: LocalDatabase) : Persistence {
    private val dao = db.dao()
    private val executor = Executors.newSingleThreadExecutor { runnable -> Thread(runnable, "chikuwa-db") }

    override fun loadAll(): Snapshot = Snapshot(
        meta = dao.meta().associate { it.key to it.value },
        users = dao.users().mapNotNull { decode(UserPublic.serializer(), it.json) },
        channels = dao.channels().mapNotNull { decode(ChannelState.serializer(), it.json) },
        outbox = dao.outbox().mapNotNull { decode(OutboxItem.serializer(), it.json) },
    )

    override fun loadMessages(): List<MessageState> = dao.messages().mapNotNull { decode(MessageState.serializer(), it.json) }

    override fun saveMeta(key: String, value: String?) = run { if (value == null) dao.deleteMeta(key) else dao.putMeta(MetaRow(key, value)) }
    override fun saveUser(user: UserPublic) = run { dao.putUser(UserRow(user.id, Codec.plain.encodeToString(UserPublic.serializer(), user))) }
    override fun saveChannel(channel: ChannelState) = run { dao.putChannel(ChannelRow(channel.id, Codec.plain.encodeToString(ChannelState.serializer(), channel))) }
    override fun deleteChannel(id: String) = run { dao.deleteChannel(id) }
    override fun saveMessage(message: MessageState) = run { dao.putMessage(MessageRow(message.id, message.channelId, Codec.plain.encodeToString(MessageState.serializer(), message))) }
    override fun deleteMessage(id: String) = run { dao.deleteMessage(id) }
    // Chunked below SQLite's bound-variable limit (999 on older Android versions); one transaction for the whole trim.
    override fun deleteMessages(ids: List<String>) = run { db.runInTransaction { ids.chunked(DELETE_CHUNK).forEach { dao.deleteMessages(it) } } }
    override fun clearMessages(channelId: String) = run { dao.clearMessages(channelId) }
    override fun saveOutbox(item: OutboxItem) = run { dao.putOutbox(OutboxRow(item.clientMsgId, Codec.plain.encodeToString(OutboxItem.serializer(), item))) }
    override fun deleteOutbox(clientMsgId: String) = run { dao.deleteOutbox(clientMsgId) }

    /** Lets the queued writes finish (briefly), then closes the database; call off the main thread. */
    fun close() {
        executor.shutdown()
        executor.awaitTermination(2, TimeUnit.SECONDS)
        db.close()
    }

    private fun run(work: () -> Unit) {
        // A write that arrives after close() (work of a stopped session finishing late, M16c switch) is dropped.
        try {
            executor.execute { runCatching(work).onFailure { Log.w("RoomPersistence", "write failed", it) } }
        } catch (_: RejectedExecutionException) {
            Log.i("RoomPersistence", "write after close dropped")
        }
    }

    private fun <T> decode(serializer: kotlinx.serialization.KSerializer<T>, json: String): T? =
        runCatching { Codec.plain.decodeFromString(serializer, json) }.getOrNull()

    companion object {
        private const val DELETE_CHUNK = 500

        /**
         * The schema version of [LocalDatabase]. The builders below fall back to a destructive migration, which is
         * only right while this is 1 (the first schema, nothing to migrate from): a bump must ship a `Migration` and
         * drop the fallback, or every device would lose its cached rows, drafts and unsent messages at the update.
         * RoomPersistenceTest pins the value so the bump cannot slip through without that.
         */
        const val SCHEMA_VERSION = 1

        /**
         * One database per (server, user) profile, named by a hash of both (SYNC_PROTOCOL.md §11), so switching
         * accounts never mixes timelines and similar names cannot collide.
         */
        fun fileName(profile: String): String {
            val digest = MessageDigest.getInstance("SHA-256").digest(profile.toByteArray()).take(8).joinToString("") { "%02x".format(it) }
            return "chikuwa-$digest.db"
        }

        fun open(context: Context, profile: String): RoomPersistence {
            val db = Room.databaseBuilder(context, LocalDatabase::class.java, fileName(profile))
                .fallbackToDestructiveMigration(true) // see SCHEMA_VERSION: version 1 only
                .build()
            return RoomPersistence(db)
        }

        /** Sign-out (§11): the profile's messages, drafts and outbox go with the session. Close it first. */
        fun delete(context: Context, profile: String) {
            context.deleteDatabase(fileName(profile))
        }

        /**
         * Whether a profile's local store knows a channel (WORKSPACES.md §7: a push without a known workspace id goes
         * to the workspace that has its channel). A profile without a database has none; nothing is created.
         */
        fun hasChannel(context: Context, profile: String, channelId: String): Boolean {
            if (!context.getDatabasePath(fileName(profile)).exists()) return false
            val db = Room.databaseBuilder(context, LocalDatabase::class.java, fileName(profile)).fallbackToDestructiveMigration(true).build()
            return try {
                db.dao().countChannel(channelId) > 0
            } catch (e: Exception) {
                Log.w("RoomPersistence", "channel lookup failed", e)
                false
            } finally {
                db.close()
            }
        }
    }
}
