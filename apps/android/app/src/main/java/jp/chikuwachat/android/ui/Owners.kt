package jp.chikuwachat.android.ui

import jp.chikuwachat.android.api.MemberOut
import jp.chikuwachat.android.api.UserMe
import jp.chikuwachat.android.api.UserPublic
import jp.chikuwachat.android.sync.ChannelState
import jp.chikuwachat.android.sync.MessageState
import jp.chikuwachat.android.R
import jp.chikuwachat.android.L10n

/** L4 (M31): asking those who have not acknowledged a message (DATA_MODEL.md reminders, 確認のお願い). */
object AckReminders {
    /** The author or an admin, while someone has yet to acknowledge (the server says the same: 403 ack_remind_forbidden). */
    fun canRemind(message: MessageState, me: UserMe?, pendingCount: Int): Boolean =
        me != null && message.ackRequested && pendingCount > 0 && (me.id == message.senderId || me.role == "admin")

    /** The notice after 「未確認の人にリマインド」: 0 means everyone pending already has an open request. */
    fun notice(reminded: Int): String = if (reminded == 0) L10n.str(R.string.owners_everyone_has_already_been_reminded) else L10n.plural(R.plurals.owners_reminded_person_reminded_people, reminded, reminded)

    /** What 「未確認の人にリマインド」 did, as the line under the button: the notice, or the error text (`failed`). */
    data class Outcome(val text: String, val failed: Boolean)
}

/** L4 (M31): channel owners and converting a channel (SECURITY.md §3.2). */
object ChannelOwners {
    /** Owners and admins manage the owners of a channel (never of a DM). */
    fun canManage(channel: ChannelState, myRole: String?): Boolean =
        !channel.channel.isDm && (channel.channel.membership?.role == "owner" || myRole == "admin")

    /**
     * What I can do to this member: "owner" (make an owner), "member" (take it back) or null. Guests and bots are never
     * made owners (403 owner_not_allowed); the last owner stays (409 last_owner), so that choice is not offered.
     */
    fun action(channel: ChannelState, myRole: String?, member: MemberOut, user: UserPublic?, ownerCount: Int): String? {
        if (!canManage(channel, myRole)) return null
        return when {
            member.role == "owner" -> if (ownerCount > 1) "member" else null
            user == null || user.role == "guest" || user.role == "bot" -> null
            else -> "owner"
        }
    }

    fun actionLabel(action: String): String = if (action == "owner") L10n.str(R.string.owners_make_owner) else L10n.str(R.string.owners_remove_as_owner)

    /**
     * 「非公開チャンネルに変換」 for owners and admins of a public channel; 「公開チャンネルに変換」 only for an admin who is a
     * member of the private channel (the whole history becomes readable; 403 admin_not_member otherwise).
     */
    fun canConvert(channel: ChannelState, myRole: String?): Boolean = when (channel.channel.type) {
        "public" -> channel.isMember && (channel.channel.membership?.role == "owner" || myRole == "admin")
        "private" -> channel.isMember && myRole == "admin"
        else -> false
    }
}
