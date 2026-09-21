// @module epub-images.ts — EPUB image extractor, caching, and lightbox preview
import { state, getOpfsRoot } from './state';
import type { Line } from './types';

// Map of image zip path (or normalized filename) -> blob URL
const epubImageCache = new Map<string, string>();
// Map of file (e.g. OEBPS/text/chap01.xhtml) -> list of image zip paths in that file
const fileToImagesMap = new Map<string, string[]>();

// Shared in-flight preload so concurrent callers await the same completion
// (an early `return` while loading would resolve before the cache is filled).
let inFlightPreload: Promise<void> | null = null;
// Bumped on clear; a preload finishing for a stale generation drops what it added.
let cacheGeneration = 0;

function tryDecodePath(p: string): string {
  try { return decodeURIComponent(p); } catch (_) { return p; }
}

export function clearEpubImageCache(): void {
  cacheGeneration++;
  inFlightPreload = null;
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
  // Bookkeeping so a stale run (project closed/switched mid-load) can undo itself.
  const createdUrls: string[] = [];
  const addedKeys: string[] = [];
  const mappedFiles: string[] = [];

  try {
    const root = await getOpfsRoot();
    const fh = await (root as any).getFileHandle(sourceId);
    const file = await fh.getFile();
    const zip = await (window as any).JSZip.loadAsync(file);

    // Extract all image files in zip (in parallel)
    const imageExtensions = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.svg', '.bmp', '.avif'];
    const imageFiles: string[] = [];

    zip.forEach((relativePath: string, zipEntry: any) => {
      if (!zipEntry.dir) {
        const lower = relativePath.toLowerCase();
        if (imageExtensions.some(ext => lower.endsWith(ext))) {
          imageFiles.push(relativePath);
        }
      }
    });

    const cacheImage = (key: string, blobUrl: string) => {
      if (!key || epubImageCache.has(key)) return;
      epubImageCache.set(key, blobUrl);
      addedKeys.push(key);
    };

    await Promise.all(imageFiles.map(async (imgPath) => {
      if (epubImageCache.has(imgPath)) return;
      try {
        const zipEntry = zip.file(imgPath);
        if (!zipEntry) return;
        const blob = await zipEntry.async('blob');
        const blobUrl = URL.createObjectURL(blob);
        createdUrls.push(blobUrl);
        cacheImage(imgPath, blobUrl);
        const fileName = imgPath.includes('/') ? imgPath.substring(imgPath.lastIndexOf('/') + 1) : imgPath;
        cacheImage(fileName, blobUrl);
        // XHTML hrefs are often percent-encoded while zip entries are not (or vice versa)
        cacheImage(tryDecodePath(imgPath), blobUrl);
        cacheImage(tryDecodePath(fileName), blobUrl);
      } catch (e) {
        console.warn('[CSTL] Error loading EPUB image:', imgPath, e);
      }
    }));

    // Scan XHTML spine files to map chapters to images
    const htmlExtensions = ['.xhtml', '.html', '.htm', '.xml'];
    const htmlPaths = Object.keys(zip.files).filter((relativePath) => {
      const lower = relativePath.toLowerCase();
      return htmlExtensions.some(ext => lower.endsWith(ext));
    });

    await Promise.all(htmlPaths.map(async (relativePath) => {
      try {
        const entry = zip.file(relativePath);
        if (!entry) return;
        const text = await entry.async('text');
        const doc = new DOMParser().parseFromString(text, relativePath.toLowerCase().endsWith('.xhtml') ? 'application/xhtml+xml' : 'text/html');
        const imgEls = Array.from(doc.querySelectorAll('img, image'));
        const found: string[] = [];
        for (const imgEl of imgEls) {
          const src = imgEl.getAttribute('src') || imgEl.getAttribute('href') || imgEl.getAttribute('xlink:href') || '';
          if (src) {
            const resolved = resolveZipPath(relativePath, src);
            if (resolved) found.push(resolved);
          }
        }
        if (found.length > 0) {
          fileToImagesMap.set(relativePath, found);
          mappedFiles.push(relativePath);
        }
      } catch (_) {}
    }));
  } catch (err) {
    console.error('[CSTL] Failed to preload EPUB images:', err);
  } finally {
    if (gen !== cacheGeneration || state.epubSourceId !== sourceId) {
      // Project was closed/switched while loading — drop everything this run added.
      for (const k of addedKeys) epubImageCache.delete(k);
      for (const f of mappedFiles) fileToImagesMap.delete(f);
      for (const u of createdUrls) {
        try { URL.revokeObjectURL(u); } catch (_) {}
      }
    }
  }
}

export function preloadEpubImages(): Promise<void> {
  if (state.projectType !== 'epub' || !state.epubSourceId || state.showEpubImages === false) {
    return Promise.resolve();
  }
  if (inFlightPreload) return inFlightPreload;
  const p = runPreload().finally(() => {
    // Only clear our own slot — an older run must not unset a newer preload.
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
    const decodedName = tryDecodePath(fileName);
    if (decodedName !== fileName) {
      return epubImageCache.get(decodedName) || null;
    }
  }
  return null;
}

export function getEpubImagesForFile(filePath: string): string[] {
  return fileToImagesMap.get(filePath) || [];
}

export function openImageLightbox(src: string): void {
  const modal = document.getElementById('imageLightboxModal');
  const img = document.getElementById('imageLightboxImg') as HTMLImageElement | null;
  if (!modal || !img || !src) return;
  img.src = src;
  modal.classList.add('open');
}

export function closeImageLightbox(): void {
  const modal = document.getElementById('imageLightboxModal');
  if (modal) modal.classList.remove('open');
}
