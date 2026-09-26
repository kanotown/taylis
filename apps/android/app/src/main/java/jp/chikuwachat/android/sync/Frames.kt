package jp.chikuwachat.android.sync

import jp.chikuwachat.android.api.Codec
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put

/** WebSocket frames (SYNC_PROTOCOL.md §5.2). Payload keys are kept as sent (snake_case). */
data class EventFrame(val id: Long, val event: String, val ts: String, val channelId: String?, val seq: Int?, val data: JsonObject)

sealed class ServerFrame {
    data class Hello(val sessionId: String, val heartbeatIntervalSec: Int) : ServerFrame()
    object Pong : ServerFrame()
    data class Error(val code: String, val message: String) : ServerFrame()
    data class Event(val frame: EventFrame) : ServerFrame()

    companion object {
        fun parse(text: String): ServerFrame? {
            val obj = runCatching { Codec.plain.parseToJsonElement(text).jsonObject }.getOrNull() ?: return null
            return when (obj["type"]?.jsonPrimitive?.contentOrNull) {
                "hello" -> Hello(obj["session_id"]?.jsonPrimitive?.contentOrNull ?: "", obj["heartbeat_interval_sec"]?.jsonPrimitive?.intOrNull ?: 30)
                "pong" -> Pong
                "error" -> Error(obj["code"]?.jsonPrimitive?.contentOrNull ?: "error", obj["message"]?.jsonPrimitive?.contentOrNull ?: "")
                "event" -> Event(
                    EventFrame(
                        id = obj["id"]?.jsonPrimitive?.contentOrNull?.toLongOrNull() ?: 0L,
                        event = obj["event"]?.jsonPrimitive?.contentOrNull ?: "",
                        ts = obj["ts"]?.jsonPrimitive?.contentOrNull ?: "",
                        channelId = obj["channel_id"]?.let { if (it is JsonPrimitive) it.contentOrNull else null },
                        seq = obj["seq"]?.let { if (it is JsonPrimitive) it.intOrNull else null },
                        data = obj["data"]?.jsonObject ?: JsonObject(emptyMap()),
                    ),
                )
                else -> null
            }
        }
    }
}

object ClientFrame {
    fun auth(token: String): String = Codec.plain.encodeToString(JsonObject.serializer(), buildJsonObject { put("type", "auth"); put("token", token) })
    fun ping(active: Boolean): String = Codec.plain.encodeToString(JsonObject.serializer(), buildJsonObject { put("type", "ping"); put("active", active) })
}

const val CLOSE_RECONNECT = 4000
const val CLOSE_AUTH_FAILED = 4001
const val CLOSE_SESSION_REVOKED = 4003

internal fun JsonObject.str(key: String): String? = this[key]?.let { if (it is JsonPrimitive) it.contentOrNull else null }
internal fun JsonObject.bool(key: String): Boolean? = this[key]?.let { if (it is JsonPrimitive) it.booleanOrNull else null }
