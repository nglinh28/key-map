# Làm lại: sao lưu `jya2/databases` + phân tích cache — kế hoạch triển khai

> **Cho người thực hiện:** làm tuần tự từng task, TDD (viết test trước, thấy FAIL, rồi mới viết code). Mỗi task kết thúc bằng một commit.

**Mục tiêu:** server + web + app Android chỉ sao lưu các file `.xml` của `Documents/jya2/databases`, kèm tab phân tích `gamwing_keymap_cache.xml`; build lại và chạy trên Docker của máy này.

**Kiến trúc:** cắt bớt tại chỗ (phương án A). Giữ `databases.js`, `devices.js`, lớp chống CSRF; `backup.js` chỉ còn sao lưu thư mục `databases`; module mới `admin/cachexml.js` (UMD) đọc SharedPreferences XML ở trình duyệt; `app.js` viết lại quanh 5 tab.

**Tech stack:** Node ≥ 20 (không dependency, `node --test`), JS thuần ở web, Kotlin (JVM test) ở app, Docker.

**Spec:** `docs/superpowers/specs/2026-10-12-databases-backup-rewrite-design.md`

## Ràng buộc chung (nguyên văn từ spec)

- File `.xml` ≤ **24 MB** mỗi file (`MAX_FILE_BYTES`), tối đa 200 file, tên tối đa 120 ký tự, 10 phiên bản mỗi file; body admin tối thiểu 32 MB.
- Từ chối tên chứa `entitlement`, `ipc_session`, `license` (server lẫn app).
- Sao lưu theo ngày: `backups/YYYY-MM-DD/databases/<tên mã hóa>.xml` + `_manifest.json`; ghi qua thư mục tạm; không thay bằng trạng thái rỗng. (Các ngày đã có sẵn dùng đúng bố cục này nên vẫn đọc được.)
- Tab web: **Phân tích cache**, **Tệp cài đặt**, **So sánh ngày**, **Sao lưu theo ngày**, **Thiết bị**. Sửa trực tiếp chỉ cho file ≤ 256 KB.
- Chỉ xem (không sửa) độ giật và vị trí phím. Test không phụ thuộc vào `databases/` thật (có `ADBKey.xml`, đã `.gitignore`).
- Giữ `/admin` và các đường dẫn `/admin/api/sync/*` còn dùng.

## Cấu trúc file

| File | Việc |
|---|---|
| `keymap-server/databases.js` | giữ; đổi `MAX_FILE_BYTES` 24 MB, thêm `readFileOfDay` không cần |
| `keymap-server/backup.js` | viết lại: chỉ databases |
| `keymap-server/server.js` | viết lại: HTTP + `/health` + `/admin` |
| `keymap-server/admin.js` | cắt còn endpoint sync + thêm đọc 1 file của 1 ngày |
| `keymap-server/admin/cachexml.js` | mới: `parse`, `analyze`, `diffEntries` |
| `keymap-server/admin/{app.js,index.html,app.css,recoil.js,layout.js,edit.js}` | viết lại / cắt |
| `android-sync/app/src/main/java/.../*.kt` | cắt phần cache keymap |
| `README.md` (2 project), `docker-compose.yml`, `Dockerfile` | cập nhật |

---

### Task 1: Server — sao lưu chỉ databases và API sync gọn

**Files:** sửa `backup.js`, `server.js`, `admin.js`, `databases.js`, `package.json`; viết lại `backups.test.js`, `sync.test.js`, `admin.test.js`, `hardening.test.js`, `harness.js` (bỏ client/token); xóa `server.test.js`, `edit.test.js`, `admin-edit.test.js`, `recoil-edit.test.js` nếu chỉ kiểm thử tính năng đã bỏ (giữ phần kiểm thử `databases` trong `databases.test.js`).

**Giao diện sau task này (dùng ở task sau):**
- `DailyBackups({ dir, tz, keepDays, clock, buildExtra })`: `snapshot() → {day, databases}|null`, `ensureToday()`, `list() → [{date, databases, bytes, updated_at, last_actor}]`, `read(day) → {date, manifest}|null`, `readDatabases(day) → [{name,text}]`, `readDatabase(day, name) → {name,text}|null`, `prune()`.
- `createServer(cfg)`; `loadConfig(env)` chỉ còn `port, host, dataDir, maxBody, tlsKey, tlsCert, adminEnabled, adminAllowedHosts, backupTz, backupKeepDays`.
- Endpoint mới: `GET /admin/api/sync/backups/<ngày>/databases/<tên>` → `{name,text}` hoặc 404.
- `GET /admin/api/sync/info` → `{ok, server:'ft-keymap-server', version, files, docs, web:{sessions}, devices_online, backup_days}` (`docs` = `files`, để app cũ vẫn đọc được).

- [ ] Viết test (FAIL): `snapshot` chép đủ file databases vào thư mục ngày; trong ngày ghi đè; sang ngày mới tạo thư mục mới (clock giả); không ghi đè bằng rỗng; `readDatabase` đọc đúng tên có dấu; `info` có `files`; `GET …/backups/<ngày>/databases/<tên>` trả 200/404/400 (ngày sai); push file 7 MB thành công (giới hạn mới); push `ADBKey` hợp lệ nhưng `license.xml` bị bỏ qua; ghi không có `X-Admin-Request` → 403; Host lạ → 403; `wipe` yêu cầu `XOA TAT CA`.
- [ ] Chạy `node --test` → FAIL.
- [ ] Viết `backup.js` (bỏ `buildCacheFiles`, `readCacheFiles`, `CACHE_NAME_RE`), `server.js`, `admin.js` (xóa overview/accounts/shares/import-cache/export/history theo doc/push cache/pull), `MAX_FILE_BYTES = 24 * 1024 * 1024`, version 2.0.0.
- [ ] `node --test` → PASS. `git commit -m "Server: chỉ sao lưu jya2/databases"`.

### Task 2: `admin/cachexml.js`

**Files:** tạo `admin/cachexml.js`, `cachexml.test.js`; thêm vào `PAGES` của `admin.js` đường `/admin/cachexml.js`.

**Giao diện:**
- `parse(xml) → { entries: [{tag, name, value}] }` (`value`: chuỗi đã giải mã cho `string`; số/boolean ở dạng chuỗi trong thuộc tính `value`; `set` → mảng). Ném `Error('Không phải file SharedPreferences hợp lệ: …')`.
- `serialize(parsed) → string` (không cần cho v1: bỏ nếu không dùng).
- `analyze(parsed) → { namespaces: [{ ns, kind, selected, items: [{ id, listName, dataName, addTime, bytes, hasMap, orphan, nameMismatch }] }], orphans: [{id, bytes}], missingMaps: [{id, ns}], maps: Map<id, text> }`.
- `kindOf(ns)` → `'recoil' | 'recognition' | 'keymap'` (cùng quy tắc `admin.js`: `com.zjx.pubg.rcConfig2`, tiền tố `com.zjx.pubg.recognition.`).
- `diffEntries(a, b) → { added: [name], removed: [name], changed: [name] }` (a, b là kết quả `parse`).
- `mapJson(analysis, id) → object` (`JSON.parse` tại chỗ, lỗi → `Error` tiếng Việt).

- [ ] Test fixture tự dựng (một `list|` có 1 item, hai `map|` trong đó một mồ côi, entity `&quot; &amp; &lt; &#x4E2D;`, tên lệch, `list` rỗng, `<map/>` rỗng, XML hỏng) → FAIL.
- [ ] Viết `cachexml.js` bằng regex trên `<string|int|long|float|boolean|set …>`; không dùng `DOMParser`.
- [ ] `node --test` → PASS. Commit `"cachexml.js: đọc SharedPreferences và phân tích cache keymap"`.

### Task 3: Web

**Files:** viết lại `admin/app.js` (5 tab), `admin/index.html` (nạp `cachexml.js`), sửa `admin/app.css`; cắt `recoil.js` (bỏ `applyRecoilEdits`, `mirrorTargets`, `applyToGroups`, `checkCurve`, `curveDiff`, `comboKey` nếu không dùng), `layout.js` (bỏ `applyChanges`, `describeChange`, `positionFromRect`), `edit.js` (giữ `formatPath`, `childPath`, `diff`; bỏ phần validate nếu không dùng); cập nhật `layout.test.js`, `recoil.test.js`, `edit.test.js`.

**Tab:**
1. *Phân tích cache* — tải `gamwing_keymap_cache.xml` từ `/admin/api/sync/databases/<tên>`; bảng theo loại; chọn mục → mô phỏng (keymap/nhận diện) hoặc phân tích độ giật.
2. *Tệp cài đặt* — danh sách, xem, tải, lịch sử (`…/history`), sửa ≤ 256 KB (kiểm tra bằng `DOMParser` + etag), file lớn chỉ xem.
3. *So sánh ngày* — chọn file + hai nguồn (ngày hoặc "hiện tại"), `diffEntries`, bấm mục đổi của file cache để xem `EditLib.diff` của JSON.
4. *Sao lưu theo ngày* — danh sách ngày, xem/tải từng file.
5. *Thiết bị* — như cũ.

- [ ] Giữ lại và chuyển nguyên các hàm đã có của app.js cũ: `el`, `api`, `toast`, `showModal`, `chart`, `drawRecoil`/`viewRecoilDetail` (bỏ phần `editableCell`/`pendingBar`), `screenCard` (bỏ kéo thả), `viewDevices`, `viewBackups`, `viewDatabases`/`dbEditor`.
- [ ] Test Node cho phần logic thuần (đã có trong `recoil.test.js`, `layout.test.js`, `cachexml.test.js`); phần DOM kiểm tra bằng chạy thật ở Task 5.
- [ ] `node --test` → PASS. Commit `"Web: 5 tab, phân tích cache chỉ xem"`.

### Task 4: App Android

**Files:** sửa `Helpers.kt` (bỏ `CacheNames`, `sameJson`/`jsonEquals` nếu không còn dùng — `sameJson` bỏ), `Models.kt`, `SyncEngine.kt`, `ServerClient.kt` (bỏ `push`, `pull`, `backup`; giữ `pushDatabases`, `databasesOfDay`, `backups`, `hello`, `wipe`, `info`), `Watcher.kt` (một thư mục, `StateStore` bỏ), `WatchService.kt`, `Prefs.kt` (bỏ `folderPath`, `databasesOn`; `databasesPath` mặc định `Documents/jya2/databases`; giữ `lastPushedDb`, `deviceId`, `deviceName`), `MainActivity.kt`; cập nhật các test Kotlin và `FakeSyncServer.kt`.

**Giao diện:**
- `SyncEngine(folder: LocalFolder, client: ServerClient, backupRoot: File, maxBatchBytes: Int = 6_000_000, clock)`: `scan(): DatabaseScan`, `push(names: Collection<String>? = null): DatabasePushSummary`, `listBackupDays(): List<BackupDay>`, `planRestore(date): PullPlan`, `applyRestore(plan): PullResult`.
- `Watcher(folder, engine, state: DbStateStore)`: `tick(): DbWatchEvent`.

- [ ] Sửa test Kotlin trước (bỏ test cache, đổi tên `…Databases` → tên mới), chạy `gradlew.bat testDebugUnitTest` → FAIL (biên dịch).
- [ ] Sửa code, chạy test → PASS; `gradlew.bat assembleDebug` tạo APK.
- [ ] Commit `"Android: chỉ sao lưu jya2/databases"`.

### Task 5: Tài liệu, Docker, kiểm tra thật

- [ ] Cập nhật 2 `README.md` và comment `docker-compose.yml` (bỏ biến không còn dùng: `FT_ALLOWED_CLIENTS`).
- [ ] Sao lưu volume `ft-keymap-server_ftdata` ra `D:\tmp` (an toàn) trước khi tạo lại container.
- [ ] `docker compose up -d --build` trong `keymap-server/`; chờ `healthy`.
- [ ] Kiểm tra thật trên một server Node tạm (thư mục dữ liệu tạm, cổng khác): đẩy toàn bộ `databases/` thật qua API sync; mở `/admin`, kiểm tra tab Phân tích cache với file 6 MB (số mục, mồ côi, tên lệch khớp phần đã xem tay), tab Tệp, So sánh, Sao lưu, Thiết bị.
- [ ] Kiểm tra container thật: `/health`, `/admin` 200, `sync/info`, file cũ trong volume vẫn đọc được.
- [ ] Commit `"Docs + Docker"`.
