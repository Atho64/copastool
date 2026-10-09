package com.copastool.app

import android.annotation.SuppressLint
import android.os.Bundle
import android.webkit.CookieManager
import android.webkit.WebChromeClient
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.appcompat.app.AppCompatActivity

/**
 * In-app webview host for Auto Copas ("for android just webview").
 *
 * Loads the AI chat site so the clipboard-driven automation can run inside the
 * app: the bridge pastes the prompt through the IME InputConnection (a real
 * clipboard paste, never DOM injection), the site's own Copy button puts the
 * response on the clipboard, and the bridge reads it back with ClipboardManager.
 *
 * Built entirely in code (no layout XML) because scripts/patch-android-bridge.mjs
 * injects this file into the generated gradle project together with the
 * manifest entry below.
 */
class AutoCopasActivity : AppCompatActivity() {

    companion object {
        const val EXTRA_URL = "cstl_copas_url"
    }

    private var webView: WebView? = null

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val url = intent?.getStringExtra(EXTRA_URL) ?: "https://gemini.google.com/app"
        val wv = WebView(this)
        wv.settings.javaScriptEnabled = true
        wv.settings.domStorageEnabled = true
        wv.settings.databaseEnabled = true
        // Keep the page alive when the activity is paused: the automation loop
        // continues in the background webview and only talks to this one.
        wv.settings.loadsImagesAutomatically = true
        wv.settings.mixedContentMode = WebView.MIXED_CONTENT_COMPATIBILITY_MODE
        wv.settings.setSupportMultipleWindows(false)
        // Strip the WebView marker so sites serve the normal desktop/mobile
        // chat UI instead of a "open in app" interstitial.
        wv.settings.userAgentString = wv.settings.userAgentString.replace("; wv", "")
        wv.webViewClient = object : WebViewClient() {
            override fun onPageFinished(view: WebView, pageUrl: String) {
                AndroidBridge.onCopasPageFinished(pageUrl)
            }
        }
        wv.webChromeClient = WebChromeClient()
        setContentView(wv)
        webView = wv
        if (savedInstanceState != null) {
            wv.restoreState(savedInstanceState)
        } else {
            wv.loadUrl(url)
        }
        AndroidBridge.attachCopas(this, wv)
    }

    fun loadCopasUrl(url: String) {
        webView?.loadUrl(url)
        webView?.requestFocus()
    }

    fun copasWebView(): WebView? = webView

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        webView?.saveState(outState)
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        val wv = webView
        if (wv != null && wv.canGoBack()) {
            wv.goBack()
        } else {
            super.onBackPressed()
        }
    }

    override fun onPause() {
        super.onPause()
        // Force cookies to disk so site logins survive the process being
        // killed (WebView flushes are otherwise best-effort/timed).
        CookieManager.getInstance().flush()
    }

    override fun onDestroy() {
        CookieManager.getInstance().flush()
        AndroidBridge.detachCopas(this)
        webView?.destroy()
        webView = null
        super.onDestroy()
    }
}
