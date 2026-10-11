package vn.local.ftkeymapsync

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class DatabaseNamesTest {
    @Test fun `plain xml names are allowed, including spaces, accents and CJK`() {
        for (ok in listOf("PubgSettings.xml", "Cài đặt cơ bản.xml", "睙ubgSettings.xml", "ADBKey.xml", "com.facebook.ads.flash.xml", "gamwing_keymap_cache.xml", "A.XML")) {
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
    @Test fun `scan counts the files that may be backed up and names the ones that may not`() {
        put("PubgSettings.xml", xml(1)); put("Cài đặt cơ bản.xml", xml(2)); put("ADBKey.xml", xml(3))
        put("gamwing_entitlement.xml", xml(4)); put("notes.txt", "hi")
        val s = engine.scan()
        assertTrue(s.exists)
        assertEquals(3, s.files)
        assertEquals(listOf("gamwing_entitlement.xml"), s.excluded)
        assertTrue(s.describe(), s.describe().contains("3 file .xml"))
        assertTrue(s.describe(), s.describe().contains("gamwing_entitlement.xml"))
    }

    @Test fun `scan of a missing folder says so`() {
        val s = SyncEngine(LocalFolder(File(tmp.root, "nope")), client, backup).scan()
        assertFalse(s.exists)
        assertTrue(s.describe(), s.describe().contains("không tồn tại"))
    }

    @Test fun `push sends only backup-able files with their real names and a second push changes nothing`() {
        put("PubgSettings.xml", xml(1)); put("Cài đặt cơ bản.xml", xml(2)); put("ADBKey.xml", xml(3))
        put("gamwing_entitlement.xml", xml(4)); put("gamwing_ipc_session.xml", xml(5)); put("notes.txt", "hi")
        val first = engine.push()
        assertEquals(3, first.saved)
        assertEquals(setOf("PubgSettings.xml", "Cài đặt cơ bản.xml", "ADBKey.xml"), server.databases.keys)
        assertEquals(xml(2), server.databases["Cài đặt cơ bản.xml"])
        val second = engine.push()
        assertEquals(listOf(0, 3), listOf(second.saved, second.unchanged))
    }

    @Test fun `every push says which folder of the phone the files come from`() {
        put("a.xml", xml(1)); put("b.xml", xml(2))
        engine.push()
        engine.push(listOf("b.xml"))
        assertEquals(listOf(dir.path, dir.path), server.pushFolders)
        assertTrue(dir.path.endsWith("databases"))
    }

    @Test fun `the watcher also tells the folder`() {
        put("a.xml", xml(1))
        val w = Watcher(folder, engine, MemoryDbState())
        w.tick(); w.tick()
        assertEquals(listOf(dir.path), server.pushFolders)
    }

    @Test fun `push sends only the named files and ignores a license file even when named`() {
        put("a.xml", xml(1)); put("b.xml", xml(2)); put("gamwing_entitlement.xml", xml(3))
        engine.push(listOf("b.xml", "gamwing_entitlement.xml", "missing.xml"))
        assertEquals(listOf(listOf("b.xml")), server.databasePushes)
    }

    @Test fun `push splits big sets into several requests and a file bigger than a batch goes alone`() {
        put("a.xml", "x".repeat(60)); put("b.xml", "y".repeat(60)); put("c.xml", "z".repeat(60))
        val small = SyncEngine(folder, client, backup, maxBatchBytes = 100)
        small.push()
        assertEquals(3, server.databasePushes.size)
        assertEquals(setOf("a.xml", "b.xml", "c.xml"), server.databases.keys)
        server.databasePushes.clear()
        put("big.xml", "q".repeat(500))
        val tiny = SyncEngine(folder, client, backup, maxBatchBytes = 100)
        tiny.push(listOf("big.xml"))
        assertEquals(listOf(listOf("big.xml")), server.databasePushes)
    }

    @Test fun `backup days report how many files they hold`() {
        day("2026-10-11", "a.xml" to xml(1), "b.xml" to xml(2))
        day("2026-10-10", "a.xml" to xml(1))
        val days = client.backups()
        assertEquals(listOf("2026-10-11", "2026-10-10"), days.map { it.date })
        assertEquals(listOf(2, 1), days.map { it.databases })
        assertTrue(days[0].describe(), days[0].describe().startsWith("2026-10-11 · 2 file"))
    }

    @Test fun `restore plan marks new, changed and same files and never offers a refused name`() {
        put("same.xml", xml(1)); put("changed.xml", xml(2))
        day("2026-10-11",
            "same.xml" to xml(1), "changed.xml" to xml(9), "Cài đặt cơ bản.xml" to xml(3),
            "../evil.xml" to "x", "gamwing_entitlement.xml" to "x", "a/b.xml" to "x", "notes.txt" to "x")
        val plan = engine.planRestore("2026-10-11")
        assertEquals(listOf(1, 1, 1), listOf(plan.newCount, plan.changedCount, plan.sameCount))
        assertEquals(setOf("../evil.xml", "gamwing_entitlement.xml", "a/b.xml", "notes.txt"), plan.rejected.toSet())
        assertEquals(setOf("same.xml", "changed.xml", "Cài đặt cơ bản.xml"), plan.items.map { it.name }.toSet())
    }

    @Test fun `applying a restore copies old files first, writes new ones, leaves the rest alone`() {
        put("changed.xml", xml(2)); put("same.xml", xml(1)); put("untouched.xml", xml(7))
        val sameModified = File(dir, "same.xml").lastModified()
        day("2026-10-11", "changed.xml" to xml(9), "same.xml" to xml(1), "Cài đặt cơ bản.xml" to xml(3))
        val r = engine.applyRestore(engine.planRestore("2026-10-11"))
        assertEquals(setOf("changed.xml", "Cài đặt cơ bản.xml"), r.written.toSet())
        assertTrue(r.failed.isEmpty())
        assertEquals(xml(9), text("changed.xml"))
        assertEquals(xml(3), text("Cài đặt cơ bản.xml"))
        assertEquals(xml(7), text("untouched.xml"))
        assertEquals(sameModified, File(dir, "same.xml").lastModified())
        val saved = r.backupDir
        assertNotNull(saved)
        assertEquals("databases", saved!!.name)
        assertTrue(saved.absolutePath.startsWith(backup.absolutePath))
        assertEquals(xml(2), File(saved, "changed.xml").readText())
        assertFalse(File(saved, "same.xml").exists())
    }

    @Test fun `a restore with nothing overwritten makes no backup folder`() {
        day("2026-10-11", "new.xml" to xml(1))
        val r = engine.applyRestore(engine.planRestore("2026-10-11"))
        assertEquals(listOf("new.xml"), r.written)
        assertNull(r.backupDir)
    }

    @Test fun `a restore never writes a refused name even if a plan is built by hand`() {
        val plan = PullPlan(listOf(PullItem("gamwing_entitlement.xml", "x", PullState.NEW), PullItem("ok.xml", "y", PullState.NEW)), emptyList())
        val r = engine.applyRestore(plan)
        assertEquals(listOf("ok.xml"), r.written)
        assertFalse(File(dir, "gamwing_entitlement.xml").exists())
    }

    @Test fun `an unknown day is explained and a malformed date never reaches the server`() {
        val e = runCatching { client.databasesOfDay("2026-01-01") }.exceptionOrNull() as SyncException
        assertTrue(e.message!!, e.message!!.contains("404"))
        val before = server.requestHeaders.size
        for (bad in listOf("../etc", "2026-1-1", "latest", "")) assertTrue(runCatching { client.databasesOfDay(bad) }.exceptionOrNull() is SyncException)
        assertEquals("no request was made", before, server.requestHeaders.size)
    }
}
