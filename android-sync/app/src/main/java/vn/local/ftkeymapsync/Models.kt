package vn.local.ftkeymapsync

import org.json.JSONObject
import java.io.File
import java.time.OffsetDateTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

/** A preference file as name + text. */
data class NamedText(val name: String, val text: String)

enum class PullState { NEW, CHANGED, SAME }

class SyncException(message: String, cause: Throwable? = null) : Exception(message, cause)

data class ServerInfo(
    val server: String,
    val version: String,
    val files: Int,
    val webSessions: Int = 0,
    val devicesOnline: Int = 0,
    val backupDays: Int = 0,
) {
    fun describe(baseUrl: String) = "Đã kết nối tới $baseUrl (server sao lưu, $files file đang lưu)"

    /** whether somebody has the web page open right now */
    fun webLine() = if (webSessions > 0) "Giao diện web: đang mở ($webSessions phiên)" else "Giao diện web: chưa có ai mở"
}

/** Who this phone is, as the server and the web page will show it. */
data class DeviceIdentity(val id: String, val name: String, val model: String, val android: String, val appVersion: String, val ip: String)

/** What the phone reports in each heartbeat. */
data class Heartbeat(val autoPush: Boolean, val folder: String, val state: String, val error: String)

/** Something the web page asked this phone to do (today only: delete items of the keymap cache). */
data class ServerCommand(val id: String, val type: String, val file: String, val ids: List<String>)

/** What this phone did about a command, as the web page shows it. */
data class CommandReport(
    val removed: List<String> = emptyList(),
    val missing: List<String> = emptyList(),
    val reappeared: List<String> = emptyList(),
    val skipped: List<Pair<String, String>> = emptyList(),
    val error: String = "",
    val backup: String = "",
) {
    fun toJson(): JSONObject = JSONObject()
        .put("removed", org.json.JSONArray(removed)).put("missing", org.json.JSONArray(missing)).put("reappeared", org.json.JSONArray(reappeared))
        .put("skipped", org.json.JSONArray().also { a -> skipped.forEach { a.put(JSONObject().put("id", it.first).put("reason", it.second)) } })
        .put("error", error).put("backup", backup)

    fun describe(): String = buildString {
        append("đã xóa ${removed.size} mục trên máy")
        if (missing.isNotEmpty()) append(", ${missing.size} mục không còn")
        if (reappeared.isNotEmpty()) append(", ⚠ ${reappeared.size} mục hiện lại (Gamwing ghi đè file? hãy đóng Gamwing)")
        if (error.isNotEmpty()) append(", lỗi: $error")
    }
}

data class HelloResult(val webSessions: Int, val devicesOnline: Int, val commands: List<ServerCommand> = emptyList())

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
data class BackupDay(val date: String, val databases: Int, val bytes: Long, val updatedAt: String?, val lastActor: String?) {
    fun describe(): String {
        val size = if (bytes >= 1_048_576) String.format(Locale.US, "%.1f MB", bytes / 1_048_576.0) else String.format(Locale.US, "%.0f KB", bytes / 1024.0)
        val time = updatedAt?.let { runCatching { OffsetDateTime.parse(it).atZoneSameInstant(ZoneId.systemDefault()).format(DateTimeFormatter.ofPattern("HH:mm")) }.getOrNull() }
        return buildString {
            append("$date · $databases file · $size")
            if (time != null) append(" · cập nhật $time")
            if (!lastActor.isNullOrBlank()) append(" · bởi $lastActor")
        }
    }
}

/** Result of sending the preference files; `saved` are new or changed on the server. */
data class DatabasePushSummary(val saved: Int, val unchanged: Int, val skipped: List<String>) {
    fun describe() = "$saved file mới/đổi, giữ nguyên $unchanged, bỏ qua ${skipped.size}"

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
        if (!exists) return "Thư mục không tồn tại: $path"
        val kb = String.format(Locale.US, "%.1f", bytes / 1024.0)
        return "Thư mục $path: $files file .xml sẽ sao lưu ($kb KB)" + if (excluded.isEmpty()) "" else ", bỏ qua ${excluded.size} file (${excluded.joinToString()})"
    }
}

/** What the server reports after "delete everything": which folders were cleared and where the last copy is kept. */
data class WipeResult(val moved: List<String>, val keptIn: String)

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
