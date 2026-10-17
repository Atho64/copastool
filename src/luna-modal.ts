// @module luna-modal.ts — Modal manager for LunaTranslator & VN Overlay settings

import { lunaHooker, type LunaConnectionStatus, type LunaOperatingMode } from './luna-hooker';
import { overlayController } from './overlay-controller';
import { openModal, closeModal } from './project';
import { state } from './state';

const q = <T extends HTMLElement>(id: string) => document.getElementById(id) as T | null;

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
      if (this.lunaTlModelBadge) {
        const modelName = state.aiModel || state.aiApiType || 'API';
        if (state.aiApiKey) {
          this.lunaTlModelBadge.textContent = `Model: ${modelName}`;
          this.lunaTlModelBadge.classList.remove('is-error');
          this.lunaTlModelBadge.title = `${modelName} — dipakai untuk menerjemahkan dialog mentah`;
        } else {
          this.lunaTlModelBadge.textContent = 'API Key Belum Diisi!';
          this.lunaTlModelBadge.classList.add('is-error');
          this.lunaTlModelBadge.title = 'Isi API Key di Setting → API Global untuk memakai TL Mode';
        }
      }
    } else {
      if (this.lunaTlModeInfo) this.lunaTlModeInfo.style.display = 'none';
    }
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
