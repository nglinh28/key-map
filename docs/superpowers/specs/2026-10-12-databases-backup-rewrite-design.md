# Làm lại: chỉ sao lưu `Documents/jya2/databases` + tab phân tích `gamwing_keymap_cache.xml`

Ngày: 2026-10-12. Trạng thái: thiết kế đã được người dùng duyệt trong hội thoại (phương án A: cắt bớt tại chỗ).

## Mục tiêu

App Android (`android-sync/`) và server + web (`keymap-server/`) chỉ còn một việc: **sao lưu các file `.xml` trong
`Documents/jya2/databases` của điện thoại**, kèm một nhóm tab trên web để **phân tích file `gamwing_keymap_cache.xml`**.
Mọi thứ liên quan tới "kho keymap" (API FT, tài khoản, mã chia sẻ, nhập backup, cache `list|…`/`map|…` dạng file rời) bị bỏ.

Ngoài phạm vi: sửa nội dung JSON bên trong `gamwing_keymap_cache.xml`; kéo thả vị trí phím; sửa đường cong độ giật;
đăng nhập/xác thực (vẫn chỉ dùng trong LAN tin cậy); chuyển dữ liệu cũ trong `data/`.

## Dữ liệu thật (đã xem, ghi lại để test dựa vào)

`gamwing_keymap_cache.xml` là một file Android SharedPreferences (`<map>`), 6,1 MB, các mục `<string>`:
- `list|<namespace>`: JSON `{"selected": "<id>", "items": [{id, name(ngày), game, public, meta(chuỗi JSON có "name")}]}`.
- `map|<id>`: JSON của một keymap (có `components`), một bản nhận diện AI (có `components` kiểu `type`, `vehicleCarRect*`)
  hoặc một cấu hình độ giật (có `recoil_data`, có thể có `ft_recoil_mode_profiles`; tới 4 MB).
- Giá trị được escape XML (`&quot;` …). Có mục `map|` không nằm trong `list|` (mồ côi); tên trong `list|` có thể lệch với
  `name` trong dữ liệu (ví dụ list ghi "2.0数据", dữ liệu ghi "4.0数据").
- Namespace: `com.vng.pubgmobile` (sơ đồ phím), `com.zjx.pubg.rcConfig2` (độ giật), `com.zjx.pubg.recognition.<game>` (nhận diện AI).

Các file khác trong thư mục (`PubgSettings.xml`, `ft_map_server_v1.xml`, `ADBKey.xml`, …) cũng là SharedPreferences nhỏ.
Thư mục `databases/` ở gốc dự án là dữ liệu thật dùng để xem tay; **test không phụ thuộc vào nó** (dùng fixture tự dựng) và nó
nằm trong `.gitignore` vì có `ADBKey.xml`.

## 1. Server (`keymap-server/`)

Giữ nguyên:
- `databases.js`: kiểm tra tên file (chỉ `.xml` an toàn, từ chối tên chứa `entitlement`/`ipc_session`/`license`), ghi qua file tạm,
  10 phiên bản mỗi file (`.history/`), etag, không bao giờ xóa qua push.
- `devices.js`: nhịp tim của app (online nếu có tín hiệu trong 40 giây), tín hiệu "web đang mở" (30 giây), tối đa 50 máy.
- Lớp bảo vệ trong `admin.js`: `Host` hợp lệ, `X-Admin-Request: 1` khi ghi, same-origin, header bảo mật, CSP.

Thay đổi:
- `backup.js` (`DailyBackups`): mỗi ngày một thư mục `backups/YYYY-MM-DD/` chứa `databases/<tên mã hóa>.xml` và `_manifest.json`.
  Trong ngày ghi đè bằng trạng thái mới nhất; sang ngày mới tạo thư mục mới (múi giờ `BACKUP_TZ`); ghi qua thư mục tạm rồi đổi tên;
  không bao giờ thay bằng trạng thái rỗng; `BACKUP_KEEP_DAYS` để dọn. Bỏ `buildCacheFiles` và mọi file `list%7C`/`map%7C`.
  Thư mục ngày cũ có các file đó thì bị bỏ qua (không lỗi).
- `server.js`: chỉ còn HTTP/HTTPS, `/health`, và chuyển `/admin*` sang `admin.js`. Bỏ `Store`, mọi route `/v2/*`, `/ft/v1/*`,
  mã chia sẻ, idempotency, `FT_ALLOWED_CLIENTS`, `SYNC_ACCOUNT`.
- `admin.js` (≈560 → ≈250 dòng): bỏ `overview`, `accounts/*`, `shares`, `import-cache`, `export`, lịch sử theo doc, `sync/push`
  và `sync/pull` kiểu cache. Giữ `sync/info`, `hello`, `devices`, `presence`, `databases` (list, push, đọc, lịch sử, PUT sửa),
  `backups`, `backups/<ngày>/databases`, `wipe`. **Thêm** `GET /admin/api/sync/backups/<ngày>/databases/<tên mã hóa URL>`
  để đọc một file của một ngày (phục vụ so sánh).
- `sync/info` trả `docs` = số file `.xml` đang lưu (app cũ vẫn đọc được), thêm `files`.
- Giới hạn: `MAX_FILE_BYTES` 8 MB → **24 MB** (file cache đã 6,1 MB và lớn dần); body của admin vẫn tối thiểu 32 MB.
- `package.json` version 2.0.0. `data/accounts`, `data/history`, `data/shares.json` cũ không được đụng tới và không còn dùng.

## 2. Phân tích file cache: `admin/cachexml.js` (mới)

Module UMD (chạy trong trình duyệt và trong Node, giống `recoil.js`), không cần `DOMParser`:
- `parse(xmlText)` → `{ entries: [{tag, name, value}] }` cho SharedPreferences `<map>` (`string`, `int`, `long`, `float`, `boolean`,
  `set`); giải mã entity có tên và số. Ném lỗi có thông điệp tiếng Việt nếu không phải `<map>` hợp lệ.
- `analyze(parsed)` → namespace (kèm `kind` recoil/recognition/keymap, dùng cùng quy tắc `kindOf` hiện có), mục `list|` đang chọn,
  các mục (id, tên trong list, tên trong dữ liệu, ngày, kích thước), danh sách **mồ côi**, **thiếu map**, **tên lệch**.
  `JSON.parse` từng `map|` chỉ khi được hỏi tới.
- `diffEntries(a, b)` → mục thêm/mất/đổi giữa hai bản của cùng một file prefs (dùng cho tab So sánh); với file cache so theo
  từng `list|`/`map|`, với file khác so theo từng khóa.

## 3. Web (`keymap-server/admin/`): 5 tab

1. **Phân tích cache**: bảng mục theo loại; chọn sơ đồ phím/nhận diện AI → màn hình mô phỏng vị trí (`layout.js`, chỉ xem);
   chọn độ giật → phân tích theo súng/tư thế/ống ngắm/đường cong/hệ số (`recoil.js`, chỉ xem). Gắn cờ mồ côi và tên lệch.
2. **Tệp cài đặt**: danh sách file, xem, tải về, lịch sử 10 bản (so sánh, khôi phục). File **≤ 256 KB**: sửa trực tiếp, kiểm tra
   XML hợp lệ, hộp cảnh báo, etag (409 khi file đã đổi), tự sao lưu bản cũ. File lớn hơn (tức file cache): chỉ xem và tải,
   có liên kết sang tab Phân tích.
3. **So sánh ngày**: chọn file và hai ngày (hoặc một ngày so với bản hiện tại); `diffEntries`; mục đổi của file cache bấm vào để
   xem diff JSON (`EditLib.diff`, có giới hạn số thay đổi). File không đọc được dạng prefs: chỉ báo giống/khác.
4. **Sao lưu theo ngày**: danh sách ngày, xem và tải từng file.
5. **Thiết bị**: như hiện nay (+ chip trạng thái kết nối trên đầu trang).

`app.js` viết lại quanh 5 tab này. `recoil.js`, `layout.js`, `edit.js` bỏ các hàm sửa không còn được gọi
(`applyRecoilEdits`, `applyChanges`, các hàm đường dẫn nếu không dùng).

## 4. App Android (`android-sync/`)

- Bỏ: `CacheNames`, đẩy/nhập kiểu cache, `planPull`, "Nhập từ server về", ô "thư mục keymap", công tắc sao lưu cài đặt
  (luôn bật), `StateStore`.
- Giữ/đơn giản hóa: một thư mục `Documents/jya2/databases` (pref `databases`); **Đẩy lên server**; **Khôi phục theo ngày…**
  (xem file mới/sẽ bị ghi đè, hộp xác nhận, chép file cũ vào `Documents/FTKeymapSync/backup/<thời gian>/databases/`);
  **Kiểm tra kết nối**; **Quét file**; công tắc **tự đẩy** (poll 3 giây, chỉ đẩy khi thư mục đứng yên qua 2 lần kiểm tra,
  giãn dần khi lỗi tới 60 giây); nhịp tim 15 giây; **xóa toàn bộ trên server** (gõ "XOA"; chỉ còn xóa `databases`, lịch sử, sao lưu).
- Quy tắc tên file giống server (không đọc/gửi/ghi file giấy phép hay phiên đăng nhập). Ghi file vẫn ghi đè tại chỗ.
- File 6 MB được gửi riêng thành một lô (giới hạn lô 6 MB chỉ chia khi đã có file trong lô).

## 5. Kiểm thử và thứ tự làm (TDD)

- Node `node --test`: giữ `databases`, `devices`; viết lại `backups` và test admin còn lại (host/CSRF, sync, wipe, so sánh ngày);
  thêm `cachexml` (fixture dựng từ cấu trúc ở trên, gồm mồ côi, tên lệch, entity, `list` rỗng); cắt gọn test `recoil`, `layout`, `edit`.
- Android JVM (server giả): giữ engine/watcher/restore/device/databases; bỏ test cache.
- Thứ tự: (1) server + sao lưu, (2) `cachexml.js`, (3) web, (4) app Android, (5) README, Docker, dọn file thừa.

## Rủi ro đã biết

- File cache sẽ ghi đè liên tục khi Gamwing chạy: mỗi lần đổi tạo một phiên bản lịch sử (10 × ~6 MB/file) và một bản ghi
  đè trong thư mục ngày. Chấp nhận được; nếu quá tải thì giảm tần suất tự đẩy sau.
- `ADBKey.xml` có thể là khóa riêng và vẫn được sao lưu (như hiện nay); README giữ cảnh báo "chỉ dùng trong mạng tin cậy".
- Tab Phân tích phụ thuộc vào suy luận về cách app Gamwing dùng dữ liệu (đã ghi chú "suy ra" trong `recoil.js`/`layout.js`).
