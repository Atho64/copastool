// @module agent-review.ts — Mutation preview (diff-gate) + self-verification
// for the AI Agent. Large mutations via applyTranslations/editLines pause the
// agent and render a diff preview with an interactive decision card; after any
// applied mutation a deterministic quality sweep runs automatically.

import { state, ui } from './state';
import { isTranslated } from './state';

// ── Diff (token LCS, same algorithm as ai-check.ts) ──────────────────────────

function tokenize(text: string): string[] {
  return String(text || '').split(/(\s+)/).filter(t => t.length > 0);
}

function computeDiff(oldText: string, newText: string): { type: 'same' | 'del' | 'add'; text: string }[] {
  const oldTokens = tokenize(oldText);
  const newTokens = tokenize(newText);
  const m = oldTokens.length;
  const n = newTokens.length;
  if (m === 0) return newTokens.map(t => ({ type: 'add', text: t }));
  if (n === 0) return oldTokens.map(t => ({ type: 'del', text: t }));
  if (m * n > 50000) {
    return [
      ...oldTokens.map(t => ({ type: 'del' as const, text: t })),
      ...newTokens.map(t => ({ type: 'add' as const, text: t })),
    ];
  }
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = oldTokens[i - 1] === newTokens[j - 1]
        ? dp[i - 1][j - 1] + 1
        : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  const result: { type: 'same' | 'del' | 'add'; text: string }[] = [];
  let i = m, j = n;
  while (i > 0 && j > 0) {
    if (oldTokens[i - 1] === newTokens[j - 1]) {
      result.unshift({ type: 'same', text: oldTokens[i - 1] });
      i--; j--;
    } else if (dp[i - 1][j] >= dp[i][j - 1]) {
      result.unshift({ type: 'del', text: oldTokens[i - 1] }); i--;
    } else {
      result.unshift({ type: 'add', text: newTokens[j - 1] }); j--;
    }
  }
  while (i > 0) { result.unshift({ type: 'del', text: oldTokens[i - 1] }); i--; }
  while (j > 0) { result.unshift({ type: 'add', text: newTokens[j - 1] }); j--; }
  return result;
}

function renderDiffHtml(oldText: string, newText: string): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return computeDiff(oldText, newText).map(p => {
    if (p.type === 'del') return `<del class="agent-diff-del">${esc(p.text)}</del>`;
    if (p.type === 'add') return `<ins class="agent-diff-add">${esc(p.text)}</ins>`;
    return esc(p.text);
  }).join('');
}

// ── Mutation preview gate ────────────────────────────────────────────────────

/** Mutations larger than this trigger the interactive diff preview. */
const PREVIEW_THRESHOLD = 10;

interface PendingMutation {
  id: string;
  resolve: (approved: boolean) => void;
}

let pendingMutation: PendingMutation | null = null;

export function hasPendingMutation(): boolean {
  return !!pendingMutation;
}

export function resolvePendingMutation(id: string, approved: boolean): void {
  if (pendingMutation && pendingMutation.id === id) {
    const p = pendingMutation;
    pendingMutation = null;
    p.resolve(approved);
  }
}

export interface MutationPreviewItem {
  num: number;
  oldText: string;
  newText: string;
}

/**
 * Show the interactive diff-preview card in the agent chat and wait for the
 * user's decision. Resolves true = apply, false = cancel.
 */
function awaitMutationApproval(
  kind: string,
  items: MutationPreviewItem[],
  isCancelled: () => boolean
): Promise<boolean> {
  return new Promise((resolve, reject) => {
    if (isCancelled()) { reject(new Error('Dibatalkan.')); return; }
    const id = `m${Date.now().toString(36)}`;
    pendingMutation = { id, resolve };

    const historyEl = ui.agentChatHistory as HTMLElement | null;
    if (!historyEl) { pendingMutation = null; resolve(true); return; }

    const card = document.createElement('div');
    card.className = 'agent-msg assistant agent-mutation-card';
    card.dataset.mutationId = id;

    const title = document.createElement('div');
    title.className = 'agent-mutation-title';
    title.textContent = `🔍 Preview mutasi ${kind}: ${items.length} baris — menunggu konfirmasi`;
    card.appendChild(title);

    const list = document.createElement('div');
    list.className = 'agent-mutation-list';
    // Show at most 8 rows; the rest summarized.
    const shown = items.slice(0, 8);
    for (const it of shown) {
      const row = document.createElement('div');
      row.className = 'agent-mutation-row';
      const num = document.createElement('span');
      num.className = 'agent-mutation-num';
      num.textContent = `[${it.num}]`;
      const diff = document.createElement('span');
      diff.className = 'agent-mutation-diff';
      diff.innerHTML = renderDiffHtml(it.oldText, it.newText) || '<em>(kosong → teks baru)</em>';
      row.append(num, diff);
      list.appendChild(row);
    }
    if (items.length > shown.length) {
      const more = document.createElement('div');
      more.className = 'agent-mutation-more';
      more.textContent = `…dan ${items.length - shown.length} baris lainnya`;
      list.appendChild(more);
    }
    card.appendChild(list);

    const btns = document.createElement('div');
    btns.className = 'agent-question-options';
    const mkBtn = (label: string, primary: boolean, val: boolean) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `btn btn-sm ${primary ? 'btn-primary' : 'btn-outline'}`;
      b.textContent = label;
      b.addEventListener('click', () => {
        if (card.dataset.answered) return;
        card.dataset.answered = '1';
        btns.querySelectorAll('button').forEach(x => (x as HTMLButtonElement).disabled = true);
        const note = document.createElement('div');
        note.className = 'agent-question-answered';
        note.textContent = val ? '✅ Disetujui' : '❌ Dibatalkan';
        card.appendChild(note);
        resolvePendingMutation(id, val);
      });
      btns.appendChild(b);
    };
    mkBtn(`✅ Terapkan (${items.length})`, true, true);
    mkBtn('❌ Batal', false, false);
    card.appendChild(btns);

    historyEl.appendChild(card);
    historyEl.scrollTop = historyEl.scrollHeight;

    // Cancel watch — Stop must also kill a pending preview.
    const check = setInterval(() => {
      if (isCancelled()) {
        clearInterval(check);
        if (pendingMutation && pendingMutation.id === id) pendingMutation = null;
        if (!card.dataset.answered) {
          card.dataset.answered = '1';
          btns.querySelectorAll('button').forEach(x => (x as HTMLButtonElement).disabled = true);
        }
        reject(new Error('Dibatalkan.'));
      }
    }, 500);
  });
}

/**
 * Gate for mutation tools. If the mutation is large (or auto-review is forced),
 * show the preview and wait. Returns true when the caller may proceed.
 */
export async function gateMutation(
  kind: string,
  items: MutationPreviewItem[],
  opts: { threshold?: number; forcePreview?: boolean; isCancelled: () => boolean; onUpdate?: (msg: string) => void }
): Promise<boolean> {
  const threshold = opts.threshold ?? PREVIEW_THRESHOLD;
  const needsPreview = !!opts.forcePreview || items.length > threshold;
  if (!needsPreview) return true;
  opts.onUpdate?.(`Menunggu konfirmasi preview mutasi (${items.length} baris)...`);
  try {
    return await awaitMutationApproval(kind, items, opts.isCancelled);
  } catch (e: any) {
    if (/dibatalkan/i.test(String(e?.message))) return false;
    throw e;
  }
}

// ── Self-verification (deterministic, runs after applied mutations) ─────────

export interface VerifyIssue {
  num: number;
  kind: string;
  detail: string;
}

/**
 * Deterministic post-mutation sweep over the affected lines: leftover JP
 * punctuation, suspicious shortening, empty translation, and untranslated
 * flag mismatches. Cheap, no AI — surfaces obvious regressions instantly.
 */
export function verifyMutatedLines(nums: number[]): VerifyIssue[] {
  const issues: VerifyIssue[] = [];
  for (const num of nums) {
    const l = state.lineByNum.get(num);
    if (!l) continue;
    const t = l.trans_message || '';
    if (l.is_translated && !t.trim()) {
      issues.push({ num, kind: 'empty', detail: 'Terjemahan kosong tapi ditandai terjemahan' });
      continue;
    }
    if (!l.is_translated) continue;
    // Leftover JP punctuation in the message.
    const jp = t.match(/[。、・〜ー]/g);
    if (jp) {
      issues.push({ num, kind: 'jp-punct', detail: `Sisa tanda baca Jepang: ${jp.join(' ')}` });
    }
    // Suspicious shortening vs the source (same heuristic as analyzeQuality).
    if (l.message.length > 10 && t.length < l.message.length * 0.2) {
      issues.push({ num, kind: 'short', detail: `Terjemahan jauh lebih pendek dari asli (${t.length} vs ${l.message.length} karakter)` });
    }
    // Untranslated CJK residue in a translated line (kanji may be legit — flag only).
    if (/[\u3040-\u30ff]/.test(t)) {
      issues.push({ num, kind: 'kana', detail: 'Sisa kana di terjemahan' });
    }
  }
  return issues;
}

/** Build a compact report string for the agent from verification issues. */
export function formatVerifyReport(issues: VerifyIssue[]): string {
  if (!issues.length) return '';
  const lines = issues.slice(0, 15).map(i => `- [${i.num}] ${i.kind}: ${i.detail}`);
  const more = issues.length > 15 ? `\n…+${issues.length - 15} lainnya` : '';
  return `\n⚠️ Self-verification menemukan ${issues.length} indikasi masalah pada baris yang baru diubah:\n${lines.join('\n')}${more}\nPeriksa baris tersebut (getLines) dan perbaiki bila perlu.`;
}
