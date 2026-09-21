// @module native-clipboard.ts — Focus-Independent Native & Web Clipboard API
// Uses @tauri-apps/plugin-clipboard-manager when running in Tauri to bypass
// browser-level "Document is not focused" restrictions, allowing background Auto Copas.

import { isTauri } from './native-storage';

export async function readClipboardText(): Promise<string> {
  if (isTauri()) {
    try {
      const { readText } = await import('@tauri-apps/plugin-clipboard-manager');
      const txt = await readText();
      if (typeof txt === 'string') return txt;
    } catch (e) {
      console.warn('[Clipboard] Native readText error, falling back to web clipboard:', e);
    }
  }

  try {
    return (await navigator.clipboard.readText()) || '';
  } catch (e) {
    return '';
  }
}

export async function writeClipboardText(text: string): Promise<boolean> {
  if (isTauri()) {
    try {
      const { writeText } = await import('@tauri-apps/plugin-clipboard-manager');
      await writeText(text);
      return true;
    } catch (e) {
      console.warn('[Clipboard] Native writeText error, falling back to web clipboard:', e);
    }
  }

  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (e) {
    return false;
  }
}
