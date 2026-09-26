package jp.chikuwachat.android

import android.app.Application
import jp.chikuwachat.android.app.AppController

class ChikuwaApp : Application() {
    /** Process-wide controller: outlives activity recreation (rotation) and keeps the socket open. */
    val controller: AppController by lazy { AppController(this) }
}
