# KeyMap Sync (app Android riêng)

App nhỏ viết bằng Kotlin, **không đăng nhập, không cần Shizuku**. Nó **sao lưu các file `.xml` trong `Documents/jya2/databases`** của app
Gamwing lên server tự host (`../keymap-server`) và khôi phục lại theo ngày. Đây là app **độc lập**, không sửa app Gamwing và không đụng tới
license hay chứng chỉ của nó.

## Chức năng
- **Cài đặt server** (mục riêng ở đầu màn hình): nhập địa chỉ (ví dụ `192.168.4.17:8787`, tự thêm `http://`) rồi bấm **Lưu địa chỉ** hoặc phím Xong
  trên bàn phím. App kiểm tra trước khi lưu và nói rõ sai ở đâu (ví dụ IP phải có đủ 4 số, cổng 1–65535); địa chỉ sai **không bị lưu**, địa chỉ
  cũ được giữ. Địa chỉ lưu trong bộ nhớ riêng của app (SharedPreferences) và mọi thao tác (đẩy, khôi phục, tự đẩy, nhịp tim) đều dùng địa chỉ đã lưu.
  Dòng bên dưới nút luôn cho biết địa chỉ đang dùng hoặc lý do địa chỉ đã lưu không dùng được.
- **Thư mục** (mặc định `Documents/jya2/databases`).
- **Khi mở app** tự kiểm tra và hiện: `✔ Đã kết nối tới http://… (server sao lưu, N file đang lưu)` (hoặc lỗi bằng tiếng Việt).
- **Quét file**: đếm file `.xml` sẽ sao lưu và nêu tên file bị bỏ qua.
- **Đẩy lên server**: gửi mọi file `.xml` (kể cả `gamwing_keymap_cache.xml` và `ADBKey.xml`), trừ file có tên giấy phép/phiên đăng nhập
  (`entitlement`, `ipc_session`, `license`). Server giữ bản mới nhất, 10 bản cũ của mỗi file và một bản theo ngày. Không bao giờ xóa gì.
- **Khôi phục theo ngày…**: chọn một ngày trong danh sách sao lưu của server, xem file nào mới/sẽ bị ghi đè, xác nhận rồi ghi vào thư mục
  (file cũ được chép trước vào `Documents/FTKeymapSync/backup/<thời gian>/databases/`; chỉ ghi file mới hoặc khác, không xóa file nào).
  **Hãy đóng hẳn Gamwing trước khi ghi**; chưa kiểm chứng app có đọc lại các file này hay không (nó có thể ghi đè lại).
- **Tự đẩy khi thư mục thay đổi** (công tắc): dịch vụ nền có thông báo cố định, kiểm tra thư mục mỗi 3 giây, chỉ đẩy file đã đổi và chỉ
  đẩy sau khi thư mục "đứng yên" qua 2 lần kiểm tra liên tiếp (tránh gửi file app đang ghi dở). Lỗi thì thử lại, giãn dần tới 60 giây.
- **Lệnh xóa từ giao diện web**: khi bạn xóa một mục ở tab "Phân tích cache" của web, server trả lệnh trong nhịp tim 15 giây (cần app đang mở hoặc đang bật Tự đẩy).
  App **tự làm, không hỏi**: chép `gamwing_keymap_cache.xml` cũ vào `Documents/FTKeymapSync/backup/<thời gian>/databases/`, cắt `map|<id>` (và bỏ khỏi `list|…`),
  ghi đè tại chỗ, chờ 3 giây rồi đọc lại để biết Gamwing có ghi đè lại không, và báo kết quả lên web ("đã xóa", "không còn", "hiện lại", lỗi). **Hãy đóng hẳn Gamwing**
  trước khi xóa. Mỗi lệnh chỉ làm một lần; kết quả chưa gửi được sẽ gửi lại ở nhịp sau.
- **Tên thiết bị** (mặc định là hãng + model máy): hiện trên trang web ở tab "Thiết bị".
- **Kết nối với web**: app gửi nhịp tim mỗi 15 giây nên trang web hiện "đang kết nối"; app hiện "Giao diện web: đang mở (N phiên)" hoặc
  "chưa có ai mở". Mất nhịp quá 40 giây thì web coi là ngắt.
- **Xóa toàn bộ trên server…** (vùng nguy hiểm, phải gõ "XOA"): xóa file cài đặt, lịch sử và sao lưu theo ngày trên server. Server giữ một bản
  của lần xóa gần nhất trong `data/_wiped/`. File trên máy không bị đụng tới.

## Cài đặt
Yêu cầu: Android 11 trở lên. Lần đầu mở app, bấm **Cấp quyền truy cập mọi file** và bật quyền cho "KeyMap Sync".
Server dùng HTTP thường (`usesCleartextTraffic`) và giao diện quản trị không có đăng nhập, nên **chỉ dùng trên mạng nội bộ tin cậy**.
Điện thoại và máy tính phải cùng mạng; mở cổng 8787 trên tường lửa Windows nếu cần.
Phiên bản 2.0.0 không còn đồng bộ cache keymap kiểu cũ (`list|…`/`map|…`); cần server 2.0.0 trở lên.

## Build
```
cd android-sync
set JAVA_HOME=C:\Program Files\Microsoft\jdk-17.0.20.101-hotspot
gradlew.bat testDebugUnitTest      # test JVM (server giả trong JVM)
gradlew.bat assembleDebug          # app/build/outputs/apk/debug/app-debug.apk
adb install -r app\build\outputs\apk\debug\app-debug.apk
```
Bài test đầu-cuối với server thật (bỏ qua nếu không đặt biến):
`SYNC_TEST_SERVER=http://127.0.0.1:8799 SYNC_TEST_DATABASES=<thư mục chứa file .xml> gradlew.bat testDebugUnitTest --tests "*RealServerTest*"`.
APK ký bằng khóa debug của chính bạn (khác hoàn toàn chứng chỉ của Gamwing, và không liên quan gì tới nó).

## Cấu trúc mã
- `Models.kt`, `Helpers.kt`: kiểu dữ liệu, luật tên file (`DatabaseNames`), chuẩn hóa địa chỉ.
- `ServerClient.kt`: HTTP tới `/admin/api/sync/*`.
- `SyncEngine.kt`: quét, đẩy (chia lô ≤ 6 MB, file lớn hơn đi riêng), kế hoạch và ghi khi khôi phục (có sao lưu file cũ).
- `CacheEdit.kt`: cắt mục khỏi file cache (cùng luật với `admin/cachexml.js` của server).
- `Watcher.kt`: logic theo dõi (thuần, test được). `WatchService.kt`: dịch vụ nền gọi `Watcher.tick()` và gửi nhịp tim.
- `MainActivity.kt`: giao diện. `Prefs.kt`: cài đặt và `StatusBus` (nhật ký).
