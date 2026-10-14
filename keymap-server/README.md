# ft-keymap-server (sao lưu cài đặt Gamwing)

Server tự host chỉ làm một việc: **nhận và sao lưu các file `.xml` trong `Documents/jya2/databases`** của điện thoại/máy tính bảng
(do app `android-sync` gửi lên), kèm một trang web để xem, sửa file nhỏ, so sánh theo ngày và **phân tích `gamwing_keymap_cache.xml`**.
Không có thư viện ngoài, cần Node >= 20.

```
npm start        # lắng nghe trên PORT (mặc định 8787)
npm test         # test của server và các thư viện của trang web
```

## AI gợi ý mốc độ giật

Khi thêm một tổ hợp phụ kiện chưa có mục riêng, trang so sánh hai cách tính các mốc:

- **Server** (`suggest.js`): lấy tối đa 5 súng có đường cong nền (cùng ống ngắm, đứng, không phụ kiện) gần nhất với súng này và có mục riêng cho đúng tổ hợp. Với mỗi súng, "độ lệch thật" = mục riêng / đường cong theo hệ số của chính nó (so trên trục thời gian chia theo thời lượng). Kết quả = đường cong theo hệ số của súng này × độ lệch trung bình có trọng số, thời gian co giãn theo tỉ lệ thời lượng trung bình. Không đoán: không có súng tương tự nào thì báo lý do.
- **AI** (`ai.js`): gửi cho một điểm cuối tương thích OpenAI (`POST {AI_BASE_URL}/chat/completions`) dữ liệu của súng này (đường cong nền, đường cong theo hệ số, các mục riêng khác của súng) và của các súng tương tự (nền, theo hệ số, mục riêng của tổ hợp). AI trả JSON `{points, reasoning}`. Server kiểm tra rất chặt (số hữu hạn, thời gian tăng dần, tối đa 60 mốc, thời lượng 0,25–4 lần và mỗi giá trị 0,4–2,5 lần đường cong theo hệ số); trả lời sai thì chỉ báo lý do, không bao giờ điền vào ô sửa.

Hai bên độc lập (AI **không** thấy kết quả của server). Trên dữ liệu thật, giấu từng mục riêng rồi đoán lại (5800 trường hợp, tập "touch"): sai số giá trị trung bình **8,9% nếu tính theo hệ số → 4,0% theo cách của server**, gần đúng hơn hệ số trong 66% trường hợp (nhóm tay cầm + nòng + báng: ~9–14% → ~2–6%; nhóm chỉ nòng hoặc chỉ báng vốn đã chính xác, hai cách ngang nhau). Với AI mới thử hai ca thật: một ca AI chỉ chép lại đường cong theo hệ số (kém server), một ca AI tốt hơn hẳn server (1,8% so với 5,4%): vì vậy hai kết quả được đặt cạnh nhau cho bạn chọn.

**Gợi ý thêm tổ hợp** (`suggest.comboCandidates`): server tìm hai loại ứng viên cho một súng + ống ngắm + tư thế, bỏ các tổ hợp súng này đã có:
- *Thiếu so với súng tương tự*: tối đa 8 súng có đường cong nền gần nhất, và ít nhất 2 súng trong số đó có mục riêng cho tổ hợp này.
- *Hệ số hay sai*: tổ hợp mà dữ liệu thật cho thấy đường cong theo hệ số thường lệch nhiều (đo trên mọi mục riêng của mọi súng, theo "loại" = tư thế + có/không tay cầm, nòng, báng; ví dụ tay cầm + báng lệch ~17%, chỉ nòng ~1%). Mỗi loại tối đa 3 ứng viên để danh sách đa dạng.

Trên dữ liệu thật hiện tại các súng gần như có cùng bộ tổ hợp, nên loại thứ nhất hầu như trống và loại thứ hai là nguồn chính. Sau đó **AI** (nền, sau ~0,6 giây, hủy nếu bạn đổi súng/tư thế) chỉ **xếp hạng và giải thích** các ứng viên đó (nhãn "AI #n"); AI không thể thêm tổ hợp ngoài danh sách của server. AI tắt hoặc lỗi thì danh sách vẫn hiện, chỉ không có nhãn AI.

**Liệt kê và thêm tất cả tổ hợp còn thiếu**: danh sách gợi ý mờ chỉ hiện 6 tổ hợp "đáng làm trước" (server chọn tối đa 8: súng tương tự đã có, hoặc loại tổ hợp mà hệ số thường sai ≥ 6%; AI chỉ xếp hạng chúng). Nút **Hiện thêm n tổ hợp còn thiếu** hiện nốt phần còn lại: mọi tổ hợp mà súng này lắp được (theo quy tắc phụ kiện và bộ lọc của bảng) nhưng chưa có mục riêng (`missing` trong `combo-suggestions`). Nút **Thêm tất cả (n)** ở đầu danh sách đưa cả n tổ hợp vào bảng thành dòng "mới" (chưa lưu); sau đó **AI tạo mốc** và **Lưu tất cả**. Nút **Lưu tất cả** cũng có ở đầu danh sách gợi ý.

**Bảng không cần kéo ngang**: khi cột danh sách hẹp (có chi tiết bên phải, hoặc cửa sổ nhỏ) mỗi dòng của bảng tổ hợp tự thành hai dòng: dòng trên là tay cầm / nòng / báng, dòng dưới là nguồn, giá trị t=0, giá trị cuối, thời lượng, số mốc (mỗi số có chú thích), nên luôn thấy đủ giá trị. Bảng mốc cũng co theo bề ngang.

**AI tạo mốc và Lưu tất cả** (hai nút đầu bảng Tổ hợp): tổ hợp mới thêm chưa có mốc nên mang nhãn "mới". **AI tạo mốc (n)** tạo mốc cho tất cả cùng lúc (AI trả lời thì dùng, không thì dùng kết quả của server; có thanh tiến trình và nút **Dừng**), kết quả chỉ là bản nháp (nhãn "chờ lưu"), chưa ghi gì. **Lưu tất cả (n)** ghi mọi tổ hợp mới và tổ hợp đang sửa **một lần** (lịch sử của file chỉ thêm một bản cũ), kiểm tra hết trước khi ghi, và hộp thoại có **thanh tiến trình** theo từng bước (áp dụng từng tổ hợp i/n, tạo XML, gửi lên server, cập nhật trang). Sửa dở một tổ hợp mới rồi chuyển sang tổ hợp khác thì phần sửa được giữ lại (không hỏi bỏ), chờ Lưu tất cả. Sau khi lưu, trang tự cập nhật từ chính bản vừa ghi (không tải lại file, không nháy).

**Gợi ý theo bộ lọc của bảng**: khi bạn lọc cột Tay cầm / Nòng / Báng, server chọn ứng viên ngay trong phạm vi đã lọc (kết hợp với quy tắc phụ kiện của súng) và AI được báo bạn đang lọc gì, nên danh sách luôn đầy đủ trong phạm vi đó. Các cột Nguồn, t=0, giá trị cuối, thời lượng, mốc lọc ngay trên trang; bảng đang sắp xếp thì gợi ý xếp theo đó, không thì theo thứ hạng AI. Nút **AI tạo lại** (đầu danh sách) hỏi AI lần nữa để có ý kiến mới (nhiệt độ cao hơn); nút tắt khi AI chưa bật hoặc đang chạy, và thứ hạng cũ được giữ nếu lần hỏi lại lỗi.

## Quy tắc phụ kiện

Nguồn chính: **dữ liệu chính thức của Tencent cho 和平精英** (kho vũ khí: danh sách phụ kiện lắp được của từng súng và danh sách súng áp dụng của từng phụ kiện), đối chiếu với bảng do người dùng cung cấp. Bảng nằm trong `admin/recoil.js` (`ATTACHMENT_RULES`, mỗi súng ghi rõ nguồn: `official` / `appmedia` / `user`; `attachments.test.js` kiểm tra từng tên với enum của app). Tra cứu chi tiết, nguyên văn, các nguồn và độ tin cậy: `docs/PhuKien_Sung_PUBG_Mobile.xlsx`. **Dữ liệu thật của app không cho biết súng nào lắp được gì**: 62/70 súng (cả AWM, Kar98K, AKM…) mang cùng một bộ tổ hợp mẫu.

Hệ thống dùng bảng này ở mọi chỗ **thêm hoặc gợi ý** tổ hợp: hộp Thêm tổ hợp, danh sách gợi ý mờ, "Hiện mọi tổ hợp", thanh ống ngắm, lưu một mục MỚI, và **cả AI**: mỗi câu hỏi gửi cho AI kèm `accessory_rules` của súng (những gì súng lắp được, nguồn, ống ngắm tối đa) và `combination_problems`; danh sách ứng viên đã được lọc theo bảng trước khi AI xếp hạng, nên AI không thể đề xuất phụ kiện súng không lắp được. Mục riêng đã có sẵn trong file không bị đổi hay đánh dấu.

| Nhóm | Mã súng trong app | Đầu nòng | Tay cầm | Báng | Ống ngắm |
|---|---|---|---|---|---|
| M416 | `M416` | 3 loại | 5 + Laser | báng chiến thuật | đến 6x |
| AR không báng | `Scar` `G36C` `QBZ` `AUG` `M762` | 3 loại | 5 + Laser | không | đến 6x |
| ACE32 (chỉ có trong bảng của người dùng) | `ACE32` | 3 loại | 5 (không Laser) | không | đến 6x |
| Mk47, M16A4 | `MK47` `M16` | 3 loại | Mk47: 5 + Laser; M16A4: không | báng chiến thuật | đến 6x |
| AR chỉ nòng | `AKM` `FAMAS` | 3 loại | không | không | đến 6x |
| Groza | `Groza` | chỉ giảm thanh | không | không | đến 6x |
| Micro UZI | `UZI` | 3 loại | không | báng riêng | chỉ 1x |
| Vector | `Vector` | 3 loại | đứng, nhẹ, Half, Laser | báng chiến thuật | đến 6x |
| UMP45 | `UMP45` | 3 loại | 5 + Laser | không | đến 6x |
| Tommy Gun | `Thomson` | chỉ giảm thanh | chỉ tay cầm đứng | không | chỉ 1x |
| Bizon | `Bison` | 3 loại | không | không | đến 6x |
| SR | `Kar98K` `M24` `AWM` | 3 loại | không | không | đến 8x |
| DMR có tay cầm | `SKS` | 3 loại | 5 + Laser | không | đến 8x |
| DMR không tay cầm | `MK14` `SLR` `Mini14` `QBU` `MK12` | 3 loại | không | không | đến 8x |
| VSS | `VSS` | không (tích hợp) | không | không | không lắp được |
| Shotgun | `S12K` | 3 loại | không | không | đến 6x |
| Shotgun | `S1897` `S686` | không | không | không | không lắp được |
| Shotgun, súng máy, nỏ | `DBS` `DP28` `MG3` `CrossBow` | không | không | không | đến 6x |
| Cần lever | `Win94` | không | không | không | không lắp được |

"3 loại" = Nòng hãm giật, ẩn tia lửa, giảm thanh (`COMPENSATOR`, `FLASH_HIDER`, `SUPPRESSOR`). "5" = đứng, tam giác (Angled = `HORIZONTAL`), ngón cái, Half, nhẹ. Laser (`LASER`) nằm trong nhóm tay cầm của Tencent. `MK12`, `FAMAS` lấy từ AppMedia (bản toàn cầu 2022) vì Tencent không có.

Cách hiểu cần biết:
- Các lựa chọn của app mà **không nguồn nào** nhắc tới được coi là không hỗ trợ: tay cầm công thái học (`ERGONOMIC`), nòng `BRAKE`, `EXTENDER`, `BRAKE_NEW`, báng `GENERAL_NEW`. Ốp má, Bullet Loops, Quiver, Choke, Duckbill, băng đạn không có trong danh sách phụ kiện của app nên không áp dụng.
- Báng chiến thuật và báng thường (UZI) đều được ghi là `GENERAL` (chưa biết app dùng `GENERAL` cho loại nào).
- "Ống ngắm tối đa Nx" so với các mục ống ngắm của app: `X63`/`LPVO`/`LPVO_61` tính 6x; `X84`, `tactic`, `tactic_84` tính 8x; `hippie` là bắn hông (luôn được).
- **Chưa áp dụng, đang chờ quyết định** (có một nguồn thứ cấp hoặc nguồn mâu thuẫn, xem sheet "38 súng chưa có quy tắc"): `Mosin` `M1014` `MP5K` `P90` `AMR`. Chúng và 26 mã còn lại chưa có nguồn đáng tin nên **không bị hạn chế** (trang ghi rõ "Chưa có quy tắc phụ kiện"). Danh sách đủ 33 mã: `Empty` `Mosin` `M249` `PKM` `ASM` `M1014` `MP5K` `P90` `AMR` `ACVAL` `Bow` `SPAS12` `M417` `HB` `TacticsBow` `MK20H` `M200` `SHIELD` `AA12G` `AKS` `FireCompositeBow` `SVD` `MG36` `MORTAR` `JS9` `M1` `ARX` `ABAKAN` `M338` `MP7` `AS50` `MG97` `ChiXiao`.

**Cấu hình** (biến môi trường của server; trong Docker đặt trong file `.env` cạnh `docker-compose.yml`, đã được git và Docker bỏ qua; mẫu: `.env.example`):

| Biến | Ý nghĩa |
|---|---|
| `AI_BASE_URL` | Ví dụ `http://192.168.4.6:3001/v1`. Trống = tắt AI (phần của server vẫn chạy) |
| `AI_API_KEY` | Khóa. Chỉ nằm ở server: trình duyệt, các câu trả lời của API và nhật ký đều không chứa khóa hay địa chỉ |
| `AI_MODEL` | Mặc định `auto` (bộ định tuyến chọn). Có thể `fusion`, `glm-5.3`, `gemini-3.8-flash`… |
| `AI_TIMEOUT_MS` | Chờ tối đa (mặc định 120000, tối thiểu 1000) |
| `AI_CONCURRENCY` | Số yêu cầu AI chạy song song khi tạo mốc cho nhiều tổ hợp (1–8, mặc định 3). Trang dùng tối đa 4 luồng; gặp "bận" hoặc HTTP 429/5xx thì đợi rồi thử lại (tối đa 4 lần). Xếp hạng tổ hợp luôn một yêu cầu một lúc |

Lưu ý: chỉ một yêu cầu AI chạy một lúc (tránh dồn dập lên dịch vụ miễn phí); đóng hộp so sánh sẽ hủy yêu cầu đang chờ. Dữ liệu gửi đi chỉ gồm tên súng, ống ngắm, phụ kiện và các đường cong; **bộ định tuyến miễn phí có thể chuyển tiếp tới nhà cung cấp bên ngoài**, hãy cân nhắc nếu bạn coi số liệu này là riêng tư. Đây là khóa API: nếu đã lộ (dán vào chat, commit…) hãy đổi khóa.

| Endpoint | Việc làm |
|---|---|
| `GET /admin/api/ai/status` | `{enabled, model}` (không có khóa) |
| `POST /admin/api/recoil/suggest` | Body `{id, mode: touch/gyro/raw, combo: {weapon, scope, gesture, grip, muzzle, stock}}` (chỉ số enum). Trả `{ok, curve, computed, factor, stretch, similar, ms}` hoặc `{ok:false, reason, computed}` |
| `POST /admin/api/recoil/combo-suggestions` | Body `{id, mode, combo: {weapon, scope, gesture}, filter?: {grips?, muzzles?, stocks?: [int]}}` (`filter` = những phụ kiện bộ lọc của bảng cho qua; sai thì 400). Trả `{ok, candidates:[{grip, muzzle, stock, kind, expectedError, multiplier, stats:{v0, vEnd, duration, points}, seenIn, gap}], similar, total, ms}` hoặc `{ok:false, reason}` |
| `POST /admin/api/ai/rank-combos` | Cùng body, thêm `regenerate?: true` (nút "AI tạo lại"). Server tính lại ứng viên rồi nhờ AI xếp hạng: `{ok, ranking:[{grip, muzzle, stock, rank, reason}], model, ms}` hoặc `{ok:false, reason}` |
| `POST /admin/api/ai/suggest-curve` | Cùng body. Trả `{ok, curve, reasoning, model, ms}` hoặc `{ok:false, reason}` (luôn HTTP 200 khi đầu vào hợp lệ, để trang vẫn dùng được kết quả của server) |

## Chạy bằng Docker (khuyên dùng)

```
docker compose up -d --build     # build và chạy nền
docker compose logs -f           # xem log
docker compose down              # dừng; dữ liệu nằm trong volume "ftdata" nên không mất
```

Trang web: **`http://<máy>:8787/admin`**. **Không có đăng nhập** (chạy trong LAN tin cậy): đừng forward cổng 8787 ra Internet.
Server chỉ chặn các lời gọi do trang web lạ phát ra từ trình duyệt của bạn (kiểm tra `Host`, `Origin` và header `X-Admin-Request`).
Truy cập bằng tên miền riêng thì thêm vào `ADMIN_ALLOWED_HOSTS`. Chỉ cho máy này truy cập: `BIND=127.0.0.1 docker compose up -d`.

## Trang web (6 tab)

Giao diện phẳng, ít chữ: nền xám nhạt, thẻ trắng viền mảnh, **một màu nhấn** (xanh chàm); màu khác chỉ để báo trạng thái hoặc nguy hiểm. Chi tiết kỹ thuật (đường dẫn, id, tên mục trong file) nằm sau dòng "Chi tiết kỹ thuật" / "Nơi lưu", các nút phụ nằm trong menu ba chấm, nút của hàng chỉ hiện khi rê chuột hoặc chọn dòng, và không có thông báo "mọi thứ ổn" thừa (cảnh báo chỉ hiện khi có chuyện).
**Sidebar** bên trái (5 mục, một dòng trạng thái máy tính bảng), **Toolbar** phía trên có nút **Tìm nhanh** và nút đổi giao diện (đường dẫn chỉ hiện khi đang ở trang con); danh sách bên trái và **Inspector** bên phải cho mục đang chọn (dưới 1100 px Inspector xuống dưới danh sách, dưới 1024 px sidebar thành thanh trên). Không tải phông hay thư viện ngoài.
- **Thu gọn menu bên trái** (chỉ trên màn hình rộng ≥ 1024 px): nút "Thu gọn menu" dưới thanh bên, phím **Ctrl+B**, hoặc "Tìm nhanh". Menu còn dải biểu tượng 64 px (tên tab hiện khi rê chuột, chấm xanh/xám là trạng thái kết nối) và vùng làm việc rộng thêm 176 px. Lựa chọn được nhớ trong trình duyệt (`ftAdminNav`).
- **Tìm nhanh (Ctrl+K hoặc "/")**: gõ vài chữ (không cần dấu: "do giat" ra "Độ giật") để nhảy tới tab, một mục của cache, một tệp, hoặc đổi giao diện / tải lại. ↑ ↓ chọn, Enter mở, Esc đóng.
- **Giao diện sáng / tối**: theo hệ thống; nút ở góc phải trên đổi vòng "hệ thống → sáng → tối" và nhớ lựa chọn trong trình duyệt.
- Menu ba chấm ở mỗi hàng gom các thao tác phụ (mở, xem, sửa, tải, lịch sử, sao chép); **Xóa** luôn có hai bước xác nhận và nằm trong menu hoặc Inspector, màu đỏ. Điều khiển được bằng bàn phím (Tab, Enter, Esc, mũi tên); khi đang tải file lớn có khung xám (skeleton).


- **Phân tích cache**: đọc `gamwing_keymap_cache.xml` (file SharedPreferences chứa các mục `list|<namespace>` và `map|<id>`) và cho thấy
  - danh sách theo loại: sơ đồ phím, nhận diện AI, độ giật/cấu hình; bản đang được chọn trong app; tên, ngày, dung lượng;
  - **mục mồ côi** (có nội dung nhưng không nằm trong danh sách), mục thiếu nội dung, tên trong danh sách khác tên trong dữ liệu;
  - bấm một mục: sơ đồ phím/nhận diện AI hiện **trên màn hình mô phỏng** đúng toạ độ (có thể chọn ảnh chụp game làm nền); độ giật hiện
    theo súng, tư thế, ống ngắm, đường cong và hệ số (mô phỏng cách app chọn đường cong, `admin/recoil.js`).
  - **sửa độ giật** (chỉ khi xem bản "Mới nhất"): sửa từng mốc của đường cong một tổ hợp, hoặc xóa "mục riêng" của tổ hợp để app tính lại từ hệ số.
    Chỉ nhận số hữu hạn (không `Infinity`/`NaN`, thời gian ≥ 0); sửa đúng bộ dữ liệu đang xem (touch / gyro / raw) và đúng mục cuối của khóa trùng (mục app dùng);
    súng luôn bằng 0 trong app (`Empty`, `MORTAR`) và súng chưa có nhóm dữ liệu trong file thì không sửa được. Chỉ mục đó được ghi lại, phần còn lại của file giữ nguyên từng byte
    (`replaceMapItem` trong `admin/cachexml.js`); server giữ bản cũ trong lịch sử;
  - **mốc tự tính (cộng dồn)**: "Thêm mốc" tạo mốc nối tiếp mốc cuối: thời gian **+450–678 ms** (số nguyên), giá trị **+1,02–1,35** (hướng *Tăng*), **−1,02–1,35** (hướng *Giảm*) hoặc một trong hai ngẫu nhiên (*Tăng hoặc giảm*); bước giá trị có hai chữ số thập phân. Với ô "Tự tính các mốc sau" bật (mặc định), khi bạn sửa xong thời gian của mốc #n thì thời gian của #n+1, #n+2… được tính lại, mỗi mốc dựa vào mốc đứng trước nó; sửa giá trị thì chỉ các giá trị sau được tính lại (cột còn lại giữ nguyên). Tính lại chạy khi rời ô nhập (hoặc Enter), không chạy từng phím; ô không phải số hợp lệ thì không tính. Tắt ô này để sửa từng mốc riêng lẻ; "Hoàn tác" trả đường cong về bản đang lưu. Lựa chọn được nhớ trong trình duyệt;
  - **tính mốc bằng server và AI, song song** (nút "Tính mốc (server + AI)", hoặc ô "Tính các mốc ngay" trong hộp Thêm tổ hợp): hai kết quả chạy cùng lúc rồi hiện trong một hộp so sánh (biểu đồ chồng nhau, số liệu từng bên, lời giải thích của AI). **Chỉ chọn được một trong hai**; mốc của bên được chọn điền vào ô sửa như một thay đổi chưa lưu. Xem mục "AI gợi ý mốc" bên dưới;
  - **lọc kiểu Excel ở bảng Tổ hợp**: mỗi cột (trừ "Thao tác") có nút phễu ở tiêu đề. Hộp lọc có sắp xếp (A→Z / Z→A, hoặc nhỏ→lớn / lớn→nhỏ với số), khoảng số "từ … đến …" cho cột số, ô tìm (không cần dấu: "dung" ra "đứng"), danh sách giá trị có đếm số dòng để tích chọn, và OK / Hủy / Xóa bộ lọc. Danh sách giá trị của một cột chỉ đếm các dòng mà bộ lọc của CÁC CỘT KHÁC cho qua (như Excel). Nhiều cột lọc cùng lúc là "và". Phễu đang lọc được tô màu, dòng "x/y tổ hợp" cho biết số dòng đang hiện, nút "Xóa bộ lọc (n)" bỏ hết. Esc hoặc bấm ra ngoài thì đóng; Enter trong ô số thì áp dụng. Bộ lọc nằm trong trang, không lưu qua lần tải lại;
  - **gợi ý thêm tổ hợp** (danh sách mờ ngay dưới bảng Tổ hợp, tự hiện khi mở một súng/ống ngắm/tư thế): mỗi dòng có nút **Thêm** (đưa vào danh sách và mở luôn, như thêm tay) và dòng "Hoặc thêm một tổ hợp khác bằng tay…". Chỉ gợi ý tổ hợp chưa có mục riêng và chưa nằm trong bảng, tối đa 6 dòng. Xem mục "AI gợi ý mốc độ giật" để biết cách chọn;
  - **không thêm phụ kiện súng không hỗ trợ**: theo bảng phụ kiện từng súng (mục "Quy tắc phụ kiện" bên dưới). Hộp Thêm tổ hợp làm mờ và khóa các lựa chọn súng không lắp được, danh sách gợi ý và "Hiện mọi tổ hợp" không đưa chúng ra, thanh ống ngắm gạch/mờ ống ngắm quá mức của súng, và lưu một mục MỚI cho phụ kiện không được hỗ trợ bị từ chối. Mục riêng đã có trong file không bị đổi;
  - **thêm tổ hợp không trùng**: hộp "Thêm tổ hợp" báo ngay khi tổ hợp đã có (mục riêng trong file, đã thêm trên trang chưa lưu, hoặc hàng mặc định không phụ kiện). Bấm thêm trên tổ hợp trùng thì chỉ mở tổ hợp đã có, không tạo bản thứ hai;
  - **bản sửa trên web chưa xuống máy**: sau khi lưu, server nhớ file đó là "sửa trên web" cho tới khi máy có đúng bản này (app khôi phục theo ngày rồi đẩy lại cùng nội dung).
    Trong lúc đó mọi lần đẩy NỘI DUNG KHÁC của file ấy từ máy bị từ chối (`skipped`, app ghi "bỏ qua …") để bản cũ trên máy không ghi đè bản vừa sửa.
    Nút **Chấp nhận bản từ máy** (trang Tệp cài đặt hoặc trang phân tích) bỏ cờ này nếu bạn muốn lấy bản của máy;
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
- **Sao lưu theo ngày**: mỗi ngày một thư mục (Timeline); xem và tải từng file. Có thẻ **Kiểm tra đồng bộ** với hai nút:
  - *trên server*: so bản **mới nhất** của từng file với bản sao lưu của **ngày mới nhất** bằng dấu vân tay sha-256; báo file khác, thiếu hoặc thừa trong bản sao lưu;
  - *trên app*: gửi lệnh cho máy tính bảng tự so các file của nó với server (bản mới nhất và ngày mới nhất); kết quả từng máy hiện ngay trên trang (cần app đang bật Chạy ngầm).
  Cả hai cũng có trong Tìm nhanh (Ctrl+K).
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
| `PUT …/databases/<tên>` | Sửa từ trang web: `{text, etag}`; 409 nếu `etag` cũ; 400 nếu `text` không phải file preferences XML (`<map>…</map>`). Nếu nội dung đổi, file được đánh dấu "sửa trên web" (trừ xóa mục của cache, vốn do tablet tự làm theo lệnh) (`web_edit:{at, etag}` trong danh sách và trong nội dung file) |
| `DELETE …/databases/<tên>/web-edit` | Bỏ dấu "sửa trên web" ("Chấp nhận bản từ máy"): lần đẩy kế tiếp của máy được phép thay bản trên server |
| `GET …/databases/<tên>/history[/<phiên bản>]` | Các bản cũ |
| `GET /admin/api/sync/backups` | Danh sách ngày sao lưu (mới nhất trước) |
| `GET …/backups/<YYYY-MM-DD>/databases` | Cả bộ file của một ngày (tên thật, có dấu và CJK) |
| `GET …/backups/<YYYY-MM-DD>/databases/<tên>` | Một file của một ngày |
| `POST …/hello`, `GET …/devices`, `DELETE …/devices/<id>`, `POST /admin/api/presence` | Kết nối app ↔ web. Câu trả lời của `hello` có `commands`: các lệnh đang chờ thiết bị đó |
| `POST /admin/api/cache/delete` | `{file, ids, etag, labels}`: cắt các mục khỏi file cache trên server (cần `etag` hiện hành, 409 nếu file đã đổi; 404 nếu id không có ở đâu; 400 nếu id/file sai) và tạo lệnh cho các thiết bị đã biết |
| `GET /admin/api/cache/commands` | Các lệnh gần đây (50 mới nhất) với trạng thái `pending` / `done` / `attention` / `server_only` / `expired` và kết quả từng thiết bị |
| `GET /admin/api/sync/verify` | Kiểm tra đồng bộ trên server: `{ok, at, day, checked, same, problems:[{name, kind: different / missing_in_day / extra_in_day, …sha256}]}`; `reason: "no_backup_day"` khi chưa có ngày sao lưu |
| `GET /admin/api/sync/manifest` | Dấu vân tay `{latest:[{name,bytes,sha256}], day:{date, files:[…]}\|null}` của bản mới nhất và của ngày sao lưu mới nhất (app dùng để tự so) |
| `POST /admin/api/sync/verify-request` | Nhờ các máy đã biết tự kiểm tra: tạo lệnh `verify_sync`; máy trả kết quả (`verify`) qua `…/commands/<id>/result` |
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

## Kiểm tra theo chuẩn phụ kiện và xóa mục dư

- **M249** theo dữ liệu chính thức 和平精英 và xác nhận của bạn: **không có tay cầm, nòng, báng; ống ngắm chỉ đến 6x** (không có 8x, 4–8x, chiến thuật). Bản toàn cầu có báng chiến thuật nhưng 和平精英 thì không.
- Dữ liệu thật của app mang cùng một mẫu tổ hợp cho gần như mọi súng, nên rất nhiều mục riêng không khớp bảng chuẩn (trên bản đang thử: 1981/5941, riêng M249 77). Nút **Kiểm tra theo chuẩn (n)** trong thẻ chọn súng (và dòng cảnh báo "… có n mục riêng không đúng chuẩn phụ kiện" ở danh sách) mở cửa sổ liệt kê theo súng, mỗi súng mở ra xem từng mục và lý do (tay cầm / nòng / báng / ống ngắm).
- **Chọn tất cả mục dư** bằng một ô, hoặc chọn theo súng, hoặc từng mục (ban đầu không chọn gì). **Xóa n mục đã chọn** → xác nhận → xóa MỘT lần (mọi bản trùng khóa) với thanh tiến trình; bản cũ của file giữ trong lịch sử. Tổ hợp bị xóa không còn mục riêng nên app tính từ hệ số. Dòng bảng có mục sai chuẩn hiện nhãn đỏ "sai chuẩn". Súng chưa có trong bảng chuẩn không bị kiểm tra.

## Tạo đủ tổ hợp cho cả súng, và tab "Tiêu chuẩn súng"

- **Tạo đủ cho cả súng** (nút trong danh sách tổ hợp): một lần quét **mọi ống ngắm × 3 tư thế** của súng đang xem (ống ngắm nào bảng chuẩn không cho thì bỏ), liệt kê mọi tổ hợp súng lắp được theo bảng chuẩn mà chưa có mục riêng (AUG: 605 tổ hợp). Bạn xác nhận (có ô chọn số tổ hợp nhờ AI), rồi hộp thoại tiến trình làm 4 bước: **tính mốc** (từ súng tương tự nếu có súng nào đã có mục riêng cho đúng tổ hợp đó; không thì lấy đường cong theo hệ số, đúng cái app đang dùng), **AI tạo mốc** cho số tổ hợp quan trọng nhất bạn chọn (mặc định 10; có nút Dừng; AI trả lệch quá thì giữ kết quả của server), **kiểm tra lại** (mọi đường cong hợp lệ, không tổ hợp nào sai bảng chuẩn, quét lần hai không còn thiếu gì, đánh dấu "xem lại" cho tổ hợp lệch nhiều so với hệ số), **thêm vào danh sách** (chưa lưu). Kết thúc bấm **Lưu tất cả (n)** ngay trong hộp thoại kết quả: ghi một lần mọi tổ hợp của mục này (kể cả ở ống ngắm và tư thế khác với cái đang xem).
- AI chỉ làm được vài chục tổ hợp trong thời gian hợp lý (mỗi tổ hợp 10–40 giây), nên không thể hỏi AI cho cả vài trăm; phần còn lại dùng server/hệ số.
- **Tab Tiêu chuẩn súng**: bảng mọi mã súng dạng `M416 (22)` (số trong ngoặc là số thứ tự trong dữ liệu) với nòng, tay cầm, báng, ống ngắm tối đa, loại, trạng thái (Có chuẩn / Chờ xác nhận / Luôn 0 / Chưa có nguồn); lọc kiểu Excel; bấm một súng để xem nguồn và ghi chú. **Đối chiếu với dữ liệu thật** thêm hai cột lấy từ file cache trên server: số mục riêng của súng và số mục sai chuẩn (chọn mục độ giật và bộ dữ liệu).
