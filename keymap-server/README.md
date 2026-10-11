# ft-keymap-server

Server lưu keymap tự host, nói cùng "hợp đồng" HTTP mà client (`FtMapRouter` và `C8870a`) mong đợi
từ server keymap FT. Không có thư viện ngoài, cần Node >= 20.

```
npm start        # lắng nghe trên PORT (mặc định 8787)
npm test         # 21 test: hợp đồng với client, các lỗi đã sửa, giao diện quản trị
```

## Chạy bằng Docker (khuyên dùng)

```
docker compose up -d --build     # build và chạy nền
docker compose logs -f           # xem log
docker compose down              # dừng; dữ liệu nằm trong volume "ftdata" nên không mất
```

- API keymap: `http://<máy>:8787/…` (đúng hợp đồng bên dưới).
- **Giao diện quản trị: `http://<máy>:8787/admin`** — tách rõ ba loại file theo namespace (server gán `kind`):
  **Sơ đồ phím** (mọi namespace khác), **Nhận diện AI** (`com.zjx.pubg.recognition.*`) và
  **Độ giật / Cấu hình** (`com.zjx.pubg.rcConfig2`). Xem/tìm JSON, tải, xóa, xem và xóa mã chia sẻ,
  nhập file backup `list|…` và `map|…` lấy từ `Documents/Gamwing/keymap_cache/` của điện thoại.
- **Sửa JSON trực tiếp** (nút "Sửa" ở mỗi nút của cây JSON, "Sửa toàn bộ" cho file nhỏ, "Sửa siêu dữ liệu"): JSON sai cú pháp
  thì không cho lưu; mỗi lần lưu có **hộp cảnh báo** liệt kê thay đổi và kiểm tra cấu trúc; bản cũ được **tự sao lưu** (20 bản gần
  nhất, tab "Lịch sử" có So sánh / Khôi phục, khôi phục cũng hoàn tác được); nếu file đã bị nơi khác sửa từ lúc bạn mở (ví dụ app
  đồng bộ) thì từ chối ghi đè (HTTP 409). Lịch sử nằm ở `<DATA_DIR>/history/`.
- **Màn hình mô phỏng vị trí** (tab Sơ đồ phím và Nhận diện AI): chọn một bản thì bên dưới dựng màn hình với từng phím/ô đúng
  toạ độ (`base:x/y/width/height`, pixel). Bấm vào ô để xem thông số (tên phím, mã phím HID, tham số), **kéo để di chuyển**
  (Shift = làm tròn 10 px, phím mũi tên = nhích 1 px), mỗi lần đổi có thông báo "Phím «…» đã đổi vị trí: (x,y) → (x',y') — chưa lưu".
  Thay đổi nằm ở thanh "chưa lưu" cho tới khi bấm **Lưu vị trí…**, khi đó đi qua cùng hộp cảnh báo / sao lưu / lịch sử của trình sửa JSON và
  chỉ ghi đúng các số `base:*` đã đổi. Có thể chọn ảnh chụp game làm nền (chỉ xử lý trong trình duyệt) để kiểm tra gốc toạ độ
  (chưa xác nhận là góc trên-trái hay tâm ô). Nhận diện AI hiển thị thêm vùng xe (`vehicleCarRect*`). Tên loại ô nhận diện lấy từ code
  (`Extensions/pubg/C8711b.java`, `accessory_rects.json`); các tên suy ra được ghi chú trong `admin/layout.js`.
- **Sửa độ giật ngay trong tab Phân tích độ giật:** bấm vào một số (thời gian hoặc giá trị của mốc, hay một hệ số) để sửa tại chỗ
  (Enter = xác nhận, Esc = hủy). Ô đã sửa được tô màu và có nút **↺** đặt lại về giá trị đã lưu; có thêm/xóa mốc, kéo điểm trên biểu đồ
  lên/xuống, "Đặt lại cả đường cong" và "Hoàn tác tất cả". Sửa tổ hợp chưa có mục riêng (đang tính = nền × hệ số) sẽ **tạo mục riêng mới**
  khi lưu (có cảnh báo). Khi trùng khóa, sửa đúng mục cuối (mục app dùng). Bản sửa ghi vào bộ dữ liệu đang chọn và, nếu `recoil_data`
  đang giống hệt bộ đó, cập nhật luôn cho khỏi lệch. Lưu đi qua hộp cảnh báo / sao lưu / lịch sử như các chỗ khác.
- **Phân tích recoil** (tab riêng): chọn súng, tư thế, ống ngắm; bảng mọi tổ hợp tay cầm/nòng/báng với giá trị, thời gian, số mốc,
  biểu đồ đường cong, so sánh đứng/ngồi/nằm, bảng hệ số. Logic mô phỏng cách app chọn đường cong (`admin/recoil.js`, có test):
  bộ dữ liệu theo chế độ (touch/gyro), bản trùng khóa **cuối cùng** thắng, tổ hợp không có mục riêng = đường cong nền × hệ số.
- Mặc định mở cho cả mạng nội bộ. Chỉ cho máy này truy cập: `BIND=127.0.0.1 docker compose up -d`.
- **Giao diện quản trị không có đăng nhập** (chạy trong LAN tin cậy). Đừng forward cổng 8787 ra Internet. Nó chỉ chặn
  các lời gọi do trang web lạ phát ra từ trình duyệt của bạn (kiểm tra `Host`, `Origin` và header `X-Admin-Request`).
  Truy cập bằng tên miền riêng thì thêm vào `ADMIN_ALLOWED_HOSTS`. Tắt hẳn: `ADMIN_ENABLED=0`.
- Nạp cả thư mục backup bằng dòng lệnh: `python -I keymap_analysis/scripts/import_to_server.py <thư_mục> <ft_client 32 hex>`.

## Cấu hình (biến môi trường)

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `PORT`, `HOST` | `8787`, `0.0.0.0` | Địa chỉ lắng nghe |
| `DATA_DIR` | `./data` | Nơi lưu dữ liệu (`accounts/*.json`, `shares.json`) |
| `MAX_BODY_BYTES` | 8 MiB | Giới hạn body |
| `FT_ALLOWED_CLIENTS` | trống | Danh sách `ft_client` (32 hex) được phép, cách nhau bởi dấu phẩy. Trống = ai cũng dùng được |
| `TLS_KEY`, `TLS_CERT` | trống | Đường dẫn khóa và chứng chỉ để chạy HTTPS trực tiếp |
| `ADMIN_ENABLED` | `1` | `0` để tắt giao diện `/admin` |
| `ADMIN_ALLOWED_HOSTS` | trống | Tên miền được phép vào `/admin` ngoài IP, `localhost`, tên ngắn, `*.local`, `*.lan` |
| `SYNC_ACCOUNT` | `c_` + 32 số 0 | Tài khoản mà app Android đồng bộ và mà sao lưu theo ngày áp dụng |
| `BACKUP_TZ` | `Asia/Ho_Chi_Minh` | Múi giờ dùng để tính "hôm nay" cho thư mục sao lưu (container chạy giờ UTC nên cần đặt) |
| `BACKUP_KEEP_DAYS` | `0` | Giữ bao nhiêu ngày sao lưu; `0` = giữ hết, không tự xóa |

Client gốc dùng HTTPS cho server FT, nên khi đưa ra ngoài hãy đặt sau reverse proxy có TLS
(Caddy, nginx, Cloudflare Tunnel) hoặc dùng `TLS_KEY`/`TLS_CERT`.

## Endpoint

Mọi endpoint (trừ `/health`) cần header `Login-Token` dài từ 8 ký tự. Dữ liệu được tách theo tham số
`ft_client` mà client tự thêm vào URL; nếu thiếu thì tách theo hash của token.
Mọi phản hồi JSON đều có `ft_server: true`, vì client chỉ chấp nhận JSON thường khi có trường này.

| Method và path | Việc làm |
|---|---|
| `GET /v2/keymap_list/{ns}` | Danh sách: `selected_keymap_id`, `keymaps[{id, add_time, is_official, metadata(chuỗi JSON)}]` |
| `GET /v2/keymap/{id}` | Chi tiết: `keymap`, `metadata` (chuỗi JSON), `isOfficial`, `bundleId` |
| `POST /v2/keymap/{ns}` | Tạo (body `keymap`, `metadata`). Với `?share_code=` thì sao chép từ mã chia sẻ. Trả `keymap_id` |
| `POST /v2/keymap/update/{id}` | Cập nhật `keymap`, `metadata` |
| `POST /v2/keymap/select/{id}` | Chọn keymap đang dùng của namespace |
| `DELETE /v2/keymap/{id}` | Xóa. Id lạ trả **404** (client bản .6 chỉ failover sang server gốc khi không phải 2xx) |
| `GET /v2/keymap/share/{id}?prefix=&valid_count=` | Tạo mã chia sẻ `ankm2ft…`, `yqa3_ft…`, `yqg3_ft…` (24 hex) |
| `GET /v2.1/keymap/share/{code}` | Đọc nội dung từ mã chia sẻ |
| `POST /ft/v1/migration/import` | Nhập theo trang, giữ nguyên `id` cũ; `reset: true` xóa namespace trước |
| `POST /ft/v1/migration/verify` | So manifest `[{id, sha256}]`, trả `state: "VERIFIED"` |

`POST` có `Idempotency-Key` sẽ được phát lại đúng phản hồi lần đầu (giữ 200 khóa gần nhất mỗi tài khoản).

## Đồng bộ với app Android (`android-sync/`)

App riêng (không đăng nhập) đẩy/nhập thư mục cache keymap của điện thoại qua 3 endpoint dưới đây. Chúng làm việc với **một tài khoản đồng bộ
mặc định** (`SYNC_ACCOUNT`, mặc định `c_` + 32 số 0), nên app không cần mã tài khoản, và dùng cùng lớp bảo vệ như giao diện quản trị
(`Host` hợp lệ, header `X-Admin-Request: 1` khi ghi). Không có đăng nhập: chỉ dùng trong mạng nội bộ tin cậy.

| Endpoint | Việc làm |
|---|---|
| `GET /admin/api/sync/info` | `{ok, server, version, account, accounts, docs}` để app hiện "Đã kết nối tới … (server keymap, N tài khoản)" |
| `POST /admin/api/sync/push` | Body `{files:[{name,text}]}` (file `list%7C…` / `map%7C…`). Tạo mới, **cập nhật nếu khác** và **chép bản cũ vào lịch sử** (20 bản/keymap), bỏ qua nếu giống hệt, không bao giờ xóa. Có thể chỉ gửi `map` (keymap đã có) hoặc chỉ gửi `list` (đổi tên, đổi bản đang chọn) |
| `GET /admin/api/sync/pull` | Trả `{files:[{name,text}]}` đúng dạng cache của điện thoại (tên file có `%7C`) |
| `POST /admin/api/sync/hello` | Nhịp tim của app (mỗi 15 giây): `{id,name,model,android,app_version,ip,auto_push,folder,state,error}`. Trả `{online, web:{sessions}}` để app biết trang web có đang mở |
| `GET /admin/api/sync/devices`, `DELETE /admin/api/sync/devices/<id>` | Danh sách thiết bị (online nếu có nhịp trong 40 giây; lưu tối đa 50 máy trong `devices.json`) / quên một thiết bị |
| `POST /admin/api/presence` | Trang web báo `{session}` mỗi 10 giây (tính là đang mở nếu có tín hiệu trong 30 giây) |
| `POST /admin/api/sync/databases/push` | Body `{files:[{name,text}]}`: các file cài đặt `.xml` của app Gamwing (`Documents/jya2/databases`). Trả `{saved, unchanged, skipped:[{name,reason}], changed}`. Chỉ nhận tên `.xml` an toàn (không `/`, `\`, `..`, không bắt đầu bằng `.`, tối đa 120 ký tự), tối đa 8 MB/file và 200 file; **từ chối** tên chứa `entitlement`, `ipc_session`, `license`. Không bao giờ xóa file |
| `GET /admin/api/sync/databases`, `GET /admin/api/sync/databases/<tên mã hóa URL>` | Danh sách và nội dung bản mới nhất của từng file cài đặt |
| `GET /admin/api/sync/backups/<YYYY-MM-DD>/databases` | Các file cài đặt của một ngày sao lưu (tên thật, có dấu và CJK) |
| `GET /admin/api/sync/backups`, `GET /admin/api/sync/backups/<YYYY-MM-DD>` | Danh sách ngày sao lưu (mới nhất trước) / bộ file cache của một ngày |

### Sao lưu theo ngày

Mỗi ngày một thư mục `data/backups/YYYY-MM-DD/` (file `list%7C…`, `map%7C…` và `_manifest.json`). Trong ngày thì **ghi đè** bằng trạng thái mới nhất mỗi khi tài khoản đồng bộ thay đổi; sang ngày mới thì tạo thư mục mới (ngày tính theo `BACKUP_TZ`). Không bao giờ ghi đè bằng trạng thái rỗng hoàn toàn. Xóa một keymap sẽ phản ánh vào bản sao lưu của chính ngày đó, nên muốn lấy lại thì chọn ngày hôm trước. Xem ở tab "Sao lưu theo ngày"; khôi phục về điện thoại bằng nút "Khôi phục theo ngày…" trong app. Lịch sử từng keymap (20 bản) vẫn được giữ song song với sao lưu theo ngày.

### File cài đặt của Gamwing (`databases`)

App KeyMap Sync gửi thêm các file XML trong `Documents/jya2/databases` (ví dụ `PubgSettings.xml`, `gamwing_keymap_cache.xml`, `ADBKey.xml`). Server giữ bản mới nhất trong `data/databases/` (tên file mã hóa phần trăm) và chép vào thư mục con `databases/` của mỗi ngày sao lưu, cùng quy tắc: trong ngày thì ghi đè, sang ngày mới thì tạo thư mục mới, bên nào (keymap hoặc cài đặt) đang rỗng thì giữ nguyên phần đã có trong ngày. Trang web có tab "Cài đặt app (jya2)" để xem và tải về (chỉ đọc, không sửa). **`ADBKey.xml` có thể là khóa riêng của app; server không có đăng nhập, chỉ dùng trong mạng tin cậy.** File giấy phép/phiên đăng nhập bị từ chối ở cả app lẫn server.

### Kết nối app ↔ web

App gửi nhịp tim, trang web gửi tín hiệu "đang mở"; mỗi bên hiện bên kia có đang kết nối hay không (chip trên đầu trang web, dòng "Giao diện web: …" trong app). Không có xác thực: bất kỳ máy nào trong mạng đều có thể tự khai là một thiết bị, nên đây chỉ là chỉ báo tiện lợi, không phải bảo mật.

Lịch sử xem/so sánh/khôi phục ở tab "Lịch sử" của giao diện web. Trang "Nhập backup" dùng cùng logic nên cũng giữ lại bản cũ khi nhập đè.

## Giả định (suy ra từ client, chưa kiểm chứng với server FT thật)

- `valid_count` được hiểu là số lần nhập tối đa của mã chia sẻ; vắng hoặc `-1` là không giới hạn.
- Server không xác thực `Login-Token` với backend gốc (không có khóa để làm việc đó). Quyền truy cập
  dựa vào `ft_client` (UUID ngẫu nhiên 128 bit) và tùy chọn `FT_ALLOWED_CLIENTS`.
- Không gửi `ft_message`, nên client sẽ không hiện toast "Tải lên/Tải xuống từ Sever FT thành công".
- Lưu trữ là file JSON, đủ cho dùng cá nhân. Giới hạn 2000 tài liệu mỗi tài khoản.
- Luồng "default share code" của bản .6 cần một keymap có tên chứa `default`, `pubg`, `安卓游戏厅` hoặc `和平精英`
  trong danh sách của namespace PUBG. Server này không có sẵn mẫu như vậy; nếu thiếu, client rơi về đường legacy.
- Tài khoản được tách theo `ft_client` ở query string và **không** kiểm tra `Login-Token`. Quyền truy cập thực chất
  nằm ở `ft_client`; chỉ dùng trong mạng tin cậy hoặc đặt `FT_ALLOWED_CLIENTS`.

## Chưa có trong server này

Server chỉ thay phần keymap. Đăng nhập, license, thanh toán và `/v2/config/*` vẫn đi qua các backend
khác của app. Cách để client trỏ tới server này (`FT_BASE` là hằng số trong APK) nằm ngoài phạm vi.
