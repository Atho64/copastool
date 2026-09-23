// @module epub-images.ts — EPUB image extractor, caching, and lightbox preview
import { state, getOpfsRoot } from './state';
import type { Line } from './types';

// Map of image zip path (or normalized filename) -> blob URL
const epubImageCache = new Map<string, string>();
// Map of file (e.g. OEBPS/text/chap01.xhtml) -> list of image zip paths in that file
const fileToImagesMap = new Map<string, string[]>();

// Shared in-flight preload so concurrent callers await the same completion
let inFlightPreload: Promise<void> | null = null;
// Bumped on clear; a preload finishing for a stale generation drops what it added.
let cacheGeneration = 0;

function tryDecodePath(p: string): string {
  try { return decodeURIComponent(p); } catch (_) { return p; }
}

// Cached JSZip instance and O(1) file index for the currently active EPUB project session
let activeZip: any = null;
let activeZipSourceId: string | null = null;
let activeZipPromise: Promise<any> | null = null;
let activeZipFileIndex: Map<string, string> | null = null;

export async function getActiveEpubZip(): Promise<any> {
  const sourceId = state.epubSourceId;
  if (!sourceId) return null;
  if (activeZip && activeZipSourceId === sourceId) return activeZip;
  if (activeZipPromise && activeZipSourceId === sourceId) return activeZipPromise;

  activeZipSourceId = sourceId;
  activeZipPromise = (async () => {
    try {
      const root = await getOpfsRoot();
      const fh = await (root as any).getFileHandle(sourceId);
      const file = await fh.getFile();
      const zip = await (window as any).JSZip.loadAsync(file);
      activeZip = zip;

      // Build O(1) filename lookup index
      const index = new Map<string, string>();
      zip.forEach((relPath: string, entry: any) => {
        if (!entry.dir) {
          const fn = relPath.includes('/') ? relPath.substring(relPath.lastIndexOf('/') + 1) : relPath;
          index.set(fn, relPath);
          index.set(tryDecodePath(fn), relPath);
        }
      });
      activeZipFileIndex = index;
      return zip;
    } finally {
      activeZipPromise = null;
    }
  })();
  return activeZipPromise;
}

export function clearEpubImageCache(): void {
  cacheGeneration++;
  inFlightPreload = null;
  activeZip = null;
  activeZipSourceId = null;
  activeZipPromise = null;
  activeZipFileIndex = null;
  for (const url of epubImageCache.values()) {
    try {
      URL.revokeObjectURL(url);
    } catch (_) {}
  }
  epubImageCache.clear();
  fileToImagesMap.clear();
}

export function resolveZipPath(baseFile: string, relPath: string): string {
  if (!relPath) return '';
  let p = relPath.split('#')[0].split('?')[0];
  if (p.startsWith('/')) p = p.substring(1);
  const baseDir = baseFile.includes('/') ? baseFile.substring(0, baseFile.lastIndexOf('/') + 1) : '';
  const raw = baseDir + p;
  const parts = raw.split('/');
  const stack: string[] = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (stack.length > 0) stack.pop();
    } else {
      stack.push(part);
    }
  }
  return stack.join('/');
}

async function runPreload(): Promise<void> {
  const gen = cacheGeneration;
  const sourceId = state.epubSourceId!;
  const createdUrls: string[] = [];
  const addedKeys: string[] = [];
  const mappedFiles: string[] = [];

  try {
    const zip = await getActiveEpubZip();
    if (!zip) return;

    // 1. Populate the file map from inline text images and standalone image
    // assets. Image-only paragraphs are kept out of the translation line list.
    let hasLineImg = false;
    for (const l of state.lines) {
      if (l.epub_img_src && l.file) {
        hasLineImg = true;
        let arr = fileToImagesMap.get(l.file);
        if (!arr) {
          arr = [];
          fileToImagesMap.set(l.file, arr);
          mappedFiles.push(l.file);
        }
        if (!arr.includes(l.epub_img_src)) arr.push(l.epub_img_src);
      }
    }
    for (const image of state.epubImages) {
      hasLineImg = true;
      let arr = fileToImagesMap.get(image.file);
      if (!arr) {
        arr = [];
        fileToImagesMap.set(image.file, arr);
        mappedFiles.push(image.file);
      }
      if (!arr.includes(image.src)) arr.push(image.src);
    }

    // 2. Collect only images referenced by this project
    const referencedImages: string[] = [];
    for (const l of state.lines) {
      if (l.epub_img_src && !referencedImages.includes(l.epub_img_src)) {
        referencedImages.push(l.epub_img_src);
      }
    }
    for (const image of state.epubImages) {
      if (image.src && !referencedImages.includes(image.src)) referencedImages.push(image.src);
    }

    // Preload referenced images smoothly in background
    for (const imgPath of referencedImages) {
      if (gen !== cacheGeneration || state.epubSourceId !== sourceId) break;
      if (epubImageCache.has(imgPath)) continue;
      const url = await loadEpubImage(imgPath);
      if (url) {
        createdUrls.push(url);
        addedKeys.push(imgPath);
      }
      await new Promise(r => setTimeout(r, 0));
    }

    // Fallback: If project had no inline epub_img_src, scan html files with regex
    if (!hasLineImg) {
      const htmlExtensions = ['.xhtml', '.html', '.htm', '.xml'];
      const htmlPaths = Object.keys(zip.files).filter((relativePath) => {
        const lower = relativePath.toLowerCase();
        return htmlExtensions.some(ext => lower.endsWith(ext));
      });

      const IMG_TAG_RE = /<(?:img|image)\b[^>]*?(?:src|href|xlink:href)=["']([^"']+)["'][^>]*>/gi;

      for (const relativePath of htmlPaths) {
        if (gen !== cacheGeneration || state.epubSourceId !== sourceId) break;
        try {
          const entry = zip.file(relativePath);
          if (!entry) continue;
          const text = await entry.async('text');
          const found: string[] = [];
          let m: RegExpExecArray | null;
          IMG_TAG_RE.lastIndex = 0;
          while ((m = IMG_TAG_RE.exec(text)) !== null) {
            const raw = m[1];
            if (raw) {
              const resolved = resolveZipPath(relativePath, raw);
              if (resolved) found.push(resolved);
            }
          }
          if (found.length > 0) {
            fileToImagesMap.set(relativePath, found);
            mappedFiles.push(relativePath);
          }
        } catch (_) {}
        await new Promise(r => setTimeout(r, 0));
      }
    }
  } catch (err) {
    console.error('[CSTL] Failed to preload EPUB images:', err);
  } finally {
    if (gen !== cacheGeneration || state.epubSourceId !== sourceId) {
      for (const k of addedKeys) epubImageCache.delete(k);
      for (const f of mappedFiles) fileToImagesMap.delete(f);
      for (const u of createdUrls) {
        try { URL.revokeObjectURL(u); } catch (_) {}
      }
    }
  }
}

export async function loadEpubImage(targetSrc: string): Promise<string | null> {
  if (!targetSrc) return null;
  const existing = getEpubImageBlobUrl(targetSrc);
  if (existing) return existing;

  if (!state.epubSourceId) return null;
  try {
    const zip = await getActiveEpubZip();
    if (!zip) return null;

    let zipEntry = zip.file(targetSrc);
    if (!zipEntry) zipEntry = zip.file(tryDecodePath(targetSrc));
    if (!zipEntry && activeZipFileIndex) {
      const fileName = targetSrc.includes('/') ? targetSrc.substring(targetSrc.lastIndexOf('/') + 1) : targetSrc;
      const indexedPath = activeZipFileIndex.get(fileName) || activeZipFileIndex.get(tryDecodePath(fileName));
      if (indexedPath) zipEntry = zip.file(indexedPath);
    }

    if (zipEntry) {
      const blob = await zipEntry.async('blob');
      const blobUrl = URL.createObjectURL(blob);
      epubImageCache.set(targetSrc, blobUrl);
      const fileName = targetSrc.includes('/') ? targetSrc.substring(targetSrc.lastIndexOf('/') + 1) : targetSrc;
      epubImageCache.set(fileName, blobUrl);
      epubImageCache.set(tryDecodePath(targetSrc), blobUrl);
      epubImageCache.set(tryDecodePath(fileName), blobUrl);
      return blobUrl;
    }
  } catch (err) {
    console.warn('[CSTL] Lazy load EPUB image failed:', targetSrc, err);
  }
  return null;
}

export function preloadEpubImages(): Promise<void> {
  if (state.projectType !== 'epub' || !state.epubSourceId || state.showEpubImages === false) {
    return Promise.resolve();
  }
  if (inFlightPreload) return inFlightPreload;
  const p = runPreload().finally(() => {
    if (inFlightPreload === p) inFlightPreload = null;
  });
  inFlightPreload = p;
  return p;
}

export function getEpubImageBlobUrl(pathOrFilename: string): string | null {
  if (!pathOrFilename) return null;
  const direct = epubImageCache.get(pathOrFilename);
  if (direct) return direct;
  const fileName = pathOrFilename.includes('/') ? pathOrFilename.substring(pathOrFilename.lastIndexOf('/') + 1) : pathOrFilename;
  const byName = epubImageCache.get(fileName);
  if (byName) return byName;
  const decoded = tryDecodePath(pathOrFilename);
  if (decoded !== pathOrFilename) {
    const byDecoded = epubImageCache.get(decoded);
    if (byDecoded) return byDecoded;
  }
  return null;
}

export function getEpubImagesForFile(file: string): string[] {
  return fileToImagesMap.get(file) || [];
}

export function openImageLightbox(blobUrl: string): void {
  let modal = document.getElementById('epubImageLightboxModal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'epubImageLightboxModal';
    modal.className = 'modal-backdrop';
    modal.style.zIndex = '3000';
    modal.innerHTML = `
      <div class="epub-lightbox-dialog" style="position: relative; max-width: 95vw; max-height: 95vh; display: flex; flex-direction: column; align-items: center; justify-content: center; background: rgba(0,0,0,0.85); border-radius: var(--radius-lg); padding: 12px; box-shadow: var(--shadow-xl);">
        <button type="button" class="btn btn-icon btn-secondary epub-lightbox-close" style="position: absolute; top: -14px; right: -14px; width: 34px; height: 34px; border-radius: 50%; padding: 0; display: flex; align-items: center; justify-content: center; z-index: 10;" title="Tutup">
          <svg class="lucide-icon" xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
        </button>
        <img class="epub-lightbox-img" style="max-width: 90vw; max-height: 85vh; object-fit: contain; border-radius: var(--radius); user-select: none;" alt="Preview" />
      </div>
    `;
    document.body.appendChild(modal);

    modal.addEventListener('click', (e) => {
      if (e.target === modal || (e.target as HTMLElement).closest('.epub-lightbox-close')) {
        modal!.classList.remove('open');
      }
    });

    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && modal!.classList.contains('open')) {
        modal!.classList.remove('open');
      }
    });
  }

  const img = modal.querySelector('.epub-lightbox-img') as HTMLImageElement;
  if (img) img.src = blobUrl;
  modal.classList.add('open');
}
