package vn.local.ftkeymapsync

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeNotNull
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder

/**
 * End to end against a REAL backup server, with the real files of Documents/jya2/databases.
 * Skipped unless both variables are set:
 *   SYNC_TEST_SERVER=http://127.0.0.1:8799   SYNC_TEST_DATABASES=<folder with the .xml files>
 * Use a throw-away server: the test pushes files to it and then changes one.
 */
class RealServerTest {
    @get:Rule val tmp = TemporaryFolder()

    private fun getText(base: String, path: String): String {
        val c = URL(base + path).openConnection() as HttpURLConnection
        return try { String(c.inputStream.readBytes(), Charsets.UTF_8) } finally { c.disconnect() }
    }

    @Test fun `push the phone files, change one, push again, then restore today's backup onto an empty folder`() {
        val url = System.getenv("SYNC_TEST_SERVER")
        val src = System.getenv("SYNC_TEST_DATABASES")
        assumeNotNull(url, src)

        val dir = tmp.newFolder("databases")
        File(src).listFiles()!!.filter { it.isFile && it.name.endsWith(".xml") }.forEach { it.copyTo(File(dir, it.name)) }
        val expected = dir.listFiles()!!.count { DatabaseNames.isBackupName(it.name) }
        val engine = SyncEngine(LocalFolder(dir), ServerClient(url), File(tmp.root, "backup"))

        val first = engine.push()
        assertTrue(first.skipped.toString(), first.skipped.isEmpty())
        assertEquals(expected, first.saved + first.unchanged)
        val again = engine.push()
        assertEquals(listOf(0, expected), listOf(again.saved, again.unchanged))

        val name = File(dir, "PubgSettings.xml").takeIf { it.exists() } ?: dir.listFiles()!!.first { DatabaseNames.isBackupName(it.name) }
        name.writeText(name.readText() + "\n<!-- changed by the test -->\n")
        assertEquals(1, engine.push(listOf(name.name)).saved)
        assertTrue(getText(url, "/admin/api/sync/databases/" + URLEncoder.encode(name.name, "UTF-8").replace("+", "%20")).contains("changed by the test"))

        val empty = tmp.newFolder("restored")
        val restoreEngine = SyncEngine(LocalFolder(empty), ServerClient(url), File(tmp.root, "backup2"))
        val today = restoreEngine.listBackupDays().first { it.databases > 0 }
        val result = restoreEngine.applyRestore(restoreEngine.planRestore(today.date))
        assertTrue(result.failed.toString(), result.failed.isEmpty())
        assertEquals(expected, result.written.size)
        assertEquals(name.readText(), File(empty, name.name).readText())
    }
}
