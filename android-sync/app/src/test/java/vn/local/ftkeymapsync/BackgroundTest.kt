package vn.local.ftkeymapsync

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** The rules that decide whether the background service starts by itself, and what the heartbeat says about it. */
class BackgroundTest {
    @Test
    fun startsOnItsOwnOnlyWhenWantedAndAbleToWork() {
        assertTrue(shouldRunInBackground(keepAlive = true, serverUrl = "192.168.4.17:8787", hasAllFiles = true))
        assertTrue(shouldRunInBackground(keepAlive = true, serverUrl = "http://192.168.4.17:8787", hasAllFiles = true))
        // the user turned it off: never start it behind their back
        assertFalse(shouldRunInBackground(keepAlive = false, serverUrl = "192.168.4.17:8787", hasAllFiles = true))
        // it could not work yet: no address, an address that is not usable, or no permission to read the folder
        assertFalse(shouldRunInBackground(keepAlive = true, serverUrl = "", hasAllFiles = true))
        assertFalse(shouldRunInBackground(keepAlive = true, serverUrl = "192.168.17:8787", hasAllFiles = true))
        assertFalse(shouldRunInBackground(keepAlive = true, serverUrl = "192.168.4.17:8787", hasAllFiles = false))
    }

    @Test
    fun heartbeatSaysWhetherTheTabletOnlyListensOrAlsoPushes() {
        assertEquals("watching", heartbeatState(autoPush = true, lastError = ""))
        assertEquals("idle", heartbeatState(autoPush = false, lastError = ""))
        // an error wins over both, so the web page shows it
        assertEquals("error", heartbeatState(autoPush = true, lastError = "timeout"))
        assertEquals("error", heartbeatState(autoPush = false, lastError = "timeout"))
    }
}
