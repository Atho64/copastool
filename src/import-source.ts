// @module import-source.ts — Import source files: JSON, EPUB, ZIP, LucaTxt

import { state, ui, getOpfsRoot } from './state';
import { normalizeLineDict, EPUB_ILUSTRASI_MARKER } from './state';
import { decodeArrayBuffer, arrayBufferToBase64, splitBufferToLines } from './binary-utils';
import { parseLucaTxt, getLucaProfile, getActiveLucaProfile, getLucaExportSlotOptions, normalizeLucaHeavyQuoteFields, parseJsonEntries, parseJsonFromFileObject, clearLucaFileLineBytesCache, DEFAULT_LUCA_PROFILE } from './luca-engine';
import { WINDOWS_FILE_ORDER_COLLATOR } from './constants';
import { normalizeFileBaseName, windowsFileOrderCompare, getFileOrderPath } from './string-utils';
import { refreshAll, flashHint, renumberLinesToDisplayOrder } from './render';
import { queueAutoSave, saveLucaDataToOpfs, saveCustomSourcesToOpfs } from './project';
import { findCustomParserForFile, getCustomParser, buildParserOptions } from './custom-parsers';
import { runCustomParse } from './custom-parser-runner';
import { resetSelectionHistory } from './selection';
import { resolveZipPath, preloadEpubImages } from './epub-images';
import type { Line, CustomParser } from './types';

const esc = (s: any) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export async function promptLucaProfileDialog(initialProfile: string): Promise<{ profileId: string; exportLang: string; mcName: string } | null> {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-backdrop open';
    overlay.style.zIndex = '3000';
    
    const profs = [
      { id: 'summer-pockets-steam', label: 'Summer Pockets Steam (MESSAGE 4-slot)' },
      { id: 'clannad-switch', label: 'CLANNAD Switch (MESSAGE JP+EN)' },
      { id: 'tomoyo-switch', label: 'Tomoyo After Switch (MESSAGE voice+text)' },
      { id: 'clannad-ss', label: 'CLANNAD Side Stories (MESSAGE_WAIT)' }
    ];

    overlay.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true" style="max-width: 480px;">
        <div class="modal-head">
          <h3 style="display: flex; align-items: center; gap: 8px;">
            <svg class="lucide-icon text-luca" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/></svg>
            Pilih Format Game Luca System
          </h3>
        </div>
        <div class="modal-body" style="padding: 12px 2px;">
          <p class="mb-3 text-muted text-sm">File skenario LucaSystem terdeteksi. Silakan tentukan game target untuk parsing perintah teks dengan akurat:</p>
          <div class="flex-col gap-1 mb-3">
            <label class="form-label" style="font-weight: 600;">Profil Game Luca</label>
            <select id="modalPickerLucaProfile" class="text-input w-full">
              ${profs.map(p => `<option value="${p.id}" ${p.id === initialProfile ? 'selected' : ''}>${p.label}</option>`).join('')}
            </select>
          </div>
          <div class="flex-col gap-1 mb-3" id="modalPickerLucaLangRow">
            <label class="form-label" style="font-weight: 600;">Slot Bahasa Ekspor</label>
            <select id="modalPickerLucaLang" class="text-input w-full"></select>
          </div>
          <div class="flex-col gap-1 mb-2" id="modalPickerLucaMcRow" style="display: none;">
            <label class="form-label" style="font-weight: 600;">Nama Protagonis (@nama di CLANNAD)</label>
            <input id="modalPickerLucaMc" class="text-input w-full" type="text" value="${esc(state.lucaMcDisplayName || 'Tomoya')}" placeholder="Nama MC tampilan (mis. Tomoya)" />
          </div>
        </div>
        <div class="modal-actions" style="display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px;">
          <button type="button" class="btn btn-outline btn-picker-cancel">Batal</button>
          <button type="button" class="btn btn-primary btn-picker-confirm">Mulai Impor</button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    const selProfile = overlay.querySelector('#modalPickerLucaProfile') as HTMLSelectElement;
    const selLang = overlay.querySelector('#modalPickerLucaLang') as HTMLSelectElement;
    const rowLang = overlay.querySelector('#modalPickerLucaLangRow') as HTMLElement;
    const inputMc = overlay.querySelector('#modalPickerLucaMc') as HTMLInputElement;
    const rowMc = overlay.querySelector('#modalPickerLucaMcRow') as HTMLElement;

    const updateUI = () => {
      const pId = selProfile?.value || 'summer-pockets-steam';
      const prof = getLucaProfile(pId);
      if (rowMc) rowMc.style.display = prof.nameAtFormat ? '' : 'none';
      if (selLang) {
        const opts = getLucaExportSlotOptions(prof);
        const cur = selLang.value || state.lucaExportLang || 'en';
        selLang.replaceChildren();
        for (const o of opts) {
          const opt = document.createElement('option');
          opt.value = o.value;
          opt.textContent = o.label.replace('arg 3', 'Slot 2/3').replace('arg 4', 'Slot 3/4').replace('arg 2', 'Slot 2');
          selLang.appendChild(opt);
        }
        const match = opts.find((o: any) => o.value === cur);
        selLang.value = match ? cur : opts[0].value;
        if (rowLang) rowLang.style.display = opts.length > 1 || prof.hasMultiLangRef ? '' : 'none';
      }
    };

    selProfile?.addEventListener('change', updateUI);
    updateUI();

    const cleanup = () => {
      overlay.classList.remove('open');
      overlay.remove();
    };

    overlay.querySelector('.btn-picker-cancel')?.addEventListener('click', () => {
      cleanup();
      resolve(null);
    });

    overlay.querySelector('.btn-picker-confirm')?.addEventListener('click', () => {
      const res = {
        profileId: selProfile?.value || 'summer-pockets-steam',
        exportLang: selLang?.value || 'en',
        mcName: inputMc?.value.trim() || 'Tomoya'
      };
      cleanup();
      resolve(res);
    });
  });
}

export async function handleImportLucaTxtLogic(files: FileList | File[]): Promise<void> {
  const txtFiles = Array.from(files).filter(f => f.name.toLowerCase().endsWith('.txt'));
  if (txtFiles.length === 0) {
    flashHint('Tidak ada file .txt yang valid.', false);
    return;
  }

  if (state.lines.length === 0) {
    const picked = await promptLucaProfileDialog(state.lucaProfile || DEFAULT_LUCA_PROFILE);
    if (!picked) {
      flashHint('Impor Luca dibatalkan.', false);
      return;
    }
    state.projectType = 'luca';
    state.lucaProfile = picked.profileId;
    state.lucaExportLang = picked.exportLang;
    state.lucaMcDisplayName = picked.mcName;
  } else if (state.projectType !== 'luca') {
    throw new Error('Format LucaSystem tidak cocok dengan tipe proyek saat ini. Buat proyek baru untuk mengimpor skenario Luca.');
  }

  flashHint('Memproses file TXT... Mohon tunggu.', true);
  document.body.style.cursor = 'wait';
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  const previousState = {
    lines: state.lines,
    importedFiles: [...state.importedFiles],
    fileOrder: [...state.fileOrder],
    selectedLines: [...state.selectedLines],
    projectType: state.projectType,
    lucaProfile: state.lucaProfile,
    lucaRawFiles: { ...state.lucaRawFiles },
    lucaRawBuffers: { ...state.lucaRawBuffers },
  };
  try {
    let cur = state.lines.length > 0 ? state.lines.reduce((m, l) => l.line_num > m ? l.line_num : m, 0) + 1 : 1;
    const existingFiles = new Set(state.importedFiles);
    const skippedFiles: string[] = [];
    const newLines: Line[] = [];

    const sortedFiles = Array.from(files).sort((a, b) =>
      windowsFileOrderCompare(getFileOrderPath(a), getFileOrderPath(b))
    );
    for (const f of sortedFiles) {
      if (!f.name.toLowerCase().endsWith('.txt')) continue;
      const baseName = f.name;
      if (existingFiles.has(baseName)) { skippedFiles.push(baseName); continue; }
      const buf = await f.arrayBuffer();
      const bytes = new Uint8Array(buf);
      const text = decodeArrayBuffer(bytes);
      if (!existingFiles.has(baseName)) {
        state.lucaRawFiles[baseName] = text.split(/\r?\n/);
        state.lucaRawBuffers[baseName] = arrayBufferToBase64(buf);
      }
      const parsed = parseLucaTxt(text, baseName, cur, state.lucaProfile, splitBufferToLines(bytes));
      if (parsed.length > 0) {
        existingFiles.add(baseName);
        for (let i = 0; i < parsed.length; i++) newLines.push(parsed[i]);
        cur += parsed.length;
      }
      await new Promise(r => setTimeout(r, 0));
    }

    if (newLines.length > 0) {
      clearLucaFileLineBytesCache();
      state.lines = state.lines.concat(newLines);
      state.importedFiles = Array.from(existingFiles);
      renumberLinesToDisplayOrder();
      state.selectedLines.clear();
      resetSelectionHistory();
      refreshAll();
      if (state.currentProjectId) {
        await saveLucaDataToOpfs(state.currentProjectId, {
          lucaRawFiles: state.lucaRawFiles,
          lucaRawBuffers: state.lucaRawBuffers,
        });
        queueAutoSave();
      } else {
        queueAutoSave();
      }
      let msg = `Berhasil impor ${newLines.length} baris (${getActiveLucaProfile().label}).`;
      if (skippedFiles.length > 0) msg += ` (${skippedFiles.length} file duplikat diabaikan)`;
      if (getActiveLucaProfile().id === 'tomoyo-switch') {
        const withPrefix = newLines.filter((l) => l.luca_prefix_b64).length;
        if (withPrefix > 0) {
          msg += ` | Tomoyo: ${withPrefix} baris masih punya byte prefix di txt (dinormalisasi saat export).`;
        } else {
          msg += ' | Tomoyo: format decompile bersih (payload saja — siap diterjemahkan).';
        }
      }
      flashHint(msg);
    } else if (skippedFiles.length > 0) {
      (ui.copyStatus as HTMLElement).classList.add('empty');
      setTimeout(() => alert(`Gagal impor: File duplikat.\n${skippedFiles.join('\n')}`), 10);
    } else {
      flashHint('Tidak ada MESSAGE atau SELECT yang ditemukan dalam file TXT.');
    }
  } catch (err: any) {
    state.lines = previousState.lines;
    state.importedFiles = previousState.importedFiles;
    state.fileOrder = previousState.fileOrder;
    state.selectedLines.clear();
    for (const lineNum of previousState.selectedLines) state.selectedLines.add(lineNum);
    state.projectType = previousState.projectType;
    state.lucaProfile = previousState.lucaProfile;
    state.lucaRawFiles = previousState.lucaRawFiles;
    state.lucaRawBuffers = previousState.lucaRawBuffers;
    clearLucaFileLineBytesCache();
    resetSelectionHistory();
    refreshAll();
    (ui.copyStatus as HTMLElement).classList.add('empty');
    setTimeout(() => alert(`Terjadi kesalahan saat mengimpor TXT:\n${err.message}`), 10);
  } finally {
    document.body.style.cursor = 'default';
  }
}

export async function handleImportLogic(filesObj: FileList | File[] | File, isZip = false): Promise<void> {
  flashHint('Memproses file... Mohon tunggu.', true);
  document.body.style.cursor = 'wait';
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  try {
    let cur = 1, lines: Line[] = [];
    let maxExistingLineNum = state.lines.length > 0 ? state.lines.reduce((m, l) => l.line_num > m ? l.line_num : m, 0) : 0;
    cur = maxExistingLineNum + 1;
    const existingFiles = new Set(state.importedFiles);
    const skippedFiles: string[] = [];
    let pendingEpubSourceId: string | null = null;
    let pendingEpubFile: File | null = null;

    if (isZip && filesObj instanceof File && (window as any).JSZip) {
      if (state.projectType !== 'json') {
        throw new Error('Format ZIP/JSON tidak cocok dengan tipe proyek saat ini. Buat proyek JSON baru untuk mengimpor file JSON.');
      }
      const zip = await (window as any).JSZip.loadAsync(filesObj);
      const names = Object.keys(zip.files).filter(n => n.endsWith('.json')).sort(windowsFileOrderCompare);
      for (const n of names) {
        const baseName = normalizeFileBaseName(n);
        if (existingFiles.has(baseName)) {
          skippedFiles.push(baseName);
          continue;
        }
        try {
          const jsonContent = JSON.parse(decodeArrayBuffer(await zip.file(n).async('uint8array')));
          const p = parseJsonEntries(jsonContent, baseName, cur);
          if (p.length) {
            existingFiles.add(baseName);
            for (let i = 0; i < p.length; i++) lines.push(p[i]);
            cur += p.length;
          }
        } catch (err) {
          console.warn(`[Import ZIP] Gagal mem-parse file JSON: ${n}`, err);
        }
        await new Promise(r => setTimeout(r, 0));
      }
    } else {
      const files = Array.from(filesObj as FileList | File[]).sort((a, b) => windowsFileOrderCompare(getFileOrderPath(a), getFileOrderPath(b)));
      for (const f of files) {
        const isEpub = f.name.toLowerCase().endsWith('.epub');
        const isJson = f.name.toLowerCase().endsWith('.json');

        if (isJson && (state.projectType === 'luca' || state.projectType === 'epub' || state.lines.length > 0 && state.projectType !== 'json')) {
          alert('Format JSON tidak cocok dengan tipe proyek saat ini. Buat proyek JSON baru untuk mengimpor JSON.');
          continue;
        }

        if (isEpub) {
          if (state.projectType === 'luca' || pendingEpubSourceId || lines.length > 0 || state.lines.length > 0 && state.projectType !== 'epub') {
            alert('Format EPUB tidak cocok dengan tipe proyek saat ini. Buat proyek EPUB baru untuk mengimpor EPUB.');
            continue;
          }
          pendingEpubSourceId = 'epub_' + Date.now() + '.epub';
          pendingEpubFile = f;

          const zip = await (window as any).JSZip.loadAsync(f);
          const containerXml = await zip.file('META-INF/container.xml').async('text');
          const rootfile = new DOMParser().parseFromString(containerXml, 'application/xml').querySelector('rootfile');
          if (!rootfile) continue;
          const opfPath = decodeURIComponent(rootfile.getAttribute('full-path') || '');
          const opfDir = opfPath.includes('/') ? opfPath.substring(0, opfPath.lastIndexOf('/')) + '/' : '';

          const opfXml = await zip.file(opfPath).async('text');
          const opfDoc = new DOMParser().parseFromString(opfXml, 'application/xml');

          const manifest: Record<string, string> = {};
          Array.from(opfDoc.querySelectorAll('manifest > item')).forEach(item => {
            manifest[item.getAttribute('id') || ''] = decodeURIComponent(item.getAttribute('href') || '');
          });

          const spineHrefs = Array.from(opfDoc.querySelectorAll('spine > itemref')).map(ref => {
            const idref = ref.getAttribute('idref') || '';
            return manifest[idref] ? opfDir + manifest[idref] : null;
          }).filter(Boolean) as string[];

          const tagsSelector = state.epubTags || 'p';

          for (const href of spineHrefs) {
            if (existingFiles.has(href)) {
              skippedFiles.push(href);
              continue;
            }
            const fileEntry = zip.file(href);
            if (!fileEntry) continue;

            const html = await fileEntry.async('text');
            const doc = new DOMParser().parseFromString(html, href.endsWith('.xhtml') ? 'application/xhtml+xml' : 'text/html');
            const els = Array.from(doc.querySelectorAll(tagsSelector));

            // Find all image elements in this document (e.g. cover, inserts, illustrations)
            const docImgEls = Array.from(doc.querySelectorAll('img, image'));
            const docImages = docImgEls.map(imgEl => {
              const src = imgEl.getAttribute('src') || imgEl.getAttribute('href') || imgEl.getAttribute('xlink:href') || '';
              return src ? resolveZipPath(href, src) : null;
            }).filter(Boolean) as string[];

            let fileHasContent = false;
            let imgIdx = 0;

            for (const el of els) {
              const text = (el.textContent || '').replace(/\r?\n/g, ' ').trim();
              const elImgSrcs = Array.from(el.querySelectorAll('img, image')).map(imgEl => {
                const raw = imgEl.getAttribute('src') || imgEl.getAttribute('href') || imgEl.getAttribute('xlink:href') || '';
                return raw ? resolveZipPath(href, raw) : '';
              }).filter(Boolean);
              let lineImgSrc: string | undefined = elImgSrcs[0];
              if (!lineImgSrc && imgIdx < docImages.length && !fileHasContent) {
                lineImgSrc = docImages[imgIdx++];
              }

              if (text) {
                lines.push({
                  line_num: cur++,
                  file: href,
                  name: null,
                  message: text,
                  trans_name: null,
                  trans_message: null,
                  is_translated: false,
                  epub_img_src: lineImgSrc
                });
                fileHasContent = true;
              } else if (elImgSrcs.length > 0) {
                // Image-only paragraph mid-chapter — keep each image as its own line
                // so the illustration is not lost from the workspace.
                for (const imgSrc of elImgSrcs) {
                  lines.push({
                    line_num: cur++,
                    file: href,
                    name: null,
                    message: EPUB_ILUSTRASI_MARKER,
                    trans_name: null,
                    trans_message: null,
                    is_translated: false,
                    epub_img_src: imgSrc
                  });
                }
                fileHasContent = true;
              }
            }

            // Standalone illustration page without matching text tags
            if (!fileHasContent && docImages.length > 0) {
              for (const imgPath of docImages) {
                lines.push({
                  line_num: cur++,
                  file: href,
                  name: null,
                  message: EPUB_ILUSTRASI_MARKER,
                  trans_name: null,
                  trans_message: null,
                  is_translated: false,
                  epub_img_src: imgPath
                });
              }
              fileHasContent = true;
            }

            if (fileHasContent) {
              existingFiles.add(href);
            }
            await new Promise(r => setTimeout(r, 0));
          }
        } else if (isJson) {
          if (pendingEpubSourceId) {
            alert('Jangan mencampur EPUB dan JSON dalam satu impor.');
            continue;
          }
          const baseName = normalizeFileBaseName(f.name);
          if (existingFiles.has(baseName)) {
            skippedFiles.push(baseName);
            continue;
          }
          const p = parseJsonEntries(await parseJsonFromFileObject(f), baseName, cur);
          if (p.length) {
            existingFiles.add(baseName);
            for (let i = 0; i < p.length; i++) lines.push(p[i]);
            cur += p.length;
          }
          await new Promise(r => setTimeout(r, 0));
        }
      }
    }

    if (lines.length > 0) {
      if (pendingEpubSourceId && pendingEpubFile) {
        const root = await getOpfsRoot();
        const fh = await (root as any).getFileHandle(pendingEpubSourceId, { create: true });
        const writable = await fh.createWritable();
        await writable.write(pendingEpubFile);
        await writable.close();
        state.projectType = 'epub';
        state.epubSourceId = pendingEpubSourceId;
        preloadEpubImages();
      }
      state.lines = state.lines.concat(lines);
      state.importedFiles = Array.from(existingFiles);
      // EPUB: kunci urutan tampilan ke urutan SPINE (urutan baca buku) —
      // bukan alfabetis — supaya tabel & penomoran mengikuti alur cerita.
      state.fileOrder = Array.from(existingFiles);
      renumberLinesToDisplayOrder();
      state.selectedLines.clear();
      resetSelectionHistory();
      refreshAll();
      queueAutoSave();
      let msg = `Berhasil impor ${lines.length} baris.`;
      if (skippedFiles.length > 0) {
        msg += ` (${skippedFiles.length} file duplikat diabaikan)`;
      }
      flashHint(msg);
    } else if (skippedFiles.length > 0) {
      (ui.copyStatus as HTMLElement).classList.add('empty');
      setTimeout(() => {
        alert(`Gagal impor: File yang dipilih sudah ada di dalam proyek.\n\nFile duplikat:\n- ${skippedFiles.slice(0, 5).join('\n- ')}${skippedFiles.length > 5 ? '\n...dan lainnya' : ''}`);
      }, 10);
    } else {
      flashHint('Tidak ada data valid yang diimpor.', false);
    }
  } catch (err: any) {
    (ui.copyStatus as HTMLElement).classList.add('empty');
    setTimeout(() => alert(`Terjadi kesalahan saat mengimpor:\n${err.message}`), 10);
  } finally {
    document.body.style.cursor = 'default';
  }
}

// ─── Custom parser import ─────────────────────────────────────────────────────

/** Impor file via parser custom (JS/Python). Semua file dalam satu batch harus
 *  cocok dengan satu parser yang sama — proyek terkunci ke satu parser. */
export async function handleImportCustomLogic(files: FileList | File[]): Promise<void> {
  flashHint('Memproses file parser custom... Mohon tunggu.', true);
  document.body.style.cursor = 'wait';
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  const previousState = {
    lines: state.lines,
    importedFiles: [...state.importedFiles],
    fileOrder: [...state.fileOrder],
    selectedLines: [...state.selectedLines],
    projectType: state.projectType,
    customParserId: state.customParserId,
    customRawFiles: { ...state.customRawFiles },
    customRawBuffers: { ...state.customRawBuffers },
  };
  try {
    const sortedFiles = Array.from(files).sort((a, b) =>
      windowsFileOrderCompare(getFileOrderPath(a), getFileOrderPath(b))
    );

    const parserByFile = new Map<File, NonNullable<ReturnType<typeof findCustomParserForFile>>>();
    const unsupportedFiles: string[] = [];
    let parser: ReturnType<typeof findCustomParserForFile> = null;
    for (const f of sortedFiles) {
      let sample: Uint8Array | null = null;
      try { sample = new Uint8Array(await f.slice(0, 64).arrayBuffer()); } catch { sample = null; }
      const p = findCustomParserForFile(f.name, sample);
      if (!p) { unsupportedFiles.push(f.name); continue; }
      if (parser && parser.id !== p.id) {
        throw new Error(
          'Campur beberapa parser dalam satu impor tidak didukung. ' +
          `File "${f.name}" cocok dengan parser "${p.name}", bukan "${parser.name}". Impor per format.`
        );
      }
      parser = p;
      parserByFile.set(f, p);
    }
    if (!parser) {
      flashHint('Tidak ada parser custom yang cocok dengan file yang dipilih.', false);
      if (unsupportedFiles.length) {
        setTimeout(() => alert(`Tidak ada parser custom aktif untuk:\n- ${unsupportedFiles.slice(0, 10).join('\n- ')}`), 10);
      }
      return;
    }

    if (parser.id === 'builtin-lucasystem') {
      await handleImportLucaTxtLogic(files);
      return;
    }

    if (state.lines.length > 0) {
      if (state.projectType !== 'custom') {
        throw new Error('Format parser custom tidak cocok dengan tipe proyek saat ini. Buat proyek baru untuk memakai parser custom.');
      }
      if (state.customParserId && state.customParserId !== parser.id) {
        const activeParser = getCustomParser(state.customParserId);
        throw new Error(
          `Proyek ini memakai parser "${activeParser?.name || state.customParserId}". ` +
          `Yang dipilih: "${parser.name}". Buat proyek baru atau impor dengan parser yang sama.`
        );
      }
    }

    let cur = state.lines.length > 0 ? state.lines.reduce((m, l) => l.line_num > m ? l.line_num : m, 0) + 1 : 1;
    const existingFiles = new Set(state.importedFiles);
    const skippedFiles: string[] = [];
    const newLines: Line[] = [];

    if (state.lines.length === 0) {
      state.projectType = 'custom';
      state.customParserId = parser.id;
    }

    // Nilai setting user (global per parser) -> ctx.options utk parse().
    const parserOptions = buildParserOptions(parser);

    for (const f of sortedFiles) {
      const p = parserByFile.get(f);
      if (!p) continue;
      const baseName = f.name;
      if (existingFiles.has(baseName)) { skippedFiles.push(baseName); continue; }
      const buf = await f.arrayBuffer();
      const bytes = new Uint8Array(buf);
      const text = decodeArrayBuffer(bytes);
      let entries: { name?: string | null; message: string; raw?: any; index?: any }[] = [];
      if ((p as any).isPlugin || !(p as any).parseScript) {
        const extractRes = await (window as any).CSTL.plugins.callExtract(p, {
          fileName: baseName,
          buffer: buf,
          settings: parserOptions
        });
        entries = (extractRes?.lines || []).map((l: any) => ({
          file: l.file,
          name: l.name ?? null,
          message: l.message ?? '',
          raw: l.raw ?? null,
          index: l.index ?? null
        }));
      } else {
        entries = await runCustomParse(p as CustomParser, { fileName: baseName, text, bytes, startLineNum: cur, options: parserOptions }, {
          // Progress determinate dari parser (ctx.progress) -> status bar.
          onProgress: (done, total, label) => {
            const st = ui.copyStatus as HTMLElement | undefined;
            if (!st) return;
            st.classList.remove('empty');
            st.textContent = `Parser ${baseName}: ${done}/${total}${label ? ' — ' + label : ''}`;
          },
        });
      }
      if (entries.length > 0) {
        existingFiles.add(baseName);
        for (const entry of entries) {
          const entryFile = (entry as any).file || baseName;
          existingFiles.add(entryFile);
          newLines.push({
            line_num: cur++,
            file: entryFile,
            name: entry.name == null ? null : String(entry.name).replace(/\r?\n/g, '\\n').trim(),
            message: String(entry.message).replace(/\r?\n/g, '\\n').trim(),
            trans_name: null,
            trans_message: null,
            is_translated: false,
            ...(entry.raw != null && entry.raw !== '' ? { custom_raw: entry.raw } : {}),
            // Index bebas buatan parser (posisi entri/offset di file asli) —
            // diteruskan balik ke serialize() sebagai line.index saat ekspor.
            ...(entry.index != null ? { custom_index: entry.index } : {}),
          });
        }
        state.customRawFiles[baseName] = text;
        state.customRawBuffers[baseName] = arrayBufferToBase64(buf);
      }
      await new Promise(r => setTimeout(r, 0));
    }

    if (newLines.length > 0) {
      state.lines = state.lines.concat(newLines);
      state.importedFiles = Array.from(existingFiles);
      renumberLinesToDisplayOrder();
      state.selectedLines.clear();
      resetSelectionHistory();
      refreshAll();
      if (state.currentProjectId) {
        await saveCustomSourcesToOpfs(state.currentProjectId, {
          customRawFiles: state.customRawFiles,
          customRawBuffers: state.customRawBuffers,
        });
        queueAutoSave();
      } else {
        queueAutoSave();
      }
      let msg = `Berhasil impor ${newLines.length} baris (parser "${parser.name}").`;
      if (skippedFiles.length > 0) msg += ` (${skippedFiles.length} file duplikat diabaikan)`;
      if (unsupportedFiles.length > 0) msg += ` (${unsupportedFiles.length} file tanpa parser diabaikan)`;
      flashHint(msg);
    } else if (skippedFiles.length > 0) {
      (ui.copyStatus as HTMLElement).classList.add('empty');
      setTimeout(() => alert(`Gagal impor: File duplikat.\n${skippedFiles.join('\n')}`), 10);
    } else {
      flashHint(`Parser "${parser.name}" tidak menemukan baris apa pun (message kosong semua).`, false);
    }
  } catch (err: any) {
    state.lines = previousState.lines;
    state.importedFiles = previousState.importedFiles;
    state.fileOrder = previousState.fileOrder;
    state.selectedLines.clear();
    for (const lineNum of previousState.selectedLines) state.selectedLines.add(lineNum);
    state.projectType = previousState.projectType;
    state.customParserId = previousState.customParserId;
    state.customRawFiles = previousState.customRawFiles;
    state.customRawBuffers = previousState.customRawBuffers;
    resetSelectionHistory();
    refreshAll();
    (ui.copyStatus as HTMLElement).classList.add('empty');
    setTimeout(() => alert(`Terjadi kesalahan saat impor parser custom:\n${err.message}`), 10);
  } finally {
    document.body.style.cursor = 'default';
  }
}

export async function onImportCustomChange(ev: Event): Promise<void> {
  const target = ev.target as HTMLInputElement;
  if (!target.files?.length) return;
  await handleImportCustomLogic(target.files);
  target.value = '';
}

/** Folder khusus parser custom: semua file langsung masuk jalur parser —
 *  file yang tidak cocok dilaporkan oleh handleImportCustomLogic. */
export async function onImportCustomFolderChange(ev: Event): Promise<void> {
  const target = ev.target as HTMLInputElement;
  if (!target.files?.length) return;
  await handleImportCustomLogic(target.files);
  target.value = '';
}

/** File/folder generik: file yang cocok parser custom aktif dialihkan ke
 *  handleImportCustomLogic, sisanya ke jalur built-in. */
export async function importWithCustomRouting(files: FileList | File[]): Promise<void> {
  const all = Array.from(files);
  if (all.length === 0) return;
  const custom: File[] = [];
  const rest: File[] = [];
  for (const f of all) {
    let sample: Uint8Array | null = null;
    try { sample = new Uint8Array(await f.slice(0, 64).arrayBuffer()); } catch { sample = null; }
    if (findCustomParserForFile(f.name, sample)) custom.push(f);
    else rest.push(f);
  }
  if (custom.length > 0) await handleImportCustomLogic(custom);
  if (rest.length > 0) await handleImportLogic(rest);
}

export async function onImportFileChange(ev: Event): Promise<void> {
  const target = ev.target as HTMLInputElement;
  if (!target.files?.length) return;
  await importWithCustomRouting(target.files);
  target.value = '';
}

export async function onImportFolderChange(ev: Event): Promise<void> {
  const target = ev.target as HTMLInputElement;
  if (!target.files?.length) return;
  await importWithCustomRouting(target.files);
  target.value = '';
}

export async function onImportZipChange(ev: Event): Promise<void> {
  const target = ev.target as HTMLInputElement;
  if (!target.files?.length) return;
  await handleImportLogic(target.files[0], true);
  target.value = '';
}

export async function onImportLucaTxtChange(ev: Event): Promise<void> {
  const target = ev.target as HTMLInputElement;
  if (!target.files?.length) return;
  await handleImportLucaTxtLogic(target.files);
  target.value = '';
}

export async function onImportLucaTxtFolderChange(ev: Event): Promise<void> {
  const target = ev.target as HTMLInputElement;
  if (!target.files?.length) return;
  await handleImportLucaTxtLogic(target.files);
  target.value = '';
}
