package vn.local.ftkeymapsync

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Environment

/**
 * Starts the background service again when the tablet has restarted, and after this app was updated (an update stops the service).
 * Nothing is started when the user turned "Chạy ngầm" off, or when it could not work yet (no server address, no all-files permission).
 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED && intent.action != Intent.ACTION_MY_PACKAGE_REPLACED) return
        val prefs = Prefs(context)
        if (!shouldRunInBackground(prefs.keepAlive, prefs.serverUrl, Environment.isExternalStorageManager())) return
        try {
            context.startForegroundService(Intent(context, WatchService::class.java))
        } catch (e: Exception) {
            StatusBus.log("Không tự bật được chạy ngầm sau khi khởi động: ${e.message ?: e.javaClass.simpleName}")
        }
    }
}
