package vn.local.ftkeymapsync

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.File

private fun xml(v: Int) = "<?xml version='1.0' encoding='utf-8' standalone='yes' ?>\n<map>\n    <int name=\"x\" value=\"$v\" />\n</map>\n"

class MemoryDbState : DbStateStore {
    override var lastPushedDb: Map<String, String> = emptyMap()
}

class DatabaseNamesTest {
    @Test fun `plain xml names are allowed, including spaces, accents and CJK`() {
        for (ok in listOf("PubgSettings.xml", "Cài đặt cơ bản.xml", "睙ubgSettings.xml", "ADBKey.xml", "com.facebook.ads.flash.xml", "A.XML")) {
            assertNull(ok, DatabaseNames.problem(ok))
        }
    }

    @Test fun `unsafe names, other extensions and license or session files are refused`() {
        val bad = listOf(
            "", "a.txt", "../x.xml", "a/b.xml", "a\\b.xml", ".hidden.xml", ".", "..", "a\u0000.xml", "x".repeat(130) + ".xml",
            "gamwing_entitlement.xml", "gamwing_ipc_session.xml", "License.xml", "ipc-session.xml", "IPCSESSION.xml",
        )
        for (name in bad) assertFalse("'$name' must be refused", DatabaseNames.isBackupName(name))
    }
}

class DatabaseEngineTest : SyncTestBase() {
    private lateinit var dbDir: File
    private lateinit var dbFolder: LocalFolder
    private lateinit var db: SyncEngine
    private var t = 1_700_000_100_000L

    @Before fun dbSetUp() {
        dbDir = tmp.newFolder("databases")
        dbFolder = LocalFolder(dbDir)
        db = SyncEngine(folder, client, backup, clock = { 1_700_000_000_000L }, dbFolder = dbFolder)
    }

    private fun putDb(name: String, text: String) {
        val f = File(dbDir, name)
        f.writeText(text)
        t += 5_000
        f.setLastModified(t)
    }

    private fun dbText(name: String) = File(dbDir, name).readText()

    @Test fun `scan counts the files that may be backed up and names the ones that may not`() {
        putDb("PubgSettings.xml", xml(1)); putDb("Cài đặt cơ bản.xml", xml(2)); putDb("ADBKey.xml", xml(3))
        putDb("gamwing_entitlement.xml", xml(4)); putDb("notes.txt", "hi")
        val s = db.scanDatabases()
        assertTrue(s.exists)
        assertEquals(3, s.files)
        assertEquals(listOf("gamwing_entitlement.xml"), s.excluded)
        assertTrue(s.describe(), s.describe().contains("3 file .xml"))
        assertTrue(s.describe(), s.describe().contains("gamwing_entitlement.xml"))
    }

    @Test fun `scan of a missing or switched-off folder says so`() {
        assertFalse(SyncEngine(folder, client, backup, dbFolder = LocalFolder(File(tmp.root, "nope"))).scanDatabases().exists)
        val off = SyncEngine(folder, client, backup).scanDatabases()
        assertFalse(off.exists)
        assertTrue(off.describe(), off.describe().contains("không tồn tại"))
    }

    @Test fun `push sends only backup-able files with their real names and a second push changes nothing`() {
        putDb("PubgSettings.xml", xml(1)); putDb("Cài đặt cơ bản.xml", xml(2)); putDb("ADBKey.xml", xml(3))
        putDb("gamwing_entitlement.xml", xml(4)); putDb("gamwing_ipc_session.xml", xml(5)); putDb("notes.txt", "hi")
        val first = db.pushDatabases()
        assertEquals(3, first.saved)
        assertEquals(setOf("PubgSettings.xml", "Cài đặt cơ bản.xml", "ADBKey.xml"), server.databases.keys)
        assertEquals(xml(2), server.databases["Cài đặt cơ bản.xml"])
        val second = db.pushDatabases()
        assertEquals(listOf(0, 3), listOf(second.saved, second.unchanged))
    }

    @Test fun `push sends only the named files and ignores a license file even when named`() {
        putDb("a.xml", xml(1)); putDb("b.xml", xml(2)); putDb("gamwing_entitlement.xml", xml(3))
        db.pushDatabases(listOf("b.xml", "gamwing_entitlement.xml", "missing.xml"))
        assertEquals(listOf(listOf("b.xml")), server.databasePushes)
    }

    @Test fun `push splits big sets into several requests`() {
        putDb("a.xml", "x".repeat(60)); putDb("b.xml", "y".repeat(60)); putDb("c.xml", "z".repeat(60))
        val small = SyncEngine(folder, client, backup, maxBatchBytes = 100, dbFolder = dbFolder)
        small.pushDatabases()
        assertEquals(3, server.databasePushes.size)
        assertEquals(setOf("a.xml", "b.xml", "c.xml"), server.databases.keys)
    }

    @Test fun `push with the backup switched off sends nothing`() {
        putDb("a.xml", xml(1))
        val off = SyncEngine(folder, client, backup)
        assertEquals(DatabasePushSummary.EMPTY, off.pushDatabases())
        assertTrue(server.databasePushes.isEmpty())
    }

    @Test fun `backup days report how many preference files they hold`() {
        server.backupDays["2026-10-11"] = LinkedHashMap<String, String>().also { it[MAPFILE] = "{}" }
        server.backupDatabases["2026-10-11"] = LinkedHashMap<String, String>().also { it["a.xml"] = xml(1); it["b.xml"] = xml(2) }
        server.backupDays["2026-10-10"] = LinkedHashMap<String, String>().also { it[MAPFILE] = "{}" }
        val days = client.backups()
        assertEquals(listOf(2, 0), days.map { it.databases })
        assertTrue(days[0].describe(), days[0].describe().contains("2 file cài đặt"))
        assertFalse(days[1].describe(), days[1].describe().contains("file cài đặt"))
    }

    @Test fun `restore plan marks new, changed and same files and never offers a refused name`() {
        putDb("same.xml", xml(1)); putDb("changed.xml", xml(2))
        server.backupDays["2026-10-11"] = LinkedHashMap()
        server.backupDatabases["2026-10-11"] = LinkedHashMap<String, String>().also {
            it["same.xml"] = xml(1); it["changed.xml"] = xml(9); it["Cài đặt cơ bản.xml"] = xml(3)
            it["../evil.xml"] = "x"; it["gamwing_entitlement.xml"] = "x"; it["a/b.xml"] = "x"; it["notes.txt"] = "x"
        }
        val plan = db.planRestoreDatabases("2026-10-11")
        assertEquals(listOf(1, 1, 1), listOf(plan.newCount, plan.changedCount, plan.sameCount))
        assertEquals(setOf("../evil.xml", "gamwing_entitlement.xml", "a/b.xml", "notes.txt"), plan.rejected.toSet())
        assertEquals(setOf("same.xml", "changed.xml", "Cài đặt cơ bản.xml"), plan.items.map { it.name }.toSet())
    }

    @Test fun `applying a restore copies old files first, writes new ones, leaves the rest alone`() {
        putDb("changed.xml", xml(2)); putDb("same.xml", xml(1)); putDb("untouched.xml", xml(7))
        val sameModified = File(dbDir, "same.xml").lastModified()
        server.backupDays["2026-10-11"] = LinkedHashMap()
        server.backupDatabases["2026-10-11"] = LinkedHashMap<String, String>().also { it["changed.xml"] = xml(9); it["same.xml"] = xml(1); it["Cài đặt cơ bản.xml"] = xml(3) }
        val r = db.applyRestoreDatabases(db.planRestoreDatabases("2026-10-11"))
        assertEquals(setOf("changed.xml", "Cài đặt cơ bản.xml"), r.written.toSet())
        assertTrue(r.failed.isEmpty())
        assertEquals(xml(9), dbText("changed.xml"))
        assertEquals(xml(3), dbText("Cài đặt cơ bản.xml"))
        assertEquals(xml(7), dbText("untouched.xml"))
        assertEquals(sameModified, File(dbDir, "same.xml").lastModified())
        val saved = r.backupDir
        assertNotNull(saved)
        assertEquals("databases", saved!!.name)
        assertEquals(xml(2), File(saved, "changed.xml").readText())
        assertFalse(File(saved, "same.xml").exists())
    }

    @Test fun `a restore never writes a refused name even if a plan is built by hand`() {
        val plan = PullPlan(listOf(PullItem("gamwing_entitlement.xml", "x", PullState.NEW), PullItem("ok.xml", "y", PullState.NEW)), emptyList())
        val r = db.applyRestoreDatabases(plan)
        assertEquals(listOf("ok.xml"), r.written)
        assertFalse(File(dbDir, "gamwing_entitlement.xml").exists())
    }

    @Test fun `restore with the backup switched off fails with a clear message and writes nothing`() {
        val off = SyncEngine(folder, client, backup)
        val e = runCatching { off.planRestoreDatabases("2026-10-11") }.exceptionOrNull() as SyncException
        assertTrue(e.message!!, e.message!!.contains("Chưa bật"))
        assertTrue(runCatching { off.applyRestoreDatabases(PullPlan(emptyList(), emptyList())) }.exceptionOrNull() is SyncException)
    }

    private fun watcher(state: MemoryDbState = MemoryDbState()) = Watcher(folder, db, MemoryState(), dbFolder, state) to state

    @Test fun `watcher waits for two equal looks, pushes once, then stays quiet`() {
        val (w, state) = watcher()
        assertTrue(w.tickDatabases() is DbWatchEvent.Idle)
        putDb("a.xml", xml(1)); putDb("gamwing_entitlement.xml", xml(2))
        assertTrue(w.tickDatabases() is DbWatchEvent.Waiting)
        val ev = w.tickDatabases()
        assertTrue(ev.toString(), ev is DbWatchEvent.Pushed)
        assertEquals(listOf("a.xml"), (ev as DbWatchEvent.Pushed).names)
        assertEquals(setOf("a.xml"), server.databases.keys)
        assertEquals(setOf("a.xml"), state.lastPushedDb.keys)
        assertTrue(w.tickDatabases() is DbWatchEvent.Idle)
        putDb("a.xml", xml(5))
        assertTrue(w.tickDatabases() is DbWatchEvent.Waiting)
        assertTrue(w.tickDatabases() is DbWatchEvent.Pushed)
        assertEquals(xml(5), server.databases["a.xml"])
    }

    @Test fun `watcher keeps trying after a server error and a half-written file is not sent`() {
        val (w, _) = watcher()
        putDb("a.xml", xml(1))
        w.tickDatabases()
        server.failNext = true
        val failed = w.tickDatabases()
        assertTrue(failed.toString(), failed is DbWatchEvent.Failed)
        assertTrue(w.tickDatabases() is DbWatchEvent.Waiting) // starts again from scratch
        assertTrue(w.tickDatabases() is DbWatchEvent.Pushed)
        assertEquals(setOf("a.xml"), server.databases.keys)
        // a file changing between two looks is not sent until it settles
        putDb("b.xml", xml(1)); w.tickDatabases()
        putDb("b.xml", xml(2))
        assertTrue(w.tickDatabases() is DbWatchEvent.Waiting)
        assertFalse(server.databases.containsKey("b.xml"))
    }

    @Test fun `watcher without a preference folder or with a missing one does nothing`() {
        val none = Watcher(folder, engine, MemoryState())
        assertTrue(none.tickDatabases() is DbWatchEvent.Idle)
        val gone = Watcher(folder, db, MemoryState(), LocalFolder(File(tmp.root, "nope")), MemoryDbState())
        assertTrue(gone.tickDatabases() is DbWatchEvent.Idle)
    }

    companion object {
        private const val MAPFILE = "map%7Caaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.json"
    }
}

class WipeClientTest : SyncTestBase() {
    @Test fun `wipe sends the confirmation text and reports what was cleared`() {
        server.files["x"] = "1"
        server.databases["a.xml"] = xml(1)
        val r = client.wipe()
        assertEquals(1, server.wipes)
        assertTrue(server.files.isEmpty() && server.databases.isEmpty())
        assertEquals(listOf("accounts", "backups"), r.moved)
        assertTrue(r.keptIn, r.keptIn.startsWith("_wiped/"))
    }

    @Test fun `a server error is reported and nothing is counted as wiped`() {
        server.failNext = true
        val e = runCatching { client.wipe() }.exceptionOrNull() as SyncException
        assertTrue(e.message!!, e.message!!.contains("500"))
        assertEquals(0, server.wipes)
    }
}
