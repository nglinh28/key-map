package vn.local.ftkeymapsync

import android.content.Context
import android.os.Build
import android.os.Environment
import android.os.Handler
import android.os.Looper
import org.json.JSONObject
import java.io.File
import java.net.Inet4Address
import java.net.NetworkInterface
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.UUID

const val DEFAULT_DATABASES = "Documents/jya2/databases"

/** Settings, plus the "what was last pushed" memory the watcher needs (so a restart does not push everything again). */
class Prefs(context: Context) : DbStateStore {
    private val sp = context.applicationContext.getSharedPreferences("ftkeymapsync", Context.MODE_PRIVATE)

    var serverUrl: String
        get() = sp.getString("server", "") ?: ""
        set(v) { sp.edit().putString("server", v).apply() }

    var autoPush: Boolean
        get() = sp.getBoolean("auto", false)
        set(v) { sp.edit().putBoolean("auto", v).apply() }

    /** Documents/jya2/databases: the Gamwing app's own preference files (the only thing this app backs up). */
    var databasesPath: String
        get() = sp.getString("databases", DEFAULT_DATABASES) ?: DEFAULT_DATABASES
        set(v) { sp.edit().putString("databases", v).apply() }

    override var lastPushedDb: Map<String, String>
        get() = runCatching {
            val j = JSONObject(sp.getString("lastPushedDb", "{}") ?: "{}")
            j.keys().asSequence().associateWith { j.getString(it) }
        }.getOrDefault(emptyMap())
        set(v) { sp.edit().putString("lastPushedDb", JSONObject(v).toString()).apply() }

    /** A random id made once; it is how the server and the web page recognise this phone. */
    val deviceId: String
        get() {
            sp.getString("deviceId", null)?.let { return it }
            val fresh = "ftks-" + UUID.randomUUID().toString().replace("-", "")
            sp.edit().putString("deviceId", fresh).apply()
            return fresh
        }

    /** The name shown on the web page; the phone's model unless the user typed another one. */
    var deviceName: String
        get() = sp.getString("deviceName", "")?.takeIf { it.isNotBlank() } ?: defaultDeviceName()
        set(v) { sp.edit().putString("deviceName", v.trim()).apply() }
}

/** "Documents/jya2/databases" is relative to the internal storage; a path starting with "/" is used as it is. */
fun resolveFolder(path: String, default: String = DEFAULT_DATABASES): File {
    val p = path.trim().ifEmpty { default }
    return if (p.startsWith("/")) File(p) else File(Environment.getExternalStorageDirectory(), p)
}

/** Files that a pull is about to overwrite are copied here first. */
fun backupRoot(): File = File(Environment.getExternalStorageDirectory(), "Documents/FTKeymapSync/backup")

/** A small in-process log shown on the main screen; the watcher service writes to it too. */
object StatusBus {
    private val main = Handler(Looper.getMainLooper())
    private val lines = ArrayDeque<String>()
    @Volatile var listener: ((String) -> Unit)? = null

    fun log(message: String) {
        val line = SimpleDateFormat("HH:mm:ss", Locale.US).format(Date()) + "  " + message
        synchronized(lines) {
            lines.addLast(line)
            while (lines.size > 300) lines.removeFirst()
        }
        main.post { listener?.invoke(line) }
    }

    fun history(): List<String> = synchronized(lines) { lines.toList() }
}

fun defaultDeviceName(): String = "${Build.MANUFACTURER.replaceFirstChar { it.uppercase() }} ${Build.MODEL}".trim()

/** The phone's address on the local network (what the web page shows), or "" when it has none. */
fun lanIp(): String = runCatching {
    NetworkInterface.getNetworkInterfaces().asSequence()
        .filter { it.isUp && !it.isLoopback }
        .flatMap { it.inetAddresses.asSequence() }
        .filterIsInstance<Inet4Address>()
        .firstOrNull { it.isSiteLocalAddress }
        ?.hostAddress
}.getOrNull().orEmpty()

fun identityOf(context: Context, prefs: Prefs): DeviceIdentity {
    val version = runCatching { context.packageManager.getPackageInfo(context.packageName, 0).versionName }.getOrNull().orEmpty()
    return DeviceIdentity(prefs.deviceId, prefs.deviceName, Build.MODEL, Build.VERSION.RELEASE, version, lanIp())
}
