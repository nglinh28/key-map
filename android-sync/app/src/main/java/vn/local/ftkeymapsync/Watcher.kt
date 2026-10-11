package vn.local.ftkeymapsync

/** What was last pushed (file name -> fingerprint); kept across restarts so the same files are not pushed again. */
interface StateStore {
    var lastPushed: Map<String, String>
}

/** What was last pushed from the preference folder; separate from the cache so each folder is tracked on its own. */
interface DbStateStore {
    var lastPushedDb: Map<String, String>
}

sealed class DbWatchEvent {
    object Idle : DbWatchEvent()
    data class Waiting(val changed: Int) : DbWatchEvent()
    data class Pushed(val summary: DatabasePushSummary, val names: List<String>) : DbWatchEvent()
    data class Failed(val message: String) : DbWatchEvent()
}

sealed class WatchEvent {
    object Idle : WatchEvent()
    data class Waiting(val changed: Int) : WatchEvent()
    data class Pushed(val summary: PushSummary, val names: List<String>) : WatchEvent()
    data class Failed(val message: String) : WatchEvent()
}

/**
 * Polls the folder. A change is pushed only after the folder looked the same on two checks in a row, so a file that
 * Gamwing is still writing is not sent half way. Called once every few seconds by the foreground service.
 */
class Watcher(
    private val folder: LocalFolder,
    private val engine: SyncEngine,
    private val state: StateStore,
    private val dbFolder: LocalFolder? = null,
    private val dbState: DbStateStore? = null,
) {
    private var pending: Map<String, String>? = null
    private var dbPending: Map<String, String>? = null

    /** Same idea as [tick] for the preference folder: push only what changed, and only once it looked the same twice in a row. */
    fun tickDatabases(): DbWatchEvent {
        val f = dbFolder ?: return DbWatchEvent.Idle
        val store = dbState ?: return DbWatchEvent.Idle
        if (!f.exists()) return DbWatchEvent.Idle
        val current = databaseFingerprints(f)
        val last = store.lastPushedDb
        val changed = current.filter { (name, fp) -> last[name] != fp }.keys.toList()
        if (changed.isEmpty()) {
            dbPending = null
            return DbWatchEvent.Idle
        }
        if (dbPending != current) {
            dbPending = current
            return DbWatchEvent.Waiting(changed.size)
        }
        return try {
            val summary = engine.pushDatabases(changed)
            store.lastPushedDb = last + current.filterKeys { it in changed }
            dbPending = null
            DbWatchEvent.Pushed(summary, changed)
        } catch (e: Exception) {
            dbPending = null
            DbWatchEvent.Failed(e.message ?: e.javaClass.simpleName)
        }
    }

    fun tick(): WatchEvent {
        val current = cacheFingerprints(folder)
        val last = state.lastPushed
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
            state.lastPushed = last + current.filterKeys { it in changed }
            pending = null
            WatchEvent.Pushed(summary, changed)
        } catch (e: Exception) {
            pending = null // look again from scratch before retrying
            WatchEvent.Failed(e.message ?: e.javaClass.simpleName)
        }
    }
}
