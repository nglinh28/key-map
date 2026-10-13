package vn.local.ftkeymapsync

import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.content.res.ColorStateList
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.RippleDrawable
import android.graphics.Typeface
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.text.Editable
import android.text.InputType
import android.text.TextWatcher
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.WindowInsets
import android.view.inputmethod.EditorInfo
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.Switch
import android.widget.TextView
import java.util.concurrent.Executors

class MainActivity : Activity() {
    private lateinit var prefs: Prefs
    private val io = Executors.newSingleThreadExecutor()
    private val ui = Handler(Looper.getMainLooper())
    private lateinit var statusView: TextView
    private lateinit var webView: TextView
    private lateinit var logView: TextView
    private lateinit var logScroll: ScrollView
    private lateinit var actionsView: TextView
    private lateinit var permBox: LinearLayout
    private lateinit var serverInput: EditText
    private lateinit var savedView: TextView
    private lateinit var savedDot: View
    private lateinit var nameInput: EditText
    private lateinit var folderInput: EditText
    private lateinit var autoSwitch: Switch

    private enum class Level { INFO, OK, WARN, ERR }

    private val night get() = (resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES
    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()

    // The heartbeat that lets the web page see this phone is connected (the service sends its own while the auto-push is on).
    private val beatTask = object : Runnable {
        override fun run() {
            sendHeartbeat()
            ui.postDelayed(this, HeartbeatMs)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        prefs = Prefs(this)
        setContentView(buildUi())
        StatusBus.history().forEach { appendLog(it) }
        if (prefs.autoPush) startWatch() // the service may have been killed with the process
    }

    override fun onStart() {
        super.onStart()
        StatusBus.listener = { line -> appendLog(line) }
    }

    override fun onStop() {
        StatusBus.listener = null
        super.onStop()
    }

    override fun onResume() {
        super.onResume()
        refreshPermission()
        refreshActions()
        checkConnection() // the "which server am I connected to" message, every time the app opens
        ui.post(beatTask)
    }

    override fun onPause() {
        ui.removeCallbacks(beatTask)
        super.onPause()
    }

    // ------------------------------------------------------------------ UI
    // Semantic colours, one set per theme. Text on its own surface is at least 4.5:1 in both; the status colour lives in a dot
    // next to words that say the same thing, so colour is never the only signal.
    private class Palette(
        val bg: Int, val surface: Int, val text: Int, val muted: Int, val line: Int,
        val primary: Int, val onPrimary: Int, val ok: Int, val warn: Int, val err: Int, val warnBg: Int,
    )

    private val pal by lazy {
        if (night) {
            Palette(0xFF14171C.toInt(), 0xFF1C2027.toInt(), 0xFFE6E8EC.toInt(), 0xFFA8B0BD.toInt(), 0xFF3A414C.toInt(), 0xFF8AB0FF.toInt(), 0xFF0E1420.toInt(), 0xFF5CCF8B.toInt(), 0xFFE3B25A.toInt(), 0xFFFF8A80.toInt(), 0xFF3A2F12.toInt())
        } else {
            Palette(0xFFF3F4F6.toInt(), 0xFFFFFFFF.toInt(), 0xFF1B1F27.toInt(), 0xFF566070.toInt(), 0xFFC9CED6.toInt(), 0xFF2F6FED.toInt(), 0xFFFFFFFF.toInt(), 0xFF1B7A43.toInt(), 0xFF8A5A00.toInt(), 0xFFB3261E.toInt(), 0xFFFFF3CD.toInt())
        }
    }

    private val actionButtons = mutableListOf<Button>()
    private lateinit var statusDot: View
    private lateinit var webDot: View

    private fun rounded(fill: Int, stroke: Int? = null, radiusDp: Int = 12) = GradientDrawable().apply {
        setColor(fill)
        cornerRadius = dp(radiusDp).toFloat()
        if (stroke != null) setStroke(dp(1), stroke)
    }

    private fun pressable(fill: Int, stroke: Int?, ripple: Int, radiusDp: Int = 10) =
        RippleDrawable(ColorStateList.valueOf(ripple), rounded(fill, stroke, radiusDp), rounded(Color.WHITE, null, radiusDp))

    private fun matchWrap() = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)

    private fun buildUi(): View {
        // Two columns when the window is wide enough (a tablet held sideways); one centred column otherwise.
        val twoColumns = resources.configuration.screenWidthDp >= 840
        val gutter = dp(if (resources.configuration.screenWidthDp >= 600) 24 else 16)

        // ---- connection
        statusView = TextView(this).apply { text = "Đang kiểm tra kết nối…"; textSize = 16f; setTextColor(pal.text); accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE }
        webView = TextView(this).apply { text = "Giao diện web: chưa rõ"; textSize = 14f; setTextColor(pal.muted) }
        statusDot = dot(pal.muted)
        webDot = dot(pal.muted)
        serverInput = EditText(this).apply {
            setText(prefs.serverUrl)
            hint = "192.168.4.17:8787"
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
            imeOptions = EditorInfo.IME_ACTION_DONE
            isSingleLine = true
            setOnEditorActionListener { _, actionId, _ -> if (actionId == EditorInfo.IME_ACTION_DONE) { saveServer(); true } else false }
        }
        savedView = TextView(this).apply { textSize = 14f; setTextColor(pal.text); accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE }
        savedDot = dot(pal.muted)
        nameInput = EditText(this).apply {
            setText(prefs.deviceName)
            isSingleLine = true
            addTextChangedListener(watcher { prefs.deviceName = it })
        }
        val settingsCard = card("Cài đặt server") {
            field("Địa chỉ server (ví dụ 192.168.4.17:8787, lưu trong máy)", serverInput)
            addView(actionButton("Lưu địa chỉ", true) { saveServer() }, matchWrap().apply { topMargin = dp(10) })
            addView(statusLine(savedDot, savedView), matchWrap().apply { topMargin = dp(10) })
            field("Tên thiết bị (hiện trên trang web)", nameInput)
        }
        val connectCard = card("Kết nối") {
            addView(statusLine(statusDot, statusView))
            addView(statusLine(webDot, webView), matchWrap().apply { topMargin = dp(6) })
        }

        // ---- folder
        folderInput = EditText(this).apply {
            setText(prefs.databasesPath)
            hint = DEFAULT_DATABASES
            isSingleLine = true
            addTextChangedListener(watcher { prefs.databasesPath = it })
        }
        val folderCard = card("Thư mục") {
            field("Thư mục cài đặt Gamwing (tính từ bộ nhớ trong; bắt đầu bằng / là đường dẫn đầy đủ)", folderInput)
        }

        // ---- actions: the one that matters most is filled, the rest are outlined
        val actionCard = card("Thao tác") {
            addView(actionButton("Đẩy lên server", true) { pushAll() }, matchWrap())
            actions(
                actionButton("Khôi phục theo ngày…", false) { restoreByDay() },
                actionButton("Kiểm tra kết nối", false) { checkConnection() },
                actionButton("Quét file", false) { scanFolder() },
                actionButton("Kiểm tra đồng bộ trên app", false) { checkTabletSync() },
                actionButton("Kiểm tra đồng bộ trên server", false) { checkServerSync() },
            )
        }

        // ---- automatic push
        autoSwitch = switchRow("Tự đẩy lên server khi thư mục có thay đổi", prefs.autoPush) { on ->
            prefs.autoPush = on
            if (on) { ensureNotificationPermission(); startWatch() } else stopWatch()
        }
        val autoCard = card("Tự động") {
            addView(autoSwitch, matchWrap())
            addView(TextView(context).apply {
                text = "Kiểm tra mỗi 3 giây; chỉ đẩy file đã đổi và đã ngừng thay đổi."
                textSize = 13f; setTextColor(pal.muted); setPadding(0, dp(2), 0, 0)
            })
        }

        // ---- danger zone
        val dangerCard = card("Vùng nguy hiểm") {
            addView(TextView(context).apply {
                text = "Xóa toàn bộ file cài đặt, lịch sử từng file và sao lưu theo ngày đang lưu trên server. File trên máy tính bảng không bị đụng tới."
                textSize = 13f; setTextColor(pal.muted)
            })
            addView(actionButton("Xóa toàn bộ trên server…", false, danger = true) { confirmWipe() }, matchWrap().apply { topMargin = dp(10) })
        }

        // ---- log
        logView = TextView(this).apply { typeface = Typeface.MONOSPACE; textSize = 12f; setTextColor(pal.text); setTextIsSelectable(true) }
        logScroll = ScrollView(this).apply {
            addView(logView)
            setPadding(dp(10), dp(8), dp(10), dp(8))
            background = rounded(pal.bg, null, 8)
        }
        val logCard = card("Nhật ký") { addView(logScroll, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(if (twoColumns) 200 else 240))) }

        // ---- what the web page made this tablet do, and the checks after a push (kept across restarts)
        actionsView = TextView(this).apply { textSize = 13f; setTextColor(pal.text); setTextIsSelectable(true) }
        val historyCard = card("Việc đã làm theo lệnh từ web") { addView(actionsView) }
        refreshActions()

        // storage permission: only shown while it is missing
        permBox = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            background = rounded(pal.warnBg, pal.warn)
            setPadding(dp(16), dp(14), dp(16), dp(14))
            layoutParams = matchWrap().apply { bottomMargin = dp(12) }
            addView(TextView(context).apply { text = "Cần quyền \"Truy cập mọi file\" để đọc thư mục của app Gamwing."; textSize = 14f; setTextColor(pal.text) })
            addView(actionButton("Cấp quyền truy cập mọi file", true) { openAllFilesSettings() }, matchWrap().apply { topMargin = dp(10) })
        }

        val col = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(gutter, dp(20), gutter, dp(28)) }
        col.addView(TextView(this).apply { text = "KeyMap Sync"; textSize = 24f; setTypeface(null, Typeface.BOLD); setTextColor(pal.text); isAccessibilityHeading = true })
        col.addView(TextView(this).apply {
            text = "Sao lưu cài đặt Gamwing (jya2/databases) lên server"
            textSize = 14f; setTextColor(pal.muted); setPadding(0, dp(2), 0, dp(14))
        })
        col.addView(permBox)
        if (twoColumns) {
            // left: where it connects and which folders; right: what to do, automatic push, the log
            fun column(vararg cards: View, endGap: Boolean) = LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL
                cards.forEach { addView(it) }
                layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply { if (endGap) marginEnd = dp(16) }
            }
            col.addView(LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                addView(column(settingsCard, connectCard, folderCard, dangerCard, endGap = true))
                addView(column(actionCard, historyCard, autoCard, logCard, endGap = false))
            }, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        } else {
            listOf(settingsCard, connectCard, folderCard, actionCard, historyCard, autoCard, logCard, dangerCard).forEach { col.addView(it) }
        }

        // Content is centred and at most 640dp (one column) or 1200dp (two) wide, so a big screen is not stretched edge to edge.
        val limit = dp(if (twoColumns) 1200 else 640)
        val widthParam = if (resources.displayMetrics.widthPixels > limit) limit else ViewGroup.LayoutParams.MATCH_PARENT
        val frame = FrameLayout(this).apply {
            addView(col, FrameLayout.LayoutParams(widthParam, ViewGroup.LayoutParams.WRAP_CONTENT).apply { gravity = Gravity.TOP or Gravity.CENTER_HORIZONTAL })
        }
        val root = ScrollView(this).apply { isFillViewport = true; setBackgroundColor(pal.bg); addView(frame) }
        window.decorView.setBackgroundColor(pal.bg)
        // Android 15 draws apps edge to edge: keep the content out from under the system bars
        root.setOnApplyWindowInsetsListener { v, insets ->
            val bars = insets.getInsets(WindowInsets.Type.systemBars())
            v.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            insets
        }
        return root
    }

    /** Delete everything on the server. Typed confirmation, because one stray tap must not be able to do this. */
    private fun confirmWipe() {
        val url = serverUrlOrNull() ?: return
        val input = EditText(this).apply {
            hint = "Gõ XOA để xác nhận"
            isSingleLine = true
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_CAP_CHARACTERS
            textSize = 16f
            setTextColor(pal.text)
            setHintTextColor(pal.muted)
            background = rounded(pal.bg, pal.err, 8)
            setPadding(dp(12), dp(10), dp(12), dp(10))
            minHeight = dp(48)
        }
        val body = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(24), dp(8), dp(24), 0)
            addView(TextView(context).apply {
                text = "Sẽ xóa TOÀN BỘ trên server $url:\n" +
                    "• các file cài đặt Gamwing đã sao lưu (kể cả ADBKey.xml, gamwing_keymap_cache.xml) và lịch sử từng file\n" +
                    "• mọi bản sao lưu theo ngày\n\n" +
                    "File trên máy tính bảng không bị đụng tới. Server giữ lại đúng một bản sao của lần xóa này trong thư mục data/_wiped cho tới lần xóa kế tiếp; muốn xóa hẳn phải xóa tay thư mục đó.\n\n" +
                    "Tự đẩy sẽ không đẩy lại các file chưa thay đổi, nên server sẽ trống cho tới khi có file đổi hoặc bạn bấm \"Đẩy lên server\"."
                textSize = 14f
                setTextColor(pal.text)
            })
            addView(input, matchWrap().apply { topMargin = dp(14) })
        }
        val dialog = AlertDialog.Builder(this)
            .setTitle("Xóa toàn bộ dữ liệu trên server?")
            .setView(body)
            .setNegativeButton("Hủy", null)
            .setPositiveButton("Xóa toàn bộ", null)
            .create()
        dialog.setOnShowListener {
            val ok = dialog.getButton(AlertDialog.BUTTON_POSITIVE)
            ok.isEnabled = false
            ok.setTextColor(pal.err)
            input.addTextChangedListener(watcher { ok.isEnabled = it.trim().equals("XOA", ignoreCase = true) })
            ok.setOnClickListener {
                dialog.dismiss()
                runWipe(url)
            }
        }
        dialog.show()
    }

    private fun runWipe(url: String) {
        val me = identity()
        setBusy(true)
        StatusBus.log("Đang xóa toàn bộ dữ liệu trên server…")
        io.execute {
            try {
                val r = ServerClient(url, identity = me).wipe()
                StatusBus.log("Đã xóa toàn bộ dữ liệu trên server (${r.moved.joinToString()}). Bản sao của lần xóa này nằm ở ${r.keptIn} trên server.")
                runOnUiThread { checkConnection() }
            } catch (e: Exception) {
                StatusBus.log("Lỗi: ${e.message ?: e.javaClass.simpleName}")
            } finally {
                runOnUiThread { setBusy(false) }
            }
        }
    }

    private fun card(title: String?, build: LinearLayout.() -> Unit): LinearLayout = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        background = rounded(pal.surface, pal.line)
        setPadding(dp(16), dp(14), dp(16), dp(16))
        layoutParams = matchWrap().apply { bottomMargin = dp(12) }
        if (title != null) {
            addView(TextView(context).apply { text = title; textSize = 16f; setTypeface(null, Typeface.BOLD); setTextColor(pal.text); isAccessibilityHeading = true; setPadding(0, 0, 0, dp(6)) })
        }
        build()
    }

    private fun LinearLayout.field(labelText: String, input: EditText) {
        addView(TextView(context).apply { text = labelText; textSize = 12f; setTextColor(pal.muted); setPadding(0, dp(12), 0, dp(4)) })
        input.apply {
            textSize = 15f
            setTextColor(pal.text)
            setHintTextColor(pal.muted)
            background = rounded(pal.bg, pal.line, 8)
            setPadding(dp(12), dp(10), dp(12), dp(10))
            minHeight = dp(48)
            contentDescription = labelText
        }
        addView(input, matchWrap())
    }

    private fun dot(color: Int) = View(this).apply {
        background = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(color) }
        importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO // the words next to it say the same thing
        layoutParams = LinearLayout.LayoutParams(dp(10), dp(10)).apply { marginEnd = dp(10); gravity = Gravity.CENTER_VERTICAL }
    }

    private fun statusLine(d: View, t: TextView) = LinearLayout(this).apply {
        orientation = LinearLayout.HORIZONTAL
        gravity = Gravity.CENTER_VERTICAL
        addView(d)
        addView(t, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
    }

    private fun switchRow(text: String, checked: Boolean, onChange: (Boolean) -> Unit) = Switch(this).apply {
        this.text = text
        textSize = 15f
        setTextColor(pal.text)
        minHeight = dp(48)
        setPadding(0, dp(6), 0, dp(6))
        isChecked = checked
        setOnCheckedChangeListener { _, on -> onChange(on) }
    }

    private fun actionButton(text: String, primary: Boolean, danger: Boolean = false, onClick: () -> Unit) = Button(this).apply {
        this.text = text
        isAllCaps = false
        textSize = 15f
        setTypeface(null, if (primary) Typeface.BOLD else Typeface.NORMAL)
        minHeight = dp(48)
        minimumHeight = dp(48)
        stateListAnimator = null // no elevation jump, pressed feedback is the ripple
        setPadding(dp(12), dp(8), dp(12), dp(8))
        if (primary) {
            setTextColor(pal.onPrimary)
            background = pressable(pal.primary, null, if (night) 0x33000000 else 0x33FFFFFF)
        } else if (danger) {
            setTextColor(pal.err)
            background = pressable(pal.surface, pal.err, (pal.err and 0x00FFFFFF) or 0x33000000)
        } else {
            setTextColor(pal.primary)
            background = pressable(pal.surface, pal.primary, (pal.primary and 0x00FFFFFF) or 0x33000000)
        }
        setOnClickListener { onClick() }
        actionButtons += this
    }

    /** Buttons two to a row (one per row on a very narrow screen), 8dp apart; a lone last button takes the full width. */
    private fun LinearLayout.actions(vararg buttons: Button) {
        val narrow = resources.configuration.screenWidthDp < 360
        val rows = if (narrow) buttons.map { listOf(it) } else buttons.toList().chunked(2)
        for (pair in rows) {
            addView(
                LinearLayout(context).apply {
                    orientation = LinearLayout.HORIZONTAL
                    pair.forEachIndexed { i, b ->
                        val lp = if (pair.size == 1) matchWrap() else LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply { if (i == 1) marginStart = dp(8) }
                        addView(b, lp)
                    }
                },
                matchWrap().apply { topMargin = dp(8) },
            )
        }
    }

    /** While a long action runs, the buttons are visibly off so a second tap cannot start a second copy. */
    private fun setBusy(on: Boolean) {
        actionButtons.forEach { it.isEnabled = !on; it.alpha = if (on) 0.5f else 1f }
    }

    private fun watcher(onChange: (String) -> Unit) = object : TextWatcher {
        override fun beforeTextChanged(s: CharSequence?, a: Int, b: Int, c: Int) = Unit
        override fun onTextChanged(s: CharSequence?, a: Int, b: Int, c: Int) = Unit
        override fun afterTextChanged(s: Editable?) = onChange(s?.toString() ?: "")
    }

    private fun levelColor(level: Level) = when (level) {
        Level.OK -> pal.ok
        Level.ERR -> pal.err
        Level.WARN -> pal.warn
        Level.INFO -> pal.muted
    }

    private fun setStatus(text: String, level: Level) {
        statusView.text = text
        (statusDot.background as GradientDrawable).setColor(levelColor(level))
    }

    private fun setWeb(text: String, open: Boolean) {
        webView.text = text
        (webDot.background as GradientDrawable).setColor(if (open) pal.ok else pal.muted)
    }

    private fun appendLog(line: String) {
        logView.append(line + "\n")
        logScroll.post { logScroll.fullScroll(View.FOCUS_DOWN) }
    }

    // ------------------------------------------------------------------ permissions
    private fun hasAllFiles() = Environment.isExternalStorageManager()

    private fun refreshPermission() {
        permBox.visibility = if (hasAllFiles()) View.GONE else View.VISIBLE
    }

    private fun openAllFilesSettings() {
        val intent = Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION, Uri.parse("package:$packageName"))
        try { startActivity(intent) } catch (e: Exception) { startActivity(Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION)) }
    }

    private fun ensureNotificationPermission() {
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1)
        }
    }

    // ------------------------------------------------------------------ service
    private fun startWatch() {
        startForegroundService(Intent(this, WatchService::class.java))
    }

    private fun stopWatch() {
        stopService(Intent(this, WatchService::class.java))
    }

    // ------------------------------------------------------------------ actions
    private fun identity() = identityOf(this, prefs)

    /** The saved address (normalized), or null with the reason in the log and under the field. */
    private fun serverUrlOrNull(): String? {
        val url = normalizeServerUrl(prefs.serverUrl)
        if (url == null) {
            val why = savedServerState().first
            StatusBus.log(why)
            setSaved(why, savedServerState().second)
        }
        return url
    }

    /** what to say about the address stored in the phone, and in which colour */
    private fun savedServerState(): Pair<String, Level> {
        val saved = prefs.serverUrl
        if (saved.isBlank()) return "Chưa lưu địa chỉ server. Nhập địa chỉ ở trên rồi bấm \"Lưu địa chỉ\"." to Level.WARN
        val problem = serverUrlProblem(saved)
        if (problem != null) return "Địa chỉ đã lưu không dùng được: $problem Sửa lại ở trên rồi bấm \"Lưu địa chỉ\"." to Level.ERR
        return "Đang dùng: ${normalizeServerUrl(saved)} (đã lưu trong máy)" to Level.OK
    }

    private fun setSaved(text: String, level: Level) {
        savedView.text = text
        (savedDot.background as GradientDrawable).setColor(levelColor(level))
    }

    /** Stores the address only when it is usable; otherwise says why and keeps what was saved before. */
    private fun saveServer() {
        val input = serverInput.text.toString()
        val problem = serverUrlProblem(input)
        if (problem != null) {
            setSaved("Chưa lưu: $problem", Level.ERR)
            StatusBus.log("Chưa lưu địa chỉ server: $problem")
            return
        }
        val url = normalizeServerUrl(input)!!
        prefs.serverUrl = url
        serverInput.setText(url)
        setSaved("Đã lưu địa chỉ server: $url", Level.OK)
        StatusBus.log("Đã lưu địa chỉ server: $url")
        checkConnection()
    }

    /** Runs [work] in the background with a ready engine; checks the address and the storage permission first. */
    private fun withEngine(work: (LocalFolder, SyncEngine) -> Unit) {
        val url = serverUrlOrNull() ?: return
        if (!hasAllFiles()) { StatusBus.log("Chưa cấp quyền \"Truy cập mọi file\"."); refreshPermission(); return }
        val folder = LocalFolder(resolveFolder(folderInput.text.toString()))
        val me = identity()
        setBusy(true)
        io.execute {
            try {
                work(folder, SyncEngine(folder, ServerClient(url, identity = me), backupRoot(), actions = prefs))
            } catch (e: Exception) {
                StatusBus.log("Lỗi: ${e.message ?: e.javaClass.simpleName}")
            } finally {
                runOnUiThread { setBusy(false) }
            }
        }
    }

    private fun checkConnection() {
        val url = normalizeServerUrl(prefs.serverUrl)
        val state = savedServerState()
        setSaved(state.first, state.second)
        if (url == null) { setStatus("Chưa có địa chỉ server hợp lệ: xem mục Cài đặt server", Level.WARN); setWeb("Giao diện web: chưa rõ (chưa có địa chỉ server)", false); return }
        setStatus("Đang kiểm tra kết nối tới $url …", Level.INFO)
        val me = identity()
        io.execute {
            try {
                val info = ServerClient(url, connectTimeoutMs = 4_000, readTimeoutMs = 8_000, identity = me).info()
                runOnUiThread { setStatus(info.describe(url), Level.OK); setWeb(info.webLine(), info.webSessions > 0) }
                StatusBus.log("${info.describe(url)} · ${info.backupDays} ngày sao lưu · phiên bản server ${info.version}")
            } catch (e: SyncException) {
                runOnUiThread { setStatus(e.message ?: "Không kết nối được", Level.ERR); setWeb("Giao diện web: chưa rõ (chưa kết nối server)", false) }
            }
        }
    }

    /** every 15 s while this screen is on: tells the server (so the web page) this phone is here, and learns whether the web page is open */
    private fun sendHeartbeat() {
        val url = normalizeServerUrl(prefs.serverUrl) ?: return
        val me = identity()
        val auto = prefs.autoPush
        val folder = prefs.databasesPath
        io.execute {
            try {
                val r = ServerClient(url, connectTimeoutMs = 4_000, readTimeoutMs = 8_000, identity = me).hello(Heartbeat(auto, folder, if (auto) "watching" else "idle", ""))
                runOnUiThread { setWeb(if (r.webSessions > 0) "Giao diện web: đang mở (${r.webSessions} phiên)" else "Giao diện web: chưa có ai mở", r.webSessions > 0) }
                if (r.commands.isNotEmpty()) {
                    // the web page asked something of this tablet (delete items of the cache file, check the sync)
                    if (!hasAllFiles()) StatusBus.log("Có lệnh từ giao diện web nhưng chưa cấp quyền \"Truy cập mọi file\".")
                    else {
                        val local = LocalFolder(resolveFolder(folder))
                        SyncEngine(local, ServerClient(url, identity = me), backupRoot(), actions = prefs).runCommands(r.commands).forEach { StatusBus.log(it) }
                        runOnUiThread { refreshActions() }
                    }
                }
            } catch (e: SyncException) {
                // the status line above already shows the connection problem
            }
        }
    }

    private fun scanFolder() = withEngine { _, engine ->
        StatusBus.log(engine.scan().describe())
    }

    private fun pushAll() = withEngine { folder, engine ->
        val scan = engine.scan()
        if (!scan.exists) { StatusBus.log(scan.describe()); return@withEngine }
        StatusBus.log("Đang đẩy ${scan.files} file lên server…")
        val s = engine.push()
        prefs.lastPushedDb = databaseFingerprints(folder) // the watcher must not push the same files again
        StatusBus.log("Đã đẩy lên: ${s.describe()}")
        s.skipped.forEach { StatusBus.log("  bỏ qua $it") }
        // the files just sent must be the same as the newest backup day on the server
        val sent = folder.scan().map { it.name }.filter { DatabaseNames.isBackupName(it) }
        engine.checkAfterPush(sent).lines().forEach { StatusBus.log(it) }
        runOnUiThread { refreshActions() }
    }

    /** "Kiểm tra đồng bộ trên app": the files on this tablet against the server's latest copy and its newest backup day. */
    private fun checkTabletSync() = withEngine { _, engine ->
        StatusBus.log("Đang kiểm tra đồng bộ giữa máy tính bảng và server…")
        val r = engine.checkSync()
        r.lines().forEach { StatusBus.log(it) }
        showResult("Đồng bộ giữa máy tính bảng và server", r.lines(), good = r.inSync)
    }

    /** "Kiểm tra đồng bộ trên server": the server compares its latest copy with its newest backup day. */
    private fun checkServerSync() {
        val url = serverUrlOrNull() ?: return
        val me = identity()
        setBusy(true)
        StatusBus.log("Đang nhờ server kiểm tra đồng bộ…")
        io.execute {
            try {
                val r = ServerClient(url, identity = me).serverVerify()
                r.lines().forEach { StatusBus.log(it) }
                showResult("Đồng bộ trên server", r.lines(), good = r.ok)
            } catch (e: Exception) {
                StatusBus.log("Lỗi: ${e.message ?: e.javaClass.simpleName}")
            } finally {
                runOnUiThread { setBusy(false) }
            }
        }
    }

    private fun showResult(title: String, lines: List<String>, good: Boolean) {
        runOnUiThread {
            AlertDialog.Builder(this)
                .setTitle(if (good) "$title: ĐÃ ĐỒNG BỘ" else "$title: CHƯA ĐỒNG BỘ")
                .setMessage(lines.joinToString("\n"))
                .setPositiveButton("Đóng", null)
                .show()
        }
    }

    /** the list of what the web page made this tablet do (deleted items by name, checks) and of the checks after a push */
    private fun refreshActions() {
        val lines = prefs.actionLog().take(12)
        actionsView.text = if (lines.isEmpty()) "Chưa có gì. Khi bạn xóa mục hoặc kiểm tra đồng bộ từ giao diện web, app ghi lại ở đây." else lines.joinToString("\n\n")
    }

    private fun restoreByDay() = withEngine { folder, engine ->
        val days = engine.listBackupDays().filter { it.databases > 0 }
        if (days.isEmpty()) { StatusBus.log("Server chưa có bản sao lưu nào."); return@withEngine }
        runOnUiThread {
            AlertDialog.Builder(this)
                .setTitle("Chọn ngày để khôi phục")
                .setItems(days.map { it.describe() }.toTypedArray()) { _, i ->
                    val day = days[i]
                    io.execute {
                        try {
                            StatusBus.log("Đang lấy bản sao lưu ngày ${day.date}…")
                            confirmAndApply(folder, engine, engine.planRestore(day.date), day.date)
                        } catch (e: Exception) {
                            StatusBus.log("Lỗi: ${e.message ?: e.javaClass.simpleName}")
                        }
                    }
                }
                .setNegativeButton("Hủy", null)
                .show()
        }
    }

    /** Shows what would change, warns, and only after the user agrees writes the files (old ones are copied first). */
    private fun confirmAndApply(folder: LocalFolder, engine: SyncEngine, plan: PullPlan, day: String) {
        plan.rejected.forEach { StatusBus.log("  bỏ qua tên file không được phép: $it") }
        StatusBus.log("Ngày $day: ${plan.items.size} file — ${plan.newCount} mới, ${plan.changedCount} khác, ${plan.sameCount} giống")
        if (plan.newCount + plan.changedCount == 0) { StatusBus.log("Không có gì để ghi."); return }
        val names = plan.items.filter { it.state != PullState.SAME }.joinToString("\n") { "• ${it.name} (${if (it.state == PullState.NEW) "mới" else "sẽ bị ghi đè"})" }
        runOnUiThread {
            AlertDialog.Builder(this)
                .setTitle("Ghi ${plan.newCount + plan.changedCount} file của ngày $day vào ${folder.dir.path}?")
                .setMessage(
                    "$names\n\n⚠ Đây là file cài đặt của chính app Gamwing. Hãy ĐÓNG HẲN Gamwing trước khi ghi; nếu app đang chạy nó có thể ghi đè lại " +
                        "hoặc không đọc lại các file này. Tôi chưa kiểm chứng app có đọc lại hay không.\n\n" +
                        "File cũ bị ghi đè được sao lưu vào ${backupRoot().path}/<thời gian>/databases/.",
                )
                .setNegativeButton("Hủy") { _, _ -> StatusBus.log("Đã hủy.") }
                .setPositiveButton("Ghi vào thư mục") { _, _ ->
                    io.execute {
                        val r = engine.applyRestore(plan)
                        prefs.lastPushedDb = databaseFingerprints(folder)
                        StatusBus.log("Đã ghi ${r.written.size} file." + (r.backupDir?.let { " File cũ đã sao lưu vào ${it.path}" } ?: ""))
                        r.failed.forEach { StatusBus.log("  lỗi: $it") }
                    }
                }
                .show()
        }
    }

    companion object {
        private const val HeartbeatMs = 15_000L
    }
}
