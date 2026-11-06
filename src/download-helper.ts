// @module download-helper.ts: cross-platform file saving for desktop and Android WebView.
import { flashHint } from './render';
import { isAndroidNativeApp } from './android-files';
import { isDesktopTauriApp, isSaveAskEveryTime, saveBase64ToNativeFolder, saveBase64WithSaveAs } from './native-save-folder';

/**
 * Universal file saver: native save folder (Tauri desktop and Android, persisted
 * like Backup ke Folder in the browser), Android WebView (Download folder / Share
 * Sheet), then anchor download.
 */
export async function saveOrDownloadBlob(blob: Blob, filename: string): Promise<boolean> {
  const androidBridge = (window as any).AndroidBridge || (window as any).AndroidAiOverlay;
  const onAndroid = isAndroidNativeApp();
  const onDesktopTauri = isDesktopTauriApp();

  // Native apps: Save As per file when "Selalu tanya lokasi simpan" is on,
  // otherwise the persisted save folder (picked once).
  let base64: string | null = null;
  if (onAndroid || onDesktopTauri) {
    base64 = await blobToBase64(blob);
    const askEveryTime = isSaveAskEveryTime();
    const outcome = askEveryTime
      ? await saveBase64WithSaveAs(filename, base64, blob.type || '')
      : await saveBase64ToNativeFolder(filename, base64);
    if (outcome === 'saved') {
      flashHint(`Tersimpan: ${filename}`);
      return true;
    }
    if (outcome === 'cancelled' && (onDesktopTauri || askEveryTime)) {
      // User menutup dialog Save As / folder picker: jangan diam-diam menyimpan
      // ke lokasi lain yang tidak mereka pilih.
      flashHint('Penyimpanan dibatalkan.');
      return false;
    }
    // Android folder mode 'cancelled' falls through to the old behavior below
    // (Download folder / share sheet); 'failed' falls back on any platform.
  }

  // Android with native bridge: write directly to the Downloads folder.
  if (androidBridge && typeof androidBridge.saveFileToDownloads === 'function') {
    try {
      base64 = base64 ?? await blobToBase64(blob);
      const res = androidBridge.saveFileToDownloads(filename, base64);
      if (res === 'ok') {
        flashHint(`Disimpan ke folder Download: ${filename}`);
        return true;
      }
      console.warn('[download-helper] saveFileToDownloads returned:', res);
      // MediaStore failed; try the native Share Sheet.
      if (typeof androidBridge.shareFile === 'function') {
        const shareRes = androidBridge.shareFile(filename, base64, blob.type || 'application/octet-stream');
        if (shareRes === 'ok') return true;
      }
    } catch (err) {
      console.warn('[download-helper] Native Android download failed, trying web fallback:', err);
    }
  }

  // Web Share API (mobile browsers / PWAs).
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

  // Anchor download fallback.
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
