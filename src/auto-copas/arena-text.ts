// @module auto-copas/arena-text.ts — Arena response text normalization.
// Port of the extension's shared/text-utils.ts (normalizeQwenResponseText) and
// arena fixArenaLineNumbers. Applied to Arena's clipboard captures: Arena
// renders the translation payload in a Monaco-style code block whose
// line-number gutter can leak into the copied text, and its model likes to
// restart numbering at 1.

/** Normalize the Arena/Qwen-style inline-rendered numbered translation blocks. */
export function normalizeQwenStyleText(raw: string): string {
  let text = raw.replace(/\u00a0/g, ' ').replace(/\r\n?/g, '\n').trim();
  // The model may append the prompt context in a tagged block; it is not output.
  text = text.replace(/\s*<background>[\s\S]*?<\/background>\s*$/i, '').trim();

  // Monaco's detached DOM can flatten its line-number gutter before the
  // content: "123...24251. First line2. Second line". Strip an exact
  // concatenated 1..N prefix when it is immediately followed by output line 1.
  const plaintextPrefix = text.match(/^(?:text\s*)?plaintext/i);
  const prefixOffset = plaintextPrefix?.[0].length || 0;
  const afterLabel = text.slice(prefixOffset).trimStart();
  let sequence = '';
  let gutterLength = 0;
  for (let n = 1; n <= 500 && sequence.length < afterLabel.length; n++) {
    sequence += String(n);
    if (afterLabel.startsWith(`${sequence}1. `)) gutterLength = sequence.length;
  }
  if (gutterLength >= 5) text = afterLabel.slice(gutterLength);

  // AI Check payloads flatten into "plaintext123... [line 12]category: ...".
  // Remove the code-editor gutter prefix and restore structural newlines.
  const firstAiCheckBlock = text.search(/\[line\s+\d+\]/i);
  if (firstAiCheckBlock >= 0) {
    const prefix = text.slice(0, firstAiCheckBlock).replace(/\s+/g, ' ').trim();
    if (!prefix || /^(?:text\s*)?plaintext[\d\s]*$/i.test(prefix) || !/[A-Za-zÀ-ÿぁ-んァ-ン一-龯]/.test(prefix)) {
      text = text.slice(firstAiCheckBlock);
    }
    text = text
      .replace(/([^\n])(?=\[line\s+\d+\])/gi, '$1\n')
      .replace(/(\[line\s+\d+\])\s*(?=category\s*:)/gi, '$1\n')
      .replace(/([^\n])(?=reason\s*:)/gi, '$1\n')
      .replace(/([^\n])(?=(?:correction|text|name)\s*:)/gi, '$1\n');
  }

  // Glossary code blocks suffer from the same flattened-span rendering:
  // "plaintext123[character] A = B {...}[term] C = D {...}".
  const glossaryType = '(?:character|place|organization|item|ability|title|concept|term)';
  const firstGlossaryEntry = text.search(new RegExp(`\\[${glossaryType}\\]\\s*[^=\\n]+\\s*=`, 'i'));
  if (firstGlossaryEntry >= 0) {
    const prefix = text.slice(0, firstGlossaryEntry).replace(/\s+/g, ' ').trim();
    if (!prefix || /^(?:text\s*)?plaintext[\d\s]*$/i.test(prefix) || !/[A-Za-zÀ-ÿぁ-んァ-ン一-龯]/.test(prefix)) {
      text = text.slice(firstGlossaryEntry);
    }
    text = text.replace(new RegExp(`([^\\n])(?=\\[${glossaryType}\\]\\s*[^=\\n]+\\s*=)`, 'gi'), '$1\n');
  }

  // A run of line-number spans can be flattened before the real marker, e.g.
  // "123456789...2829 6035. Akari...". Discard that UI-number prefix.
  const markers = [...text.matchAll(/(\d{4,6})\.\s/g)];
  if (markers.length >= 2) {
    const second = Number(markers[1][1]);
    const expectedFirst = second - 1;
    const secondIndex = markers[1].index ?? text.length;
    const expectedMarker = `${expectedFirst}. `;
    const expectedIndex = text.lastIndexOf(expectedMarker, secondIndex);
    if (expectedIndex >= 0) {
      const prefix = text.slice(0, expectedIndex);
      if (!/[A-Za-zÀ-ÿぁ-んァ-ン一-龯]/.test(prefix)) text = text.slice(expectedIndex);
    }
  }
  const firstMarker = text.search(/\d{4,6}\.\s/);
  if (firstMarker > 0) {
    const prefix = text.slice(0, firstMarker);
    const normalizedPrefix = prefix.replace(/\s+/g, ' ').trim();
    const isUiNumberNoise = !/[A-Za-zÀ-ÿぁ-んァ-ン一-龯]/.test(prefix);
    const isPlaintextUiNoise = /^(?:text\s*)?plaintext[\d\s]*$/i.test(normalizedPrefix);
    if (isUiNumberNoise || isPlaintextUiNoise) text = text.slice(firstMarker);
  }

  // Arena gutter can leak as isolated number-only lines between rows; strip them.
  text = text.split('\n').filter((line) => !/^\s*\d{1,4}\s*$/.test(line)).join('\n');

  // The model commonly glues markers: "1. ...2. ..." or "6035. ...6036. ...".
  text = restoreSequentialNumberedLineBreaks(text);

  text = text.split('\n')
    .map((line) => line.replace(/\s+$/g, '').trim())
    .filter(Boolean)
    .filter((line) => !/^\s*\d{1,4}\s*$/.test(line))
    .join('\n')
    .trim();
  return text;
}

function restoreSequentialNumberedLineBreaks(text: string): string {
  const first = text.match(/^\s*(\d{1,6})\.\s/);
  if (!first) return text;
  let expected = Number(first[1]) + 1;
  let restored = text;
  for (let i = 0; i < 1000; i++, expected++) {
    const pattern = new RegExp(`([^\\n])(${expected})\\.\\s`);
    if (!pattern.test(restored)) break;
    restored = restored.replace(pattern, '$1\n$2. ');
  }
  return restored;
}

/** Arena sometimes restarts response numbering at 1 while the payload uses the
 * original line numbers — renumber the response to match the prompt. */
export function fixArenaLineNumbers(response: string, payload: string): string {
  const payloadNums = [...payload.matchAll(/^\s*(\d+)\.\s/gm)].map((m) => parseInt(m[1], 10));
  if (!payloadNums.length) return response;
  const respLines = response.split('\n');
  const respNums: number[] = [];
  const respIdx: number[] = [];
  respLines.forEach((line, idx) => {
    const m = line.match(/^\s*(\d+)\.\s/);
    if (m) { respNums.push(parseInt(m[1], 10)); respIdx.push(idx); }
  });
  if (!respNums.length || respNums.length !== payloadNums.length) return response;
  if (respNums[0] === payloadNums[0]) return response;
  if (respNums[0] !== 1) return response;
  let out = response;
  for (let i = respIdx.length - 1; i >= 0; i--) {
    const lineIdx = respIdx[i];
    const expected = payloadNums[i];
    out = out.split('\n').map((l, j) => j === lineIdx ? l.replace(/^\s*\d+\.\s/, `${expected}. `) : l).join('\n');
  }
  return out;
}
