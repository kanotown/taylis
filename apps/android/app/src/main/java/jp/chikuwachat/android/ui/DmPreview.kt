package jp.chikuwachat.android.ui

import jp.chikuwachat.android.api.ChannelOut
import jp.chikuwachat.android.api.GroupOut
import jp.chikuwachat.android.api.LastMessageOut
import jp.chikuwachat.android.api.UserPublic
import jp.chikuwachat.android.sync.MessageState

/*
 * M49, the DM list's preview line (MOBILE_UI.md §6.3 / §7.1, SYNC_PROTOCOL.md §7.8). The rule and its cases are shared
 * with the server and the other clients: apps/shared/dm-preview.json (DmPreviewTest). Pure: the Store keeps
 * `last_message` current with it too (Store.applyLastMessage).
 */

/** The excerpt's length, the server's (messages/service.py PREVIEW_LENGTH); the row cuts it to one line anyway. */
const val PREVIEW_LENGTH = 140

/**
 * The server's excerpt (ChannelOut.last_message.excerpt): the body as one line with mention names (the push body's
 * rule), or, without text, what the attachments were (「画像を送信しました」 …).
 */
fun previewExcerpt(body: String, contentTypes: List<String>, users: Map<String, UserPublic>, groups: Map<String, GroupOut> = emptyMap()): String =
    messageLine(body, contentTypes, users, groups, PREVIEW_LENGTH)

/** A held or live message as `last_message` (what the server would send for it). */
fun lastMessageOf(message: MessageState, users: Map<String, UserPublic>, groups: Map<String, GroupOut> = emptyMap()): LastMessageOut =
    LastMessageOut(
        id = message.id,
        senderId = message.senderId,
        type = message.type,
        seq = message.seq ?: 0,
        excerpt = previewExcerpt(message.body, message.attachments.map { it.contentType }, users, groups),
        hasAttachments = message.attachments.isNotEmpty(),
        createdAt = message.createdAt,
    )

/**
 * The line under the conversation's name. Nothing without a last message or with an empty excerpt; a system message as
 * it is; mine 「あなた: 」 (not in my own DM, where every message is mine); someone else's in a 1:1 DM as it is (the row
 * already names them, as Slack); elsewhere 「<表示名>: 」 (an unknown sender 「メンバー: 」).
 */
fun previewLine(type: String, dmUserIds: List<String>?, last: LastMessageOut?, meId: String?, users: Map<String, UserPublic>): String {
    if (last == null || last.excerpt.isEmpty()) return ""
    if (last.type != "user") return last.excerpt
    if (meId != null && last.senderId == meId) {
        val selfNotes = type == "dm" && (dmUserIds ?: emptyList()).all { it == meId }
        return if (selfNotes) last.excerpt else "あなた: ${last.excerpt}"
    }
    if (type == "dm") return last.excerpt
    val name = users[last.senderId]?.displayName?.trim()?.ifEmpty { null } ?: "メンバー"
    return "$name: ${last.excerpt}"
}

/** The preview of a stored conversation (its `last_message`). */
fun previewLine(channel: ChannelOut, meId: String?, users: Map<String, UserPublic>): String =
    previewLine(channel.type, channel.dmUserIds, channel.lastMessage, meId, users)

/** The same preview (nothing the row shows changed): an event that only moved reactions or pins. */
fun sameLastMessage(a: LastMessageOut?, b: LastMessageOut?): Boolean {
    if (a == null || b == null) return a == null && b == null
    return a.id == b.id && a.seq == b.seq && a.excerpt == b.excerpt && a.hasAttachments == b.hasAttachments && a.type == b.type && a.senderId == b.senderId
}
