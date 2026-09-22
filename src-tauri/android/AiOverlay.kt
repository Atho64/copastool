package com.copastool.app

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Context
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.util.Log
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.InputMethodManager
import android.webkit.ConsoleMessage
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import android.content.ContentValues
import android.content.Intent
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.util.Base64
import android.widget.Toast
import androidx.core.content.FileProvider
import androidx.appcompat.app.AppCompatActivity
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.json.JSONObject

/**
 * CSTL in-app AI companion overlay.
 *
 * Tauri v2 cannot create a second webview window on Android, so instead of
 * punting the AI site into a whole separate browser app, this draws a native
 * floating panel (draggable, resizable, closable) ON TOP of the CopasTool screen
 * and hosts the AI site in its own WebView. Full Auto Copas keeps working because
 * the frontend drives it through the same `open`/`evalAsync` calls it would make on
 * desktop — nothing leaves the app.
 *
 * Side-by-side / docking has been removed on Android because smartphone screens are
 * too small to split and docking causes black screen layout corruption when closed.
 * The overlay remains purely floating on top without ever resizing or clipping
 * the main CopasTool webview.
 *
 * Security: the host allow-list mirrors ALLOWED_AI_HOSTS in src-tauri/src/lib.rs,
 * plus one optional user-provided host for a custom Web AI URL. `open()` refuses
 * any non-allow-listed https host, `eval*()` refuse to inject while the overlay
 * sits on a different host. The JS interface is attached ONLY to the main
 * (trusted, local) webview — never to the overlay WebView, so third-party AI
 * pages cannot call back into it.
 *
 * NOTE: this file is copied into src-tauri/gen/android by
 * scripts/patch-android-overlay.mjs — edit it in src-tauri/android/.
 */
object AiOverlay {
    private const val INTERFACE_NAME = "AndroidAiOverlay"
    private const val TAG = "CSTL-Overlay"
    private const val PREFS = "copas_overlay"

    // Keep in sync with ALLOWED_AI_HOSTS in src-tauri/src/lib.rs.
    private val ALLOWED_HOSTS = setOf(
        "gemini.google.com",
        "aistudio.google.com",
        "chatgpt.com",
        "chat.openai.com",
        "chat.deepseek.com",
        "meta.ai",
        "claude.ai",
        "chat.qwenlm.ai",
        "lmarena.ai",
        "freebuff.chat",
    )

    private val HOST_RE = Regex("^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$")

    /** Extra host allowed for the user's custom Web AI URL ("" = none). */
    private var extraHost: String = ""

    private var activity: Activity? = null
    private var mainWebView: WebView? = null
    private var container: FrameLayout? = null
    private var panel: FrameLayout? = null
    private var webView: WebView? = null
    private var titleView: TextView? = null
    private var onBackPressedCallback: androidx.activity.OnBackPressedCallback? = null

    /** Last URL we opened: `WebView.url` is briefly empty right after loadUrl. */
    private var lastUrl: String = ""

    /**
     * True while a Full Auto loop (translate / glossary / AI check) runs.
     * Set from JS via `setBackgroundWork`. While set, the activity keeps the
     * screen on and `onActivityPaused()` immediately unfreezes the main
     * WebView after WryActivity.onPause() froze it — so Auto Copas keeps
     * polling the overlay when the app is backgrounded.
     */
    @Volatile private var backgroundWork = false

    private fun prefs(): android.content.SharedPreferences? =
        activity?.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    private fun clearLegacyDockPrefs() {
        try {
            prefs()?.edit()
                ?.remove("docked")
                ?.remove("side")
                ?.remove("ratio")
                ?.apply()
        } catch (_: Throwable) {}
    }

    private fun hostAllowed(url: String?): Boolean {
        if (url.isNullOrBlank()) return false
        val uri = Uri.parse(url) ?: return false
        if (uri.scheme?.equals("https", true) != true) return false
        val host = uri.host?.lowercase() ?: return false
        if (ALLOWED_HOSTS.any { host == it || host.endsWith(".$it") }) return true
        return extraHost.isNotEmpty() && (host == extraHost || host.endsWith(".$extraHost"))
    }

    private fun dp(v: Int): Int = (v * activity!!.resources.displayMetrics.density).toInt()

    internal fun log(message: String) {
        Log.i(TAG, message)
    }

    /** Attach the JS bridge to the main, trusted webview. Called once. */
    @JvmStatic
    fun attach(mainActivity: AppCompatActivity, mainWebView: WebView) {
        activity = mainActivity
        this.mainWebView = mainWebView
        clearLegacyDockPrefs()
        // Ensure main webview is always full screen
        restoreMainSpace()

        mainWebView.addJavascriptInterface(Bridge(), INTERFACE_NAME)
        log("bridge attached (floating overlay ready)")

        val callback = object : androidx.activity.OnBackPressedCallback(false) {
            override fun handleOnBackPressed() { close() }
        }
        mainActivity.onBackPressedDispatcher.addCallback(mainActivity, callback)
        onBackPressedCallback = callback
    }

    /** Forces the main webview layout back to full match_parent. */
    fun restoreMainSpace() {
        val mw = mainWebView ?: return
        val act = activity ?: return
        act.runOnUiThread {
            try {
                mw.layoutParams = FrameLayout.LayoutParams(
                    FrameLayout.LayoutParams.MATCH_PARENT,
                    FrameLayout.LayoutParams.MATCH_PARENT
                )
                mw.requestLayout()
            } catch (_: Throwable) {}
        }
    }

    /** Lazily build the floating overlay so it sits above the main webview. */
    @SuppressLint("SetJavaScriptEnabled", "AddJavascriptInterface")
    private fun ensureContainer(): FrameLayout {
        container?.let { return it }
        val act = activity ?: throw IllegalStateException("AiOverlay not attached")

        val root = FrameLayout(act)
        root.setBackgroundColor(Color.TRANSPARENT)

        val p = FrameLayout(act)
        val shape = GradientDrawable().apply {
            cornerRadius = 14f * act.resources.displayMetrics.density
            setColor(Color.parseColor("#FF181614"))
            setStroke((1.5f * act.resources.displayMetrics.density).toInt(), Color.parseColor("#FF38342E"))
        }
        p.background = shape
        p.elevation = 24f * act.resources.displayMetrics.density

        val layout = LinearLayout(act)
        layout.orientation = LinearLayout.VERTICAL

        // ── Title bar: drag to move, ⤡ resize, ✕ close ──
        val bar = LinearLayout(act)
        bar.orientation = LinearLayout.HORIZONTAL
        bar.setBackgroundColor(Color.parseColor("#FF24201C"))
        bar.gravity = Gravity.CENTER_VERTICAL
        bar.setPadding(dp(12), dp(8), dp(4), dp(8))

        val tv = TextView(act)
        tv.text = "CopasTool AI Companion"
        tv.setTextColor(Color.parseColor("#FFF2EFEA"))
        tv.textSize = 14f
        tv.setSingleLine(true)
        tv.gravity = Gravity.CENTER_VERTICAL
        titleView = tv

        val sizeHandle = TextView(act)
        sizeHandle.text = "⤡"
        sizeHandle.setTextColor(Color.parseColor("#FF9E9A93"))
        sizeHandle.textSize = 16f
        sizeHandle.setPadding(dp(16), dp(4), dp(8), dp(4))
        sizeHandle.contentDescription = "Ubah ukuran"
        sizeHandle.setOnTouchListener(makeResizeListener())

        // Minimizes the panel but keeps the AI page + session alive, so Full
        // Auto keeps polling it in background (see show()/close()).
        val minimize = TextView(act)
        minimize.text = "−"
        minimize.setTextColor(Color.parseColor("#FFF2EFEA"))
        minimize.textSize = 18f
        minimize.setPadding(dp(16), dp(4), dp(8), dp(4))
        minimize.contentDescription = "Sembunyikan (tetap berjalan di latar)"
        minimize.setOnClickListener { minimize() }

        val close = TextView(act)
        close.text = "✕"
        close.setTextColor(Color.parseColor("#FFFF8A80"))
        close.textSize = 18f
        close.setPadding(dp(18), dp(4), dp(14), dp(4))
        close.contentDescription = "Tutup AI Companion"
        close.setOnClickListener { close() }

        val spacer = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
        bar.addView(tv, spacer)
        bar.addView(minimize)
        bar.addView(sizeHandle)
        bar.addView(close)

        val wv = WebView(act)
        wv.settings.javaScriptEnabled = true
        wv.settings.domStorageEnabled = true
        wv.settings.databaseEnabled = true
        wv.settings.mediaPlaybackRequiresUserGesture = false
        wv.settings.cacheMode = WebSettings.LOAD_DEFAULT
        // Drop the "; wv" WebView marker — several AI sites refuse plain WebView UAs.
        try {
            wv.settings.userAgentString = WebSettings.getDefaultUserAgent(act).replace("; wv", "")
        } catch (_: Throwable) {}
        wv.webViewClient = WebViewClient()
        wv.webChromeClient = object : WebChromeClient() {
            override fun onConsoleMessage(cm: ConsoleMessage): Boolean {
                log("[page] ${cm.message()} (${cm.sourceId()}:${cm.lineNumber()})")
                return true
            }
        }
        webView = wv

        layout.addView(bar, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(44), 0f))
        layout.addView(wv, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f))

        p.layoutParams = FrameLayout.LayoutParams(
            (act.resources.displayMetrics.widthPixels * 92) / 100,
            (act.resources.displayMetrics.heightPixels * 70) / 100,
            Gravity.CENTER
        )
        p.addOnLayoutChangeListener { v, _, _, _, _, _, _, _, _ ->
            clampTranslation(v)
        }
        p.addView(layout, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
        bar.setOnTouchListener(makeDragListener())

        root.addView(p)
        act.addContentView(root, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))

        container = root
        panel = p
        return root
    }

    private fun clampTranslation(v: View) {
        val parent = v.parent as? View ?: return
        val maxTx = ((parent.width - v.width) / 2f).coerceAtLeast(0f)
        val maxTy = ((parent.height - v.height) / 2f).coerceAtLeast(0f)
        v.translationX = v.translationX.coerceIn(-maxTx, maxTx)
        v.translationY = v.translationY.coerceIn(-maxTy, maxTy)
    }

    private fun applyFloatLayout() {
        val target = panel ?: return
        val act = activity ?: return
        target.layoutParams = FrameLayout.LayoutParams(
            (act.resources.displayMetrics.widthPixels * 92) / 100,
            (act.resources.displayMetrics.heightPixels * 70) / 100,
            Gravity.CENTER
        )
        target.translationX = 0f
        target.translationY = 0f
    }

    private fun makeDragListener(): View.OnTouchListener {
        var startX = 0f; var startY = 0f; var baseTx = 0f; var baseTy = 0f
        return View.OnTouchListener { v, event ->
            when (event.actionMasked) {
                android.view.MotionEvent.ACTION_DOWN -> {
                    startX = event.rawX; startY = event.rawY
                    baseTx = v.translationX; baseTy = v.translationY
                    true
                }
                android.view.MotionEvent.ACTION_MOVE -> {
                    val target = panel ?: return@OnTouchListener false
                    target.translationX = baseTx + (event.rawX - startX)
                    target.translationY = baseTy + (event.rawY - startY)
                    clampTranslation(target)
                    true
                }
                else -> false
            }
        }
    }

    private fun makeResizeListener(): View.OnTouchListener {
        var startX = 0f; var startY = 0f
        var startW = 0; var startH = 0
        return View.OnTouchListener { _, event ->
            when (event.actionMasked) {
                android.view.MotionEvent.ACTION_DOWN -> {
                    startX = event.rawX; startY = event.rawY
                    val target = panel ?: return@OnTouchListener false
                    startW = target.width; startH = target.height
                    true
                }
                android.view.MotionEvent.ACTION_MOVE -> {
                    val target = panel ?: return@OnTouchListener false
                    val lp = target.layoutParams as FrameLayout.LayoutParams
                    val maxW = ((container?.width ?: Int.MAX_VALUE) - dp(16)).coerceAtLeast(dp(280))
                    val maxH = ((container?.height ?: Int.MAX_VALUE) - dp(16)).coerceAtLeast(dp(280))
                    lp.width = (startW + (event.rawX - startX)).toInt().coerceIn(dp(280), maxW)
                    lp.height = (startH + (event.rawY - startY)).toInt().coerceIn(dp(280), maxH)
                    target.layoutParams = lp
                    clampTranslation(target)
                    true
                }
                else -> false
            }
        }
    }

    private fun setBackEnabled(enabled: Boolean) {
        onBackPressedCallback?.isEnabled = enabled
    }

    fun isOpen(): Boolean = webView != null && container?.visibility == View.VISIBLE

    @JvmStatic
    fun isDockedState(): Boolean = false

    private fun panelWidthPx(): Int = panel?.width ?: 0
    private fun panelHeightPx(): Int = panel?.height ?: 0

    private fun notifyDockState() {
        val main = mainWebView ?: return
        val payload = JSONObject()
            .put("docked", false)
            .put("side", "none")
            .put("ratio", 0.0)
            .put("panePx", panelWidthPx())
            .put("paneHeightPx", panelHeightPx())
            .put("screenPx", container?.width ?: 0)
            .put("screenHeightPx", container?.height ?: 0)
            .toString()
        main.post {
            try {
                main.evaluateJavascript("window.__cstlAiDock && window.__cstlAiDock($payload);", null)
            } catch (t: Throwable) {
                log("notifyDockState failed: ${t.message}")
            }
        }
    }

    fun open(rawUrl: String): String {
        if (!hostAllowed(rawUrl)) {
            log("open refused (host not allowed): $rawUrl")
            return "__CSTL_HOST_DENIED__"
        }
        val act = activity ?: return "__CSTL_NOT_ATTACHED__"
        act.runOnUiThread {
            try {
                ensureContainer()
                lastUrl = rawUrl
                container?.visibility = View.VISIBLE
                applyFloatLayout()
                titleView?.text = "CopasTool AI Companion"
                webView?.loadUrl(rawUrl)
                webView?.requestFocus()
                hideKeyboard()
                setBackEnabled(true)
                restoreMainSpace()
                notifyDockState()
                log("open $rawUrl (floating)")
            } catch (t: Throwable) {
                container?.visibility = View.GONE
                setBackEnabled(false)
                restoreMainSpace()
                log("open failed: ${t.message}")
            }
        }
        return "ok"
    }

    fun float() {
        val act = activity ?: return
        act.runOnUiThread {
            restoreMainSpace()
            applyFloatLayout()
            notifyDockState()
        }
    }

    /** Dismisses the soft keyboard without touching the focused field. */
    private fun hideKeyboard() {
        val act = activity ?: return
        try {
            val imm = act.getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager
            imm?.hideSoftInputFromWindow(webView?.windowToken, 0)
        } catch (_: Throwable) {}
    }

    @JvmStatic
    fun prepareInput(): String {
        val act = activity ?: return "__CSTL_NOT_ATTACHED__"
        if (webView == null) return "__CSTL_NOT_OPEN__"
        act.runOnUiThread {
            try {
                webView?.requestFocus()
                hideKeyboard()
            } catch (_: Throwable) {}
        }
        return "ok"
    }

    fun close() {
        // Closing mid-run would kill the AI session — just hide the panel so
        // Full Auto keeps polling the live page in background instead.
        if (backgroundWork && webView != null) {
            minimize()
            return
        }
        val act = activity ?: return
        act.runOnUiThread {
            webView?.loadUrl("about:blank")
            webView?.stopLoading()
            container?.visibility = View.GONE
            restoreMainSpace()
            setBackEnabled(false)
            notifyDockState()
        }
    }

    /**
     * Hides the panel but keeps the overlay WebView + AI session alive.
     * A hidden WebView stops rendering yet its JS/network/DOM keeps running,
     * so the frontend's evalAsync grab polling keeps receiving answers.
     */
    fun minimize() {
        val act = activity ?: return
        act.runOnUiThread {
            try {
                container?.visibility = View.GONE
                setBackEnabled(false)
                hideKeyboard()
                log("minimized (AI page kept alive in background)")
            } catch (_: Throwable) {}
        }
    }

    /**
     * Reveals a minimized panel WITHOUT reloading the AI page, preserving the
     * conversation. Returns __CSTL_NOT_OPEN__ when nothing was ever opened.
     */
    @JvmStatic
    fun show(): String {
        val act = activity ?: return "__CSTL_NOT_ATTACHED__"
        if (webView == null || lastUrl.isEmpty()) return "__CSTL_NOT_OPEN__"
        act.runOnUiThread {
            try {
                ensureContainer()
                container?.visibility = View.VISIBLE
                applyFloatLayout()
                titleView?.text = "CopasTool AI Companion"
                webView?.requestFocus()
                hideKeyboard()
                setBackEnabled(true)
                restoreMainSpace()
                notifyDockState()
                log("shown without reload")
            } catch (t: Throwable) {
                log("show failed: ${t.message}")
            }
        }
        return "ok"
    }

    // ── Background Full Auto support ──────────────────────────────────────

    @JvmStatic
    fun setBackgroundWork(active: Boolean): String {
        backgroundWork = active
        val act = activity
        if (act != null) {
            act.runOnUiThread {
                try {
                    val win = act.window
                    if (active) win?.addFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                    else win?.clearFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                } catch (_: Throwable) {}
            }
        }
        // Apply immediately in case the activity is currently paused.
        if (active) resumeMainWebView()
        return "ok"
    }

    /** Re-enables the main WebView's timers/JS after WryActivity.onPause froze them. */
    @JvmStatic
    fun resumeMainWebView(): String {
        val mw = mainWebView ?: return "__CSTL_NOT_ATTACHED__"
        try {
            mw.post {
                try {
                    mw.onResume()
                    mw.resumeTimers()
                } catch (_: Throwable) {}
            }
        } catch (_: Throwable) {}
        return "ok"
    }

    /** Called from MainActivity.onPause (injected by patch-android-overlay.mjs). */
    @JvmStatic
    fun onActivityPaused() {
        if (!backgroundWork) return
        log("activity paused during background work — keeping WebView alive")
        resumeMainWebView()
    }

    /** Called from MainActivity.onResume (injected by patch-android-overlay.mjs). */
    @JvmStatic
    fun onActivityResumed() {
        try {
            mainWebView?.post {
                try {
                    mainWebView?.onResume()
                    mainWebView?.resumeTimers()
                } catch (_: Throwable) {}
            }
        } catch (_: Throwable) {}
    }

    private fun deliver(callId: Int, raw: String) {
        val main = mainWebView ?: return
        val payload = try { JSONObject.quote(raw) } catch (_: Throwable) { "\"__CSTL_ERROR__ quote\"" }
        main.post {
            try {
                main.evaluateJavascript(
                    "window.__cstlAiEvalDone && window.__cstlAiEvalDone($callId, $payload);",
                    null
                )
            } catch (t: Throwable) {
                log("deliver($callId) failed: ${t.message}")
            }
        }
    }

    @JvmStatic
    fun evalAsync(script: String, callId: Int) {
        val act = activity
        if (act == null) {
            deliver(callId, "__CSTL_NOT_ATTACHED__")
            return
        }
        // Gate on the page being alive, not visible — a minimized (background)
        // panel keeps answering evals so Full Auto survives a closed window.
        if (webView == null) {
            deliver(callId, "__CSTL_NOT_OPEN__")
            return
        }
        act.runOnUiThread {
            val wv = webView
            if (wv == null) {
                deliver(callId, "__CSTL_NOT_OPEN__")
                return@runOnUiThread
            }
            val current = try { wv.url } catch (_: Throwable) { null }
            val url = if (current.isNullOrBlank()) lastUrl else current
            if (!hostAllowed(url)) {
                log("eval refused (host not allowed): $url")
                deliver(callId, "__CSTL_HOST_DENIED__")
                return@runOnUiThread
            }
            try {
                wv.evaluateJavascript(script) { result -> deliver(callId, result ?: "null") }
            } catch (t: Throwable) {
                deliver(callId, "__CSTL_ERROR__ " + (t.message ?: "eval failed"))
            }
        }
    }

    @JvmStatic
    fun eval(script: String): String {
        val act = activity ?: return "__CSTL_NOT_ATTACHED__"
        // Same as evalAsync: a minimized panel still answers.
        if (webView == null) return "__CSTL_NOT_OPEN__"

        val latch = CountDownLatch(1)
        val out = arrayOf("__CSTL_TIMEOUT__")
        act.runOnUiThread {
            val wv = webView
            if (wv == null) {
                out[0] = "__CSTL_NOT_OPEN__"
                latch.countDown()
                return@runOnUiThread
            }
            val current = try { wv.url } catch (_: Throwable) { null }
            val url = if (current.isNullOrBlank()) lastUrl else current
            if (!hostAllowed(url)) {
                log("eval refused (host not allowed): $url")
                out[0] = "__CSTL_HOST_DENIED__"
                latch.countDown()
                return@runOnUiThread
            }
            try {
                wv.evaluateJavascript(script) { result ->
                    out[0] = result ?: "null"
                    latch.countDown()
                }
            } catch (t: Throwable) {
                out[0] = "__CSTL_ERROR__ " + t.message
                latch.countDown()
            }
        }
        if (!latch.await(8, TimeUnit.SECONDS)) {
            log("eval timed out")
            return "__CSTL_TIMEOUT__"
        }
        return out[0]
    }

    class Bridge {
        @JavascriptInterface fun open(url: String): String = try { AiOverlay.open(url) } catch (t: Throwable) { "__CSTL_ERROR__" }
        @JavascriptInterface fun eval(script: String): String = try { AiOverlay.eval(script) } catch (t: Throwable) { "__CSTL_ERROR__" }
        @JavascriptInterface fun evalAsync(script: String, callId: Int) {
            try { AiOverlay.evalAsync(script, callId) } catch (t: Throwable) { AiOverlay.deliverPublic(callId, "__CSTL_ERROR__") }
        }
        @JavascriptInterface fun close(): String = try { AiOverlay.close(); "ok" } catch (t: Throwable) { "__CSTL_ERROR__" }
        @JavascriptInterface fun minimize(): String = try { AiOverlay.minimize(); "ok" } catch (t: Throwable) { "__CSTL_ERROR__" }
        @JavascriptInterface fun show(): String = try { AiOverlay.show() } catch (t: Throwable) { "__CSTL_ERROR__" }
        @JavascriptInterface fun isOpen(): Boolean = try { AiOverlay.isOpen() } catch (t: Throwable) { false }
        @JavascriptInterface fun prepareInput(): String = try { AiOverlay.prepareInput() } catch (t: Throwable) { "__CSTL_ERROR__" }
        @JavascriptInterface fun setBackgroundWork(active: Boolean): String = try { AiOverlay.setBackgroundWork(active) } catch (t: Throwable) { "__CSTL_ERROR__" }
        @JavascriptInterface fun resumeMainWebView(): String = try { AiOverlay.resumeMainWebView() } catch (t: Throwable) { "__CSTL_ERROR__" }
        // Dock & Flip are now safe no-ops on Android (docking removed)
        @JavascriptInterface fun dock(side: String): String = "ok"
        @JavascriptInterface fun float(): String = try { AiOverlay.float(); "ok" } catch (t: Throwable) { "__CSTL_ERROR__" }
        @JavascriptInterface fun flip(): String = "ok"
        @JavascriptInterface fun setExtraHost(host: String): String = try { AiOverlay.setExtraHost(host) } catch (t: Throwable) { "__CSTL_ERROR__" }

        @JavascriptInterface fun nativeState(): String = try {
            AiOverlay.nativeState()
        } catch (t: Throwable) {
            "{\"error\":\"" + (t.message ?: "unknown") + "\"}"
        }

        @JavascriptInterface fun isDocked(): Boolean = false

        @JavascriptInterface fun saveFileToDownloads(filename: String, base64Data: String): String =
            try { AiOverlay.saveFileToDownloads(filename, base64Data) } catch (t: Throwable) { "__CSTL_ERROR__ " + (t.message ?: "error") }

        @JavascriptInterface fun shareFile(filename: String, base64Data: String, mimeType: String): String =
            try { AiOverlay.shareFile(filename, base64Data, mimeType) } catch (t: Throwable) { "__CSTL_ERROR__ " + (t.message ?: "error") }

        @JavascriptInterface fun log(message: String): String {
            AiOverlay.log("[app] $message")
            return "ok"
        }
    }

    @JvmStatic
    fun saveFileToDownloads(filename: String, base64Data: String): String {
        val act = activity ?: return "__CSTL_ERROR__ Activity not attached"
        return try {
            val bytes = Base64.decode(base64Data, Base64.DEFAULT)
            val mimeType = when {
                filename.endsWith(".zip", true) -> "application/zip"
                filename.endsWith(".epub", true) -> "application/epub+zip"
                filename.endsWith(".json", true) -> "application/json"
                filename.endsWith(".txt", true) -> "text/plain"
                filename.endsWith(".cstl", true) || filename.endsWith(".copas", true) -> "application/json"
                else -> "application/octet-stream"
            }

            var saved = false
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                val values = ContentValues().apply {
                    put(MediaStore.MediaColumns.DISPLAY_NAME, filename)
                    put(MediaStore.MediaColumns.MIME_TYPE, mimeType)
                    put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS)
                }
                val resolver = act.contentResolver
                val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
                if (uri != null) {
                    resolver.openOutputStream(uri)?.use { stream ->
                        stream.write(bytes)
                        stream.flush()
                    }
                    saved = true
                }
            } else {
                val dir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS)
                if (!dir.exists()) dir.mkdirs()
                val file = File(dir, filename)
                file.writeBytes(bytes)
                android.media.MediaScannerConnection.scanFile(act, arrayOf(file.absolutePath), arrayOf(mimeType), null)
                saved = true
            }

            if (saved) {
                act.runOnUiThread {
                    Toast.makeText(act, "Disimpan di folder Download: $filename", Toast.LENGTH_LONG).show()
                }
                "ok"
            } else {
                "__CSTL_ERROR__ Failed to insert file into MediaStore"
            }
        } catch (t: Throwable) {
            Log.e(TAG, "saveFileToDownloads error", t)
            "__CSTL_ERROR__ " + (t.message ?: "Unknown error")
        }
    }

    @JvmStatic
    fun shareFile(filename: String, base64Data: String, mimeTypeInput: String): String {
        val act = activity ?: return "__CSTL_ERROR__ Activity not attached"
        return try {
            val bytes = Base64.decode(base64Data, Base64.DEFAULT)
            val mimeType = if (mimeTypeInput.isNotBlank()) mimeTypeInput else "application/octet-stream"
            val cacheFile = File(act.cacheDir, filename)
            cacheFile.writeBytes(bytes)
            val uri = FileProvider.getUriForFile(
                act,
                "${act.packageName}.fileprovider",
                cacheFile
            )
            val intent = Intent(Intent.ACTION_SEND).apply {
                type = mimeType
                putExtra(Intent.EXTRA_STREAM, uri)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
            act.startActivity(Intent.createChooser(intent, "Simpan / Bagikan $filename"))
            "ok"
        } catch (t: Throwable) {
            Log.e(TAG, "shareFile error", t)
            "__CSTL_ERROR__ " + (t.message ?: "Unknown error")
        }
    }

    @JvmStatic
    fun deliverPublic(callId: Int, raw: String) = deliver(callId, raw)

    @JvmStatic
    fun setExtraHost(host: String): String {
        val h = host.trim().lowercase()
        extraHost = if (h.isEmpty() || HOST_RE.matches(h)) h else ""
        log("extra host set: '${if (extraHost.isEmpty()) "(none)" else extraHost}'")
        return "ok"
    }

    private fun <T> uiValue(timeoutMs: Long, fallback: T, block: () -> T): T {
        val act = activity ?: return fallback
        val latch = CountDownLatch(1)
        var value: T = fallback
        act.runOnUiThread {
            try { value = block() } catch (_: Throwable) {}
            latch.countDown()
        }
        latch.await(timeoutMs, TimeUnit.MILLISECONDS)
        return value
    }

    @JvmStatic
    fun nativeState(): String {
        val snapshot = uiValue(2500L, null as JSONObject?) {
            val o = JSONObject()
            o.put("open", isOpen())
            o.put("url", (webView?.url ?: lastUrl) ?: "")
            o.put("panePx", panelWidthPx())
            o.put("paneHeightPx", panelHeightPx())
            o.put("screenPx", container?.width ?: 0)
            o.put("screenHeightPx", container?.height ?: 0)
            o
        } ?: JSONObject()
        snapshot.put("docked", false)
        snapshot.put("side", "none")
        snapshot.put("ratio", 0.0)
        snapshot.put("extraHost", extraHost)
        snapshot.put("allowed", hostAllowed(snapshot.optString("url", "")))
        return snapshot.toString()
    }
}
