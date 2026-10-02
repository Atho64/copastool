package com.copastool.app

import android.app.Activity
import android.content.ClipData
import android.content.ClipboardManager
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.database.Cursor
import android.graphics.Color
import android.graphics.PixelFormat
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.os.Handler
import android.os.Looper
import android.os.VibrationEffect
import android.os.Vibrator
import android.provider.DocumentsContract
import android.provider.MediaStore
import android.provider.Settings
import android.util.Base64
import android.util.Log
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.WebView
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.FileProvider
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import org.json.JSONObject

/**
 * Android native bridge for CopasTool:
 * - Storage Access Framework (SAF) folder picker and file operations
 * - Downloads directory file saver
 * - System file share intent
 * - Background work timer keep-alive
 * - Circular Floating Bubble (Chathead / Overlay) for Semi-Auto Copy-Paste
 */
object AndroidBridge {
    private const val INTERFACE_NAME = "AndroidBridge"
    private const val LEGACY_INTERFACE_NAME = "AndroidAiOverlay"
    private const val TAG = "CSTL-Android"
    private const val FOLDER_PICK_REQUEST = 0x4354
    private val folderIoExecutor: ExecutorService = Executors.newCachedThreadPool()

    private var activity: Activity? = null
    private var mainWebView: WebView? = null
    private var pendingFolderPurpose: String? = null
    @Volatile private var backgroundWork = false

    // Circular Floating Bubble state
    private var windowManager: WindowManager? = null
    private var bubbleView: View? = null
    private var bubbleParams: WindowManager.LayoutParams? = null
    private var badgeTextView: TextView? = null
    private var titleTextView: TextView? = null
    private val mainHandler = Handler(Looper.getMainLooper())
    private var currentBatchBadge = "B1"

    private val safetyFocusRestoreRunnable = Runnable {
        try {
            val bv = bubbleView ?: return@Runnable
            val lp = bubbleParams ?: return@Runnable
            val wm = windowManager ?: return@Runnable
            lp.flags = lp.flags or WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
            wm.updateViewLayout(bv, lp)
            log("safety focus restore executed")
        } catch (_: Throwable) {}
    }

    private val revertVisualRunnable = Runnable {
        updateBubbleState(currentBatchBadge, State.NORMAL)
    }

    private enum class State {
        NORMAL,
        PROCESSING,
        SUCCESS,
        ERROR
    }

    internal fun log(message: String) {
        Log.i(TAG, message)
    }

    private fun dp(dp: Float): Int {
        val density = activity?.resources?.displayMetrics?.density ?: 1f
        return (dp * density + 0.5f).toInt()
    }

    private fun vibrateBrief(millis: Long = 25) {
        try {
            val act = activity ?: return
            val v = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                val vm = act.getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as? android.os.VibratorManager
                vm?.defaultVibrator
            } else {
                @Suppress("DEPRECATION")
                act.getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                v?.vibrate(VibrationEffect.createOneShot(millis, VibrationEffect.DEFAULT_AMPLITUDE))
            } else {
                @Suppress("DEPRECATION")
                v?.vibrate(millis)
            }
        } catch (_: Throwable) {}
    }

    private fun vibrateSuccess() {
        try {
            val act = activity ?: return
            val v = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                val vm = act.getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as? android.os.VibratorManager
                vm?.defaultVibrator
            } else {
                @Suppress("DEPRECATION")
                act.getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                val timings = longArrayOf(0, 30, 50, 40)
                val amplitudes = intArrayOf(0, 180, 0, 255)
                v?.vibrate(VibrationEffect.createWaveform(timings, amplitudes, -1))
            } else {
                @Suppress("DEPRECATION")
                v?.vibrate(longArrayOf(0, 30, 50, 40), -1)
            }
        } catch (_: Throwable) {}
    }

    private fun vibrateError() {
        vibrateBrief(90)
    }

    /** Attach the JS bridge to the main, trusted webview. Called once. */
    @JvmStatic
    fun attach(mainActivity: AppCompatActivity, mainWebView: WebView) {
        activity = mainActivity
        this.mainWebView = mainWebView
        val bridge = Bridge()
        mainWebView.addJavascriptInterface(bridge, INTERFACE_NAME)
        mainWebView.addJavascriptInterface(bridge, LEGACY_INTERFACE_NAME)
        log("bridge attached")
    }

    /** Keeps webview timers alive when backgrounded during Semi-Auto work. */
    @JvmStatic
    fun setBackgroundWork(active: Boolean): String {
        backgroundWork = active
        val act = activity ?: return "no_activity"
        act.runOnUiThread {
            try {
                if (active) {
                    act.window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                } else {
                    act.window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                }
            } catch (t: Throwable) {
                log("setBackgroundWork error: ${t.message}")
            }
        }
        return "ok"
    }

    @JvmStatic
    fun onActivityPaused() {
        if (!backgroundWork) return
        val mw = mainWebView ?: return
        val act = activity ?: return
        act.runOnUiThread {
            try {
                mw.onResume()
                mw.resumeTimers()
                log("main webview timers kept active for background work")
            } catch (t: Throwable) {
                log("onActivityPaused resume failed: ${t.message}")
            }
        }
    }

    @JvmStatic
    fun onActivityResumed() {}

    @JvmStatic
    fun onDestroy() {
        hideFloatingBubble()
    }

    // ==========================================
    // CIRCULAR FLOATING BUBBLE OVERLAY SYSTEM
    // ==========================================

    @JvmStatic
    fun canDrawOverlays(): Boolean {
        val act = activity ?: return false
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            Settings.canDrawOverlays(act)
        } else {
            true
        }
    }

    @JvmStatic
    fun requestOverlayPermission(): String {
        val act = activity ?: return "__CSTL_ERROR__ Activity not attached"
        return try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && !Settings.canDrawOverlays(act)) {
                val intent = Intent(
                    Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                    Uri.parse("package:${act.packageName}")
                ).apply {
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                }
                act.startActivity(intent)
                "permission_requested"
            } else {
                "already_granted"
            }
        } catch (t: Throwable) {
            "__CSTL_ERROR__ ${t.message ?: "Failed to request permission"}"
        }
    }

    @JvmStatic
    fun isFloatingBubbleVisible(): Boolean = bubbleView != null

    @JvmStatic
    fun showFloatingBubble(badgeText: String): String {
        val act = activity ?: return "__CSTL_ERROR__ Activity not attached"
        if (!canDrawOverlays()) return "__CSTL_ERROR__ Overlay permission not granted"

        act.runOnUiThread {
            try {
                if (bubbleView != null) {
                    if (badgeText.isNotBlank()) {
                        currentBatchBadge = badgeText
                        badgeTextView?.text = currentBatchBadge
                    }
                    return@runOnUiThread
                }

                val wm = act.getSystemService(Context.WINDOW_SERVICE) as? WindowManager ?: return@runOnUiThread
                windowManager = wm

                val layoutType = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
                } else {
                    @Suppress("DEPRECATION")
                    WindowManager.LayoutParams.TYPE_PHONE
                }

                val size = dp(56f)
                val params = WindowManager.LayoutParams(
                    size,
                    size,
                    layoutType,
                    WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
                    PixelFormat.TRANSLUCENT
                ).apply {
                    gravity = Gravity.TOP or Gravity.START
                    x = dp(16f)
                    y = dp(160f)
                }
                bubbleParams = params

                val circularBubble = LinearLayout(act).apply {
                    orientation = LinearLayout.VERTICAL
                    gravity = Gravity.CENTER
                    elevation = dp(10f).toFloat()

                    background = GradientDrawable().apply {
                        shape = GradientDrawable.OVAL
                        setColor(Color.parseColor("#241e47")) // CopasTool signature deep theme
                        setStroke(dp(2f), Color.parseColor("#6366f1")) // Indigo border
                    }
                }

                val titleView = TextView(act).apply {
                    text = "COPAS"
                    textSize = 8.5f
                    setTypeface(null, Typeface.BOLD)
                    setTextColor(Color.parseColor("#a5b4fc"))
                    gravity = Gravity.CENTER
                }
                titleTextView = titleView

                currentBatchBadge = if (badgeText.isNotBlank()) badgeText else "B1"
                val badgeView = TextView(act).apply {
                    text = currentBatchBadge
                    textSize = 13f
                    setTypeface(null, Typeface.BOLD)
                    setTextColor(Color.WHITE)
                    gravity = Gravity.CENTER
                }
                badgeTextView = badgeView

                circularBubble.addView(titleView)
                circularBubble.addView(badgeView)

                // Drag and Tap handling
                var initialX = 0
                var initialY = 0
                var initialTouchX = 0f
                var initialTouchY = 0f
                var isDragging = false
                var touchDownTime = 0L
                val touchSlop = dp(8f)

                circularBubble.setOnTouchListener { _, event ->
                    when (event.action) {
                        MotionEvent.ACTION_DOWN -> {
                            initialX = params.x
                            initialY = params.y
                            initialTouchX = event.rawX
                            initialTouchY = event.rawY
                            isDragging = false
                            touchDownTime = System.currentTimeMillis()
                            true
                        }
                        MotionEvent.ACTION_MOVE -> {
                            val dx = (event.rawX - initialTouchX).toInt()
                            val dy = (event.rawY - initialTouchY).toInt()
                            if (!isDragging && (Math.abs(dx) > touchSlop || Math.abs(dy) > touchSlop)) {
                                isDragging = true
                            }
                            if (isDragging) {
                                params.x = initialX + dx
                                params.y = initialY + dy
                                try {
                                    wm.updateViewLayout(circularBubble, params)
                                } catch (_: Throwable) {}
                            }
                            true
                        }
                        MotionEvent.ACTION_UP -> {
                            if (!isDragging) {
                                val duration = System.currentTimeMillis() - touchDownTime
                                if (duration > 650) {
                                    // Long press: re-copy current batch prompt
                                    vibrateBrief(40)
                                    updateBubbleState(currentBatchBadge, State.PROCESSING)
                                    triggerBubbleRecopy()
                                } else {
                                    // Single tap: process AI clipboard and copy next batch
                                    handleBubbleTap()
                                }
                            }
                            true
                        }
                        else -> false
                    }
                }

                wm.addView(circularBubble, params)
                bubbleView = circularBubble
                log("circular floating bubble shown")
            } catch (t: Throwable) {
                log("showFloatingBubble error: ${t.message}")
            }
        }
        return "ok"
    }

    @JvmStatic
    fun hideFloatingBubble(): String {
        val act = activity ?: return "no_activity"
        act.runOnUiThread {
            try {
                mainHandler.removeCallbacksAndMessages(null)
                val bv = bubbleView
                if (bv != null) {
                    windowManager?.removeView(bv)
                    bubbleView = null
                    bubbleParams = null
                    badgeTextView = null
                    titleTextView = null
                    log("circular floating bubble hidden")
                    mainWebView?.post {
                        try {
                            mainWebView?.evaluateJavascript("window.__cstlOnBubbleClosed && window.__cstlOnBubbleClosed();", null)
                        } catch (_: Throwable) {}
                    }
                }
            } catch (t: Throwable) {
                log("hideFloatingBubble error: ${t.message}")
            }
        }
        return "ok"
    }

    private fun updateBubbleState(badge: String, state: State) {
        val act = activity ?: return
        val bv = bubbleView ?: return
        act.runOnUiThread {
            try {
                badgeTextView?.text = badge
                val bg = GradientDrawable().apply {
                    shape = GradientDrawable.OVAL
                    when (state) {
                        State.SUCCESS -> {
                            setColor(Color.parseColor("#132e27")) // deep emerald
                            setStroke(dp(2.5f), Color.parseColor("#10b981")) // emerald green ring
                        }
                        State.ERROR -> {
                            setColor(Color.parseColor("#371313")) // deep red
                            setStroke(dp(2.5f), Color.parseColor("#ef4444")) // red ring
                        }
                        State.PROCESSING -> {
                            setColor(Color.parseColor("#1e1b4b"))
                            setStroke(dp(2.5f), Color.parseColor("#818cf8")) // bright indigo ring
                        }
                        State.NORMAL -> {
                            setColor(Color.parseColor("#241e47"))
                            setStroke(dp(2f), Color.parseColor("#6366f1")) // indigo ring
                        }
                    }
                }
                bv.background = bg

                if (state == State.SUCCESS || state == State.ERROR) {
                    mainHandler.removeCallbacks(revertVisualRunnable)
                    mainHandler.postDelayed(revertVisualRunnable, 2000)
                }
            } catch (_: Throwable) {}
        }
    }

    private fun handleBubbleTap() {
        val act = activity ?: return
        val wm = windowManager ?: return
        val bv = bubbleView ?: return
        val lp = bubbleParams ?: return

        vibrateBrief(25)
        updateBubbleState(currentBatchBadge, State.PROCESSING)

        // 1. Temporarily remove FLAG_NOT_FOCUSABLE to gain window focus without opening any Activity
        try {
            lp.flags = lp.flags and WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE.inv()
            wm.updateViewLayout(bv, lp)
            bv.isFocusable = true
            bv.isFocusableInTouchMode = true
            bv.requestFocus()
        } catch (t: Throwable) {
            log("grab focus error: ${t.message}")
        }

        // 2. Wait 80ms for focus to settle, then read clipboard
        mainHandler.removeCallbacks(safetyFocusRestoreRunnable)
        mainHandler.postDelayed({
            val cm = act.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager
            val clipText = try {
                val clip = cm?.primaryClip
                if (clip != null && clip.itemCount > 0) clip.getItemAt(0)?.text?.toString() ?: "" else ""
            } catch (t: Throwable) {
                log("read clipboard error: ${t.message}")
                ""
            }

            onClipboardCaptured(clipText)
        }, 80)

        // Safety timeout: restore FLAG_NOT_FOCUSABLE if no response in 800ms
        mainHandler.postDelayed(safetyFocusRestoreRunnable, 800)
    }

    @JvmStatic
    fun onClipboardCaptured(text: String) {
        val mw = mainWebView
        if (mw != null) {
            val quoted = JSONObject.quote(text)
            mw.post {
                try {
                    mw.evaluateJavascript(
                        "window.__cstlOnBubbleTriggered && window.__cstlOnBubbleTriggered($quoted);",
                        null
                    )
                } catch (t: Throwable) {
                    log("evaluateJavascript error: ${t.message}")
                    cancelOverlayFocus(currentBatchBadge)
                }
            }
        } else {
            cancelOverlayFocus(currentBatchBadge)
        }
    }

    private fun triggerBubbleRecopy() {
        val mw = mainWebView ?: return
        mw.post {
            try {
                mw.evaluateJavascript("window.__cstlOnBubbleRecopy && window.__cstlOnBubbleRecopy();", null)
            } catch (_: Throwable) {}
        }
    }

    @JvmStatic
    fun writeClipboardAndRestoreOverlay(nextPrompt: String, newBadgeText: String): String {
        val act = activity ?: return "no_activity"
        val wm = windowManager ?: return "no_wm"
        val bv = bubbleView ?: return "no_bubble"
        val lp = bubbleParams ?: return "no_params"

        mainHandler.removeCallbacks(safetyFocusRestoreRunnable)
        act.runOnUiThread {
            try {
                if (nextPrompt.isNotEmpty()) {
                    val cm = act.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager
                    cm?.setPrimaryClip(ClipData.newPlainText("CopasTool", nextPrompt))
                }
                vibrateSuccess()
                currentBatchBadge = if (newBadgeText.isNotBlank()) newBadgeText else currentBatchBadge
                updateBubbleState(currentBatchBadge, State.SUCCESS)
            } catch (t: Throwable) {
                log("write clipboard error: ${t.message}")
            } finally {
                try {
                    lp.flags = lp.flags or WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                    wm.updateViewLayout(bv, lp)
                } catch (t: Throwable) {
                    log("restore flags error: ${t.message}")
                }
            }
        }
        return "ok"
    }

    @JvmStatic
    fun cancelOverlayFocus(fallbackBadge: String): String {
        val act = activity ?: return "no_activity"
        val wm = windowManager ?: return "no_wm"
        val bv = bubbleView ?: return "no_bubble"
        val lp = bubbleParams ?: return "no_params"

        mainHandler.removeCallbacks(safetyFocusRestoreRunnable)
        act.runOnUiThread {
            vibrateError()
            currentBatchBadge = if (fallbackBadge.isNotBlank()) fallbackBadge else currentBatchBadge
            updateBubbleState(currentBatchBadge, State.ERROR)
            try {
                lp.flags = lp.flags or WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                wm.updateViewLayout(bv, lp)
            } catch (t: Throwable) {
                log("restore flags error: ${t.message}")
            }
        }
        return "ok"
    }

    @JvmStatic
    fun bringAppToFront(): String {
        val act = activity ?: return "no_activity"
        act.runOnUiThread {
            try {
                val intent = Intent(act, MainActivity::class.java).apply {
                    flags = Intent.FLAG_ACTIVITY_REORDER_TO_FRONT or Intent.FLAG_ACTIVITY_SINGLE_TOP
                }
                act.startActivity(intent)
            } catch (t: Throwable) {
                log("bringAppToFront error: ${t.message}")
            }
        }
        return "ok"
    }

    class Bridge {
        @JavascriptInterface fun resumeMainWebView(): String = "ok"
        @JavascriptInterface fun setBackgroundWork(active: Boolean): String = try { AndroidBridge.setBackgroundWork(active) } catch (t: Throwable) { "__CSTL_ERROR__ " + (t.message ?: "error") }

        @JavascriptInterface fun canDrawOverlays(): Boolean = try { AndroidBridge.canDrawOverlays() } catch (_: Throwable) { false }
        @JavascriptInterface fun requestOverlayPermission(): String = try { AndroidBridge.requestOverlayPermission() } catch (t: Throwable) { "__CSTL_ERROR__ " + (t.message ?: "error") }
        @JavascriptInterface fun showFloatingBubble(badgeText: String): String = try { AndroidBridge.showFloatingBubble(badgeText) } catch (t: Throwable) { "__CSTL_ERROR__ " + (t.message ?: "error") }
        @JavascriptInterface fun hideFloatingBubble(): String = try { AndroidBridge.hideFloatingBubble() } catch (t: Throwable) { "__CSTL_ERROR__ " + (t.message ?: "error") }
        @JavascriptInterface fun isFloatingBubbleVisible(): Boolean = try { AndroidBridge.isFloatingBubbleVisible() } catch (_: Throwable) { false }
        @JavascriptInterface fun writeClipboardAndRestoreOverlay(nextPrompt: String, newBadgeText: String): String =
            try { AndroidBridge.writeClipboardAndRestoreOverlay(nextPrompt, newBadgeText) } catch (t: Throwable) { "__CSTL_ERROR__ " + (t.message ?: "error") }
        @JavascriptInterface fun cancelOverlayFocus(fallbackBadge: String): String =
            try { AndroidBridge.cancelOverlayFocus(fallbackBadge) } catch (t: Throwable) { "__CSTL_ERROR__ " + (t.message ?: "error") }
        @JavascriptInterface fun bringAppToFront(): String =
            try { AndroidBridge.bringAppToFront() } catch (t: Throwable) { "__CSTL_ERROR__ " + (t.message ?: "error") }

        @JavascriptInterface fun pickFolder(purpose: String): String = try { AndroidBridge.pickFolder(purpose) } catch (t: Throwable) { "__CSTL_ERROR__ " + (t.message ?: "error") }
        @JavascriptInterface fun listTreeFiles(treeUri: String): String = try { AndroidBridge.listTreeFiles(treeUri) } catch (t: Throwable) { "__CSTL_ERROR__ " + (t.message ?: "error") }
        @JavascriptInterface fun readTreeFile(treeUri: String, documentId: String): String = try { AndroidBridge.readTreeFile(treeUri, documentId) } catch (t: Throwable) { "__CSTL_ERROR__ " + (t.message ?: "error") }
        @JavascriptInterface fun writeTreeFile(treeUri: String, name: String, base64Data: String): String = try { AndroidBridge.writeTreeFile(treeUri, name, base64Data) } catch (t: Throwable) { "__CSTL_ERROR__ " + (t.message ?: "error") }
        @JavascriptInterface fun listTreeFilesAsync(treeUri: String, callId: Int): String = try { AndroidBridge.listTreeFilesAsync(treeUri, callId) } catch (t: Throwable) { "__CSTL_ERROR__ " + (t.message ?: "error") }
        @JavascriptInterface fun readTreeFileAsync(treeUri: String, documentId: String, callId: Int): String = try { AndroidBridge.readTreeFileAsync(treeUri, documentId, callId) } catch (t: Throwable) { "__CSTL_ERROR__ " + (t.message ?: "error") }
        @JavascriptInterface fun writeTreeFileAsync(treeUri: String, name: String, base64Data: String, callId: Int): String = try { AndroidBridge.writeTreeFileAsync(treeUri, name, base64Data, callId) } catch (t: Throwable) { "__CSTL_ERROR__ " + (t.message ?: "error") }

        @JavascriptInterface fun saveFileToDownloads(filename: String, base64Data: String): String =
            try { AndroidBridge.saveFileToDownloads(filename, base64Data) } catch (t: Throwable) { "__CSTL_ERROR__ " + (t.message ?: "error") }

        @JavascriptInterface fun shareFile(filename: String, base64Data: String, mimeType: String): String =
            try { AndroidBridge.shareFile(filename, base64Data, mimeType) } catch (t: Throwable) { "__CSTL_ERROR__ " + (t.message ?: "error") }

        @JavascriptInterface fun log(message: String): String {
            AndroidBridge.log("[app] $message")
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
    fun pickFolder(purpose: String): String {
        if (purpose !in setOf("import", "backup", "restore", "game")) return "__CSTL_ERROR__ Invalid folder action"
        val act = activity ?: return "__CSTL_ERROR__ Activity not attached"
        act.runOnUiThread {
            try {
                pendingFolderPurpose = purpose
                val intent = Intent(Intent.ACTION_OPEN_DOCUMENT_TREE).apply {
                    addFlags(
                        Intent.FLAG_GRANT_READ_URI_PERMISSION or
                            Intent.FLAG_GRANT_WRITE_URI_PERMISSION or
                            Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION
                    )
                }
                act.startActivityForResult(intent, FOLDER_PICK_REQUEST)
            } catch (t: Throwable) {
                pendingFolderPurpose = null
                deliverFolderPick(null, purpose)
                log("folder picker failed: ${t.message}")
            }
        }
        return "ok"
    }

    @JvmStatic
    fun onFolderPickerResult(requestCode: Int, resultCode: Int, data: Intent?): Boolean {
        if (requestCode != FOLDER_PICK_REQUEST) return false
        val purpose = pendingFolderPurpose ?: ""
        pendingFolderPurpose = null
        val uri = if (resultCode == Activity.RESULT_OK) data?.data else null
        if (uri != null) {
            try {
                val flags = data?.flags?.and(
                    Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION
                ) ?: (Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
                activity?.contentResolver?.takePersistableUriPermission(uri, flags)
            } catch (t: Throwable) {
                log("persist folder permission failed: ${t.message}")
            }
        }
        deliverFolderPick(uri?.toString(), purpose)
        return true
    }

    private fun deliverFolderPick(uri: String?, purpose: String) {
        val main = mainWebView ?: return
        val uriArg = JSONObject.quote(uri ?: "")
        val purposeArg = JSONObject.quote(purpose)
        main.post {
            try {
                main.evaluateJavascript(
                    "window.__cstlAndroidDirectoryPicked && window.__cstlAndroidDirectoryPicked($uriArg, $purposeArg);",
                    null
                )
            } catch (t: Throwable) {
                log("deliver folder picker result failed: ${t.message}")
            }
        }
    }

    private fun deliverFolderIo(callId: Int, result: String) {
        val main = mainWebView ?: return
        val resultArg = JSONObject.quote(result)
        main.post {
            try {
                main.evaluateJavascript(
                    "window.__cstlAndroidFileOperationFinished && window.__cstlAndroidFileOperationFinished($callId, $resultArg);",
                    null
                )
            } catch (t: Throwable) {
                log("deliver folder I/O result failed: ${t.message}")
            }
        }
    }

    private fun runFolderIoAsync(callId: Int, operation: () -> String): String {
        return try {
            folderIoExecutor.execute {
                val result = try { operation() } catch (t: Throwable) {
                    "__CSTL_ERROR__ ${t.message ?: "Android folder operation failed"}"
                }
                deliverFolderIo(callId, result)
            }
            "ok"
        } catch (t: Throwable) {
            "__CSTL_ERROR__ ${t.message ?: "Could not start Android folder operation"}"
        }
    }

    @JvmStatic
    fun listTreeFilesAsync(rawTreeUri: String, callId: Int): String =
        runFolderIoAsync(callId) { listTreeFiles(rawTreeUri) }

    @JvmStatic
    fun readTreeFileAsync(rawTreeUri: String, documentId: String, callId: Int): String =
        runFolderIoAsync(callId) { readTreeFile(rawTreeUri, documentId) }

    @JvmStatic
    fun writeTreeFileAsync(rawTreeUri: String, name: String, base64Data: String, callId: Int): String =
        runFolderIoAsync(callId) { writeTreeFile(rawTreeUri, name, base64Data) }

    @JvmStatic
    fun listTreeFiles(rawTreeUri: String): String {
        val act = activity ?: return "__CSTL_ERROR__ Activity not attached"
        return try {
            val treeUri = Uri.parse(rawTreeUri)
            val result = org.json.JSONArray()
            val resolver = act.contentResolver
            val columns = arrayOf(
                DocumentsContract.Document.COLUMN_DOCUMENT_ID,
                DocumentsContract.Document.COLUMN_DISPLAY_NAME,
                DocumentsContract.Document.COLUMN_MIME_TYPE
            )
            fun visit(parentId: String, relativeDir: String, depth: Int) {
                if (depth > 32) return
                val childrenUri = DocumentsContract.buildChildDocumentsUriUsingTree(treeUri, parentId)
                resolver.query(childrenUri, columns, null, null, null)?.use { cursor ->
                    val idCol = cursor.getColumnIndexOrThrow(DocumentsContract.Document.COLUMN_DOCUMENT_ID)
                    val nameCol = cursor.getColumnIndexOrThrow(DocumentsContract.Document.COLUMN_DISPLAY_NAME)
                    val mimeCol = cursor.getColumnIndexOrThrow(DocumentsContract.Document.COLUMN_MIME_TYPE)
                    while (cursor.moveToNext()) {
                        val id = cursor.getString(idCol) ?: continue
                        val name = cursor.getString(nameCol) ?: continue
                        val mime = cursor.getString(mimeCol) ?: ""
                        val path = if (relativeDir.isEmpty()) name else "$relativeDir/$name"
                        if (mime == DocumentsContract.Document.MIME_TYPE_DIR) {
                            visit(id, path, depth + 1)
                        } else {
                            result.put(JSONObject().put("name", name).put("relativePath", path).put("documentId", id))
                        }
                    }
                }
            }
            visit(DocumentsContract.getTreeDocumentId(treeUri), "", 0)
            result.toString()
        } catch (t: Throwable) {
            "__CSTL_ERROR__ ${t.message ?: "Could not list selected folder"}"
        }
    }

    @JvmStatic
    fun readTreeFile(rawTreeUri: String, documentId: String): String {
        val act = activity ?: return "__CSTL_ERROR__ Activity not attached"
        return try {
            val treeUri = Uri.parse(rawTreeUri)
            val uri = DocumentsContract.buildDocumentUriUsingTree(treeUri, documentId)
            val output = ByteArrayOutputStream()
            act.contentResolver.openInputStream(uri)?.use { input ->
                val buffer = ByteArray(64 * 1024)
                while (true) {
                    val count = input.read(buffer)
                    if (count < 0) break
                    output.write(buffer, 0, count)
                }
            } ?: return "__CSTL_ERROR__ Provider did not open the selected file"
            Base64.encodeToString(output.toByteArray(), Base64.NO_WRAP)
        } catch (t: Throwable) {
            "__CSTL_ERROR__ ${t.message ?: "Could not read selected file"}"
        }
    }

    @JvmStatic
    fun writeTreeFile(rawTreeUri: String, rawName: String, base64Data: String): String {
        val act = activity ?: return "__CSTL_ERROR__ Activity not attached"
        val name = rawName.substringAfterLast('/').substringAfterLast('\\').trim()
        if (name.isEmpty() || name.any { it in "\\/:*?\"<>|" }) return "__CSTL_ERROR__ Invalid backup filename"
        return try {
            val treeUri = Uri.parse(rawTreeUri)
            val rootId = DocumentsContract.getTreeDocumentId(treeUri)
            val childrenUri = DocumentsContract.buildChildDocumentsUriUsingTree(treeUri, rootId)
            val columns = arrayOf(
                DocumentsContract.Document.COLUMN_DOCUMENT_ID,
                DocumentsContract.Document.COLUMN_DISPLAY_NAME,
                DocumentsContract.Document.COLUMN_MIME_TYPE
            )
            var targetUri: Uri? = null
            act.contentResolver.query(childrenUri, columns, null, null, null)?.use { cursor: Cursor ->
                val idCol = cursor.getColumnIndexOrThrow(DocumentsContract.Document.COLUMN_DOCUMENT_ID)
                val nameCol = cursor.getColumnIndexOrThrow(DocumentsContract.Document.COLUMN_DISPLAY_NAME)
                val mimeCol = cursor.getColumnIndexOrThrow(DocumentsContract.Document.COLUMN_MIME_TYPE)
                while (cursor.moveToNext()) {
                    if (cursor.getString(nameCol) == name && cursor.getString(mimeCol) != DocumentsContract.Document.MIME_TYPE_DIR) {
                        targetUri = DocumentsContract.buildDocumentUriUsingTree(treeUri, cursor.getString(idCol))
                        break
                    }
                }
            }
            if (targetUri == null) {
                targetUri = DocumentsContract.createDocument(
                    act.contentResolver,
                    DocumentsContract.buildDocumentUriUsingTree(treeUri, rootId),
                    "application/json",
                    name
                )
            }
            val outputUri = targetUri ?: return "__CSTL_ERROR__ Could not create backup document"
            val bytes = Base64.decode(base64Data, Base64.DEFAULT)
            act.contentResolver.openOutputStream(outputUri, "wt")?.use { it.write(bytes) }
                ?: return "__CSTL_ERROR__ Provider did not open the backup document"
            "ok"
        } catch (t: Throwable) {
            "__CSTL_ERROR__ ${t.message ?: "Could not write backup document"}"
        }
    }
}
