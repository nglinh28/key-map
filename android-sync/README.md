# KeyMap Sync (app Android riêng)

App nhỏ viết bằng Kotlin, **không đăng nhập, không cần Shizuku, không cần mã tài khoản**. Nó đọc thư mục cache keymap của app
Gamwing trên điện thoại và đồng bộ với server keymap tự host (`../ft-keymap-server`). Đây là app **độc lập**, không sửa
app Gamwing và không đụng tới license hay chứng chỉ của nó.

## Chức năng
- **Địa chỉ server** (ví dụ `http://192.168.1.15:8787`) và **thư mục nguồn** (mặc định `Documents/Gamwing/keymap_cache`).
- **Khi mở app** tự kiểm tra và hiện: `✔ Đã kết nối tới http://… (server keymap, N tài khoản)` (hoặc lỗi bằng tiếng Việt).
- **Kiểm tra kết nối**, **Quét file** (đếm file `list|…` và `map|…`).
- **Đẩy lên server**: gửi qua `POST /admin/api/sync/push`. Giữ nguyên id và keymap đang chọn. Nếu một keymap đã có trên server mà
  nội dung khác thì server **chép bản cũ vào lịch sử** (20 bản/keymap; xem So sánh / Khôi phục ở tab Lịch sử của giao diện web).
  File giống hệt thì bỏ qua. Không bao giờ xóa gì.
- **Nhập từ server về**: lấy `GET /admin/api/sync/pull` rồi ghi vào thư mục nguồn. Có hộp xác nhận cảnh báo; file bị ghi đè
  được **sao lưu trước** vào `Documents/FTKeymapSync/backup/<thời gian>/`; chỉ ghi file mới hoặc khác, không xóa file nào.
- **Sao lưu cả cài đặt của Gamwing**: công tắc và ô "Thư mục cài đặt Gamwing" (mặc định `Documents/jya2/databases`). "Đẩy lên server" và tự đẩy gửi thêm các file `.xml` ở đó (kể cả `ADBKey.xml`), trừ file có tên giấy phép/phiên đăng nhập. "Quét file" cho biết số file và tên bị bỏ qua. Server giữ theo ngày (thư mục con `databases/`).
- **Khôi phục cài đặt theo ngày…**: chọn một ngày, xem file nào mới/sẽ bị ghi đè, rồi ghi vào thư mục cài đặt (file cũ được chép trước vào `Documents/FTKeymapSync/backup/<thời gian>/databases/`). Hãy đóng hẳn Gamwing trước khi ghi; tôi chưa kiểm chứng app có đọc lại các file này hay không (nó có thể ghi đè lại).
- **Tên thiết bị** (mặc định là hãng + model máy): hiện trên trang web ở tab "Thiết bị".
- **Kết nối với web**: app gửi nhịp tim mỗi 15 giây (khi màn hình mở, và cả khi dịch vụ tự đẩy đang chạy) nên trang web hiện "đang kết nối"; app cũng hiện dòng "Giao diện web: đang mở (N phiên)" hoặc "chưa có ai mở". Mất nhịp quá 40 giây thì web coi là ngắt.
- **Khôi phục theo ngày…**: chọn một ngày trong danh sách sao lưu của server (`2026-10-11`, …) rồi ghi bộ file của ngày đó vào thư mục nguồn, cùng hộp xác nhận cảnh báo và sao lưu file cũ như "Nhập từ server về".
- **Tự đẩy khi thư mục thay đổi** (công tắc): dịch vụ nền có thông báo cố định, kiểm tra thư mục mỗi 3 giây, chỉ đẩy file đã đổi
  và chỉ đẩy sau khi thư mục "đứng yên" qua 2 lần kiểm tra liên tiếp (tránh gửi file app đang ghi dở). Lỗi thì thử lại, giãn dần tới 60 giây.

## Điều cần biết về "Nhập từ server về"
Theo code của Gamwing (`KeymapCache`): app ghi cache vào **cả hai nơi** (SharedPreferences riêng và file trong `Documents`), nhưng khi đọc
thì lấy **SharedPreferences trước**, chỉ đọc file khi preferences không có, và khi có mạng nó tải lại từ server của nó rồi ghi đè cả hai.
Vì vậy ghi file vào thư mục này thường **không làm app đổi theo**; chúng chủ yếu là bản lưu dự phòng. App cũng không đọc được
SharedPreferences của Gamwing (cần root). File mới do app này tạo có thể không do Gamwing ghi đè được về sau (khác chủ sở hữu);
file đã có thì được ghi đè tại chỗ nên giữ nguyên chủ sở hữu.

## Cài đặt
Yêu cầu: Android 11 trở lên. Lần đầu mở app, bấm **Cấp quyền truy cập mọi file** và bật quyền cho "KeyMap Sync".
Server dùng HTTP thường (`usesCleartextTraffic`) và giao diện quản trị không có đăng nhập, nên **chỉ dùng trên mạng nội bộ tin cậy**.
Điện thoại và máy tính phải cùng mạng; mở cổng 8787 trên tường lửa Windows nếu cần.

## Build
```
cd android-sync
set JAVA_HOME=C:\Program Files\Microsoft\jdk-17.0.20.101-hotspot
gradlew.bat testDebugUnitTest      # test JVM (server giả trong JVM)
gradlew.bat assembleDebug          # app/build/outputs/apk/debug/app-debug.apk
adb install -r app\build\outputs\apk\debug\app-debug.apk
```
APK ký bằng khóa debug của chính bạn (khác hoàn toàn chứng chỉ của Gamwing, và không liên quan gì tới nó).

## Cấu trúc mã
- `Models.kt`, `Helpers.kt`: kiểu dữ liệu, tên file cache, chuẩn hóa địa chỉ, so sánh JSON (bỏ qua thứ tự khóa, `100` = `100.0`).
- `ServerClient.kt`: HTTP tới `/admin/api/sync/{info,push,pull}`.
- `SyncEngine.kt`: quét, đẩy (chia lô ≤ 6 MB), kế hoạch và ghi khi nhập về (có sao lưu).
- `Watcher.kt`: logic theo dõi (thuần, test được). `WatchService.kt`: dịch vụ nền gọi `Watcher.tick()`.
- `MainActivity.kt`: giao diện. `Prefs.kt`: cài đặt và `StatusBus` (nhật ký).
