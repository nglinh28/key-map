package vn.local.ftkeymapsync

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeNotNull
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

/**
 * End to end against a REAL keymap server, with the real backup files pulled from the phone.
 * Skipped unless both variables are set:
 *   SYNC_TEST_SERVER=http://127.0.0.1:8788   SYNC_TEST_RAW=<folder with the list%7C… / map%7C… files>
 * Use a throw-away server: the test creates and then changes a document on it.
 */
class RealServerTest {
    @get:Rule val tmp = TemporaryFolder()

    private fun getJson(base: String, path: String): JSONObject {
        val c = URL(base + path).openConnection() as HttpURLConnection
        return try { JSONObject(String(c.inputStream.readBytes(), Charsets.UTF_8)) } finally { c.disconnect() }
    }

    @Test fun `push the phone backup, change one file, then pull it all back`() {
        val url = System.getenv("SYNC_TEST_SERVER")
        val raw = System.getenv("SYNC_TEST_RAW")
        assumeNotNull(url, raw)

        val dir = tmp.newFolder("cache")
        File(raw).listFiles()!!.filter { it.isFile && it.name.endsWith(".json") }.forEach { it.copyTo(File(dir, it.name)) }
        val total = dir.listFiles()!!.size
        val engine = SyncEngine(LocalFolder(dir), ServerClient(url), File(tmp.root, "backup"))

        val first = engine.pushAll()
        assertTrue(first.skipped.toString(), first.skipped.isEmpty())
        assertEquals(9, first.imported)

        val again = engine.pushAll()
        assertEquals(listOf(0, 0, 0), listOf(again.imported, again.updated, again.snapshots))

        // the keyboard map of the user: change one value like an edit made on the phone
        val keyboard = File(dir, "map%7C14cbc4ec486541b5add77553b03b5544.json")
        val edited = JSONObject(keyboard.readText()).put("version", "9.9.9")
        keyboard.writeText(edited.toString())
        val upd = engine.pushAll()
        assertEquals(listOf(1, 1), listOf(upd.updated, upd.snapshots))

        val acc = getJson(url, "/admin/api/sync/info").getString("account")
        val versions = getJson(url, "/admin/api/accounts/$acc/docs/14cbc4ec486541b5add77553b03b5544/history").getJSONArray("versions")
        assertEquals("the old version is kept on the server", 1, versions.length())

        val dir2 = tmp.newFolder("cache2")
        val engine2 = SyncEngine(LocalFolder(dir2), ServerClient(url), File(tmp.root, "backup2"))
        val plan = engine2.planPull()
        assertEquals(total, plan.newCount)
        val result = engine2.applyPull(plan)
        assertEquals(total, result.written.size)
        assertTrue(result.failed.isEmpty())
        for (f in dir.listFiles()!!.filter { it.name.startsWith("map") }) {
            assertTrue("${f.name} differs after the round trip", sameJson(f.readText(), File(dir2, f.name).readText()))
        }
        assertEquals("9.9.9", JSONObject(File(dir2, keyboard.name).readText()).getString("version"))
        // pulling again finds nothing to do
        assertEquals(total, engine2.planPull().sameCount)
    }

    /** The preference files of the app, as copied from the phone (SYNC_TEST_DB), through a real server and back. */
    @Test fun `preference files round trip through the real server, names with accents and CJK included`() {
        val url = System.getenv("SYNC_TEST_SERVER")
        val src = System.getenv("SYNC_TEST_DB")
        assumeNotNull(url, src)

        val dir = tmp.newFolder("databases")
        File(src).listFiles()!!.filter { it.isFile && it.name.endsWith(".xml") }.forEach { it.copyTo(File(dir, it.name)) }
        val expected = dir.listFiles()!!.map { it.name }.filter { DatabaseNames.isBackupName(it) }.toSet()
        assertTrue("need some files to test with", expected.size >= 5)
        val client = ServerClient(url)
        val engine = SyncEngine(LocalFolder(tmp.newFolder("cache")), client, File(tmp.root, "backup"), dbFolder = LocalFolder(dir))

        val first = engine.pushDatabases()
        assertTrue(first.skipped.toString(), first.skipped.isEmpty())
        assertEquals(expected.size, first.saved)
        assertEquals(listOf(0, expected.size), engine.pushDatabases().let { listOf(it.saved, it.unchanged) })

        val listed = getJson(url, "/admin/api/sync/databases").getJSONArray("files")
        assertEquals(expected, (0 until listed.length()).map { listed.getJSONObject(it).getString("name") }.toSet())

        val day = client.backups().first()
        assertEquals(expected.size, day.databases)

        val dir2 = tmp.newFolder("databases2")
        val engine2 = SyncEngine(LocalFolder(tmp.newFolder("cache2")), client, File(tmp.root, "backup2"), dbFolder = LocalFolder(dir2))
        val plan = engine2.planRestoreDatabases(day.date)
        assertEquals(expected.size, plan.newCount)
        assertTrue(plan.rejected.isEmpty())
        val result = engine2.applyRestoreDatabases(plan)
        assertEquals(expected, result.written.toSet())
        for (name in expected) assertEquals("$name differs after the round trip", File(dir, name).readText(), File(dir2, name).readText())
        assertEquals(expected.size, engine2.planRestoreDatabases(day.date).sameCount)

        // a changed file is shown as changed, and its old content is copied aside before it is overwritten
        val victim = expected.first { it.startsWith("Cài") || it.contains("Settings") }
        File(dir2, victim).writeText("<map/>")
        val again = engine2.planRestoreDatabases(day.date)
        assertEquals(1, again.changedCount)
        val r2 = engine2.applyRestoreDatabases(again)
        assertEquals("<map/>", File(r2.backupDir!!, victim).readText())
        assertEquals(File(dir, victim).readText(), File(dir2, victim).readText())
    }
}
