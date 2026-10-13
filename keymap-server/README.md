# ft-keymap-server (sao lưu cài đặt Gamwing)

Server tự host chỉ làm một việc: **nhận và sao lưu các file `.xml` trong `Documents/jya2/databases`** của điện thoại/máy tính bảng
(do app `android-sync` gửi lên), kèm một trang web để xem, sửa file nhỏ, so sánh theo ngày và **phân tích `gamwing_keymap_cache.xml`**.
Không có thư viện ngoài, cần Node >= 20.

```
npm start        # lắng nghe trên PORT (mặc định 8787)
npm test         # test của server và các thư viện của trang web
```

## Chạy bằng Docker (khuyên dùng)

```
docker compose up -d --build     # build và chạy nền
docker compose logs -f           # xem log
docker compose down              # dừng; dữ liệu nằm trong volume "ftdata" nên không mất
```

Trang web: **`http://<máy>:8787/admin`**. **Không có đăng nhập** (chạy trong LAN tin cậy): đừng forward cổng 8787 ra Internet.
Server chỉ chặn các lời gọi do trang web lạ phát ra từ trình duyệt của bạn (kiểm tra `Host`, `Origin` và header `X-Admin-Request`).
Truy cập bằng tên miền riêng thì thêm vào `ADMIN_ALLOWED_HOSTS`. Chỉ cho máy này truy cập: `BIND=127.0.0.1 docker compose up -d`.

## Trang web (5 tab)

- **Phân tích cache**: đọc `gamwing_keymap_cache.xml` (file SharedPreferences chứa các mục `list|<namespace>` và `map|<id>`) và cho thấy
  - danh sách theo loại: sơ đồ phím, nhận diện AI, độ giật/cấu hình; bản đang được chọn trong app; tên, ngày, dung lượng;
  - **mục mồ côi** (có nội dung nhưng không nằm trong danh sách), mục thiếu nội dung, tên trong danh sách khác tên trong dữ liệu;
  - bấm một mục: sơ đồ phím/nhận diện AI hiện **trên màn hình mô phỏng** đúng toạ độ (có thể chọn ảnh chụp game làm nền); độ giật hiện
    theo súng, tư thế, ống ngắm, đường cong và hệ số (mô phỏng cách app chọn đường cong, `admin/recoil.js`). Chỉ xem, không sửa.
  - nguồn có thể là bản mới nhất hoặc một ngày sao lưu;
  - mỗi mục cho biết **nó nằm ở đâu**: file XML nào, mục `map|<id>` nào, trong danh sách `list|<namespace>` nào (hoặc "không nằm trong danh sách nào"),
    thư mục nào trên máy tính bảng, và các dòng `document|…|<id>` ghi id đó ở `ft_map_server_v1.xml`;
  - **xóa**: mọi mục (đang trong danh sách hay mồ côi) có nút **Xóa**, mục mồ côi có thêm "Xóa cả N mục mồ côi". Xóa phải qua **hai hộp xác nhận**.
    Server cắt `map|<id>` khỏi `gamwing_keymap_cache.xml` ngay (mục nằm trong danh sách thì bỏ luôn khỏi `list|…`; nếu là mục đang được chọn thì danh sách
    chọn mục đầu còn lại), giữ bản trước trong lịch sử, và để lại một **lệnh** cho các tablet; app KeyMap Sync nhận lệnh ở nhịp 15 giây, tự sửa file trên máy
    (chép file cũ trước), rồi báo kết quả. Thẻ "Lệnh xóa gần đây" hiện: chờ máy nhận / đã xóa trên máy / cần xem lại (mục hiện lại vì Gamwing ghi đè, lỗi…).
    Trong lúc tablet chưa báo, file cache nó đẩy lên bị server cắt lại các mục đó, nên bản cũ trên máy không làm mục đã xóa hiện lại.
    Không xóa các dòng `document|…` ở `ft_map_server_v1.xml` và các bản chép `.json` (nếu có) ở `Documents/Gamwing/keymap_cache`.
- **Tệp cài đặt**: danh sách file `.xml` (kèm thư mục của file trên máy tính bảng), xem, tải về, **Lịch sử** 10 bản mỗi file với nút khôi phục trên server (mọi kích thước), và **sửa trực tiếp** (file ≤ 256 KB): kiểm tra XML hợp lệ,
  hộp cảnh báo liệt kê thay đổi, từ chối ghi đè nếu file đã bị nơi khác sửa (HTTP 409). File lớn (cache keymap) chỉ xem và tải.
- **So sánh ngày**: chọn một file và hai thời điểm (hoặc bản mới nhất); liệt kê mục thêm/mất/đổi; với file cache, mục đổi có nút "Chi tiết"
  để xem từng giá trị JSON thay đổi.
- **Sao lưu theo ngày**: mỗi ngày một thư mục; xem và tải từng file.
- **Thiết bị**: app gửi nhịp "còn sống" mỗi 15 giây; trang web báo "đang mở" mỗi 10 giây để app biết.

## Cấu hình (biến môi trường)

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `PORT`, `HOST` | `8787`, `0.0.0.0` | Địa chỉ lắng nghe |
| `DATA_DIR` | `./data` | Nơi lưu dữ liệu (`databases/`, `backups/`, `devices.json`) |
| `MAX_BODY_BYTES` | 8 MiB | Giới hạn body (trang quản trị và API đồng bộ luôn cho tối thiểu 64 MiB) |
| `TLS_KEY`, `TLS_CERT` | trống | Đường dẫn khóa và chứng chỉ để chạy HTTPS trực tiếp |
| `ADMIN_ENABLED` | `1` | `0` để tắt hẳn trang web và API đồng bộ |
| `ADMIN_ALLOWED_HOSTS` | trống | Tên miền được phép vào `/admin` ngoài IP, `localhost`, tên ngắn, `*.local`, `*.lan` |
| `BACKUP_TZ` | `Asia/Ho_Chi_Minh` | Múi giờ tính "hôm nay" cho thư mục sao lưu (container chạy giờ UTC nên cần đặt) |
| `BACKUP_KEEP_DAYS` | `0` | Giữ bao nhiêu ngày sao lưu; `0` = giữ hết, không tự xóa |

## API đồng bộ (cho app Android)

Dùng cùng lớp bảo vệ với trang web (`Host` hợp lệ, header `X-Admin-Request: 1` khi ghi). App gửi thêm `X-Device-Id` / `X-Device-Name` để được nhận ra.

| Endpoint | Việc làm |
|---|---|
| `GET /admin/api/sync/info` | `{ok, server, version, files, web:{sessions}, devices_online, backup_days}` |
| `POST /admin/api/sync/databases/push` | Body `{files:[{name,text}]}`. Trả `{saved, unchanged, skipped:[{name,reason}], changed}`. Chỉ nhận tên `.xml` an toàn (không `/`, `\`, `..`, không bắt đầu bằng `.`, tối đa 120 ký tự), tối đa **24 MB** mỗi file và 200 file; **từ chối** tên chứa `entitlement`, `ipc_session`, `license`. Không bao giờ xóa file; bản cũ được giữ trong lịch sử (10 bản) |
| `GET /admin/api/sync/databases`, `GET …/databases/<tên mã hóa URL>` | Danh sách và nội dung bản mới nhất |
| `PUT …/databases/<tên>` | Sửa từ trang web: `{text, etag}`; 409 nếu `etag` cũ |
| `GET …/databases/<tên>/history[/<phiên bản>]` | Các bản cũ |
| `GET /admin/api/sync/backups` | Danh sách ngày sao lưu (mới nhất trước) |
| `GET …/backups/<YYYY-MM-DD>/databases` | Cả bộ file của một ngày (tên thật, có dấu và CJK) |
| `GET …/backups/<YYYY-MM-DD>/databases/<tên>` | Một file của một ngày |
| `POST …/hello`, `GET …/devices`, `DELETE …/devices/<id>`, `POST /admin/api/presence` | Kết nối app ↔ web. Câu trả lời của `hello` có `commands`: các lệnh đang chờ thiết bị đó |
| `POST /admin/api/cache/delete` | `{file, ids, etag, labels}`: cắt các mục khỏi file cache trên server (cần `etag` hiện hành, 409 nếu file đã đổi; 404 nếu id không có ở đâu; 400 nếu id/file sai) và tạo lệnh cho các thiết bị đã biết |
| `GET /admin/api/cache/commands` | Các lệnh gần đây (50 mới nhất) với trạng thái `pending` / `done` / `attention` / `server_only` / `expired` và kết quả từng thiết bị |
| `POST …/commands/<id>/result` | App báo kết quả: `{removed, missing, reappeared, skipped, error, backup}` (cần `X-Device-Id`) |
| `POST …/wipe` | Xóa toàn bộ (cần `{"confirm":"XOA TAT CA"}`); bản xóa gần nhất được giữ ở `data/_wiped/` |

## Sao lưu theo ngày

Mỗi ngày một thư mục `data/backups/YYYY-MM-DD/` gồm `databases/` (tên file mã hóa phần trăm) và `_manifest.json`. Trong ngày thì **ghi đè**
bằng trạng thái mới nhất mỗi khi có file thay đổi; sang ngày mới thì tạo thư mục mới (ngày tính theo `BACKUP_TZ`). Ghi qua thư mục tạm rồi
đổi tên nên không bao giờ có ngày dở dang; không bao giờ ghi đè bằng trạng thái rỗng. Khôi phục về máy: app Android → "Khôi phục theo ngày…".

## Lưu ý

- **`ADBKey.xml` có thể là khóa riêng của app (ADB)** và vẫn được sao lưu; server không có đăng nhập, nên chỉ dùng trong mạng tin cậy.
  File giấy phép/phiên đăng nhập bị từ chối ở cả app lẫn server.
- Dữ liệu cũ của các phiên bản trước (`data/accounts`, `data/history`, `data/shares.json`) không còn được dùng và không bị xóa; các thư mục
  sao lưu ngày cũ vẫn đọc được (các file `list%7C…`/`map%7C…` trong đó bị bỏ qua).
- Phân tích độ giật và vị trí phím dựa trên suy luận về cách app Gamwing dùng dữ liệu (ghi chú "suy ra" nằm trong `admin/recoil.js`, `admin/layout.js`);
  chưa xác nhận gốc toạ độ (góc trên-trái hay tâm ô).
