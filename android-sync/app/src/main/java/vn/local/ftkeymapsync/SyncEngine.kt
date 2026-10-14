package vn.local.ftkeymapsync

import java.io.File
import java.io.FileOutputStream
import java.security.MessageDigest
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/** The folder holding the Gamwing preference files (Documents/jya2/databases by default). */
class LocalFolder(val dir: File) {
    fun exists() = dir.isDirectory

    fun scan(): List<LocalFile> =
        dir.listFiles()?.filter { it.isFile }?.map { LocalFile(it.name, it.length(), it.lastModified()) }?.sortedBy { it.name } ?: emptyList()

    fun file(name: String) = File(dir, name)

    fun read(name: String): String = file(name).readText(Charsets.UTF_8)

    /**
     * Overwrites the file in place (same file, so the app that owns it can keep writing it); creates it when it is missing.
     * No temp-file-and-rename on purpose: a renamed file would belong to this app instead.
     */
    fun write(name: String, text: String) {
        dir.mkdirs()
        FileOutputStream(file(name), false).use { it.write(text.toByteArray(Charsets.UTF_8)) }
    }
}

/** the preference files that may be backed up, by name -> fingerprint */
fun databaseFingerprints(folder: LocalFolder): Map<String, String> =
    folder.scan().filter { DatabaseNames.isBackupName(it.name) }.associate { it.name to it.fingerprint }

/** Which commands this process has already done or still has to report, shared by the screen and the background service. */
class CommandState {
    val done = HashSet<String>()
    val unsent = HashMap<String, CommandReport>()

    companion object { val shared = CommandState() }
}

class SyncEngine(
    private val folder: LocalFolder,
    private val client: ServerClient,
    private val backupRoot: File,
    private val maxBatchBytes: Int = 6_000_000,
    private val clock: () -> Long = { System.currentTimeMillis() },
    /** waits a little after a file was written by a command, so a write-back by Gamwing can be noticed */
    private val settle: () -> Unit = { Thread.sleep(3_000) },
    private val commandState: CommandState = CommandState.shared,
    /** receives a line for every thing done because of the web page, and for every check made after a push */
    private val actions: ActionLog? = null,
) {
    // ---------------------------------------------------------------- "kiểm tra đồng bộ": this tablet against the server
    private fun sha256(text: String): String = MessageDigest.getInstance("SHA-256").digest(text.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }

    /** Fingerprints of the files on this tablet that may be backed up ([names]: only these). Same rules as the server's: sha-256 of the utf-8 text. */
    fun localDigests(names: Collection<String>? = null): List<FileDigest> =
        folder.scan().filter { DatabaseNames.isBackupName(it.name) && (names == null || it.name in names) }
            .map { FileDigest(it.name, it.size, sha256(folder.read(it.name))) }.sortedBy { it.name }

    /**
     * Compares the files of this tablet with the server's latest copy and with the files of its newest backup day.
     * With [names] only those files are looked at (what a push just sent): files that exist only on the server are then not reported.
     */
    fun checkSync(manifest: ServerManifest, names: Collection<String>? = null): SyncCheck {
        val local = localDigests(names)
        val latest = manifest.latest.associateBy { it.name }
        val day = manifest.day.associateBy { it.name }
        val different = mutableListOf<String>()
        val onlyTablet = mutableListOf<String>()
        val dayDifferent = mutableListOf<String>()
        var same = 0
        for (f in local) {
            val s = latest[f.name]
            when {
                s == null -> onlyTablet += f.name
                s.sha256 == f.sha256 -> same++
                else -> different += f.name
            }
            if (manifest.dayDate != null && day[f.name]?.sha256 != f.sha256) dayDifferent += f.name
        }
        val onlyServer = if (names == null) manifest.latest.map { it.name }.filter { n -> local.none { it.name == n } }.sorted() else emptyList()
        return SyncCheck(manifest.dayDate.orEmpty(), local.size, same, different, onlyTablet, onlyServer, dayDifferent)
    }

    /** The whole check, asking the server for its fingerprints. A problem talking to the server is part of the answer, not an exception. */
    fun checkSync(names: Collection<String>? = null): SyncCheck = try {
        checkSync(client.manifest(), names)
    } catch (e: Exception) {
        SyncCheck("", 0, 0, emptyList(), emptyList(), emptyList(), emptyList(), error = e.message ?: e.javaClass.simpleName)
    }

    /** After a push: the files just sent against the newest backup day (and the latest copy) on the server. The result is also written to the action log. */
    fun checkAfterPush(names: Collection<String>): SyncCheck {
        val r = checkSync(names)
        val short = when {
            r.error.isNotEmpty() -> "Sau khi đẩy: không kiểm tra được đồng bộ (${r.error})"
            r.inSync -> "Sau khi đẩy: đã kiểm tra đồng bộ với bản sao lưu ngày ${r.dayDate}: ${r.same}/${r.checked} file giống."
            else -> "Sau khi đẩy: CHƯA đồng bộ với bản sao lưu ngày ${r.dayDate.ifEmpty { "(chưa có)" }}: ${(r.different + r.onlyTablet + r.dayDifferent).distinct().joinToString()}"
        }
        actions?.addAction(short)
        return r
    }

    fun scan(): DatabaseScan {
        if (!folder.exists()) return DatabaseScan(false, 0, emptyList(), 0, folder.dir.path)
        val all = folder.scan()
        val ok = all.filter { DatabaseNames.isBackupName(it.name) }
        val skipped = all.filter { it.name.endsWith(".xml", ignoreCase = true) && !DatabaseNames.isBackupName(it.name) }.map { it.name }
        return DatabaseScan(true, ok.size, skipped, ok.sumOf { it.size }, folder.dir.path)
    }

    /**
     * Sends the given files (all of them when [names] is null) in batches; names that may not be backed up are left out.
     * A file bigger than a batch goes alone in its own request.
     */
    fun push(names: Collection<String>? = null): DatabasePushSummary {
        val want = (names ?: folder.scan().map { it.name }).filter { DatabaseNames.isBackupName(it) && folder.file(it).isFile }
        var total = DatabasePushSummary.EMPTY
        var batch = mutableListOf<NamedText>()
        var size = 0
        for (name in want) {
            val t = NamedText(name, folder.read(name))
            if (batch.isNotEmpty() && size + t.text.length > maxBatchBytes) {
                total += client.pushDatabases(batch, folder.dir.path)
                batch = mutableListOf()
                size = 0
            }
            batch += t
            size += t.text.length
        }
        if (batch.isNotEmpty()) total += client.pushDatabases(batch, folder.dir.path)
        return total
    }

    fun listBackupDays(): List<BackupDay> = client.backups()

    /** What restoring the files of a backup day would do. Names that may not be written are rejected, never written. */
    fun planRestore(date: String): PullPlan {
        val rejected = mutableListOf<String>()
        val items = mutableListOf<PullItem>()
        for (remote in client.databasesOfDay(date)) {
            if (!DatabaseNames.isBackupName(remote.name)) { rejected += remote.name; continue }
            val local = folder.file(remote.name)
            val state = when {
                !local.isFile -> PullState.NEW
                local.readText(Charsets.UTF_8) == remote.text -> PullState.SAME // XML: exact text
                else -> PullState.CHANGED
            }
            items += PullItem(remote.name, remote.text, state)
        }
        return PullPlan(items, rejected)
    }

    /**
     * Writes new and changed files. Files about to be overwritten are first copied to <backup>/<time>/databases/. Nothing is deleted.
     * [onFile] gets (done, total, name) before each file, so a screen can show how far it is.
     */
    fun applyRestore(plan: PullPlan, onFile: (Int, Int, String) -> Unit = { _, _, _ -> }): PullResult {
        val written = mutableListOf<String>()
        val failed = mutableListOf<String>()
        var backupDir: File? = null
        val todo = plan.items.filter { it.state != PullState.SAME && DatabaseNames.isBackupName(it.name) }
        for ((i, item) in todo.withIndex()) {
            onFile(i + 1, todo.size, item.name)
            try {
                if (item.state == PullState.CHANGED) {
                    val dir = backupDir ?: File(newBackupDir(), "databases").also { it.mkdirs(); backupDir = it }
                    folder.file(item.name).copyTo(File(dir, item.name), overwrite = true)
                }
                folder.write(item.name, item.text)
                written += item.name
            } catch (e: Exception) {
                failed += "${item.name}: ${e.message ?: e.javaClass.simpleName}"
            }
        }
        return PullResult(written, failed, backupDir)
    }

    // ---------------------------------------------------------------- commands from the web page
    /** Deletes the items of a delete_cache_items command from the file on this phone. Never throws: problems are in the report. */
    fun applyCommand(cmd: ServerCommand): CommandReport = when (cmd.type) {
        "delete_cache_items" -> applyDeletion(cmd)
        "verify_sync" -> CommandReport(verify = checkSync())
        else -> CommandReport(error = "Lệnh không biết: ${cmd.type}")
    }

    /** What to tell the user (log lines) about a command that was done and reported; also adds lines to the action log. */
    private fun describeDone(c: ServerCommand, report: CommandReport): List<String> {
        if (c.type == "verify_sync") {
            val v = report.verify
            val lines = v?.lines() ?: listOf(report.error)
            actions?.addAction("Kiểm tra đồng bộ (lệnh từ web): ${lines.first()}")
            return listOf("Kiểm tra đồng bộ theo lệnh từ giao diện web:") + lines
        }
        fun named(id: String) = "«${c.labelOf(id).ifEmpty { "(không tên)" }}» (map|$id)"
        val lines = mutableListOf("Lệnh xóa từ giao diện web: ${report.describe()}" + if (report.backup.isNotEmpty()) " (file cũ đã chép vào ${report.backup})" else "")
        report.removed.forEach { lines += "  • đã xóa trên máy: ${named(it)}" }
        report.missing.forEach { lines += "  • không còn trên máy: ${named(it)}" }
        report.reappeared.forEach { lines += "  ⚠ hiện lại sau khi xóa: ${named(it)}" }
        if (report.removed.isNotEmpty()) actions?.addAction("Đã xóa trên máy theo lệnh từ web: " + report.removed.joinToString("; ") { named(it) })
        if (report.reappeared.isNotEmpty()) actions?.addAction("⚠ ${report.reappeared.size} mục hiện lại sau khi xóa (Gamwing ghi đè file?): " + report.reappeared.joinToString("; ") { named(it) })
        if (report.error.isNotEmpty()) actions?.addAction("Lệnh xóa từ web gặp lỗi: ${report.error}")
        return lines
    }

    fun applyDeletion(cmd: ServerCommand): CommandReport {
        if (cmd.type != "delete_cache_items") return CommandReport(error = "Lệnh không biết: ${cmd.type}")
        if (!DatabaseNames.isBackupName(cmd.file)) return CommandReport(error = "Tên file không được phép: ${cmd.file}")
        val file = folder.file(cmd.file)
        if (!file.isFile) return CommandReport(error = "Trên máy không có file ${cmd.file} trong ${folder.dir.path}")
        return try {
            val before = file.readText(Charsets.UTF_8)
            val cut = CacheEdit.removeItems(before, cmd.ids)
            val removed = (cut.removedMaps + cut.lists.flatMap { it.removed }).distinct()
            var saved = ""
            var reappeared = emptyList<String>()
            if (cut.text != before) {
                val dir = File(newBackupDir(), "databases").also { it.mkdirs() }
                file.copyTo(File(dir, cmd.file), overwrite = true) // the old file first
                saved = dir.path
                folder.write(cmd.file, cut.text)
                settle()
                val after = file.readText(Charsets.UTF_8)
                reappeared = removed.filter { CacheEdit.isPresent(after, it) }
            }
            CommandReport(removed = removed, missing = cut.missing, reappeared = reappeared, error = cut.warnings.joinToString("; "), backup = saved)
        } catch (e: Exception) {
            CommandReport(error = e.message ?: e.javaClass.simpleName)
        }
    }

    /**
     * Does the commands the server handed out, once each, and reports every result. A result that could not be sent is kept
     * and sent again at the next heartbeat (the work is not done twice). Returns lines for the log.
     */
    fun runCommands(cmds: List<ServerCommand>): List<String> = synchronized(commandState) {
        val lines = mutableListOf<String>()
        for (c in cmds) {
            if (c.id in commandState.done) continue
            val report = commandState.unsent[c.id] ?: applyCommand(c).also { commandState.unsent[c.id] = it }
            try {
                client.reportCommand(c.id, report)
                commandState.unsent.remove(c.id)
                commandState.done += c.id
                lines += describeDone(c, report)
            } catch (e: SyncException) {
                lines += "Đã làm lệnh ${c.id} nhưng chưa báo được lên server, sẽ thử lại: ${e.message}"
            }
        }
        lines
    }

    /** <backup>/<yyyyMMdd-HHmmss>/ (created); the files copied away before they are overwritten or deleted go in folders inside it */
    fun newBackupDir(): File {
        val stamp = SimpleDateFormat("yyyyMMdd-HHmmss", Locale.US).format(Date(clock()))
        return File(backupRoot, stamp).also { it.mkdirs() }
    }
}
