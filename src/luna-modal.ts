// @module luna-modal.ts — Modal manager for LunaTranslator & VN Overlay settings

import { lunaHooker, type LunaConnectionStatus, type LunaOperatingMode } from './luna-hooker';
import { overlayController } from './overlay-controller';
import { openModal, closeModal } from './project';
import { state } from './state';
import { COPAS_TARGETS, normalizeCopasTarget } from './auto-copas/targets';

const q = <T extends HTMLElement>(id: string) => document.getElementById(id) as T | null;

/**
 * The floating VN overlay is desktop-Windows only: raising a window above a
 * fullscreen game needs Win32 SetWindowPos + DWM info, and the Rust
 * `open_vn_overlay_window` command returns an error on any non-desktop target.
 * Detect that here so the UI hides the controls instead of offering a button
 * whose only outcome is an error. User-agent based (not `isAndroidNativeApp`)
 * so an Android/PWA browser build is covered too, and so desktop browsers
 * keep the feature: outside Tauri the overlay opens as a popped-out window.
 */
function isOverlaySupported(): boolean {
  return !/Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
}

/**
 * Renders the TL Mode engine badge. In Copas mode the API key is irrelevant,
 * so the badge reports the target site instead of demanding a key. In API mode
 * a missing key is a hard stop, which the badge makes visible before gameplay.
 */
function updateLunaTlBadge(badge: HTMLSpanElement | null): void {
  if (!badge) return;
  if (state.liveTranslateEngine === 'copas') {
    const target = COPAS_TARGETS[normalizeCopasTarget(state.copasTarget)];
    badge.textContent = `Copas: ${target.label}`;
    badge.classList.remove('is-error');
    badge.title = `Menerjemahkan dialog lewat ${target.label} di browser otomatis (login sekali via Buka Browser)`;
    return;
  }
  const modelName = state.aiModel || state.aiApiType || 'API';
  if (state.aiApiKey) {
    badge.textContent = `Model: ${modelName}`;
    badge.classList.remove('is-error');
    badge.title = `${modelName}: dipakai untuk menerjemahkan dialog mentah`;
  } else {
    badge.textContent = 'API Key Belum Diisi!';
    badge.classList.add('is-error');
    badge.title = 'Isi API Key di Setting → API Global, atau pilih mesin Copas di TL Mode';
  }
}

/** Re-renders the TL badge after the engine or target changed elsewhere. */
export function refreshLunaTlBadge(): void {
  updateLunaTlBadge(q<HTMLSpanElement>('lunaTlModelBadge'));
}

export class LunaModalController {
  private modal = q<HTMLDivElement>('lunaHookerModal');
  private hostInput = q<HTMLInputElement>('lunaHostInput');
  private portInput = q<HTMLInputElement>('lunaPortInput');
  private btnConnect = q<HTMLButtonElement>('btnLunaConnect');
  private btnDisconnect = q<HTMLButtonElement>('btnLunaDisconnect');
  private btnToggleOverlay = q<HTMLButtonElement>('btnToggleOverlay');
  private btnOverlayInteractive = q<HTMLButtonElement>('btnOverlayInteractive');
  private btnOverlayDiagnose = q<HTMLButtonElement>('btnOverlayDiagnose');
  private overlayDiagnosticOut = q<HTMLPreElement>('overlayDiagnosticOut');
  private btnClose = q<HTMLButtonElement>('btnLunaModalClose');
  private chkAutoConnect = q<HTMLInputElement>('chkLunaAutoConnect');
  private chkAutoScroll = q<HTMLInputElement>('chkLunaAutoScroll');
  private rbLunaModeCheck = q<HTMLInputElement>('rbLunaModeCheck');
  private rbLunaModeTl = q<HTMLInputElement>('rbLunaModeTl');
  private lunaTlModeInfo = q<HTMLDivElement>('lunaTlModeInfo');
  private lunaTlModelBadge = q<HTMLSpanElement>('lunaTlModelBadge');
  private statusBadge = q<HTMLSpanElement>('lunaModalStatusBadge');
  private logText = q<HTMLSpanElement>('lunaConnectionLog');
  private overlaySection = q<HTMLDivElement>('vnOverlaySection');
  private overlayUnsupportedNote = q<HTMLParagraphElement>('vnOverlayUnsupportedNote');
  private liveBatchInput = q<HTMLInputElement>('liveBatchSizeInput');
  private liveBatchHint = q<HTMLDivElement>('liveBatchHint');
  private initialized = false;

  init(): void {
    if (this.initialized) return;
    this.initialized = true;

    // Refresh element bindings in case modal was rendered dynamically
    this.bindElements();
    this.setupListeners();
    this.syncFromConfig();

    // Subscribe to status
    lunaHooker.onStatusChange((status, message) => {
      this.updateStatusUi(status, message);
    });
  }

  private bindElements(): void {
    this.modal = q<HTMLDivElement>('lunaHookerModal');
    this.hostInput = q<HTMLInputElement>('lunaHostInput');
    this.portInput = q<HTMLInputElement>('lunaPortInput');
    this.btnConnect = q<HTMLButtonElement>('btnLunaConnect');
    this.btnDisconnect = q<HTMLButtonElement>('btnLunaDisconnect');
    this.btnToggleOverlay = q<HTMLButtonElement>('btnToggleOverlay');
    this.btnOverlayInteractive = q<HTMLButtonElement>('btnOverlayInteractive');
    this.btnOverlayDiagnose = q<HTMLButtonElement>('btnOverlayDiagnose');
    this.overlayDiagnosticOut = q<HTMLPreElement>('overlayDiagnosticOut');
    this.btnClose = q<HTMLButtonElement>('btnLunaModalClose');
    this.chkAutoConnect = q<HTMLInputElement>('chkLunaAutoConnect');
    this.chkAutoScroll = q<HTMLInputElement>('chkLunaAutoScroll');
    this.rbLunaModeCheck = q<HTMLInputElement>('rbLunaModeCheck');
    this.rbLunaModeTl = q<HTMLInputElement>('rbLunaModeTl');
    this.lunaTlModeInfo = q<HTMLDivElement>('lunaTlModeInfo');
    this.lunaTlModelBadge = q<HTMLSpanElement>('lunaTlModelBadge');
    this.statusBadge = q<HTMLSpanElement>('lunaModalStatusBadge');
    this.logText = q<HTMLSpanElement>('lunaConnectionLog');
    this.overlaySection = q<HTMLDivElement>('vnOverlaySection');
    this.overlayUnsupportedNote = q<HTMLParagraphElement>('vnOverlayUnsupportedNote');
    this.liveBatchInput = q<HTMLInputElement>('liveBatchSizeInput');
    this.liveBatchHint = q<HTMLDivElement>('liveBatchHint');
    this.applyOverlayAvailability();
    this.syncLiveBatchUi();
  }

  /**
   * Hides the whole VN Overlay block on platforms where the native command
   * cannot work, leaving the LunaTranslator hook + TL Mode fully usable.
   */
  private applyOverlayAvailability(): void {
    const supported = isOverlaySupported();
    if (this.overlaySection) this.overlaySection.style.display = supported ? '' : 'none';
    if (this.overlayUnsupportedNote) this.overlayUnsupportedNote.style.display = supported ? 'none' : '';
    if (supported) return;

    // A window restored from a desktop session could still be open server-side;
    // tear it down so it cannot linger unfocusable behind the app.
    void overlayController.closeOverlay().catch(() => {});
  }

  private setupListeners(): void {
    this.btnClose?.addEventListener('click', () => this.close());

    this.modal?.addEventListener('click', (e) => {
      if (e.target === this.modal) {
        this.close();
      }
    });

    this.btnConnect?.addEventListener('click', () => {
      this.saveCurrentInputs();
      lunaHooker.connect();
    });

    this.btnDisconnect?.addEventListener('click', () => {
      lunaHooker.disconnect();
    });

    this.liveBatchInput?.addEventListener('change', () => this.onLiveBatchChanged());
    this.liveBatchInput?.addEventListener('blur', () => this.onLiveBatchChanged());

    this.btnToggleOverlay?.addEventListener('click', async () => {
      try {
        const isOpen = await overlayController.toggleOverlay();
        if (this.btnToggleOverlay) {
          const span = this.btnToggleOverlay.querySelector('span');
          if (span) {
            span.textContent = isOpen ? 'Sembunyikan Overlay' : 'Buka Overlay';
          }
        }
        await this.refreshOverlayInteractiveUi();
      } catch (err) {
        console.error('[LunaModal] Error toggling overlay:', err);
      }
    });

    this.btnOverlayDiagnose?.addEventListener('click', async () => {
      const out = this.overlayDiagnosticOut;
      const diag = await overlayController.diagnose();
      if (!out) return;
      out.style.display = 'block';

      if (!diag) {
        out.textContent = 'Diagnosa hanya di aplikasi native Windows.';
        return;
      }
      if (!diag.window_exists) {
        out.textContent = 'Overlay belum dibuka.';
        return;
      }

      const yn = (v: boolean) => (v ? 'ya' : 'TIDAK');
      out.textContent = [
        `Terlihat   : ${yn(diag.visible)}`,
        `DWM        : ${yn(diag.dwm_composition)}`,
        `Topmost    : ${yn(diag.topmost_style)}`,
        `Layered    : ${yn(diag.layered_style)}`,
        `NoActivate : ${yn(diag.noactivate_style)}`,
        `Z-order    : ${yn(diag.raise_ok)}`,
        `Depan      : ${diag.foreground}`,
        '',
        diag.note,
      ].join('\n');
    });

    this.btnOverlayInteractive?.addEventListener('click', async () => {
      try {
        // A click-through overlay cannot receive the click that would re-enable
        // it, so this toggle lives here in the main window by necessity.
        const current = await overlayController.isInteractive();
        await overlayController.setInteractive(!current);
      } catch (err) {
        console.error('[LunaModal] Error toggling overlay interactivity:', err);
      }
      await this.refreshOverlayInteractiveUi();
    });

    this.chkAutoConnect?.addEventListener('change', () => {
      lunaHooker.saveConfig({ autoConnect: this.chkAutoConnect?.checked ?? false });
    });

    this.chkAutoScroll?.addEventListener('change', () => {
      lunaHooker.saveConfig({ autoScrollMain: this.chkAutoScroll?.checked ?? true });
    });

    this.rbLunaModeCheck?.addEventListener('change', () => {
      if (this.rbLunaModeCheck?.checked) {
        lunaHooker.saveConfig({ mode: 'check' });
        this.updateModeUi('check');
      }
    });

    this.rbLunaModeTl?.addEventListener('change', () => {
      if (this.rbLunaModeTl?.checked) {
        lunaHooker.saveConfig({ mode: 'tl' });
        this.updateModeUi('tl');
      }
    });
  }

  private syncFromConfig(): void {
    const config = lunaHooker.getConfig();
    if (this.hostInput) this.hostInput.value = config.host;
    if (this.portInput) this.portInput.value = String(config.port);
    if (this.chkAutoConnect) this.chkAutoConnect.checked = config.autoConnect;
    if (this.chkAutoScroll) this.chkAutoScroll.checked = config.autoScrollMain;
    if (config.mode === 'tl') {
      if (this.rbLunaModeTl) this.rbLunaModeTl.checked = true;
    } else {
      if (this.rbLunaModeCheck) this.rbLunaModeCheck.checked = true;
    }
    this.updateModeUi(config.mode);
  }

  /**
   * Reflects the overlay's live interaction mode on the main-window button.
   * Reads the authoritative value from Rust rather than tracking a local copy,
   * because the overlay can be closed and recreated between renders.
   */
  private async refreshOverlayInteractiveUi(): Promise<void> {
    const btn = this.btnOverlayInteractive;
    if (!btn) return;

    const span = btn.querySelector('span');
    const isOpen = await overlayController.isOverlayOpen();

    if (!isOpen) {
      btn.disabled = true;
      btn.classList.remove('btn-primary');
      btn.classList.add('btn-outline');
      if (span) span.textContent = 'Interaktif: overlay tutup';
      btn.title = 'Buka overlay dulu';
      return;
    }

    const isOn = await overlayController.isInteractive();
    btn.disabled = false;
    btn.classList.toggle('btn-primary', isOn);
    btn.classList.toggle('btn-outline', !isOn);
    if (span) span.textContent = `Interaktif: ${isOn ? 'aktif' : 'nonaktif'}`;
    btn.title = isOn
      ? 'Overlay menerima klik — matikan agar klik masuk ke game'
      : 'Klik-tembus — nyalakan untuk menggeser / tekan tombol';
  }

  private updateModeUi(mode: LunaOperatingMode): void {
    if (mode === 'tl') {
      if (this.lunaTlModeInfo) this.lunaTlModeInfo.style.display = 'block';
      updateLunaTlBadge(this.lunaTlModelBadge);
      void import('./auto-copas/ui').then(m => m.syncCopasUi());
    } else {
      if (this.lunaTlModeInfo) this.lunaTlModeInfo.style.display = 'none';
    }
  }

  /**
   * Reflects the TL look-ahead batch size: 1 is the plain single-line mode, so
   * the explanation only appears once a real batch is configured. Stored via
   * saveApiSettings so it survives a reload like every other AI preference.
   */
  private syncLiveBatchUi(): void {
    const n = state.liveBatchSize || 1;
    if (this.liveBatchInput) this.liveBatchInput.value = String(n);
    if (!this.liveBatchHint) return;
    if (n <= 1) {
      this.liveBatchHint.textContent = 'Batch 1: hanya baris aktif yang diterjemahkan.';
    } else {
      this.liveBatchHint.textContent =
        `Batch ${n}: baris aktif + ${n - 1} baris berikutnya diterjemahkan sekaligus, ` +
        'jadi dialog selanjutnya sudah siap saat hook sampai ke sana.';
    }
  }

  private onLiveBatchChanged(): void {
    const raw = Number(this.liveBatchInput?.value);
    const clamped = Number.isFinite(raw) ? Math.max(1, Math.min(20, Math.trunc(raw))) : 1;
    state.liveBatchSize = clamped;
    if (this.liveBatchInput) this.liveBatchInput.value = String(clamped);
    this.syncLiveBatchUi();
    void import('./auto-translate').then((m) => m.saveApiSettings());
  }

  private saveCurrentInputs(): void {
    const host = this.hostInput?.value.trim() || '127.0.0.1';
    const port = Number(this.portInput?.value) || 2333;
    const mode: LunaOperatingMode = this.rbLunaModeTl?.checked ? 'tl' : 'check';
    lunaHooker.saveConfig({
      host,
      port,
      autoConnect: this.chkAutoConnect?.checked ?? false,
      autoScrollMain: this.chkAutoScroll?.checked ?? true,
      mode,
    });
  }

  private updateStatusUi(status: LunaConnectionStatus, message: string): void {
    if (!this.statusBadge) return;

    if (status === 'connected') {
      this.statusBadge.textContent = 'Terhubung';
      this.statusBadge.style.backgroundColor = 'rgba(16, 185, 129, 0.2)';
      this.statusBadge.style.color = '#10b981';
      this.statusBadge.style.borderColor = 'rgba(16, 185, 129, 0.4)';
      if (this.btnConnect) this.btnConnect.disabled = true;
      if (this.btnDisconnect) this.btnDisconnect.disabled = false;
    } else if (status === 'connecting') {
      this.statusBadge.textContent = 'Menghubungkan...';
      this.statusBadge.style.backgroundColor = 'rgba(245, 158, 11, 0.2)';
      this.statusBadge.style.color = '#f59e0b';
      this.statusBadge.style.borderColor = 'rgba(245, 158, 11, 0.4)';
      if (this.btnConnect) this.btnConnect.disabled = true;
      if (this.btnDisconnect) this.btnDisconnect.disabled = false;
    } else {
      this.statusBadge.textContent = status === 'error' ? 'Error' : 'Terputus';
      this.statusBadge.style.backgroundColor = 'rgba(239, 68, 68, 0.15)';
      this.statusBadge.style.color = '#ef4444';
      this.statusBadge.style.borderColor = 'rgba(239, 68, 68, 0.3)';
      if (this.btnConnect) this.btnConnect.disabled = false;
      if (this.btnDisconnect) this.btnDisconnect.disabled = true;
    }

    if (this.logText) {
      this.logText.textContent = message || '';
    }
  }

  async open(): Promise<void> {
    this.bindElements();
    this.syncFromConfig();
    const cur = lunaHooker.getStatus();
    this.updateStatusUi(cur.status, cur.message);
    if (isOverlaySupported()) {
      try {
        const isOpen = await overlayController.isOverlayOpen();
        if (this.btnToggleOverlay) {
          const span = this.btnToggleOverlay.querySelector('span');
          if (span) {
            span.textContent = isOpen ? 'Sembunyikan Overlay' : 'Buka / Toggle Overlay';
          }
        }
      } catch {}

      await this.refreshOverlayInteractiveUi();
    }
    if (this.modal) {
      openModal(this.modal);
    }
  }

  close(): void {
    if (this.modal) {
      closeModal(this.modal);
    }
  }
}

export const lunaModal = new LunaModalController();
