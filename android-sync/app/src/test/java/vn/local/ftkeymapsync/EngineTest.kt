package vn.local.ftkeymapsync

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

private const val LIST = "list%7Ccom.vng.pubgmobile.json"
private const val MAP_A = "map%7Caaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.json"
private const val MAP_B = "map%7Cbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.json"

class MemoryState : StateStore {
    override var lastPushed: Map<String, String> = emptyMap()
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
        dir = tmp.newFolder("keymap_cache")
        backup = File(tmp.root, "backup")
        folder = LocalFolder(dir)
        client = ServerClient(server.url)
        engine = SyncEngine(folder, client, backup, maxBatchBytes = 6_000_000, clock = { time })
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
}

class EngineTest : SyncTestBase() {
    @Test fun `scan counts list, map and other files`() {
        put(LIST, """{"items":[]}"""); put(MAP_A, "{}"); put(MAP_B, "{}"); put("raw%7Cx%7Cy.json", "{}"); put("notes.txt", "hi")
        val s = engine.scan()
        assertEquals(listOf(1, 2, 2), listOf(s.lists, s.maps, s.others))
        assertTrue(s.describe().contains("1 danh mục"))
        assertTrue(s.describe().contains("2 keymap"))
    }

    @Test fun `scan of a missing folder says so instead of crashing`() {
        val e = SyncEngine(LocalFolder(File(tmp.root, "nope")), client, backup)
        val s = e.scan()
        assertFalse(s.exists)
        assertTrue(s.describe().contains("không tồn tại"))
    }

    @Test fun `pushAll sends only list and map files and a second push changes nothing`() {
        put(LIST, """{"selected":"a","items":[]}"""); put(MAP_A, """{"k":1}"""); put("raw%7Cx%7Cy.json", "{}"); put("notes.txt", "hi")
        val r1 = engine.pushAll()
        assertEquals(listOf(MAP_A, LIST).sorted(), server.pushes.single().sorted())
        assertEquals(2, r1.imported)
        val r2 = engine.pushAll()
        assertEquals(listOf(0, 0, 2), listOf(r2.imported, r2.updated, r2.unchanged))
    }

    @Test fun `push of selected names also carries every list file`() {
        put(LIST, "{}"); put(MAP_A, "{}"); put(MAP_B, "{}")
        engine.pushAll(); server.pushes.clear()
        put(MAP_B, """{"changed":true}""")
        val r = engine.push(listOf(MAP_B))
        assertEquals(setOf(MAP_B, LIST), server.pushes.single().toSet())
        assertEquals(1, r.updated)
    }

    @Test fun `big pushes are split into batches and the results are added up`() {
        put(LIST, "{}"); put(MAP_A, "x".repeat(300)); put(MAP_B, "y".repeat(300))
        val small = SyncEngine(folder, client, backup, maxBatchBytes = 400)
        val r = small.pushAll()
        assertTrue("expected several requests, got ${server.pushes.size}", server.pushes.size >= 2)
        assertEquals(3, r.imported)
        assertEquals(3, server.files.size)
    }

    @Test fun `pull plan tells new, changed and same files apart ignoring key order`() {
        put(MAP_A, """{"b":2,"a":1}""")                       // same as the server, other key order
        put(MAP_B, """{"v":"old"}""")                         // differs
        server.files[MAP_A] = """{"a":1,"b":2.0}"""
        server.files[MAP_B] = """{"v":"new"}"""
        server.files[LIST] = """{"items":[]}"""               // not on the phone
        val plan = engine.planPull()
        val byName = plan.items.associate { it.name to it.state }
        assertEquals(PullState.SAME, byName[MAP_A])
        assertEquals(PullState.CHANGED, byName[MAP_B])
        assertEquals(PullState.NEW, byName[LIST])
        assertEquals(listOf(1, 1, 1), listOf(plan.newCount, plan.changedCount, plan.sameCount))
    }

    @Test fun `applyPull backs up files it overwrites, leaves identical ones alone and never deletes`() {
        put(MAP_A, """{"a":1}""")                              // same
        put(MAP_B, """{"v":"old"}""")                          // will be overwritten
        put("extra%7Cmine.json", "keep me")                    // not on the server: must survive
        val sameBefore = File(dir, MAP_A).lastModified()
        server.files[MAP_A] = """{"a":1}"""
        server.files[MAP_B] = """{"v":"new"}"""
        server.files[LIST] = """{"items":[]}"""
        val result = engine.applyPull(engine.planPull())
        assertEquals(setOf(MAP_B, LIST), result.written.toSet())
        assertTrue(result.failed.isEmpty())
        assertEquals("""{"v":"new"}""", text(MAP_B))
        assertEquals("""{"items":[]}""", text(LIST))
        assertEquals(sameBefore, File(dir, MAP_A).lastModified())
        assertEquals("keep me", text("extra%7Cmine.json"))
        val b = assertNotNull(result.backupDir).let { result.backupDir!! }
        assertEquals("""{"v":"old"}""", File(b, MAP_B).readText())
        assertFalse("identical files are not backed up", File(b, MAP_A).exists())
        assertTrue(b.absolutePath.startsWith(backup.absolutePath))
    }

    @Test fun `applyPull refuses unsafe names coming from the server`() {
        server.files["../evil.json"] = "{}"
        server.files["map%7Cx/y.json"] = "{}"
        server.files[MAP_A] = "{}"
        val plan = engine.planPull()
        assertEquals(listOf(MAP_A), plan.items.map { it.name })
        assertEquals(2, plan.rejected.size)
        engine.applyPull(plan)
        assertFalse(File(tmp.root, "evil.json").exists())
    }

    @Test fun `pull does not create a backup folder when nothing is overwritten`() {
        server.files[MAP_A] = "{}"
        val r = engine.applyPull(engine.planPull())
        assertEquals(listOf(MAP_A), r.written)
        assertEquals(null, r.backupDir)
    }
}

class WatcherTest : SyncTestBase() {
    private fun watcher(state: StateStore = MemoryState()) = Watcher(folder, engine, state)

    @Test fun `new files are pushed only after they stay unchanged for two checks`() {
        put(LIST, "{}"); put(MAP_A, "{}")
        val w = watcher()
        assertTrue(w.tick() is WatchEvent.Waiting)
        assertTrue(server.pushes.isEmpty())
        val e = w.tick()
        assertTrue(e is WatchEvent.Pushed)
        assertEquals(2, server.files.size)
        assertTrue(w.tick() is WatchEvent.Idle)
    }

    @Test fun `only the changed map is pushed (plus the lists)`() {
        put(LIST, "{}"); put(MAP_A, "{}"); put(MAP_B, "{}")
        val w = watcher()
        w.tick(); w.tick(); server.pushes.clear()
        put(MAP_B, """{"edited":1}""")
        assertTrue(w.tick() is WatchEvent.Waiting)
        val e = w.tick() as WatchEvent.Pushed
        assertEquals(setOf(MAP_B, LIST), server.pushes.single().toSet())
        assertEquals(setOf(MAP_B), e.names.toSet())
        assertEquals("""{"edited":1}""", server.files[MAP_B])
    }

    @Test fun `a file that keeps changing is not pushed until it settles`() {
        put(MAP_A, "{}")
        val w = watcher()
        assertTrue(w.tick() is WatchEvent.Waiting)
        put(MAP_A, """{"still":"writing"}""")
        assertTrue(w.tick() is WatchEvent.Waiting)
        assertTrue(server.pushes.isEmpty())
        assertTrue(w.tick() is WatchEvent.Pushed)
    }

    @Test fun `a failed push is retried and the state is not advanced`() {
        put(MAP_A, "{}")
        val state = MemoryState()
        val w = watcher(state)
        w.tick()
        server.failNext = true
        val f = w.tick()
        assertTrue(f is WatchEvent.Failed)
        assertTrue(state.lastPushed.isEmpty())
        w.tick() // waiting again after the failure
        assertTrue(w.tick() is WatchEvent.Pushed)
        assertEquals(1, state.lastPushed.size)
    }

    @Test fun `other files and removed files are ignored`() {
        put(LIST, "{}"); put("raw%7Cx%7Cy.json", "{}")
        val w = watcher()
        w.tick(); w.tick()
        assertEquals(listOf(LIST), server.files.keys.toList())
        File(dir, LIST).delete()
        assertTrue(w.tick() is WatchEvent.Idle)
        assertEquals("the server keeps what it has", listOf(LIST), server.files.keys.toList())
    }

    @Test fun `state survives a restart`() {
        put(LIST, "{}"); put(MAP_A, "{}")
        val state = MemoryState()
        val first = watcher(state); first.tick(); first.tick()
        server.pushes.clear()
        val second = watcher(state) // a new service instance with the saved state
        assertTrue(second.tick() is WatchEvent.Idle)
        assertTrue(server.pushes.isEmpty())
    }
}

class ServerClientTest : SyncTestBase() {
    @Test fun `info is parsed`() {
        val info = client.info()
        assertEquals(listOf("ft-keymap-server", "1.1.0", 2), listOf(info.server, info.version, info.accounts))
        assertEquals("Đã kết nối tới ${server.url} (server keymap, 2 tài khoản)", info.describe(server.url))
    }

    @Test fun `an address that is not a keymap server is explained`() {
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
        val r = client.push(listOf(NamedText(MAP_A, "{}")))
        assertEquals(1, r.imported)
    }
}
