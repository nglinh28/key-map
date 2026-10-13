package vn.local.ftkeymapsync

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.security.MessageDigest

class MemoryActions : ActionLog {
    val lines = mutableListOf<String>()
    override fun addAction(line: String) { lines += line }
}

private fun sha(text: String) = MessageDigest.getInstance("SHA-256").digest(text.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }

class SyncCheckTest : SyncTestBase() {
    private fun serverHolds(vararg files: Pair<String, String>, day: String = "2026-10-11", dayFiles: Map<String, String>? = null) {
        files.forEach { server.databases[it.first] = it.second }
        server.backupDatabases[day] = LinkedHashMap(dayFiles ?: server.databases)
    }

    @Test fun `the fingerprint is the sha-256 of the utf-8 text, with the size in bytes`() {
        val text = xml(1).replace("x", "Tiếng Việt 中文")
        put("Cài đặt cơ bản.xml", text); put("notes.txt", "not a preference file"); put("gamwing_entitlement.xml", xml(9))
        val d = engine.localDigests()
        assertEquals(listOf(FileDigest("Cài đặt cơ bản.xml", text.toByteArray().size.toLong(), sha(text))), d)
        assertEquals(emptyList<FileDigest>(), engine.localDigests(listOf("nope.xml")))
    }

    @Test fun `a tablet that matches the server and its newest day is in sync`() {
        put("a.xml", xml(1)); put("b.xml", xml(2))
        serverHolds("a.xml" to xml(1), "b.xml" to xml(2))
        val r = engine.checkSync()
        assertTrue(r.lines().toString(), r.inSync)
        assertEquals(listOf(2, 2, "2026-10-11"), listOf(r.checked, r.same, r.dayDate))
        assertTrue(r.lines()[0], r.lines()[0].contains("2/2"))
    }

    @Test fun `files that differ, exist only on the tablet or only on the server are named`() {
        put("same.xml", xml(1)); put("changed.xml", xml(2)); put("new_on_tablet.xml", xml(3))
        serverHolds("same.xml" to xml(1), "changed.xml" to xml(20), "only_on_server.xml" to xml(4))
        val r = engine.checkSync()
        assertFalse(r.inSync)
        assertEquals(listOf("changed.xml"), r.different)
        assertEquals(listOf("new_on_tablet.xml"), r.onlyTablet)
        assertEquals(listOf("only_on_server.xml"), r.onlyServer)
        assertEquals(setOf("changed.xml", "new_on_tablet.xml"), r.dayDifferent.toSet())
        assertEquals(1, r.same)
        val text = r.lines().joinToString("\n")
        assertTrue(text, text.contains("changed.xml") && text.contains("new_on_tablet.xml") && text.contains("only_on_server.xml") && text.contains("2026-10-11"))
    }

    @Test fun `a stale backup day is reported even when the latest copy matches the tablet`() {
        put("a.xml", xml(1))
        serverHolds("a.xml" to xml(1), dayFiles = mapOf("a.xml" to xml(0)))
        val r = engine.checkSync()
        assertEquals(listOf("a.xml"), r.dayDifferent)
        assertTrue(r.different.isEmpty() && r.onlyTablet.isEmpty() && r.onlyServer.isEmpty())
        assertFalse(r.inSync)
    }

    @Test fun `only the named files are compared after a push, and files only on the server are not mentioned`() {
        put("a.xml", xml(1)); put("b.xml", xml(2))
        serverHolds("a.xml" to xml(1), "b.xml" to xml(99), "c.xml" to xml(3))
        val r = engine.checkSync(listOf("a.xml"))
        assertTrue(r.lines().toString(), r.inSync)
        assertEquals(1, r.checked)
        assertTrue(r.onlyServer.isEmpty())
    }

    @Test fun `a server without any backup day compares only with the latest copy and says so`() {
        put("a.xml", xml(1))
        server.databases["a.xml"] = xml(1)
        val r = engine.checkSync()
        assertEquals("", r.dayDate)
        assertTrue(r.dayDifferent.isEmpty())
        assertTrue(r.lines()[0], r.lines()[0].contains("chưa có ngày sao lưu"))
    }

    @Test fun `a server that cannot be reached is an answer with an error, not an exception`() {
        put("a.xml", xml(1))
        server.failNext = true
        val r = engine.checkSync()
        assertTrue(r.error, r.error.isNotEmpty())
        assertFalse(r.inSync)
        assertTrue(r.lines()[0].startsWith("Không kiểm tra được"))
    }

    @Test fun `after a push the files just sent are checked against the newest backup day and the result is kept for the user`() {
        server.snapshotOnPush = true
        val actions = MemoryActions()
        val e = SyncEngine(folder, client, backup, settle = {}, commandState = CommandState(), actions = actions)
        put("a.xml", xml(1)); put("b.xml", xml(2))
        e.push()
        val r = e.checkAfterPush(listOf("a.xml", "b.xml"))
        assertTrue(r.lines().toString(), r.inSync)
        assertEquals(1, actions.lines.size)
        assertTrue(actions.lines[0], actions.lines[0].contains("2026-10-11") && actions.lines[0].contains("2/2"))
    }

    @Test fun `after a push to a server whose backup day did not follow, the difference is reported`() {
        server.snapshotOnPush = false
        server.backupDatabases["2026-10-11"] = LinkedHashMap<String, String>().also { it["a.xml"] = xml(0) }
        val actions = MemoryActions()
        val e = SyncEngine(folder, client, backup, settle = {}, commandState = CommandState(), actions = actions)
        put("a.xml", xml(1))
        e.push()
        val r = e.checkAfterPush(listOf("a.xml"))
        assertEquals(listOf("a.xml"), r.dayDifferent)
        assertTrue(actions.lines[0], actions.lines[0].contains("CHƯA đồng bộ") && actions.lines[0].contains("a.xml"))
    }

    @Test fun `the server's own check is read from its answer`() {
        server.databases["a.xml"] = xml(1); server.databases["b.xml"] = xml(2)
        server.backupDatabases["2026-10-11"] = LinkedHashMap<String, String>().also { it["a.xml"] = xml(9); it["z.xml"] = xml(5) }
        val v = client.serverVerify()
        assertFalse(v.ok)
        assertEquals(listOf("2026-10-11", 2, 0), listOf(v.day, v.checked, v.same))
        assertEquals(listOf("a.xml: khác bản sao lưu", "b.xml: thiếu trong bản sao lưu", "z.xml: thừa trong bản sao lưu"), v.problems)
        assertTrue(v.lines()[0], v.lines()[0].startsWith("✘"))
        server.backupDatabases["2026-10-11"] = LinkedHashMap(server.databases)
        assertTrue(client.serverVerify().ok)
        assertTrue(client.serverVerify().lines()[0].startsWith("✔"))
        server.backupDatabases.clear()
        assertTrue(client.serverVerify().lines()[0].contains("chưa có ngày sao lưu"))
    }

    @Test fun `the manifest of the server is read with the newest day`() {
        server.databases["a.xml"] = xml(1)
        server.backupDatabases["2026-10-10"] = LinkedHashMap<String, String>().also { it["a.xml"] = xml(0) }
        server.backupDatabases["2026-10-11"] = LinkedHashMap<String, String>().also { it["a.xml"] = xml(1) }
        val m = client.manifest()
        assertEquals(listOf(FileDigest("a.xml", xml(1).toByteArray().size.toLong(), sha(xml(1)))), m.latest)
        assertEquals("2026-10-11", m.dayDate)
        assertEquals(m.latest, m.day)
        server.backupDatabases.clear()
        assertEquals(null, client.manifest().dayDate)
    }
}

class VerifyCommandTest : SyncTestBase() {
    private val me = DeviceIdentity("tablet-0001", "Tab", "SM", "15", "2.0.0", "")

    @Test fun `a check asked by the web page is done by the tablet and its findings are reported`() {
        put("a.xml", xml(1)); put("b.xml", xml(2))
        server.databases["a.xml"] = xml(1); server.databases["b.xml"] = xml(99)
        server.backupDatabases["2026-10-11"] = LinkedHashMap(server.databases)
        server.pendingCommands += ServerCommand("cmd_v1", "verify_sync", "", emptyList())
        val c = ServerClient(server.url, identity = me)
        val actions = MemoryActions()
        val e = SyncEngine(folder, c, backup, settle = {}, commandState = CommandState(), actions = actions)
        val lines = e.runCommands(c.hello(Heartbeat(true, dir.path, "watching", "")).commands)
        val v = server.commandResults.single().second.verify!!
        assertEquals(listOf("2026-10-11", 2, 1), listOf(v.dayDate, v.checked, v.same))
        assertEquals(listOf("b.xml"), v.different)
        assertEquals(listOf("b.xml"), v.dayDifferent)
        assertTrue(lines.toString(), lines[0].contains("Kiểm tra đồng bộ") && lines.any { it.contains("b.xml") })
        assertTrue(actions.lines[0], actions.lines[0].startsWith("Kiểm tra đồng bộ"))
        assertEquals(0, c.hello(Heartbeat(true, dir.path, "watching", "")).commands.size)
    }

    @Test fun `a tablet that is in sync reports no differences`() {
        put("a.xml", xml(1))
        server.databases["a.xml"] = xml(1); server.backupDatabases["2026-10-11"] = LinkedHashMap(server.databases)
        server.pendingCommands += ServerCommand("cmd_v2", "verify_sync", "", emptyList())
        val c = ServerClient(server.url, identity = me)
        SyncEngine(folder, c, backup, settle = {}, commandState = CommandState()).runCommands(c.hello(Heartbeat(true, dir.path, "watching", "")).commands)
        val v = server.commandResults.single().second.verify!!
        assertTrue(v.inSync)
        assertEquals("", v.error)
    }

    @Test fun `deleted items are named in the log and in the action log of the tablet`() {
        put("gamwing_keymap_cache.xml", cacheXml())
        server.pendingCommands += ServerCommand("cmd_d1", "delete_cache_items", "gamwing_keymap_cache.xml", listOf("b".repeat(32), "c".repeat(32)), listOf("Bản cũ B", "Độ giật C"))
        val c = ServerClient(server.url, identity = me)
        val actions = MemoryActions()
        val e = SyncEngine(folder, c, backup, settle = {}, commandState = CommandState(), actions = actions)
        val lines = e.runCommands(c.hello(Heartbeat(true, dir.path, "watching", "")).commands)
        val text = lines.joinToString("\n")
        assertTrue(text, text.contains("đã xóa trên máy: «Bản cũ B» (map|${"b".repeat(32)})"))
        assertTrue(text, text.contains("đã xóa trên máy: «Độ giật C» (map|${"c".repeat(32)})"))
        assertEquals(1, actions.lines.size)
        assertTrue(actions.lines[0], actions.lines[0].startsWith("Đã xóa trên máy theo lệnh từ web") && actions.lines[0].contains("«Bản cũ B»") && actions.lines[0].contains("«Độ giật C»"))
    }

    @Test fun `an item the web page did not name is shown as unnamed instead of failing`() {
        put("gamwing_keymap_cache.xml", cacheXml())
        server.pendingCommands += ServerCommand("cmd_d2", "delete_cache_items", "gamwing_keymap_cache.xml", listOf("b".repeat(32)))
        val c = ServerClient(server.url, identity = me)
        val lines = SyncEngine(folder, c, backup, settle = {}, commandState = CommandState()).runCommands(c.hello(Heartbeat(true, dir.path, "watching", "")).commands)
        assertTrue(lines.toString(), lines.any { it.contains("«(không tên)»") })
    }

    @Test fun `the action log of the phone keeps the newest lines first and at most forty`() {
        val labels = ServerCommand("c", "delete_cache_items", "f", listOf("x"), listOf("Tên"))
        assertEquals("Tên", labels.labelOf("x"))
        assertEquals("", labels.labelOf("other"))
        assertEquals("", ServerCommand("c", "t", "f", listOf("x")).labelOf("x"))
    }
}
