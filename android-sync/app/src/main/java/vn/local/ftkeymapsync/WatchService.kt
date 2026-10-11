package vn.local.ftkeymapsync

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Environment
import android.os.IBinder
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Foreground service that watches the cache folder and pushes changes to the server.
 * It polls every few seconds (cheap: about a dozen files) because change notifications for files that another
 * app writes on shared storage are not reliable on recent Android versions.
 * It also sends the heartbeat every 15 s, which is how the web page knows this phone is connected.
 */
class WatchService : Service() {
    @Volatile private var running = false
    private var worker: Thread? = null
    @Volatile private var lastClient: ServerClient? = null
    @Volatile private var lastFolder = ""

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        createChannel()
        val n = notification("Đang khởi động…")
        if (Build.VERSION.SDK_INT >= 34) startForeground(NOTIFICATION_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        else startForeground(NOTIFICATION_ID, n)
        if (worker == null) {
            running = true
            worker = Thread({ loop() }, "ftkeymapsync-watch").also { it.start() }
        }
        return START_STICKY
    }

    override fun onDestroy() {
        running = false
        worker?.interrupt()
        worker = null
        val client = lastClient
        if (client != null) {
            // tell the web page at once that the automatic push is off (best effort; it would notice after 40 s anyway)
            Thread { runCatching { client.hello(Heartbeat(false, lastFolder, "idle", "")) } }.start()
        }
        StatusBus.log("Đã tắt chế độ tự đẩy")
        super.onDestroy()
    }

    private fun loop() {
        val prefs = Prefs(this)
        var key = ""
        var watcher: Watcher? = null
        var client: ServerClient? = null
        var backoff = 0L
        var lastError = ""
        val beat = HeartbeatTimer(HEARTBEAT_MS)
        StatusBus.log("Bật chế độ tự đẩy khi thư mục có thay đổi")
        while (running) {
            var pause = POLL_MS
            try {
                val url = normalizeServerUrl(prefs.serverUrl)
                when {
                    url == null -> { update("Chưa nhập địa chỉ server"); pause = 10_000 }
                    !Environment.isExternalStorageManager() -> { update("Chưa cấp quyền truy cập mọi file"); pause = 10_000 }
                    else -> {
                        val folder = LocalFolder(resolveFolder(prefs.folderPath))
                        val dbFolder = if (prefs.databasesOn) LocalFolder(resolveFolder(prefs.databasesPath, DEFAULT_DATABASES)) else null
                        val newKey = "$url|${folder.dir.path}|${prefs.deviceName}|${dbFolder?.dir?.path}"
                        if (newKey != key) {
                            key = newKey
                            client = ServerClient(url, identity = identityOf(this, prefs))
                            lastClient = client
                            lastFolder = prefs.folderPath
                            watcher = Watcher(folder, SyncEngine(folder, client, backupRoot(), dbFolder = dbFolder), prefs, dbFolder, prefs)
                            update("Đang theo dõi ${folder.dir.path}" + (dbFolder?.let { " và ${it.dir.path}" } ?: "") + " → $url")
                        }
                        if (beat.due()) {
                            runCatching { client!!.hello(Heartbeat(true, prefs.folderPath, if (lastError.isEmpty()) "watching" else "error", lastError)) }
                        }
                        when (val ev = watcher!!.tick()) {
                            is WatchEvent.Pushed -> {
                                backoff = 0
                                lastError = ""
                                StatusBus.log("Tự đẩy lên server: ${ev.names.size} file đã đổi — ${ev.summary.describe()}")
                                update("Đã đẩy lúc ${now()} (${ev.names.size} file) → $url")
                            }
                            is WatchEvent.Failed -> {
                                backoff = (if (backoff == 0L) 5_000L else backoff * 2).coerceAtMost(60_000L)
                                lastError = ev.message
                                StatusBus.log("Tự đẩy thất bại, thử lại sau ${backoff / 1000}s: ${ev.message}")
                                update("Lỗi: ${ev.message}")
                                pause = backoff
                            }
                            else -> Unit
                        }
                        when (val ev = watcher!!.tickDatabases()) {
                            is DbWatchEvent.Pushed -> {
                                backoff = 0
                                lastError = ""
                                StatusBus.log("Tự đẩy cài đặt Gamwing: ${ev.names.size} file đã đổi — ${ev.summary.describe()}")
                                ev.summary.skipped.forEach { StatusBus.log("  bỏ qua $it") }
                            }
                            is DbWatchEvent.Failed -> {
                                backoff = (if (backoff == 0L) 5_000L else backoff * 2).coerceAtMost(60_000L)
                                lastError = ev.message
                                StatusBus.log("Tự đẩy cài đặt thất bại, thử lại sau ${backoff / 1000}s: ${ev.message}")
                                pause = maxOf(pause, backoff)
                            }
                            else -> Unit
                        }
                    }
                }
            } catch (e: InterruptedException) {
                break
            } catch (e: Exception) {
                StatusBus.log("Lỗi dịch vụ: ${e.message ?: e.javaClass.simpleName}")
                pause = 10_000
            }
            try { Thread.sleep(pause) } catch (e: InterruptedException) { break }
        }
    }

    private fun now() = SimpleDateFormat("HH:mm:ss", Locale.US).format(Date())

    private fun update(text: String) {
        getSystemService(NotificationManager::class.java).notify(NOTIFICATION_ID, notification(text))
    }

    private fun createChannel() {
        val nm = getSystemService(NotificationManager::class.java)
        if (nm.getNotificationChannel(CHANNEL_ID) == null) {
            nm.createNotificationChannel(NotificationChannel(CHANNEL_ID, "Đồng bộ keymap", NotificationManager.IMPORTANCE_LOW))
        }
    }

    private fun notification(text: String): Notification {
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        return Notification.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_launcher)
            .setContentTitle("KeyMap Sync: tự đẩy đang bật")
            .setContentText(text)
            .setStyle(Notification.BigTextStyle().bigText(text))
            .setOngoing(true)
            .setContentIntent(open)
            .build()
    }

    companion object {
        const val CHANNEL_ID = "ftkeymapsync_watch"
        const val NOTIFICATION_ID = 1
        const val POLL_MS = 3_000L
        const val HEARTBEAT_MS = 15_000L
    }
}
