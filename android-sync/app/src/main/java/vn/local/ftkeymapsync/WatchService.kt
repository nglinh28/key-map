package vn.local.ftkeymapsync

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.wifi.WifiManager
import android.os.Build
import android.os.Environment
import android.os.IBinder
import android.os.PowerManager
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * The background service. It keeps this tablet in touch with the server for as long as "Chạy ngầm" is on, also after the app was
 * swiped out of the recent apps and after the tablet restarted ([BootReceiver]):
 *  - every 15 s a heartbeat, which is how the web page knows the tablet is connected and how commands from the web page arrive
 *    (delete items of the cache file, check the sync); it always runs, whether or not the auto-push is on;
 *  - when the auto-push is on, it also polls the preference folder every few seconds (cheap: about two dozen files; change notifications
 *    for files another app writes on shared storage are not reliable on recent Android versions) and pushes what changed.
 * It holds a partial wake lock and a Wi-Fi lock so the polling does not stop when the screen is off.
 */
class WatchService : Service() {
    @Volatile private var running = false
    private var worker: Thread? = null
    @Volatile private var lastClient: ServerClient? = null
    @Volatile private var lastFolder = ""
    private var wakeLock: PowerManager.WakeLock? = null
    private var wifiLock: WifiManager.WifiLock? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            // the button of the notification: the user wants it off
            Prefs(this).keepAlive = false
            StatusBus.log("Đã tắt chạy ngầm (nút trên thông báo)")
            stopSelf()
            return START_NOT_STICKY
        }
        createChannel()
        val n = notification("Đang khởi động…")
        if (Build.VERSION.SDK_INT >= 34) startForeground(NOTIFICATION_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        else startForeground(NOTIFICATION_ID, n)
        acquireLocks()
        if (worker == null) {
            running = true
            worker = Thread({ loop() }, "ftkeymapsync-watch").also { it.start() }
        }
        return START_STICKY // if the system kills the process it starts the service again
    }

    /** The app was swiped out of the recent apps: the service is not tied to it and carries on. */
    override fun onTaskRemoved(rootIntent: Intent?) {
        StatusBus.log("Đã đóng app khỏi đa nhiệm, dịch vụ vẫn chạy ngầm")
        super.onTaskRemoved(rootIntent)
    }

    override fun onDestroy() {
        running = false
        worker?.interrupt()
        worker = null
        releaseLocks()
        val client = lastClient
        if (client != null) {
            // tell the web page at once that this tablet is gone (best effort; it would notice after 40 s anyway)
            Thread { runCatching { client.hello(Heartbeat(false, lastFolder, "idle", "")) } }.start()
        }
        StatusBus.log("Đã dừng dịch vụ chạy ngầm")
        super.onDestroy()
    }

    private fun acquireLocks() {
        if (wakeLock == null) {
            wakeLock = runCatching {
                getSystemService(PowerManager::class.java).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "ftkeymapsync:watch").apply { setReferenceCounted(false); acquire() }
            }.getOrNull()
        }
        if (wifiLock == null) {
            wifiLock = runCatching {
                val mode = if (Build.VERSION.SDK_INT >= 29) WifiManager.WIFI_MODE_FULL_LOW_LATENCY else WifiManager.WIFI_MODE_FULL
                (applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager).createWifiLock(mode, "ftkeymapsync:wifi").apply { setReferenceCounted(false); acquire() }
            }.getOrNull()
        }
    }

    private fun releaseLocks() {
        runCatching { wakeLock?.takeIf { it.isHeld }?.release() }
        runCatching { wifiLock?.takeIf { it.isHeld }?.release() }
        wakeLock = null
        wifiLock = null
    }

    private fun loop() {
        val prefs = Prefs(this)
        var key = ""
        var watcher: Watcher? = null
        var engine: SyncEngine? = null
        var client: ServerClient? = null
        var backoff = 0L
        var lastError = ""
        var shownMode = ""
        val beat = HeartbeatTimer(HEARTBEAT_MS)
        StatusBus.log("Đã bật chạy ngầm: giữ liên lạc với giao diện web${if (prefs.autoPush) " và tự đẩy khi thư mục thay đổi" else ""}")
        while (running) {
            var pause = POLL_MS
            try {
                val auto = prefs.autoPush
                val url = normalizeServerUrl(prefs.serverUrl)
                when {
                    url == null -> { update("Chưa nhập địa chỉ server"); pause = 10_000 }
                    !Environment.isExternalStorageManager() -> { update("Chưa cấp quyền truy cập mọi file"); pause = 10_000 }
                    else -> {
                        val folder = LocalFolder(resolveFolder(prefs.databasesPath))
                        val newKey = "$url|${folder.dir.path}|${prefs.deviceName}"
                        if (newKey != key) {
                            key = newKey
                            client = ServerClient(url, identity = identityOf(this, prefs))
                            lastClient = client
                            lastFolder = prefs.databasesPath
                            engine = SyncEngine(folder, client, backupRoot(), actions = prefs)
                            watcher = Watcher(folder, engine, prefs)
                            shownMode = ""
                        }
                        val mode = if (auto) "auto" else "listen"
                        if (mode != shownMode) {
                            shownMode = mode
                            update(if (auto) "Đang theo dõi ${folder.dir.path} → $url" else "Đang nhận lệnh từ giao diện web (tự đẩy tắt) → $url")
                        }
                        if (beat.due()) {
                            runCatching { client!!.hello(Heartbeat(auto, prefs.databasesPath, heartbeatState(auto, lastError), lastError)) }
                                .getOrNull()?.commands?.takeIf { it.isNotEmpty() }?.let { cmds ->
                                    // the web page asked something (delete items of the cache file, check the sync): do it before the next push
                                    engine!!.runCommands(cmds).forEach { StatusBus.log(it) }
                                }
                        }
                        if (auto) {
                            when (val ev = watcher!!.tick()) {
                                is WatchEvent.Pushed -> {
                                    backoff = 0
                                    lastError = ""
                                    StatusBus.log("Tự đẩy lên server: ${ev.names.size} file đã đổi — ${ev.summary.describe()}")
                                    ev.summary.skipped.forEach { StatusBus.log("  bỏ qua $it") }
                                    // the files just sent must be the same as the newest backup day on the server
                                    engine!!.checkAfterPush(ev.names).lines().forEach { StatusBus.log(it) }
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
                        } else {
                            pause = LISTEN_MS // only the heartbeat is due: no need to look at the folder every few seconds
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
            nm.createNotificationChannel(NotificationChannel(CHANNEL_ID, "Đồng bộ cài đặt Gamwing", NotificationManager.IMPORTANCE_LOW))
        }
    }

    private fun notification(text: String): Notification {
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val stop = PendingIntent.getService(this, 1, Intent(this, WatchService::class.java).setAction(ACTION_STOP), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        return Notification.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_launcher)
            .setContentTitle("KeyMap Sync đang chạy ngầm")
            .setContentText(text)
            .setStyle(Notification.BigTextStyle().bigText(text))
            .setOngoing(true)
            .setContentIntent(open)
            .addAction(Notification.Action.Builder(null, "Tắt chạy ngầm", stop).build())
            .build()
    }

    companion object {
        const val CHANNEL_ID = "ftkeymapsync_watch"
        const val NOTIFICATION_ID = 1
        const val ACTION_STOP = "vn.local.ftkeymapsync.STOP"
        const val POLL_MS = 3_000L
        const val LISTEN_MS = 5_000L
        const val HEARTBEAT_MS = 15_000L
    }
}
