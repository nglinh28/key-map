# Làm lại: chỉ sao lưu `Documents/jya2/databases` + tab phân tích `gamwing_keymap_cache.xml`

Ngày: 2026-10-12. Trạng thái: thiết kế đã được duyệt (phương án A: cắt bớt tại chỗ) và **đã triển khai**; xem mục "Khác với thiết kế ban đầu" cuối file.

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

## Khác với thiết kế ban đầu (ghi lại sau khi làm)

- `cachexml.analyze` parse JSON của **mọi** `map|` ngay khi phân tích (6 MB mất khoảng 150–220 ms) thay vì từng mục khi cần, vì cần tên trong dữ liệu để phát hiện tên lệch.
  Kết quả có thêm `docs` (Map id → object | null), `maps` và `problems`; không có `mapJson`.
- Body của trang quản trị tối thiểu **64 MB** (không phải 32 MB): file 24 MB sau khi escape vào JSON có thể gần gấp đôi.
- Trang web tách thành `ui.js` (hàm dùng chung), `analysis.js` (tab Phân tích cache), `app.js` (điều hướng và 4 tab còn lại).
- `sync/info` trả `files` (và `docs` bằng giá trị đó); danh sách ngày sao lưu trả `databases`, `bytes`, `updated_at`, `last_actor` (không còn `files`/`docs`).
- Devices: `last_push` là `{at, saved, unchanged, skipped}`; `last_pull` ghi lần app đọc bộ file của một ngày.
- `docker-compose.yml` ghim `name: ft-keymap-server` để luôn dùng volume dữ liệu `ft-keymap-server_ftdata` dù thư mục đổi tên.
- Tab "Tệp cài đặt" của file cache có nút "Phân tích" thay cho nút "Sửa".
- App Android lên 2.0.0 (versionCode 2); đẩy file lớn hơn một lô thì đi riêng một request.

## Thêm sau: xóa mục khỏi cache, từ web xuống tablet (2026-10-13)

- Mọi mục của tab "Phân tích cache" (sơ đồ phím, nhận diện AI, độ giật; trong danh sách hay mồ côi) có nút **Xóa**, qua **hai hộp xác nhận**; chỉ ở "Bản mới nhất".
  Mỗi mục hiện rõ: file XML, mục `map|<id>`, danh sách `list|<ns>`, thư mục trên máy, và các dòng `document|…|<id>` ở `ft_map_server_v1.xml` (không bị xóa).
- Server (`POST /admin/api/cache/delete`): `cachexml.removeItems` cắt `map|<id>` và bỏ mục khỏi `list|<ns>` (mục đang chọn → chọn mục đầu còn lại, hoặc bỏ `selected` khi danh sách trống);
  ghi qua `databases.update` (etag, 10 bản lịch sử, sao lưu ngày) rồi tạo **lệnh** (`commands.js`, `data/commands.json`) cho các thiết bị đã biết.
- Tablet: lệnh đi trong câu trả lời của `hello` (nhịp 15 giây); app (`SyncEngine.applyDeletion`) chép file cũ vào `Documents/FTKeymapSync/backup/<thời gian>/databases/`,
  cắt bằng `CacheEdit.removeItems` (cùng luật với JS), ghi đè tại chỗ, chờ 3 giây, đọc lại để phát hiện Gamwing ghi đè (`reappeared`), rồi báo `POST …/commands/<id>/result`.
  **Không hỏi trên máy** (lựa chọn của người dùng). Mỗi lệnh làm một lần; kết quả chưa gửi được giữ để gửi lại.
- Trong lúc tablet chưa báo, server cắt lại các mục đó khỏi file cache mà thiết bị đó đẩy lên, nên bản cũ trên máy không làm mục đã xóa hiện lại.
- Tab "Tệp cài đặt" có nút **Lịch sử** (khôi phục bản cũ trên server, mọi kích thước) để xóa nhầm vẫn lấy lại được phía server.
- Không làm: xóa `document|…` ở `ft_map_server_v1.xml`, xóa bản chép `.json` ở `Documents/Gamwing/keymap_cache`, công tắc tắt lệnh xóa trong app, đăng nhập.

## Thêm sau: kiểm tra đồng bộ và báo tên mục đã xóa (2026-10-13)

- **Dấu vân tay**: `{name, bytes (utf-8), sha256 (của văn bản)}`; server (`verify.js`) và app (`SyncEngine.localDigests`) tính giống hệt nhau.
- **Trên server** (`GET /admin/api/sync/verify`): bản mới nhất của từng file so với file cùng tên trong **ngày sao lưu mới nhất** (`backups.list()[0]`): `different`, `missing_in_day`, `extra_in_day`. Chưa có ngày nào: `ok:false, reason:"no_backup_day"`.
- **Trên app**: app lấy `GET /admin/api/sync/manifest` (bản mới nhất và ngày mới nhất) rồi tự so file trên máy: giống / khác bản mới nhất / chỉ có trên máy / chỉ có trên server / khác ngày mới nhất. Lỗi mạng là một kết quả (`error`), không phải ngoại lệ.
- **Sau mỗi lần đẩy** (tay hoặc Tự đẩy): `checkAfterPush(names)` so các file vừa gửi với ngày mới nhất; không báo file "chỉ có trên server"; ghi một dòng vào nhật ký việc đã làm.
- **Web nhờ app** (`POST /admin/api/sync/verify-request`): lệnh `verify_sync` cho các thiết bị đã biết; kết quả (`verify`) trong `results` của lệnh; trạng thái `attention` nếu có khác biệt hoặc lỗi.
  Máy đã biết mà không bao giờ trả lời (ví dụ máy cũ) giữ lệnh ở trạng thái "đang chờ" tới 14 ngày; dùng "Quên thiết bị" để loại: quên máy nào thì máy đó cũng bị bỏ khỏi `targets` của mọi lệnh còn chờ nó (`Commands.dropTarget`), máy đã trả lời thì giữ nguyên làm lịch sử.
- **Tên mục đã xóa**: lệnh xóa mang `labels` (theo thứ tự `ids`, từ `items` của web); app ghi "đã xóa trên máy: «tên» (map|id)" vào nhật ký và vào danh sách việc đã làm (lưu trong SharedPreferences, 40 dòng gần nhất, hiện trên màn hình app).
- Giao diện: thẻ "Kiểm tra đồng bộ" ở tab Sao lưu theo ngày (hai nút, kết quả cập nhật mỗi 3 giây tới 2 phút khi chờ máy) và hai hành động trong Tìm nhanh.

## Thêm sau: sửa độ giật trên web và bảo vệ bản sửa (2026-10-14)

- **Sửa đường cong** (`admin/recoil.js`: `checkCurve`, `applyCurveEdit`, `removeEntry`, `isZeroWeapon`; có test trong `recoil.test.js`): chỉ nhận số hữu hạn (một giá trị `Infinity` bị `JSON.stringify` thành `null` và làm hỏng app); sửa đúng bộ dữ liệu mà `pickDataset` đang hiển thị; sửa mục CUỐI của khóa trùng (mục app dùng); tổ hợp chưa có mục riêng được tạo mục mới; không tạo nhóm súng trống; súng `Empty`/`MORTAR` không sửa. Ô nhập sai được đánh dấu (`aria-invalid`) và khóa nút Lưu.
- **Ghi lại một mục**: `CacheXml.replaceMapItem` thay đúng `map|<id>`; thử trên file thật: sửa không đổi gì thì file giữ nguyên từng byte.
- **Bản sửa trên web chưa xuống máy** (`databases.js`: `.webedits.json`, `filterDevicePush`): `PUT` từ trang web làm đổi nội dung thì đánh dấu file (xóa mục của cache KHÔNG đánh dấu: tablet tự cắt theo lệnh, bản đẩy của nó vẫn được nhận, mục đã xóa vẫn bị cắt). Lần đẩy của máy với nội dung KHÁC bị bỏ vào `skipped` (lý do hiện ở app); đẩy đúng nội dung hiện có thì bỏ dấu (máy đã nhận). `DELETE …/web-edit` bỏ dấu thủ công. Dấu không hết hạn, nhưng luôn hiện trên web (tab Tệp cài đặt, trang phân tích).
- **`PUT` kiểm tra XML** bằng cùng bộ phân tích của trang (`CacheXml.parse`): rỗng, HTML, JSON bị từ chối (400). Bộ phân tích không bắt thẻ lồng sai, nên đây không phải kiểm tra well-formed đầy đủ.
- **CSS**: không có bước build Tailwind. Các class tiện ích không có luật trong `app.css` (225 loại) đã bị gỡ khỏi JS/HTML; so 3604 phần tử ở 24 tình huống (sáng/tối, 1440 và 390 px, mọi tab) trước và sau: giống hệt. `tailwind.config.js` bị xóa. Viewport không còn `maximum-scale=1` (cho phép phóng to).
- Hộp xác nhận "bỏ thay đổi chưa lưu" dùng hộp thoại của trang thay cho `confirm()` của trình duyệt.
- **Menu thu gọn được** (`#nav-toggle`, `html[data-nav="collapsed"]`, `theme.js` khôi phục trạng thái trước khi vẽ để không nháy): cột trái 240 → 64 px, nhãn ẩn nhưng mỗi nút giữ `aria-label` và `title`; Ctrl+B không kích hoạt khi đang gõ trong ô nhập; không có trên màn hình hẹp (thanh ngang).
- **Sửa lỗi căn giữa menu**: class `items-center` còn luật thật trong `app.css` làm các nút của cột `#nav` co theo chữ rồi nằm giữa; đã bỏ các class tiện ích xung đột khỏi thanh bên và đặt `align-items: stretch` cho `#nav`.
- **Mốc tự tính, cộng dồn** (`recoil.js`: `STEP`, `stepTime`, `stepDelta`, `stepValue`, `nextPoint`, `cascadeFrom`; test trong `recoil.test.js`): thời gian cộng 450–678 ms (số nguyên); giá trị cộng 1,02–1,35 (Tăng), trừ (Giảm) hoặc ngẫu nhiên, bước có hai chữ số thập phân. Mỗi mốc dựa vào mốc đứng trước nó. Lịch sử yêu cầu: lúc đầu thời gian 1032–1153 ms; giá trị từng được làm theo hệ số nhân/chia 1,02–1,35 (hiểu "lũy tiến" là nhân dồn) rồi người dùng chốt lại là cộng như thời gian. Giá trị có thể xuống dưới 0 khi chọn Giảm; trang không chặn. Sửa thời gian chỉ tính lại cột thời gian của các mốc sau, sửa giá trị chỉ tính lại cột giá trị.
- **Thêm tổ hợp không trùng** (`findDuplicateCombo`, `comboKey`): trùng khi đã có mục riêng, đã có trong danh sách trên trang (chưa lưu), hoặc là hàng "không phụ kiện" luôn có sẵn; hộp thoại cảnh báo ngay và không thêm bản thứ hai. Thêm một tổ hợp khi đường cong bên phải đang sửa dở sẽ hỏi trước khi bỏ thay đổi.

## Thêm sau: tính mốc bằng server và AI, so sánh rồi chọn một (2026-10-14)

- **Quyết định của người dùng**: hai bên chạy SONG SONG và độc lập; hộp thoại so sánh hiện cả hai; chỉ được chọn MỘT. Mặc định mình chọn: súng tương tự theo dữ liệu, model `auto`, kết quả điền vào ô sửa chưa lưu.
- **Server** (`suggest.js`, `RecoilLib.computedFor`): đường cong theo hệ số × độ lệch thật trung bình của các súng tương tự (khoảng cách giữa hai đường nền = trung bình |ln tỉ lệ giá trị| tại 8 điểm chia theo thời lượng + nửa |ln tỉ lệ thời lượng|; trọng số 1/(khoảng cách + 0,05)). Kiểm tra giấu từng mục (leave-one-out, 5800 ca thật): sai số trung bình 8,9% → 4,0%, trung vị 7,3% → ~0%, tốt hơn hệ số ở 66% ca; ngang nhau ở các tổ hợp chỉ nòng hoặc chỉ báng; tư thế nằm có quá ít dữ liệu (8 ca).
- **AI** (`ai.js`): một yêu cầu một lúc, hủy được (đóng hộp thì `AbortSignal`), hết giờ, kiểm tra chặt đầu ra; khóa chỉ ở server (`.env` bị git/Docker bỏ qua). Câu trả lời của API không chứa khóa hay địa chỉ (có test).
- **Giao diện** (`admin/suggest-ui.js`): hai thẻ radio (đúng một lựa chọn), nút "Dùng kết quả đã chọn" khóa cho tới khi chọn được một kết quả hợp lệ; AI chậm thì server vẫn chọn được; AI lỗi hoặc chưa bật thì chỉ thẻ server dùng được; biểu đồ chồng đường cong theo hệ số, server, AI và đường đang có trong ô sửa (khác nhau cả màu lẫn kiểu nét). `showModal` có thêm `onOpen` và `disabled` cho nút.

## Thêm sau: gợi ý thêm tổ hợp (2026-10-14)

- **Yêu cầu**: ở mục Tổ hợp, AI cũng tự gợi ý thêm tổ hợp, hiển thị mờ bên dưới, có nút chọn luôn hoặc thêm tay.
- **Phát hiện từ dữ liệu thật** (70 súng, tập touch): các súng gần như có cùng bộ khóa (đứng ~55, ngồi ~31, nằm 0–2), nên "súng tương tự có mà súng này chưa có" cho 0–1 gợi ý mỗi màn hình. Vì vậy thêm tiêu chí thứ hai có số liệu: sai số trung bình của đường cong theo hệ số theo từng loại tổ hợp (`kindErrors`, 12 điểm so sánh theo thời lượng chuẩn hóa; ~45 ms cho cả 5800 mục): tay cầm + báng ~17%, tay cầm + nòng + báng ~9,6%, tay cầm + nòng ~9,3% (đứng) và ~11% (ngồi), chỉ nòng ~1%, chỉ báng ~2,6%; tư thế nằm có quá ít dữ liệu.
- **Chọn ứng viên** (`comboCandidates`): điểm = (gap: 1000 + độ ủng hộ × 100) + sai số kỳ vọng × 100 + 0,5 × số súng tương tự sở hữu + độ phổ biến của từng phụ kiện × 0,001; tối đa 3 ứng viên "hệ số hay sai" mỗi loại; mặc định 8, ngưỡng sai số 6%, loại cần ≥ 30 mẫu.
- **AI chỉ xếp hạng** (`rankCombos`, hàng chờ riêng với việc tính mốc để hai việc không làm nhau "bận"): trả về chỉ số trong danh sách + lý do; chỉ số lạ, trùng bị bỏ; không thêm tổ hợp mới. Tự gọi nền sau 0,6 giây; đổi súng/tư thế hoặc rời tab thì hủy.
- **Giao diện**: danh sách mờ (độ mờ 0,62, rõ hẳn khi rê chuột/focus, nút luôn rõ) nằm NGOÀI vùng cuộn ngang của bảng (bản đầu để thành dòng của bảng thì nút bị cắt ở mép phải); cập nhật tại chỗ nên không làm mất con trỏ khi đang gõ mốc; Thêm khi còn sửa dở thì hỏi trước.

## Thêm sau: quy tắc phụ kiện theo súng (2026-10-14)

- **Yêu cầu**: đối chiếu bảng phụ kiện từng súng (người dùng cung cấp) với mã súng, đưa ra quy tắc để không thêm phụ kiện súng không hỗ trợ.
- **Phát hiện**: dữ liệu thật KHÔNG mã hóa khả năng lắp phụ kiện: 62/70 súng có đúng một bộ tổ hợp mẫu (tay cầm ngang/nhẹ/ngón cái/công thái học, nòng hãm giật/ẩn tia lửa, báng Tactical) kể cả AWM và AKM; 3 súng thêm tay cầm laser, 3 súng thêm giảm thanh, SVD chỉ có đường nền. Nên không thể kiểm chứng bảng bằng dữ liệu.
- **Quy tắc** (`RecoilLib.ATTACHMENT_RULES`, `attachmentsFor`, `comboProblems`, `describeAttachments`): 30 súng có trong bảng (có DP28 sau khi người dùng bổ sung), 38 súng không có (không hạn chế). Lựa chọn không có trong bảng (laser, công thái học, brake, extender, brake mới, báng mới) được coi là không hỗ trợ vì khẳng định ngược lại thiếu căn cứ; ốp má, Bullet Loops, Choke, Duckbill, băng đạn không có chỗ trong danh sách phụ kiện của app.
- **Nơi áp dụng**: gợi ý (`comboGaps`, `comboCandidates`, tham số `allowed` thay được quy tắc; vì thế số tổ hợp có thể thêm của AUG giảm từ ~154 xuống ~20), hộp Thêm tổ hợp (lựa chọn bị khóa + kiểm tra lại khi bấm), "Hiện mọi tổ hợp", thanh ống ngắm, và `applyCurveEdit` (tạo mục MỚI cho phụ kiện không hỗ trợ bị từ chối, sửa mục đã có thì được; `allowUnsupported` là lối thoát). Các mục riêng đã có trong file KHÔNG bị đánh dấu hay đổi, vì dữ liệu mẫu chứa nhiều mục mà bảng coi là không lắp được.
- **Chỉnh sau**: người dùng sửa ống ngắm tối đa: M416 và AR không báng 6x; Vector, UMP45 6x; Tommy Gun chỉ 1x; SR và DMR 8x (trước đó 8x/8x/không giới hạn/không giới hạn/15x); bổ sung DP28 (súng máy): không nòng, tay cầm, báng, ống ngắm 6x. "DB28" trong tin nhắn được hiểu là mã `DP28` của app.

## Thêm sau: bảng phụ kiện chính thức làm nguồn cho quy tắc và cho AI (2026-10-14)

- **Nguồn dữ liệu**: kho vũ khí chính thức của 和平精英 (`https://gp.qq.com/zlkdatasys/data_zlk_hpjywqzlk1.json`; 45 vũ khí, 44 phụ kiện kèm "súng áp dụng"; trang ghi lấy thông số trong game làm chuẩn). Mỗi súng có đoạn "可装配枪口/弹匣/瞄准镜/握把&枪托". 33 súng khớp mã của app. Bảng được SINH từ dữ liệu này (không gõ tay) và ghi nguồn từng súng (`official`, `appmedia` cho FAMAS và MK12, `user` cho ACE32).
- **Thay đổi so với bảng người dùng đưa lúc đầu** (27 súng có đối chiếu): Laser thuộc nhóm tay cầm (hầu hết súng có tay cầm gắn được); Groza chỉ giảm thanh; Mk47 và M16A4 có báng chiến thuật; Tommy Gun gắn được tay cầm đứng; Vector không có tay cầm tam giác và ngón cái; SLR và Mk14 không có tay cầm; VSS không có nòng và không lắp ống ngắm; S1897 và S686 không lắp ống ngắm. Thêm 5 súng: CrossBow, MG3, DBS, Bison, Win94 (DP28 đã có).
- **Chưa áp dụng**: Mosin, M1014, MP5K, P90, AMR (một nguồn thứ cấp). Không đủ dữ liệu: M417, JS9 và 22 mã khác; chúng không bị hạn chế.
- **AI dùng bảng**: `ai.js` thêm `accessory_rules` (những gì súng lắp được, nguồn, ống ngắm tối đa; hoặc ghi chú "không có quy tắc, đừng giả định hạn chế" cho súng chưa có bảng) và `combination_problems` vào câu hỏi tính mốc; `accessory_rules` vào câu hỏi xếp hạng. Ứng viên luôn được lọc bằng `comboProblems` trước khi tới AI. Sau khi đổi bảng, số tổ hợp có thể thêm của AUG là 20 (báng bị loại, Laser được thêm; trước đó 154 khi chưa có quy tắc).
- **Giao diện**: dòng tóm tắt phụ kiện của súng hiện kèm nguồn trong tooltip và trỏ tới file Excel.

## Thêm sau: bộ lọc kiểu Excel cho bảng Tổ hợp (2026-10-14)

- **Logic** (`admin/tablefilter.js`, test `tablefilter.test.js`): bộ lọc một cột là `{ values: Set|null, min, max }` (`values` rỗng = ẩn hết như bỏ chọn hết trong Excel; `min`/`max` gồm cả hai đầu, giá trị không phải số không qua được ngưỡng); `applyFilters` (và giữa các cột), `distinct` (danh sách giá trị kèm số dòng, tính trên các dòng mà bộ lọc của cột KHÁC cho qua), `sortRows` (ổn định cả khi giảm dần; thứ tự tiếng Việt: A D Đ E Ê; trống, rồi số, rồi chữ), `describe`.
- **Giao diện** (`admin/filter-ui.js`): nút phễu trong `<th>` mở hộp `role=dialog` gắn vào body (không bị cắt bởi vùng cuộn ngang), áp dụng bằng OK để trang chỉ vẽ lại một lần; Esc, Hủy, bấm ra ngoài, cuộn hoặc đổi cỡ cửa sổ thì đóng. `aria-sort` trên `<th>`, `aria-expanded` trên nút. Cột giá trị liên tục (t=0, giá trị cuối) chỉ có khoảng số và sắp xếp, không có danh sách.
- **Áp dụng**: bảng Tổ hợp của tab Độ giật / Cấu hình (8 cột). Hộp Thêm tổ hợp không bị ảnh hưởng (dùng toàn bộ tổ hợp, không chỉ các dòng đang hiện); danh sách gợi ý mờ thì có (mục dưới). Thành phần dùng chung, gắn cho bảng khác chỉ cần truyền `rows`, `valueOf`, `filters`, `sort`, `onChange`.

### Gợi ý (server + AI) theo bộ lọc, nút "AI tạo lại" (2026-10-14)

- **Server chọn ứng viên TRONG phạm vi lọc** (không lọc sau): `comboCandidates(idx, target, { constraints: { grips, muzzles, stocks } })`, mỗi slot là các chỉ số enum mà bộ lọc của cột Tay cầm / Nòng / Báng cho qua (không có = tự do). Kết hợp VỚI quy tắc phụ kiện của súng, không thay thế. Nhờ vậy lọc "Tay cầm: ngón cái" ra đủ danh sách ứng viên tốt nhất của riêng ngón cái, không phải phần còn sót của danh sách chung. `total` đếm theo phạm vi đã lọc. Mỗi ứng viên có `stats { v0, vEnd, duration, points }` (từ đường cong theo hệ số) để các cột số của bảng lọc được cả gợi ý.
- **API**: `combo-suggestions` và `rank-combos` nhận `filter: { grips: [int], muzzles: [int], stocks: [int] }` (sai kiểu/ngoài phạm vi: 400); `rank-combos` nhận thêm `regenerate: true`. Không có `filter` thì hành vi như trước.
- **AI**: câu hỏi xếp hạng có thêm `user_filter` (tên enum của những gì đang lọc) và `regenerate: true` khi người dùng bấm "AI tạo lại"; lúc đó `temperature` 0,7 (mặc định 0,2) để có ý kiến mới thay vì lặp lại thứ tự cũ. Không có thì không ghi trường nào.
- **Giao diện** (`admin/analysis.js`): khóa gợi ý gồm cả bộ lọc ba cột phụ kiện, nên đổi lọc thì tải lại gợi ý và AI tự xếp hạng lại (sau 600 ms). Các cột còn lại (Nguồn, giá trị t=0, giá trị cuối, thời lượng, mốc) lọc ngay trên trang bằng cùng `TableFilter`, không gọi lại AI. Nếu bảng đang sắp xếp thì gợi ý xếp theo đó, không thì theo thứ hạng AI. Lọc xong không còn gợi ý nào thì có dòng "Không có gợi ý nào khớp bộ lọc của bảng" kèm nút Xóa bộ lọc (không nói vậy khi các gợi ý chỉ vì đã là dòng của bảng, như khi bật "Hiện mọi tổ hợp"). Nút **AI tạo lại** nằm ở đầu danh sách; tắt khi AI chưa bật hoặc đang chạy; nếu AI lỗi thì thứ hạng cũ được giữ.

## Thiết kế lại giao diện web (2026-10-14)

Mục tiêu: hiện đại, dễ thao tác, ít rối mắt, ít thông tin nhưng đủ, **giữ nguyên logic** (không đổi API, dữ liệu, thứ tự bước xác nhận, các cờ "chưa lưu"; toàn bộ test vẫn đạt).

- **Hệ thống thiết kế** (`admin/app.css`, viết lại từ đầu, không còn `!important` chắp vá): token màu sáng/tối trung tính + một màu nhấn (`--accent`); thẻ phẳng viền mảnh, bán kính 14/10; chữ nền 14 px, tiêu đề trang 24 px; tiêu đề cột bảng không viết hoa; huy hiệu nền nhạt không viền; hộp thoại không còn dải màu trên cùng. Bỏ hàm tự chèn lớp Tailwind trong `ui.js` (trang không nạp Tailwind nên các lớp đó không có tác dụng) và các chuỗi lớp thừa.
- **Khung**: sidebar 224 px (68 px khi thu gọn), cuối sidebar chỉ có một dòng trạng thái máy tính bảng (chấm + "đang kết nối" / "chưa kết nối"; câu đầy đủ trong tooltip), số file / ngày sao lưu / phiên bản chuyển vào tooltip của logo. Đường dẫn trên thanh công cụ ẩn khi chỉ có một cấp. Mọi tab dùng chung `Ui.pageHead(tiêu đề, một dòng mô tả, nút của trang)`.
- **Phân tích cache**: hàng chỉ còn tên, "Đang dùng", ngày, dung lượng; đường dẫn `map|…`, danh sách, thư mục, id nằm trong "Nơi lưu (chi tiết kỹ thuật)" của Inspector. Nút Mở hiện khi rê/chọn; Xóa chuyển vào menu ba chấm và Inspector. Dòng "không có bất thường" và thẻ "Lệnh xóa gần đây" rỗng bị bỏ (chỉ hiện khi có cảnh báo / có lệnh).
- **Tệp cài đặt**: bảng 3 cột (file, dung lượng, cập nhật); thư mục trên máy sang Inspector; phần giải thích dài thành mục "Lưu ý" gập.
- **So sánh ngày / Sao lưu theo ngày / Thiết bị**: mô tả một dòng; kiểm tra đồng bộ là một thẻ hai nút, kết quả chỉ hiện sau khi chạy; ngày sao lưu là danh sách gọn; thiết bị là bốn ô số liệu (trạng thái, tự đẩy, lần đẩy, lần lấy) và phần còn lại sau "Chi tiết kỹ thuật".
- **Độ giật / Cấu hình**: một thẻ chọn gọn (súng, tư thế, bộ dữ liệu trên một dòng; ống ngắm có dữ liệu thành nút, các ống ngắm còn lại và quy tắc phụ kiện sau một dòng gập); bảng tổ hợp thu nhỏ, nút sửa/xóa hiện khi rê chuột, khi cột danh sách hẹp (có chi tiết bên phải) các cột phụ (Nguồn, giá trị cuối, thời lượng, mốc) tự ẩn bằng container query (bộ lọc trên các cột đó vẫn có hiệu lực, đếm trong "Xóa bộ lọc (n)"); chi tiết một tổ hợp: tiêu đề + trạng thái + nút Lưu + menu (lịch sử, sao chép JSON, xóa mục riêng), biểu đồ, bảng mốc, nút thêm/tính/hoàn tác, nút Lưu thứ hai dưới bảng, rồi các mục gập (tùy chọn tự tính, cách tính và hệ số, so sánh tư thế).
- **Hộp thoại**: "Thêm tổ hợp" còn ba ô chọn trên một hàng, một dòng tham chiếu (nguồn, hệ số, t=0 → cuối, thời lượng, số mốc) và quy tắc phụ kiện gập; bước 1 của xóa chỉ hiện danh sách, cảnh báo đóng Gamwing và một mục gập giải thích.
- **Điện thoại**: dưới 1024 px sidebar thành thanh trên cuộn ngang; bảng "stack" thành thẻ; hộp thoại trượt từ dưới lên.

## Thêm sau: AI tạo mốc, Lưu tất cả, lưu mượt (2026-10-14)

- **Bản nháp** (`rc.drafts`: khóa `recoilKey` → `{ curve, source: 'ai' | 'server' | 'edit' }`): mốc làm cho tổ hợp mới thêm, chưa ghi vào file. Mở tổ hợp đó thì bắt đầu từ bản nháp (và sửa trực tiếp trên nó); chuyển sang tổ hợp khác không hỏi "bỏ thay đổi" với tổ hợp mới (phần sửa thành bản nháp). Mở mục khác thì bản nháp và danh sách tổ hợp thêm tay được xóa (chúng thuộc một mục).
- **AI tạo mốc (n)**: lần lượt từng tổ hợp mới chưa có bản nháp, hỏi server (`/recoil/suggest`) và AI (`/ai/suggest-curve`) cùng lúc; dùng kết quả AI nếu hợp lệ (`checkCurve`), không thì của server. Dừng được (hủy yêu cầu đang chờ, giữ những cái đã xong). Không ghi gì.
- **Lưu tất cả (n)**: gom tổ hợp mới (bản nháp, hoặc đường cong theo hệ số nếu chưa có) và tổ hợp đang mở đã sửa; kiểm tra hết (`checkCurve`, `comboProblems`) trước khi ghi; áp dụng lần lượt bằng `applyCurveEdit` lên cùng một bản sao; **một** lần `PUT`. Hộp thoại không đóng được trong lúc làm: thanh phần trăm (áp dụng 0–45%, tạo XML 50%, gửi 60%, cập nhật 92%, xong 100%), bốn bước và dòng chi tiết; lỗi thì báo "chưa có gì được ghi" và chờ bấm Đóng.
- **Lưu mượt**: sau `PUT` trang dùng ngay `etag` trả về và nội dung vừa ghi (không tải lại 6 MB, không có trạng thái trống); `redraw` giữ chiều cao cũ trong lúc thay nội dung (không nhảy cuộn, không nháy) và dùng `document.startViewTransition` (mờ dần) sau khi lưu nếu trình duyệt có và không bật giảm chuyển động.

## Thêm sau: liệt kê / thêm tất cả tổ hợp còn thiếu, bảng không kéo ngang (2026-10-14)

- **Vì sao chỉ có 6**: `comboCandidates` chọn tối đa `limit = 8` ứng viên "đáng làm trước" (có súng tương tự đã có, hoặc loại tổ hợp mà `kindErrors` ≥ `minError`; tối đa `perKind = 3` mỗi loại) và giao diện hiện `MAX_GHOST = 6`; AI chỉ xếp hạng chúng. Các tổ hợp còn lại không bị chặn, chỉ không được đề xuất.
- **`missing`**: kết quả của `comboCandidates` (và `combo-suggestions`) có thêm `missing` = mọi tổ hợp súng này lắp được (`rulesAllowed` + `constraints` của bộ lọc) chưa có mục riêng, tốt nhất trước, mỗi mục có `stats`; `total = missing.length`; `candidates` là một phần của nó. `rank-combos` vẫn chỉ nhận `candidates`.
- **Giao diện**: `st.missing`; "Hiện thêm n tổ hợp còn thiếu" (`MAX_GHOST_ALL = 300`) và **Thêm tất cả (n)** (`addAllSuggested`: thêm vào `rc.customCombos`; hỏi trước khi thêm trên 40; n đếm theo bộ lọc của bảng, cả cột số); **Lưu tất cả** có ở đầu danh sách và ở đầu gợi ý (`saveAllButton`, số đếm cập nhật khi gõ qua `paintSaveAll`).
- **Không kéo ngang**: danh sách là container (`container-type: inline-size`); dưới 960 px bề ngang mỗi dòng `.combo-table` thành lưới 12 cột hai dòng (tay cầm / nòng / báng; nguồn / t=0 / cuối / thời lượng / mốc / nút) với chú thích `data-label`, đầu bảng (nút lọc) xuống dòng; không còn cột bị ẩn. `.curve-table` dùng `table-layout: fixed` theo phần trăm; `.table-card table` bỏ `min-width`. Đã quét mọi tab ở 1440 / 1100 / 900 px: không phần tử nào có `scrollWidth > clientWidth`.

## Thêm sau: M249 và kiểm tra các mục riêng theo bảng chuẩn (2026-10-14)

- **M249** được áp dụng (`rule([], [], [], 6, 'official')`, như DP28 và MG3): người dùng xác nhận không có tay cầm và chỉ ống ngắm đến 6x (không 8x, 4–8x). Bảng chuẩn có 36 súng; còn chờ: Mosin, M1014, MP5K, P90, AMR. Workbook `docs/PhuKien_Sung_PUBG_Mobile.xlsx` đã cập nhật dòng M249 ("Đã áp dụng").
- **`RecoilLib.auditEntries(idx)`** liệt kê mọi khóa (mục riêng) của bộ dữ liệu mà `comboProblems` báo sai (kèm số bản trùng); **`removeEntries(doc, mode, list)`** xóa mọi bản của các khóa trong một lần sao chép (không sao chép mỗi tổ hợp một lần). Test `audit.test.js`.
- **Giao diện** (`showAuditModal`, `deleteAudited`): nút "Kiểm tra theo chuẩn (n)" và dòng cảnh báo theo súng đang xem; cửa sổ nhóm theo súng (súng đang xem trước, mở ra mới vẽ từng mục), ô "Chọn tất cả mục dư" + ô theo súng + ô từng mục, ban đầu không chọn; xóa qua xác nhận rồi hộp thoại tiến trình (gom → tạo XML → gửi → cập nhật trang) bằng đúng `putRecoilItem` của Lưu tất cả (một `PUT`, cờ "sửa trên web chưa xuống máy" được đặt như mọi lần sửa từ web).

## Thêm sau: tạo đủ tổ hợp cho cả súng, lưu tất cả theo cả mục, tab Tiêu chuẩn súng (2026-10-14)

- **Lưu tất cả / AI tạo mốc theo cả mục**: `pendingCombos()` lấy mọi khóa trong `rc.customCombos` (đúng súng, ống ngắm, tư thế của chúng) chưa có mục riêng, không chỉ phần đang hiện; `recoilKey(o)` dùng súng/ống ngắm/tư thế của chính `o`. `RecoilLib.curveEditor(doc, mode)` sao chép tài liệu MỘT lần rồi `apply` từng tổ hợp (`applyCurveEdit` giờ gọi nó); trước đây mỗi tổ hợp một lần sao chép 4 MB.
- **`fillGun(ix)`**: `scanGun` gọi `combo-suggestions` cho từng (ống ngắm hợp lệ, tư thế 0–2) và gom `missing`; hỏi xác nhận (tóm tắt theo ống ngắm, số tổ hợp nhờ AI); tính mốc song song 6 yêu cầu (`/recoil/suggest`: súng tương tự, không có thì đường cong theo hệ số), AI tuần tự cho top K theo `priority` (`gap.support`, `expectedError`), kết quả AI phải qua `checkCurve` và `plausible` (đầu, cuối, thời lượng trong vùng ±40/40/50% đường cong hệ số); kiểm tra lại (`checkCurve`, `comboProblems`, quét lần hai: mọi `missing` phải nằm trong kế hoạch), rồi thêm vào `rc.customCombos` và `rc.drafts` (`suspect` = lệch nhiều: nhãn "xem lại"). `Ui.progressDialog` có thêm `setStop` và `result(lines, buttons)`. Đo trên dữ liệu thật: AUG 605 tổ hợp / 24 cặp, tạo trong ~50 giây (3 tổ hợp nhờ AI giả), lưu một lần ~9 giây, quét lại không còn thiếu gì.
- **`standards.js`** (tab "Tiêu chuẩn súng", `window.Standards.view`): một hàng cho mỗi mã trong `WEAPONS` (trừ `Empty`), `M416 (22)`; cột loại (bảng `GUN_CLASS` trong tệp), nòng/tay cầm/báng/ống ngắm từ `attachmentsFor`, trạng thái (có quy tắc / `WAITING` / `isZeroWeapon` / chưa có nguồn); bộ lọc `TableFilter`/`FilterUi`; ô chi tiết bên phải; "Đối chiếu với dữ liệu thật" đọc `gamwing_keymap_cache.xml`, `indexData` + `auditEntries` cho hai cột số mục riêng / sai chuẩn; bảng dùng container query (dưới 700 px mỗi súng thành ba dòng), không kéo ngang.

- **Song song (AI_CONCURRENCY, mặc định 3, tối đa 8)**: `createAi` giữ tối đa N yêu cầu điểm cùng lúc (xếp hạng vẫn một); `/ai/status` trả thêm `concurrency`. Trang dùng `min(4, concurrency)` luồng (`runPool`) cho "AI tạo mốc" và bước AI của "Tạo đủ cho cả súng", đợi rồi thử lại tối đa 4 lần khi gặp "bận" hoặc HTTP 429/5xx (`askAi`). Đo trên cổng model miễn phí của người dùng: 1 đến 8 yêu cầu đồng thời đều thành công, từ khoảng 8 trở lên mỗi yêu cầu chậm gấp nhiều lần vì cổng chuyển sang model dự phòng chậm hơn, nên 3 đến 4 là hợp lý. Đo trình duyệt: 6 tổ hợp, mỗi cái 2 giây, mất khoảng 4,2 giây thay vì 12 giây.
