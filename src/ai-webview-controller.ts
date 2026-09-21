// @module ai-webview-controller.ts — Embedded Web AI Controller for Tauri (Windows & Android)
// Controls ChatGPT, Gemini, DeepSeek, Claude webviews natively without a Chrome extension

import { isTauri } from './native-storage';
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
  const invoke = await getInvoke();
  if (!invoke) return false;
  const url = AI_TARGET_URLS[targetId] || AI_TARGET_URLS.gemini;
  try {
    await invoke('open_ai_window', { url });
    return true;
  } catch (err) {
    console.error('[AiWebview] Failed to open AI window:', err);
    return false;
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
  if (!isTauri()) {
    return { ok: false, error: 'Tauri environment not detected' };
  }

  // Ensure AI window is open
  const opened = await openAiCompanion(targetId);
  if (!opened) {
    return { ok: false, error: 'Gagal membuka jendela AI Companion' };
  }

  onProgress?.('Persiapan', 'Menghubungkan ke Web AI...');

  // Wait briefly for window to be ready
  await new Promise((r) => setTimeout(r, 600));

  // Build the self-contained injection script
  const script = `(function() {
    try {
      document.title = "__COPAS_BUSY__";
      var prompt = decodeURIComponent("${encodeURIComponent(promptText)}");
      var mode = "${mode}";
      var target = "${targetId}";

      function findInput() {
        var selectors = [
          'div.ql-editor.textarea[contenteditable="true"]',
          'div[contenteditable="true"][aria-label*="prompt" i]',
          'div[contenteditable="true"][aria-label*="Enter" i]',
          'rich-textarea div[contenteditable="true"]',
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
          'button[aria-label*="Submit" i]',
          'div[role="button"][aria-label*="Send" i]'
        ];
        for (var i = 0; i < selectors.length; i++) {
          var btn = document.querySelector(selectors[i]);
          if (btn && !btn.disabled) return btn;
        }
        return null;
      }

      function findAssistantText() {
        var selectors = [
          'model-response .markdown',
          'message-content.model-response-text',
          '.model-response-text',
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

      var input = findInput();
      if (!input) {
        document.title = "__COPAS_ERROR__:" + encodeURIComponent("Kotak input chat tidak ditemukan. Pastikan Anda sudah login ke akun AI.");
        return;
      }

      // Fill input
      if (input.tagName === 'TEXTAREA' || input.tagName === 'INPUT') {
        input.value = prompt;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      } else {
        input.focus();
        input.innerText = prompt;
        input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: prompt }));
      }

      if (mode === 'semi') {
        document.title = "__COPAS_RESULT__:" + encodeURIComponent(prompt);
        return;
      }

      // Full mode: Click Send and wait for generation
      setTimeout(function() {
        var sendBtn = findSendButton();
        if (sendBtn) {
          sendBtn.click();
        } else {
          // Try enter key
          input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
        }

        document.title = "__COPAS_STATUS__:generating";

        // Poll for completion
        var lastText = "";
        var stableCount = 0;
        var maxWait = 180; // 90 seconds
        var elapsed = 0;

        var interval = setInterval(function() {
          elapsed++;
          var currentText = findAssistantText();
          if (currentText && currentText.length > 5) {
            if (currentText === lastText) {
              stableCount++;
              if (stableCount >= 4) { // Stable for ~2 seconds
                clearInterval(interval);
                document.title = "__COPAS_RESULT__:" + encodeURIComponent(currentText);
                return;
              }
            } else {
              lastText = currentText;
              stableCount = 0;
            }
          }

          if (elapsed >= maxWait) {
            clearInterval(interval);
            if (lastText) {
              document.title = "__COPAS_RESULT__:" + encodeURIComponent(lastText);
            } else {
              document.title = "__COPAS_ERROR__:" + encodeURIComponent("Batas waktu menunggu respons AI tercapai.");
            }
          }
        }, 500);

      }, 300);

    } catch(err) {
      document.title = "__COPAS_ERROR__:" + encodeURIComponent(err.message || String(err));
    }
  })();`;

  const invoke = await getInvoke();
  if (!invoke) return { ok: false, error: 'Invoke not available' };

  try {
    await invoke('eval_ai_script', { script });
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }

  // Poll AI companion title via invoke
  const startTime = Date.now();
  const timeoutMs = 120000; // 2 minutes timeout

  return new Promise((resolve) => {
    const pollInterval = setInterval(async () => {
      if (Date.now() - startTime > timeoutMs) {
        clearInterval(pollInterval);
        resolve({ ok: false, error: 'Waktu tunggu melebihi batas (timeout).' });
        return;
      }

      try {
        const title = (await invoke('get_ai_window_title')) as string;
        if (!title) return;

        if (title.startsWith('__COPAS_STATUS__:')) {
          const stage = title.replace('__COPAS_STATUS__:', '');
          onProgress?.('Generating', stage);
        } else if (title.startsWith('__COPAS_RESULT__:')) {
          clearInterval(pollInterval);
          const encoded = title.replace('__COPAS_RESULT__:', '');
          const resultText = decodeURIComponent(encoded);
          // Reset title
          await invoke('set_ai_window_title', { title: 'CopasTool AI Companion' });
          resolve({ ok: true, text: resultText });
        } else if (title.startsWith('__COPAS_ERROR__:')) {
          clearInterval(pollInterval);
          const encoded = title.replace('__COPAS_ERROR__:', '');
          const errorMsg = decodeURIComponent(encoded);
          await invoke('set_ai_window_title', { title: 'CopasTool AI Companion' });
          resolve({ ok: false, error: errorMsg });
        }
      } catch (e) {
        // Window might be busy or navigating, ignore poll error
      }
    }, 400);
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
      function findAssistantText() {
        var selectors = [
          'model-response .markdown',
          'message-content.model-response-text',
          '.model-response-text',
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
      var text = findAssistantText();
      if (text) {
        document.title = "__COPAS_RESULT__:" + encodeURIComponent(text);
      } else {
        document.title = "__COPAS_ERROR__:" + encodeURIComponent("Belum ada respons dari AI.");
      }
    } catch(err) {
      document.title = "__COPAS_ERROR__:" + encodeURIComponent(err.message || String(err));
    }
  })();`;

  try {
    await invoke('eval_ai_script', { script });
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }

  const startTime = Date.now();
  return new Promise((resolve) => {
    const pollInterval = setInterval(async () => {
      if (Date.now() - startTime > 3000) {
        clearInterval(pollInterval);
        resolve({ ok: false, error: 'Gagal mengambil hasil dari jendela AI' });
        return;
      }
      try {
        const title = (await invoke('get_ai_window_title')) as string;
        if (title.startsWith('__COPAS_RESULT__:')) {
          clearInterval(pollInterval);
          const encoded = title.replace('__COPAS_RESULT__:', '');
          const resultText = decodeURIComponent(encoded);
          await invoke('set_ai_window_title', { title: 'CopasTool AI Companion' });
          resolve({ ok: true, text: resultText });
        } else if (title.startsWith('__COPAS_ERROR__:')) {
          clearInterval(pollInterval);
          const encoded = title.replace('__COPAS_ERROR__:', '');
          const errorMsg = decodeURIComponent(encoded);
          await invoke('set_ai_window_title', { title: 'CopasTool AI Companion' });
          resolve({ ok: false, error: errorMsg });
        }
      } catch (e) {
        // ignore
      }
    }, 200);
  });
}
