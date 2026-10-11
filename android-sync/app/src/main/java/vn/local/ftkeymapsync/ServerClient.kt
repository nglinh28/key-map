package vn.local.ftkeymapsync

import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder

// a backup day as the server names it, e.g. 2026-10-11 (matches() needs the whole text to fit)
private val DAY = Regex("""\d{4}-\d{2}-\d{2}""")

/** A string field, or null when it is missing, blank or JSON null (Android's optString turns JSON null into the text "null"). */
private fun JSONObject.textOrNull(key: String): String? = if (isNull(key)) null else optString(key).ifBlank { null }

/**
 * Talks to the backup server's sync endpoints. The server has no login (it is meant for a trusted LAN);
 * the X-Admin-Request header is what its browser-protection expects on writes.
 */
class ServerClient(
    baseUrl: String,
    private val connectTimeoutMs: Int = 5_000,
    private val readTimeoutMs: Int = 60_000,
    private val identity: DeviceIdentity? = null,
) {
    private val base = baseUrl.trimEnd('/')

    fun info(): ServerInfo {
        val j = request("GET", "/admin/api/sync/info", null)
        if (!j.optBoolean("ok") || j.optString("server") != "ft-keymap-server") {
            throw SyncException("Địa chỉ này không phải server sao lưu (ft-keymap-server).")
        }
        return ServerInfo(
            server = j.optString("server"), version = j.optString("version"), files = j.optInt("files", j.optInt("docs")),
            webSessions = j.optJSONObject("web")?.optInt("sessions") ?: 0,
            devicesOnline = j.optInt("devices_online"), backupDays = j.optInt("backup_days"),
        )
    }

    /** Heartbeat: tells the server (and so the web page) that this phone is connected, and learns whether the web page is open. */
    fun hello(h: Heartbeat): HelloResult {
        val me = identity ?: throw SyncException("Chưa có định danh thiết bị.")
        val body = JSONObject()
            .put("id", me.id).put("name", me.name).put("model", me.model).put("android", me.android).put("app_version", me.appVersion)
            .put("ip", me.ip).put("auto_push", h.autoPush).put("folder", h.folder).put("state", h.state).put("error", h.error)
        val j = request("POST", "/admin/api/sync/hello", body.toString())
        return HelloResult(j.optJSONObject("web")?.optInt("sessions") ?: 0, j.optInt("online"))
    }

    fun backups(): List<BackupDay> {
        val arr = request("GET", "/admin/api/sync/backups", null).optJSONArray("days") ?: return emptyList()
        return (0 until arr.length()).map {
            val o = arr.getJSONObject(it)
            BackupDay(o.getString("date"), o.optInt("databases"), o.optLong("bytes"), o.textOrNull("updated_at"), o.textOrNull("last_actor"))
        }
    }

    /** The preference files of one backup day. */
    fun databasesOfDay(day: String): List<NamedText> {
        if (!DAY.matches(day)) throw SyncException("Ngày không hợp lệ: $day")
        val arr = request("GET", "/admin/api/sync/backups/$day/databases", null).optJSONArray("files") ?: return emptyList()
        return (0 until arr.length()).map { val o = arr.getJSONObject(it); NamedText(o.getString("name"), o.getString("text")) }
    }

    fun pushDatabases(files: List<NamedText>): DatabasePushSummary {
        val arr = JSONArray()
        for (f in files) arr.put(JSONObject().put("name", f.name).put("text", f.text))
        return DatabasePushSummary.fromJson(request("POST", "/admin/api/sync/databases/push", JSONObject().put("files", arr).toString()))
    }

    /** Deletes everything the server keeps. The server only does it for this exact confirmation text. */
    fun wipe(): WipeResult {
        val j = request("POST", "/admin/api/sync/wipe", JSONObject().put("confirm", "XOA TAT CA").toString())
        val moved = j.optJSONArray("moved")
        return WipeResult((0 until (moved?.length() ?: 0)).map { moved!!.getString(it) }, j.optString("kept_in"))
    }

    private fun request(method: String, path: String, body: String?): JSONObject {
        val c = try {
            URL(base + path).openConnection() as HttpURLConnection
        } catch (e: IOException) {
            throw SyncException("Địa chỉ không hợp lệ: $base", e)
        }
        try {
            c.requestMethod = method
            c.connectTimeout = connectTimeoutMs
            c.readTimeout = readTimeoutMs
            c.setRequestProperty("Accept", "application/json")
            c.setRequestProperty("X-Admin-Request", "1")
            identity?.let {
                c.setRequestProperty("X-Device-Id", it.id)
                c.setRequestProperty("X-Device-Name", URLEncoder.encode(it.name, "UTF-8").replace("+", "%20")) // the server decodes it with decodeURIComponent
            }
            if (body != null) {
                val bytes = body.toByteArray(Charsets.UTF_8)
                c.doOutput = true
                c.setRequestProperty("Content-Type", "application/json; charset=utf-8")
                c.setFixedLengthStreamingMode(bytes.size)
                c.outputStream.use { it.write(bytes) }
            }
            val code = c.responseCode
            val stream = if (code in 200..299) c.inputStream else c.errorStream
            val text = stream?.use { String(it.readBytes(), Charsets.UTF_8) } ?: ""
            val json = runCatching { JSONObject(text) }.getOrNull()
            if (code !in 200..299) {
                val why = json?.optString("error")?.takeIf { it.isNotBlank() } ?: text.take(120)
                throw SyncException("Server trả lỗi $code: $why")
            }
            return json ?: throw SyncException("Phản hồi không phải JSON: địa chỉ này không phải server sao lưu.")
        } catch (e: SyncException) {
            throw e
        } catch (e: IOException) {
            throw SyncException("Không kết nối được tới $base: ${e.message ?: e.javaClass.simpleName}", e)
        } finally {
            c.disconnect()
        }
    }
}
