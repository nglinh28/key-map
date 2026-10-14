package vn.local.ftkeymapsync

import java.net.URI

/**
 * The preference files of the Gamwing app (the .xml files in Documents/jya2/databases). Same rules as the server's: only plain .xml
 * names, and nothing that carries license or session state is ever read, sent or written back.
 */
object DatabaseNames {
    private val EXCLUDED = Regex("entitlement|ipc[-_ ]?session|licen[cs]e", RegexOption.IGNORE_CASE)
    private const val MAX_CHARS = 120
    private const val BACKSLASH = '\\'

    /** null when the name may be backed up, otherwise why not */
    fun problem(name: String): String? = when {
        name.isEmpty() -> "tên trống"
        name.codePointCount(0, name.length) > MAX_CHARS -> "tên quá dài"
        name.any { it == '/' || it == BACKSLASH || it.code < 32 } || name == "." || name == ".." || name.startsWith(".") -> "tên không an toàn"
        !name.endsWith(".xml", ignoreCase = true) -> "không phải file .xml"
        EXCLUDED.containsMatchIn(name) -> "file giấy phép/phiên đăng nhập không được sao lưu"
        else -> null
    }

    fun isBackupName(name: String) = problem(name) == null
}

/**
 * Why an address typed by the user cannot be used, in words for the user; null when it is fine.
 * (An IP such as 192.168.17 has only three parts: Java's URI then reports no host at all, so the reason is worked out here.)
 */
fun serverUrlProblem(input: String): String? {
    val t = input.trim()
    if (t.isEmpty()) return "Chưa nhập địa chỉ server."
    val rest = if (t.contains("://")) {
        val scheme = t.substringBefore("://").lowercase()
        if (scheme != "http" && scheme != "https") return "Chỉ dùng được địa chỉ bắt đầu bằng http:// hoặc https://."
        t.substringAfter("://")
    } else t
    val authority = rest.substringBefore('/').substringBefore('?').substringBefore('#').substringAfterLast('@')
    val colon = authority.lastIndexOf(':')
    val hasPort = colon >= 0 && !authority.startsWith("[")
    val host = if (hasPort) authority.substring(0, colon) else authority
    if (hasPort) {
        val port = authority.substring(colon + 1)
        if (port.isNotEmpty() && (!port.all { it.isDigit() } || port.toIntOrNull() !in 1..65535)) return "Cổng phải là số từ 1 đến 65535 (bạn nhập \"$port\")."
    }
    if (host.isBlank()) return "Thiếu địa chỉ máy chạy server (ví dụ 192.168.4.17:8787)."
    if (host.all { it.isDigit() || it == '.' }) {
        val parts = host.split('.')
        if (parts.size != 4 || parts.any { it.isEmpty() || it.length > 3 || it.toInt() > 255 }) {
            return if (parts.size == 4 && parts.none { it.isEmpty() }) "Mỗi số trong địa chỉ IP phải từ 0 đến 255 (bạn nhập $host)."
            else "Địa chỉ IP phải có đủ 4 số từ 0 đến 255, ví dụ 192.168.4.17 (bạn nhập $host)."
        }
    }
    val withScheme = if (t.contains("://")) t else "http://$t"
    val ok = try { !URI(withScheme).host.isNullOrBlank() } catch (e: Exception) { false }
    return if (ok) null else "Địa chỉ không hợp lệ: \"$t\" (ví dụ 192.168.4.17:8787)."
}

/**
 * Should the background service be started on its own (when the tablet boots, or after this app is updated)? Only when the user
 * wants it kept alive and it could actually work: a usable server address and the "all files" permission.
 */
fun shouldRunInBackground(keepAlive: Boolean, serverUrl: String, hasAllFiles: Boolean): Boolean =
    keepAlive && hasAllFiles && normalizeServerUrl(serverUrl) != null

/** The line of the heartbeat that tells the web page what the app is doing: "idle" when it only listens, "watching" when it also pushes. */
fun heartbeatState(autoPush: Boolean, lastError: String): String = when {
    lastError.isNotEmpty() -> "error"
    autoPush -> "watching"
    else -> "idle"
}

/** "192.168.1.15:8787" -> "http://192.168.1.15:8787"; null when it is not an http(s) address (see [serverUrlProblem] for why). */
fun normalizeServerUrl(input: String): String? {
    if (serverUrlProblem(input) != null) return null
    val t = input.trim()
    val withScheme = if (t.contains("://")) t else "http://$t"
    return try {
        val u = URI(withScheme)
        val port = if (u.port != -1) ":${u.port}" else ""
        "${u.scheme.lowercase()}://${u.host}$port"
    } catch (e: Exception) {
        null
    }
}
