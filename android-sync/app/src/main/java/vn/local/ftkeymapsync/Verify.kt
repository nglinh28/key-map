package vn.local.ftkeymapsync

import org.json.JSONArray
import org.json.JSONObject

/** Name, size in utf-8 bytes and sha-256 of the text of one file (the same fingerprints the server computes). */
data class FileDigest(val name: String, val bytes: Long, val sha256: String)

/** What the server holds (latest copy of every file) and what its newest backup day holds. [dayDate] is null when there is no backup day. */
data class ServerManifest(val latest: List<FileDigest>, val dayDate: String?, val day: List<FileDigest>)

/** The tablet's files compared with the server's latest copy and with the newest backup day. */
data class SyncCheck(
    val dayDate: String,
    val checked: Int,
    val same: Int,
    val different: List<String>,
    val onlyTablet: List<String>,
    val onlyServer: List<String>,
    val dayDifferent: List<String>,
    val error: String = "",
) {
    val inSync get() = error.isEmpty() && different.isEmpty() && onlyTablet.isEmpty() && onlyServer.isEmpty() && dayDifferent.isEmpty()

    fun toJson(): JSONObject = JSONObject().put("day", dayDate).put("checked", checked).put("same", same)
        .put("different", JSONArray(different)).put("only_tablet", JSONArray(onlyTablet)).put("only_server", JSONArray(onlyServer))
        .put("day_different", JSONArray(dayDifferent)).put("error", error)

    /** lines for the log and for the result dialog */
    fun lines(): List<String> {
        if (error.isNotEmpty()) return listOf("Không kiểm tra được đồng bộ: $error")
        val day = if (dayDate.isEmpty()) "server chưa có ngày sao lưu nào" else "bản sao lưu ngày $dayDate"
        val out = mutableListOf(
            if (inSync) "✔ Đã đồng bộ: $same/$checked file trên máy giống bản mới nhất trên server và giống $day."
            else "✘ Chưa đồng bộ ($same/$checked file giống bản mới nhất trên server; so với $day).",
        )
        if (different.isNotEmpty()) out += "  • khác bản mới nhất trên server: ${different.joinToString()}"
        if (onlyTablet.isNotEmpty()) out += "  • chỉ có trên máy: ${onlyTablet.joinToString()}"
        if (onlyServer.isNotEmpty()) out += "  • chỉ có trên server: ${onlyServer.joinToString()}"
        if (dayDifferent.isNotEmpty()) out += "  • khác $day: ${dayDifferent.joinToString()}"
        return out
    }
}

/** What the server found when it compared its latest copy with its newest backup day. */
data class ServerVerify(val ok: Boolean, val reason: String, val day: String, val checked: Int, val same: Int, val problems: List<String>) {
    fun lines(): List<String> = when {
        reason == "no_backup_day" -> listOf("Server chưa có ngày sao lưu nào để so sánh.")
        ok -> listOf("✔ Server đã đồng bộ: $same/$checked file của bản mới nhất giống bản sao lưu ngày $day.")
        else -> listOf("✘ Server chưa đồng bộ với bản sao lưu ngày $day ($same/$checked file giống):") + problems.map { "  • $it" }
    }
}
