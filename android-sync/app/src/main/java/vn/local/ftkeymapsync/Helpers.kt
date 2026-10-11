package vn.local.ftkeymapsync

import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener
import java.net.URI

/** The phone stores "list|<ns>" and "map|<id>" with the bar percent-encoded in the file name. */
object CacheNames {
    private val CACHE = Regex("^(list|map)%7C[A-Za-z0-9._-]+\\.json$")

    fun kind(name: String): FileKind = when {
        !CACHE.matches(name) -> FileKind.OTHER
        name.startsWith("list%7C") -> FileKind.LIST
        else -> FileKind.MAP
    }

    /** A name received from the server is only used if it is a plain cache file name (no path, nothing surprising). */
    fun isSafeServerName(name: String) = CACHE.matches(name)
}

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

/** Equality of two JSON values: key order and number spelling (100 vs 100.0) do not matter. */
fun jsonEquals(a: Any?, b: Any?): Boolean = when {
    a is JSONObject && b is JSONObject -> {
        val ka = a.keys().asSequence().toSet()
        val kb = b.keys().asSequence().toSet()
        ka == kb && ka.all { jsonEquals(a.get(it), b.get(it)) }
    }
    a is JSONArray && b is JSONArray -> a.length() == b.length() && (0 until a.length()).all { jsonEquals(a.get(it), b.get(it)) }
    a is Number && b is Number -> a.toDouble() == b.toDouble()
    else -> a == b
}

private fun parseStrict(text: String): Any? {
    val t = JSONTokener(text)
    val v = t.nextValue()
    if (t.nextClean() != 0.toChar()) throw IllegalArgumentException("trailing data")
    return v
}

/** Same JSON content? Text that is not valid JSON is compared exactly. */
fun sameJson(a: String, b: String): Boolean {
    val pa = runCatching { parseStrict(a) }.getOrNull()
    val pb = runCatching { parseStrict(b) }.getOrNull()
    if ((pa is JSONObject || pa is JSONArray) && (pb is JSONObject || pb is JSONArray)) return jsonEquals(pa, pb)
    return a == b
}
