package vn.local.ftkeymapsync

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

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

class ServerUrlProblemTest {
    @Test fun `good addresses have no problem`() {
        for (ok in listOf("192.168.4.17:8787", "http://192.168.4.17:8787", " https://keymap.example.com ", "nas.local:8787", "localhost", "http://10.0.2.2:8787/admin", "127.0.0.1")) {
            assertNull(ok, serverUrlProblem(ok))
            assertEquals(true, normalizeServerUrl(ok) != null)
        }
    }

    @Test fun `an empty address is explained`() {
        for (empty in listOf("", "   ")) assertEquals("Chưa nhập địa chỉ server.", serverUrlProblem(empty))
    }

    @Test fun `an IP with the wrong number of parts says what is wrong and shows what was typed`() {
        val p = serverUrlProblem("192.168.17:8787")!!
        assertEquals(true, p.contains("192.168.17") && p.contains("4 số") && p.contains("192.168.4.17"))
        assertNull("it must not be accepted either", normalizeServerUrl("http://192.168.17:8787"))
        assertEquals(true, serverUrlProblem("192.168.4.17.5")!!.contains("4 số"))
        assertEquals(true, serverUrlProblem("192.168..17")!!.contains("4 số"))
    }

    @Test fun `an IP part above 255 is explained`() {
        assertEquals(true, serverUrlProblem("192.168.4.300:8787")!!.contains("0 đến 255"))
    }

    @Test fun `a wrong scheme or a missing host or a bad port is explained`() {
        assertEquals(true, serverUrlProblem("ftp://192.168.4.17")!!.contains("http"))
        assertEquals(true, serverUrlProblem("http://")!!.contains("Thiếu"))
        assertEquals(true, serverUrlProblem(":8787")!!.contains("Thiếu"))
        assertEquals(true, serverUrlProblem("192.168.4.17:abc")!!.contains("Cổng"))
        assertEquals(true, serverUrlProblem("192.168.4.17:70000")!!.contains("Cổng"))
        assertEquals(true, serverUrlProblem("http:// bad host")!!.isNotBlank())
    }

    @Test fun `normalizing still gives the same clean address`() {
        assertEquals("http://192.168.4.17:8787", normalizeServerUrl("192.168.4.17:8787/"))
        assertEquals("https://keymap.example.com", normalizeServerUrl("https://keymap.example.com/x"))
    }
}
