// @module qa.ts — Quality Control validation (Kana residue, Similarity, Glossary, Linebreak, Length, Language, Punctuation)

import { state, ui, getQaScroller } from './state';
import { isTranslated } from './state';
import { stringSimilarity, escapeRegex, unescapeStoredNewlines } from './string-utils';
import { parseGlossaryToMap } from './glossary';
import { openLineEditor } from './render';
import { openModal, closeModal } from './project';
import type { QaMatch } from './types';

// ─── Helper functions for new QA checks ──────────────────────────────────────

function countLinebreaks(text: string): number {
  const stored = (text.match(/\\n/g) || []).length;
  const br = (text.match(/<br>/gi) || []).length;
  return stored + br;
}

function countGraphemes(text: string): number {
  return Array.from(text).length;
}

// Heuristic Indonesian vs English language detection.
// Returns true if the text looks like English (not Indonesian).
function detectEnglishFallback(text: string): boolean {
  const words = text.toLowerCase().split(/[\s\p{P}]+/u).filter(w => w.length > 0);
  if (words.length < 3) return false;

  const idMarkers = new Set([
    'yang', 'dan', 'di', 'ke', 'dari', 'untuk', 'dengan', 'ini', 'itu',
    'saya', 'dia', 'adalah', 'tidak', 'akan', 'bisa', 'pada', 'atau',
    'juga', 'telah', 'sudah', 'belum', 'kalau', 'karena', 'tapi',
    'seperti', 'oleh', 'saat', 'hanya', 'masih', 'lebih', 'sangat',
    'semua', 'siapa', 'apa', 'mana', 'bagaimana', 'mengapa', 'dimana',
    'kapan', 'iya', 'ya', 'bukan', 'jangan', 'kita', 'kami', 'kamu',
    'kau', 'aku', 'engkau', 'mereka', 'nya', 'lah', 'pun', 'dong',
    'nanti', 'besok', 'kemarin', 'sekarang', 'tadi', 'lagi', 'terus',
    'sudah', 'belum', 'pasti', 'mungkin', 'harus', 'boleh', 'ingin',
  ]);

  const enMarkers = new Set([
    'the', 'is', 'was', 'are', 'to', 'of', 'in', 'that', 'he', 'she',
    'it', 'with', 'for', 'on', 'be', 'have', 'has', 'had', 'you', 'we',
    'they', 'not', 'but', 'this', 'from', 'by', 'at', 'or', 'as', 'an',
    'so', 'if', 'do', 'does', 'did', 'will', 'would', 'can', 'could',
    'should', 'about', 'what', 'who', 'where', 'when', 'why', 'how',
    'all', 'each', 'some', 'any', 'more', 'most', 'only', 'same', 'than',
    'too', 'very', 'his', 'her', 'its', 'their', 'our', 'your', 'my',
    'me', 'him', 'them', 'us', 'am', 'were', 'been', 'being', 'having',
    'and', 'get', 'got', 'getting', 'go', 'going', 'gone', 'went', 'come',
    'came', 'look', 'looked', 'said', 'say', 'saying', 'see', 'saw', 'seen',
    'know', 'knew', 'known', 'think', 'thought', 'feel', 'felt', 'want',
    'wanted', 'need', 'needed', 'make', 'made', 'making', 'take', 'took',
    'taken', 'let', 'going', 'really', 'just', 'now', 'then', 'here',
  ]);

  let idScore = 0;
  let enScore = 0;

  for (const word of words) {
    if (idMarkers.has(word)) idScore++;
    if (enMarkers.has(word)) enScore++;
    // Indonesian morphological patterns
    if (word.length >= 4) {
      if (/^(ber|men|meng|mem|meny|di|ter|ke|se|pe|peng|peny)/.test(word)) idScore++;
      if (/(nya|kan|lah|kah|an|i)$/.test(word)) idScore++;
    }
    // English patterns
    if (/(ing|ed|tion|ment|ness|ful|less|able|ible)$/.test(word) && word.length >= 5) enScore++;
    if (/(don't|can't|won't|isn't|aren't|wasn't|weren't|didn't|doesn't|wouldn't|couldn't|shouldn't|i'm|you're|he's|she's|it's|we're|they're)/.test(word)) enScore++;
  }

  // Conservative: only flag if English markers found, no Indonesian markers
  return enScore > 0 && idScore === 0;
}

const JP_PUNCTUATION_REGEX = /[。、「」『』・〜ー]/;

function findJpPunctuation(text: string): string[] {
  const found: string[] = [];
  const set = new Set<string>();
  for (const ch of Array.from(text)) {
    if (JP_PUNCTUATION_REGEX.test(ch) && !set.has(ch)) {
      set.add(ch);
      found.push(ch);
    }
  }
  return found;
}

// ─── QA Modal functions ───────────────────────────────────────────────────────

export function onOpenQa(): void {
  openModal(ui.qaModal);
  if (state.qaMatches.length === 0) {
    ui.qaStats.textContent = 'Status: Siap dijalankan.';
  }
  const btn = document.getElementById('btnRetranslateFlagged');
  if (btn) btn.style.display = state.qaMatches.length > 0 ? '' : 'none';
}

export function onResetQa(): void {
  (ui.qaCheckGlossary as HTMLInputElement).checked = true;
  (ui.qaCheckKana as HTMLInputElement).checked = true;
  (ui.qaCheckSimilarity as HTMLInputElement).checked = true;
  const lb = document.getElementById('qaCheckLinebreak') as HTMLInputElement;
  if (lb) lb.checked = true;
  const lr = document.getElementById('qaCheckLength') as HTMLInputElement;
  if (lr) lr.checked = true;
  const wl = document.getElementById('qaCheckLanguage') as HTMLInputElement;
  if (wl) wl.checked = true;
  const jp = document.getElementById('qaCheckPunctuation') as HTMLInputElement;
  if (jp) jp.checked = true;
  const un = document.getElementById('qaCheckUncertain') as HTMLInputElement;
  if (un) un.checked = true;
  const un2 = document.getElementById('qaCheckUntransName') as HTMLInputElement;
  if (un2) un2.checked = true;
  state.qaMatches = [];
  getQaScroller().setItems([]);
  ui.qaStats.textContent = 'Status: Siap dijalankan.';
  const btn = document.getElementById('btnRetranslateFlagged');
  if (btn) btn.style.display = 'none';
}

export function runQaCheck(): void {
  ui.qaStats.textContent = 'Status: Sedang memeriksa...';
  state.qaMatches = [];

  const checkKana = (ui.qaCheckKana as HTMLInputElement).checked;
  const checkSim = (ui.qaCheckSimilarity as HTMLInputElement).checked;
  const checkGloss = (ui.qaCheckGlossary as HTMLInputElement).checked;
  const checkLinebreak = (document.getElementById('qaCheckLinebreak') as HTMLInputElement)?.checked ?? false;
  const checkLength = (document.getElementById('qaCheckLength') as HTMLInputElement)?.checked ?? false;
  const checkLanguage = (document.getElementById('qaCheckLanguage') as HTMLInputElement)?.checked ?? false;
  const checkPunct = (document.getElementById('qaCheckPunctuation') as HTMLInputElement)?.checked ?? false;
  const checkUncertain = (document.getElementById('qaCheckUncertain') as HTMLInputElement)?.checked ?? false;
  const checkUntransName = (document.getElementById('qaCheckUntransName') as HTMLInputElement)?.checked ?? false;

  const glossaryMap = checkGloss ? parseGlossaryToMap(state.glossaryText) : new Map();
  const simThreshold = state.similarityThreshold || 0.7;
  const lengthThreshold = state.lengthRatioThreshold || 2.5;

  let kanaCount = 0;
  let simCount = 0;
  let glossCount = 0;
  let linebreakCount = 0;
  let lengthCount = 0;
  let langCount = 0;
  let punctCount = 0;
  let uncertainCount = 0;
  let untransNameCount = 0;

  for (const l of state.lines) {
    if (!isTranslated(l) || !l.trans_message) continue;

    const origRawMsg = unescapeStoredNewlines(l.message || '');
    const transRawMsg = unescapeStoredNewlines(l.trans_message);
    const origRawName = unescapeStoredNewlines(l.name || '');
    const transRawName = unescapeStoredNewlines(l.trans_name || '');

    const errors: string[] = [];
    // Kana (hiragana/katakana, termasuk ー dan tanda iterasi) + Kanji (termasuk 々〆〇) — TANPA simbol (・ ゛ ゜ ゠)
    const kanaRegex = /[\u3041-\u3096\u309D-\u309F\u30A1-\u30FA\u30FC-\u30FF\u4E00-\u9FFF\u3005-\u3007]/;

    if (checkKana) {
      if (kanaRegex.test(transRawMsg) || (transRawName && kanaRegex.test(transRawName))) {
        errors.push('Kana/Kanji Residue');
        kanaCount++;
      }
    }

    if (checkUntransName) {
      const origName = (l.name || '').trim();
      if (origName && kanaRegex.test(origName)) {
        const transName = (l.trans_name || '').trim();
        if (!transName) {
          errors.push('Name Not Translated');
          untransNameCount++;
        } else if (transName === origName) {
          errors.push('Name Copied (JP)');
          untransNameCount++;
        } else if (kanaRegex.test(transName)) {
          errors.push('Name JP Residue');
          untransNameCount++;
        }
      }
    }

    if (checkSim) {
      let flagged = false;
      if (origRawMsg.length >= 2 || transRawMsg.length >= 2) {
        const simMsg = stringSimilarity(origRawMsg, transRawMsg);
        if (simMsg >= simThreshold) {
          errors.push(`Sim: Teks (${Math.round(simMsg * 100)}%)`);
          flagged = true;
        }
      }
      if (origRawName && transRawName && (origRawName.length >= 2 || transRawName.length >= 2)) {
        const simName = stringSimilarity(origRawName, transRawName);
        if (simName >= simThreshold) {
          errors.push(`Sim: Nama (${Math.round(simName * 100)}%)`);
          flagged = true;
        }
      }
      if (flagged) simCount++;
    }

    if (checkGloss) {
      const missingTerms: string[] = [];
      const combinedOrig = (origRawName ? origRawName + '\n' : '') + origRawMsg;
      const combinedTrans = (transRawName ? transRawName + '\n' : '') + transRawMsg;

      for (const [src, entry] of glossaryMap) {
        if (!entry.target) continue;
        if (combinedOrig.includes(src)) {
          const re = new RegExp('\\b' + escapeRegex(entry.target) + '\\b', 'i');
          if (!re.test(combinedTrans)) {
            missingTerms.push(src);
          }
        }
      }
      if (missingTerms.length > 0) {
        errors.push(`Glossary (${missingTerms.join(', ')})`);
        glossCount++;
      }
    }

    if (checkLinebreak) {
      const origBrk = countLinebreaks(l.message || '');
      const transBrk = countLinebreaks(l.trans_message || '');
      if (origBrk !== transBrk) {
        errors.push(`Linebreak (${transBrk}/${origBrk})`);
        linebreakCount++;
      }
    }

    if (checkLength) {
      const origLen = countGraphemes(origRawMsg);
      const transLen = countGraphemes(transRawMsg);
      if (origLen > 0 && transLen > 0) {
        const ratio = transLen / origLen;
        if (ratio > lengthThreshold) {
          errors.push(`Length ${ratio.toFixed(1)}x (${transLen}/${origLen})`);
          lengthCount++;
        }
      }
    }

    if (checkLanguage) {
      const combined = (transRawName ? transRawName + ' ' : '') + transRawMsg;
      if (detectEnglishFallback(combined)) {
        errors.push('Wrong Language (EN?)');
        langCount++;
      }
    }

    if (checkPunct) {
      const combined = (transRawName || '') + transRawMsg;
      const jpPuncts = findJpPunctuation(combined);
      if (jpPuncts.length > 0) {
        errors.push(`JP Punct (${jpPuncts.join('')})`);
        punctCount++;
      }
    }

    if (checkUncertain) {
      const combined = (transRawName || '') + ' ' + transRawMsg;
      if (combined.includes('[?]')) {
        errors.push('Uncertain [?]');
        uncertainCount++;
      }
    }

    if (errors.length > 0) {
      state.qaMatches.push({
        num: l.line_num,
        file: l.file,
        origName: l.name,
        origMsg: l.message,
        transName: l.trans_name,
        transMsg: l.trans_message,
        errors,
      });
    }
  }

  const parts: string[] = [];
  if (kanaCount) parts.push(`Kana: ${kanaCount}`);
  if (simCount) parts.push(`Sim: ${simCount}`);
  if (glossCount) parts.push(`Gloss: ${glossCount}`);
  if (linebreakCount) parts.push(`Brk: ${linebreakCount}`);
  if (lengthCount) parts.push(`Len: ${lengthCount}`);
  if (langCount) parts.push(`Lang: ${langCount}`);
  if (punctCount) parts.push(`Punct: ${punctCount}`);
  if (uncertainCount) parts.push(`Uncertain: ${uncertainCount}`);
  if (untransNameCount) parts.push(`Name: ${untransNameCount}`);
  const total = kanaCount + simCount + glossCount + linebreakCount + lengthCount + langCount + punctCount + uncertainCount + untransNameCount;
  ui.qaStats.textContent = `Selesai. ${total} pelanggaran pada ${state.qaMatches.length} baris (${parts.join(', ') || 'bersih'}).`;
  getQaScroller().setItems(state.qaMatches);

  const btn = document.getElementById('btnRetranslateFlagged');
  if (btn) btn.style.display = state.qaMatches.length > 0 ? '' : 'none';
}

// ─── Retranslate Flagged ──────────────────────────────────────────────────────

export async function onRetranslateFlagged(): Promise<void> {
  if (state.qaMatches.length === 0) return;
  const nums = state.qaMatches.map(m => m.num);

  // Clear translations for flagged lines
  for (const num of nums) {
    const l = state.lineByNum.get(num);
    if (l) {
      l.is_translated = false;
      l.trans_message = null;
      l.trans_name = null;
    }
  }


  // Close QA modal, select flagged lines, trigger auto-translate
  closeModal(ui.qaModal as HTMLElement);
  state.selectedLines.clear();
  for (const num of nums) state.selectedLines.add(num);
  import('./render').then(m => m.syncCheckboxUI());
  import('./auto-translate').then(m => m.onAutoTranslate());
}

export function renderQaRow(r: QaMatch): HTMLElement {
  const row = document.createElement('div');
  row.className = 'preview-row';
  const contentWrap = document.createElement('div');
  contentWrap.className = 'text-content';

  const titleEl = document.createElement('div');
  titleEl.className = 'hint m-0 label-bold mb-1 flex-center gap-10';
  titleEl.textContent = r.file + ` (Baris ${r.num})`;

  for (const err of r.errors) {
    const badge = document.createElement('span');
    badge.className = 'badge';
    if (err.startsWith('Kana')) badge.style.background = 'var(--danger)';
    else if (err.startsWith('Sim')) badge.style.background = '#f59e0b';
    else if (err.startsWith('Linebreak')) badge.style.background = '#8b5cf6';
    else if (err.startsWith('Length')) badge.style.background = '#ec4899';
    else if (err.startsWith('Wrong')) badge.style.background = '#ef4444';
    else if (err.startsWith('JP')) badge.style.background = '#f97316';
    else if (err.startsWith('Uncertain')) badge.style.background = '#b9975b';
    else if (err.startsWith('Name')) badge.style.background = '#2d7d5f';
    else badge.style.background = 'var(--primary)';
    badge.textContent = err;
    titleEl.appendChild(badge);
  }

  const buildNodes = (name: string | null, msg: string | null) => {
    const wrap = document.createDocumentFragment();
    if (name) {
      wrap.appendChild(document.createTextNode(name + ': '));
    }
    const mSpan = document.createElement('span');
    mSpan.className = 'text-muted';
    mSpan.textContent = msg || '';
    wrap.appendChild(mSpan);
    const div = document.createElement('div');
    div.appendChild(wrap);
    return div;
  };

  contentWrap.appendChild(titleEl);
  contentWrap.appendChild(buildNodes(r.origName, r.origMsg));
  // get updated translation dynamically
  const l = state.lineByNum.get(r.num);
  const tName = l ? l.trans_name : r.transName;
  const tMsg = l ? l.trans_message : r.transMsg;
  contentWrap.appendChild(buildNodes(tName, tMsg));

  row.appendChild(contentWrap);
  row.style.cursor = 'pointer';
  row.addEventListener('click', () => {
    closeModal(ui.qaModal as HTMLElement);
    openLineEditor(r.num);
  });
  return row;
}