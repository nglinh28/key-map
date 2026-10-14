package vn.local.ftkeymapsync

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/** "Khôi phục theo ngày" as one action: the databases are written, RCConfig is cleared (with a copy first), and a screen can follow the progress. */
class ApplyDayTest : SyncTestBase() {
    private fun rcDir() = RcConfig.dirFor(dir).also { it.mkdirs() }

    @Test fun `RCConfig sits next to the databases folder`() {
        assertEquals(File(tmp.root, "pubg_extension/RCConfig").path, RcConfig.dirFor(dir).path)
    }

    @Test fun `plan counts the files, also in sub folders, and a missing folder is an empty plan`() {
        assertFalse(RcConfig.plan(RcConfig.dirFor(dir)).exists)
        val rc = rcDir()
        File(rc, "a.json").writeText("12345")
        File(rc, "sub").mkdirs(); File(rc, "sub/b.json").writeText("123")
        val plan = RcConfig.plan(rc)
        assertTrue(plan.exists)
        assertEquals(2, plan.count)
        assertEquals(8L, plan.bytes)
    }

    @Test fun `clear copies every file away first, deletes only files and keeps the folders`() {
        val rc = rcDir()
        File(rc, "a.json").writeText("A")
        File(rc, "sub").mkdirs(); File(rc, "sub/b.json").writeText("B")
        val seen = mutableListOf<String>()
        val r = RcConfig.clear(rc, { engine.newBackupDir() }) { i, n, name -> seen += "$i/$n $name" }
        assertEquals(2, r.deleted)
        assertTrue(r.failed.isEmpty())
        assertEquals(listOf("1/2 a.json", "2/2 sub${File.separator}b.json"), seen)
        assertTrue(rc.isDirectory && File(rc, "sub").isDirectory)
        assertTrue(RcConfig.files(rc).isEmpty())
        val copy = r.backupDir!!
        assertEquals("RCConfig", copy.name)
        assertEquals("A", File(copy, "a.json").readText())
        assertEquals("B", File(copy, "sub/b.json").readText())
    }

    @Test fun `clear of an empty or missing folder does nothing and makes no backup folder`() {
        var asked = 0
        val r = RcConfig.clear(RcConfig.dirFor(dir), { asked++; engine.newBackupDir() })
        assertEquals(RcResult(0, emptyList(), null), r)
        assertEquals(0, asked)
        assertFalse(backup.exists())
    }

    @Test fun `restoring reports each file it writes, and the same files are left alone`() {
        put("same.xml", xml(1)); put("old.xml", xml(1))
        day("2026-10-14", "same.xml" to xml(1), "old.xml" to xml(2), "new.xml" to xml(3))
        val plan = engine.planRestore("2026-10-14")
        assertEquals(listOf(1, 1, 1), listOf(plan.newCount, plan.changedCount, plan.sameCount))
        val seen = mutableListOf<String>()
        val r = engine.applyRestore(plan) { i, n, name -> seen += "$i/$n $name" }
        assertEquals(listOf("1/2 old.xml", "2/2 new.xml"), seen)
        assertEquals(listOf("old.xml", "new.xml"), r.written)
        assertEquals(xml(2), text("old.xml"))
        assertEquals(xml(1), File(r.backupDir, "old.xml").readText()) // the old copy went to <backup>/<time>/databases first
    }

    @Test fun `the summary says what was written, deleted and where the copies are`() {
        val rc = rcDir(); File(rc, "a.json").writeText("A")
        day("2026-10-14", "new.xml" to xml(3))
        val restore = engine.applyRestore(engine.planRestore("2026-10-14"))
        val cleared = RcConfig.clear(rc, { engine.newBackupDir() })
        val result = ApplyDayResult(restore, cleared, stoppedGamwing = true)
        assertTrue(result.ok)
        val text = result.lines("2026-10-14").joinToString("\n")
        assertTrue(text, text.contains("đã ghi 1 file từ bản sao lưu ngày 2026-10-14"))
        assertTrue(text, text.contains("RCConfig: đã xóa 1 file"))
        assertTrue(text, text.contains("Gamwing: đã yêu cầu dừng"))
    }
}
