package jp.chikuwachat.android.ui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember

/**
 * M28c: a value computed again whenever `keys` change, but the previous instance when the new one equals it. The Store
 * bumps its version on every change (a typing frame, a presence change, another channel's row), and a list read from it
 * then is a new instance with the same rows, so everything keyed on the list (the timeline's items, the read gate's
 * effect) ran again on every bump. Data classes compare by identity first, so unchanged rows compare cheaply.
 */
@Composable
fun <T : Any> rememberUnchanged(vararg keys: Any?, compute: () -> T): T {
    val last = remember { Last<T>() }
    return remember(*keys) {
        val next = compute()
        val previous = last.value
        if (previous != null && previous == next) previous else next.also { last.value = it }
    }
}

private class Last<T> {
    var value: T? = null
}
