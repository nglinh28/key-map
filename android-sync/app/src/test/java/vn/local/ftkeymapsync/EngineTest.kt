package vn.local.ftkeymapsync

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

fun xml(v: Int) = "<?xml version='1.0' encoding='utf-8' standalone='yes' ?>\n<map>\n    <int name=\"x\" value=\"$v\" />\n</map>\n"

class MemoryDbState : DbStateStore {
    override var lastPushedDb: Map<String, String> = emptyMap()
}

abstract class SyncTestBase {
    @get:Rule val tmp = TemporaryFolder()
    lateinit var server: FakeSyncServer
    lateinit var dir: File
    lateinit var backup: File
    lateinit var folder: LocalFolder
    lateinit var client: ServerClient
    lateinit var engine: SyncEngine
    private var time = 1_700_000_000_000L

    @Before fun setUp() {
        server = FakeSyncServer()
        dir = tmp.newFolder("databases")
        backup = File(tmp.root, "backup")
        folder = LocalFolder(dir)
        client = ServerClient(server.url)
        engine = SyncEngine(folder, client, backup, maxBatchBytes = 6_000_000, clock = { 1_700_000_000_000L }, settle = {}, commandState = CommandState())
    }

    @After fun tearDown() = server.stop()

    /** writes a file and gives it a distinct modification time, so a rewrite is always visible to the watcher */
    fun put(name: String, text: String) {
        val f = File(dir, name)
        f.writeText(text)
        time += 5_000
        f.setLastModified(time)
    }

    fun text(name: String) = File(dir, name).readText()

    fun day(date: String, vararg files: Pair<String, String>) {
        server.backupDatabases[date] = LinkedHashMap<String, String>().also { m -> files.forEach { m[it.first] = it.second } }
    }
}

class WatcherTest : SyncTestBase() {
    private fun watcher(state: DbStateStore = MemoryDbState()) = Watcher(folder, engine, state)

    @Test fun `waits for two equal looks, pushes once, then stays quiet`() {
        val state = MemoryDbState()
        val w = watcher(state)
        assertTrue(w.tick() is WatchEvent.Idle)
        put("a.xml", xml(1)); put("gamwing_entitlement.xml", xml(2))
        assertTrue(w.tick() is WatchEvent.Waiting)
        val ev = w.tick()
        assertTrue(ev.toString(), ev is WatchEvent.Pushed)
        assertEquals(listOf("a.xml"), (ev as WatchEvent.Pushed).names)
        assertEquals(setOf("a.xml"), server.databases.keys)
        assertEquals(setOf("a.xml"), state.lastPushedDb.keys)
        assertTrue(w.tick() is WatchEvent.Idle)
        put("a.xml", xml(5))
        assertTrue(w.tick() is WatchEvent.Waiting)
        assertTrue(w.tick() is WatchEvent.Pushed)
        assertEquals(xml(5), server.databases["a.xml"])
    }

    @Test fun `only the changed file is pushed`() {
        put("a.xml", xml(1)); put("b.xml", xml(2))
        val w = watcher()
        w.tick(); w.tick(); server.databasePushes.clear()
        put("b.xml", xml(3))
        w.tick()
        val e = w.tick() as WatchEvent.Pushed
        assertEquals(listOf(listOf("b.xml")), server.databasePushes)
        assertEquals(listOf("b.xml"), e.names)
    }

    @Test fun `keeps trying after a server error and a half-written file is not sent`() {
        val w = watcher()
        put("a.xml", xml(1))
        w.tick()
        server.failNext = true
        val failed = w.tick()
        assertTrue(failed.toString(), failed is WatchEvent.Failed)
        assertTrue(w.tick() is WatchEvent.Waiting) // starts again from scratch
        assertTrue(w.tick() is WatchEvent.Pushed)
        assertEquals(setOf("a.xml"), server.databases.keys)
        // a file changing between two looks is not sent until it settles
        put("b.xml", xml(1)); w.tick()
        put("b.xml", xml(2))
        assertTrue(w.tick() is WatchEvent.Waiting)
        assertTrue(!server.databases.containsKey("b.xml"))
    }

    @Test fun `state survives a restart and removed files are ignored`() {
        put("a.xml", xml(1))
        val state = MemoryDbState()
        val first = watcher(state); first.tick(); first.tick()
        server.databasePushes.clear()
        val second = watcher(state) // a new service instance with the saved state
        assertTrue(second.tick() is WatchEvent.Idle)
        File(dir, "a.xml").delete()
        assertTrue(second.tick() is WatchEvent.Idle)
        assertTrue(server.databasePushes.isEmpty())
        assertEquals("the server keeps what it has", setOf("a.xml"), server.databases.keys)
    }

    @Test fun `a missing folder does nothing`() {
        val gone = Watcher(LocalFolder(File(tmp.root, "nope")), engine, MemoryDbState())
        assertTrue(gone.tick() is WatchEvent.Idle)
    }
}

class ServerClientTest : SyncTestBase() {
    @Test fun `info is parsed`() {
        server.databases["a.xml"] = xml(1); server.databases["b.xml"] = xml(2)
        val info = client.info()
        assertEquals(listOf("ft-keymap-server", "2.0.0", 2), listOf(info.server, info.version, info.files))
        assertEquals("Đã kết nối tới ${server.url} (server sao lưu, 2 file đang lưu)", info.describe(server.url))
    }

    @Test fun `an address that is not a backup server is explained`() {
        val e = runCatching { ServerClient(server.url + "/admin/api/other/x").info() }.exceptionOrNull()
        assertTrue(e is SyncException)
    }

    @Test fun `a refused connection says where it tried`() {
        val dead = ServerClient("http://127.0.0.1:1")
        val e = runCatching { dead.info() }.exceptionOrNull() as SyncException
        assertTrue(e.message!!, e.message!!.contains("Không kết nối được tới http://127.0.0.1:1"))
    }

    @Test fun `a server error shows the server's own message`() {
        server.failNext = true
        val e = runCatching { client.info() }.exceptionOrNull() as SyncException
        assertTrue(e.message!!, e.message!!.contains("Internal error") || e.message!!.contains("500"))
    }

    @Test fun `push sends the admin header`() {
        val r = client.pushDatabases(listOf(NamedText("a.xml", xml(1))))
        assertEquals(1, r.saved)
    }
}

class WipeClientTest : SyncTestBase() {
    @Test fun `wipe sends the confirmation text and reports what was cleared`() {
        server.databases["a.xml"] = xml(1)
        day("2026-10-11", "a.xml" to xml(1))
        val r = client.wipe()
        assertEquals(1, server.wipes)
        assertTrue(server.databases.isEmpty() && server.backupDatabases.isEmpty())
        assertEquals(listOf("backups", "databases"), r.moved)
        assertTrue(r.keptIn, r.keptIn.startsWith("_wiped/"))
    }

    @Test fun `a server error is reported and nothing is counted as wiped`() {
        server.failNext = true
        val e = runCatching { client.wipe() }.exceptionOrNull() as SyncException
        assertTrue(e.message!!, e.message!!.contains("500"))
        assertEquals(0, server.wipes)
    }
}
