package vn.local.ftkeymapsync

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

private const val LIST = "list%7Ccom.vng.pubgmobile.json"
private const val MAP_A = "map%7Caaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.json"
private const val MAP_B = "map%7Cbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.json"

private val tablet = DeviceIdentity(
    id = "ftks-0123456789abcdef", name = "Máy tính bảng của tôi", model = "SM-X906B", android = "15", appVersion = "1.1.0", ip = "192.168.4.21",
)

class IdentityTest : SyncTestBase() {
    @Test fun `requests carry the device identity, the name percent-encoded`() {
        val c = ServerClient(server.url, identity = tablet)
        c.info(); c.push(listOf(NamedText(MAP_A, "{}"))); c.pull()
        assertEquals(3, server.requestHeaders.size)
        for (h in server.requestHeaders) {
            assertEquals("ftks-0123456789abcdef", h["x-device-id"])
            assertEquals("M%C3%A1y%20t%C3%ADnh%20b%E1%BA%A3ng%20c%E1%BB%A7a%20t%C3%B4i", h["x-device-name"])
        }
    }

    @Test fun `without an identity no device headers are sent`() {
        ServerClient(server.url).info()
        assertFalse(server.requestHeaders.single().containsKey("x-device-id"))
    }

    @Test fun `the heartbeat sends everything the web page shows`() {
        server.webSessions = 2
        val r = ServerClient(server.url, identity = tablet).hello(Heartbeat(autoPush = true, folder = "Documents/Gamwing/keymap_cache", state = "watching", error = ""))
        val body = server.hellos.single()
        assertEquals("ftks-0123456789abcdef", body.getString("id"))
        assertEquals("Máy tính bảng của tôi", body.getString("name"))
        assertEquals(listOf("SM-X906B", "15", "1.1.0", "192.168.4.21"), listOf("model", "android", "app_version", "ip").map { body.getString(it) })
        assertEquals(listOf(true, "Documents/Gamwing/keymap_cache", "watching", ""), listOf(body.getBoolean("auto_push"), body.getString("folder"), body.getString("state"), body.getString("error")))
        assertEquals(2, r.webSessions)
    }

    @Test fun `a heartbeat needs an identity`() {
        val e = runCatching { ServerClient(server.url).hello(Heartbeat(false, "", "idle", "")) }.exceptionOrNull()
        assertTrue(e is SyncException)
        assertTrue(server.hellos.isEmpty())
    }
}

class ConnectionTextTest : SyncTestBase() {
    @Test fun `info carries what the app shows about the web page and the backups`() {
        server.webSessions = 1
        val info = client.info()
        assertEquals(listOf(1, 1, 0), listOf(info.webSessions, info.devicesOnline, info.backupDays))
        assertEquals("Giao diện web: đang mở (1 phiên)", info.webLine())
        server.webSessions = 0
        assertEquals("Giao diện web: chưa có ai mở", client.info().webLine())
    }

    @Test fun `an older server without the new fields still works`() {
        val old = ServerInfo(server = "ft-keymap-server", version = "1.0.0", account = "c_x", accounts = 1, docs = 3)
        assertEquals(0, old.webSessions)
        assertEquals("Giao diện web: chưa có ai mở", old.webLine())
    }

    @Test fun `the heartbeat is due every 15 seconds`() {
        var now = 1_000_000L
        val t = HeartbeatTimer(15_000) { now }
        assertTrue("the first one is sent at once", t.due())
        assertFalse(t.due())
        now += 14_999
        assertFalse(t.due())
        now += 2
        assertTrue(t.due())
        assertFalse(t.due())
    }
}

class DailyBackupClientTest : SyncTestBase() {
    private fun day(date: String, vararg files: Pair<String, String>) {
        server.backupDays[date] = LinkedHashMap<String, String>().also { m -> files.forEach { m[it.first] = it.second } }
    }

    @Test fun `days are listed newest first and described for a human`() {
        day("2026-10-10", LIST to "{}", MAP_A to "{}")
        day("2026-10-11", LIST to "{}", MAP_A to "{}", MAP_B to "{}")
        val days = client.backups()
        assertEquals(listOf("2026-10-11", "2026-10-10"), days.map { it.date })
        assertEquals(listOf(3, 2), listOf(days[0].files, days[0].docs))
        assertTrue(days[0].describe(), days[0].describe().startsWith("2026-10-11 · 3 file"))
        assertTrue(days[0].describe(), days[0].describe().contains("Galaxy Tab"))
    }

    @Test fun `a day nobody has written to yet has no author and never shows the word null`() {
        day("2026-10-11", LIST to "{}")
        server.nullActorDay = "2026-10-11"
        val d = client.backups().single()
        assertNull(d.lastActor)
        assertFalse(d.describe(), d.describe().contains("null"))
        assertFalse(d.describe(), d.describe().contains("bởi"))
    }

    @Test fun `a chosen day is read as cache files`() {
        day("2026-10-10", MAP_A to """{"v":"old"}""")
        val files = client.backup("2026-10-10")
        assertEquals(listOf(MAP_A), files.map { it.name })
        assertEquals("""{"v":"old"}""", files.single().text)
    }

    @Test fun `an unknown day is explained, a malformed date never reaches the server`() {
        val e = runCatching { client.backup("2026-01-01") }.exceptionOrNull() as SyncException
        assertTrue(e.message!!, e.message!!.contains("404"))
        val before = server.requestHeaders.size
        for (bad in listOf("../etc", "2026-1-1", "latest", "")) assertTrue(runCatching { client.backup(bad) }.exceptionOrNull() is SyncException)
        assertEquals("no request was made", before, server.requestHeaders.size)
    }

    @Test fun `restoring a day uses the same plan and the same safe writing as a normal pull`() {
        put(MAP_A, """{"v":"today"}""")                    // differs from the chosen day
        put(MAP_B, """{"v":"same"}""")                      // same
        day("2026-10-10", MAP_A to """{"v":"old"}""", MAP_B to """{"v":"same"}""", LIST to """{"items":[]}""")
        val plan = engine.planPullDay("2026-10-10")
        val states = plan.items.associate { it.name to it.state }
        assertEquals(PullState.CHANGED, states[MAP_A])
        assertEquals(PullState.SAME, states[MAP_B])
        assertEquals(PullState.NEW, states[LIST])
        val result = engine.applyPull(plan)
        assertEquals(setOf(MAP_A, LIST), result.written.toSet())
        assertEquals("""{"v":"old"}""", text(MAP_A))
        assertEquals("""{"v":"today"}""", File(result.backupDir!!, MAP_A).readText())
    }

    @Test fun `unsafe names inside a backup day are refused`() {
        day("2026-10-10", "../evil.json" to "{}", MAP_A to "{}")
        val plan = engine.planPullDay("2026-10-10")
        assertEquals(listOf(MAP_A), plan.items.map { it.name })
        assertEquals(1, plan.rejected.size)
    }

    @Test fun `days known to the engine come from the client`() {
        day("2026-10-09", MAP_A to "{}")
        assertEquals(listOf("2026-10-09"), engine.listBackupDays().map { it.date })
        assertNull(engine.listBackupDays().firstOrNull { it.date == "2026-10-10" })
    }
}
