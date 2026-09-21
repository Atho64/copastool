// @module ai-webview-controller.ts — Embedded Web AI Controller for Tauri (Windows & Android)
// Controls ChatGPT, Gemini, DeepSeek, Claude webviews natively without a Chrome extension

import { isTauri } from './native-storage';
import { readClipboardText, writeClipboardText } from './native-clipboard';
import type { CopasTargetId } from './extension-bridge';

export const AI_TARGET_URLS: Record<CopasTargetId, string> = {
  gemini: 'https://gemini.google.com/app',
  chatgpt: 'https://chatgpt.com/',
  deepseek: 'https://chat.deepseek.com/',
  meta: 'https://www.meta.ai/',
  claude: 'https://claude.ai/new',
  qwen: 'https://chat.qwenlm.ai/',
  arena: 'https://lmarena.ai/',
  freebuff: 'https://freebuff.chat/',
};

let invokeFn: ((cmd: string, args?: Record<string, any>) => Promise<any>) | null = null;

async function getInvoke() {
  if (invokeFn) return invokeFn;
  if (!isTauri()) return null;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    invokeFn = invoke;
    return invokeFn;
  } catch {
    return null;
  }
}

export async function openAiCompanion(targetId: CopasTargetId): Promise<boolean> {
  const url = AI_TARGET_URLS[targetId] || AI_TARGET_URLS.gemini;
  const invoke = await getInvoke();
  if (invoke) {
    try {
      await invoke('open_ai_window', { url });
      return true;
    } catch (err) {
      console.warn('[AiWebview] invoke open_ai_window failed, trying opener:', err);
    }
  }

  // Fallback via tauri plugin opener or window.open
  try {
    const { openUrl } = await import('@tauri-apps/plugin-opener');
    await openUrl(url, 'inAppBrowser');
    return true;
  } catch (_) {
    window.open(url, '_blank');
    return true;
  }
}

export async function closeAiCompanion(): Promise<boolean> {
  const invoke = await getInvoke();
  if (!invoke) return false;
  try {
    await invoke('close_ai_window');
    return true;
  } catch (err) {
    console.error('[AiWebview] Failed to close AI window:', err);
    return false;
  }
}

/**
 * Injects automation script into the AI companion window and waits for response.
 * Uses document.title protocol for zero-dependency, cross-process data return.
 */
export async function executeAiWorkflow(
  targetId: CopasTargetId,
  promptText: string,
  mode: 'semi' | 'full',
  onProgress?: (stage: string, detail?: string) => void
): Promise<{ ok: boolean; text?: string; error?: string }> {
  // Always copy prompt to clipboard so user can immediately paste in any AI window/browser
  try {
    await writeClipboardText(promptText);
  } catch (_) {}

  // Open or focus AI Companion window (or external browser)
  await openAiCompanion(targetId);

  if (mode === 'semi') {
    onProgress?.('pasted', 'Tersalin ke Clipboard & Web AI terbuka');
    return { ok: true, text: promptText };
  }

  if (!isTauri()) {
    return { ok: false, error: 'Fitur Full Auto memerlukan runtime Tauri Desktop' };
  }

  onProgress?.('Persiapan', 'Menghubungkan ke Web AI Companion...');

  // Wait briefly for window to be ready
  await new Promise((r) => setTimeout(r, 600));

  // Build the self-contained injection script
  const script = `(function() {
    try {
      var prompt = decodeURIComponent("${encodeURIComponent(promptText)}");
      var mode = "${mode}";
      var target = "${targetId}";

      function findInput() {
        var selectors = [
          'rich-textarea div[contenteditable="true"]',
          'div[contenteditable="true"][aria-label*="Gemini" i]',
          'div[contenteditable="true"][aria-label*="Minta" i]',
          'div[contenteditable="true"][aria-label*="Ask" i]',
          'div[contenteditable="true"][aria-label*="prompt" i]',
          'div.ql-editor.textarea[contenteditable="true"]',
          'div[contenteditable="true"][aria-label*="Enter" i]',
          'div[contenteditable="true"][role="textbox"]',
          'div[contenteditable="true"]',
          'textarea#chat-input',
          'textarea#prompt-textarea',
          'textarea[placeholder*="Message" i]',
          'textarea[placeholder*="Ask" i]',
          'textarea[placeholder*="Kirim" i]',
          'textarea'
        ];
        for (var i = 0; i < selectors.length; i++) {
          var el = document.querySelector(selectors[i]);
          if (el && el.offsetParent !== null) return el;
        }
        return null;
      }

      function findSendButton() {
        var selectors = [
          'button[aria-label*="Send" i]',
          'button[aria-label*="Kirim" i]',
          'button[data-testid="send-button"]',
          'button.send-button',
          'button[mattooltip*="Send" i]',
          'button[mattooltip*="Kirim" i]',
          'button[aria-label*="Submit" i]',
          'div[role="button"][aria-label*="Send" i]',
          'div[role="button"][aria-label*="Kirim" i]'
        ];
        for (var i = 0; i < selectors.length; i++) {
          var btn = document.querySelector(selectors[i]);
          if (btn && !btn.disabled && btn.offsetParent !== null) return btn;
        }
        return null;
      }

      function findAssistantText() {
        var selectors = [
          'model-response pre code',
          'model-response .markdown',
          'message-content.model-response-text',
          '.model-response-text',
          '[data-message-author-role="assistant"] pre code',
          '[data-message-author-role="assistant"] .markdown',
          '[data-message-author-role="model"]',
          'div.markdown.prose',
          'model-response',
          '.response-container'
        ];
        for (var i = 0; i < selectors.length; i++) {
          var items = document.querySelectorAll(selectors[i]);
          if (items.length > 0) {
            var last = items[items.length - 1];
            var text = last.innerText || last.textContent;
            if (text && text.trim().length > 0) return text.trim();
          }
        }
        return '';
      }

      function copyToClipboard(text) {
        try {
          var copyBtns = document.querySelectorAll('button[aria-label*="Copy" i], button[aria-label*="Salin" i], button[data-tooltip*="Copy" i], button[data-tooltip*="Salin" i]');
          if (copyBtns.length > 0) copyBtns[copyBtns.length - 1].click();
        } catch (_) {}
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text);
          }
        } catch (_) {}
        try {
          var ta = document.createElement('textarea');
          ta.value = text;
          ta.style.position = 'fixed';
          ta.style.left = '-9999px';
          document.body.appendChild(ta);
          ta.focus();
          ta.select();
          document.execCommand('copy');
          document.body.removeChild(ta);
        } catch (_) {}
      }

      var input = findInput();
      if (!input) return;

      if (input.tagName === 'TEXTAREA' || input.tagName === 'INPUT') {
        input.value = prompt;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      } else {
        input.focus();
        input.innerText = prompt;
        input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: prompt }));
      }

      if (mode === 'semi') return;

      // Full mode: Click Send and wait for generation
      setTimeout(function() {
        var sendBtn = findSendButton();
        if (sendBtn) {
          sendBtn.click();
        } else {
          input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
        }

        // Poll for completion
        var lastText = "";
        var stableCount = 0;
        var elapsed = 0;

        var timer = setInterval(function() {
          elapsed++;
          var stopBtn = document.querySelector('button[aria-label*="Stop" i], button[aria-label*="Hentikan" i]');
          var currentText = findAssistantText();
          if (!stopBtn && currentText && currentText.length > 10) {
            if (currentText === lastText) {
              stableCount++;
              if (stableCount >= 2) {
                clearInterval(timer);
                copyToClipboard(currentText);
                return;
              }
            } else {
              lastText = currentText;
              stableCount = 0;
            }
          } else if (currentText) {
            lastText = currentText;
          }

          if (elapsed >= 180) { // 90 seconds timeout
            clearInterval(timer);
            if (lastText) copyToClipboard(lastText);
          }
        }, 500);

      }, 300);

    } catch(err) {}
  })();`;

  const invoke = await getInvoke();
  if (!invoke) return { ok: false, error: 'Invoke not available' };

  try {
    await invoke('eval_ai_script', { script });
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }

  onProgress?.('Menghasilkan', 'Prompt terkirim. Menunggu respons AI...');

  // Poll clipboard and periodically poke the AI window to copy latest assistant text
  const startTime = Date.now();
  const timeoutMs = 180000; // 3 minutes timeout

  let initialClip = '';
  try {
    initialClip = (await readClipboardText())?.trim() || '';
  } catch (_) {}

  return new Promise((resolve) => {
    let tickCount = 0;
    const pollInterval = setInterval(async () => {
      tickCount++;
      if (Date.now() - startTime > timeoutMs) {
        clearInterval(pollInterval);
        resolve({ ok: false, error: 'Waktu tunggu AI melebihi batas (timeout).' });
        return;
      }

      // Check clipboard using focus-independent native clipboard
      try {
        const currentClip = (await readClipboardText())?.trim() || '';
        if (
          currentClip &&
          currentClip.length > 10 &&
          currentClip !== initialClip &&
          currentClip !== promptText.trim() &&
          !currentClip.startsWith('You are a visual novel translator')
        ) {
          clearInterval(pollInterval);
          onProgress?.('Selesai', 'Respons AI diterima dari clipboard!');
          resolve({ ok: true, text: currentClip });
          return;
        }
      } catch (_) {}

      if (tickCount === 4) {
        onProgress?.('Menghasilkan', 'AI sedang memproses naskah...');
      }

      // Every ~1.5 seconds, poke the webview to check if assistant text is ready and copy it
      if (tickCount % 3 === 0) {
        try {
          const pokeScript = `(function() {
            try {
              var sel = [
                'model-response pre code',
                'model-response .markdown',
                'message-content.model-response-text',
                '.model-response-text',
                '[data-message-author-role="assistant"] pre code',
                '[data-message-author-role="assistant"] .markdown',
                '[data-message-author-role="model"]',
                'div.markdown.prose',
                'model-response',
                '.response-container'
              ];
              var text = '';
              for (var i = 0; i < sel.length; i++) {
                var list = document.querySelectorAll(sel[i]);
                if (list.length > 0) {
                  var last = list[list.length - 1];
                  text = last.innerText || last.textContent || '';
                  if (text && text.trim().length > 10) break;
                }
              }
              var stopBtn = document.querySelector('button[aria-label*="Stop" i], button[aria-label*="Hentikan" i]');
              if (!stopBtn && text && text.trim().length > 10) {
                var copyBtns = document.querySelectorAll('button[aria-label*="Copy" i], button[aria-label*="Salin" i], button[data-tooltip*="Copy" i], button[data-tooltip*="Salin" i]');
                if (copyBtns.length > 0) copyBtns[copyBtns.length - 1].click();
                try { navigator.clipboard.writeText(text.trim()); } catch(_) {}
                try {
                  var ta = document.createElement('textarea');
                  ta.value = text.trim();
                  ta.style.position = 'fixed';
                  ta.style.left = '-9999px';
                  document.body.appendChild(ta);
                  ta.focus();
                  ta.select();
                  document.execCommand('copy');
                  document.body.removeChild(ta);
                } catch(_) {}
              }
            } catch(_) {}
          })();`;
          await invoke('eval_ai_script', { script: pokeScript });
        } catch (_) {}
      }
    }, 500);
  });
}

export async function fetchCurrentAiResult(): Promise<{ ok: boolean; text?: string; error?: string }> {
  if (!isTauri()) {
    return { ok: false, error: 'Tauri environment not detected' };
  }
  const invoke = await getInvoke();
  if (!invoke) return { ok: false, error: 'Invoke not available' };

  const script = `(function() {
    try {
      var selectors = [
        'model-response pre code',
        'model-response .markdown',
        'message-content.model-response-text',
        '.model-response-text',
        '[data-message-author-role="assistant"] pre code',
        '[data-message-author-role="assistant"] .markdown',
        '[data-message-author-role="model"]',
        'div.markdown.prose',
        'model-response',
        '.response-container'
      ];
      var text = '';
      for (var i = 0; i < selectors.length; i++) {
        var items = document.querySelectorAll(selectors[i]);
        if (items.length > 0) {
          var last = items[items.length - 1];
          text = last.innerText || last.textContent || '';
          if (text && text.trim().length > 0) break;
        }
      }
      var copyBtns = document.querySelectorAll('button[aria-label*="Copy" i], button[aria-label*="Salin" i], button[data-tooltip*="Copy" i], button[data-tooltip*="Salin" i]');
      if (copyBtns.length > 0) copyBtns[copyBtns.length - 1].click();
      if (text) {
        try { navigator.clipboard.writeText(text.trim()); } catch (_) {}
        try {
          var ta = document.createElement('textarea');
          ta.value = text.trim();
          ta.style.position = 'fixed';
          ta.style.left = '-9999px';
          document.body.appendChild(ta);
          ta.focus();
          ta.select();
          document.execCommand('copy');
          document.body.removeChild(ta);
        } catch (_) {}
      }
    } catch (_) {}
  })();`;

  try {
    await invoke('eval_ai_script', { script });
  } catch (_) {}

  // Wait briefly for clipboard to be populated
  await new Promise((r) => setTimeout(r, 300));

  try {
    const text = (await readClipboardText())?.trim();
    if (text && text.length > 0 && !text.startsWith('You are a visual novel translator')) {
      return { ok: true, text };
    }
  } catch (_) {}

  return { ok: false, error: 'Belum ada respons yang tersalin dari AI' };
}
