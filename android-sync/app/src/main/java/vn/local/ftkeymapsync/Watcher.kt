package vn.local.ftkeymapsync

/** What was last pushed (file name -> fingerprint); kept across restarts so the same files are not pushed again. */
interface DbStateStore {
    var lastPushedDb: Map<String, String>
}

sealed class WatchEvent {
    object Idle : WatchEvent()
    data class Waiting(val changed: Int) : WatchEvent()
    data class Pushed(val summary: DatabasePushSummary, val names: List<String>) : WatchEvent()
    data class Failed(val message: String) : WatchEvent()
}

/**
 * Polls the folder. A change is pushed only after the folder looked the same on two checks in a row, so a file that
 * Gamwing is still writing is not sent half way. Called once every few seconds by the foreground service.
 */
class Watcher(
    private val folder: LocalFolder,
    private val engine: SyncEngine,
    private val state: DbStateStore,
) {
    private var pending: Map<String, String>? = null

    fun tick(): WatchEvent {
        if (!folder.exists()) return WatchEvent.Idle
        val current = databaseFingerprints(folder)
        val last = state.lastPushedDb
        val changed = current.filter { (name, fp) -> last[name] != fp }.keys.toList()
        if (changed.isEmpty()) {
            pending = null
            return WatchEvent.Idle
        }
        if (pending != current) {
            pending = current
            return WatchEvent.Waiting(changed.size)
        }
        return try {
            val summary = engine.push(changed)
            state.lastPushedDb = last + current.filterKeys { it in changed }
            pending = null
            WatchEvent.Pushed(summary, changed)
        } catch (e: Exception) {
            pending = null // look again from scratch before retrying
            WatchEvent.Failed(e.message ?: e.javaClass.simpleName)
        }
    }
}
