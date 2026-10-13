package vn.local.ftkeymapsync

import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.Executors

/**
 * A tiny stand-in for the keymap server's sync endpoints, running inside the JVM test.
 * Plain sockets on purpose: the Android unit-test classpath does not include com.sun.net.httpserver.
 */
class FakeSyncServer {
    @Volatile var failNext = false
    @Volatile var webSessions = 0
    val requestHeaders = mutableListOf<Map<String, String>>()   // headers of every request, in order
    val hellos = mutableListOf<JSONObject>()                    // bodies of the heartbeat requests
    var nullActorDay = "" // this backup day is reported with last_actor: null, like the real server does before anyone wrote to it
    @Volatile var wipes = 0                                                  // how many times "delete everything" was confirmed
    val databases = LinkedHashMap<String, String>()                         // preference files the "server" holds, by real name
    val databasePushes = mutableListOf<List<String>>()                      // file names of every databases push request
    val pendingCommands = mutableListOf<ServerCommand>()                    // handed out in every heartbeat answer until a result is posted
    val commandResults = mutableListOf<Pair<String, CommandReport>>()       // command id -> what the phone reported
    val pushFolders = mutableListOf<String>()                               // the phone folder named in every databases push request
    val backupDatabases = LinkedHashMap<String, LinkedHashMap<String, String>>() // date -> preference files (a day exists once it has an entry)
    private val socket = ServerSocket(0, 50, InetAddress.getByName("127.0.0.1"))
    private val pool = Executors.newCachedThreadPool()
    @Volatile private var open = true

    val url: String get() = "http://127.0.0.1:${socket.localPort}"

    init {
        pool.execute {
            while (open) {
                try {
                    val c = socket.accept()
                    pool.execute { serve(c) }
                } catch (e: Exception) {
                    if (!open) break
                }
            }
        }
    }

    fun stop() {
        open = false
        socket.close()
        pool.shutdownNow()
    }

    private fun readLine(input: InputStream): String? {
        val buf = ByteArrayOutputStream()
        while (true) {
            val b = input.read()
            if (b == -1) return if (buf.size() == 0) null else buf.toString("UTF-8")
            if (b == '\n'.code) return buf.toString("UTF-8").trimEnd('\r')
            buf.write(b)
        }
    }

    private fun serve(c: Socket) {
        c.use { s ->
            val input = s.getInputStream()
            val requestLine = readLine(input) ?: return
            val parts = requestLine.split(" ")
            val method = parts[0]
            val path = parts[1]
            val headers = HashMap<String, String>()
            while (true) {
                val line = readLine(input) ?: break
                if (line.isEmpty()) break
                val i = line.indexOf(':')
                if (i > 0) headers[line.substring(0, i).trim().lowercase()] = line.substring(i + 1).trim()
            }
            val length = headers["content-length"]?.toIntOrNull() ?: 0
            val body = ByteArray(length)
            var read = 0
            while (read < length) {
                val n = input.read(body, read, length - read)
                if (n < 0) break
                read += n
            }
            synchronized(requestHeaders) { requestHeaders += headers }
            val (code, text) = route(method, path, headers, String(body, Charsets.UTF_8))
            val payload = text.toByteArray(Charsets.UTF_8)
            val head = "HTTP/1.1 $code X\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: ${payload.size}\r\nConnection: close\r\n\r\n"
            s.getOutputStream().apply { write(head.toByteArray(Charsets.UTF_8)); write(payload); flush() }
        }
    }

    private fun route(method: String, path: String, headers: Map<String, String>, body: String): Pair<Int, String> {
        if (path.startsWith("/admin/api/other")) return 200 to "<html>not a keymap server</html>"
        if (failNext) { failNext = false; return 500 to """{"error":"Internal error"}""" }
        if (method != "GET" && headers["x-admin-request"] != "1") return 403 to """{"error":"Cross-site or missing X-Admin-Request"}"""
        val commandResultMatch = Regex("""/sync/commands/([A-Za-z0-9._-]+)/result\z""").find(path)
        val dbDayMatch = Regex("""/sync/backups/(\d{4}-\d{2}-\d{2})/databases\z""").find(path)
        return when {
            path.endsWith("/sync/info") -> 200 to JSONObject().put("ok", true).put("server", "ft-keymap-server").put("version", "2.0.0")
                .put("files", databases.size).put("docs", databases.size)
                .put("web", JSONObject().put("sessions", webSessions)).put("devices_online", 1).put("backup_days", backupDatabases.size).toString()
            path.endsWith("/sync/hello") -> {
                hellos += JSONObject(body)
                val cmds = JSONArray().also { a -> pendingCommands.forEach { c -> a.put(JSONObject().put("id", c.id).put("type", c.type).put("file", c.file).put("ids", JSONArray(c.ids))) } }
                200 to JSONObject().put("ok", true).put("online", 1).put("web", JSONObject().put("sessions", webSessions)).put("commands", cmds).toString()
            }
            commandResultMatch != null -> {
                val j = JSONObject(body)
                fun ids(key: String) = j.optJSONArray(key)?.let { a -> (0 until a.length()).map { a.getString(it) } } ?: emptyList()
                commandResults += commandResultMatch.groupValues[1] to CommandReport(ids("removed"), ids("missing"), ids("reappeared"), emptyList(), j.optString("error"), j.optString("backup"))
                pendingCommands.removeAll { it.id == commandResultMatch.groupValues[1] }
                200 to """{"ok":true}"""
            }
            path.endsWith("/sync/backups") -> {
                val arr = JSONArray()
                for ((d, f) in backupDatabases.entries.sortedByDescending { it.key }) {
                    arr.put(JSONObject().put("date", d).put("databases", f.size).put("bytes", f.values.sumOf { it.length })
                        .put("updated_at", "${d}T07:32:00.000Z").put("last_actor", if (d == nullActorDay) JSONObject.NULL else "Galaxy Tab"))
                }
                200 to JSONObject().put("days", arr).toString()
            }
            dbDayMatch != null -> {
                val day = dbDayMatch.groupValues[1]
                val f = backupDatabases[day]
                if (f == null) 404 to """{"error":"Backup not found"}""" else {
                    val arr = JSONArray()
                    for ((n, t) in f) arr.put(JSONObject().put("name", n).put("text", t))
                    200 to JSONObject().put("date", day).put("files", arr).toString()
                }
            }
            path.endsWith("/sync/databases/push") -> pushDatabases(body)
            path.endsWith("/sync/wipe") -> {
                if (JSONObject(body).optString("confirm") != "XOA TAT CA") 400 to """{"error":"Confirmation required"}""" else {
                    wipes++
                    databases.clear(); backupDatabases.clear()
                    200 to JSONObject().put("ok", true).put("moved", JSONArray(listOf("backups", "databases"))).put("kept_in", "_wiped/2026-10-11T00-00-00-000Z").toString()
                }
            }
            else -> 404 to """{"error":"Not found"}"""
        }
    }

    private fun pushDatabases(body: String): Pair<Int, String> {
        val json = JSONObject(body)
        pushFolders += json.optString("folder")
        val arr = json.getJSONArray("files")
        val names = mutableListOf<String>()
        var saved = 0
        var unchanged = 0
        for (i in 0 until arr.length()) {
            val f = arr.getJSONObject(i)
            val name = f.getString("name")
            val text = f.getString("text")
            names += name
            if (databases[name] == text) unchanged++ else { databases[name] = text; saved++ }
        }
        databasePushes += names
        return 200 to JSONObject().put("saved", saved).put("unchanged", unchanged).put("skipped", JSONArray()).toString()
    }
}
