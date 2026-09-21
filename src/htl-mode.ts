// @module htl-mode.ts — HTL (Human Translation) mode toggle & reference language panel

import { state, ui } from './state';
import { parseJsonFromFileObject, parseJsonEntries } from './luca-engine';
import { switchWorkspaceTab } from './selection';
import { refreshAll, flashHint } from './render';
import { queueAutoSave } from './project';
import { applyProjectLoggingVisibility } from './logging';

const REFLANG_1 = 'ref_lang_1';
const REFLANG_2 = 'ref_lang_2';

function isHtl(): boolean {
  return state.translationMode === 'htl';
}

// ─── HTL visibility toggle ────────────────────────────────────────────────────

export function applyHtlMode(): void {
  const htl = isHtl();
  document.body.classList.toggle('htl-mode', htl);

  for (const el of document.querySelectorAll<HTMLElement>('[data-htl-hide="true"]')) {
    el.hidden = htl;
    el.style.display = htl ? 'none' : '';
  }
  for (const el of document.querySelectorAll<HTMLElement>('[data-htl-show="true"]')) {
    el.hidden = !htl;
    el.style.display = htl ? 'block' : 'none';
  }

  if (htl) {
    if (ui.aiAgentChatPanel) ui.aiAgentChatPanel.style.display = 'none';
    if (ui.loggingPanel) ui.loggingPanel.style.display = 'none';
  }

  applyProjectLoggingVisibility();

  if (htl && (state.activeWorkspaceTab === 'glossary' || state.activeWorkspaceTab === 'aiCheck')) {
    switchWorkspaceTab('translate');
  }

  const panelTitle = document.querySelector<HTMLElement>('.panel-right .panel-title');
  if (panelTitle) panelTitle.textContent = htl ? 'Mode HTL' : 'Area Kerja';

  updateHtlRefLangPanels();
}

function updateHtlRefLangPanels(): void {
  if (!isHtl()) return;
  const has1 = state.lines.some(l => l.ref_lang_1 != null);
  const has2 = state.lines.some(l => l.ref_lang_2 != null);

  const box1 = document.getElementById('htlRefLang1Box');
  const box2 = document.getElementById('htlRefLang2Box');
  const text1 = document.getElementById('htlRefLang1Text');
  const text2 = document.getElementById('htlRefLang2Text');

  if (box1) box1.style.display = has1 ? 'block' : 'none';
  if (box2) box2.style.display = has2 ? 'block' : 'none';

  if (has1 && text1) {
    const out: string[] = [];
    for (const l of state.lines) {
      if (l.ref_lang_1 == null) continue;
      const nm = l.name ? `${l.name}: ` : '';
      out.push(`${l.line_num}. ${nm}${l.ref_lang_1}`);
    }
    text1.textContent = out.join('\n');
  }
  if (has2 && text2) {
    const out: string[] = [];
    for (const l of state.lines) {
      if (l.ref_lang_2 == null) continue;
      const nm = l.name ? `${l.name}: ` : '';
      out.push(`${l.line_num}. ${nm}${l.ref_lang_2}`);
    }
    text2.textContent = out.join('\n');
  }
}

// ─── Reference language import (JSON, position-matched) ──────────────────────

async function applyRefJsonToLines(slot: number, json: any[]): Promise<number> {
  if (!Array.isArray(json)) throw new Error('File JSON harus berupa array of {name, message}.');
  if (json.length === 0) throw new Error('File JSON kosong.');
  const cur = state.lines.length;
  const limit = Math.min(json.length, cur);
  let applied = 0;
  for (let i = 0; i < limit; i++) {
    const entry = json[i];
    if (!entry || typeof entry !== 'object') continue;
    const msg = entry.message != null ? String(entry.message).replace(/\r?\n/g, '\\n').trim() : '';
    const name = entry.name != null ? String(entry.name).replace(/\r?\n/g, '\\n').trim() : null;
    const line = state.lines[i];
    if (!line) continue;
    if (slot === 1) {
      line.ref_lang_1 = msg || null;
      line.ref_lang_1_name = name;
    } else {
      line.ref_lang_2 = msg || null;
      line.ref_lang_2_name = name;
    }
    if (msg) applied++;
  }
  return applied;
}

function findProjectFileNameForRef(refFile: File): string | null {
  const candidates = new Set<string>();
  const nameNoExt = refFile.name.replace(/\.(json|xhtml|html|txt)$/i, '');
  candidates.add(nameNoExt.toLowerCase());
  const relPath = (refFile as any).webkitRelativePath;
  if (relPath) {
    const relNoExt = relPath.replace(/\.(json|xhtml|html|txt)$/i, '');
    candidates.add(relNoExt.toLowerCase());
    const relBase = relNoExt.split('/').pop();
    if (relBase) candidates.add(relBase.toLowerCase());
  }
  for (const f of state.importedFiles) {
    const fLower = f.toLowerCase();
    const fNoExt = fLower.replace(/\.(json|xhtml|html|txt)$/i, '');
    if (candidates.has(fNoExt) || candidates.has(fLower)) return f;
  }
  return null;
}

async function importRefJson(slot: number, file: File): Promise<void> {
  if (state.projectType !== 'json') {
    return alert('Referensi bahasa tambahan hanya untuk proyek JSON VNTP.');
  }
  if (!state.lines.length) {
    return alert('Impor file sumber JSON dulu sebelum impor referensi.');
  }
  try {
    const json = await parseJsonFromFileObject(file);
    const applied = await applyRefJsonToLines(slot, json);
    refreshAll();
    queueAutoSave();
    flashHint(`Berhasil impor ${applied} baris Referensi ${slot} (${file.name}).`);
  } catch (err: any) {
    alert(`Gagal impor Referensi ${slot}: ${err.message}`);
  }
}

async function importRefJsonFolder(slot: number, files: File[]): Promise<void> {
  if (!state.lines.length) {
    return alert('Impor file sumber JSON dulu sebelum impor referensi.');
  }
  const jsonFiles = files.filter(f => f.name.toLowerCase().endsWith('.json'));
  if (!jsonFiles.length) return alert('Tidak ada file JSON dalam folder.');

  const linesByFile = new Map<string, typeof state.lines>();
  for (const l of state.lines) {
    if (!linesByFile.has(l.file)) linesByFile.set(l.file, []);
    linesByFile.get(l.file)!.push(l);
  }
  let totalApplied = 0;
  const matched: string[] = [];
  const unmatched: string[] = [];
  const errors: string[] = [];

  for (const f of jsonFiles) {
    const targetFile = findProjectFileNameForRef(f);
    if (!targetFile) { unmatched.push(f.name); continue; }
    try {
      const json = await parseJsonFromFileObject(f);
      if (!Array.isArray(json)) { errors.push(`${f.name}: bukan array JSON`); continue; }
      const targetLines = linesByFile.get(targetFile) || [];
      const limit = Math.min(json.length, targetLines.length);
      let applied = 0;
      for (let i = 0; i < limit; i++) {
        const entry = json[i];
        if (!entry || typeof entry !== 'object') continue;
        const msg = entry.message != null ? String(entry.message).replace(/\r?\n/g, '\\n').trim() : '';
        const name = entry.name != null ? String(entry.name).replace(/\r?\n/g, '\\n').trim() : null;
        const line = targetLines[i];
        if (slot === 1) {
          line.ref_lang_1 = msg || null;
          line.ref_lang_1_name = name;
        } else {
          line.ref_lang_2 = msg || null;
          line.ref_lang_2_name = name;
        }
        if (msg) applied++;
      }
      totalApplied += applied;
      matched.push(`${f.name} → ${targetFile} (${applied} baris)`);
    } catch (err: any) {
      errors.push(`${f.name}: ${err.message}`);
    }
  }

  refreshAll();
  queueAutoSave();
  let msg = `Berhasil impor ${totalApplied} baris Referensi ${slot} dari ${matched.length} file.`;
  if (unmatched.length) msg += ` (${unmatched.length} file tanpa pasangan, dilewati)`;
  flashHint(msg);
  const lines: string[] = [];
  if (matched.length) lines.push(`Cocok: ${matched.length} file`, ...matched.slice(0, 8), matched.length > 8 ? `...+${matched.length - 8} lainnya` : '');
  if (unmatched.length) lines.push('', `Tidak ada pasangan: ${unmatched.length} file`, ...unmatched.slice(0, 8), unmatched.length > 8 ? `...+${unmatched.length - 8} lainnya` : '');
  if (errors.length) lines.push('', `Error: ${errors.length}`, ...errors.slice(0, 5));
  if (lines.length) alert(`Impor Referensi ${slot} selesai:\n\n` + lines.filter(Boolean).join('\n'));
}

function clearRefLang(slot: number): void {
  if (!confirm(`Hapus data Referensi ${slot} dari semua baris?`)) return;
  for (const l of state.lines) {
    if (slot === 1) {
      delete l.ref_lang_1;
      delete l.ref_lang_1_name;
    } else {
      delete l.ref_lang_2;
      delete l.ref_lang_2_name;
    }
  }
  refreshAll();
  queueAutoSave();
  flashHint(`Referensi ${slot} dihapus dari semua baris.`);
}

// ─── Public handler binders ───────────────────────────────────────────────────

export function onImportRefLang1(): void { ui.refLang1Input.click(); }
export function onImportRefLang2(): void { ui.refLang2Input.click(); }
export function onImportRefLang1Folder(): void { ui.refLang1FolderInput.click(); }
export function onImportRefLang2Folder(): void { ui.refLang2FolderInput.click(); }

export function onRefLang1FileChange(ev: Event): void {
  const target = ev.target as HTMLInputElement;
  const f = target.files?.[0];
  target.value = '';
  if (!f) return;
  importRefJson(1, f);
}

export function onRefLang2FileChange(ev: Event): void {
  const target = ev.target as HTMLInputElement;
  const f = target.files?.[0];
  target.value = '';
  if (!f) return;
  importRefJson(2, f);
}

export function onRefLang1FolderChange(ev: Event): void {
  const target = ev.target as HTMLInputElement;
  const files = target.files ? Array.from(target.files) : null;
  target.value = '';
  if (!files || !files.length) return;
  importRefJsonFolder(1, files).catch(err => console.error('[importRefJsonFolder error]', err));
}

export function onRefLang2FolderChange(ev: Event): void {
  const target = ev.target as HTMLInputElement;
  const files = target.files ? Array.from(target.files) : null;
  target.value = '';
  if (!files || !files.length) return;
  importRefJsonFolder(2, files);
}

export function onClearRefLang1(): void { clearRefLang(1); }
export function onClearRefLang2(): void { clearRefLang(2); }

export function refreshHtlPanels(): void {
  if (isHtl()) updateHtlRefLangPanels();
}
