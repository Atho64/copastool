import { state, ui, isTranslated } from './state';
import { applyAgentTranslations, clearAgentTranslations, onUndoLastApply, onRedoLastUndo } from './translate';
import { queueAutoSave } from './project';
import { refreshAll, pushUndoSnapshot } from './render';
import { renderGlossaryPreview, mergeGlossaryEntries } from './glossary';
import { applyHtlMode } from './htl-mode';
import { fetchVndbVnByName, fetchVndbCharacters, fetchAnilistMediaByName, fetchAnilistMediaCharacters, collectVndbGlossaryEntries, collectAnilistGlossaryEntries, applyVndbNameTranslations } from './vndb-anilist';
import type { Line } from './types';
import type { AgentMemory, MemoryCategory, MemoryScope } from './types';

// ------------------------------------------------------------------
// AI request layer — provided by ai-client.ts
// ------------------------------------------------------------------
// The provider implementations, SSE parser and key rotation used to live here.
// They now live in ai-client.ts so the agent and the auto-translate pipeline
// share ONE request path (idle timeout, cancellation, status-based key rotation).
// Re-exported so existing importers keep working unchanged.

import { chatCompletion, currentAbortEpoch, stripThinkingTagsForStream, type ChatMessage, type ChatRole } from './ai-client';
import { salvageJsonObject } from './json-repair';

export { chatCompletion, type ChatMessage, type ChatRole };
export type { StreamDeltaCallback } from './ai-client';

const COMPACTION_THRESHOLD = 50000;
const WELCOME_MSG = 'Halo! Saya CSTL Agent. Saya bisa menjawab pertanyaan seputar proyek ini atau membantu mengeksekusi terjemahan layaknya Vibecoding Agent.';

// ------------------------------------------------------------------
// Shared message content renderer
// ------------------------------------------------------------------

/**
 * Renders an agent message to safe HTML. Shared by the saved-history view and
 * the live streaming view so both always format identically (previously two
 * copies of this logic drifted apart).
 *
 * Escapes everything first, then re-introduces the small whitelist of
 * formatting: line breaks, bold, italic, inline code, and standalone
 * paragraph-level fenced code blocks.
 */
export function renderAgentMessageContent(content: string): string {
  const escaped = String(content ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return escaped
    .replace(/```(?:[a-z0-9_-]*)\n?([\s\S]*?)```/gi, (_m, code: string) => {
      const body = code.replace(/&lt;/g, '<').replace(/&amp;/g, '&').replace(/&gt;/g, '>');
      return `<pre><code>${body}</code></pre>`;
    })
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\n/g, '<br>');
}

/**
 * Applies renderAgentMessageContent into a DOM node. Throttled repaints while
 * streaming use the same path, so a streamed reply and its persisted render
 * stay byte-identical.
 */
export function setAgentMessageHtml(el: HTMLElement, content: string, streaming: boolean): void {
  el.classList.toggle('streaming', !!streaming);
  el.innerHTML = renderAgentMessageContent(content);
}

/**
 * Minimal throttle for streaming repaints — repainting innerHTML on every SSE
 * delta is wasted work once replies get long.
 */
export function createStreamThrottle(): (fn: () => void) => void {
  let pending = false;
  let lastPaint = 0;
  return (fn: () => void) => {
    const now = Date.now();
    if (now - lastPaint >= 50) {
      lastPaint = now;
      fn();
    } else if (!pending) {
      pending = true;
      setTimeout(() => {
        pending = false;
        lastPaint = Date.now();
        fn();
      }, 50);
    }
  };
}

// ------------------------------------------------------------------
// Chat History Persistence
// ------------------------------------------------------------------

function getChatStorageKey(): string {
  return state.currentProjectId
    ? `cstl_agent_chat_${state.currentProjectId}`
    : 'cstl_agent_chat_global';
}

export function saveChatHistory(): void {
  try {
    // Save only non-system, non-internal messages (system prompt is rebuilt on load)
    const toSave = chatHistory.filter(m => m.role !== 'system' && !m._internal);
    localStorage.setItem(getChatStorageKey(), JSON.stringify(toSave));
  } catch (e) {
    console.warn('Gagal menyimpan chat history:', e);
  }
}

export function loadChatHistory(): void {
  chatHistory.length = 0;
  chatHistory.push({ role: 'system', content: buildSystemPrompt() });
  try {
    const saved = localStorage.getItem(getChatStorageKey());
    if (saved) {
      const msgs = JSON.parse(saved) as ChatMessage[];
      if (Array.isArray(msgs)) {
        for (const m of msgs) {
          if (m.role && m.content) chatHistory.push({ role: m.role, content: m.content });
        }
      }
    }
  } catch (e) {
    console.warn('Gagal memuat chat history:', e);
  }
}

export function clearChatHistory(): void {
  chatHistory.length = 0;
  chatHistory.push({ role: 'system', content: buildSystemPrompt() });
  try { localStorage.removeItem(getChatStorageKey()); } catch {}
  // Reset UI
  const historyEl = ui.agentChatHistory as HTMLElement;
  if (historyEl) {
    historyEl.innerHTML = '';
    const welcome = document.createElement('div');
    welcome.className = 'agent-msg system';
    welcome.textContent = WELCOME_MSG;
    historyEl.appendChild(welcome);
  }
}

export function renderChatHistory(): void {
  const historyEl = ui.agentChatHistory as HTMLElement;
  if (!historyEl) return;
  historyEl.innerHTML = '';
  let hasContent = false;
  for (const m of chatHistory) {
    if (m.role === 'system') continue;
    if (m._internal) continue;
    const div = document.createElement('div');
    div.className = `agent-msg ${m.role}`;
    div.innerHTML = renderAgentMessageContent(m.content);
    historyEl.appendChild(div);
    hasContent = true;
  }
  if (!hasContent) {
    const welcome = document.createElement('div');
    welcome.className = 'agent-msg system';
    welcome.textContent = WELCOME_MSG;
    historyEl.appendChild(welcome);
  }
  historyEl.scrollTop = historyEl.scrollHeight;
}

// ------------------------------------------------------------------
// Tools Logic
// ------------------------------------------------------------------

function getProjectStats() {
  const visible = state.lines.filter(l => !l._hidden);
  const total = visible.length;
  const rawTotal = state.lines.length;
  const translated = visible.filter(l => l.is_translated).length;
  const untranslated = total - translated;
  const percent = total ? Math.round((translated / total) * 100) : 0;
  const files = [...new Set(visible.map(l => l.file).filter(Boolean))];
  return [
    `=== RINGKASAN PROYEK ===`,
    `Total Baris: ${total}${rawTotal > total ? ` (${rawTotal - total} terfilter, dari total ${rawTotal} baris)` : ''}`,
    `Sudah Diterjemahkan: ${translated} (${percent}%)`,
    `Belum Diterjemahkan: ${untranslated}`,
    `Bahasa Sumber: ${state.sourceLang}`,
    `Bahasa Target: ${state.targetLang}`,
    `Jumlah File: ${files.length}`,
    files.length ? `Daftar File: ${files.join(', ')}` : '',
  ].filter(Boolean).join('\n');
}

function searchLines(query: string) {
  const lower = query.toLowerCase();
  const results = state.lines.filter(l =>
    !l._hidden && (
      (l.message || '').toLowerCase().includes(lower) ||
      (l.trans_message || '').toLowerCase().includes(lower) ||
      (l.name || '').toLowerCase().includes(lower) ||
      (l.trans_name || '').toLowerCase().includes(lower)
    )
  ).slice(0, 50);
  if (!results.length) return `Tidak ditemukan baris yang mengandung: "${query}"`;
  return results.map(l =>
    `[Baris ${l.line_num}] ${l.name ? `(${l.name})` : ''}\nAsli: ${l.message}\nTerjemahan: ${l.trans_message || '(belum diterjemahkan)'}`
  ).join('\n\n');
}

function getLines(start: number, end: number) {
  const results = state.lines.filter(l => !l._hidden && l.line_num >= start && l.line_num <= end).slice(0, 50);
  if (!results.length) return `Tidak ada baris antara ${start}-${end}`;
  return results.map(l =>
    `[Baris ${l.line_num}] ${l.name ? `Karakter: ${l.name}` : '(Narasi)'}\nAsli: ${l.message}\nTerjemahan: ${l.trans_message || '(belum diterjemahkan)'}${l.trans_name ? `\nNama Terjemahan: ${l.trans_name}` : ''}`
  ).join('\n\n');
}

function getContext(line_num: number, radius: number) {
  const r = Math.min(Math.max(radius || 3, 1), 20);
  const target = state.lines.find(l => l.line_num === line_num);
  if (!target) return `Baris ${line_num} tidak ditemukan.`;
  const visible = state.lines.filter(l => !l._hidden);
  const idx = visible.findIndex(l => l.line_num === line_num);
  const results = idx >= 0
    ? visible.slice(Math.max(0, idx - r), Math.min(visible.length, idx + r + 1))
    : visible.filter(l => l.line_num >= line_num - r && l.line_num <= line_num + r);
  if (!results.length) return `Baris ${line_num} tidak ditemukan atau terfilter.`;
  return results.map(l => {
    const marker = l.line_num === line_num ? ' <<< TARGET' : '';
    return `[Baris ${l.line_num}${marker}] ${l.name ? `(${l.name})` : '(Narasi)'}\nAsli: ${l.message}\nTerjemahan: ${l.trans_message || '(belum)'}`;
  }).join('\n\n');
}

function getCharacterNames() {
  const map = new Map<string, Set<string>>();
  for (const l of state.lines) {
    if (l._hidden || !l.name) continue;
    if (!map.has(l.name)) map.set(l.name, new Set());
    if (l.trans_name) map.get(l.name)!.add(l.trans_name);
  }
  if (!map.size) return 'Tidak ada karakter dengan nama speaker dalam proyek ini.';
  const lines: string[] = ['=== DAFTAR KARAKTER ==='];
  for (const [orig, transSet] of map.entries()) {
    const transArr = [...transSet];
    if (transArr.length === 0) lines.push(`${orig} -> (belum diterjemahkan)`);
    else if (transArr.length === 1) lines.push(`${orig} -> ${transArr[0]}`);
    else lines.push(`${orig} -> [INKONSISTEN: ${transArr.join(' / ')}]`);
  }
  return lines.join('\n');
}

function analyzeQuality(limit: number) {
  const lim = Math.min(limit || 20, 50);
  const issues: string[] = [];
  const untrans = state.lines.filter(l => !l.is_translated).slice(0, lim);
  if (untrans.length) {
    issues.push(`--- Belum Diterjemahkan (${untrans.length} pertama dari ${state.lines.filter(l => !l.is_translated).length}) ---`);
    untrans.forEach(l => issues.push(`[Baris ${l.line_num}] ${l.name || 'Narasi'}: ${l.message}`));
  }
  const tooShort = state.lines.filter(l =>
    l.is_translated && l.trans_message && l.message.length > 10 && l.trans_message.length < l.message.length * 0.2
  ).slice(0, 10);
  if (tooShort.length) {
    issues.push(`\n--- Terjemahan Terlalu Pendek (mencurigakan) ---`);
    tooShort.forEach(l => issues.push(`[Baris ${l.line_num}] Asli: "${l.message}" -> Terjemahan: "${l.trans_message}"`));
  }
  const nameMap = new Map<string, Set<string>>();
  for (const l of state.lines) {
    if (!l.name || !l.trans_name) continue;
    if (!nameMap.has(l.name)) nameMap.set(l.name, new Set());
    nameMap.get(l.name)!.add(l.trans_name);
  }
  const inconsistentNames = [...nameMap.entries()].filter(([, s]) => s.size > 1);
  if (inconsistentNames.length) {
    issues.push(`\n--- Nama Karakter Tidak Konsisten ---`);
    inconsistentNames.forEach(([orig, transSet]) =>
      issues.push(`"${orig}" diterjemahkan sebagai: ${[...transSet].join(', ')}`)
    );
  }
  return issues.length ? issues.join('\n') : 'Tidak ditemukan masalah kualitas yang signifikan.';
}

function getProgressReport() {
  const fileMap = new Map<string, { total: number; translated: number }>();
  for (const l of state.lines) {
    if (l._hidden) continue;
    const f = l.file || '(tidak diketahui)';
    if (!fileMap.has(f)) fileMap.set(f, { total: 0, translated: 0 });
    const entry = fileMap.get(f)!;
    entry.total++;
    if (l.is_translated) entry.translated++;
  }
  const lines = ['=== LAPORAN PROGRESS PER FILE ==='];
  for (const [file, { total, translated }] of fileMap.entries()) {
    const pct = total ? Math.round((translated / total) * 100) : 0;
    const bar = '#'.repeat(Math.round(pct / 10)) + '-'.repeat(10 - Math.round(pct / 10));
    lines.push(`${file}\n  [${bar}] ${translated}/${total} (${pct}%)`);
  }
  return lines.join('\n');
}

function applyTranslations(updates: {num: number, trans_message: string, trans_name?: string}[]) {
  try {
    const applied = applyAgentTranslations(updates);
    return `Berhasil menerapkan terjemahan ke ${applied} baris.`;
  } catch (e: any) {
    return `Gagal menerapkan terjemahan: ${e.message}`;
  }
}

// ── Tool: editPrompt — edit prompt terjemahan/AI check/glosarium/agent ──

function editPrompt(promptType: string, newPrompt: string): string {
  const pt = String(promptType || '').toLowerCase().trim();
  const np = String(newPrompt || '').trim();
  if (!np) return 'Error: new_prompt tidak boleh kosong.';
  const map: Record<string, string> = {
    translation: 'aiInstructionHeader',
    glossary: 'glossaryPrompt',
    ai_check: 'aiCheckPrompt',
    aicheck: 'aiCheckPrompt',
    agent: 'agentPrompt',
  };
  const field = map[pt];
  if (!field) {
    return `Error: prompt_type tidak valid — "${promptType}". Pilihan: translation, glossary, ai_check, agent.`;
  }
  (state as any)[field] = np;
  queueAutoSave();
  return `Prompt "${pt}" berhasil diperbarui (${np.length} karakter).`;
}

// ── Tool: editGlossary — edit teks glosarium ──

function editGlossary(newGlossary: string): string {
  const ng = String(newGlossary ?? '');
  state.glossaryText = ng;
  renderGlossaryPreview();
  queueAutoSave();
  const entryCount = ng.trim() ? ng.trim().split(/\r?\n/).filter((l: string) => l.trim()).length : 0;
  return `Glosarium berhasil diperbarui (${entryCount} baris).`;
}

// ── Tool: toggleSetting — toggle/ubah semua setting di AppState ──

interface SettingMeta {
  field: keyof typeof state;
  type: 'boolean' | 'number' | 'string';
  desc: string;
}

const SETTING_REGISTRY: Record<string, SettingMeta> = {
  // Boolean toggles
  showFurigana: { field: 'showFurigana', type: 'boolean', desc: 'Tampilkan furigana di teks Jepang' },
  enableDictionary: { field: 'enableDictionary', type: 'boolean', desc: 'Aktifkan kamus pop-up' },
  checkKanaResidue: { field: 'checkKanaResidue', type: 'boolean', desc: 'Cek sisa kana di terjemahan' },
  checkSimilarity: { field: 'checkSimilarity', type: 'boolean', desc: 'Cek kemiripan asli-terjemahan' },
  checkLinebreak: { field: 'checkLinebreak', type: 'boolean', desc: 'Cek konsistensi linebreak' },
  checkLengthRatio: { field: 'checkLengthRatio', type: 'boolean', desc: 'Cek rasio panjang terjemahan' },
  checkLanguage: { field: 'checkLanguage', type: 'boolean', desc: 'Cek bahasa terjemahan' },
  checkPunctuation: { field: 'checkPunctuation', type: 'boolean', desc: 'Cek tanda baca' },
  checkUntransName: { field: 'checkUntransName', type: 'boolean', desc: 'Cek nama karakter JP belum diterjemahkan' },
  enableUncertainMarking: { field: 'enableUncertainMarking', type: 'boolean', desc: 'Tandai baris yang belum pasti' },
  enableBackgroundChaining: { field: 'enableBackgroundChaining', type: 'boolean', desc: 'Aktifkan background chaining' },
  disableEmptyLineValidation: { field: 'disableEmptyLineValidation', type: 'boolean', desc: 'Matikan validasi baris kosong' },
  aiFilterThinkingOutput: { field: 'aiFilterThinkingOutput', type: 'boolean', desc: 'Filter <think> tag dari output AI' },
  aiMergeSystemPrompt: { field: 'aiMergeSystemPrompt', type: 'boolean', desc: 'Merge system prompt ke user (workaround gateway yang drop system di OpenAI-compatible)' },
  // Number settings
  fontSize: { field: 'fontSize', type: 'number', desc: 'Ukuran font (8-32)' },
  contextLines: { field: 'contextLines', type: 'number', desc: 'Jumlah baris konteks (0-100)' },
  selectionBatchSize: { field: 'selectionBatchSize', type: 'number', desc: 'Ukuran batch seleksi (1-500)' },
  glossaryBatchSize: { field: 'glossaryBatchSize', type: 'number', desc: 'Ukuran batch glosarium (1-500)' },
  aiCheckBatchSize: { field: 'aiCheckBatchSize', type: 'number', desc: 'Ukuran batch AI check (1-500)' },
  parallelBatchSize: { field: 'parallelBatchSize', type: 'number', desc: 'Jumlah request paralel ke API (1-10)' },
  agentMaxTurns: { field: 'agentMaxTurns', type: 'number', desc: 'Maksimum turn AI agent (3-30)' },
  subagentWorkers: { field: 'subagentWorkers', type: 'number', desc: 'Jumlah worker paralel untuk subagent (1-10, default 3)' },
  similarityThreshold: { field: 'similarityThreshold', type: 'number', desc: 'Threshold kemiripan (0.01-0.99)' },
  lengthRatioThreshold: { field: 'lengthRatioThreshold', type: 'number', desc: 'Threshold rasio panjang (1-10)' },
  // String settings
  sourceLang: { field: 'sourceLang', type: 'string', desc: 'Bahasa sumber' },
  targetLang: { field: 'targetLang', type: 'string', desc: 'Bahasa target' },
  regexFilter: { field: 'regexFilter', type: 'string', desc: 'Regex filter baris' },
  regexFilterCase: { field: 'regexFilterCase', type: 'boolean', desc: 'Regex filter case sensitive (ON=case-sensitive, OFF=case-insensitive)' },
  epubTags: { field: 'epubTags', type: 'string', desc: 'Tag HTML untuk parsing EPUB' },
  aiThinkingMode: { field: 'aiThinkingMode', type: 'string', desc: 'Mode thinking AI (default|off|on)' },
  tavilyApiKey: { field: 'tavilyApiKey', type: 'string', desc: 'Tavily API Key untuk web search (kosong = tidak aktif)' },
};

function listSettings(): string {
  const lines: string[] = ['=== DAFTAR SETTING ==='];
  for (const [name, meta] of Object.entries(SETTING_REGISTRY)) {
    const current = (state as any)[meta.field];
    const valStr = meta.type === 'boolean' ? (current ? 'ON' : 'OFF') : String(current);
    lines.push(`- ${name} (${meta.type}): ${valStr} — ${meta.desc}`);
  }
  return lines.join('\n');
}

function toggleSetting(settingName: string, value: any): string {
  const meta = SETTING_REGISTRY[String(settingName || '').trim()];
  if (!meta) {
    return `Error: setting tidak dikenal — "${settingName}". Gunakan listSettings() untuk melihat daftar setting yang tersedia.`;
  }
  const field = meta.field;
  let applied: any;

  if (meta.type === 'boolean') {
    // value bisa: true/false, "on"/"off", "true"/"false", 1/0, atau undefined (toggle)
    if (value === undefined || value === null || value === '') {
      applied = !(state as any)[field];
    } else if (typeof value === 'boolean') {
      applied = value;
    } else if (typeof value === 'number') {
      applied = value !== 0;
    } else {
      const s = String(value).toLowerCase().trim();
      if (s === 'on' || s === 'true' || s === '1' || s === 'yes') applied = true;
      else if (s === 'off' || s === 'false' || s === '0' || s === 'no') applied = false;
      else return `Error: nilai boolean tidak valid — "${value}". Gunakan true/false, on/off, atau 1/0.`;
    }
    (state as any)[field] = applied;
  } else if (meta.type === 'number') {
    const num = typeof value === 'number' ? value : parseFloat(String(value));
    if (isNaN(num)) return `Error: nilai number tidak valid — "${value}".`;
    // Validasi range
    if (field === 'fontSize' && (num < 8 || num > 32)) return 'Error: fontSize harus 8-32.';
    if (field === 'contextLines' && (num < 0 || num > 100)) return 'Error: contextLines harus 0-100.';
    if ((field === 'selectionBatchSize' || field === 'glossaryBatchSize' || field === 'aiCheckBatchSize') && (num < 1 || num > 500)) return `Error: ${field} harus 1-500.`;
    if (field === 'parallelBatchSize' && (num < 1 || num > 10)) return 'Error: parallelBatchSize harus 1-10.';
    if (field === 'agentMaxTurns' && (num < 3 || num > 30)) return 'Error: agentMaxTurns harus 3-30.';
    if (field === 'subagentWorkers' && (num < 1 || num > 10)) return 'Error: subagentWorkers harus 1-10.';
    if (field === 'similarityThreshold' && (num < 0.01 || num > 0.99)) return 'Error: similarityThreshold harus 0.01-0.99.';
    if (field === 'lengthRatioThreshold' && (num < 1 || num > 10)) return 'Error: lengthRatioThreshold harus 1-10.';
    applied = num;
    (state as any)[field] = applied;
  } else {
    // string
    if (value === undefined || value === null) return `Error: nilai string diperlukan untuk "${settingName}".`;
    const s = String(value);
    // Validasi khusus
    if (field === 'regexFilter' && s) {
      try { new RegExp(s, 'u'); } catch (e: any) { return `Error: regex tidak valid: ${e.message}`; }
    }
    if (field === 'aiThinkingMode' && !['default', 'off', 'on'].includes(s.toLowerCase())) {
      return 'Error: aiThinkingMode harus "default", "off", atau "on".';
    }
    applied = s;
    (state as any)[field] = applied;
  }

  // Side effects
  if (field === 'fontSize') {
    document.documentElement.style.setProperty('--content-font-size', applied + 'px');
  }
  if (field === 'translationMode') {
    applyHtlMode();
  }
  refreshAll();
  renderGlossaryPreview();
  queueAutoSave();

  const valDisplay = meta.type === 'boolean' ? (applied ? 'ON' : 'OFF') : String(applied);
  return `Setting "${settingName}" berhasil diubah ke ${valDisplay}.`;
}

// ── Tool: editLine — edit semua field di satu baris ──

const EDITABLE_LINE_FIELDS = new Set([
  'message', 'name', 'trans_message', 'trans_name', 'is_translated',
  'file', '_hidden', '_glossary_extracted', '_ai_checked',
  // LucaSystem
  'luca_command', 'luca_pre', 'luca_post', 'luca_text_prefix',
  // EPUB
  'epub_selector', 'epub_id',
]);

function applyLineEdit(l: Line, fields: Record<string, any>): string[] {
  const changed: string[] = [];
  for (const [key, val] of Object.entries(fields)) {
    if (!EDITABLE_LINE_FIELDS.has(key)) continue;
    if (key === 'is_translated' || key === '_hidden' || key === '_glossary_extracted' || key === '_ai_checked') {
      (l as any)[key] = !!val;
    } else if (val === null) {
      (l as any)[key] = null;
    } else {
      // Sanitize newlines untuk field teks (konsisten dengan normalizeLineDict)
      (l as any)[key] = String(val).replace(/\r?\n/g, '\\n').trim();
    }
    changed.push(key);
  }
  return changed;
}

function editLine(lineNum: number, fields: Record<string, any>): string {
  const l = state.lineByNum.get(lineNum);
  if (!l) return `Error: baris ${lineNum} tidak ditemukan.`;
  if (!fields || typeof fields !== 'object') return 'Error: fields harus berupa object.';
  const validFields = Object.keys(fields).filter(k => EDITABLE_LINE_FIELDS.has(k));
  if (!validFields.length) {
    return `Error: tidak ada field yang valid. Field yang bisa diedit: ${[...EDITABLE_LINE_FIELDS].join(', ')}.`;
  }
  pushUndoSnapshot();
  const changed = applyLineEdit(l, fields);
  refreshAll();
  queueAutoSave();
  return `Baris ${lineNum} berhasil diedit. Field diubah: ${changed.join(', ')}.`;
}

function editLines(updates: {line_num: number, fields: Record<string, any>}[]): string {
  if (!updates || !updates.length) return 'Error: updates tidak boleh kosong.';
  pushUndoSnapshot();
  let edited = 0;
  const errors: string[] = [];
  for (const u of updates) {
    const l = state.lineByNum.get(u.line_num);
    if (!l) { errors.push(`Baris ${u.line_num} tidak ditemukan.`); continue; }
    if (!u.fields || typeof u.fields !== 'object') { errors.push(`Baris ${u.line_num}: fields tidak valid.`); continue; }
    const changed = applyLineEdit(l, u.fields);
    if (changed.length) edited++;
    else errors.push(`Baris ${u.line_num}: tidak ada field valid.`);
  }
  refreshAll();
  queueAutoSave();
  const parts = [`${edited} baris berhasil diedit.`];
  if (errors.length) parts.push(`Error: ${errors.join(' ')}`);
  return parts.join(' ');
}

// ── Agent Memory: Storage ───────────────────────────────────────────────────

const MEMORY_GLOBAL_KEY = 'cstl_agent_memory_global';
const MAX_MEMORIES = 50;

function getMemoryStorageKey(scope: MemoryScope): string {
  return scope === 'global'
    ? MEMORY_GLOBAL_KEY
    : state.currentProjectId
      ? `cstl_agent_memory_${state.currentProjectId}`
      : MEMORY_GLOBAL_KEY;
}

function loadMemoriesFromStorage(scope: MemoryScope): AgentMemory[] {
  try {
    const raw = localStorage.getItem(getMemoryStorageKey(scope));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((m: any) => m && m.key && m.value && m.category && m.scope);
  } catch {
    return [];
  }
}

function saveMemoriesToStorage(scope: MemoryScope, memories: AgentMemory[]): void {
  try {
    localStorage.setItem(getMemoryStorageKey(scope), JSON.stringify(memories));
  } catch (e) {
    console.warn('Gagal menyimpan agent memory:', e);
  }
}

export function loadAllAgentMemories(): void {
  const globalMems = loadMemoriesFromStorage('global');
  const projectMems = state.currentProjectId
    ? loadMemoriesFromStorage('project')
    : [];
  state.agentMemories = [...globalMems, ...projectMems];
}

// ── Agent Memory: Tools ──────────────────────────────────────────────────────

function getMemory(category?: string): string {
  let mems = state.agentMemories;
  if (category) {
    const cat = String(category).toLowerCase().trim();
    mems = mems.filter(m => m.category === cat);
  }
  if (!mems.length) return 'Tidak ada memori yang tersimpan.';
  const lines = ['=== MEMORI AI AGENT ==='];
  for (const m of mems) {
    lines.push(`[${m.scope}/${m.category}] ${m.key}: ${m.value}`);
  }
  return lines.join('\n');
}

function listMemory(): string {
  return getMemory();
}

function saveMemory(key: string, value: string, category: string, scope?: string): string {
  const k = String(key || '').trim();
  if (!k) return 'Error: key tidak boleh kosong.';
  const v = String(value || '').trim();
  if (!v) return 'Error: value tidak boleh kosong.';
  const validCategories: MemoryCategory[] = ['style', 'terminology', 'character', 'preference', 'note'];
  const cat = String(category || 'note').toLowerCase().trim() as MemoryCategory;
  if (!validCategories.includes(cat)) {
    return `Error: category tidak valid — "${category}". Pilihan: ${validCategories.join(', ')}.`;
  }
  const sc: MemoryScope = (scope === 'global' || scope === 'project') ? scope : 'project';

  const now = Date.now();
  const existing = state.agentMemories.findIndex(m => m.key === k && m.scope === sc);
  if (existing >= 0) {
    state.agentMemories[existing].value = v;
    state.agentMemories[existing].category = cat;
    state.agentMemories[existing].updated = now;
  } else {
    if (state.agentMemories.length >= MAX_MEMORIES) {
      return `Error: batas maksimum memori tercapai (${MAX_MEMORIES}). Hapus memori lama dengan deleteMemory().`;
    }
    state.agentMemories.push({ key: k, value: v, category: cat, scope: sc, created: now, updated: now });
  }

  // Persist ke localStorage
  const scopeMems = state.agentMemories.filter(m => m.scope === sc);
  saveMemoriesToStorage(sc, scopeMems);

  return `Memori "${k}" berhasil disimpan (${sc}/${cat}).`;
}

function deleteMemory(key: string): string {
  const k = String(key || '').trim();
  if (!k) return 'Error: key tidak boleh kosong.';
  const idx = state.agentMemories.findIndex(m => m.key === k);
  if (idx < 0) return `Error: memori "${k}" tidak ditemukan.`;
  const removed = state.agentMemories[idx];
  state.agentMemories.splice(idx, 1);
  // Persist
  if (removed) {
    const scopeMems = state.agentMemories.filter(m => m.scope === removed.scope);
    saveMemoriesToStorage(removed.scope, scopeMems);
  }
  return `Memori "${k}" berhasil dihapus.`;
}

// ── Agent Memory: System Prompt Injection ────────────────────────────────────

function buildMemoryPromptSection(): string {
  if (!state.agentMemories.length) return '';
  const globalMems = state.agentMemories.filter(m => m.scope === 'global');
  const projectMems = state.agentMemories.filter(m => m.scope === 'project');
  const parts: string[] = [];
  if (globalMems.length) {
    parts.push('MEMORI PENGGUNA (Global — berlaku untuk semua proyek):');
    for (const m of globalMems) {
      parts.push(`- [${m.category}] ${m.value}`);
    }
  }
  if (projectMems.length) {
    parts.push('\nMEMORI PROYEK INI:');
    for (const m of projectMems) {
      parts.push(`- [${m.category}] ${m.value}`);
    }
  }
  return parts.length ? parts.join('\n') : '';
}

// ── Web Search Tools: Wikipedia + Jisho + VNDB ───────────────────────────────

async function searchWikipedia(query: string, lang: string): Promise<string> {
  const l = lang || 'en';
  const url = `https://${l}.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json&origin=*&srlimit=5`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Wikipedia HTTP ${res.status}`);
  const data = await res.json();
  const results = data?.query?.search;
  if (!results || !results.length) return `Tidak ditemukan hasil Wikipedia untuk: "${query}"`;
  const lines: string[] = [`=== WIKIPEDIA (${l}) — "${query}" ===`];
  for (const r of results) {
    const snippet = String(r.snippet || '').replace(/<[^>]+>/g, '').trim();
    lines.push(`[${r.title}] ${snippet}`);
  }
  return lines.join('\n');
}

async function searchJisho(query: string): Promise<string> {
  const url = `https://jisho.org/api/v1/search/words?keyword=${encodeURIComponent(query)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Jisho HTTP ${res.status}`);
  const data = await res.json();
  const results = data?.data;
  if (!results || !results.length) return `Tidak ditemukan hasil Jisho untuk: "${query}"`;
  const lines: string[] = [`=== JISHO — "${query}" ===`];
  for (const r of results.slice(0, 5)) {
    const japanese = r.japanese?.[0];
    const word = japanese?.word || japanese?.reading || '?';
    const reading = japanese?.reading || '';
    const senses = (r.senses || []).slice(0, 3).map((s: any) => {
      const gloss = (s.english_definitions || []).join('; ');
      const pos = (s.parts_of_speech || []).join(', ');
      return `  ${pos ? `[${pos}] ` : ''}${gloss}`;
    });
    lines.push(`${word}${reading ? ` (${reading})` : ''}:\n${senses.join('\n')}`);
  }
  return lines.join('\n');
}

async function searchVndb(query: string): Promise<string> {
  const body = {
    filters: ['search', '=', query],
    fields: 'id,title,alttitle,devstatus,released,tags.name,length,rating',
    sort: 'searchrank',
    results: 5,
  };
  const res = await fetch('https://api.vndb.org/kana/vn', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`VNDB HTTP ${res.status}`);
  const data = await res.json();
  const results = data?.results;
  if (!results || !results.length) return `Tidak ditemukan hasil VNDB untuk: "${query}"`;
  const lines: string[] = [`=== VNDB — "${query}" ===`];
  for (const v of results) {
    const title = v.title || '?';
    const original = v.alttitle || '';
    const id = v.id || '';
    const released = v.released || '';
    const rating = v.rating ? ` ★${(v.rating / 10).toFixed(1)}` : '';
    const length = v.length ? ` [${v.length}]` : '';
    const tags = (v.tags || []).slice(0, 5).map((t: any) => t.name).join(', ');
    lines.push(`${id}: ${title}${original ? ` (${original})` : ''}${released ? ` [${released}]` : ''}${rating}${length}${tags ? `\n  Tags: ${tags}` : ''}`);
  }
  return lines.join('\n');
}

async function searchTavily(query: string): Promise<string> {
  const apiKey = (state as any).tavilyApiKey || '';
  if (!apiKey) return 'Error: Tavily API Key belum diset. Buka Pengaturan API → isi Tavily API Key. Daftar gratis di tavily.com';
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: apiKey,
      query: query,
      max_results: 5,
      include_answer: true,
    }),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Tavily HTTP ${res.status}: ${errText.slice(0, 200)}`);
  }
  const data = await res.json();
  const lines: string[] = [`=== TAVILY — "${query}" ===`];
  if (data?.answer) {
    lines.push(`Answer: ${data.answer}`);
  }
  const results = data?.results;
  if (results && results.length) {
    for (const r of results) {
      const title = r.title || '';
      const url = r.url || '';
      const content = String(r.content || '').replace(/<[^>]+>/g, '').trim().slice(0, 300);
      lines.push(`[${title}] ${url}\n  ${content}`);
    }
  } else if (!data?.answer) {
    return `Tidak ditemukan hasil Tavily untuk: "${query}"`;
  }
  return lines.join('\n');
}

async function webSearch(query: string, source: string): Promise<string> {
  const q = String(query || '').trim();
  if (!q) return 'Error: query tidak boleh kosong.';
  const s = String(source || 'auto').toLowerCase().trim();
  try {
    if (s === 'wikipedia' || s === 'wiki') {
      return await searchWikipedia(q, 'en');
    } else if (s === 'jisho') {
      return await searchJisho(q);
    } else if (s === 'vndb') {
      return await searchVndb(q);
    } else if (s === 'tavily') {
      return await searchTavily(q);
    } else {
      // auto: coba semua sumber yang relevan
      const results: string[] = [];
      const containsJp = /[\u3040-\u30ff\u4e00-\u9fff]/.test(q);
      if (containsJp) {
        try { results.push(await searchJisho(q)); } catch (e: any) { results.push(`Jisho error: ${e.message}`); }
      }
      try { results.push(await searchWikipedia(q, 'en')); } catch (e: any) { results.push(`Wikipedia error: ${e.message}`); }
      if (!containsJp) {
        try { results.push(await searchVndb(q)); } catch (e: any) { results.push(`VNDB error: ${e.message}`); }
        // Tavily sebagai fallback general search (jika API key tersedia)
        if ((state as any).tavilyApiKey) {
          try { results.push(await searchTavily(q)); } catch (e: any) { results.push(`Tavily error: ${e.message}`); }
        }
      }
      return results.length ? results.join('\n\n') : 'Tidak ada hasil.';
    }
  } catch (e: any) {
    return `Error saat web search: ${e.message}`;
  }
}

// ── Subagent Tools: delegate tasks to parallel AI calls ──────────────────────

/** Helper: build a translate prompt for a set of line numbers using the current selection trick. */
async function buildTranslatePrompt(lineNums: number[], instruction?: string): Promise<string> {
  const { buildSelectedTranslationExport, applyPromptVariables } = await import('./ai-format');
  const { getGlossaryPrompt } = await import('./glossary');
  const { DEFAULT_PROMPT_HEADER } = await import('./constants');

  const selectedLineNums = new Set(lineNums);
  const joinedText = buildSelectedTranslationExport(false, selectedLineNums);
  const glossaryBlock = getGlossaryPrompt(joinedText);

  const baseHeader = applyPromptVariables((state.aiInstructionHeader || DEFAULT_PROMPT_HEADER).trim());
  const extra = instruction ? `\n\nInstruction: ${instruction}` : '';
  const sections: string[] = [baseHeader];
  if (glossaryBlock) sections.push(glossaryBlock.trim());
  if (state.enableUncertainMarking) sections.push('If you are uncertain about a translation, prefix it with [?].');
  sections.push(joinedText.trim());
  return sections.join('\n\n') + extra;
}

/** Helper: run one translate worker for a chunk of line nums. Returns a status string. */
let delegatedApplyQueue: Promise<void> = Promise.resolve();

async function runTranslateWorker(lineNums: number[], instruction?: string): Promise<string> {
  const { fetchApiResult } = await import('./auto-translate');
  const Translate = await import('./translate');
  const { ui } = await import('./state');

  const prompt = await buildTranslatePrompt(lineNums, instruction);
  const result = await fetchApiResult(prompt);

  // The parser uses the shared paste area, so serialize only the apply step.
  const applyTask = delegatedApplyQueue.then(() => {
    const prevVal = (ui.pasteArea as HTMLTextAreaElement)?.value ?? '';
    if (ui.pasteArea) (ui.pasteArea as HTMLTextAreaElement).value = result;
    try {
      Translate.onApplyTranslation({ suppressAlerts: true, selectedLineNums: new Set(lineNums) });
    } catch (err: any) {
      throw new Error(`Apply error: ${err.message}`);
    } finally {
      if (ui.pasteArea) (ui.pasteArea as HTMLTextAreaElement).value = prevVal;
    }
  });
  delegatedApplyQueue = applyTask.catch(() => {});
  await applyTask;
  return `${lineNums.length} baris (${lineNums[0]}–${lineNums[lineNums.length - 1]})`;
}

async function delegateTranslate(lineNums: number[], instruction?: string): Promise<string> {
  if (!Array.isArray(lineNums) || lineNums.length === 0) return 'Error: lineNums tidak boleh kosong.';
  const hasInvalidInput = lineNums.some(n => {
    if (typeof n === 'number') return !Number.isInteger(n) || n <= 0;
    return typeof n !== 'string' || !/^\s*\d+\s*$/.test(n);
  });
  if (hasInvalidInput) return 'Error: lineNums harus berisi nomor baris yang valid.';
  const requested = [...new Set(lineNums.map(n => Number(n)))];
  const invalid = requested.filter(n => {
    const line = state.lineByNum.get(n);
    return !line || line._hidden || isTranslated(line);
  });
  if (invalid.length) return `Error: lineNums tidak valid untuk diterjemahkan: ${invalid.join(', ')}.`;
  const nums = requested;
  const lines = nums.map(n => state.lineByNum.get(n)).filter((l): l is Line => !!l);

  const chunkSize = state.selectionBatchSize || 25;
  const workers = Math.max(1, state.subagentWorkers || 3);

  // Split into chunks
  const chunks: number[][] = [];
  for (let i = 0; i < nums.length; i += chunkSize) chunks.push(nums.slice(i, i + chunkSize));

  if (chunks.length === 1) {
    // Single chunk — run directly
    try {
      const msg = await runTranslateWorker(nums, instruction);
      return `Berhasil menerjemahkan ${msg}.`;
    } catch (err: any) {
      return `Error: ${err.message}`;
    }
  }

  // Multiple chunks — run in parallel batches of `workers`
  const results: string[] = [];
  const errors: string[] = [];
  for (let i = 0; i < chunks.length; i += workers) {
    const batch = chunks.slice(i, i + workers);
    const settled = await Promise.allSettled(batch.map(chunk => runTranslateWorker(chunk, instruction)));
    for (const r of settled) {
      if (r.status === 'fulfilled') results.push(r.value);
      else errors.push(r.reason?.message || String(r.reason));
    }
  }

  const summary = `Berhasil menerjemahkan ${results.length}/${chunks.length} chunk (${lines.length} baris total).`;
  return errors.length ? `${summary}\nError: ${errors.join('; ')}` : summary;
}

async function delegateAnalyze(lineNums: number[], focus?: string): Promise<string> {
  const nums = Array.isArray(lineNums) ? lineNums.filter(n => n > 0) : [];
  if (!nums.length) return 'Error: lineNums tidak boleh kosong.';
  const lines = nums.map(n => state.lineByNum.get(n)).filter(l => l);
  if (!lines.length) return 'Error: tidak ada baris yang ditemukan.';

  const { fetchApiResult } = await import('./auto-translate');
  const chunkSize = state.selectionBatchSize || 25;
  const workers = Math.max(1, state.subagentWorkers || 3);
  const focusStr = focus ? `\n\nFocus: ${focus}` : '';

  function buildAnalyzePrompt(chunk: typeof lines): string {
    const out = chunk.map(l => {
      let namePart = '';
      if (l.name) namePart = l.trans_name ? `${l.trans_name}: ` : `${l.name}: `;
      return `#${l.line_num}\n[Original] ${namePart}${l.message}\n[Translated] ${namePart}${l.trans_message || ''}`;
    });
    return `You are a translation quality analyst. Analyze the following translations and report issues (accuracy, naturalness, consistency, missing nuance). Be concise.\n\n${out.join('\n\n')}${focusStr}`;
  }

  // Split into chunks
  const chunks: typeof lines[] = [];
  for (let i = 0; i < lines.length; i += chunkSize) chunks.push(lines.slice(i, i + chunkSize));

  if (chunks.length === 1) {
    try {
      const result = await fetchApiResult(buildAnalyzePrompt(chunks[0]));
      return `=== ANALISIS SUBAGENT (${lines.length} baris) ===\n${result}`;
    } catch (err: any) {
      return `Error saat delegate analyze: ${err.message}`;
    }
  }

  const reports: string[] = [];
  const errors: string[] = [];
  for (let i = 0; i < chunks.length; i += workers) {
    const batch = chunks.slice(i, i + workers);
    const settled = await Promise.allSettled(batch.map(chunk => fetchApiResult(buildAnalyzePrompt(chunk))));
    for (let j = 0; j < settled.length; j++) {
      const r = settled[j];
      const chunk = batch[j];
      if (r.status === 'fulfilled') {
        reports.push(`--- Baris ${chunk[0].line_num}–${chunk[chunk.length - 1].line_num} ---\n${r.value}`);
      } else {
        errors.push(`Chunk ${chunk[0].line_num}–${chunk[chunk.length - 1].line_num}: ${r.reason?.message || r.reason}`);
      }
    }
  }

  const header = `=== ANALISIS SUBAGENT (${lines.length} baris, ${chunks.length} chunk) ===`;
  const body = reports.join('\n\n');
  return errors.length ? `${header}\n${body}\n\nError:\n${errors.join('\n')}` : `${header}\n${body}`;
}

/** delegateParallelTranslate — high-level orchestrator: translate a LINE RANGE in parallel. */
async function delegateParallelTranslate(
  startLine: number,
  endLine: number,
  instruction?: string,
  onProgress?: (msg: string) => void
): Promise<string> {
  const start = Number(startLine) || 1;
  const end = Number(endLine) || start;
  if (start > end) return 'Error: startLine harus <= endLine.';

  const targetLines = state.lines.filter(l =>
    l.line_num >= start && l.line_num <= end && !l._hidden && !isTranslated(l)
  );
  if (!targetLines.length) return `Error: tidak ada baris di rentang ${start}–${end}.`;

  const chunkSize = state.selectionBatchSize || 25;
  const workers = Math.max(1, state.subagentWorkers || 3);

  // Build chunks
  const chunks: number[][] = [];
  for (let i = 0; i < targetLines.length; i += chunkSize) {
    chunks.push(targetLines.slice(i, i + chunkSize).map(l => l.line_num));
  }

  const startTime = Date.now();
  let completedChunks = 0;
  const errors: string[] = [];

  for (let i = 0; i < chunks.length; i += workers) {
    const batch = chunks.slice(i, i + workers);
    const settled = await Promise.allSettled(
      batch.map(chunk => runTranslateWorker(chunk, instruction))
    );
    for (let j = 0; j < settled.length; j++) {
      const r = settled[j];
      completedChunks++;
      if (r.status === 'fulfilled') {
        onProgress?.(`Subagent ${completedChunks}/${chunks.length}: Selesai ${r.value}`);
      } else {
        const errMsg = r.reason?.message || String(r.reason);
        errors.push(`Chunk ${batch[j][0]}–${batch[j][batch[j].length - 1]}: ${errMsg}`);
        onProgress?.(`Subagent ${completedChunks}/${chunks.length}: Error — ${errMsg}`);
      }
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const ok = completedChunks - errors.length;
  const summary = `Selesai: ${ok}/${chunks.length} chunk berhasil (${targetLines.length} baris, ${workers} worker paralel, ${elapsed}s).`;
  return errors.length ? `${summary}\nError:\n${errors.join('\n')}` : summary;
}

/** delegateGlossaryExtract — parallel glossary extraction across multiple queries. */
async function delegateGlossaryExtract(queries: string[], source: string = 'vndb'): Promise<string> {
  if (!Array.isArray(queries) || !queries.length) return 'Error: queries harus berupa array string.';
  const workers = Math.max(1, state.subagentWorkers || 3);

  const results: string[] = [];
  const errors: string[] = [];

  for (let i = 0; i < queries.length; i += workers) {
    const batch = queries.slice(i, i + workers);
    const settled = await Promise.allSettled(batch.map(q => extractGlossary(q, source)));
    for (let j = 0; j < settled.length; j++) {
      const r = settled[j];
      if (r.status === 'fulfilled') results.push(`[${batch[j]}]\n${r.value}`);
      else errors.push(`[${batch[j]}]: ${r.reason?.message || r.reason}`);
    }
  }

  const header = `=== GLOSSARY EXTRACT (${queries.length} query, source: ${source}) ===`;
  const body = results.join('\n\n');
  return errors.length ? `${header}\n${body}\n\nError:\n${errors.join('\n')}` : `${header}\n${body}`;
}

// ── Tool 26: searchVn — search VN/anime by name ──────────────────────────────
async function searchVn(query: string, source: string = 'vndb'): Promise<string> {
  if (!query?.trim()) return 'Error: query tidak boleh kosong.';
  const q = query.trim();

  if (source === 'anilist') {
    const results = await fetchAnilistMediaByName(q);
    if (!results.length) return `Tidak ditemukan media AniList untuk "${q}".`;
    const lines = results.map((m: any) => {
      const t = m.title || {};
      const romaji = t.romaji || '?';
      const english = t.english ? ` / ${t.english}` : '';
      const native = t.native ? ` / ${t.native}` : '';
      return `AniList ID ${m.id}: ${romaji}${english}${native} [${m.format || m.type || '?'}]`;
    });
    return `Ditemukan ${results.length} media AniList:\n${lines.join('\n')}`;
  }

  // default: vndb
  const results = await fetchVndbVnByName(q);
  if (!results.length) return `Tidak ditemukan VN di VNDB untuk "${q}".`;
  const lines = results.map((vn: any) => {
    const alt = vn.alttitle ? ` / ${vn.alttitle}` : '';
    const tags = Array.isArray(vn.tags) && vn.tags.length ? ` [${vn.tags.slice(0, 3).map((t: any) => t.name || t).join(', ')}]` : '';
    return `VNDB ${vn.id}: ${vn.title}${alt} [${vn.released || '?'}]${tags}`;
  });
  return `Ditemukan ${results.length} VN:\n${lines.join('\n')}`;
}

// ── Tool 27: extractGlossary — auto-extract glossary from VNDB/AniList ───────
async function extractGlossary(query: string, source: string = 'vndb'): Promise<string> {
  if (!query?.trim()) return 'Error: query tidak boleh kosong.';
  const q = query.trim();

  try {
    let entries: Map<string, any>;
    let charCount = 0;
    let appliedResult: { appliedNames: number; appliedLines: number } | null = null;

    if (source === 'anilist') {
      const mediaResults = await fetchAnilistMediaByName(q);
      if (!mediaResults.length) return `Tidak ditemukan media AniList untuk "${q}".`;
      const first = mediaResults[0];
      const title = first.title?.romaji || first.title?.english || `ID ${first.id}`;
      const media = await fetchAnilistMediaCharacters(String(first.id));
      const chars = Array.isArray(media?.characters?.edges) ? media.characters.edges.map((e: any) => e.node) : [];
      charCount = chars.length;
      if (!charCount) return `Tidak ada karakter di AniList untuk "${title}".`;
      entries = collectAnilistGlossaryEntries(media);
    } else {
      // vndb: search by name → get ID → fetch characters
      const vnResults = await fetchVndbVnByName(q);
      if (!vnResults.length) return `Tidak ditemukan VN di VNDB untuk "${q}".`;
      const vn = vnResults[0];
      const chars = await fetchVndbCharacters(vn.id);
      charCount = chars.length;
      if (!charCount) return `Tidak ada karakter di VNDB untuk ${vn.id}: ${vn.title}.`;
      entries = collectVndbGlossaryEntries(chars);
      // Also apply name translations directly to name table
      appliedResult = applyVndbNameTranslations(chars);
    }

    const before = state.glossaryText || '';
    mergeGlossaryEntries(entries);
    const after = state.glossaryText || '';

    // Count new entries added
    let added = 0;
    if (after && after !== before) {
      const beforeLines = before ? before.split('\n').filter((l: string) => l.trim()) : [];
      const afterLines = after.split('\n').filter((l: string) => l.trim());
      added = afterLines.length - beforeLines.length;
    }

    // Refresh UI
    renderGlossaryPreview();
    queueAutoSave();

    let msg = `Berhasil extract glossary dari ${source === 'anilist' ? 'AniList' : 'VNDB'}.\n`;
    msg += `Karakter ditemukan: ${charCount}\n`;
    msg += `Entri glossary baru: ${added > 0 ? added : '0 (mungkin sudah ada sebelumnya)'}\n`;
    if (appliedResult && (appliedResult.appliedNames > 0 || appliedResult.appliedLines > 0)) {
      msg += `Nama langsung di-apply ke name table: ${appliedResult.appliedNames} nama (${appliedResult.appliedLines} baris)\n`;
    }
    msg += `\nGlossary saat ini:\n${state.glossaryText || '(kosong)'}`;
    return msg;
  } catch (err: any) {
    return `Error saat extract glossary: ${err.message}`;
  }
}

/** Known tool names — used for typo suggestions. */
const TOOL_NAMES = [
  'getProjectStats', 'getLines', 'getContext', 'searchLines', 'getCharacterNames',
  'analyzeQuality', 'getProgressReport', 'applyTranslations', 'editLine', 'editLines',
  'clearTranslations', 'undoLastAction', 'redoLastAction', 'getGlossary', 'editPrompt',
  'editGlossary', 'listSettings', 'toggleSetting', 'getMemory', 'listMemory', 'saveMemory',
  'deleteMemory', 'webSearch', 'delegateTranslate', 'delegateAnalyze',
  'delegateParallelTranslate', 'delegateGlossaryExtract', 'searchVn', 'extractGlossary',
];

/** Closest known tool name by case-insensitive/plural/substring match. */
function suggestToolName(name: string): string | null {
  const n = String(name || '').trim();
  if (!n) return null;
  const lower = n.toLowerCase();
  const exact = TOOL_NAMES.find(t => t.toLowerCase() === lower);
  if (exact) return exact;
  // Common typos: missing or extra plural 's'.
  for (const t of TOOL_NAMES) {
    const tl = t.toLowerCase();
    if (tl === lower + 's' || tl === lower.replace(/s$/, '')) return t;
  }
  // Substring containment (either direction) as a weak fallback.
  return TOOL_NAMES.find(t => {
    const tl = t.toLowerCase();
    return tl.includes(lower) || lower.includes(tl);
  }) || null;
}

/** Coerces "123"/123/" 123 " style inputs to a line number. */
function coerceLineNum(v: unknown): number {
  const n = typeof v === 'number' ? v : parseInt(String(v ?? '').trim(), 10);
  return Number.isInteger(n) ? n : NaN;
}

async function executeTool(
  name: string,
  args: any,
  onProgress?: (msg: string) => void
): Promise<string> {
  // Tool errors must never kill the agent turn — the model reads the error
  // text and self-corrects on its next turn. Previously a single throwing
  // tool (e.g. a network failure in webSearch) aborted the whole conversation.
  const safe = (fn: () => string | Promise<string>): Promise<string> =>
    Promise.resolve()
      .then(fn)
      .catch((e: any) => `Error: ${e?.message || String(e)}`);

  const a = (args && typeof args === 'object') ? args : {};

  switch (name) {
    case 'getProjectStats': return safe(getProjectStats);
    case 'getLines': return safe(() => getLines(coerceLineNum(a.start), coerceLineNum(a.end)));
    case 'getContext': return safe(() => getContext(coerceLineNum(a.line_num ?? a.lineNum ?? a.num), Number(a.radius)));
    case 'searchLines': return safe(() => searchLines(String(a.query ?? a.q ?? '')));
    case 'getCharacterNames': return safe(getCharacterNames);
    case 'analyzeQuality': return safe(() => analyzeQuality(Number(a.limit)));
    case 'getProgressReport': return safe(getProgressReport);
    case 'applyTranslations': return safe(() => applyTranslations(a.updates ?? a.translations));
    case 'editLine': return safe(() => editLine(coerceLineNum(a.line_num ?? a.lineNum ?? a.num), a.fields));
    case 'editLines': return safe(() => editLines(a.updates));
    case 'clearTranslations': return safe(() => {
      const cleared = clearAgentTranslations(a.line_nums ?? a.lineNums);
      return `Berhasil menghapus terjemahan untuk ${cleared} baris.`;
    });
    case 'undoLastAction': return safe(() => { onUndoLastApply(); return 'Aksi terakhir berhasil dibatalkan.'; });
    case 'redoLastAction': return safe(() => { onRedoLastUndo(); return 'Aksi yang dibatalkan berhasil dikembalikan.'; });
    case 'getGlossary': return safe(() => state.glossaryText || 'Glosarium belum didefinisikan.');
    case 'editPrompt': return safe(() => editPrompt(a.prompt_type, a.new_prompt));
    case 'editGlossary': return safe(() => editGlossary(a.new_glossary));
    case 'toggleSetting': return safe(() => toggleSetting(a.setting_name, a.value));
    case 'listSettings': return safe(listSettings);
    case 'getMemory': return safe(() => getMemory(a.category));
    case 'listMemory': return safe(listMemory);
    case 'saveMemory': return safe(() => saveMemory(a.key, a.value, a.category, a.scope));
    case 'deleteMemory': return safe(() => deleteMemory(a.key));
    case 'webSearch': return safe(() => webSearch(String(a.query ?? a.q ?? ''), a.source));
    case 'delegateTranslate': return safe(() => delegateTranslate(a.lineNums ?? a.line_nums, a.instruction));
    case 'delegateAnalyze': return safe(() => delegateAnalyze(a.lineNums ?? a.line_nums, a.focus));
    case 'delegateParallelTranslate': return safe(() => delegateParallelTranslate(coerceLineNum(a.startLine ?? a.start_line), coerceLineNum(a.endLine ?? a.end_line), a.instruction, onProgress));
    case 'delegateGlossaryExtract': return safe(() => delegateGlossaryExtract(a.queries, a.source));
    case 'searchVn':
      return safe(() => searchVn(String(a.query ?? a.q ?? ''), a.source));
    case 'extractGlossary':
      return safe(() => extractGlossary(String(a.query ?? a.q ?? ''), a.source));
    default: {
      // A typo'd tool name should come back as a *usable* error with the right
      // name, not a dead end.
      const suggestion = suggestToolName(name);
      const hint = suggestion
        ? `Mungkin maksudmu "${suggestion}"?`
        : 'Gunakan salah satu tool dari DAFTAR TOOL di system prompt.';
      return `Error: Tool tidak dikenal — "${name}". ${hint}`;
    }
  }
}

// ------------------------------------------------------------------
// Response Parser — JSON with fallback
// ------------------------------------------------------------------

/** Short human-readable description of a tool call for the activity line. */
function describeToolCall(name: string, args: any): string {
  const a = args || {};
  switch (name) {
    case 'getLines':
      return `getLines(${a.start}–${a.end})`;
    case 'getContext':
      return `getContext(${a.line_num}, r=${a.radius})`;
    case 'searchLines':
    case 'webSearch':
      return `${name}("${String(a.query ?? '').slice(0, 40)}")`;
    case 'applyTranslations':
      return `applyTranslations(${Array.isArray(a.updates) ? a.updates.length : '?'} baris)`;
    case 'editLines':
      return `editLines(${Array.isArray(a.updates) ? a.updates.length : '?'} baris)`;
    case 'delegateParallelTranslate':
      return `delegateParallelTranslate(${a.startLine}–${a.endLine})`;
    case 'delegateTranslate':
    case 'delegateAnalyze': {
      const nums = a.lineNums || a.line_nums;
      return `${name}(${Array.isArray(nums) ? nums.length + ' baris' : '?'})`;
    }
    case 'toggleSetting':
      return `toggleSetting(${a.setting_name}=${String(a.value ?? '')})`;
    case 'saveMemory':
      return `saveMemory("${String(a.key ?? '').slice(0, 24)}")`;
    default:
      return name;
  }
}

interface ParsedToolCalls {
  calls: { name: string; arguments: any }[];
  raw: string;
}

function parseToolCalls(text: string): ParsedToolCalls | null {
  let jsonStr = stripCodeFences(text.trim());

  // Strategy 1: Try direct JSON parse
  try {
    const obj = JSON.parse(jsonStr);
    return extractCallsFromObject(obj, text);
  } catch { /* fall through */ }

  // Strategy 2: Brace-balanced JSON objects in the text, first parse wins.
  // A greedy {.*} match (the old approach) breaks when the model wraps its
  // JSON in prose that itself contains braces; a single first-object scan
  // breaks when that prose appears BEFORE the JSON. Iterate instead.
  let from = 0;
  while (true) {
    const candidate = nextBalancedObject(jsonStr, from);
    if (!candidate) break;
    from = candidate.end;
    try {
      const obj = JSON.parse(candidate.text);
      return extractCallsFromObject(obj, text);
    } catch { /* try the next balanced object */ }
  }

  // Strategy 3: Truncated responses (max-tokens cutoff) leave a JSON object
  // missing its closing braces. The salvage parser keeps every complete field.
  const salvaged = salvageJsonObject(jsonStr);
  if (salvaged) {
    const parsed = extractCallsFromObject(salvaged, text);
    if (parsed && parsed.calls.length > 0) return parsed;
  }

  return null;
}

/** Removes markdown code fences around the whole response. */
function stripCodeFences(s: string): string {
  const m = s.match(/^```(?:json|tool_call)?\s*\n?([\s\S]*?)\n?```\s*$/i);
  if (m) return m[1].trim();
  // Old ```tool_call format embedded mid-text (backward compat)
  const embedded = s.match(/```tool_call\s*\n([\s\S]*?)\n```/i);
  if (embedded) return embedded[1].trim();
  return s;
}

/**
 * Finds the next brace-balanced top-level object literal at or after `from`.
 * String/escape aware, so braces inside string values do not confuse the scan.
 * Returns `{ text, end }` or null when no (more) object exists.
 */
function nextBalancedObject(s: string, from: number): { text: string; end: number } | null {
  const start = s.indexOf('{', from);
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inString) {
      if (escaped) { escaped = false; continue; }
      if (c === '\\') { escaped = true; continue; }
      if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; continue; }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return { text: s.slice(start, i + 1), end: i + 1 };
    }
  }
  return null; // unterminated
}

function extractCallsFromObject(obj: any, raw: string): ParsedToolCalls {
  const calls: { name: string; arguments: any }[] = [];
  // Multiple tools format
  if (Array.isArray(obj.tool_calls)) {
    for (const c of obj.tool_calls) {
      if (c.name) calls.push({ name: c.name, arguments: c.arguments || {} });
      else if (c.tool) calls.push({ name: c.tool, arguments: c.arguments || {} });
    }
  }
  // Single tool format (backward compat)
  else if (obj.tool) {
    calls.push({ name: obj.tool, arguments: obj.arguments || {} });
  }
  return { calls, raw };
}

// ------------------------------------------------------------------
// Context Compaction
// ------------------------------------------------------------------

async function compactContextIfNeeded(onUpdate: (msg: string, role: 'assistant' | 'system') => void): Promise<void> {
  const nonSystem = chatHistory.filter(m => m.role !== 'system');
  const totalChars = nonSystem.reduce((sum, m) => sum + m.content.length, 0);
  if (totalChars <= COMPACTION_THRESHOLD) return;

  onUpdate('Compacting context...', 'system');

  // Ask the AI to summarize everything so far
  const summaryMessages: ChatMessage[] = [
    { role: 'system', content: 'You are a conversation summarizer. Summarize the following conversation concisely. Include important context, decisions made, character names established, and any translations applied. Be concise but preserve key details.' },
    { role: 'user', content: nonSystem.map(m => `[${m.role}]: ${m.content}`).join('\n\n') }
  ];

  const summary = await chatCompletion(summaryMessages);

  // Replace all messages with: system prompt + summary
  chatHistory.length = 0;
  chatHistory.push({ role: 'system', content: buildSystemPrompt() });
  chatHistory.push({ role: 'assistant', content: `[Summary of previous conversation]\n${summary}` });
  saveChatHistory();
}

// ------------------------------------------------------------------
// System Prompt
// ------------------------------------------------------------------

function buildSystemPrompt(): string {
  const visible = state.lines.filter(l => !l._hidden);
  const total = visible.length;
  const rawTotal = state.lines.length;
  const translated = visible.filter(l => l.is_translated).length;

  return `Kamu adalah CSTL AI Agent, asisten terjemahan visual novel yang terintegrasi di dalam aplikasi CSTL Visual Novel Translation Editor. Kamu membantu pengguna menerjemahkan skrip, menjawab pertanyaan tentang proyek, menganalisis kualitas terjemahan, dan memodifikasi data terjemahan.

INFO PROYEK:
- Bahasa: ${state.sourceLang} -> ${state.targetLang}
- Total Baris: ${total}${rawTotal > total ? ` (${rawTotal - total} terfilter)` : ''}
- Sudah Diterjemahkan: ${translated}
${buildMemoryPromptSection()}
## DAFTAR TOOL

| Tool | Fungsi |
|---|---|
| getProjectStats() | Ringkasan progress, jumlah baris, daftar file |
| getLines(start, end) | Teks asli + terjemahan rentang baris |
| getContext(line_num, radius=3) | Konteks sekitar satu baris (radius 1-20) |
| searchLines(query) | Cari di teks asli/terjemahan/nama (maks 50) |
| getCharacterNames() | Nama karakter + terjemahan; inkonsistensi ditandai |
| analyzeQuality(limit=20) | Masalah kualitas: belum terjemah, terlalu pendek, nama inkonsisten |
| getProgressReport() | Progress per file |
| applyTranslations(updates) | Terapkan terjemahan: [{num, trans_message, trans_name?}] |
| editLine(line_num, fields) / editLines(updates) | Edit field baris (message, name, trans_message, trans_name, is_translated, file, _hidden, luca_*, epub_*) |
| clearTranslations(line_nums) | Hapus terjemahan baris tertentu |
| undoLastAction() / redoLastAction() | Batalkan / kembalikan aksi terakhir |
| getGlossary() / editGlossary(new_glossary) | Baca / tulis glosarium |
| editPrompt(prompt_type, new_prompt) | Edit prompt: translation, glossary, ai_check, agent |
| listSettings() / toggleSetting(name, value) | Lihat / ubah setting aplikasi |
| getMemory(category?) / listMemory() / saveMemory(key, value, category, scope?) / deleteMemory(key) | Memori persisten |
| webSearch(query, source?) | Cari web: wikipedia, jisho (kamus JP), vndb, tavily (perlu API key), auto |
| delegateParallelTranslate(startLine, endLine, instruction?) | Terjemahkan rentang baris via subagent paralel — PAKE INI untuk rentang besar (>30 baris) |
| delegateTranslate(lineNums, instruction?) | Terjemahkan kumpulan baris spesifik via subagent |
| delegateAnalyze(lineNums, focus?) | Analisis kualitas terjemahan via subagent |
| delegateGlossaryExtract(queries, source?) | Ekstrak glosarium paralel dari beberapa VN/anime |
| searchVn(query, source?) | Cari VN/anime by nama (vndb/anilist) |
| extractGlossary(query, source?) | Ekstrak glosarium dari karakter VN/anime |

## FORMAT RESPONS WAJIB

Memanggil tool (bisa beberapa sekaligus) — BALAS HANYA dengan JSON, tanpa teks lain, tanpa markdown fence:
{"tool_calls": [{"name": "getLines", "arguments": {"start": 100, "end": 105}}, {"name": "getGlossary", "arguments": {}}]}

Balasan biasa tanpa tool: tulis teks biasa (bukan JSON).
Sistem akan mengeksekusi tool dan mengirim hasilnya sebagai pesan user internal. Tunggu hasil sebelum melanjutkan.

## PROTOKOL ERROR

- Hasil tool berawalan "Error:" = panggilan gagal. Baca alasannya, perbaiki argument-nya, lalu panggil ulang tool yang sama. JANGAN menebak hasil.
- Jika JSON-mu ditolak karena malformed/terpotong, ulangi HANYA JSON-nya — jangan tambahkan penjelasan.

## ATURAN TERJEMAHAN

- Sebelum menerjemahkan: ambil baris dulu (getLines/getContext), baca glosarium (getGlossary) dan nama karakter (getCharacterNames) bila relevan.
- Menerjemahkan sendiri: gunakan applyTranslations. WAJIB sertakan trans_name untuk baris yang punya nama karakter.
- Rentang besar (>30 baris): JANGAN terjemahkan manual satu-satu — gunakan delegateParallelTranslate(startLine, endLine). Ia memakai pipeline terjemahan lengkap (prompt, glosarium, konteks) dengan worker paralel.
- Perbaiki terjemahan spesifik yang sudah ada: delegateAnalyze untuk menemukan masalahnya, lalu applyTranslations/editLines untuk memperbaiki.
- Perubahan selalu bisa dibatalkan pengguna lewat undoLastAction — jangan ragu menerapkan, tapi jangan menimpa terjemahan yang sudah baik tanpa alasan.

## PROTOKOL KONFIRMASI

- editPrompt, editGlossary, toggleSetting: tampilkan nilai saat ini dulu, lalu konfirmasi dengan pengguna sebelum mengubah.
- Nama karakter inkonsisten: sarankan perbaikan, minta konfirmasi sebelum menerapkan.
- applyTranslations/editLines/clearTranslations pada baris yang diminta user: langsung terapkan.

## MEMORI OTOMATIS

Simpan memori SECARA OTOMATIS (tanpa menunggu perintah) ketika:
(1) Koreksi user mengungkap preferensi style (mis. "jangan pakai 'kamu', pakai nama") -> saveMemory category "style", scope "global"
(2) User konfirmasi keputusan nama/istilah (mis. "iya, スピカ = Spica") -> category "character", scope "project"
(3) User menyatakan preferensi terjemahan langsung (mis. "aku suka terjemahan natural") -> category "preference", scope "global"
(4) Pola yang sama dikoreksi 2+ kali -> langsung simpan
(5) User memberi konteks cerita/tone (mis. "VN ini school life romantis") -> category "note", scope "project"
Hapus memori outdated dengan deleteMemory. Jangan simpan hal trivial atau progres terjemahan. Setelah menyimpan, beri tahu user singkat: "(Tersimpan di memori: ...)"

## GAYA

- Jawab dalam Bahasa Indonesia kecuali diminta sebaliknya.
- Jangan tampilkan proses berpikir internal. Langsung jawab atau panggil tool.
- Untuk pertanyaan tentang proyek, gunakan tool untuk mendapat data aktual — jangan mengarang angka.`;
}

// ------------------------------------------------------------------
// ReAct Agent Engine
// ------------------------------------------------------------------

export const chatHistory: ChatMessage[] = [];

export async function sendAgentMessage(
  userMessage: string,
  onUpdate: (msg: string, role: 'assistant' | 'system', meta?: { streaming?: boolean }) => void
): Promise<void> {
  // Ensure system prompt is fresh
  if (chatHistory.length === 0 || chatHistory[0].role !== 'system') {
    chatHistory.unshift({ role: 'system', content: buildSystemPrompt() });
  } else {
    // Refresh system prompt with current stats
    chatHistory[0].content = buildSystemPrompt();
  }

  // Compact if needed
  await compactContextIfNeeded(onUpdate);

  chatHistory.push({ role: 'user', content: userMessage });
  saveChatHistory();

  let loopCount = 0;
  // The Settings UI exposes agentMaxTurns (3–30); the chat loop must honor it
  // instead of the previously hardcoded 15.
  const maxLoops = Math.min(30, Math.max(1, state.agentMaxTurns || 10));
  const startEpoch = currentAbortEpoch();

  let finishedWithReply = false;
  let userStopped = false;
  while (loopCount < maxLoops) {
    // Stop pressed between turns (e.g. while a local tool runs): bail out
    // instead of starting another model round-trip.
    if (currentAbortEpoch() > startEpoch) { userStopped = true; break; }
    loopCount++;
    onUpdate('Memproses...', 'system');

    let responseText = '';
    let streamedVisible = false;
    try {
      responseText = await chatCompletion(chatHistory, {
        onDelta: (_delta, fullText) => {
          // Live stream only while text looks like a normal reply (not pure tool JSON).
          // During tool-call JSON we keep "Memproses..." until parse finishes.
          const looksLikeTool =
            /^\s*\{/.test(fullText) ||
            /"tool"\s*:/.test(fullText) ||
            /```json\s*\{/.test(fullText);
          if (!looksLikeTool && fullText.trim()) {
            streamedVisible = true;
            // Same display filter as the translation pipelines — a reasoning
            // model's <think> block must not flash into the chat while streaming.
            const display = state.aiFilterThinkingOutput
              ? stripThinkingTagsForStream(fullText)
              : fullText;
            if (display.trim()) onUpdate(display, 'assistant', { streaming: true });
          }
        },
      });
    } catch (e: any) {
      // API errors are UI-only — persisting them as an assistant message used
      // to poison the conversation (the model saw its own "error" as text on
      // reload) and pushed junk into future prompts.
      throw e;
    }

    // Try to parse tool calls
    const parsed = parseToolCalls(responseText);

    // The response *looks* like a tool call (starts with {) but failed every
    // parse strategy — usually truncated output or malformed JSON. Corrective
    // retry: tell the model what broke instead of dumping raw JSON into the
    // chat as a "reply".
    const looksLikeTool = /^\s*\{/.test(responseText) || /```json\s*\{/.test(responseText);
    if (!parsed && looksLikeTool) {
      chatHistory.push({ role: 'assistant', content: responseText, _internal: true });
      chatHistory.push({
        role: 'user',
        content:
          'Error: Respons JSON-mu tidak bisa diparse (kemungkinan terpotong atau malformed). '
          + 'JANGAN ulangi seluruh tool call sebelumnya. Respon ulang HANYA dengan JSON valid '
          + 'berformat {"tool_calls": [{"name": ..., "arguments": {...}}]} — tanpa teks lain, '
          + 'tanpa markdown fence, pastikan semua string tertutup dan objek seimbang.',
        _internal: true,
      });
      saveChatHistory();
      continue;
    }

    chatHistory.push({ role: 'assistant', content: responseText, _internal: !!(parsed && parsed.calls.length > 0) });
    saveChatHistory();

    if (parsed && parsed.calls.length > 0) {
      // Describe each call with its key argument so the user can follow what
      // the agent is actually doing, not just which tool fired.
      const described = parsed.calls.map(c => describeToolCall(c.name, c.arguments)).join(', ');
      onUpdate(`Menggunakan tool: ${described}...`, 'system');

      // Independent read-only calls run in parallel; state-mutating calls and
      // anything with progress callbacks stay sequential so their order and
      // undo snapshots remain deterministic.
      const READ_ONLY_TOOLS = new Set([
        'getProjectStats', 'getLines', 'getContext', 'searchLines', 'getCharacterNames',
        'analyzeQuality', 'getProgressReport', 'getGlossary', 'listSettings',
        'getMemory', 'listMemory', 'webSearch', 'searchVn',
      ]);
      const calls = parsed.calls;
      const parallelizable = calls.length > 1 && calls.every(c => READ_ONLY_TOOLS.has(c.name));

      let results: string[];
      if (parallelizable) {
        const settled = await Promise.all(calls.map(c => executeTool(c.name, c.arguments)));
        results = settled;
      } else {
        results = [];
        for (const call of calls) {
          results.push(await executeTool(call.name, call.arguments, (msg) => onUpdate(msg, 'system')));
        }
      }

      // Bound each tool result so a 50-hit searchLines cannot inject 10k+
      // characters into the context on every turn.
      const TOOL_RESULT_LIMIT = 6000;
      const toolResults = calls.map((call, i) => {
        const clipped = results[i].length > TOOL_RESULT_LIMIT
          ? results[i].slice(0, TOOL_RESULT_LIMIT) + `\n…(terpotong — ${results[i].length - TOOL_RESULT_LIMIT} karakter lagi; persempit query atau minta rentang lebih kecil)`
          : results[i];
        return `Tool "${call.name}" result:\n${clipped}`;
      });

      chatHistory.push({ role: 'user', content: toolResults.join('\n\n'), _internal: true });
      saveChatHistory();
      // Loop continues — AI can call more tools or respond with text
    } else {
      // No tool call — plain text response, conversation turn ended
      // Final paint without streaming cursor (even if already streamed)
      onUpdate(responseText || (streamedVisible ? '' : '(kosong)'), 'assistant', { streaming: false });
      finishedWithReply = true;
      break;
    }
  }

  // Turn budget exhausted without a final text reply: the loop above exits
  // silently, so tell the user what happened instead of freezing the UI.
  if (!finishedWithReply) {
    if (userStopped) {
      onUpdate('⏹ Dibatalkan.', 'system');
    } else {
      onUpdate(
        `⚠️ Batas ${maxLoops} giliran tool tercapai sebelum agent selesai. Naikkan "Max Turn" di pengaturan atau lanjutkan dengan instruksi baru.`,
        'system'
      );
    }
  }
}
