# Trục thời gian theo thời gian bắn hết băng: kế hoạch cài đặt

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Gắn trục thời gian của các mốc độ giật với thời gian bắn hết một băng thường (T) của từng súng, chia đều các mốc trên T, và đưa mẫu đó cho AI và phần tính của server.

**Architecture:** `admin/recoil.js` (chạy ở trình duyệt và Node) giữ mô hình `fire` (băng, giây/phát) và các hàm thuần chia thời gian; server lưu phần sửa của người dùng trong `gun-standards.json` và trả qua `/admin/api/standards`; trang Tiêu chuẩn súng sửa được thông số; trình sửa đường cong, hộp "Thêm mốc cho súng", `ai.js` và `suggest.js` dùng `fireOf` để chia đều. Súng chưa có `fire` giữ nguyên cách cũ ở mọi nơi.

**Tech Stack:** Node >= 20 không thư viện ngoài, `node --test`, JavaScript thuần ở trình duyệt (CSP `style-src 'self'`: không dùng thuộc tính `style` trong markup).

**Spec:** `docs/superpowers/specs/2026-10-16-magazine-time-axis-design.md` (đọc kèm, kể cả phụ lục bảng 36 súng).

## Global Constraints

- T = `round((magazine − 1) × interval × 1000)` ms; `magazine` là số nguyên 1–200, `interval` 0,02–3 (giây). Chỉ băng thường.
- n mốc: mốc thứ i ở `round(i × T ÷ (n − 1))`, số nguyên, **luôn tăng dần** (không bao giờ trùng), `n = 1` → `[0]`.
- Đổi số mốc: nội suy tuyến tính theo thời gian chuẩn hóa, giữ nguyên giá trị đầu và cuối (phương án A đã chốt).
- Câu trả lời của AI: giữ nguyên giá trị theo thứ tự, chỉ thay thời gian bằng lưới chia đều (`withEvenTimes`); không từ chối vì thời lượng khi súng có `fire`.
- Súng chưa có `fire` (và súng zero, súng bị tắt): hành vi y hệt hiện nay (bước 450–678 ms, kiểm tra thời lượng cũ 0,25–4 lần và 0,5–2 lần).
- Đường cong đã lưu không tự đổi. Mọi thao tác hàng loạt chỉ tạo bản nháp (`rc.drafts`), không ghi file.
- Chữ giao diện bằng tiếng Việt; số thập phân hiển thị dùng dấu phẩy như `vn()` trong `analysis.js`.
- Tăng số `?v=` của tệp tĩnh đã đổi trong `admin/index.html` ở mỗi task giao diện.
- Theo `CLAUDE.md`: hỏi subagent `advisor` trước khi chốt kế hoạch, khi một lỗi lặp lại hai lần, và trước khi báo xong. Commit kết thúc bằng hai dòng `Co-Authored-By` và `Claude-Session` do hệ thống cung cấp.
- Chạy test: `cd keymap-server && node --test` (hiện 203 test qua).

## Review Focus

- T rất nhỏ so với n (ví dụ T = 100 ms, n = 60): thời gian vẫn tăng dần, không có hai mốc trùng. → Task 2.
- Đường cong 1 mốc, thời lượng 0, hoặc có giá trị không hữu hạn khi nội suy: không ném lỗi, không sinh `NaN`. → Task 2.
- `gun-standards.json` cũ không có `fire`, hoặc `fire` có giá trị rác (băng 0, chữ, âm): file vẫn đọc được, phần rác bị bỏ. → Task 3.
- AI trả sai số mốc hoặc thời gian không đều: được chuẩn hóa chứ không bị từ chối; AI trả giá trị lệch quá xa thì vẫn bị từ chối. Câu trả lời "giữ nguyên" khi rà soát vẫn qua và không bị đổi thời gian. → Task 5.
- Súng chưa có `fire`: hộp "Thêm mốc cho súng", nút Thêm mốc, `analogCurve` và validators của AI cho đúng kết quả cũ. → Tasks 5, 6, 8.

---

## File Structure

| Tệp | Trách nhiệm |
|---|---|
| `keymap-server/admin/recoil.js` | `FIRE_DEFAULTS`, `checkFire`, `emptyMsOf`, `setFireOverrides`, `getFireOverrides`, `fireOf`; `evenTimes`, `resample`, `retime`, `withEvenTimes`, `spreadAfter`, `durationGap` |
| `keymap-server/gun-standards.js` | đọc, ghi `fire` trong `gun-standards.json`; `setFire`, `resetFire`, `listFire` |
| `keymap-server/admin.js` | `GET/PUT /admin/api/standards` trả và nhận `fire`; `DELETE /admin/api/standards/:code/fire` |
| `keymap-server/admin/app.js`, `admin/standards.js` | nạp `fire` vào `RecoilLib`; cột và hộp sửa thông số bắn |
| `keymap-server/ai.js` | mẫu trục thời gian trong câu hỏi; chuẩn hóa câu trả lời |
| `keymap-server/suggest.js` | `analogCurve` kết thúc ở T khi có `fire` |
| `keymap-server/admin/analysis.js` | dòng "Hết băng", thêm/bớt mốc, chia đều, hộp "Thêm mốc cho súng", nút chia đều cả súng |
| `keymap-server/README.md` | mô tả tính năng |
| `*.test.js` tương ứng | `recoil.test.js`, `gun-standards.test.js`, `admin.test.js`, `ai.test.js`, `suggest.test.js` |

---

### Task 1: Mô hình thông số bắn trong RecoilLib

**Files:**
- Modify: `keymap-server/admin/recoil.js` (thêm cạnh `ATTACHMENT_RULES`, xuất trong `return {…}`)
- Test: `keymap-server/recoil.test.js`

**Interfaces:**
- Produces:
  - `FIRE_DEFAULTS: { [code: string]: { magazine: number, interval: number, note?: string } }` — đúng 36 súng ở phụ lục spec (giá trị chép nguyên).
  - `checkFire(f: any) -> { ok: true, fire: { magazine: number, interval: number } } | { ok: false, error: string }` — `magazine` nguyên 1–200, `interval` hữu hạn 0,02–3, `interval` làm tròn 4 chữ số thập phân; thông báo lỗi tiếng Việt.
  - `emptyMsOf(fire: { magazine, interval }) -> number` = `Math.round((magazine − 1) × interval × 1000)`.
  - `setFireOverrides(map: { [code]: { magazine, interval } | null }) -> map` đã lọc; `getFireOverrides() -> map`. Mã không có trong `WEAPONS` hoặc là `Empty`, hoặc giá trị không qua `checkFire` (và khác `null`) bị bỏ.
  - `fireOf(weapon: number | string) -> { magazine, interval, emptyMs, source: 'default' | 'edited', sourceLabel: string, note: string, edited: boolean } | null`. `null` khi: súng zero, súng bị tắt, người dùng đặt `null`, hoặc không có mặc định lẫn phần sửa.

- [ ] **Step 1: Write the failing tests** trong `recoil.test.js`: `fireOf('M416')` có `magazine 30`, `interval 0.085`, `emptyMs 2465`, `source 'default'`; `fireOf('AWM').emptyMs === 7400`, `fireOf('S686').emptyMs === 200`; `fireOf('P90') === null` (không có mặc định); `Object.keys(FIRE_DEFAULTS).length === 36` và mọi mã nằm trong `WEAPONS`; `fireOf('MORTAR') === null`; `setFireOverrides({ M416: { magazine: 40, interval: 0.09 } })` cho `fireOf('M416').emptyMs === 3510` và `edited === true`; `setFireOverrides({ M416: null })` cho `fireOf('M416') === null`; `setFireOverrides({ M416: { magazine: 0, interval: 0.09 }, Foo: { magazine: 5, interval: 1 }, AKM: { magazine: 'x', interval: 0.1 } })` cho `getFireOverrides()` bằng `{}`; `checkFire` từ chối `magazine 201`, `1.5`, `interval 0.01`, `4`, `NaN`, `null`; `setDisabledGuns(['M416'])` làm `fireOf('M416') === null`. Mỗi test dọn trạng thái (`setFireOverrides({})`, `setDisabledGuns([])`).
- [ ] **Step 2: Run to verify failure:** `cd keymap-server && node --test recoil.test.js` → FAIL (hàm chưa có).
- [ ] **Step 3: Implement** các hàm trên trong `recoil.js`; `FIRE_DEFAULTS` chép nguyên bảng phụ lục của spec (mã dùng đúng tên trong `WEAPONS`, ví dụ `Thomson`, `Scar`, `DP28`). `SOURCES.fire = 'Liquipedia PUBG Mobile (giây/phát) và BitTopup (băng); chưa kiểm chứng'` dùng làm `sourceLabel` mặc định; phần sửa dùng `SOURCES.edited`. Thêm vào danh sách xuất.
- [ ] **Step 4: Run** `node --test recoil.test.js` → PASS.
- [ ] **Step 5: Commit** `feat(recoil): fire model (magazine, interval) with default table and overrides`.

---

### Task 2: Hàm chia đều thời gian

**Files:**
- Modify: `keymap-server/admin/recoil.js`
- Test: `keymap-server/recoil.test.js`

**Interfaces:**
- Produces (đều thuần, không đổi tham số đầu vào trừ `spreadAfter`):
  - `evenTimes(T: number, n: number) -> number[]`: n ≤ 0 → `[]`; n = 1 → `[0]`; ngược lại `round(i·T/(n−1))`, rồi ép tăng dần bằng `t[i] = max(t[i], t[i−1] + 1)`.
  - `resample(curve: [number, number][], n: number, T: number) -> [number, number][]`: thời gian `evenTimes(T, n)`; giá trị nội suy tuyến tính theo `u = t ÷ thời lượng cũ` (thời lượng cũ = thời gian mốc cuối); mốc đầu và cuối giữ đúng giá trị cũ; đường cong 1 mốc hoặc thời lượng ≤ 0 → mọi mốc lấy `curve[0][1]`; đường rỗng → `[]`; giá trị làm tròn 4 chữ số thập phân.
  - `retime(curve, T) = resample(curve, curve.length, T)`.
  - `withEvenTimes(curve, T)`: giữ nguyên giá trị theo thứ tự, thay thời gian bằng `evenTimes(T, curve.length)`.
  - `spreadAfter(curve, index: number, T: number) -> number`: sửa tại chỗ thời gian các mốc sau `index` thành chia đều từ `curve[index][0]` đến T; không làm gì và trả 0 nếu `T <= curve[index][0]` hoặc `index` ngoài phạm vi; trả số mốc đã đổi.
  - `durationGap(curve, T) -> number` = `|thời lượng ÷ T − 1|`; T ≤ 0 → `0`.

- [ ] **Step 1: Write the failing tests**: `evenTimes(2465, 11)` = `[0, 247, 493, 740, 986, 1233, 1479, 1726, 1972, 2219, 2465]` (số học `round(i·246.5)` — kiểm lại từng phần tử khi viết); `evenTimes(100, 60)` tăng dần chặt và có 60 phần tử khác nhau; `evenTimes(5, 1)` = `[0]`, `evenTimes(5, 0)` = `[]`; `resample([[0,0],[1000,10]], 5, 2000)` có thời gian `[0,500,1000,1500,2000]` và giá trị `[0,2.5,5,7.5,10]`; hai đầu giữ nguyên khi n khác; tăng rồi giảm lại số mốc của một đường cong parabol giữ sai lệch nhỏ (< 3%); `resample([[0,7]], 4, 1000)` toàn giá trị 7; `resample([[0,1],[0,2]], 3, 100)` không `NaN`; `retime` giữ số mốc; `withEvenTimes([[0,1],[10,5],[11,9]], 1000)` = `[[0,1],[500,5],[1000,9]]`; `spreadAfter` trên 5 mốc, `index = 1`, T = 1000 cho `[.., t1, ..]` chia đều đúng và trả 3, và trả 0 khi `T <= curve[1][0]`; `durationGap([[0,0],[2000,1]], 2000) === 0`, `durationGap([[0,0],[4000,1]], 2000) === 1`.
- [ ] **Step 2: Run** `node --test recoil.test.js` → FAIL.
- [ ] **Step 3: Implement** theo chữ ký trên trong `recoil.js` (hàm nội suy riêng nhỏ `valueAt(curve, t)`; `recoil.js` không được `require` `suggest.js` vì chạy ở trình duyệt). Xuất tất cả.
- [ ] **Step 4: Run** `node --test` → toàn bộ PASS.
- [ ] **Step 5: Commit** `feat(recoil): even time axis helpers (evenTimes, resample, retime, withEvenTimes)`.

---

### Task 3: Lưu và API cho thông số bắn

**Files:**
- Modify: `keymap-server/gun-standards.js`, `keymap-server/admin.js` (khối `standards`, dòng ~307–328), `keymap-server/admin/app.js` (`loadStandards`)
- Test: `keymap-server/gun-standards.test.js`, `keymap-server/admin.test.js`

**Interfaces:**
- Consumes: `R.setFireOverrides`, `R.getFireOverrides`, `R.checkFire` (Task 1).
- Produces:
  - `GunStandards#setFire(code: string, fire: { magazine, interval } | null) -> { ok: true } | { ok: false, error }`; `resetFire(code) -> { ok } | { ok:false, error: 'Súng này chưa được sửa thông số bắn.' }`; `listFire() -> map`. `save()` ghi `{ overrides, disabled, fire }`; constructor đọc `saved.fire` (thiếu → `{}`).
  - `GET /admin/api/standards` → `{ overrides, disabled, fire }`.
  - `PUT /admin/api/standards/:code` chấp nhận thêm `body.fire` (object hoặc `null`), dùng riêng hoặc kèm `rule`/`disabled`; phản hồi `{ ok: true, overrides, disabled, fire }`.
  - `DELETE /admin/api/standards/:code/fire` → `{ ok: true, overrides, disabled, fire }`.

- [ ] **Step 1: Write the failing tests**: ở `gun-standards.test.js`: `setFire('M416', { magazine: 40, interval: 0.09 })` rồi tạo `GunStandards` mới từ cùng file thì `R.fireOf('M416').emptyMs === 3510`; file cũ chỉ có `{ overrides: {}, disabled: [] }` vẫn đọc được; file có `fire: { M416: { magazine: 0, interval: 1 }, X: 3 }` được đọc mà không ném lỗi và `listFire()` bằng `{}`; `setFire('Foo', …)` và `setFire('Empty', …)` trả `ok:false`; `setFire('M416', { magazine: 9999, interval: 1 })` trả `ok:false` với `error`; `resetFire` trả `ok:false` nếu chưa sửa, `ok:true` nếu đã sửa và `fireOf` về mặc định. Ở `admin.test.js` (dùng `withServer`, `raw`, header `X-Admin-Request`): `GET` có khóa `fire`; `PUT` với `fire` hợp lệ trả 200 và `fire.M416`; `PUT` với `fire` sai trả 400; thiếu header trả lỗi như các route khác; `DELETE …/fire` trả 200. Dọn `R.setFireOverrides({})` ở `afterEach`.
- [ ] **Step 2: Run** `node --test gun-standards.test.js admin.test.js` → FAIL.
- [ ] **Step 3: Implement** theo giao diện trên; trong `admin.js` thêm một route `DELETE` cho `/admin/api/standards/:code/fire` đặt **trước** route regex hiện có, dùng `safeDecode` và cùng quy tắc kiểm tra như route cũ; `PUT` chỉ trả 400 "Thiếu "rule", "disabled" hoặc "fire"." khi cả ba đều vắng. Trong `app.js`, `loadStandards` gọi thêm `window.RecoilLib.setFireOverrides(r.fire || {})`.
- [ ] **Step 4: Run** `node --test` → PASS.
- [ ] **Step 5: Commit** `feat(standards): persist and serve fire parameters`.

---

### Task 4: Trang Tiêu chuẩn súng: cột và hộp sửa

**Files:**
- Modify: `keymap-server/admin/standards.js` (`rows()`, bảng, `editRule`, `inspector`, `saveOverrides`), `keymap-server/admin/index.html` (tăng `?v=` của `standards.js`)
- Test: kiểm bằng trình duyệt (không có test Node cho giao diện này)

**Interfaces:**
- Consumes: `RL.fireOf`, `RL.setFireOverrides` (Task 1); `PUT /standards/:code` với `fire`, `DELETE /standards/:code/fire` (Task 3).
- Produces: ba cột **Băng**, **Giây/phát**, **Hết băng (s)** (lọc và sắp xếp như cột khác; súng không có `fire` hiện `—`); dòng nguồn trong inspector; hai ô nhập trong hộp "Sửa tiêu chuẩn" cùng dòng tính trực tiếp "Hết băng: x,xx s"; nút "Đặt lại thông số bắn" khi đã sửa.

- [ ] **Step 1: Implement** `rows()` thêm `fire`, `magazine`, `interval`, `emptyS` (từ `RL.fireOf(w)`); `saveOverrides` gọi `RL.setFireOverrides(r.fire)` khi có; trong `editRule` thêm hai ô số (`magazine`, `interval`), trường trống cả hai = không gửi `fire`, trống một ô = báo lỗi tại chỗ, và gửi `fire: { magazine, interval }` cùng `rule`; nút "Đặt lại thông số bắn" gọi `DELETE …/fire`; xóa thông số của súng chưa có mặc định bằng cách gửi `fire: null`.
- [ ] **Step 2: Verify trên trình duyệt** (Playwright có sẵn tại `/opt/node-tools`; máy chủ thử với `DATA_DIR` tạm): mở tab Tiêu chuẩn súng; M416 hiện `30`, `0,085`, `2,47`; sửa M416 thành 40 viên, 0,09 rồi lưu thì dòng đổi thành `3,51`; bấm "Đặt lại thông số bắn" thì quay về `2,47`; P90 hiện `—`; không có lỗi trình duyệt; chụp ảnh sáng và tối ở 1440 px và 390 px.
- [ ] **Step 3: Commit** `feat(admin): fire parameters in the gun standards table and editor`.

---

### Task 5: AI: mẫu trục thời gian và chuẩn hóa câu trả lời

**Files:**
- Modify: `keymap-server/ai.js` (`SYSTEM`, `SYSTEM_REVIEW`, `buildMessages`, `buildReviewMessages`, `validatePoints`, `validateReview`, `curveTaker`, `review`)
- Test: `keymap-server/ai.test.js`

**Interfaces:**
- Consumes: `R.fireOf`, `R.withEvenTimes`, `R.evenTimes` (Tasks 1–2).
- Produces:
  - `buildMessages(idx, target, opts)` và `buildReviewMessages(...)`: trong JSON dữ liệu, `target.time_axis = { duration_ms: T, point_count: n, rule: string } | null` (`n` = số mốc của đường theo hệ số; với rà soát là số mốc của `current_curve`).
  - `validatePoints(points, computed, fire = null)` và `validateReview(points, current, fire = null)`: khi `fire` khác `null` thì **bỏ** kiểm tra thời lượng (0,25–4 và 0,5–2 lần); kết quả `curve` đã qua `R.withEvenTimes(points, fire.emptyMs)`; ngoại lệ: `validateReview` trả nguyên `points` khi `sameCurve(points, current)` (câu trả lời "giữ nguyên"). Kiểm tra giá trị (0,4–2,5 và 0,6–1,6 lần), số mốc ≤ 60 và `checkCurve` giữ nguyên.

- [ ] **Step 1: Write the failing tests**: `buildMessages` cho M416 có `time_axis.duration_ms === 2465` và `point_count` bằng số mốc đường ước tính, và dòng hướng dẫn nhắc "evenly spaced"; cho súng không có `fire` thì `time_axis === null`; `validatePoints` với `fire` chấp nhận câu trả lời có thời lượng 10 lần đường theo hệ số, trả `curve` có thời gian `evenTimes`, và giữ nguyên thứ tự giá trị; vẫn từ chối giá trị lệch 5 lần; không có `fire` thì vẫn từ chối thời lượng lệch 5 lần (kết quả cũ); `validateReview` với `fire` trả nguyên câu trả lời giống hệt `current` (không đổi thời gian); câu trả lời khác `current` được chuẩn hóa thời gian; AI trả 61 mốc vẫn bị từ chối.
- [ ] **Step 2: Run** `node --test ai.test.js` → FAIL.
- [ ] **Step 3: Implement**: thêm vào hai `SYSTEM*` một câu: nếu `target.time_axis` khác null thì thời gian đã cố định (cách đều từ 0 đến `duration_ms`), AI chỉ quyết định **giá trị** và trả đúng `point_count` mốc, server sẽ đặt lại thời gian. `curveTaker` và `review` truyền `R.fireOf(target.weapon)` cho validator. Cập nhật `module.exports` nếu cần.
- [ ] **Step 4: Run** `node --test` → PASS.
- [ ] **Step 5: Commit** `feat(ai): time-axis sample in the prompt and even-time normalisation of answers`.

---

### Task 6: `analogCurve` kết thúc ở T

**Files:**
- Modify: `keymap-server/suggest.js` (`analogCurve`)
- Test: `keymap-server/suggest.test.js`

**Interfaces:**
- Consumes: `R.fireOf`, `R.evenTimes` (Tasks 1–2).
- Produces: khi `R.fireOf(target.weapon)` khác `null`, `analogCurve(...).curve` có thời gian `evenTimes(T, computed.length)`, giá trị như cũ, `stretch = T ÷ duration(computed)` (1 nếu thời lượng 0). Súng không có `fire`: giữ nguyên kết quả cũ.

- [ ] **Step 1: Write the failing tests** (dựng dữ liệu bằng `build` có sẵn trong file test, bật `fire` bằng `R.setFireOverrides({ AUG: { magazine: 4, interval: 0.1 } })`, dọn ở cuối test): mốc cuối đúng 300 ms và thời gian là `[0, 150, 300]` với đường 3 mốc; giá trị bằng giá trị cũ; `stretch` bằng `300 ÷ 200`; thiếu `fire` thì thời gian vẫn như test "the time axis stretches like the similar guns do".
- [ ] **Step 2: Run** `node --test suggest.test.js` → FAIL.
- [ ] **Step 3: Implement** bước đặt lại thời gian ở cuối `analogCurve` (giữ nhánh cũ khi không có `fire`).
- [ ] **Step 4: Run** `node --test` → PASS.
- [ ] **Step 5: Commit** `feat(suggest): analogCurve ends at the magazine time when the gun has fire data`.

---

### Task 7: Trình sửa đường cong

**Files:**
- Modify: `keymap-server/admin/analysis.js` (`recoilDetail`: `committed`, `delBtn`, `addBtn`, hàng nút ~dòng 2930, đầu trình sửa), `keymap-server/admin/app.css` (nhãn lệch T, nếu cần), `keymap-server/admin/index.html` (`?v=`)

**Interfaces:**
- Consumes: `RL.fireOf`, `RL.resample`, `RL.retime`, `RL.spreadAfter`, `RL.durationGap` (Tasks 1–2).
- Produces: dòng "Hết băng: 2,47 s (30 viên × 0,085 s)" và nhãn cảnh báo khi `RL.durationGap(curve, T) > 0.05`, cập nhật theo `updateLive()`; nút **Chia đều thời gian theo băng đạn** (tắt khi súng không có `fire`).

- [ ] **Step 1: Implement** (súng có `fire` thì dùng cách mới, không thì giữ code cũ): **Thêm mốc** = `curve.splice(0, curve.length, ...RL.resample(curve, curve.length + 1, T))`; xóa mốc = cùng cách với `curve.length − 1` (nút vẫn tắt khi chỉ còn 1 mốc); `committed(i, 0)` với `rc.autoStep` gọi `RL.spreadAfter(curve, i, T)` rồi `syncRows(i + 1)`; nút chia đều gọi `RL.retime` tại chỗ, đặt `rc.dirty = true`, vẽ lại bảng và biểu đồ.
- [ ] **Step 2: Verify trên trình duyệt**: dùng dữ liệu độ giật mẫu (xem cách dựng ở phiên làm việc trước: M416 có nhiều ống ngắm và tư thế); mở một đường cong 4 mốc của M416 → dòng "Hết băng: 2,47 s" và nhãn lệch T; bấm Chia đều thì mốc cuối = 2465 và các mốc cách đều; Thêm mốc cho 5 mốc, các mốc vẫn cách đều và hình dạng biểu đồ gần như không đổi; xóa một mốc tương tự; với AUG chưa có `fire`, các nút hành xử như cũ; không lỗi trình duyệt; chụp ảnh sáng và tối.
- [ ] **Step 3: Commit** `feat(admin): even time axis in the curve editor`.

---

### Task 8: Hộp "Thêm mốc cho súng" và chia đều cả súng

**Files:**
- Modify: `keymap-server/admin/analysis.js` (`showBatchAddPointsModal`, hàng nút cạnh `batchAddPointsBtn`), `keymap-server/admin/index.html` (`?v=`)

**Interfaces:**
- Consumes: `RL.fireOf`, `RL.resample`, `RL.retime`, `RL.batchCombos` (Tasks 1–2 và code hiện có).
- Produces: một hàm trong `analysis.js` `applyToDrafts(ix, targets, makeCurve, how)` dùng chung cho hộp thoại và nút mới (tách từ vòng lặp đang có trong hộp thoại: lấy `baseCurve` từ bản nháp, `rc.editCurve` hoặc `RL.resolve`, tạo `rc.drafts.set(key, { o, curve, review: true, source, how, change: 0 })`); nút **Chia đều thời gian cả súng** (tắt khi súng không có `fire`, tắt hoặc zero, hoặc `!latest()`).

- [ ] **Step 1: Implement**: trong hộp "Thêm mốc cho súng", khi súng có `fire`: bỏ hai thẻ "Quy tắc tính mốc", thay bằng một đoạn giải thích "Các mốc mới được nội suy lại trên T = x,xx s, hình dạng đường cong giữ nguyên"; mỗi tổ hợp được `RL.resample(base, base.length + count, T)`; tóm tắt nhắc T. Khi súng không có `fire`: giữ nguyên hai thẻ và cách cũ. Nút chia đều cả súng: hộp xác nhận nêu số tổ hợp (mục riêng của súng, `RL.batchCombos(...).own`) rồi gọi `applyToDrafts` với `RL.retime(base, T)` và `how: 'chia đều theo băng đạn'`; toast kết quả; mọi thứ là bản nháp.
- [ ] **Step 2: Verify trên trình duyệt**: với M416 mở hộp thoại, thấy đoạn giải thích thay thẻ; chọn ống 2x, tư thế Đứng, +2 mốc → toast "Đã thêm 2 mốc cho 2 tổ hợp"; mở một tổ hợp vừa đổi thì có đúng n + 2 mốc và mốc cuối bằng T; "Chia đều thời gian cả súng" tạo bản nháp cho mọi mục riêng; với AUG (không `fire`) hộp thoại giữ nguyên hai thẻ và nút chia đều bị tắt; không lỗi trình duyệt; chụp ảnh hộp thoại sáng và tối.
- [ ] **Step 3: Commit** `feat(admin): batch add points and whole-gun retime use the magazine time axis`.

---

### Task 9: Tài liệu, kiểm tra toàn nhánh, rà soát

**Files:**
- Modify: `keymap-server/README.md` (mục mới "Trục thời gian theo băng đạn"; sửa câu mô tả ở phần AI gợi ý về thời lượng nếu còn nói thời lượng tự do), `docs/superpowers/specs/2026-10-16-magazine-time-axis-design.md` (mục "Đã làm, và khác với bản thiết kế" nếu có điều khác)

- [ ] **Step 1: Update README** nêu: ý nghĩa T, công thức, cột mới ở Tiêu chuẩn súng, quy tắc chia đều và nội suy, nút chia đều, súng chưa có số liệu giữ cách cũ, và cảnh báo số mặc định chưa kiểm chứng.
- [ ] **Step 2: Run** `cd keymap-server && node --test` → toàn bộ PASS (không còn test thất bại; ghi lại số test).
- [ ] **Step 3: Gọi `advisor`** xem lại toàn bộ nhánh `claude/magazine-time-axis` (so với `claude/batch-points-scope-posture`): lỗi thật, hồi quy cho súng chưa có `fire`, và các mục trong "Review Focus"; sửa lỗi thật rồi chạy lại test.
- [ ] **Step 4: Commit và push** `docs: magazine time axis in the README`; `git push -u origin claude/magazine-time-axis`.

---

## Self-review

- **Spec coverage:** mục 1 (thông số bắn, API, giao diện) → Tasks 1, 3, 4; mục 2 (trục thời gian, nơi áp dụng, nút chia đều, dòng "Hết băng") → Tasks 2, 7, 8; mục 3 (AI, server) → Tasks 5, 6; mục 4 (kiểm thử, ảnh chụp, advisor) → có trong từng task và Task 9; rủi ro (số chưa kiểm chứng, đường cũ lệch T) → nhãn nguồn Task 1 và nhãn lệch Task 7.
- **Khác nhẹ so với spec, đã quyết trong kế hoạch:** câu trả lời AI dùng `withEvenTimes` (giữ giá trị theo thứ tự) thay vì nội suy; câu trả lời "giữ nguyên" khi rà soát không bị đổi thời gian; thêm `durationGap` và `spreadAfter` làm hàm thuần để kiểm thử được.
- **Nhất quán tên:** `fireOf`, `emptyMs`, `evenTimes`, `resample`, `retime`, `withEvenTimes`, `spreadAfter`, `durationGap`, `setFireOverrides`, `getFireOverrides`, `checkFire` dùng giống nhau ở mọi task.
