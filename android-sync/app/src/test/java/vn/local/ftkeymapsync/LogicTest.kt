package vn.local.ftkeymapsync

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class CacheNamesTest {
    @Test fun `list and map files are recognised by their percent-encoded bar`() {
        assertEquals(FileKind.LIST, CacheNames.kind("list%7Ccom.vng.pubgmobile.json"))
        assertEquals(FileKind.MAP, CacheNames.kind("map%7C14cbc4ec486541b5add77553b03b5544.json"))
        assertEquals(FileKind.OTHER, CacheNames.kind("raw%7Cx%7Cy.json"))
        assertEquals(FileKind.OTHER, CacheNames.kind("notes.txt"))
        assertEquals(FileKind.OTHER, CacheNames.kind("list|com.x.json")) // the phone never stores a literal bar
    }

    @Test fun `names coming from a server must be plain cache file names`() {
        assertTrue(CacheNames.isSafeServerName("list%7Ccom.zjx.pubg.rcConfig2.json"))
        assertTrue(CacheNames.isSafeServerName("map%7Ca83e86a5d225446abb635d68c940192a.json"))
        for (bad in listOf("../map%7Cx.json", "map%7C../x.json", "map%7Cx/y.json", "map%7Cx\\y.json", "other.json", "map%7C.json", "", "map%7Cx.json.exe", "/etc/passwd")) {
            assertFalse(bad, CacheNames.isSafeServerName(bad))
        }
    }
}

class ServerUrlTest {
    @Test fun `adds http and drops trailing slashes and paths`() {
        assertEquals("http://192.168.1.15:8787", normalizeServerUrl("192.168.1.15:8787"))
        assertEquals("http://192.168.1.15:8787", normalizeServerUrl("  http://192.168.1.15:8787/  "))
        assertEquals("http://nas.local:8787", normalizeServerUrl("http://nas.local:8787/admin"))
        assertEquals("https://keymap.example.com", normalizeServerUrl("https://keymap.example.com"))
        assertEquals("http://127.0.0.1:8788", normalizeServerUrl("127.0.0.1:8788"))
    }

    @Test fun `rejects things that are not addresses`() {
        for (bad in listOf("", "   ", "ftp://x", "http://", "http:// bad host", "://x")) assertNull(bad, normalizeServerUrl(bad))
    }
}

class JsonEqualsTest {
    @Test fun `objects equal regardless of key order and number spelling`() {
        assertTrue(sameJson("""{"a":1,"b":[1,2,{"c":true}]}""", """{"b":[1,2,{"c":true}],"a":1.0}"""))
        assertTrue(sameJson("""{"v":100}""", """{"v":100.0}"""))
    }

    @Test fun `different values or shapes are different`() {
        assertFalse(sameJson("""{"a":1}""", """{"a":2}"""))
        assertFalse(sameJson("""{"a":1}""", """{"a":1,"b":2}"""))
        assertFalse(sameJson("""[1,2]""", """[2,1]"""))
        assertFalse(sameJson("""{"a":"1"}""", """{"a":1}"""))
        assertFalse(sameJson("""{"a":null}""", """{"a":0}"""))
    }

    @Test fun `text that is not json falls back to exact comparison`() {
        assertTrue(sameJson("not json", "not json"))
        assertFalse(sameJson("not json", "other"))
        assertFalse(sameJson("{", """{"a":1}"""))
    }

    @Test fun `push summary reads like a sentence`() {
        val s = PushSummary(imported = 2, updated = 1, unchanged = 3, skipped = listOf("x: y"), snapshots = 1)
        assertEquals("mới 2, cập nhật 1 (bản cũ đã lưu trong lịch sử server), giữ nguyên 3, bỏ qua 1", s.describe())
        val j = JSONObject("""{"imported":[{"id":"a"}],"updated":[],"unchanged":4,"skipped":[{"id":"z","reason":"missing map file"},{"file":"f.json","reason":"invalid JSON"}],"snapshots":0}""")
        val p = PushSummary.fromJson(j)
        assertEquals(listOf(1, 0, 4, 2, 0), listOf(p.imported, p.updated, p.unchanged, p.skipped.size, p.snapshots))
        assertEquals("z: missing map file", p.skipped[0])
        assertEquals("f.json: invalid JSON", p.skipped[1])
    }
}
