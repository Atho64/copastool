// @module download-helper.ts — Cross-platform file saving for Desktop & Android WebView
import { flashHint } from './render';

/**
 * Universal file saver: handles Android WebView (saving to Download folder or native Share Sheet)
 * and Desktop/Browser (anchor tag download).
 */
export async function saveOrDownloadBlob(blob: Blob, filename: string): Promise<boolean> {
  const androidOverlay = (window as any).AndroidAiOverlay;

  // 1. Android Tauri with native bridge: write directly to Downloads folder
  if (androidOverlay && typeof androidOverlay.saveFileToDownloads === 'function') {
    try {
      const base64 = await blobToBase64(blob);
      const res = androidOverlay.saveFileToDownloads(filename, base64);
      if (res === 'ok') {
        flashHint(`Berhasil disimpan ke folder Download: ${filename}`);
        return true;
      }
      console.warn('[download-helper] saveFileToDownloads returned:', res);
      // Fallback to native Android Share Sheet if MediaStore saving had an issue
      if (typeof androidOverlay.shareFile === 'function') {
        const shareRes = androidOverlay.shareFile(filename, base64, blob.type || 'application/octet-stream');
        if (shareRes === 'ok') return true;
      }
    } catch (err) {
      console.warn('[download-helper] Native Android download failed, trying web fallback:', err);
    }
  }

  // 2. Web Share API (for mobile browsers / PWAs)
  if (navigator.canShare && typeof File !== 'undefined') {
    try {
      const file = new File([blob], filename, { type: blob.type || 'application/octet-stream' });
      if (navigator.canShare({ files: [file] })) {
        await navigator.share({
          files: [file],
          title: filename,
        });
        flashHint(`File siap: ${filename}`);
        return true;
      }
    } catch (shareErr: any) {
      if (shareErr.name === 'AbortError') return true; // user closed share sheet
      console.warn('[download-helper] navigator.share error:', shareErr);
    }
  }

  // 3. Desktop / Standard Browser anchor download fallback
  try {
    const href = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = href;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(href), 2000);
    flashHint(`Download dimulai: ${filename}`);
    return true;
  } catch (e: any) {
    console.error('[download-helper] Anchor download failed:', e);
    alert('Gagal mendownload file: ' + (e.message || String(e)));
    return false;
  }
}

export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const res = reader.result as string;
      const commaIdx = res.indexOf(',');
      resolve(commaIdx >= 0 ? res.slice(commaIdx + 1) : res);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}
