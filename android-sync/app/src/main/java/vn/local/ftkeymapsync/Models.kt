package vn.local.ftkeymapsync

import org.json.JSONObject
import java.io.File
import java.time.OffsetDateTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

/** A file of the phone's keymap cache, as name + text. */
data class NamedText(val name: String, val text: String)

enum class FileKind { LIST, MAP, OTHER }

enum class PullState { NEW, CHANGED, SAME }

class SyncException(message: String, cause: Throwable? = null) : Exception(message, cause)

data class ServerInfo(
    val server: String,
    val version: String,
    val account: String,
    val accounts: Int,
    val docs: Int,
    val webSessions: Int = 0,
    val devicesOnline: Int = 0,
    val backupDays: Int = 0,
) {
    fun describe(baseUrl: String) = "Đã kết nối tới $baseUrl (server keymap, $accounts tài khoản)"

    /** whether somebody has the web page open right now (a server older than 1.2 does not say, so it reads as "nobody") */
    fun webLine() = if (webSessions > 0) "Giao diện web: đang mở ($webSessions phiên)" else "Giao diện web: chưa có ai mở"
}

/** Who this phone is, as the server and the web page will show it. */
data class DeviceIdentity(val id: String, val name: String, val model: String, val android: String, val appVersion: String, val ip: String)

/** What the phone reports in each heartbeat. */
data class Heartbeat(val autoPush: Boolean, val folder: String, val state: String, val error: String)

data class HelloResult(val webSessions: Int, val devicesOnline: Int)

/** Tells when the next heartbeat is due; the first one is due at once. */
class HeartbeatTimer(private val intervalMs: Long, private val clock: () -> Long = { System.currentTimeMillis() }) {
    private var last: Long? = null

    fun due(): Boolean {
        val now = clock()
        val l = last
        if (l == null || now - l >= intervalMs) { last = now; return true }
        return false
    }
}

/** One daily backup folder on the server. */
data class BackupDay(val date: String, val files: Int, val docs: Int, val bytes: Long, val updatedAt: String?, val lastActor: String?, val databases: Int = 0) {
    fun describe(): String {
        val size = if (bytes >= 1_048_576) String.format(Locale.US, "%.1f MB", bytes / 1_048_576.0) else String.format(Locale.US, "%.0f KB", bytes / 1024.0)
        val time = updatedAt?.let { runCatching { OffsetDateTime.parse(it).atZoneSameInstant(ZoneId.systemDefault()).format(DateTimeFormatter.ofPattern("HH:mm")) }.getOrNull() }
        return buildString {
            append("$date · $files file · $size")
            if (databases > 0) append(" · $databases file cài đặt")
            if (time != null) append(" · cập nhật $time")
            if (!lastActor.isNullOrBlank()) append(" · bởi $lastActor")
        }
    }
}

data class PushSummary(
    val imported: Int,
    val updated: Int,
    val unchanged: Int,
    val skipped: List<String>,
    val snapshots: Int,
) {
    fun describe() = "mới $imported, cập nhật $updated (bản cũ đã lưu trong lịch sử server), giữ nguyên $unchanged, bỏ qua ${skipped.size}"

    operator fun plus(o: PushSummary) = PushSummary(imported + o.imported, updated + o.updated, unchanged + o.unchanged, skipped + o.skipped, snapshots + o.snapshots)

    companion object {
        val EMPTY = PushSummary(0, 0, 0, emptyList(), 0)

        fun fromJson(j: JSONObject): PushSummary {
            val skipped = mutableListOf<String>()
            val arr = j.optJSONArray("skipped")
            if (arr != null) {
                for (i in 0 until arr.length()) {
                    val s = arr.getJSONObject(i)
                    val who = s.optString("id").ifBlank { s.optString("file") }
                    skipped += "$who: ${s.optString("reason")}"
                }
            }
            return PushSummary(
                imported = j.optJSONArray("imported")?.length() ?: 0,
                updated = j.optJSONArray("updated")?.length() ?: 0,
                unchanged = j.optInt("unchanged"),
                skipped = skipped,
                snapshots = j.optInt("snapshots"),
            )
        }
    }
}

/** Result of sending the preference files; `saved` are new or changed on the server. */
data class DatabasePushSummary(val saved: Int, val unchanged: Int, val skipped: List<String>) {
    fun describe() = "$saved file cài đặt mới/đổi, giữ nguyên $unchanged, bỏ qua ${skipped.size}"

    operator fun plus(o: DatabasePushSummary) = DatabasePushSummary(saved + o.saved, unchanged + o.unchanged, skipped + o.skipped)

    companion object {
        val EMPTY = DatabasePushSummary(0, 0, emptyList())

        fun fromJson(j: JSONObject): DatabasePushSummary {
            val skipped = mutableListOf<String>()
            val arr = j.optJSONArray("skipped")
            if (arr != null) for (i in 0 until arr.length()) skipped += arr.getJSONObject(i).let { "${it.optString("name")}: ${it.optString("reason")}" }
            return DatabasePushSummary(j.optInt("saved"), j.optInt("unchanged"), skipped)
        }
    }
}

data class DatabaseScan(val exists: Boolean, val files: Int, val excluded: List<String>, val bytes: Long, val path: String) {
    fun describe(): String {
        if (!exists) return "Thư mục cài đặt không tồn tại: $path"
        val kb = String.format(Locale.US, "%.1f", bytes / 1024.0)
        return "Thư mục cài đặt $path: $files file .xml sẽ sao lưu ($kb KB)" + if (excluded.isEmpty()) "" else ", bỏ qua ${excluded.size} file (${excluded.joinToString()})"
    }
}

/** What the server reports after "delete everything": which folders were cleared and where the last copy is kept. */
data class WipeResult(val moved: List<String>, val keptIn: String)

data class ScanSummary(val exists: Boolean, val lists: Int, val maps: Int, val others: Int, val bytes: Long, val path: String) {
    fun describe(): String {
        if (!exists) return "Thư mục không tồn tại: $path"
        val mb = String.format(Locale.US, "%.2f", bytes / 1_048_576.0)
        return "Thư mục $path: $lists danh mục (list|), $maps keymap (map|), $others file khác, $mb MB"
    }
}

data class PullItem(val name: String, val text: String, val state: PullState)

data class PullPlan(val items: List<PullItem>, val rejected: List<String>) {
    val newCount get() = items.count { it.state == PullState.NEW }
    val changedCount get() = items.count { it.state == PullState.CHANGED }
    val sameCount get() = items.count { it.state == PullState.SAME }
}

data class PullResult(val written: List<String>, val failed: List<String>, val backupDir: File?)

data class LocalFile(val name: String, val size: Long, val modified: Long) {
    /** changes whenever the file is rewritten */
    val fingerprint: String get() = "$size:$modified"
}
