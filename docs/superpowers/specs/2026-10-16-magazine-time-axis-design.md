# Trục thời gian của mốc độ giật theo thời gian bắn hết băng

Ngày: 2026-10-16. Trạng thái: thiết kế đã được duyệt trong chat (nội suy giữ hình dạng, chỉ băng thường); **chờ duyệt bản viết này** trước khi lập kế hoạch cài đặt.

## Mục tiêu

Hiện nay thời gian của các mốc trong đường cong độ giật là số ngẫu nhiên cộng dồn 450–678 ms (`RecoilLib.STEP`), không liên quan gì tới việc súng bắn nhanh hay chậm. Bản này gắn trục thời gian với **thời gian bắn hết một băng đạn (T)** của từng súng:

- Mỗi súng trong "Tiêu chuẩn súng" có thêm **số viên một băng** và **số giây giữa hai phát**; T = (băng − 1) × giây/phát.
- Đường cong có n mốc thì mốc thứ i nằm ở `round(i × T ÷ (n − 1))` ms: **chia đều**, tổng thời lượng luôn bằng T.
- Thêm hoặc bớt mốc thì chia đều lại, và **giữ hình dạng** đường cong (nội suy tuyến tính), không đổi tổng thời lượng.
- Mẫu chuẩn này được đưa cho AI gợi ý mốc và dùng trong phần tính của server.

Ví dụ: M416 (30 viên, 0,085 s) cho T = 2.465 ms; 11 mốc cách nhau 246,5 ms (làm tròn từng mốc).

## Quyết định đã chốt với người dùng

1. Khi đổi số mốc: **nội suy lại đường cong tại các thời điểm chia đều** (phương án A). Thêm mốc làm đường cong mịn hơn, bớt mốc làm thô hơn, hình dạng gần như không đổi.
2. Chỉ dùng **băng thường**. Muốn tính theo băng khác thì sửa số viên bằng tay.
3. Súng chưa có số liệu giữ cách cũ (bước 450–678 ms) và có nhãn cảnh báo.
4. Các đường cong đã lưu **không tự đổi**. Có nút "Chia đều thời gian theo băng đạn" cho từng đường cong và cho cả súng.

Ngoài phạm vi: băng mở rộng; tự động sửa các đường cong đã lưu; nghỉ giữa các loạt bắn (M16, Mk47); thời gian thay đạn; nạp từng viên của sniper và shotgun.

## 1. Thông số bắn của súng

Dạng dữ liệu của mỗi súng: `fire = { magazine, interval }`
- `magazine`: số nguyên 1–200 (viên trong một băng thường).
- `interval`: số thực 0,02–3 (giây giữa hai phát; với súng bắn từng phát, bắn tay hoặc bơm đạn thì đây là chu kỳ tối thiểu).
- Suy ra `emptyMs = round((magazine − 1) × interval × 1000)`.

Thứ tự ưu tiên: **sửa của người dùng** > **bảng mặc định** (`FIRE_DEFAULTS`, 36 súng ở phụ lục) > không có (`null`).

`recoil.js` (chạy cả ở trình duyệt và Node, giống `ATTACHMENT_RULES`):
- `FIRE_DEFAULTS`: `{ code: { magazine, interval, source, note } }`.
- `checkFire(f)` → `{ ok, fire }` hoặc `{ ok:false, error }` (kiểm tra giá trị như trên).
- `setFireOverrides(map)`, `getFireOverrides()`: `code → { magazine, interval } | null` (`null` = "bỏ số liệu của súng này"), bỏ phần không hợp lệ giống `setRuleOverrides`.
- `fireOf(weapon)` → `{ magazine, interval, emptyMs, source, sourceLabel, edited }` hoặc `null`. Súng "luôn đường cong 0" (Empty, MORTAR) và súng bị tắt không có `fire`.

Server (`gun-standards.js`): thêm `fire` vào `gun-standards.json` (`{ overrides, disabled, fire }`; file cũ không có `fire` vẫn đọc được). Thêm `setFire(code, fire)` và `resetFire(code)`; ghi nguyên tử như hiện nay.

API (`admin.js`): `GET /admin/api/standards` trả thêm `fire`. `PUT /admin/api/standards/:code` nhận thêm `body.fire` (`{ magazine, interval }` hoặc `null`); `DELETE .../fire` hoặc `body.resetFire` đặt lại về mặc định. Giữ nguyên quy tắc kiểm tra mã súng và header `X-Admin-Request`.

Giao diện (`admin/standards.js`): bảng thêm ba cột **Băng**, **Giây/phát**, **Hết băng (s)** (có lọc và sắp xếp như các cột khác); hộp "Sửa tiêu chuẩn" thêm hai ô nhập kèm số "Hết băng" tính trực tiếp; nhãn nguồn ("mặc định, chưa kiểm chứng" / "đã sửa").

## 2. Trục thời gian chia đều

Hàm thuần trong `recoil.js`:
- `evenTimes(T, n)` → mảng n số nguyên tăng dần. `n = 1` → `[0]`. Mốc cuối đúng bằng `round(T)`. Nếu T quá nhỏ so với n khiến hai mốc trùng thì đẩy lên để vẫn tăng dần (không bao giờ trả thời gian trùng).
- `resample(curve, n, T)` → đường cong mới n mốc: thời gian `evenTimes(T, n)`; giá trị = nội suy tuyến tính của đường cong cũ theo thời gian chuẩn hóa `u = t ÷ thời lượng cũ`. Giá trị mốc đầu và cuối được giữ nguyên. Đường cong cũ chỉ có 1 mốc thì mọi mốc mới lấy giá trị đó. Giá trị là số hữu hạn, làm tròn 4 chữ số thập phân.
- `retime(curve, T)` = `resample(curve, curve.length, T)`.
- Các hàm cũ (`STEP`, `stepTime`, `nextPoint`, `cascadeFrom`, `extendCurve`) giữ nguyên để dùng cho súng chưa có số liệu.

Nơi áp dụng (`admin/analysis.js`):
- **Thêm mốc** và xóa mốc trong trình sửa đường cong: súng có `fire` thì `resample(curve, n ± 1, T)`; chưa có thì cách cũ.
- **Thêm mốc cho súng** (hộp thoại): +k mốc cho mỗi tổ hợp = `resample(base, n + k, T)`. Hai thẻ "Quy tắc tính mốc" (xu hướng / bước chuẩn) được thay bằng một dòng giải thích, vì cách nội suy không còn hai lựa chọn. Súng chưa có `fire` giữ cách cũ và hộp thoại nói rõ.
- **Tự tính các mốc sau** khi sửa ô thời gian của mốc i: các mốc sau i được chia đều giữa mốc i và T. Cột giá trị giữ cách cộng dồn hiện tại.
- Nút **Chia đều thời gian theo băng đạn** (từng đường cong và cả súng): `retime(curve, T)`. Kết quả vào bản nháp, chưa ghi file, giống các thao tác hàng loạt khác.
- Đầu trình sửa đường cong thêm dòng "Hết băng: 2,47 s (30 viên × 0,085 s)", kèm nhãn cảnh báo khi thời lượng đường cong lệch T quá 5%.

## 3. Mẫu cho AI và phần tính của server

`ai.js`:
- Câu hỏi thêm `target_duration_ms` (T), `point_count`, và quy tắc "các mốc cách đều nhau, mốc đầu ở 0, mốc cuối ở T". Câu hướng dẫn nói AI chỉ cần quyết định **giá trị**.
- Sau khi AI trả lời, server **chuẩn hóa**: giữ giá trị AI, `retime` lên T với số mốc AI trả (hoặc `point_count` nếu AI trả sai số mốc nhưng vẫn hợp lệ), rồi chạy kiểm tra giá trị như hiện nay (0,4–2,5 lần đường theo hệ số; 0,6–1,6 lần khi rà soát). Thời lượng không còn là lý do từ chối khi súng có `fire`.
- Súng chưa có `fire`: giữ nguyên kiểm tra thời lượng cũ (0,25–4 lần; 0,5–2 lần khi rà soát).

`suggest.js`:
- `analogCurve`: súng đích có `fire` thì kết quả = giá trị đã hiệu chỉnh, `retime` lên T (trường `stretch` = T ÷ thời lượng đường theo hệ số). Không có thì giữ cách cũ.
- `comboCandidates`, `distance`, `similarGuns`: không đổi.

## 4. Kiểm thử

- `recoil.test.js`: `evenTimes` (n = 1, 2, nhiều mốc, T nhỏ, mốc cuối đúng T, luôn tăng dần); `resample` (giữ hai đầu, giữ hình dạng với đường thẳng và đường cong, tăng và giảm mốc, đường 1 mốc); `checkFire`, `fireOf` (ưu tiên sửa > mặc định, súng zero và súng bị tắt); `FIRE_DEFAULTS` chỉ chứa mã súng có trong `WEAPONS`.
- `gun-standards`: ghi và đọc `fire`, file cũ không có `fire`, đặt lại về mặc định.
- `admin.test.js`: `GET` và `PUT` `standards` với `fire` (hợp lệ, sai giá trị, mã súng sai, thiếu header).
- `ai.test.js`: câu hỏi có T và số mốc; chuẩn hóa thời gian của câu trả lời AI; súng không có `fire` giữ cách cũ.
- `suggest.test.js`: `analogCurve` kết thúc ở T khi súng có `fire`.
- Giao diện: chụp ảnh sáng và tối bằng trình duyệt (1440 px và 390 px) cho bảng Tiêu chuẩn súng và trình sửa đường cong; thử thao tác thêm, bớt mốc và nút chia đều; không có lỗi trình duyệt.

## Rủi ro và điều cần biết

- Số liệu mặc định lấy từ ảnh chụp Liquipedia khoảng giữa 2025 (giây/phát) và BitTopup (băng), nên **chưa kiểm chứng**. Nhãn nguồn nói rõ điều đó, và người dùng sửa được. Có nghi vấn FAMAS 0,15 s (có thể sai).
- Các đường cong đang có thời lượng dài hơn T nhiều (bước 450–678 ms). Cho đến khi bấm "Chia đều thời gian theo băng đạn", chúng hiện cảnh báo lệch T.
- Chia đều thời gian làm mất hình dạng thời gian không đều mà người dùng có thể đã sửa tay; đó là chủ ý, và đường cong đã lưu không tự đổi.

## Phụ lục: bảng mặc định (băng thường)

Giây/phát lấy từ trang Liquipedia PUBG Mobile (ảnh chụp khoảng giữa 2025), băng từ BitTopup trừ ba súng máy lấy từ wiki PC. Chu kỳ của súng bắn từng phát là chu kỳ tối thiểu.

| Mã | Băng | Giây/phát | T (ms) | Ghi chú |
|---|---|---|---|---|
| M416 | 30 | 0,085 | 2.465 | |
| AUG | 30 | 0,085 | 2.465 | |
| M762 | 30 | 0,086 | 2.494 | |
| G36C | 30 | 0,086 | 2.494 | |
| Groza | 30 | 0,080 | 2.320 | |
| AKM | 30 | 0,100 | 2.900 | |
| QBZ | 30 | 0,092 | 2.668 | |
| ACE32 | 30 | 0,092 | 2.668 | |
| Scar | 30 | 0,096 | 2.784 | |
| M16 | 30 | 0,075 | 2.175 | bắn theo loạt, thực tế chậm hơn |
| MK47 | 20 | 0,100 | 1.900 | bắn theo loạt; trang nguồn lẫn số liệu |
| FAMAS | 30 | 0,150 | 4.350 | nghi vấn: nhiều khả năng bắn nhanh hơn |
| UZI | 25 | 0,048 | 1.152 | |
| Vector | 19 | 0,054 | 972 | |
| MP5K | 30 | 0,067 | 1.943 | |
| Thomson | 30 | 0,086 | 2.494 | |
| UMP45 | 25 | 0,092 | 2.208 | |
| VSS | 10 | 0,086 | 774 | |
| MK14 | 10 | 0,090 | 810 | |
| SKS | 10 | 0,090 | 810 | |
| SLR | 10 | 0,100 | 900 | |
| QBU | 10 | 0,100 | 900 | |
| Mini14 | 20 | 0,130 | 2.470 | PC ghi 0,1 |
| MK12 | 20 | 0,130 | 2.470 | PC ghi 0,1 |
| MG3 | 75 | 0,066 | 4.884 | băng theo wiki PC; chế độ nhanh |
| DP28 | 47 | 0,109 | 5.014 | băng theo wiki PC |
| M249 | 100 | 0,075 | 7.425 | băng theo wiki PC |
| S686 | 2 | 0,200 | 200 | có thể bắn cả hai nòng cùng lúc |
| S12K | 5 | 0,250 | 1.000 | |
| M1014 | 7 | 0,250 | 1.500 | PC ghi 8 viên |
| S1897 | 5 | 0,750 | 3.000 | |
| M24 | 5 | 1,800 | 7.200 | chu kỳ nạp đạn bolt |
| AWM | 5 | 1,850 | 7.400 | |
| Kar98K | 5 | 1,900 | 7.600 | |
| Mosin | 5 | 1,900 | 7.600 | |
| AMR | 5 | 1,900 | 7.600 | |

Chưa có số liệu (24 súng, để trống): PKM, MG36, MG97, ASM, ACVAL, HB, ARX, ABAKAN, Bison, P90, AKS, JS9, MP7, M417, MK20H, SVD, M200, M1, M338, AS50, Win94, DBS, SPAS12, AA12G.
