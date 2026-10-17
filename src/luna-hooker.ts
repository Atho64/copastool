// @module luna-hooker.ts — LunaTranslator WebSocket client & connection manager
// Connects to LunaTranslator local network service (default ws://127.0.0.1:2333/api/ws/text/origin)
// to receive live hooked dialogue lines during VN playtesting.

export type LunaConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error';
export type LunaOperatingMode = 'check' | 'tl';

export interface LunaHookerConfig {
  host: string;
  port: number;
  autoConnect: boolean;
  autoScrollMain: boolean;
  mode: LunaOperatingMode;
}

const STORAGE_KEY = 'cstl_luna_hooker_config';

export const DEFAULT_LUNA_CONFIG: LunaHookerConfig = {
  host: '127.0.0.1',
  port: 2333,
  autoConnect: false,
  autoScrollMain: true,
  mode: 'check',
};

class LunaHookerService {
  private socket: WebSocket | null = null;
  private config: LunaHookerConfig = { ...DEFAULT_LUNA_CONFIG };
  private status: LunaConnectionStatus = 'disconnected';
  private statusMessage = '';
  private reconnectTimer: number | null = null;
  private manualDisconnect = false;
  private statusListeners: Array<(status: LunaConnectionStatus, message: string) => void> = [];
  private textListeners: Array<(text: string) => void> = [];
  private modeListeners: Array<(mode: LunaOperatingMode) => void> = [];

  constructor() {
    this.loadConfig();
  }

  loadConfig(): LunaHookerConfig {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        this.config = {
          host: typeof parsed.host === 'string' && parsed.host ? parsed.host : DEFAULT_LUNA_CONFIG.host,
          port: typeof parsed.port === 'number' && parsed.port > 0 ? parsed.port : DEFAULT_LUNA_CONFIG.port,
          autoConnect: Boolean(parsed.autoConnect),
          autoScrollMain: parsed.autoScrollMain !== undefined ? Boolean(parsed.autoScrollMain) : true,
          mode: parsed.mode === 'tl' ? 'tl' : 'check',
        };
      }
    } catch {
      this.config = { ...DEFAULT_LUNA_CONFIG };
    }
    return { ...this.config };
  }

  saveConfig(newConfig: Partial<LunaHookerConfig>): void {
    const prevMode = this.config.mode;
    this.config = { ...this.config, ...newConfig };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.config));
    } catch {
      // Storage unavailable or quota exceeded
    }
    if (newConfig.mode && newConfig.mode !== prevMode) {
      for (const listener of this.modeListeners) {
        try {
          listener(this.config.mode);
        } catch (err) {
          console.error('[LunaHooker] Mode listener error:', err);
        }
      }
    }
  }

  onModeChange(fn: (mode: LunaOperatingMode) => void): () => void {
    this.modeListeners.push(fn);
    fn(this.config.mode);
    return () => {
      this.modeListeners = this.modeListeners.filter((l) => l !== fn);
    };
  }

  getConfig(): LunaHookerConfig {
    return { ...this.config };
  }

  getStatus(): { status: LunaConnectionStatus; message: string } {
    return { status: this.status, message: this.statusMessage };
  }

  onStatusChange(fn: (status: LunaConnectionStatus, message: string) => void): () => void {
    this.statusListeners.push(fn);
    fn(this.status, this.statusMessage);
    return () => {
      this.statusListeners = this.statusListeners.filter((l) => l !== fn);
    };
  }

  onText(fn: (text: string) => void): () => void {
    this.textListeners.push(fn);
    return () => {
      this.textListeners = this.textListeners.filter((l) => l !== fn);
    };
  }

  private setStatus(status: LunaConnectionStatus, message = ''): void {
    this.status = status;
    this.statusMessage = message;
    for (const listener of this.statusListeners) {
      try {
        listener(status, message);
      } catch (err) {
        console.error('[LunaHooker] Listener error:', err);
      }
    }
  }

  connect(): void {
    if (this.socket && (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)) {
      return;
    }

    this.manualDisconnect = false;
    this.clearReconnect();

    const url = `ws://${this.config.host}:${this.config.port}/api/ws/text/origin`;
    this.setStatus('connecting', `Menghubungkan ke ${url}...`);

    try {
      this.socket = new WebSocket(url);
    } catch (err: any) {
      this.setStatus('error', `Gagal inisialisasi WebSocket: ${err?.message || err}`);
      this.scheduleReconnect();
      return;
    }

    this.socket.onopen = () => {
      this.setStatus('connected', `Terhubung ke LunaTranslator (${this.config.host}:${this.config.port})`);
      this.clearReconnect();
    };

    this.socket.onmessage = (event) => {
      if (typeof event.data !== 'string') return;
      const raw = event.data.trim();
      if (!raw) return;

      let extractedText = raw;
      try {
        const parsed = JSON.parse(raw);
        if (typeof parsed === 'string') {
          extractedText = parsed;
        } else if (parsed && typeof parsed.text === 'string') {
          extractedText = parsed.text;
        } else if (parsed && typeof parsed.origin === 'string') {
          extractedText = parsed.origin;
        } else if (parsed && typeof parsed.data === 'string') {
          extractedText = parsed.data;
        }
      } catch {
        // Plain text stream, keep raw
      }

      const cleaned = extractedText.trim();
      if (cleaned) {
        for (const listener of this.textListeners) {
          try {
            listener(cleaned);
          } catch (err) {
            console.error('[LunaHooker] Text dispatch error:', err);
          }
        }
      }
    };

    this.socket.onerror = () => {
      this.setStatus('error', `Gagal terhubung ke ws://${this.config.host}:${this.config.port}`);
    };

    this.socket.onclose = () => {
      this.socket = null;
      if (!this.manualDisconnect) {
        this.setStatus('disconnected', 'Terputus dari LunaTranslator. Menjadwalkan koneksi ulang...');
        this.scheduleReconnect();
      } else {
        this.setStatus('disconnected', 'Koneksi ditutup secara manual.');
      }
    };
  }

  disconnect(): void {
    this.manualDisconnect = true;
    this.clearReconnect();
    if (this.socket) {
      try {
        this.socket.close();
      } catch {}
      this.socket = null;
    }
    this.setStatus('disconnected', 'Koneksi dinonaktifkan.');
  }

  toggle(): void {
    if (this.status === 'connected' || this.status === 'connecting') {
      this.disconnect();
    } else {
      this.connect();
    }
  }

  private scheduleReconnect(): void {
    if (this.manualDisconnect || this.reconnectTimer !== null) return;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.manualDisconnect && this.status !== 'connected') {
        this.connect();
      }
    }, 4000);
  }

  private clearReconnect(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}

export const lunaHooker = new LunaHookerService();
