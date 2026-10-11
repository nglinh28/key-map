package vn.local.ftkeymapsync

import java.io.File
import java.io.FileOutputStream
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/** The folder holding the phone's keymap cache (Documents/Gamwing/keymap_cache by default). */
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

fun cacheFingerprints(folder: LocalFolder): Map<String, String> =
    folder.scan().filter { CacheNames.kind(it.name) != FileKind.OTHER }.associate { it.name to it.fingerprint }

/** the preference files (Documents/jya2/databases) that may be backed up, by name -> fingerprint */
fun databaseFingerprints(folder: LocalFolder): Map<String, String> =
    folder.scan().filter { DatabaseNames.isBackupName(it.name) }.associate { it.name to it.fingerprint }

class SyncEngine(
    private val folder: LocalFolder,
    private val client: ServerClient,
    private val backupRoot: File,
    private val maxBatchBytes: Int = 6_000_000,
    private val clock: () -> Long = { System.currentTimeMillis() },
    private val dbFolder: LocalFolder? = null, // Documents/jya2/databases; null when this backup is switched off
) {
    fun scan(): ScanSummary {
        if (!folder.exists()) return ScanSummary(false, 0, 0, 0, 0, folder.dir.path)
        val files = folder.scan()
        return ScanSummary(
            exists = true,
            lists = files.count { CacheNames.kind(it.name) == FileKind.LIST },
            maps = files.count { CacheNames.kind(it.name) == FileKind.MAP },
            others = files.count { CacheNames.kind(it.name) == FileKind.OTHER },
            bytes = files.sumOf { it.size },
            path = folder.dir.path,
        )
    }

    fun pushAll(): PushSummary = push(folder.scan().filter { CacheNames.kind(it.name) != FileKind.OTHER }.map { it.name })

    /** Sends the given files plus every list file (they are small and carry names and the selected keymap). */
    fun push(names: Collection<String>): PushSummary {
        val all = folder.scan()
        val want = LinkedHashSet<String>()
        want += all.filter { CacheNames.kind(it.name) == FileKind.LIST }.map { it.name }
        want += names.filter { CacheNames.kind(it) != FileKind.OTHER && folder.file(it).isFile }
        var total = PushSummary.EMPTY
        var batch = mutableListOf<NamedText>()
        var size = 0
        for (name in want) {
            val t = NamedText(name, folder.read(name))
            if (batch.isNotEmpty() && size + t.text.length > maxBatchBytes) {
                total += client.push(batch)
                batch = mutableListOf()
                size = 0
            }
            batch += t
            size += t.text.length
        }
        if (batch.isNotEmpty()) total += client.push(batch)
        return total
    }

    /** the latest state on the server */
    fun planPull(): PullPlan = planFrom(client.pull())

    fun listBackupDays(): List<BackupDay> = client.backups()

    /** one daily backup on the server; written to the phone with exactly the same checks and safety copies as a normal pull */
    fun planPullDay(date: String): PullPlan = planFrom(client.backup(date))

    // ---------------------------------------------------------------- the app's preference files
    fun scanDatabases(): DatabaseScan {
        val f = dbFolder ?: return DatabaseScan(false, 0, emptyList(), 0, "(đã tắt)")
        if (!f.exists()) return DatabaseScan(false, 0, emptyList(), 0, f.dir.path)
        val all = f.scan()
        val ok = all.filter { DatabaseNames.isBackupName(it.name) }
        val skipped = all.filter { it.name.endsWith(".xml", ignoreCase = true) && !DatabaseNames.isBackupName(it.name) }.map { it.name }
        return DatabaseScan(true, ok.size, skipped, ok.sumOf { it.size }, f.dir.path)
    }

    /** Sends the given preference files (all of them when [names] is null) in batches; names that may not be backed up are left out. */
    fun pushDatabases(names: Collection<String>? = null): DatabasePushSummary {
        val f = dbFolder ?: return DatabasePushSummary.EMPTY
        val want = (names ?: f.scan().map { it.name }).filter { DatabaseNames.isBackupName(it) && f.file(it).isFile }
        var total = DatabasePushSummary.EMPTY
        var batch = mutableListOf<NamedText>()
        var size = 0
        for (name in want) {
            val t = NamedText(name, f.read(name))
            if (batch.isNotEmpty() && size + t.text.length > maxBatchBytes) {
                total += client.pushDatabases(batch)
                batch = mutableListOf()
                size = 0
            }
            batch += t
            size += t.text.length
        }
        if (batch.isNotEmpty()) total += client.pushDatabases(batch)
        return total
    }

    /** What restoring the preference files of a backup day would do. Names that may not be written are rejected, never written. */
    fun planRestoreDatabases(date: String): PullPlan {
        val f = dbFolder ?: throw SyncException("Chưa bật sao lưu thư mục cài đặt Gamwing.")
        val rejected = mutableListOf<String>()
        val items = mutableListOf<PullItem>()
        for (remote in client.databasesOfDay(date)) {
            if (!DatabaseNames.isBackupName(remote.name)) { rejected += remote.name; continue }
            val local = f.file(remote.name)
            val state = when {
                !local.isFile -> PullState.NEW
                local.readText(Charsets.UTF_8) == remote.text -> PullState.SAME // XML: exact text, no JSON rules here
                else -> PullState.CHANGED
            }
            items += PullItem(remote.name, remote.text, state)
        }
        return PullPlan(items, rejected)
    }

    /** Writes new and changed preference files. Files about to be overwritten are first copied to <backup>/<time>/databases/. Nothing is deleted. */
    fun applyRestoreDatabases(plan: PullPlan): PullResult {
        val f = dbFolder ?: throw SyncException("Chưa bật sao lưu thư mục cài đặt Gamwing.")
        val written = mutableListOf<String>()
        val failed = mutableListOf<String>()
        var backupDir: File? = null
        for (item in plan.items) {
            if (item.state == PullState.SAME || !DatabaseNames.isBackupName(item.name)) continue
            try {
                if (item.state == PullState.CHANGED) {
                    val dir = backupDir ?: File(newBackupDir(), "databases").also { it.mkdirs(); backupDir = it }
                    f.file(item.name).copyTo(File(dir, item.name), overwrite = true)
                }
                f.write(item.name, item.text)
                written += item.name
            } catch (e: Exception) {
                failed += "${item.name}: ${e.message ?: e.javaClass.simpleName}"
            }
        }
        return PullResult(written, failed, backupDir)
    }

    private fun planFrom(remote: List<NamedText>): PullPlan {
        val rejected = mutableListOf<String>()
        val items = mutableListOf<PullItem>()
        for (f in remote) {
            if (!CacheNames.isSafeServerName(f.name)) { rejected += f.name; continue }
            val local = folder.file(f.name)
            val state = when {
                !local.isFile -> PullState.NEW
                sameJson(local.readText(Charsets.UTF_8), f.text) -> PullState.SAME
                else -> PullState.CHANGED
            }
            items += PullItem(f.name, f.text, state)
        }
        return PullPlan(items, rejected)
    }

    /** Writes new and changed files into the folder. Files that would be overwritten are first copied to a dated backup folder. Nothing is deleted. */
    fun applyPull(plan: PullPlan): PullResult {
        val written = mutableListOf<String>()
        val failed = mutableListOf<String>()
        var backupDir: File? = null
        for (item in plan.items) {
            if (item.state == PullState.SAME) continue
            try {
                if (item.state == PullState.CHANGED) {
                    val dir = backupDir ?: newBackupDir().also { backupDir = it }
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

    private fun newBackupDir(): File {
        val stamp = SimpleDateFormat("yyyyMMdd-HHmmss", Locale.US).format(Date(clock()))
        return File(backupRoot, stamp).also { it.mkdirs() }
    }
}
