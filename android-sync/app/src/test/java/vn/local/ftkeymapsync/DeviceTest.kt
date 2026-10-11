package vn.local.ftkeymapsync

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

private val tablet = DeviceIdentity(
    id = "ftks-0123456789abcdef", name = "Máy tính bảng của tôi", model = "SM-X906B", android = "15", appVersion = "2.0.0", ip = "192.168.4.21",
)

class IdentityTest : SyncTestBase() {
    @Test fun `requests carry the device identity, the name percent-encoded`() {
        val c = ServerClient(server.url, identity = tablet)
        c.info(); c.pushDatabases(listOf(NamedText("a.xml", xml(1)))); c.backups()
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
        val r = ServerClient(server.url, identity = tablet).hello(Heartbeat(autoPush = true, folder = "Documents/jya2/databases", state = "watching", error = ""))
        val body = server.hellos.single()
        assertEquals("ftks-0123456789abcdef", body.getString("id"))
        assertEquals("Máy tính bảng của tôi", body.getString("name"))
        assertEquals(listOf("SM-X906B", "15", "2.0.0", "192.168.4.21"), listOf("model", "android", "app_version", "ip").map { body.getString(it) })
        assertEquals(listOf(true, "Documents/jya2/databases", "watching", ""), listOf(body.getBoolean("auto_push"), body.getString("folder"), body.getString("state"), body.getString("error")))
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

    @Test fun `a server that does not report the web page reads as nobody`() {
        val old = ServerInfo(server = "ft-keymap-server", version = "1.0.0", files = 3)
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

class BackupDayTextTest : SyncTestBase() {
    @Test fun `a day nobody has written to yet has no author and never shows the word null`() {
        day("2026-10-11", "a.xml" to xml(1))
        server.nullActorDay = "2026-10-11"
        val d = client.backups().single()
        assertNull(d.lastActor)
        assertFalse(d.describe(), d.describe().contains("null"))
        assertFalse(d.describe(), d.describe().contains("bởi"))
    }

    @Test fun `a day with an author says who`() {
        day("2026-10-11", "a.xml" to xml(1))
        assertTrue(client.backups().single().describe().contains("bởi Galaxy Tab"))
    }
}
