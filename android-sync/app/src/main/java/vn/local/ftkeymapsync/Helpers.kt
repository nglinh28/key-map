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

/** "192.168.1.15:8787" -> "http://192.168.1.15:8787"; null when it is not an http(s) address. */
fun normalizeServerUrl(input: String): String? {
    val t = input.trim()
    if (t.isEmpty()) return null
    val withScheme = if (t.contains("://")) t else "http://$t"
    return try {
        val u = URI(withScheme)
        val scheme = u.scheme?.lowercase()
        if (scheme != "http" && scheme != "https") return null
        val host = u.host
        if (host.isNullOrBlank()) return null
        val port = if (u.port != -1) ":${u.port}" else ""
        "$scheme://$host$port"
    } catch (e: Exception) {
        null
    }
}
