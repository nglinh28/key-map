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
