// @module ai-check-linter.ts — Deterministic local checks for AI Check.
// No AI involved: leftover Japanese punctuation/kana detection, glossary name
// mismatch hints, and no-op detection for parsed corrections.

import { state } from './state';
import { parseGlossaryToMap } from './glossary';
import type { Line } from './types';

/** Japanese punctuation that should never survive into a translated line. */
const JP_PUNCT_RE = /[。、・〜ー]/g;
/** Any CJK character (kana + kanji + fullwidth forms zone). */
const CJK_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff66-\uff9f]/;

export interface LintFinding {
  num: number;
  kind: 'jp-punct' | 'cjk-residue' | 'glossary-name' | 'double-space' | 'empty';
  detail: string;
  /** True when the fix is deterministic enough to auto-apply locally. */
  autoFixable: boolean;
  /** Replacement text when autoFixable. */
  fixedText?: string;
  fixedName?: string;
}

function stripSpeaker(text: string, name: string | undefined): string {
  const t = String(text || '');
  if (!name) return t;
  const sep1 = `${name}: `;
  const sep2 = `${name}：`;
  if (t.startsWith(sep1)) return t.slice(sep1.length);
  if (t.startsWith(sep2)) return t.slice(sep2.length);
  return t;
}

/**
 * Deterministic checks over already-translated lines. Cheap enough to run on
 * every batch — the result feeds both the correction filter (in ai-check.ts)
 * and the AI prompt hints (baris yang terindikasi bermasalah disorot).
 */
export function lintTranslatedLines(lines: Line[]): LintFinding[] {
  const findings: LintFinding[] = [];
  const glossary = parseGlossaryToMap(state.glossaryText);

  for (const line of lines) {
    const raw = line.trans_message || '';
    if (!raw.trim()) continue;
    const speaker = (line.trans_name || '').trim() || line.name || '';
    const body = stripSpeaker(raw, speaker || undefined);

    // 1. Leftover JP punctuation — deterministic fix.
    if (JP_PUNCT_RE.test(body)) {
      JP_PUNCT_RE.lastIndex = 0;
      const fixed = body.replace(JP_PUNCT_RE, (ch) => {
        switch (ch) {
          case '。': return '.';
          case '、': return ',';
          case '・': return ' · ';
          case '〜': return '~';
          case 'ー': return '-';
          default: return ch;
        }
      });
      findings.push({
        num: line.line_num,
        kind: 'jp-punct',
        detail: `Sisa tanda baca Jepang: ${body.match(JP_PUNCT_RE)?.join(' ') || ''}`,
        autoFixable: true,
        fixedText: raw.replace(body, fixed),
      });
      JP_PUNCT_RE.lastIndex = 0;
    }

    // 2. CJK residue — flag only (kanji can be legitimate in some settings).
    if (CJK_RE.test(body)) {
      const sample = body.match(new RegExp(CJK_RE.source, 'g'))?.slice(0, 12).join('') || '';
      findings.push({
        num: line.line_num,
        kind: 'cjk-residue',
        detail: `Karakter Jepang/CJK tersisa di terjemahan: "${sample}"`,
        autoFixable: false,
      });
    }

    // 3. Glossary mismatch on speaker name — flag only.
    if (line.name && glossary.size) {
      const entry = glossary.get(line.name.trim());
      const currentTrans = (line.trans_name || '').trim();
      if (entry && entry.target && currentTrans && currentTrans !== entry.target) {
        findings.push({
          num: line.line_num,
          kind: 'glossary-name',
          detail: `Nama "${currentTrans}" berbeda dari glosarium ("${entry.target}" untuk "${line.name}")`,
          autoFixable: true,
          fixedName: entry.target,
        });
      }
    }

    // 4. Double spaces in the message — deterministic fix.
    if (/ {2,}(?=\S)/.test(body)) {
      const fixed = body.replace(/ {2,}(?=\S)/g, ' ');
      findings.push({
        num: line.line_num,
        kind: 'double-space',
        detail: 'Spasi ganda',
        autoFixable: true,
        fixedText: raw.replace(body, fixed),
      });
    }
  }
  return findings;
}

/**
 * Build a short hint block appended to the AI Check prompt so the model pays
 * extra attention to lines the local linter flagged.
 */
export function buildLintHintBlock(findings: LintFinding[]): string {
  const flagged = findings.filter(f => !f.autoFixable);
  if (!flagged.length) return '';
  const items = flagged.slice(0, 40).map(f => `- [line ${f.num}] ${f.detail}`);
  const block = `<local_lint_hints>\nIndikasi dari pemeriksaan lokal (kemungkinan besar bermasalah, periksa khusus baris ini):\n${items.join('\n')}\n</local_lint_hints>`;
  return block;
}

/** Normalize for no-op comparison: collapse whitespace, trim quotes. */
export function normalizeForNoopCheck(s: string): string {
  return String(s || '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .trim();
}
