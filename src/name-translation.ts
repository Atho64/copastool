// @module name-translation.ts — Character name translation: copy, paste, apply

import { state, ui } from './state';
import { truncateForPrompt, stripDecorativeWrapping, stripPlaintextFences, matchKnownName } from './string-utils';
import { addNameGlossaryEntry, mergeGlossaryEntries, parseGlossaryToMap, serializeGlossaryMap, sanitizeTagsForChatgpt } from './glossary';
import { flashHint, rebuildDisplayState, renderPreviewRows, renderNameTable, updateButtonStates, pushUndoSnapshot, collectCharacterNameRows, refreshAll } from './render';
import { queueAutoSave } from './project';
import { applyPromptVariables } from './ai-format';
import { DEFAULT_NAME_TRANSLATION_PROMPT } from './constants';


export function buildNameTranslationPrompt(nameRows: any[]): string {
  const basePrompt = applyPromptVariables(DEFAULT_NAME_TRANSLATION_PROMPT).trim();
  const namesBlock = nameRows.map((row, idx) => {
    const translatedNames = Array.from(row.translatedNames as Set<string>);
    const current = translatedNames.length === 1
      ? ` (current: ${translatedNames[0]})`
      : translatedNames.length > 1
        ? ` (current variants: ${translatedNames.join(' / ')})`
        : '';
    return `${idx + 1}. ${row.name}${current}`;
  }).join('\n');
  const contextBlock = nameRows.map(row => {
    const examples = row.lines.slice(0, 3).map((line: any) => {
      return `line ${line.line_num}: ${row.name}: ${truncateForPrompt(line.message)}`;
    });
    return `${row.name}\n${examples.join('\n')}`;
  }).join('\n\n');
  return sanitizeTagsForChatgpt(`${basePrompt}\n\n<Names>\n${namesBlock}\n</Names>\n\n<Context>\nThese lines are for context only. Do NOT translate them.\n${contextBlock}\n</Context>\n`);
}

export async function onCopyNamesForAi(): Promise<void> {
  const nameRows = collectCharacterNameRows();
  if (!nameRows.length) return;
  const promptText = buildNameTranslationPrompt(nameRows);
  try {
    await navigator.clipboard.writeText(promptText);
    flashHint(`Disalin ${nameRows.length} nama untuk AI.`);
  } catch (_) {
    ui.pasteNameArea.value = promptText;
    flashHint('Clipboard gagal, prompt dimasukkan ke kotak paste nama.');
  }
  updateButtonStates();
}

export function parseNameTranslationPaste(text: string, nameRows: any[]): { result: Map<string, string>; errors: string[] } {
  const knownNames = new Set(nameRows.map((row: any) => row.name as string));
  const result = new Map<string, string>();
  const errors: string[] = [];
  const lines = stripPlaintextFences(text).split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    let raw = lines[i].trim();
    if (!raw) continue;
    raw = raw.replace(/^[-*]\s+/, '').replace(/^\d+[.)]\s+/, '');
    const typeMatch = raw.match(/^\[([a-z ]+)\]\s*/i);
    if (typeMatch) raw = raw.slice(typeMatch[0].length).trim();

    let sepIdx = raw.indexOf('=');
    let sepLen = 1;
    if (sepIdx === -1) {
      const arrowIdx = raw.indexOf('->');
      if (arrowIdx !== -1) {
        sepIdx = arrowIdx;
        sepLen = 2;
      }
    }
    if (sepIdx === -1) {
      errors.push(`[Baris ${i + 1}] Format harus "nama = terjemah".`);
      continue;
    }

    const source = matchKnownName(raw.slice(0, sepIdx), knownNames);
    let target = raw.slice(sepIdx + sepLen).trim();
    target = target.replace(/\s*\{[^{}]*\}\s*$/, '').trim();
    target = stripDecorativeWrapping(target);

    if (!source) {
      errors.push(`[Baris ${i + 1}] Nama sumber tidak ada di tabel: "${raw.slice(0, sepIdx).trim()}".`);
      continue;
    }
    if (!target) {
      errors.push(`[Baris ${i + 1}] Terjemah nama "${source}" kosong.`);
      continue;
    }
    result.set(source, target);
  }
  return { result, errors };
}

export function onApplyNameTranslations(): void {
  const nameRows = collectCharacterNameRows();
  if (!nameRows.length) return;
  const { result, errors } = parseNameTranslationPaste(ui.pasteNameArea.value.trim(), nameRows);
  if (!result.size && !errors.length) return alert('Teks di kotak nama kosong atau tidak valid.');
  if (errors.length) {
    return alert('TERJEMAH NAMA DITOLAK:\n\n' + errors.slice(0, 12).join('\n') + (errors.length > 12 ? `\n\n... (+${errors.length - 12} error lain)` : ''));
  }

  let changedNames = 0;
  let changedLines = 0;
  pushUndoSnapshot();
  for (const row of nameRows) {
    if (!result.has(row.name)) continue;
    const nextName = result.get(row.name)!;
    let rowChanged = false;
    for (const line of row.lines) {
      if ((line.trans_name || '') !== nextName) {
        line.trans_name = nextName;
        changedLines++;
        rowChanged = true;
      }
    }
    if (rowChanged) changedNames++;
  }

  if (!changedLines) {
    state.undoStack.pop();
    ui.btnUndo.disabled = state.undoStack.length === 0;
    flashHint('Tidak ada nama yang berubah.');
    return;
  }

  ui.pasteNameArea.value = '';
  refreshAll();
  queueAutoSave();
  flashHint(`Diterapkan ${changedNames} nama ke ${changedLines} baris.`);
}

export function onResetNameTranslations(): void {
  const affectedLines = state.lines.filter(line => (line.name || '').trim() && (line.trans_name || '').trim());
  if (!affectedLines.length) return;
  const affectedNames = new Set(affectedLines.map(line => String(line.name || '').trim()));
  if (!confirm(`Reset semua terjemah nama karakter?\n\nIni akan mengosongkan ${affectedNames.size} nama di ${affectedLines.length} baris.`)) return;

  pushUndoSnapshot();
  for (const line of affectedLines) {
    line.trans_name = null;
  }
  refreshAll();
  queueAutoSave();
  flashHint(`Terjemah nama dikosongkan untuk ${affectedNames.size} nama di ${affectedLines.length} baris.`);
}
