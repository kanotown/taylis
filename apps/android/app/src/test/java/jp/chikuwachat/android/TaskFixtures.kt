package jp.chikuwachat.android

import jp.chikuwachat.android.api.ChannelOut
import jp.chikuwachat.android.api.MembershipOut
import jp.chikuwachat.android.api.TaskOut
import jp.chikuwachat.android.sync.ChannelState

/** M56: tasks for the tests, shaped like the server's TaskOut (the desktop's taskFixtures.ts). */
object TaskFixtures {
    private var n = 0

    fun task(title: String, id: String? = null, channelId: String? = "c-lab", channelName: String? = "lab", status: String = "todo", position: Double? = null,
             dueOn: String? = null, assignees: List<String> = emptyList(), completedAt: String? = null, notes: String? = null,
             source: jp.chikuwachat.android.api.TaskSourceOut? = null, updatedAt: String = "2026-10-01T00:00:00Z", canDelete: Boolean = true): TaskOut {
        n += 1
        return TaskOut(
            id = id ?: "t" + n.toString().padStart(3, '0'), channelId = channelId, channelName = if (channelId == null) null else channelName, ownerId = "u-me",
            title = title, notes = notes, status = status, position = position ?: n.toDouble(), dueOn = dueOn, assigneeIds = assignees, source = source,
            completedAt = completedAt, createdAt = "2026-10-01T00:00:00Z", updatedAt = updatedAt, canDelete = canDelete,
        )
    }

    fun channel(id: String, type: String = "public", archived: Boolean = false, postingPolicy: String? = null, role: String? = "member", member: Boolean = true): ChannelState =
        ChannelState(
            ChannelOut(
                id = id, type = type, name = id, archived = archived, lastSeq = 0, createdAt = "2026-01-01T00:00:00Z", updatedAt = "2026-01-01T00:00:00Z",
                membership = role?.let { MembershipOut(it, "2026-01-01T00:00:00Z") }, postingPolicy = postingPolicy,
            ),
            isMember = member,
        )
}
