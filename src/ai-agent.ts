import { state, ui, isTranslated } from './state';
import { scrollPreviewToLine } from './selection';
import { getSessionData, deleteSessionData, deriveSessionName, legacyChatKey, persistActiveSession, renderSessionList, renameSession } from './agent-sessions';
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
import { escapeStoredNewlines } from './string-utils';

export { chatCompletion, type ChatMessage, type ChatRole };
export type { StreamDeltaCallback } from './ai-client';

// Token-based compaction lives in agent-context.ts (script-aware token
// estimation + per-model context window). No legacy constant needed.
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
 * paragraph-level fenced code blocks. Line-number references ([line N] /
 * [Baris N] / [N]) become clickable jump links.
 */
export function renderAgentMessageContent(content: string, opts: { linkLines?: boolean } = {}): string {
  const escaped = String(content ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  let html = escaped
    .replace(/```(?:[a-z0-9_-]*)\n?([\s\S]*?)```/gi, (_m, code: string) => {
      const body = code.replace(/&lt;/g, '<').replace(/&amp;/g, '&').replace(/&gt;/g, '>');
      return `<pre><code>${body}</code></pre>`;
    })
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/`([^`\n]+)`/g, '<code>$1</code>');
  if (opts.linkLines !== false) {
    // Line references: [line 340], [Baris 340], [line 12–15], [#340].
    html = html.replace(
      /\[(?:line|baris|#)\s*(\d+)(?:\s*[–\-]\s*(\d+))?\]/gi,
      (m, a: string, b: string) => {
        const to = b ? ` data-line-to="${b}"` : '';
        return `<span class="agent-line-link" role="button" tabindex="0" data-line="${a}"${to} title="Klik untuk lompat ke baris ${a}">${m}</span>`;
      }
    );
  }
  return html.replace(/\n/g, '<br>');
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
 * Jump to a preview line when the user clicks a [line N] reference in the
 * agent chat. Attached once to the chat history container (event delegation).
 */
export function attachLineLinkHandler(container: HTMLElement): void {
  if ((container as any)._lineLinkAttached) return;
  (container as any)._lineLinkAttached = true;
  container.addEventListener('click', (e) => {
    const target = (e.target as HTMLElement)?.closest?.('.agent-line-link') as HTMLElement | null;
    if (!target) return;
    const from = Number(target.dataset.line);
    if (!Number.isFinite(from) || from <= 0) return;
    scrollPreviewToLine(from);
  });
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
// Chat History Persistence (named sessions)
// ------------------------------------------------------------------

/** The active session id for the current project (persisted per project). */
let activeSessionId: string = '';

export function getActiveSessionId(): string {
  return activeSessionId;
}

function getActiveSessionNameKey(): string {
  return state.currentProjectId
    ? `cstl_agent_session_active_${state.currentProjectId}`
    : 'cstl_agent_session_active_global';
}

function loadActiveSessionPointer(): void {
  try { activeSessionId = localStorage.getItem(getActiveSessionNameKey()) || ''; } catch { activeSessionId = ''; }
}

function saveActiveSessionPointer(): void {
  try { localStorage.setItem(getActiveSessionNameKey(), activeSessionId); } catch { /* ignore */ }
}

/**
 * Serialize the current conversation (non-system, non-internal messages) and
 * persist it into the active session slot. Called after every turn-changing
 * mutation; no-ops while no session exists yet (created lazily).
 */
function persistCurrentSession(): void {
  if (!activeSessionId) return;
  const toSave = chatHistory.filter(m => m.role !== 'system' && !m._internal);
  if (!toSave.length) return;
  const name = deriveSessionNameFromHistory(toSave);
  persistActiveSession(activeSessionId, name, JSON.stringify(toSave), toSave.length);
}

function deriveSessionNameFromHistory(msgs: { role: string; content: string }[]): string {
  const firstUser = msgs.find(m => m.role === 'user')?.content || '';
  return deriveSessionName(firstUser);
}

/** Create a new session id (not yet persisted until first message). */
export function createNewSession(): string {
  activeSessionId = `s${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
  saveActiveSessionPointer();
  return activeSessionId;
}

/**
 * Switch to a stored session: persist the current one, then load the target.
 * Returns the loaded messages (already normalized), or null when not found.
 */
export function switchToSession(sessionId: string): { role: string; content: string }[] | null {
  const raw = getSessionData(sessionId);
  if (raw === null) return null;
  // Persist current first.
  if (activeSessionId && activeSessionId !== sessionId) persistCurrentSession();
  activeSessionId = sessionId;
  saveActiveSessionPointer();
  try {
    const msgs = JSON.parse(raw) as { role: string; content: string }[];
    return Array.isArray(msgs) ? msgs : null;
  } catch { return null; }
}

export function saveChatHistory(): void {
  try {
    // Legacy behavior kept for non-session fallback; the session-aware path
    // (persistCurrentSession) runs alongside.
    const toSave = chatHistory.filter(m => m.role !== 'system' && !m._internal);
    if (activeSessionId) {
      persistCurrentSession();
    } else {
      localStorage.setItem(legacyChatKey(state.currentProjectId), JSON.stringify(toSave));
    }
  } catch (e) {
    console.warn('Gagal menyimpan chat history:', e);
  }
}

export function loadChatHistory(): void {
  try { (globalThis as any).__cstlAgentPlanReset?.(); } catch {}
  chatHistory.length = 0;
  chatHistory.push({ role: 'system', content: buildSystemPrompt() });
  // Initialize the session pointer for this project (lazy first session).
  loadActiveSessionPointer();
  try {
    let raw: string | null = null;
    if (activeSessionId) {
      raw = getSessionData(activeSessionId);
    }
    if (raw === null) {
      // Legacy migration: adopt the old single-slot chat as the first session.
      raw = localStorage.getItem(legacyChatKey(state.currentProjectId));
      if (raw) {
        const msgs = JSON.parse(raw) as ChatMessage[];
        if (Array.isArray(msgs) && msgs.length) {
          for (const m of msgs) {
            if (m.role && m.content) chatHistory.push({ role: m.role, content: m.content });
          }
          createNewSession();
          persistCurrentSession();
          localStorage.removeItem(legacyChatKey(state.currentProjectId)); // migrated
          raw = null;
        } else {
          raw = null;
        }
      }
    }
    if (raw) {
      const msgs = JSON.parse(raw) as ChatMessage[];
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

/** Reset in-memory chat history, DOM view, and token meter without deleting stored sessions. */
function resetChatView(): void {
  try { (globalThis as any).__cstlAgentPlanReset?.(); } catch {}
  chatHistory.length = 0;
  chatHistory.push({ role: 'system', content: buildSystemPrompt() });
  // Reset UI
  const historyEl = ui.agentChatHistory as HTMLElement;
  if (historyEl) {
    historyEl.innerHTML = '';
    const welcome = document.createElement('div');
    welcome.className = 'agent-msg system';
    welcome.textContent = WELCOME_MSG;
    historyEl.appendChild(welcome);
  }
  updateTokenMeter();
}

export function clearChatHistory(): void {
  if (activeSessionId) {
    deleteSessionData(activeSessionId);
    activeSessionId = '';
    saveActiveSessionPointer();
  }
  try { localStorage.removeItem(legacyChatKey(state.currentProjectId)); } catch {}
  resetChatView();
  renderSessionsPanel();
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

/**
 * Render an interactive question card (question + clickable option buttons)
 * into the agent chat. Resolving writes the chosen answer back into the card
 * so the transcript stays readable.
 */
export function showSubagentQuestion(id: string, question: string, options: string[]): void {
  const historyEl = ui.agentChatHistory as HTMLElement | null;
  if (!historyEl) return;
  const card = document.createElement('div');
  card.className = 'agent-msg assistant agent-question-card';
  card.style.cssText = 'width: 100%; max-width: 94%; box-sizing: border-box;';
  card.dataset.questionId = id;

  const qEl = document.createElement('div');
  qEl.className = 'agent-question-text';
  qEl.innerHTML = renderAgentMessageContent(`🤖 **Subagent bertanya:** ${question}`);
  card.appendChild(qEl);

  const optsEl = document.createElement('div');
  optsEl.className = 'agent-question-options';
  optsEl.style.cssText = 'display: flex; flex-direction: column; gap: 8px; margin: 8px 0; width: 100%;';
  options.forEach((opt, idx) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-outline btn-sm agent-question-option';
    btn.style.cssText = [
      'display: flex',
      'align-items: flex-start',
      'justify-content: flex-start',
      'gap: 8px',
      'width: 100%',
      'max-width: 100%',
      'min-width: 0',
      'height: auto',
      'min-height: 36px',
      'padding: 8px 12px',
      'white-space: normal',
      'word-break: break-word',
      'overflow-wrap: anywhere',
      'text-align: left',
      'line-height: 1.4',
      'font-weight: 500',
      'box-sizing: border-box',
    ].join('; ');

    const numSpan = document.createElement('span');
    numSpan.className = 'agent-question-option-num';
    numSpan.style.cssText = 'flex-shrink: 0; font-weight: 700; color: var(--primary); font-family: var(--font-mono); font-size: 12px; line-height: 1.4;';
    numSpan.textContent = `${idx + 1}.`;

    const textSpan = document.createElement('span');
    textSpan.className = 'agent-question-option-label';
    textSpan.style.cssText = 'flex: 1; min-width: 0; white-space: normal; word-break: break-word; overflow-wrap: anywhere; text-align: left; line-height: 1.4;';
    textSpan.textContent = opt.replace(/^\s*\d+[\.\)]\s*/, '');

    btn.append(numSpan, textSpan);
    btn.addEventListener('click', () => {
      if (card.dataset.answered) return;
      card.dataset.answered = '1';
      optsEl.querySelectorAll('button').forEach(b => (b as HTMLButtonElement).disabled = true);
      btn.classList.remove('btn-outline');
      btn.classList.add('btn-primary');
      btn.style.opacity = '0.95';
      numSpan.style.color = '#fff';
      import('./agent-subagent').then(m => m.resolveSubagentQuestion(id, opt));
    });
    optsEl.appendChild(btn);
  });
  card.appendChild(optsEl);

  // Free-text fallback: the main input forwards as the answer.
  const hint = document.createElement('div');
  hint.className = 'agent-question-hint';
  hint.textContent = options.length ? 'Atau ketik jawaban lain di kotak input di bawah.' : 'Ketik jawabanmu di kotak input di bawah.';
  card.appendChild(hint);

  historyEl.appendChild(card);
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

async function applyTranslations(updates: {num: number, trans_message: string, trans_name?: string}[], ctx: { isCancelled: () => boolean; onUpdate?: (msg: string) => void } = { isCancelled: () => false }) {
  try {
    const list = Array.isArray(updates) ? updates : [];
    // Diff-preview gate: large mutations wait for explicit user approval.
    const { gateMutation } = await import('./agent-review');
    const items = list.map(u => {
      const l = state.lineByNum.get(u.num);
      return {
        num: u.num,
        oldText: l ? (l.trans_message || '') : '',
        newText: String(u.trans_message || ''),
      };
    }).filter(it => it.oldText.trim() !== it.newText.trim());
    const approved = await gateMutation('applyTranslations', items, {
      isCancelled: ctx.isCancelled,
      onUpdate: ctx.onUpdate,
    });
    if (!approved) return 'Dibatalkan oleh user lewat preview mutasi. Tidak ada perubahan diterapkan — tanyakan apa yang ingin diubah.';

    const applied = applyAgentTranslations(updates);
    // Self-verification: deterministic sweep over the affected lines.
    const { verifyMutatedLines, formatVerifyReport } = await import('./agent-review');
    const report = formatVerifyReport(verifyMutatedLines(list.map(u => u.num)));
    return `Berhasil menerapkan terjemahan ke ${applied} baris.${report}`;
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
  agentMaxTurns: { field: 'agentMaxTurns', type: 'number', desc: 'Maksimum turn AI agent. 0 = unlimited (3-999, 0 = tanpa batas)' },
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
    if (field === 'agentMaxTurns' && (num !== 0 && (num < 3 || num > 999))) return 'Error: agentMaxTurns harus 3-999, atau 0 untuk unlimited.';
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
      // Sanitize newlines untuk field teks (konsisten dengan normalizeLineDict).
      // Field terjemahan mempertahankan spasi di akhir kalimat, sama seperti
      // editor baris: spasi itu sering disengaja (mis. jarak sebelum jeda).
      const text = String(val);
      (l as any)[key] = (key === 'trans_message' || key === 'trans_name')
        ? escapeStoredNewlines(text, { preserveTrailingSpace: true })
        : text.replace(/\r?\n/g, '\\n').trim();
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

async function editLines(updates: {line_num: number, fields: Record<string, any>}[], ctx: { isCancelled: () => boolean; onUpdate?: (msg: string) => void } = { isCancelled: () => false }): Promise<string> {
  const list = Array.isArray(updates) ? updates : [];
  if (!list.length) return 'Error: updates tidak boleh kosong.';
  // Diff-preview gate for large edits (preview shows trans_message changes).
  const { gateMutation } = await import('./agent-review');
  const previewItems = list.map(u => {
    const l = state.lineByNum.get(u.line_num);
    const newMsg = u.fields && typeof u.fields.trans_message === 'string' ? String(u.fields.trans_message) : null;
    return {
      num: u.line_num,
      oldText: l ? (l.trans_message || '') : '',
      newText: newMsg !== null ? newMsg : (l ? (l.trans_message || '') : ''),
    };
  });
  const approved = await gateMutation('editLines', previewItems, {
    isCancelled: ctx.isCancelled,
    onUpdate: ctx.onUpdate,
  });
  if (!approved) return 'Dibatalkan oleh user lewat preview mutasi. Tidak ada perubahan diterapkan — tanyakan apa yang ingin diubah.';

  pushUndoSnapshot();
  let edited = 0;
  const errors: string[] = [];
  const affectedNums: number[] = [];
  for (const u of list) {
    const l = state.lineByNum.get(u.line_num);
    if (!l) { errors.push(`Baris ${u.line_num} tidak ditemukan.`); continue; }
    if (!u.fields || typeof u.fields !== 'object') { errors.push(`Baris ${u.line_num}: fields tidak valid.`); continue; }
    const changed = applyLineEdit(l, u.fields);
    if (changed.length) { edited++; affectedNums.push(u.line_num); }
    else errors.push(`Baris ${u.line_num}: tidak ada field valid.`);
  }
  refreshAll();
  queueAutoSave();
  // Self-verification on the lines that actually changed.
  const { verifyMutatedLines, formatVerifyReport } = await import('./agent-review');
  const verifyReport = formatVerifyReport(verifyMutatedLines(affectedNums));
  const parts = [`${edited} baris berhasil diedit.${verifyReport}`];
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

  // Feed the header the actual number of lines in this delegated request so
  // {{lineCount}} does not leak the last manual Copy for AI count.
  state._lastExportedLineCount = selectedLineNums.size;
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

// ── delegateAgent — spawn an autonomous subagent that can talk to the user ───

/** System prompt for spawned subagents — smaller scope than the main agent. */
export function buildSubagentSystemPrompt(): string {
  return `You are a focused subagent spawned by the main CSTL Agent. Complete the task you were given.

## Tools
Read tools: getProjectStats, getLines, getContext, searchLines, getCharacterNames, analyzeQuality, getProgressReport, getGlossary, listSettings, getMemory, listMemory, webSearch, searchVn.
Mutation tools: applyTranslations, editLines, editGlossary, saveMemory.
Special tools:
- askUser(question, options?) — ask the HUMAN a question; options is an array of up to 6 short answer choices. The user sees clickable buttons and answers directly. Use it when you need a decision you cannot make alone (naming preference, ambiguous instruction, confirmation before mutating many lines).
- reportToMain(message) — send a short progress report to the main agent while working (not your final answer).

## Output format
Same JSON protocol as the main agent:
{"tool_calls": [{"name": "...", "arguments": {...}}]}
Plain text (no JSON) = your FINAL answer to the main agent. Make it a concise, complete report of what you did/found — the main agent reads it as the tool result.

## Rules
- Work autonomously toward the task; use tools before guessing.
- Turn budget: unlimited by default, but jangan boros — ketika temuan sudah cukup untuk menjawab task, BALAS dengan teks final (bukan JSON). Jangan looping analisis yang sama berulang.
- Untuk analisis proyek besar: sampling cerdas dari bagian berbeda; jangan mencoba membaca semua baris satu per satu.
- Mutating many lines or changing settings/prompts without explicit instruction: askUser first.
- Do not call delegate* tools (they are unavailable to you).
- Answer in Bahasa Indonesia unless told otherwise.`;
}

/**
 * delegateAgent — spawn an autonomous subagent with its own ReAct loop. The
 * subagent can read/write project data, ask the user questions with clickable
 * options, and stream reports back into the main agent chat while working.
 */
async function delegateAgent(
  task: string,
  opts: { maxTurns?: number; onUpdate?: (msg: string) => void } = {}
): Promise<string> {
  const t = String(task || '').trim();
  if (!t) return 'Error: task tidak boleh kosong.';
  const { runSubagent } = await import('./agent-subagent');
  const { currentAbortEpoch } = await import('./ai-client');

  const emit = (activity: import('./agent-subagent').SubagentActivity) => {
    if (activity.kind === 'question') {
      showSubagentQuestion(activity.id, activity.question, activity.options);
    } else if (activity.kind === 'report') {
      opts.onUpdate?.(`💬 Subagent: ${activity.message}`);
    } else {
      opts.onUpdate?.(activity.message);
    }
  };

  try {
    const result = await runSubagent(t, {
      emit,
      isCancelled: () => currentAbortEpoch() > startEpochOfDelegate,
      startEpoch: startEpochOfDelegate,
    }, (msg) => opts.onUpdate?.(msg), opts.maxTurns);
    return `=== HASIL SUBAGENT ===\n${result}`;
  } catch (e: any) {
    return `Error: subagent gagal — ${e?.message || e}`;
  }
}

// Epoch of the currently-running main-agent turn, captured at tool dispatch.
let startEpochOfDelegate = 0;

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

export async function executeTool(
  name: string,
  args: any,
  onProgress?: (msg: string) => void
): Promise<string> {
  // Capture the current abort epoch so spawned subagents die with this turn.
  startEpochOfDelegate = currentAbortEpoch();
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
    case 'applyTranslations': return safe(() => applyTranslations(a.updates ?? a.translations, { isCancelled: () => currentAbortEpoch() > startEpochOfDelegate, onUpdate: onProgress }));
    case 'editLine': return safe(() => editLine(coerceLineNum(a.line_num ?? a.lineNum ?? a.num), a.fields));
    case 'editLines': return safe(() => editLines(a.updates, { isCancelled: () => currentAbortEpoch() > startEpochOfDelegate, onUpdate: onProgress }));
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
    case 'askUser':
      return safe(async () => {
        const question = String(a.question ?? a.q ?? '').trim();
        if (!question) return 'Error: question tidak boleh kosong.';
        const options = Array.isArray(a.options) ? a.options.map((o: any) => String(o)).filter(Boolean).slice(0, 6) : [];
        const { askUserMainThread } = await import('./agent-subagent');
        const { currentAbortEpoch } = await import('./ai-client');
        const epoch = currentAbortEpoch();
        return askUserMainThread(question, options, () => currentAbortEpoch() > epoch);
      });
    case 'setPlan': return safe(async () => { const m = await import('./agent-plan'); return m.toolSetPlan(a.steps); });
    case 'updatePlanStep': return safe(async () => { const m = await import('./agent-plan'); return m.toolUpdatePlanStep(a.step ?? a.index, a.status); });
    case 'completePlan': return safe(async () => { const m = await import('./agent-plan'); return m.toolCompletePlan(); });
    case 'delegateAgent': return safe(() => delegateAgent(a.task ?? a.instruction ?? '', {
      maxTurns: a.max_turns ?? a.maxTurns,
      onUpdate: (msg) => onProgress?.(msg),
    }));    case 'searchVn':
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
    case 'delegateAgent':
      return `delegateAgent("${String(a.task ?? '').slice(0, 60)}")`;
    case 'askUser':
      return `askUser("${String(a.question ?? '').slice(0, 60)}")`;
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

export function parseToolCalls(text: string): ParsedToolCalls | null {
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
  const { compactAgentContextIfNeeded, getEffectiveContextWindow, estimateMessagesTokens } = await import('./agent-context');
  const res = await compactAgentContextIfNeeded(chatHistory, async (msgs) => {
    onUpdate('Compacting context...', 'system');
    return chatCompletion(msgs);
  });
  if (res.compacted) {
    const win = res.contextWindow >= 1000 ? `${Math.round(res.contextWindow / 1000)}K` : String(res.contextWindow);
    onUpdate(`Context dipadatkan: ~${Math.round(res.estimatedTokensBefore / 1000)}K → ~${Math.round(res.estimatedTokensAfter / 1000)}K token (window ~${win}).`, 'system');
  }
  void getEffectiveContextWindow;
  void estimateMessagesTokens;
}

/**
 * Update the header token meter: estimated conversation tokens vs the
 * effective context window. Cheap enough to call after every turn.
 */
export async function updateTokenMeter(): Promise<void> {
  const el = ui.agentTokenMeter as HTMLElement | null;
  if (!el) return;
  try {
    const { estimateMessagesTokens, getEffectiveContextWindow } = await import('./agent-context');
    const used = estimateMessagesTokens(chatHistory);
    const window = getEffectiveContextWindow();
    const pct = Math.min(100, Math.round((used / window) * 100));
    const fmt = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}K` : String(n);
    el.textContent = `${fmt(used)} / ${fmt(window)} (${pct}%)`;
    el.style.color = pct > 90 ? 'var(--danger)' : pct > 70 ? 'var(--warning, #c98a12)' : 'var(--muted)';
  } catch { el.textContent = '—'; }
}

/**
 * Render the sessions dropdown panel and wire its actions.
 */
export function renderSessionsPanel(): void {
  const panel = ui.agentSessionsPanel as HTMLElement | null;
  const list = ui.agentSessionsList as HTMLElement | null;
  if (!panel || !list) return;
  renderSessionList(list, activeSessionId, {
    onSwitch: (id) => {
      const msgs = switchToSession(id);
      if (msgs === null) return;
      try { (globalThis as any).__cstlAgentPlanReset?.(); } catch {}
      // Rebuild chat history from the loaded session.
      chatHistory.length = 0;
      chatHistory.push({ role: 'system', content: buildSystemPrompt() });
      for (const m of msgs) {
        if (m.role && m.content) chatHistory.push({ role: m.role as ChatRole, content: m.content });
      }
      renderChatHistory();
      renderSessionsPanel();
      updateTokenMeter();
    },
    onDelete: (id) => {
      if (id === activeSessionId) {
        // Active session deleted — start fresh and refresh token meter.
        clearChatHistory();
      } else {
        deleteSessionData(id);
        renderSessionsPanel();
      }
    },
    onRename: (id, newName) => {
      renameSession(id, newName);
      renderSessionsPanel();
    },
  });
}

/** Toggle the sessions panel open/closed. */
export function toggleSessionsPanel(): void {
  const panel = ui.agentSessionsPanel as HTMLElement | null;
  if (!panel) return;
  const show = panel.style.display === 'none' || !panel.style.display;
  panel.style.display = show ? 'block' : 'none';
  if (show) renderSessionsPanel();
}

/** Start a brand-new empty session. */
export function startNewSession(): void {
  if (activeSessionId) persistCurrentSession();
  createNewSession();
  resetChatView();
  renderSessionsPanel();
}

/** Ensure an active session id exists (lazy — created on first message). */
export function ensureActiveSession(): void {
  if (!activeSessionId) {
    createNewSession();
    persistCurrentSession();
  }
}

// ------------------------------------------------------------------
// System Prompt
// ------------------------------------------------------------------

function buildSystemPrompt(): string {
  const visible = state.lines.filter(l => !l._hidden);
  const total = visible.length;
  const rawTotal = state.lines.length;
  const translated = visible.filter(l => l.is_translated).length;
  // The active plan checklist is injected synchronously via agent-plan's
  // prompt section getter (imported lazily to avoid a cycle).
  let planSection = '';
  try {
    // agent-plan has no import-time dependency on ai-agent, safe to require
    // synchronously through the module registry via a global side-channel.
    planSection = (globalThis as any).__cstlAgentPlanPrompt?.() || '';
  } catch { /* plan module not loaded yet — no active plan */ }

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
| delegateAgent(task, max_turns?) | Spawn subagent otonom (loop tool sendiri, TANPA batas turn secara default) untuk tugas kompleks/multi-langkah atau analisis besar. Subagent bisa bertanya ke user (askUser) dan mengirim laporan progress (reportToMain). Untuk proyek 20K+ baris TIDAK perlu pecah manual — langsung delegasikan keseluruhan. Set max_turns (mis. 15) hanya jika ingin membatasi |
| askUser(question, options?) | TANYA USER dengan kartu pertanyaan interaktif (tombol pilihan). Loop agent berhenti sampai user menjawab. WAJIB dipakai (bukan nanya lewat teks) saat butuh keputusan/klarifikasi penting: pilihan nama, konfirmasi aksi besar, instruksi ambigu. options = array maks 6 pilihan singkat, boleh kosong untuk jawaban bebas |
| setPlan(steps) | TAMPILKAN RENCANA sebagai checklist live di chat. WAJIB dipanggil di awal tugas multi-langkah (2+ langkah): langkah 1-6, ringkas & konkret. Contoh: setPlan(["Baca glosarium & nama karakter", "Analisis bab 1-5", "Terapkan perbaikan", "Verifikasi hasil"])
| updatePlanStep(step, status) | Update status langkah rencana: step = nomor (1-based), status = pending/active/done. Panggil SETIAP kali pindah langkah |
| completePlan() | Tandai semua langkah selesai (panggil sebelum jawaban final tugas) |
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
- PREVIEW MUTASI: applyTranslations/editLines dengan >10 baris otomatis menampilkan diff-preview dan MENUNGGU konfirmasi user. Jika hasilnya "Dibatalkan oleh user lewat preview mutasi" — JANGAN mencoba lagi dengan cara yang sama; tanyakan apa yang ingin diubah.
- Self-verification: hasil mutasi otomatis diperiksa (sisa teks Jepang, terjemahan terlalu pendek, kosong). Jika ada laporan ⚠️, periksa baris tersebut dan perbaiki sebelum melanjutkan.
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

## CARA KERJA (plan-first)
- Tugas multi-langkah (analisis, perbaikan massal, dsb.): PANGGIL setPlan dulu sebelum tool lain — user melihat checklist rencana real-time.
- Setiap pindah langkah: updatePlanStep(step, "done") + langkah berikutnya otomatis jadi aktif.
- Sebelum jawaban final tugas: completePlan().
- Pertanyaan/trivial satu-langkah: tidak perlu setPlan.
- User bisa mengirim pesan steering di tengah pekerjaanmu (muncul sebagai [Steering dari user]) — hentikan arah lama dan ikuti arahan barunya.

## GAYA

- Jawab dalam Bahasa Indonesia kecuali diminta sebaliknya.
- Jangan tampilkan proses berpikir internal. Langsung jawab atau panggil tool.
- Untuk pertanyaan tentang proyek, gunakan tool untuk mendapat data aktual — jangan mengarang angka.${planSection}`;
}

// ------------------------------------------------------------------
// ReAct Agent Engine

/** Drain queued steering messages (typed mid-run by the user). */
function drainSteer(): string | null {
  try {
    const m = (globalThis as any).__cstlAgentSteer;
    return m?.drain?.() ?? null;
  } catch { return null; }
}

/** Detect context-length failures across providers (HTTP 400/413 bodies vary). */
function isContextLengthError(err: any): boolean {
  const msg = String(err?.message || err || '').toLowerCase();
  const body = String((err as any)?.body || '').toLowerCase();
  const text = `${msg} ${body}`;
  return (
    /context length|context window|maximum context|max.?tokens.*exceed|too many tokens|prompt is too long|input is too long|exceeds.*token|token limit|request too large/.test(text)
  );
}
// ------------------------------------------------------------------

export const chatHistory: ChatMessage[] = [];

export async function sendAgentMessage(
  userMessage: string,
  onUpdate: (msg: string, role: 'assistant' | 'system', meta?: { streaming?: boolean }) => void
): Promise<void> {
  // New run — clear any stale plan checklist from the previous task.
  const planMod = await import('./agent-plan');
  planMod.resetPlanForNewRun();
  planMod.setAgentRunning(true);
  try {
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

  // The Settings UI exposes agentMaxTurns; 0 = unlimited (Stop is the only
  // exit, same philosophy as interactive coding-agent CLIs).
  const configuredTurns = Math.floor(Number(state.agentMaxTurns));
  const maxLoops = configuredTurns === 0 || !Number.isFinite(configuredTurns)
    ? 0 // unlimited
    : Math.min(999, Math.max(3, configuredTurns));
  const startEpoch = currentAbortEpoch();

  let finishedWithReply = false;
  let userStopped = false;
  let emergencyCompactedThisTurn = false;
  let loopCount = 0;
  // Native function calling: enabled automatically when the backend responds
  // with structured tool calls. Falls back to JSON-in-text parsing when the
  // provider/gateway ignores the tools declaration (result comes back as text).
  let nativeToolsActive = false;
  while (maxLoops === 0 || loopCount < maxLoops) {
    // Stop pressed between turns (e.g. while a local tool runs): bail out
    // instead of starting another model round-trip.
    if (currentAbortEpoch() > startEpoch) { userStopped = true; break; }
    loopCount++;
    emergencyCompactedThisTurn = false;
    onUpdate('Memproses...', 'system');

    let responseText = '';
    let streamedVisible = false;
    let nativeToolCalls: { name: string; arguments: any }[] = [];
    try {
      const { chatCompletionStructured } = await import('./ai-client');
      const { AGENT_TOOL_SCHEMAS } = await import('./agent-tools-schema');
      const structured = await chatCompletionStructured(chatHistory, {
        tools: nativeToolsActive ? AGENT_TOOL_SCHEMAS : undefined,
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
      responseText = structured.text;
      nativeToolCalls = structured.toolCalls;
      if (nativeToolCalls.length) nativeToolsActive = true;
    } catch (e: any) {
      // Context-length failure: the estimate missed (unknown model, wrong
      // manual window, oversized tool result). Emergency-compact hard and
      // retry ONCE on the same turn instead of dying.
      if (isContextLengthError(e) && !emergencyCompactedThisTurn) {
        emergencyCompactedThisTurn = true;
        onUpdate('Context window terlampaui — memadatkan darurat...', 'system');
        const { forceCompactAgentContext } = await import('./agent-context');
        await forceCompactAgentContext(chatHistory, async (msgs) => chatCompletion(msgs), 0.35);
        loopCount--; // this turn does not count — retry it
        continue;
      }
      // API errors are UI-only — persisting them as an assistant message used
      // to poison the conversation (the model saw its own "error" as text on
      // reload) and pushed junk into future prompts.
      throw e;
    }

    // Parse tool calls: native first (function calling API), then the
    // JSON-in-text fallback for gateways that ignore the tools declaration.
    const parsed = nativeToolCalls.length
      ? { calls: nativeToolCalls.map(tc => ({ name: tc.name, arguments: tc.arguments })), raw: '' }
      : parseToolCalls(responseText);

    // A text response that *looks* like a tool call (starts with {) but failed
    // every parse strategy — usually truncated output or malformed JSON. When
    // native tools are active this is just prose that happens to start with '{'
    // (rare) — only run the corrective retry in fallback mode.
    const looksLikeTool = !nativeToolsActive && (/^\s*\{/.test(responseText) || /```json\s*\{/.test(responseText));
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

    chatHistory.push({
      role: 'assistant',
      content: responseText || (nativeToolCalls.length
        ? `[Calling tools: ${nativeToolCalls.map(tc => tc.name).join(', ')}]`
        : ''),
      _internal: !!(parsed && parsed.calls.length > 0),
    });
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
      // Unlimited turns can accumulate huge tool results mid-turn — compact
      // between rounds too, not just before a new user message.
      await compactContextIfNeeded(onUpdate);

      // Steering: user typed a message while the agent was working. Inject it
      // now so the model adjusts course on the next round.
      const steer = drainSteer();
      if (steer) {
        chatHistory.push({ role: 'user', content: steer, _internal: true });
        saveChatHistory();
        onUpdate('📣 Steering diterima.', 'system');
      }
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
    } else if (maxLoops === 0) {
      // Unlimited loop exiting without a reply means malformed JSON retries
      // bailed out — shouldn't normally happen, but never freeze silently.
      onUpdate('⚠️ Agent berhenti tanpa jawaban final (loop unlimited terputus). Coba kirim ulang instruksi.', 'system');
    } else {
      onUpdate(
        `⚠️ Batas ${maxLoops} giliran tool tercapai sebelum agent selesai. Set "Agent Max Turns" ke 0 (unlimited) di pengaturan atau lanjutkan dengan instruksi baru.`,
        'system'
      );
    }
  }
  } finally {
    planMod.setAgentRunning(false);
  }
}
