package jp.chikuwachat.android.ui

import jp.chikuwachat.android.app.AppController

/**
 * 2026-11-16 (a hostile-server review): the in-memory picture caches ([DisplayBytes], [DriveThumbs], [AlbumThumbs]) were
 * keyed by the path alone (`/api/v1/attachments/<id>/display`), so one workspace's server could have its picture shown for
 * another's attachment of the same id. They are keyed by (server, path) and emptied whenever the workspace on screen
 * changes or signs out (AppController.closeActive).
 */
internal object WorkspaceImageCaches {
    fun key(controller: AppController, path: String): String = keyOf(controller.serverBase, path)

    fun keyOf(serverUrl: String?, path: String): String = (serverUrl ?: "") + "|" + path

    fun clear() {
        DisplayBytes.clear()
        DriveThumbs.clear()
        AlbumThumbs.clear()
    }
}
