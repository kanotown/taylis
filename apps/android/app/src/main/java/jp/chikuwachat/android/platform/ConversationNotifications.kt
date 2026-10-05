package jp.chikuwachat.android.platform

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.BitmapShader
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Shader
import androidx.core.app.NotificationCompat
import androidx.core.app.Person
import androidx.core.graphics.createBitmap
import androidx.core.graphics.drawable.IconCompat
import androidx.core.graphics.scale
import java.io.File
import java.net.URLEncoder
import java.security.MessageDigest
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull

/**
 * PUSH_NOTIFICATIONS.md §16: a person's message notification is a conversation (MessagingStyle with the sender as a
 * Person and their picture, tied to a long-lived conversation shortcut), so Android shows the sender's picture as the
 * main image with the app's small icon in the corner, like a chat app's.
 */
data class ConversationNote(
    val senderId: String,
    val senderName: String,
    /** The picture's version (`avatar_updated_at`); null: the sender has none (initials). */
    val senderAvatar: String?,
    /** A channel or a group DM; a 1:1 DM is the sender's own conversation. */
    val isGroup: Boolean,
    /** The group's name ("#general", "グループ DM"); null for a 1:1 DM. */
    val conversationTitle: String?,
) {
    companion object {
        fun isGroup(channelType: String?): Boolean = channelType != null && channelType != "dm"
    }
}

/** One message in a conversation's notification (kept while it is on screen, at most [ConversationStyle.MAX_LINES]). */
data class ConversationLine(
    val messageId: String?,
    val senderId: String,
    val senderName: String,
    val text: String,
    val time: Long,
)

object ConversationStyle {
    /** How many of the newest messages a conversation's notification lists. */
    const val MAX_LINES = 6
    /** The side of a notification picture, in pixels. */
    const val AVATAR_PX = 128

    /** The new message after the ones still shown; the socket and FCM may both bring it, so a known id is not added twice. */
    fun append(previous: List<ConversationLine>, line: ConversationLine, max: Int = MAX_LINES): List<ConversationLine> {
        if (line.messageId != null && previous.any { it.messageId == line.messageId }) return previous
        return (previous + line).takeLast(max)
    }

    /** One shortcut per conversation per workspace (the same channel id cannot come from two servers, but be safe). */
    fun shortcutId(workspace: String?, channelId: String): String =
        "conv:" + digest(workspace ?: "").take(8) + ":" + channelId

    /** The letters a picture-less sender's circle shows: the first character (two for a Latin "First Last"). */
    fun initials(name: String): String {
        val words = name.trim().split(Regex("\\s+")).filter { it.isNotEmpty() }
        if (words.isEmpty()) return "?"
        val first = words[0].codePointAt(0)
        val ascii = words.size >= 2 && first < 0x80 && words[1].codePointAt(0) < 0x80
        val letters = if (ascii) String(Character.toChars(first)) + String(Character.toChars(words[1].codePointAt(0))) else String(Character.toChars(first))
        return letters.uppercase()
    }

    /** The initials circle's colour: the same person always gets the same one. */
    fun colorFor(id: String): Int = PALETTE[(digest(id)[0].code and 0x7f) % PALETTE.size]

    fun person(id: String, name: String, icon: IconCompat?): Person =
        Person.Builder().setKey(id).setName(name).setIcon(icon).build()

    /**
     * The MessagingStyle of [lines]: each line's sender as a Person (the newest picture we have for them in [icons]),
     * named and marked a group for a channel or a group DM.
     */
    fun style(me: Person, lines: List<ConversationLine>, icons: Map<String, IconCompat?>, isGroup: Boolean, title: String?): NotificationCompat.MessagingStyle {
        val style = NotificationCompat.MessagingStyle(me)
        if (isGroup) style.setConversationTitle(title)
        style.setGroupConversation(isGroup)
        for (line in lines) {
            style.addMessage(NotificationCompat.MessagingStyle.Message(line.text, line.time, person(line.senderId, line.senderName, icons[line.senderId])))
        }
        return style
    }

    /** The disk cache's file name for a picture version (no ids or addresses in clear on disk). */
    fun cacheName(workspace: String?, userId: String, version: String): String = digest("${workspace ?: ""}|$userId|$version") + ".png"

    /** The authenticated path of a picture, as the in-app avatars load it (M14a). */
    fun avatarPath(userId: String, version: String): String = "/api/v1/users/$userId/avatar?v=" + URLEncoder.encode(version, "UTF-8")

    private fun digest(text: String): String =
        MessageDigest.getInstance("SHA-256").digest(text.toByteArray()).joinToString("") { "%02x".format(it) }

    private val PALETTE = listOf(
        0xFF5B5BD6.toInt(), 0xFF2E7D32.toInt(), 0xFFC62828.toInt(), 0xFF00838F.toInt(),
        0xFFEF6C00.toInt(), 0xFF6A1B9A.toInt(), 0xFF37474F.toInt(), 0xFFAD1457.toInt(),
    )
}

/**
 * The senders' pictures for notifications: loaded with the workspace's own signed-in client (no credentials in the push),
 * kept on disk per picture version, shrunk to [ConversationStyle.AVATAR_PX] and cut to a circle. A missing picture, an
 * error or a slow server (over [TIMEOUT_MS]) gives the initials instead; the notification never waits longer.
 */
class NotificationAvatars(context: Context) {
    private val dir = File(context.cacheDir, "notification-avatars")

    suspend fun bitmap(workspace: String?, note: ConversationNote, fetch: (suspend (String) -> ByteArray)?): Bitmap {
        val version = note.senderAvatar
        if (version != null && fetch != null) {
            val picture = withContext(Dispatchers.IO) {
                val file = File(dir, ConversationStyle.cacheName(workspace, note.senderId, version))
                file.takeIf { it.isFile }?.let { decode(it.readBytes()) }
                    ?: withTimeoutOrNull(TIMEOUT_MS) { runCatching { fetch(ConversationStyle.avatarPath(note.senderId, version)) }.getOrNull() }
                        ?.let { bytes -> decode(bytes)?.also { save(file, it) } }
            }
            if (picture != null) return picture
        }
        return initials(note.senderId, note.senderName)
    }

    /** Dropped with the account (sign-out): pictures of the old workspace's people do not stay on the phone. */
    fun clear() {
        runCatching { dir.deleteRecursively() }
    }

    private fun decode(bytes: ByteArray): Bitmap? {
        val source = runCatching { BitmapFactory.decodeByteArray(bytes, 0, bytes.size) }.getOrNull() ?: return null
        return circle(source)
    }

    private fun save(file: File, bitmap: Bitmap) {
        runCatching {
            dir.mkdirs()
            val temp = File(dir, file.name + ".tmp")
            temp.outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
            temp.renameTo(file)
        }
    }

    private fun circle(source: Bitmap): Bitmap {
        val side = ConversationStyle.AVATAR_PX
        val square = minOf(source.width, source.height)
        val cropped = Bitmap.createBitmap(source, (source.width - square) / 2, (source.height - square) / 2, square, square)
        val scaled = cropped.scale(side, side)
        val out = createBitmap(side, side)
        val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { shader = BitmapShader(scaled, Shader.TileMode.CLAMP, Shader.TileMode.CLAMP) }
        Canvas(out).drawCircle(side / 2f, side / 2f, side / 2f, paint)
        return out
    }

    private fun initials(id: String, name: String): Bitmap {
        val side = ConversationStyle.AVATAR_PX
        val out = createBitmap(side, side)
        val canvas = Canvas(out)
        canvas.drawCircle(side / 2f, side / 2f, side / 2f, Paint(Paint.ANTI_ALIAS_FLAG).apply { color = ConversationStyle.colorFor(id) })
        val text = ConversationStyle.initials(name)
        val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            color = Color.WHITE
            textAlign = Paint.Align.CENTER
            textSize = side * (if (text.length > 1) 0.38f else 0.46f)
        }
        val y = side / 2f - (paint.descent() + paint.ascent()) / 2f
        canvas.drawText(text, side / 2f, y, paint)
        return out
    }

    companion object {
        const val TIMEOUT_MS = 3_000L
    }
}
