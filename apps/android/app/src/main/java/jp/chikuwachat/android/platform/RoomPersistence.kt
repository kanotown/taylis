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
    @Upsert fun putChannel(row: ChannelRow)
    @Query("DELETE FROM channels WHERE id = :id") fun deleteChannel(id: String)

    @Query("SELECT * FROM messages") fun messages(): List<MessageRow>
    @Upsert fun putMessage(row: MessageRow)
    @Query("DELETE FROM messages WHERE id = :id") fun deleteMessage(id: String)
    @Query("DELETE FROM messages WHERE channelId = :channelId") fun clearMessages(channelId: String)

    @Query("SELECT * FROM outbox") fun outbox(): List<OutboxRow>
    @Upsert fun putOutbox(row: OutboxRow)
    @Query("DELETE FROM outbox WHERE clientMsgId = :clientMsgId") fun deleteOutbox(clientMsgId: String)
}

@Database(entities = [MetaRow::class, UserRow::class, ChannelRow::class, MessageRow::class, OutboxRow::class], version = 1, exportSchema = false)
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
        messages = dao.messages().mapNotNull { decode(MessageState.serializer(), it.json) },
        outbox = dao.outbox().mapNotNull { decode(OutboxItem.serializer(), it.json) },
    )

    override fun saveMeta(key: String, value: String?) = run { if (value == null) dao.deleteMeta(key) else dao.putMeta(MetaRow(key, value)) }
    override fun saveUser(user: UserPublic) = run { dao.putUser(UserRow(user.id, Codec.plain.encodeToString(UserPublic.serializer(), user))) }
    override fun saveChannel(channel: ChannelState) = run { dao.putChannel(ChannelRow(channel.id, Codec.plain.encodeToString(ChannelState.serializer(), channel))) }
    override fun deleteChannel(id: String) = run { dao.deleteChannel(id) }
    override fun saveMessage(message: MessageState) = run { dao.putMessage(MessageRow(message.id, message.channelId, Codec.plain.encodeToString(MessageState.serializer(), message))) }
    override fun deleteMessage(id: String) = run { dao.deleteMessage(id) }
    override fun clearMessages(channelId: String) = run { dao.clearMessages(channelId) }
    override fun saveOutbox(item: OutboxItem) = run { dao.putOutbox(OutboxRow(item.clientMsgId, Codec.plain.encodeToString(OutboxItem.serializer(), item))) }
    override fun deleteOutbox(clientMsgId: String) = run { dao.deleteOutbox(clientMsgId) }

    fun close() {
        executor.shutdown()
        db.close()
    }

    private fun run(work: () -> Unit) {
        executor.execute { runCatching(work).onFailure { Log.w("RoomPersistence", "write failed", it) } }
    }

    private fun <T> decode(serializer: kotlinx.serialization.KSerializer<T>, json: String): T? =
        runCatching { Codec.plain.decodeFromString(serializer, json) }.getOrNull()

    companion object {
        /** One database per (server, user) profile, so switching accounts never mixes timelines. */
        fun open(context: Context, profile: String): RoomPersistence {
            val digest = MessageDigest.getInstance("SHA-256").digest(profile.toByteArray()).take(8).joinToString("") { "%02x".format(it) }
            val db = Room.databaseBuilder(context, LocalDatabase::class.java, "chikuwa-$digest.db")
                .fallbackToDestructiveMigration(true)
                .build()
            return RoomPersistence(db)
        }
    }
}
