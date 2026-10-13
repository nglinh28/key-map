package vn.local.ftkeymapsync

import org.json.JSONArray
import org.json.JSONObject

/**
 * Edits gamwing_keymap_cache.xml (an Android SharedPreferences file) as text, so everything that is not touched stays byte for byte.
 * Same rules as the server's cachexml.js:
 *   * an item is the entry map|<id> and, when it is listed, its place in list|<namespace>;
 *   * a list whose selected item goes away selects the first item left (no selection when the list becomes empty).
 */
object CacheEdit {
    private val ID = Regex("^[A-Za-z0-9._-]{1,128}$")

    data class ListChange(val ns: String, val removed: List<String>, val selectedBefore: String, val selectedAfter: String)

    data class Result(val text: String, val removedMaps: List<String>, val lists: List<ListChange>, val missing: List<String>, val warnings: List<String>)

    /** the five characters Android escapes when it writes a string value */
    fun escapeXml(s: String): String = buildString {
        for (c in s) when (c) {
            '&' -> append("&amp;")
            '<' -> append("&lt;")
            '>' -> append("&gt;")
            '"' -> append("&quot;")
            '\'' -> append("&apos;")
            else -> append(c)
        }
    }

    /** one pass, so "&amp;quot;" becomes "&quot;" and not a quote */
    fun unescapeXml(s: String): String = Regex("&(?:#x([0-9a-fA-F]+)|#(\\d+)|(quot|apos|lt|gt|amp));").replace(s) { m ->
        val named = m.groupValues[3]
        when {
            named == "quot" -> "\""
            named == "apos" -> "'"
            named == "lt" -> "<"
            named == "gt" -> ">"
            named == "amp" -> "&"
            else -> runCatching {
                val cp = if (m.groupValues[1].isNotEmpty()) m.groupValues[1].toInt(16) else m.groupValues[2].toInt()
                String(Character.toChars(cp))
            }.getOrDefault(m.value)
        }
    }

    private class Span(val start: Int, val inner: Int, val innerEnd: Int, val end: Int)

    private fun span(xml: String, name: String): Span? {
        val open = "<string name=\"${escapeXml(name)}\">"
        val i = xml.indexOf(open)
        if (i < 0) return null
        val j = xml.indexOf("</string>", i + open.length)
        return if (j < 0) null else Span(i, i + open.length, j, j + "</string>".length)
    }

    /** org.json writes "/" as "\/"; Gamwing's own text does not, so give it back unless the slash is part of an escaped backslash */
    private fun plainSlashes(json: String): String = buildString {
        var backslashes = 0
        for (c in json) {
            if (c == '/' && backslashes % 2 == 1) { setLength(length - 1) }
            append(c)
            backslashes = if (c == '\\') backslashes + 1 else 0
        }
    }

    private fun looksLikePreferences(xml: String): Boolean {
        val t = xml.trim()
        return Regex("<map(\\s[^>]*)?/>$").containsMatchIn(t) || (Regex("<map(\\s[^>]*)?>").containsMatchIn(t) && t.endsWith("</map>"))
    }

    fun removeItems(xml: String, ids: List<String>): Result {
        require(looksLikePreferences(xml)) { "Không phải file SharedPreferences hợp lệ." }
        val wanted = ids.distinct()
        for (x in wanted) require(ID.matches(x)) { "id không hợp lệ: $x" }
        var text = xml
        val removedMaps = mutableListOf<String>()
        for (x in wanted) {
            val s = span(text, "map|$x") ?: continue
            var start = s.start
            while (start > 0 && (text[start - 1] == ' ' || text[start - 1] == '\t')) start--
            if (start > 0 && text[start - 1] == '\n') start-- // the whole line, so no blank line is left
            text = text.substring(0, start) + text.substring(s.end)
            removedMaps += x
        }
        val lists = mutableListOf<ListChange>()
        val warnings = mutableListOf<String>()
        val inLists = mutableSetOf<String>()
        for (name in Regex("<string name=\"(list\\|[^\"]*)\">").findAll(text).map { it.groupValues[1] }.toList()) {
            val s = span(text, name) ?: continue
            val obj = runCatching { JSONObject(unescapeXml(text.substring(s.inner, s.innerEnd))) }.getOrNull()
            if (obj == null) { warnings += "$name: JSON hỏng nên không sửa được danh sách này"; continue }
            val items = obj.optJSONArray("items") ?: JSONArray()
            val gone = wanted.filter { x -> (0 until items.length()).any { items.optJSONObject(it)?.optString("id") == x } }
            inLists += gone
            if (gone.isEmpty()) continue
            val kept = JSONArray()
            for (i in 0 until items.length()) {
                val it = items.optJSONObject(i)
                if (it != null && it.optString("id") in gone) continue
                kept.put(items.get(i))
            }
            val before = obj.optString("selected", "")
            obj.put("items", kept)
            var after = before
            if (before in gone) {
                after = (0 until kept.length()).mapNotNull { kept.optJSONObject(it)?.optString("id")?.takeIf { id -> id.isNotEmpty() } }.firstOrNull() ?: ""
                if (after.isNotEmpty()) obj.put("selected", after) else obj.remove("selected")
            }
            text = text.substring(0, s.inner) + escapeXml(plainSlashes(obj.toString())) + text.substring(s.innerEnd)
            lists += ListChange(name.removePrefix("list|"), gone, before, after)
        }
        val missing = wanted.filter { it !in removedMaps && it !in inLists }
        return Result(text, removedMaps, lists, missing, warnings)
    }

    /** true when the item (its map or its place in a list) is still in the text */
    fun isPresent(xml: String, id: String): Boolean {
        val r = runCatching { removeItems(xml, listOf(id)) }.getOrNull() ?: return false
        return r.removedMaps.isNotEmpty() || r.lists.isNotEmpty()
    }
}
