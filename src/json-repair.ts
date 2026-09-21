// @module json-repair.ts — Salvage readable fields from a damaged JSON project file
//
// A .cstl project is one large JSON object. When the file is truncated or
// damaged, JSON.parse rejects the whole document even though everything before
// the damage point is intact. These scanners walk the text with proper
// string/escape handling and keep every complete top-level field; inside
// arrays, complete entries before the damage are kept and the partial tail is
// dropped. Scanning always stops at the first unreadable region — never
// re-sync past damage, that risks stitching mismatched data together.

interface ReadResult { value: any; end: number; incomplete?: boolean }

function isWs(c: string): boolean {
  return c === ' ' || c === '\t' || c === '\n' || c === '\r';
}

function skipWs(s: string, i: number): number {
  const len = s.length;
  while (i < len && isWs(s[i])) i++;
  return i;
}

/** Read a JSON string token starting at s[start] === '"'. */
function readString(s: string, start: number): ReadResult | null {
  let i = start + 1;
  const len = s.length;
  while (i < len) {
    const c = s[i];
    if (c === '\\') { i += 2; continue; } // skip escape; \uXXXX hex digits are inert
    if (c === '"') {
      try {
        return { value: JSON.parse(s.slice(start, i + 1)), end: i + 1 };
      } catch (_) { return null; }
    }
    i++;
  }
  return null; // unterminated string
}

/** Read a bare token: number / true / false / null. */
function readPrimitive(s: string, start: number): ReadResult | null {
  let i = start;
  const len = s.length;
  while (i < len) {
    const c = s[i];
    if (c === ',' || c === '}' || c === ']' || isWs(c)) break;
    i++;
  }
  if (i === start) return null;
  try {
    return { value: JSON.parse(s.slice(start, i)), end: i };
  } catch (_) { return null; }
}

function readArray(s: string, start: number): ReadResult | null {
  let i = start + 1; // past '['
  const out: any[] = [];
  while (true) {
    i = skipWs(s, i);
    if (i >= s.length) return { value: out, end: i, incomplete: true };
    if (s[i] === ']') return { value: out, end: i + 1 };
    const r = readValue(s, i);
    // A partially readable entry (truncated last line object) is dropped.
    if (!r || r.incomplete) return { value: out, end: i, incomplete: true };
    out.push(r.value);
    i = skipWs(s, r.end);
    if (i >= s.length) return { value: out, end: i, incomplete: true };
    if (s[i] === ',') { i++; continue; }
    if (s[i] === ']') return { value: out, end: i + 1 };
    return { value: out, end: i, incomplete: true };
  }
}

function readObject(s: string, start: number): ReadResult | null {
  let i = start + 1; // past '{'
  const out: Record<string, any> = {};
  while (true) {
    i = skipWs(s, i);
    if (i >= s.length) return { value: out, end: i, incomplete: true };
    if (s[i] === '}') return { value: out, end: i + 1 };
    if (s[i] !== '"') return { value: out, end: i, incomplete: true };
    const k = readString(s, i);
    if (!k || typeof k.value !== 'string') return { value: out, end: i, incomplete: true };
    i = skipWs(s, k.end);
    if (i >= s.length || s[i] !== ':') return { value: out, end: i, incomplete: true };
    i = skipWs(s, i + 1);
    if (i >= s.length) return { value: out, end: i, incomplete: true };
    const v = readValue(s, i);
    // Keep incomplete values (e.g. a truncated "lines" array is the salvage
    // target); the outer level decides to stop after them.
    if (!v) return { value: out, end: i, incomplete: true };
    out[k.value] = v.value;
    i = skipWs(s, v.end);
    if (i >= s.length) return { value: out, end: i, incomplete: true };
    if (s[i] === ',') { i++; continue; }
    if (s[i] === '}') return { value: out, end: i + 1 };
    return { value: out, end: i, incomplete: true };
  }
}

function readValue(s: string, start: number): ReadResult | null {
  const c = s[start];
  if (c === '"') return readString(s, start);
  if (c === '{') return readObject(s, start);
  if (c === '[') return readArray(s, start);
  return readPrimitive(s, start);
}

/**
 * Best-effort salvage of a damaged JSON document. Returns the object with
 * every field that parsed completely (arrays truncated to their last complete
 * entry), or null when nothing usable remains.
 */
export function salvageJsonObject(text: string): Record<string, any> | null {
  const r = readValue(text, skipWs(text, 0));
  if (!r || !r.value || typeof r.value !== 'object' || Array.isArray(r.value)) return null;
  return Object.keys(r.value).length > 0 ? r.value : null;
}
