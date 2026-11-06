// @module text-hook-matcher.ts: matches raw hooked dialogue from LunaTranslator
// against project lines.

import type { Line } from './types';

export interface MatchResult {
  index: number;
  line: Line;
  prevLines: Line[];
  nextLines: Line[];
  score: number;
  matchType: 'exact' | 'contains' | 'fuzzy';
  matchedField: 'trans_message' | 'message';
}

export function normalizeDialogue(raw: string): string {
  if (!raw) return '';
  return raw
    .normalize('NFKC')
    // Remove common ruby/formatting tags
    .replace(/<[^>]+>/g, '')
    .replace(/\[[^\]]+\]/g, '')
    // Remove dialogue quotation brackets
    .replace(/[「」『』【】（）\(\)\[\]"'"〝〞〔〕〈〉`]/g, '')
    // Normalize ellipses and dashes
    .replace(/[…‥―ー～~-]/g, '')
    // Remove punctuation
    .replace(/[、。！？!?,.:;\s\u3000\r\n\\\/]/g, '')
    .toLowerCase();
}

/** Minimum length of a partial (prefix/infix) match; below it a "match" is more
 *  likely an accidental substring of an unrelated line than a real reveal. */
const MIN_PARTIAL_LEN = 6;

/** Prefix match bonus: dialogue is revealed left-to-right, so "A" -> "AB" is
 *  progress while "B" inside "AB" is not. */
const PREFIX_BONUS = 0.1;

/** Window around the last matched line that counts as "local": dialogue is read
 *  sequentially, so a nearby line wins when scores are close. */
const LOCAL_FORWARD_WINDOW = 40;
const LOCAL_BACKWARD_WINDOW = 10;

/** Score advantage a distant candidate needs to beat a nearby one; an exact
 *  match anywhere stays authoritative. */
const LOCALITY_MARGIN = 0.15;

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/**
 * Scores an overlap of `shared` characters. Coverage of the SHORTER side is what
 * matters, damped by the overlap's fraction of the longer side so long lines
 * don't swallow short hooks.
 */
function overlapScore(shared: number, normQuery: string, normCandidate: string, prefix: boolean): number {
  const shorter = Math.min(normQuery.length, normCandidate.length);
  const longer = Math.max(normQuery.length, normCandidate.length);
  if (shorter < MIN_PARTIAL_LEN) return 0;
  // Coverage of the shorter side, damped by the overlap relative to the longer side.
  const shortCoverage = shared / shorter;
  const longCoverage = shared / longer;
  const base = 0.5 * shortCoverage + 0.5 * longCoverage;
  return clamp01(base + (prefix ? PREFIX_BONUS : 0));
}

function scoreMatch(normQuery: string, normCandidate: string): { score: number; type: 'exact' | 'contains' | 'fuzzy' } | null {
  if (!normQuery || !normCandidate) return null;

  if (normQuery === normCandidate) {
    return { score: 1.0, type: 'exact' };
  }

  // Prefix match: streaming/partial reveal or line continuation.
  if (normCandidate.startsWith(normQuery) && normQuery.length >= MIN_PARTIAL_LEN) {
    return { score: overlapScore(normQuery.length, normQuery, normCandidate, true), type: 'contains' };
  }

  if (normQuery.startsWith(normCandidate) && normCandidate.length >= MIN_PARTIAL_LEN) {
    return { score: overlapScore(normCandidate.length, normQuery, normCandidate, true), type: 'contains' };
  }

  if (normCandidate.includes(normQuery) && normQuery.length >= MIN_PARTIAL_LEN) {
    return { score: overlapScore(normQuery.length, normQuery, normCandidate, false), type: 'contains' };
  }

  if (normQuery.includes(normCandidate) && normCandidate.length >= MIN_PARTIAL_LEN) {
    return { score: overlapScore(normCandidate.length, normQuery, normCandidate, false), type: 'contains' };
  }

  return null;
}

/** Tries the raw candidate, then speaker + text and hook without speaker. */
function testCandidate(
  normHook: string,
  candidateText: string,
  candidateSpeaker?: string | null,
): { score: number; type: 'exact' | 'contains' | 'fuzzy' } | null {
  if (!candidateText) return null;

  const normCandidate = normalizeDialogue(candidateText);
  if (!normCandidate) return null;

  const directMatch = scoreMatch(normHook, normCandidate);
  if (directMatch && directMatch.type === 'exact') return directMatch;

  let best = directMatch;

  if (candidateSpeaker) {
    const normSpeaker = normalizeDialogue(candidateSpeaker);
    if (normSpeaker) {
      const compositeMatch = scoreMatch(normHook, normSpeaker + normCandidate);
      if (compositeMatch && (!best || compositeMatch.score > best.score)) {
        best = compositeMatch;
        if (best.type === 'exact') return best;
      }

      if (normHook.startsWith(normSpeaker)) {
        const hookWithoutSpeaker = normHook.slice(normSpeaker.length);
        if (hookWithoutSpeaker) {
          const strippedMatch = scoreMatch(hookWithoutSpeaker, normCandidate);
          if (strippedMatch && (!best || strippedMatch.score > best.score)) {
            best = strippedMatch;
            if (best.type === 'exact') return best;
          }
        }
      }
    }
  }

  return best;
}

/**
 * Best matching line, checking line.trans_message then line.message.
 * Uses sequential locality: searches around lastMatchedIndex first.
 */
export function findMatchingLine(
  hookedText: string,
  lines: Line[],
  lastMatchedIndex = -1,
  contextRadius = 2,
): MatchResult | null {
  if (!lines || lines.length === 0 || !hookedText) return null;

  const normHook = normalizeDialogue(hookedText);
  if (!normHook) return null;

  const total = lines.length;
  const hasAnchor = lastMatchedIndex >= 0 && lastMatchedIndex < total;

  let bestMatch: {
    index: number;
    score: number;
    type: 'exact' | 'contains' | 'fuzzy';
    matchedField: 'trans_message' | 'message';
  } | null = null;

  const isLocal = (i: number): boolean =>
    hasAnchor && i >= lastMatchedIndex - LOCAL_BACKWARD_WINDOW
    && i <= lastMatchedIndex + LOCAL_FORWARD_WINDOW;

  /**
   * Decides whether a candidate replaces the current best. Exact matches are
   * authoritative but not globally short-circuiting: identical short lines are
   * common ("Iya", "Un"), so the exact match nearest the anchor wins.
   */
  const consider = (
    i: number,
    candidate: { score: number; type: 'exact' | 'contains' | 'fuzzy' },
    matchedField: 'trans_message' | 'message',
  ): boolean => {
    if (!bestMatch) {
      bestMatch = { index: i, ...candidate, matchedField };
      return candidate.type === 'exact' && !hasAnchor;
    }

    const bestIndex = bestMatch.index;
    const candidateLocal = isLocal(i);
    const bestLocal = isLocal(bestIndex);

    // An exact match beats any partial match anywhere, but a closer exact match
    // may still replace it.
    if (candidate.type === 'exact') {
      if (bestMatch.type !== 'exact') {
        bestMatch = { index: i, ...candidate, matchedField };
        return !hasAnchor;
      }
      const closerExact = hasAnchor
        ? Math.abs(i - lastMatchedIndex) < Math.abs(bestIndex - lastMatchedIndex)
        : false;
      if (closerExact) {
        bestMatch = { index: i, ...candidate, matchedField };
      }
      // Keep scanning: past the anchor, remaining lines can no longer be nearer.
      return i >= lastMatchedIndex;
    }

    if (bestMatch.type === 'exact') {
      return false;
    }

    if (candidateLocal && !bestLocal) {
      // Keep the local result unless the distant one is decisively better.
      if (candidate.score + LOCALITY_MARGIN >= bestMatch.score) {
        bestMatch = { index: i, ...candidate, matchedField };
      }
    } else if (candidateLocal === bestLocal) {
      // Same locality class: higher score wins, ties go to the nearer line.
      const closer = hasAnchor
        ? Math.abs(i - lastMatchedIndex) < Math.abs(bestIndex - lastMatchedIndex)
        : false;
      if (candidate.score > bestMatch.score || (candidate.score === bestMatch.score && closer)) {
        bestMatch = { index: i, ...candidate, matchedField };
      }
    } else if (candidate.score > bestMatch.score + LOCALITY_MARGIN) {
      // Distant candidate must clearly beat the local one to win.
      bestMatch = { index: i, ...candidate, matchedField };
    }

    return false;
  };

  for (let i = 0; i < total; i++) {
    const line = lines[i];
    if (!line || line._hidden) continue;

    // Priority 1: translated text, needed for patched games.
    if (line.trans_message) {
      const transMatch = testCandidate(normHook, line.trans_message, line.trans_name);
      if (transMatch && consider(i, transMatch, 'trans_message')) break;
    }

    // Priority 2: original text, for unpatched games or original hooks.
    if (line.message) {
      const origMatch = testCandidate(normHook, line.message, line.name);
      if (origMatch && consider(i, origMatch, 'message')) break;
    }
  }

  if (!bestMatch || bestMatch.score < 0.65) {
    return null;
  }

  const idx = bestMatch.index;
  const currentLine = lines[idx];

  const prevLines: Line[] = [];
  for (let i = idx - 1; i >= 0 && prevLines.length < contextRadius; i--) {
    if (lines[i] && !lines[i]._hidden) {
      prevLines.unshift(lines[i]);
    }
  }

  const nextLines: Line[] = [];
  for (let i = idx + 1; i < total && nextLines.length < contextRadius; i++) {
    if (lines[i] && !lines[i]._hidden) {
      nextLines.push(lines[i]);
    }
  }

  return {
    index: idx,
    line: currentLine,
    prevLines,
    nextLines,
    score: bestMatch.score,
    matchType: bestMatch.type,
    matchedField: bestMatch.matchedField,
  };
}
