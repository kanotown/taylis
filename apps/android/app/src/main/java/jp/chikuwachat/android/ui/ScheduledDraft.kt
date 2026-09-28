package jp.chikuwachat.android.ui

import jp.chikuwachat.android.api.GroupOut
import jp.chikuwachat.android.api.UserPublic
import jp.chikuwachat.android.sync.Draft

/** Restore cancelled text after the current draft, retaining its attachments and sync metadata. */
fun restoreScheduledDraft(draft: Draft, body: String, users: Map<String, UserPublic>, groups: Map<String, GroupOut>): Draft {
    if (body.isEmpty()) return draft
    val text = Mentions.decode(body, users, groups)
    val joined = when {
        draft.text.isBlank() -> text
        draft.text.endsWith("\n") -> draft.text + text
        else -> draft.text + "\n" + text
    }
    return draft.copy(text = joined)
}
