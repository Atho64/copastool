// @module epub-ruby.ts — EPUB ruby annotation extractor for glossary name collection

import { state, ui } from './state';
import { addNameGlossaryEntry, mergeGlossaryEntries, hasKanji, isLikelyRubyNameCandidate, parseGlossaryToMap, serializeGlossaryMap } from './glossary';
import { normalizeKana, kanaToRomaji } from './string-utils';
import { flashHint, updateButtonStates } from './render';
import { getOpfsRoot } from './state';
import { queueAutoSave } from './project';

export function getRubyBaseText(rubyEl: HTMLElement): string {
  const clone = rubyEl.cloneNode(true) as HTMLElement;
  clone.querySelectorAll('rt, rp, rtc').forEach(el => el.remove());
  return (clone.textContent || '').replace(/\s+/g, '').trim();
}

export function collectKnownNameKeys(): Set<string> {
  const keys = new Set<string>();
  for (const line of state.lines) {
    if (line.name) keys.add(line.name.replace(/\s+/g, '').trim());
    if (line.trans_name) keys.add(line.trans_name.replace(/\s+/g, '').trim());
  }
  for (const [source, entry] of parseGlossaryToMap(state.glossaryText).entries()) {
    keys.add(source.replace(/\s+/g, '').trim());
    keys.add(entry.target.replace(/\s+/g, '').trim());
  }
  return keys;
}

export function collectRubyGlossaryEntriesFromHtml(html: string, href: string, knownNameKeys: Set<string>): { autoEntries: Map<string, any>; candidateEntries: Map<string, any> } {
  const doc = new DOMParser().parseFromString(html, href.endsWith('.xhtml') ? 'application/xhtml+xml' : 'text/html');
  const autoEntries = new Map<string, any>();
  const candidateEntries = new Map<string, any>();
  for (const ruby of Array.from(doc.querySelectorAll('ruby'))) {
    const base = getRubyBaseText(ruby);
    const reading = Array.from(ruby.querySelectorAll('rt')).map(rt => rt.textContent?.trim() || '').join('');
    const normalizedReading = normalizeKana(reading);
    if (!base || !normalizedReading || base === normalizedReading) continue;
    if (!isLikelyRubyNameCandidate(base, normalizedReading)) continue;
    const romaji = kanaToRomaji(normalizedReading);
    if (!romaji || romaji === normalizedReading) continue;
    const targetMap = knownNameKeys.has(base.replace(/\s+/g, '').trim()) || knownNameKeys.has(romaji.replace(/\s+/g, '').trim())
      ? autoEntries
      : candidateEntries;
    addNameGlossaryEntry(targetMap, base, romaji);
  }
  return { autoEntries, candidateEntries };
}

export async function onExtractEpubRubyNames(): Promise<void> {
  if (state.projectType !== 'epub' || !state.epubSourceId) {
    (ui.epubRubyStatus as HTMLElement).textContent = 'Fitur ini hanya tersedia untuk proyek EPUB.';
    return;
  }

  (ui.btnExtractEpubRubyNames as HTMLButtonElement).disabled = true;
  (ui.epubRubyStatus as HTMLElement).textContent = 'Membaca ruby text dari EPUB...';
  try {
    const root = await getOpfsRoot();
    const fh = await (root as any).getFileHandle(state.epubSourceId);
    const f = await fh.getFile();
    const zip = await (window as any).JSZip.loadAsync(f);
    const files = state.importedFiles.length
      ? state.importedFiles
      : Object.keys(zip.files).filter(name => /\.(xhtml|html?)$/i.test(name));
    const knownNameKeys = collectKnownNameKeys();
    const entries = new Map<string, any>();
    const candidates = new Map<string, any>();
    for (const href of files) {
      const zf = zip.file(href);
      if (!zf) continue;
      const html = await zf.async('text');
      const extracted = collectRubyGlossaryEntriesFromHtml(html, href, knownNameKeys);
      for (const [source, target] of extracted.autoEntries.entries()) {
        if (!entries.has(source)) entries.set(source, target);
      }
      for (const [source, target] of extracted.candidateEntries.entries()) {
        if (!candidates.has(source)) candidates.set(source, target);
      }
      await new Promise(r => setTimeout(r, 0));
    }
    if (!entries.size && !candidates.size) {
      (ui.epubRubyStatus as HTMLElement).textContent = 'Tidak ada kandidat ruby name yang ditemukan.';
      return;
    }
    let status = '';
    if (entries.size) {
      const { added, updated } = mergeGlossaryEntries(entries);
      status = `${added} entri cocok otomatis, ${updated} diperbarui.`;
    } else {
      status = '0 entri cocok otomatis.';
    }
    if (candidates.size) {
      (ui.pasteGlossaryArea as HTMLTextAreaElement).value = serializeGlossaryMap(candidates);
      status += ` ${candidates.size} kandidat lain dikirim ke kotak review.`;
    }
    (ui.epubRubyStatus as HTMLElement).textContent = status;
  } catch (err: any) {
    (ui.epubRubyStatus as HTMLElement).textContent = `Gagal extract ruby EPUB: ${err.message}`;
  } finally {
    updateButtonStates();
  }
}
