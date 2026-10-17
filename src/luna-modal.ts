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
            span.textContent = isOpen ? 'Sembunyikan VN Overlay' : 'Buka VN Overlay';
          }
        }
      } catch (err) {
        console.error('[LunaModal] Error toggling overlay:', err);
      }
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

  private updateModeUi(mode: LunaOperatingMode): void {
    if (mode === 'tl') {
      if (this.lunaTlModeInfo) this.lunaTlModeInfo.style.display = 'block';
      if (this.lunaTlModelBadge) {
        const modelName = state.aiModel || state.aiApiType || 'API';
        if (state.aiApiKey) {
          this.lunaTlModelBadge.textContent = `Model: ${modelName}`;
          this.lunaTlModelBadge.style.color = '#38bdf8';
        } else {
          this.lunaTlModelBadge.textContent = 'API Key Belum Diisi!';
          this.lunaTlModelBadge.style.color = '#ef4444';
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
          span.textContent = isOpen ? 'Sembunyikan VN Overlay' : 'Buka / Toggle VN Overlay';
        }
      }
    } catch {}
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
