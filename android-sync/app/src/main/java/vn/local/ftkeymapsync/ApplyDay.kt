package vn.local.ftkeymapsync

import java.io.File

/**
 * The files Gamwing keeps in Documents/jya2/pubg_extension/RCConfig (its recoil configuration). For Gamwing to take new recoil data they
 * have to be gone, so "Khôi phục theo ngày" clears them after it has written the restored databases. Only FILES are deleted (the folders
 * stay), and every file is copied to <backup>/<time>/RCConfig/ first; a file whose copy failed is not deleted.
 */
object RcConfig {
    const val RELATIVE = "pubg_extension/RCConfig"

    /** the RCConfig folder that belongs with a databases folder: it sits next to it, in jya2/pubg_extension */
    fun dirFor(databasesDir: File): File = File(File(databasesDir.parentFile ?: databasesDir, "pubg_extension"), "RCConfig")

    /** every file in the folder, also in sub folders */
    fun files(dir: File): List<File> = if (dir.isDirectory) dir.walkTopDown().filter { it.isFile }.sortedBy { it.path }.toList() else emptyList()

    fun plan(dir: File): RcPlan {
        val all = files(dir)
        return RcPlan(dir, dir.isDirectory, all.size, all.sumOf { it.length() })
    }

    /**
     * Copies each file to [backupDir]()/RCConfig/<same relative path>, then deletes it. [onFile] gets (done, total, name) before each file.
     * [backupDir] is asked for only when there is something to back up. Never throws: problems are in the result.
     */
    fun clear(dir: File, backupDir: () -> File, onFile: (Int, Int, String) -> Unit = { _, _, _ -> }): RcResult {
        val all = files(dir)
        if (all.isEmpty()) return RcResult(0, emptyList(), null)
        val target = File(backupDir(), "RCConfig").also { it.mkdirs() }
        var deleted = 0
        val failed = mutableListOf<String>()
        all.forEachIndexed { i, f ->
            val rel = f.relativeTo(dir).path
            onFile(i + 1, all.size, rel)
            try {
                val copy = File(target, rel)
                copy.parentFile?.mkdirs()
                f.copyTo(copy, overwrite = true)
                if (f.delete()) deleted++ else failed += "$rel: không xóa được"
            } catch (e: Exception) {
                failed += "$rel: ${e.message ?: e.javaClass.simpleName}"
            }
        }
        return RcResult(deleted, failed, target)
    }
}

data class RcPlan(val dir: File, val exists: Boolean, val count: Int, val bytes: Long)

data class RcResult(val deleted: Int, val failed: List<String>, val backupDir: File?)

/** What the whole "restore a day" did, for the summary and the log. */
data class ApplyDayResult(val restore: PullResult, val rc: RcResult, val stoppedGamwing: Boolean?) {
    val ok: Boolean get() = restore.failed.isEmpty() && rc.failed.isEmpty()

    fun lines(day: String): List<String> {
        val out = mutableListOf<String>()
        out += "Thư mục databases: đã ghi ${restore.written.size} file từ bản sao lưu ngày $day." + (restore.backupDir?.let { " File cũ đã chép vào ${it.path}." } ?: "")
        restore.failed.forEach { out += "  lỗi: $it" }
        out += if (rc.deleted == 0 && rc.failed.isEmpty()) "RCConfig: không có file nào để xóa." else "RCConfig: đã xóa ${rc.deleted} file." + (rc.backupDir?.let { " Đã chép dự phòng vào ${it.path}." } ?: "")
        rc.failed.forEach { out += "  lỗi: $it" }
        when (stoppedGamwing) {
            true -> out += "Gamwing: đã yêu cầu dừng tiến trình chạy nền."
            false -> out += "Gamwing: không tìm thấy ứng dụng để dừng."
            null -> Unit
        }
        return out
    }
}
