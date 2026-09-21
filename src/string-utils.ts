// @module string-utils.ts — Text and string manipulation utilities

export function unescapeStoredNewlines(text: string): string {
  return String(text || '').replace(/\\n/g, '\n');
}

export function escapeStoredNewlines(text: string): string {
  return String(text || '').replace(/\r?\n/g, '\\n').trim();
}

/**
 * Strips leaked AI metadata sections (such as === SUMMARY ===, <summary>, === REVISIONS ===)
 * that may have accidentally been appended to a translated dialogue line.
 * Supports both actual newlines (\n) and literal escaped newlines (\\n).
 */
export function stripLeakedAiSections(text: string): string {
  if (!text) return text;
  // Match strictly on a newline followed by known AI metadata section markers
  const markerRegex = /(?:(?:\r?\n|\\n)+\s*)(?:===+\s*(?:SUMMARY|BACKGROUND|REVISIONS?)\s*===*[\s\S]*|<\s*(?:summary|background|revisions?)\s*>[\s\S]*)/i;
  return text.replace(markerRegex, '').trim();
}

// Dice coefficient pada character bigrams — cepat dan efektif untuk deteksi terjemahan yang tidak berubah.
export function stringSimilarity(a: string, b: string): number {
  const s1 = String(a || '');
  const s2 = String(b || '');
  if (s1 === s2) return 1;
  if (s1.length < 2 || s2.length < 2) return 0;
  const getBigrams = (s: string) => {
    const map = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) {
      const bg = s[i] + s[i + 1];
      map.set(bg, (map.get(bg) || 0) + 1);
    }
    return map;
  };
  const bg1 = getBigrams(s1);
  const bg2 = getBigrams(s2);
  let intersection = 0;
  for (const [bg, count] of bg1) {
    if (bg2.has(bg)) intersection += Math.min(count, bg2.get(bg)!);
  }
  const total = s1.length - 1 + s2.length - 1;
  return total > 0 ? (2 * intersection) / total : 0;
}

export function escapeXml(str: string): string {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function normalizeFileBaseName(pathOrName: string): string {
  const normalized = String(pathOrName || '').replace(/\\/g, '/');
  return (normalized.split('/').pop() || normalized).replace(/\.json$/i, '');
}

// Note: mirrors WINDOWS_FILE_ORDER_COLLATOR from constants.ts
const WINDOWS_FILE_ORDER_COLLATOR = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: 'base',
});

function splitFileOrderParts(pathOrName: string): { dir: string; stem: string; ext: string } {
  const normalized = String(pathOrName || '').replace(/\\/g, '/');
  const slashIndex = normalized.lastIndexOf('/');
  const dir = slashIndex >= 0 ? normalized.slice(0, slashIndex + 1) : '';
  const fileName = slashIndex >= 0 ? normalized.slice(slashIndex + 1) : normalized;
  const dotIndex = fileName.lastIndexOf('.');
  if (dotIndex <= 0) return { dir, stem: fileName, ext: '' };
  return {
    dir,
    stem: fileName.slice(0, dotIndex),
    ext: fileName.slice(dotIndex),
  };
}

export function windowsFileOrderCompare(a: string, b: string): number {
  const left = splitFileOrderParts(a);
  const right = splitFileOrderParts(b);
  return WINDOWS_FILE_ORDER_COLLATOR.compare(left.dir, right.dir)
    || WINDOWS_FILE_ORDER_COLLATOR.compare(left.stem, right.stem)
    || WINDOWS_FILE_ORDER_COLLATOR.compare(left.ext, right.ext);
}

export function getFileOrderPath(file: File): string {
  return (file as any)?.webkitRelativePath || file?.name || '';
}

export function buildSafeFileName(name: string): string {
  return String(name || 'glossary').replace(/[<>:"\/\\|?*]/g, '_').trim() || 'glossary';
}

export function truncateForPrompt(text: string, maxLen = 180): string {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (clean.length <= maxLen) return clean;
  return `${clean.slice(0, maxLen - 3)}...`;
}

export function stripScrapedAiPreamble(text: string): string {
  return String(text || '').replace(
    /^\s*(?:gemini\s*(?:berkata|says|said)\s*)?plaintext\s*(?=(?:\d+\s*[.)]|\[line\s+\d+\]|<\?xml\b|<lines\b|<line\s+num=|\{\s*"num"|\[\s*\d+\s*,))/i,
    ''
  );
}

export function stripPlaintextFences(text: string): string {
  const clean = String(text || '')
    .split(/\r?\n/)
    .filter(line => !/^\s*```(?:plaintext|text|xml|jsonl|json)?\s*$/i.test(line.trim()))
    .filter(line => !/^\s*<\/?lines>\s*$/i.test(line.trim()))
    .filter(line => !/^\s*<\?xml\b[^>]*>\s*$/i.test(line.trim()))
    .join('\n');

  // Defensive cleanup for Gemini's scraped accessibility/code-block labels,
  // which can be joined to the first output token without whitespace.
  return stripScrapedAiPreamble(clean);
}

export function stripDecorativeWrapping(value: string): string {
  let clean = String(value || '').trim();
  const quotePairs: [string, string][] = [
    ['"', '"'],
    ["'", "'"],
    ['`', '`'],
    ['[', ']'],
    ['「', '」'],
    ['『', '』'],
  ];
  let changed = true;
  while (changed && clean.length >= 2) {
    changed = false;
    for (const [open, close] of quotePairs) {
      if (clean.startsWith(open) && clean.endsWith(close)) {
        clean = clean.slice(open.length, clean.length - close.length).trim();
        changed = true;
      }
    }
  }
  return clean;
}

export function matchKnownName(source: string, knownNames: Set<string>): string | null {
  const clean = stripDecorativeWrapping(source);
  if (knownNames.has(clean)) return clean;
  const normalized = clean.replace(/\s+/g, '');
  for (const name of knownNames) {
    if (name.replace(/\s+/g, '') === normalized) return name;
  }
  return null;
}

export function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function containsJapanese(text: string): boolean {
  return /[\u3040-\u30ff\u3400-\u9fff]/.test(text);
}

export function normalizeKana(text: string): string {
  return String(text || '')
    .normalize('NFKC')
    .replace(/[\s・･=＝~〜〜、，,]/g, '')
    .replace(/[\u30a1-\u30f6]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0x60));
}

export function applyReplaceRules(text: string, rulesText: string, fieldName?: 'name' | 'msg'): string {
  if (!text || !rulesText) return text;
  let result = text;
  const lines = rulesText.split(/\r?\n/);
  for (const line of lines) {
    if (!line.trim()) continue;

    // Check for field prefix: "name:" or "msg:" (case-insensitive)
    let ruleLine = line;
    const fieldMatch = line.match(/^(name|msg)\s*:\s*(.+)$/i);
    if (fieldMatch) {
      const ruleField = fieldMatch[1].toLowerCase();
      if (fieldName && ruleField !== fieldName) continue;
      ruleLine = fieldMatch[2];
    }

    // Check if it matches `/regex/flags = replacement`
    const regexMatch = ruleLine.match(/^\/(.+)\/([gimsuy]*)\s*=\s*(.*)$/);
    if (regexMatch) {
      try {
        const [, pattern, flags, replacement] = regexMatch;
        // ensure global flag if not present, otherwise it only replaces first occurrence
        const finalFlags = flags.includes('g') ? flags : flags + 'g';
        const re = new RegExp(pattern, finalFlags);
        const finalReplacement = replacement.replace(/\\n/g, '\n').replace(/\\t/g, '\t');
        result = result.replace(re, finalReplacement);
      } catch (e) {
        console.warn('Invalid regex in replacer rule:', line, e);
      }
    } else {
      // Literal replacement: `Source = Target`
      let sepIdx = ruleLine.indexOf('=');
      if (sepIdx !== -1) {
        const source = ruleLine.substring(0, sepIdx).trim();
        const replacement = ruleLine.substring(sepIdx + 1).trim().replace(/\\n/g, '\n').replace(/\\t/g, '\t');
        if (source) {
          result = result.split(source).join(replacement);
        }
      }
    }
  }
  return result;
}
export function kanaToRomaji(text: string): string {
  const kana = normalizeKana(text);
  const digraphs: Record<string, string> = {
    きゃ: 'kya', きゅ: 'kyu', きょ: 'kyo', しゃ: 'sha', しゅ: 'shu', しょ: 'sho',
    ちゃ: 'cha', ちゅ: 'chu', ちょ: 'cho', にゃ: 'nya', にゅ: 'nyu', にょ: 'nyo',
    ひゃ: 'hya', ひゅ: 'hyu', ひょ: 'hyo', みゃ: 'mya', みゅ: 'myu', みょ: 'myo',
    りゃ: 'rya', りゅ: 'ryu', りょ: 'ryo', ぎゃ: 'gya', ぎゅ: 'gyu', ぎょ: 'gyo',
    じゃ: 'ja', じゅ: 'ju', じょ: 'jo', びゃ: 'bya', びゅ: 'byu', びょ: 'byo',
    ぴゃ: 'pya', ぴゅ: 'pyu', ぴょ: 'pyo', ふぁ: 'fa', ふぃ: 'fi', ふぇ: 'fe', ふぉ: 'fo',
    てぃ: 'ti', でぃ: 'di', うぃ: 'wi', うぇ: 'we', うぉ: 'wo', ゔぁ: 'va', ゔぃ: 'vi', ゔぇ: 've', ゔぉ: 'vo',
  };
  const singles: Record<string, string> = {
    あ: 'a', い: 'i', う: 'u', え: 'e', お: 'o', か: 'ka', き: 'ki', く: 'ku', け: 'ke', こ: 'ko',
    さ: 'sa', し: 'shi', す: 'su', せ: 'se', そ: 'so', た: 'ta', ち: 'chi', つ: 'tsu', て: 'te', と: 'to',
    な: 'na', に: 'ni', ぬ: 'nu', ね: 'ne', の: 'no', は: 'ha', ひ: 'hi', ふ: 'fu', へ: 'he', ほ: 'ho',
    ま: 'ma', み: 'mi', む: 'mu', め: 'me', も: 'mo', や: 'ya', ゆ: 'yu', よ: 'yo',
    ら: 'ra', り: 'ri', る: 'ru', れ: 're', ろ: 'ro', わ: 'wa', を: 'o', ん: 'n',
    が: 'ga', ぎ: 'gi', ぐ: 'gu', げ: 'ge', ご: 'go', ざ: 'za', じ: 'ji', ず: 'zu', ぜ: 'ze', ぞ: 'zo',
    だ: 'da', ぢ: 'ji', づ: 'zu', で: 'de', ど: 'do', ば: 'ba', び: 'bi', ぶ: 'bu', べ: 'be', ぼ: 'bo',
    ぱ: 'pa', ぴ: 'pi', ぷ: 'pu', ぺ: 'pe', ぽ: 'po', ゔ: 'vu', ぁ: 'a', ぃ: 'i', ぅ: 'u', ぇ: 'e', ぉ: 'o',
  };
  let out = '';
  let doubleNext = false;
  for (let i = 0; i < kana.length; i++) {
    const ch = kana[i];
    if (ch === 'っ') {
      doubleNext = true;
      continue;
    }
    if (ch === 'ー') {
      const vowel = out.match(/[aeiou]$/)?.[0] || '';
      out += vowel;
      continue;
    }
    const pair = kana.slice(i, i + 2);
    let romaji = digraphs[pair];
    if (romaji) i++;
    else romaji = singles[ch] || ch;
    if (doubleNext && /^[bcdfghjklmnpqrstvwxyz]/.test(romaji)) {
      out += romaji[0];
    }
    out += romaji;
    doubleNext = false;
  }
  return out.replace(/n([bmp])/g, 'm$1').replace(/\b\w/g, ch => ch.toUpperCase());
}
