# Thiết kế lại giao diện trang quản trị KeyMap

Ngày: 2026-10-13. Đầu vào: skill ui-ux-pro-max (phong cách Minimalism/Swiss, dashboard mật độ cao) và từ vựng thành phần của namethatui.com.
Đã chốt với người dùng: khung **Sidebar + Inspector**; giao diện **theo hệ thống + nút đổi**; thêm **Command Palette, Skeleton, menu ba chấm, Timeline**.

Chỉ đổi giao diện (`keymap-server/admin/*`). Không đổi API, dữ liệu, logic phân tích/xóa, CSP. Các thư viện `cachexml.js`, `recoil.js`, `layout.js`, `edit.js` giữ nguyên.

## Nguyên tắc
- Swiss tối giản: nền phẳng, viền mảnh 1 px, bo góc 8 px, gần như không đổ bóng, mật độ vừa-cao (hàng bảng 40 px, chữ 14 px, ghi chú 12.5 px).
- Màu theo token (`--bg --surface --surface-2 --text --muted --line --accent --ok --warn --danger` và bản `-soft`), có bản sáng và tối.
  **Xanh dương = hành động chính và focus; xanh lá chỉ cho trạng thái ổn/đang kết nối; vàng cho cảnh báo; đỏ chỉ cho xóa/lỗi.** Màu không là tín hiệu duy nhất (luôn kèm chữ hoặc biểu tượng).
- Phông: `system-ui` và `ui-monospace` (không tải phông ngoài: CSP chặn, mạng nội bộ, có chữ Việt và chữ Hán). Chữ nền 14 px, `line-height` 1.5, số dùng `tabular-nums`.
- Biểu tượng: SVG nội tuyến (nét 1.75, `aria-hidden`), không dùng emoji làm biểu tượng.
- Chuyển động 120–220 ms, chỉ `opacity/transform/background-color`; tắt hẳn khi `prefers-reduced-motion`.
- Tiếp cận: tương phản chữ ≥ 4.5:1 ở cả hai giao diện, vòng focus 2 px rõ (`:focus-visible`), vùng bấm ≥ 36 px (≥ 44 px trên màn hình cảm ứng hẹp), điều khiển bàn phím đầy đủ cho menu, palette và hộp thoại.

## Khung (App shell)
```
+-----------+---------------------------------------------+
| Sidebar   | Toolbar: Breadcrumbs ........ [Ctrl+K] [☀]  |
| (Source   |---------------------------------------------|
|  List)    | Nội dung của tab                            |
| ● máy     |   (Phân tích / Tệp: danh sách | Inspector)  |
| 5 mục     |                                             |
+-----------+---------------------------------------------+
```
- **Sidebar** 232 px: logo, 5 mục (biểu tượng + chữ, mục hiện tại có `aria-current="page"`), cuối là **Status Dot** thiết bị (xanh/xám + tên, tooltip chi tiết) và dòng thông tin server. Dưới 900 px thu thành thanh trên cuộn ngang; dưới 600 px chỉ còn biểu tượng + nhãn ngắn.
- **Toolbar**: **Breadcrumbs** (Phân tích › Độ giật › tên bản), nút **Command Palette** (Ctrl+K hoặc "/"), nút **đổi giao diện** (hệ thống → sáng → tối).
- Nội dung tối đa 1400 px; **Split View** hai cột: danh sách (linh hoạt) | **Inspector** 340 px (ẩn dưới 1100 px: Inspector chuyển xuống dưới danh sách).

## Thành phần (tên theo NameThatUI)
| Thành phần | Dùng ở |
|---|---|
| Segmented Control | Nguồn (Mới nhất / từng ngày sao lưu), chọn bộ dữ liệu độ giật, tư thế |
| Data Table (hàng chọn được, tiêu đề dính) | Danh sách mục, tệp, thiết bị |
| Chip/Badge (tone: neutral, ok, warn, danger, info) | Loại, tên lệch, thiếu nội dung, "có ở ft_map_server", trạng thái lệnh |
| Status Dot | Thiết bị, bản đang chọn trong app (★ → chấm) |
| Overflow Menu (ba chấm) | Mỗi hàng: Mở, Xem, Sửa, Tải về, Lịch sử, Sao chép id. **Xóa** luôn là nút riêng (chữ đỏ) |
| Inspector | Chi tiết mục/tệp đang chọn: nơi lưu (file › mục › danh sách › thư mục trên máy), hành động, **vùng nguy hiểm** (Xóa) |
| Disclosure (Accordion) | "Việc sẽ xảy ra" trong hộp thoại xóa; chi tiết kỹ thuật trong Inspector |
| Modal Dialog + Scrim; Steps | Hộp xác nhận xóa hai bước hiện "Bước 1/2 · 2/2"; focus vào nút an toàn |
| Inline Alert (info/warn/danger) | Mồ côi, tên lệch, cảnh báo đóng Gamwing, file cache chưa có |
| Timeline | "Lệnh xóa gần đây" (Inspector) và "Sao lưu theo ngày" |
| Skeleton | Khung xám khi tải danh sách/phân tích (chỉ hiện nếu chờ > 150 ms) |
| Empty State | Chưa có file, chưa chọn mục, chưa có lệnh |
| Command Palette (Combobox + Modal) | Ctrl+K: nhảy tới tab, mục của cache, tệp; đổi giao diện; tải lại. Tìm không phân biệt dấu |
| Toast | Giữ nguyên (vùng \`role=status\`) |
| Truncation + nút sao chép | ID dài rút gọn ở giữa, tooltip và nút sao chép |

## Từng tab
1. **Phân tích cache**: Toolbar con (Segmented nguồn + Tải lại + tóm tắt: dung lượng, thư mục trên máy, số mục/mồ côi) → Inline Alert cảnh báo → Split: bảng gộp mọi mục theo loại (nhóm có tiêu đề: Sơ đồ phím / Nhận diện AI / Độ giật / Mục mồ côi, có nút "Xóa cả N mục mồ côi") | Inspector.
   Bấm hàng = chọn (Inspector hiện chi tiết); nút "Mở phân tích" hoặc bấm đúp = chế độ xem (màn hình mô phỏng / phân tích độ giật) toàn chiều rộng với Breadcrumbs và dải thông tin gập được.
2. **Tệp cài đặt**: bảng (Tên, Thư mục trên máy, Dung lượng, Cập nhật) | Inspector (chi tiết, Xem/Sửa/Tải/Lịch sử/Phân tích).
3. **So sánh ngày**: biểu mẫu một hàng (File, Cũ, Mới, So sánh), kết quả bằng nhóm Thêm/Mất/Đổi có Chip màu và nút "Chi tiết".
4. **Sao lưu theo ngày**: Timeline, mỗi ngày một nút "Xem file", ghi số file, dung lượng, người cập nhật.
5. **Thiết bị**: thẻ với Status Dot, thông tin dạng danh sách khóa-giá trị, nút "Quên thiết bị".

## Kiểm thử
- Test Node giữ nguyên; thêm các tệp tĩnh mới vào danh sách trang của \`admin.test.js\`.
- Kiểm bằng Edge headless: ảnh chụp sáng/tối, rộng 1440, 1024 và 390 px; không lỗi trình duyệt; duyệt bằng bàn phím (Tab, Enter, Esc, Ctrl+K, mũi tên trong menu và palette); luồng xóa hai bước vẫn chạy đúng; đối chiếu tương phản bằng tính toán.
- Triển khai lại Docker sau khi xong.

## Ngoài phạm vi
Đăng nhập, đổi API, tách bản dựng (bundler), phông web, thư viện biểu tượng bên ngoài.

## Đã làm, và khác với bản thiết kế (ghi sau khi triển khai)
- Tệp mới: `theme.js` (áp giao diện đã lưu trước khi vẽ), `palette.js` (Command Palette); `ui.js` mở rộng (biểu tượng SVG nội tuyến, badge, menu ba chấm, segmented, skeleton, breadcrumbs, hộp thoại có bước và giữ focus); `app.css` viết lại theo token.
- Cột "Nằm ở (file › mục)" được **gộp vào ngay dưới tên** của mỗi hàng (file XML › `map|id`, danh sách `list|ns`, ngày, loại đoán cho mục mồ côi) thay vì một cột riêng, vì Inspector chiếm 340 px nên cột riêng làm cột Tên quá hẹp. Inspector vẫn có bản đầy đủ.
- Danh sách của tab Phân tích gộp mọi loại vào **một bảng có hàng tiêu đề nhóm** (Sơ đồ phím / Nhận diện AI / Độ giật / Mục mồ côi) thay vì mỗi loại một thẻ; nhóm mồ côi có nút "Xóa cả N mục mồ côi".
- Bấm hàng = chọn (Inspector); bấm đúp hoặc nút "Mở phân tích" = chế độ xem toàn chiều rộng với breadcrumbs và dải "Nơi lưu của mục này" gập được; Inspector của tab Tệp có Xem/Sửa/Tải/Lịch sử.
- Nguồn dữ liệu: Segmented Control khi ≤ 4 ngày sao lưu, chuyển thành ô chọn khi nhiều hơn.
- "Lệnh xóa gần đây" là Timeline nằm trong Inspector; tự làm mới mỗi 4 giây khi còn lệnh chờ.
- Hộp xóa có nhãn "Bước 1/2 · Kiểm tra" và "Bước 2/2 · Xác nhận lần cuối"; phần "Việc sẽ xảy ra" là Disclosure; hộp thoại giữ focus bên trong và đóng bằng Esc.
- Tương phản đã đo bằng tính toán: mọi cặp chữ ≥ 4,5:1 ở cả hai giao diện (cặp chữ xanh dương trên nền xanh nhạt được tối lại cho đạt); màu "faint" chỉ dùng cho biểu tượng trang trí.
- Kiểm bằng Edge headless: không lỗi trình duyệt; sáng/tối; 1440, 1024 và 390 px (không tràn ngang); Ctrl+K, menu bằng bàn phím, hộp xóa hai bước, nút đổi giao diện.
