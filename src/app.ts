// @module app.ts — Entry point: bootstraps the application on DOMContentLoaded
// All business logic lives in the other modules in this directory.

window.onerror = function(message, source, lineno, colno, error) {
  // ResizeObserver loop is a benign browser warning — ignore it
  if (typeof message === 'string' && message.includes('ResizeObserver')) return true;
  const errDiv = document.createElement('div');
  errDiv.style.cssText = 'position:fixed;top:0;left:0;width:100%;background:red;color:white;z-index:9999;padding:10px;font-family:monospace;white-space:pre-wrap;cursor:pointer;';
  errDiv.textContent = `[Klik untuk menutup]\nError: ${message}\nSource: ${source}\nLine: ${lineno}:${colno}\nStack: ${error?.stack}`;
  errDiv.onclick = () => errDiv.remove();
  document.body.appendChild(errDiv);
};

window.addEventListener('unhandledrejection', function(event) {
  const errDiv = document.createElement('div');
  errDiv.style.cssText = 'position:fixed;top:50px;left:0;width:100%;background:darkred;color:white;z-index:9999;padding:10px;font-family:monospace;white-space:pre-wrap;cursor:pointer;';
  errDiv.textContent = `[Klik untuk menutup]\nUnhandled Promise Rejection: ${event.reason?.message || event.reason}\nStack: ${event.reason?.stack}`;
  errDiv.onclick = () => errDiv.remove();
  document.body.appendChild(errDiv);
});

import { init } from './ui-init';
import { initExtensionBridge } from './extension-bridge';
import { APP_VERSION } from './constants';
import { isTauri } from './native-storage';

// Inject critical dynamic CSS that Vite may strip from external stylesheet
(function injectDynamicStyles() {
  const style = document.createElement('style');
  style.id = 'cstl-dynamic-styles';
  style.textContent = [
    '.preview-row.row-translated { border-left: 3px solid #10b981 !important; }',
    '.preview-row.row-ai-checked { border-left: 3px solid #f59e0b !important; }',
  ].join('\n');
  document.head.appendChild(style);
})();

// ─── Stale-build self-heal ────────────────────────────────────────────────────
// The webview data directory survives an in-place install/update, so a service
// worker or cache left behind by an older build can keep serving the previous
// app shell. That used to leave the app unusable until the user pressed
// Ctrl+Shift+R. Detect the leftover state and repair it automatically.

/** Cache Storage buckets that hold downloaded data, not app assets. */
const KEEP_CACHE_NAMES = new Set(['cstl-pyodide-v1', 'copastool-kuromoji-dict']);

async function invokeNative(command: string): Promise<any | null> {
  if (!isTauri()) return null;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    return await invoke(command);
  } catch (err) {
    console.warn(`[Boot] ${command} failed:`, err);
    return null;
  }
}

/**
 * Unregisters service workers and drops every Cache Storage bucket. Only ever
 * called from the Tauri build — a stale service worker left behind by an older
 * release is what made the app require Ctrl+Shift+R after an update.
 */
async function purgeWebCaches(): Promise<boolean> {
  let changed = false;
  try {
    if ('serviceWorker' in navigator) {
      const registrations = await navigator.serviceWorker.getRegistrations();
      for (const reg of registrations) {
        try {
          if (await reg.unregister()) changed = true;
        } catch (_) {}
      }
    }
  } catch (_) {}
  try {
    if (typeof caches !== 'undefined') {
      for (const key of await caches.keys()) {
        // These two hold downloaded runtime data (Pyodide ~10 MB, Kuromoji
        // dictionary) rather than app-shell assets — re-downloading them would
        // be a real cost, so they stay.
        if (KEEP_CACHE_NAMES.has(key)) continue;
        try {
          if (await caches.delete(key)) changed = true;
        } catch (_) {}
      }
    }
  } catch (_) {}
  return changed;
}

/**
 * Makes sure the running frontend matches the installed native build.
 * Returns false when a reload was triggered (the caller must not continue).
 */
async function ensureFreshBuild(): Promise<boolean> {
  // Only the native build needs repairing: its webview data directory survives
  // in-place updates. The web/PWA build *wants* its service worker and cache.
  if (!isTauri()) return true;

  const leftOverState = await purgeWebCaches();

  const rustStamp = await invokeNative('get_build_stamp');
  if (rustStamp == null) {
    // Older native build without the stamp command: a leftover service worker is
    // the only thing we can detect, so reload once when we removed one.
    if (leftOverState) {
      window.location.reload();
      return false;
    }
    return true;
  }

  if (String(rustStamp) === APP_VERSION) {
    sessionStorage.removeItem('cstl_stale_reload');
    sessionStorage.removeItem('cstl_stale_purge');
    return true;
  }

  console.warn(`[Boot] frontend ${APP_VERSION} does not match native ${rustStamp} — repairing.`);

  if (sessionStorage.getItem('cstl_stale_reload') === '1') {
    // A plain reload did not fix it, so the webview itself is serving the old
    // assets: drop the main window's browsing data once and reload again.
    if (sessionStorage.getItem('cstl_stale_purge') === '1') {
      console.error('[Boot] Frontend still stale after full purge — continuing anyway.');
      return true;
    }
    sessionStorage.setItem('cstl_stale_purge', '1');
    await invokeNative('clear_webview_browsing_data');
    window.location.reload();
    return false;
  }

  sessionStorage.setItem('cstl_stale_reload', '1');
  window.location.reload();
  return false;
}

function removeLoader() {
  const loader = document.getElementById('startupLoader');
  if (!loader) return;
  loader.classList.add('fade-out');
  setTimeout(() => loader.remove(), 250);
}

async function bootstrap() {
  try {
    if (!(await ensureFreshBuild())) return;
    await init();
  } finally {
    removeLoader();
  }
  initExtensionBridge();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootstrap);
} else {
  bootstrap();
}
