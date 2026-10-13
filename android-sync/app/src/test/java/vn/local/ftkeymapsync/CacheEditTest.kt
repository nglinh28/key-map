package vn.local.ftkeymapsync

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

private const val KM = "com.vng.pubgmobile"
private const val RC = "com.zjx.pubg.rcConfig2"
private const val AI = "com.zjx.pubg.recognition.com.vng.pubgmobile"
private fun id(c: Char) = c.toString().repeat(32)

private fun str(name: String, value: String) = "<string name=\"${CacheEdit.escapeXml(name)}\">${CacheEdit.escapeXml(value)}</string>"
private fun prefs(vararg lines: String) = "<?xml version='1.0' encoding='utf-8' standalone='yes' ?>\n<map>\n${lines.joinToString("\n") { "    $it" }}\n</map>\n"

private fun item(id: String, game: String, name: String) =
    JSONObject().put("id", id).put("name", "2026-01-01 00:00:00").put("game", game).put("public", false).put("meta", JSONObject().put("name", name).toString())

private fun list(selected: String?, vararg items: JSONObject): String {
    val o = JSONObject()
    if (selected != null) o.put("selected", selected)
    o.put("items", JSONArray().also { a -> items.forEach { a.put(it) } })
    return o.toString()
}

private val keymapDoc = """{"version":"1","components":[{"base:componentIdentifier":"com.zjx.app:joystick"}]}"""

/** a = listed keymap, b = orphan keymap, c = selected recoil config, d = second recoil config without a map, e = the only recognition map */
fun cacheXml() = prefs(
    str("list|$KM", list(id('a'), item(id('a'), KM, "Mine"))),
    str("map|${id('a')}", keymapDoc),
    str("map|${id('b')}", keymapDoc.replace("\"1\"", "\"old\"")),
    str("list|$RC", list(id('c'), item(id('c'), RC, "Recoil C"), item(id('d'), RC, "Recoil D"))),
    str("map|${id('c')}", """{"name":"Recoil C","recoil_data":[]}"""),
    str("list|$AI", list(id('e'), item(id('e'), AI, "AI"))),
    str("map|${id('e')}", """{"name":"AI map","components":[{"type":4}]}"""),
)

/** names of the <string> entries, in order */
fun entryNames(xml: String) = Regex("<string name=\"([^\"]*)\"").findAll(xml).map { it.groupValues[1] }.toList()

/** the JSON of one list entry, after unescaping */
fun listJson(xml: String, ns: String): JSONObject {
    val m = Regex("<string name=\"list\\|${Regex.escape(ns)}\">(.*?)</string>").find(xml)!!
    return JSONObject(CacheEdit.unescapeXml(m.groupValues[1]))
}

class CacheEditTest {
    @Test fun `escape and unescape are the five characters Android writes plus numeric entities`() {
        assertEquals("a&amp;b&lt;c&gt;&quot;d&apos;e", CacheEdit.escapeXml("a&b<c>\"d'e"))
        assertEquals("a&b<c>\"d'e A中", CacheEdit.unescapeXml("a&amp;b&lt;c&gt;&quot;d&apos;e &#65;&#x4E2D;"))
        assertEquals("&quot; stays", CacheEdit.unescapeXml("&amp;quot; stays"))
    }

    @Test fun `an orphan map goes away and nothing else changes, byte for byte`() {
        val xml = cacheXml()
        val r = CacheEdit.removeItems(xml, listOf(id('b')))
        assertEquals(listOf(id('b')), r.removedMaps)
        assertTrue(r.lists.isEmpty() && r.missing.isEmpty() && r.warnings.isEmpty())
        assertEquals(xml.split("\n").filter { !it.contains("<string name=\"map|${id('b')}\">") }.joinToString("\n"), r.text)
        assertFalse(Regex("\n\\s*\n").containsMatchIn(r.text))
    }

    @Test fun `a listed item leaves its map and its list entry and the selection moves to the first one left`() {
        val r = CacheEdit.removeItems(cacheXml(), listOf(id('c')))
        assertEquals(listOf(id('c')), r.removedMaps)
        assertEquals(listOf(CacheEdit.ListChange(RC, listOf(id('c')), id('c'), id('d'))), r.lists)
        val l = listJson(r.text, RC)
        assertEquals(id('d'), l.getString("selected"))
        assertEquals(listOf(id('d')), (0 until l.getJSONArray("items").length()).map { l.getJSONArray("items").getJSONObject(it).getString("id") })
        assertFalse(entryNames(r.text).contains("map|${id('c')}"))
        assertEquals("the other lists are untouched", listOf(id('a')), listJson(r.text, KM).getJSONArray("items").let { a -> (0 until a.length()).map { a.getJSONObject(it).getString("id") } })
    }

    @Test fun `an item that is not selected keeps the selection, and a listed item without a map leaves the list only`() {
        val r = CacheEdit.removeItems(cacheXml(), listOf(id('d')))
        assertTrue(r.removedMaps.isEmpty())
        assertEquals(listOf(CacheEdit.ListChange(RC, listOf(id('d')), id('c'), id('c'))), r.lists)
        assertEquals(id('c'), listJson(r.text, RC).getString("selected"))
    }

    @Test fun `the last item of a list leaves an empty list without a selection`() {
        val r = CacheEdit.removeItems(cacheXml(), listOf(id('e')))
        val l = listJson(r.text, AI)
        assertEquals(0, l.getJSONArray("items").length())
        assertFalse(l.has("selected"))
        assertEquals(CacheEdit.ListChange(AI, listOf(id('e')), id('e'), ""), r.lists.single())
    }

    @Test fun `several ids at once, unknown ids are reported and a second run changes nothing`() {
        val r = CacheEdit.removeItems(cacheXml(), listOf(id('b'), id('c'), id('9')))
        assertEquals(setOf(id('b'), id('c')), r.removedMaps.toSet())
        assertEquals(listOf(id('9')), r.missing)
        val again = CacheEdit.removeItems(r.text, listOf(id('b'), id('c')))
        assertEquals(r.text, again.text)
        assertTrue(again.removedMaps.isEmpty())
        assertEquals(setOf(id('b'), id('c')), again.missing.toSet())
    }

    @Test fun `names with quotes, ampersands, apostrophes and slashes survive the rewrite of a list`() {
        val tricky = prefs(
            str("list|$KM", list(id('1'), item(id('1'), KM, "A \"q\" & <b> 'c' a/b"), item(id('2'), KM, "other"))),
            str("map|${id('1')}", keymapDoc), str("map|${id('2')}", keymapDoc),
        )
        val r = CacheEdit.removeItems(tricky, listOf(id('2')))
        val l = listJson(r.text, KM)
        assertEquals("A \"q\" & <b> 'c' a/b", JSONObject(l.getJSONArray("items").getJSONObject(0).getString("meta")).getString("name"))
        assertEquals(id('1'), l.getString("selected"))
        assertFalse("an apostrophe is written as &apos; like Android does", r.text.contains("'c'"))
        assertFalse("a slash is not written as \\/", r.text.contains("\\/"))
    }

    @Test fun `a damaged list is left alone with a warning, the map is still removed, bad ids and non-preference files are refused`() {
        val broken = prefs(str("list|$KM", "{not json"), str("map|${id('1')}", keymapDoc))
        val r = CacheEdit.removeItems(broken, listOf(id('1')))
        assertEquals(listOf(id('1')), r.removedMaps)
        assertEquals(1, r.warnings.size)
        assertTrue(r.warnings[0], r.warnings[0].contains("list|$KM"))
        for (bad in listOf("", "../x", "a b", "a/b", "x".repeat(200))) {
            assertTrue(bad, runCatching { CacheEdit.removeItems(cacheXml(), listOf(bad)) }.exceptionOrNull() is IllegalArgumentException)
        }
        assertTrue(runCatching { CacheEdit.removeItems("<html/>", listOf(id('1'))) }.exceptionOrNull() is IllegalArgumentException)
    }

    @Test fun `the result of removing everything the web page can remove is still a readable preferences file`() {
        val r = CacheEdit.removeItems(cacheXml(), listOf(id('a'), id('b'), id('c'), id('d'), id('e')))
        assertEquals(listOf("list|$KM", "list|$RC", "list|$AI"), entryNames(r.text))
        assertTrue(r.text.startsWith("<?xml version='1.0'") && r.text.trimEnd().endsWith("</map>"))
    }
}

class DeleteCommandTest : SyncTestBase() {
    private fun cmd(vararg ids: String) = ServerCommand("cmd_1", "delete_cache_items", "gamwing_keymap_cache.xml", ids.toList())

    @Test fun `the command cuts the items on the tablet, copies the old file first and reports what it did`() {
        put("gamwing_keymap_cache.xml", cacheXml())
        val before = text("gamwing_keymap_cache.xml")
        val report = engine.applyDeletion(cmd(id('b'), id('c')))
        assertEquals(setOf(id('b'), id('c')), report.removed.toSet())
        assertTrue(report.missing.isEmpty() && report.reappeared.isEmpty() && report.error.isEmpty())
        val after = text("gamwing_keymap_cache.xml")
        assertFalse(entryNames(after).contains("map|${id('b')}") || entryNames(after).contains("map|${id('c')}"))
        assertEquals(id('d'), listJson(after, RC).getString("selected"))
        // the old file is kept where the app keeps its safety copies
        val saved = File(report.backup, "gamwing_keymap_cache.xml")
        assertEquals(before, saved.readText())
        assertTrue(saved.absolutePath.startsWith(backup.absolutePath))
        assertEquals("databases", File(report.backup).name)
    }

    @Test fun `items that are already gone are reported as missing and the file is left alone, with no safety copy`() {
        put("gamwing_keymap_cache.xml", cacheXml())
        val modified = File(dir, "gamwing_keymap_cache.xml").lastModified()
        val report = engine.applyDeletion(cmd(id('9')))
        assertEquals(listOf(id('9')), report.missing)
        assertTrue(report.removed.isEmpty() && report.backup.isEmpty())
        assertEquals(modified, File(dir, "gamwing_keymap_cache.xml").lastModified())
        assertFalse(backup.exists())
    }

    @Test fun `when Gamwing writes the old file back the items are reported as reappeared`() {
        put("gamwing_keymap_cache.xml", cacheXml())
        val old = text("gamwing_keymap_cache.xml")
        val e = SyncEngine(folder, client, backup, clock = { 1_700_000_000_000L }, settle = { File(dir, "gamwing_keymap_cache.xml").writeText(old) })
        val report = e.applyDeletion(cmd(id('b')))
        assertEquals(listOf(id('b')), report.reappeared)
        assertEquals(listOf(id('b')), report.removed)
    }

    @Test fun `a missing file, a file that may not be touched and a damaged list are errors, not crashes`() {
        assertTrue(engine.applyDeletion(cmd(id('b'))).error.contains("không có"))
        put("gamwing_entitlement.xml", cacheXml())
        val bad = engine.applyDeletion(ServerCommand("c", "delete_cache_items", "gamwing_entitlement.xml", listOf(id('b'))))
        assertTrue(bad.error, bad.error.isNotEmpty())
        assertEquals(cacheXml(), text("gamwing_entitlement.xml"))
        put("gamwing_keymap_cache.xml", prefs(str("list|$KM", "{broken"), str("map|${id('b')}", keymapDoc)))
        val damaged = engine.applyDeletion(cmd(id('b')))
        assertEquals(listOf(id('b')), damaged.removed)
        assertTrue(damaged.error, damaged.error.contains("list|$KM"))
        val unknown = engine.applyDeletion(ServerCommand("c", "format_the_tablet", "gamwing_keymap_cache.xml", listOf(id('b'))))
        assertTrue(unknown.error, unknown.error.contains("không biết"))
        assertTrue(engine.applyDeletion(ServerCommand("c", "delete_cache_items", "gamwing_keymap_cache.xml", listOf("../x"))).error.isNotEmpty())
    }

    @Test fun `commands from the heartbeat are done once, reported, and not done again while the report is on its way`() {
        put("gamwing_keymap_cache.xml", cacheXml())
        server.pendingCommands += cmd(id('b'))
        val me = DeviceIdentity("tablet-0001", "Tab", "SM", "15", "2.0.0", "192.168.4.21")
        val c = ServerClient(server.url, identity = me)
        val e = SyncEngine(folder, c, backup, settle = {}, commandState = CommandState())
        val hello = c.hello(Heartbeat(true, dir.path, "watching", ""))
        assertEquals(1, hello.commands.size)
        assertEquals(listOf("cmd_1", "delete_cache_items", "gamwing_keymap_cache.xml"), hello.commands[0].let { listOf(it.id, it.type, it.file) })
        val lines = e.runCommands(hello.commands)
        assertEquals(1, server.commandResults.size)
        assertEquals(listOf(id('b')), server.commandResults[0].second.removed)
        assertTrue(lines.single(), lines.single().contains("1"))
        assertEquals("the server stops sending it once it has the result", 0, c.hello(Heartbeat(true, dir.path, "watching", "")).commands.size)
        // the same command handed out twice (by two heartbeats at once) is only done once
        server.pendingCommands += cmd(id('c')).copy(id = "cmd_2")
        val two = c.hello(Heartbeat(true, dir.path, "watching", "")).commands
        e.runCommands(two); e.runCommands(two)
        assertEquals(2, server.commandResults.size)
    }

    @Test fun `a command that fails is still reported`() {
        server.pendingCommands += cmd(id('b'))
        val c = ServerClient(server.url, identity = DeviceIdentity("tablet-0001", "Tab", "SM", "15", "2.0.0", ""))
        val e = SyncEngine(folder, c, backup, settle = {}, commandState = CommandState())
        e.runCommands(c.hello(Heartbeat(true, dir.path, "watching", "")).commands)
        assertEquals(1, server.commandResults.size)
        assertTrue(server.commandResults[0].second.error.isNotEmpty())
    }
}
