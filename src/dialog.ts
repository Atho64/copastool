/**
 * Custom in-app dialog system (Prompt, Confirm, Alert).
 * Replaces native browser blocking dialogs with themed, non-blocking modal components.
 */

let seq = 0;
let activeOverlay: HTMLElement | null = null;
const dialogQueue: Array<() => Promise<void>> = [];
let isProcessingQueue = false;

function escapeHtml(str: string): string {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatMessageToHtml(message: string): string {
  return escapeHtml(message).replace(/\n/g, '<br />');
}

async function enqueueDialog<T>(fn: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    dialogQueue.push(async () => {
      try {
        const result = await fn();
        resolve(result);
      } catch (err) {
        reject(err);
      }
    });
    processQueue();
  });
}

async function processQueue(): Promise<void> {
  if (isProcessingQueue || dialogQueue.length === 0) return;
  isProcessingQueue = true;
  while (dialogQueue.length > 0) {
    const nextFn = dialogQueue.shift();
    if (nextFn) {
      await nextFn();
    }
  }
  isProcessingQueue = false;
}

export interface PromptOptions {
  title?: string;
  placeholder?: string;
  confirmLabel?: string;
  cancelLabel?: string;
}

export interface ConfirmOptions {
  title?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  wide?: boolean;
}

export interface AlertOptions {
  title?: string;
  confirmLabel?: string;
}

/**
 * In-app text prompt dialog.
 * Replaces `window.prompt(message, defaultValue)`.
 * Resolves with the input string if confirmed, or `null` if cancelled.
 */
export function cstlPrompt(
  message: string,
  defaultValue = '',
  opts: PromptOptions = {}
): Promise<string | null> {
  return enqueueDialog(() => {
    return new Promise<string | null>((resolve) => {
      const id = 'cstl-prompt-input-' + ++seq;
      const title = opts.title || 'Input';
      const confirmLabel = opts.confirmLabel || 'OK';
      const cancelLabel = opts.cancelLabel || 'Batal';

      const overlay = document.createElement('div');
      overlay.className = 'modal-backdrop open cstl-dialog-backdrop';
      overlay.style.zIndex = '2200';
      overlay.innerHTML = `
        <div class="modal cstl-dialog-modal" role="dialog" aria-modal="true">
          <div class="modal-head">
            <h3 class="m-0">${escapeHtml(title)}</h3>
          </div>
          <div class="modal-body cstl-dialog-body" style="max-height: 65vh; overflow-y: auto;">
            <p class="m-0 mb-3" style="font-size: 13.5px; line-height: 1.5; color: var(--text);">${formatMessageToHtml(message)}</p>
            <input id="${id}" class="text-input w-full" type="text" autocomplete="off" />
          </div>
          <div class="modal-actions" style="display: flex; align-items: center; gap: 8px; margin-top: 16px;">
            <button type="button" class="btn btn-outline cstl-dialog-cancel">${escapeHtml(cancelLabel)}</button>
            <span class="grow" style="flex: 1;"></span>
            <button type="button" class="btn btn-primary cstl-dialog-ok">${escapeHtml(confirmLabel)}</button>
          </div>
        </div>`;

      document.body.appendChild(overlay);
      activeOverlay = overlay;

      let settled = false;
      const finish = (result: string | null) => {
        if (settled) return;
        settled = true;
        activeOverlay = null;
        overlay.classList.remove('open');
        overlay.remove();
        resolve(result);
      };

      const input = overlay.querySelector('#' + id) as HTMLInputElement | null;
      const btnOk = overlay.querySelector('.cstl-dialog-ok') as HTMLButtonElement | null;
      const btnCancel = overlay.querySelector('.cstl-dialog-cancel') as HTMLButtonElement | null;

      overlay.addEventListener('click', (e: MouseEvent) => {
        if (e.target === overlay) finish(null);
      });

      btnCancel?.addEventListener('click', () => finish(null));
      btnOk?.addEventListener('click', () => finish(input ? input.value : ''));

      if (input) {
        input.value = String(defaultValue ?? '');
        if (opts.placeholder) input.placeholder = opts.placeholder;

        input.addEventListener('keydown', (e: KeyboardEvent) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            finish(input.value);
          } else if (e.key === 'Escape') {
            e.preventDefault();
            finish(null);
          }
        });
      }

      requestAnimationFrame(() => {
        if (input) {
          input.focus();
          input.select();
        }
      });
    });
  });
}

/**
 * In-app confirmation dialog.
 * Replaces `window.confirm(message)`.
 * Resolves with `true` if confirmed, or `false` if cancelled.
 */
export function cstlConfirm(
  message: string,
  opts: ConfirmOptions = {}
): Promise<boolean> {
  return enqueueDialog(() => {
    return new Promise<boolean>((resolve) => {
      const title = opts.title || (opts.danger ? 'Konfirmasi Tindakan' : 'Konfirmasi');
      const confirmLabel = opts.confirmLabel || (opts.danger ? 'Hapus' : 'OK');
      const cancelLabel = opts.cancelLabel || 'Batal';
      const danger = !!opts.danger;

      const overlay = document.createElement('div');
      overlay.className = 'modal-backdrop open cstl-dialog-backdrop';
      overlay.style.zIndex = '2200';
      overlay.innerHTML = `
        <div class="modal cstl-dialog-modal ${opts.wide ? 'modal-wide' : ''}" role="dialog" aria-modal="true">
          <div class="modal-head">
            <h3 class="m-0">${escapeHtml(title)}</h3>
          </div>
          <div class="modal-body cstl-dialog-body" style="max-height: 65vh; overflow-y: auto;">
            <p class="m-0" style="font-size: 13.5px; line-height: 1.5; color: var(--text);">${formatMessageToHtml(message)}</p>
          </div>
          <div class="modal-actions" style="display: flex; align-items: center; gap: 8px; margin-top: 18px;">
            <button type="button" class="btn btn-outline cstl-dialog-cancel">${escapeHtml(cancelLabel)}</button>
            <span class="grow" style="flex: 1;"></span>
            <button type="button" class="btn ${danger ? 'btn-danger' : 'btn-primary'} cstl-dialog-ok">${escapeHtml(confirmLabel)}</button>
          </div>
        </div>`;

      document.body.appendChild(overlay);
      activeOverlay = overlay;

      let settled = false;
      const finish = (confirmed: boolean) => {
        if (settled) return;
        settled = true;
        activeOverlay = null;
        window.removeEventListener('keydown', onKey);
        overlay.classList.remove('open');
        overlay.remove();
        resolve(confirmed);
      };

      const onKey = (e: KeyboardEvent) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          finish(false);
        } else if (e.key === 'Enter') {
          // If focus is specifically on cancel, don't confirm on Enter
          if (document.activeElement === btnCancel) {
            e.preventDefault();
            finish(false);
          } else {
            e.preventDefault();
            finish(true);
          }
        }
      };
      window.addEventListener('keydown', onKey);

      const btnOk = overlay.querySelector('.cstl-dialog-ok') as HTMLButtonElement | null;
      const btnCancel = overlay.querySelector('.cstl-dialog-cancel') as HTMLButtonElement | null;

      overlay.addEventListener('click', (e: MouseEvent) => {
        if (e.target === overlay) finish(false);
      });

      btnCancel?.addEventListener('click', () => finish(false));
      btnOk?.addEventListener('click', () => finish(true));

      requestAnimationFrame(() => {
        const toFocus = danger ? btnCancel : btnOk;
        toFocus?.focus();
      });
    });
  });
}

/**
 * In-app alert dialog.
 * Replaces `window.alert(message)`.
 * Resolves when dismissed by the user.
 */
export function cstlAlert(
  message: string,
  opts: AlertOptions = {}
): Promise<void> {
  return enqueueDialog(() => {
    return new Promise<void>((resolve) => {
      const title = opts.title || 'Informasi';
      const confirmLabel = opts.confirmLabel || 'OK';

      const overlay = document.createElement('div');
      overlay.className = 'modal-backdrop open cstl-dialog-backdrop';
      overlay.style.zIndex = '2200';
      overlay.innerHTML = `
        <div class="modal cstl-dialog-modal" role="dialog" aria-modal="true">
          <div class="modal-head">
            <h3 class="m-0">${escapeHtml(title)}</h3>
          </div>
          <div class="modal-body cstl-dialog-body" style="max-height: 65vh; overflow-y: auto;">
            <p class="m-0" style="font-size: 13.5px; line-height: 1.5; color: var(--text);">${formatMessageToHtml(message)}</p>
          </div>
          <div class="modal-actions" style="display: flex; align-items: center; justify-content: flex-end; margin-top: 18px;">
            <button type="button" class="btn btn-primary cstl-dialog-ok">${escapeHtml(confirmLabel)}</button>
          </div>
        </div>`;

      document.body.appendChild(overlay);
      activeOverlay = overlay;

      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        activeOverlay = null;
        window.removeEventListener('keydown', onKey);
        overlay.classList.remove('open');
        overlay.remove();
        resolve();
      };

      const onKey = (e: KeyboardEvent) => {
        if (e.key === 'Escape' || e.key === 'Enter') {
          e.preventDefault();
          finish();
        }
      };
      window.addEventListener('keydown', onKey);

      const btnOk = overlay.querySelector('.cstl-dialog-ok') as HTMLButtonElement | null;

      overlay.addEventListener('click', (e: MouseEvent) => {
        if (e.target === overlay) finish();
      });

      btnOk?.addEventListener('click', () => finish());

      requestAnimationFrame(() => {
        btnOk?.focus();
      });
    });
  });
}

/**
 * Initializes global dialog overrides.
 * Intercepts `window.alert` so third-party calls or legacy code display custom in-app dialogs.
 */
export function initGlobalDialogs(): void {
  if (typeof window === 'undefined') return;

  (window as any).cstlPrompt = cstlPrompt;
  (window as any).cstlConfirm = cstlConfirm;
  (window as any).cstlAlert = cstlAlert;

  // Intercept window.alert
  window.alert = (msg: any) => {
    void cstlAlert(String(msg ?? ''));
  };
}
