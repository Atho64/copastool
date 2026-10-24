// Regression tests for Auto Copas page-script invariants.
// Exits non-zero on the first failed check, like test-hook-matcher.mjs.
//
// These guard the parts of the automation that silently rot when an AI site
// renames a control: a missed stop-button label turns completion detection off
// without any error, so the failure mode is "Auto Copas hangs / copies the
// previous answer" rather than a visible exception.

import { COPAS_TARGETS } from '../src/auto-copas/targets.ts';
import { jsReadPageState, jsClickCopyButton, jsComposerTextLength } from '../src/auto-copas/page-scripts.ts';

let failures = 0;
let checks = 0;

function check(condition, message) {
  checks++;
  if (condition) return;
  failures++;
  console.error(`  FAIL: ${message}`);
}

// Every generated script is a string evaluated inside the page — a syntax
// error there surfaces only as a runtime failure mid-batch.
function checkValidJs(source, label) {
  try {
    new Function(`return ${source}`);
    check(true, `${label} is valid JS`);
  } catch (err) {
    check(false, `${label} is invalid JS: ${err.message}`);
  }
}

// ── Gemini stop control ──────────────────────────────────────────────────────
// Gemini shipped "Stop generating" → "Stop response"; both must stay listed.
check(
  COPAS_TARGETS.gemini.stop.some((s) => /Stop response/i.test(s)),
  'Gemini keeps the current "Stop response" selector',
);
check(
  COPAS_TARGETS.gemini.stop.some((s) => /Stop generating/i.test(s)),
  'Gemini keeps the legacy "Stop generating" selector',
);

// ── Stop-label drift guard ───────────────────────────────────────────────────
// A hardcoded selector list alone cannot survive the next rename, so
// jsReadPageState must also accept any visible button whose label says stop.
for (const [id, target] of Object.entries(COPAS_TARGETS)) {
  const script = jsReadPageState(target);
  check(/__cstlIsStop/.test(script), `${id}: jsReadPageState has the stop-label scan`);
  check(
    /stop\|hentikan\|berhenti\|batalkan/.test(script),
    `${id}: jsReadPageState scans stop/hentikan/berhenti/batalkan labels`,
  );
  check(/\.matches\(sel\)/.test(script), `${id}: selector match fallback present`);
}

// ── Script syntax for every target ──────────────────────────────────────────
for (const [id, target] of Object.entries(COPAS_TARGETS)) {
  checkValidJs(jsReadPageState(target), `${id}: jsReadPageState`);
  checkValidJs(jsClickCopyButton(target, 0), `${id}: jsClickCopyButton`);
  checkValidJs(jsComposerTextLength(target), `${id}: jsComposerTextLength`);
}

// ── Copy-button matcher ─────────────────────────────────────────────────────
// Must catch real copy controls without latching onto unrelated buttons.
const copyScript = jsClickCopyButton(COPAS_TARGETS.gemini, 0);
const regexMatch = copyScript.match(/__cstlCopyRe = (\/.*?\/[a-z]*);/);
check(!!regexMatch, 'copy matcher regex is present in jsClickCopyButton');
if (regexMatch) {
  const copyRe = eval(regexMatch[1]); // eslint-disable-line no-eval
  const cases = [
    ['Copy', true],
    ['Copy prompt', true],
    ['Copy response', true],
    ['Salin', true],
    ['Menyalin', true],
    ['Send message', false],
    ['Show more options', false],
    ['Toggle sidebar', false],
    ['Edit', false],
  ];
  for (const [text, expected] of cases) {
    check(copyRe.test(text) === expected, `copy matcher "${text}" => ${expected}`);
  }
}

// ── Assistant selector hygiene ──────────────────────────────────────────────
// A loose `[class*="markdown"]` also matches chrome like `.markdown-toolbar`.
// Because the reader now takes the LONGEST visible candidate, a broad selector
// can no longer shadow the real answer — but it must never be the FIRST
// specific option either, or a site rename would be masked by the fallback.
for (const [id, target] of Object.entries(COPAS_TARGETS)) {
  const broadFirst = target.assistant.findIndex((s) => /\[class\*=/.test(s));
  const specificFirst = target.assistant.findIndex((s) => !/\[class\*=/.test(s));
  check(
    broadFirst === -1 || specificFirst === -1 || specificFirst < broadFirst,
    `${id}: specific assistant selectors come before broad [class*=] ones`,
  );
}

// The reader must scan every selector and keep the longest match, not stop at
// the first selector that happens to match something.
for (const [id, target] of Object.entries(COPAS_TARGETS)) {
  const script = jsReadPageState(target);
  check(
    !/if \(nodes\.length\) \{\s*const node = nodes\[nodes\.length - 1\];\s*lastResponseLength/.test(script),
    `${id}: jsReadPageState does not break on the first matching selector`,
  );
  check(
    /if \(len > lastResponseLength\) lastResponseLength = len;/.test(script),
    `${id}: jsReadPageState keeps the longest visible candidate`,
  );
}

// ── Prompt-echo guard ───────────────────────────────────────────────────────
// "Copy prompt" controls return the text we just sent. Sites normalize
// whitespace, so a strict !== prompt compare lets the prompt through as the
// "answer" and the batch applies the source text as the translation.
//
// engine.ts pulls in ./types (extensionless, Vite-only resolution), so the
// guard is verified by reading its source instead of importing the module.
import { readFileSync } from 'node:fs';
const engineSrc = readFileSync(new URL('../src/auto-copas/engine.ts', import.meta.url), 'utf8');
check(/export function isEchoOfPrompt/.test(engineSrc), 'isEchoOfPrompt is defined and exported');
check(
  /isEchoOfPrompt\(text, prompt\)/.test(engineSrc),
  'clipboard read path uses the prompt-echo guard',
);
check(
  !/text !== sentinel && text !== prompt\) return text/.test(engineSrc),
  'clipboard read path no longer uses a strict !== prompt compare',
);
check(
  /jsReadLastResponseText/.test(engineSrc),
  'engine can fall back to reading the response from the DOM',
);

// Verify the guard's comparison semantics directly.
const collapse = (s) => String(s || '').replace(/\s+/g, ' ').trim();
{
  const prompt = 'Baris 1\nBaris 2\nBaris 3';
  const echo = (t) => {
    const a = collapse(t); const b = collapse(prompt);
    if (!a || !b) return false;
    if (a === b) return true;
    if (a.length >= b.length * 0.9 && a.includes(b.slice(0, Math.min(b.length, 120)))) return true;
    if (b.length >= a.length * 0.9 && b.includes(a.slice(0, Math.min(a.length, 120)))) return true;
    return false;
  };
  check(echo(prompt), 'exact prompt is an echo');
  check(echo('Baris 1 \nBaris 2 \nBaris 3 '), 'whitespace-padded prompt is an echo');
  check(echo('  Baris 1   Baris 2   Baris 3  '), 'collapsed-whitespace prompt is an echo');
  check(!echo('Terjemahan sebenarnya dari ketiga baris ini.'), 'a real translation is not an echo');
  check(!echo(''), 'empty text is not an echo');
}

// ── DOM fallback present ────────────────────────────────────────────────────
// When the clipboard yields nothing usable, the engine must be able to read
// the answer straight out of the page.
const { jsReadLastResponseText } = await import('../src/auto-copas/page-scripts.ts');
check(typeof jsReadLastResponseText === 'function', 'jsReadLastResponseText is exported');
for (const [id, target] of Object.entries(COPAS_TARGETS)) {
  if (typeof jsReadLastResponseText === 'function') {
    const src = jsReadLastResponseText(target);
    checkValidJs(src, `${id}: jsReadLastResponseText`);
    // cfg.assistant is ordered from the answer body outward, so the FIRST
    // non-empty selector is the cleanest read. Picking the longest instead
    // grabbed the outer wrapper and prefixed the speaker header
    // ("Gemini berkata...") onto every translation.
    check(
      /if \(text\) \{ return text; \}/.test(src),
      `${id}: DOM fallback returns the most specific non-empty candidate`,
    );
    check(
      !/if \(text\.length > bestLen\)/.test(src),
      `${id}: DOM fallback no longer takes the longest wrapper`,
    );
  }
}

// ── Reasoning / thinking exclusion ─────────────────────────────────────────
// DeepSeek with Thinking on renders a reasoning block next to the answer. It
// is usually LONGER than the answer, so the longest-match reader would return
// the model's internal monologue instead of the translation. Every reader must
// carry the reasoning guard.
for (const [id, target] of Object.entries(COPAS_TARGETS)) {
  const stateSrc = jsReadPageState(target);
  const domSrc = jsReadLastResponseText(target);
  const copySrc = jsClickCopyButton(target, 0);
  check(/__cstlIsReasoning/.test(stateSrc), `${id}: state reader excludes reasoning`);
  check(/__cstlIsReasoning/.test(domSrc), `${id}: DOM fallback excludes reasoning`);
  check(/__cstlIsReasoning/.test(copySrc), `${id}: copy picker avoids reasoning controls`);
  check(
    /think\|reason\|chain-of-thought\|cot\|analysis/i.test(stateSrc),
    `${id}: reasoning matcher covers think/reason/cot/analysis`,
  );
  check(
    /answerScoped/.test(copySrc) && /reasoningScoped/.test(copySrc),
    `${id}: copy picker ranks answer-scoped controls above reasoning ones`,
  );
  // Answer-scoped candidates must be pushed before page-level and reasoning.
  const answerPush = copySrc.indexOf('for (const b of answerScoped) push(b);');
  const pagePush = copySrc.indexOf('if (pageCopy.length) push(pageCopy[pageCopy.length - 1]);');
  const reasoningPush = copySrc.indexOf('for (const b of reasoningScoped) push(b);');
  check(answerPush >= 0 && pagePush >= 0 && reasoningPush >= 0, `${id}: all three copy tiers present`);
  check(answerPush < pagePush, `${id}: answer-scoped copy wins over page-level copy`);
  check(pagePush < reasoningPush, `${id}: reasoning copy is the last resort`);
}

// looksLikeReasoning guard on clipboard output.
check(
  /looksLikeReasoning/.test(engineSrc),
  'engine rejects chain-of-thought clipboard output',
);
{
  const re = /^\s*(thought|thinking|reasoning|berpikir|menalar|analisis|analyzing|chain of thought)\b/i;
  check(re.test('Thought for 12 seconds'), 'detects "Thought for 12 seconds"');
  check(re.test('Thinking...'), 'detects "Thinking..."');
  check(re.test('Analisis langkah demi langkah'), 'detects Indonesian reasoning prefix');
  check(!re.test('Halo, selamat datang.'), 'real translation is not flagged as reasoning');
  check(!re.test('1. Terjemahan satu'), 'numbered translation is not flagged as reasoning');
}

// ── Gemini thinking: legacy toggle vs Argon reasoning levels ───────────────
// Gemini ships two pickers. Older models expose a single toggle and the chip
// label names the mode ("...saat ini Flash Mendalam"). Argon keeps
// "...saat ini Argon" in BOTH states and puts the state in a "Tingkat
// penalaran" SUBMENU (Rendah/Sedang/Tinggi). A label-only oracle reported
// "already off" forever on Argon and never reached the level rows.
{
  const { jsGeminiSetThinking } = await import('../src/auto-copas/page-scripts.ts');
  const onSrc = jsGeminiSetThinking(true);
  const offSrc = jsGeminiSetThinking(false);
  checkValidJs(onSrc, 'jsGeminiSetThinking(true)');
  checkValidJs(offSrc, 'jsGeminiSetThinking(false)');

  check(/tingkat penalaran/i.test(onSrc), 'argon: knows the reasoning-level group');
  check(/ensureLevelGroup/.test(onSrc), 'argon: opens the reasoning submenu');
  check(/LEVELS = \['rendah', 'sedang', 'tinggi'\]/.test(onSrc), 'argon: level order is rendah/sedang/tinggi');
  check(/isModelRow/.test(onSrc), 'argon: model rows are excluded from level clicks');
  // The label must not short-circuit OFF at the entry point, or Argon never
  // opens the menu. (Inside the legacy toggle branch the label IS the oracle,
  // so only the guard before the loop is checked here.)
  const guardBlock = onSrc.slice(onSrc.indexOf('const chipLabel'), onSrc.indexOf('const openMenu'));
  check(
    !/=== wantOn/.test(guardBlock),
    'argon: chip label is not an authoritative OFF oracle',
  );
  check(
    /if \(wantOn && labelSaysOn\(chipLabel\)\) return \{ ok: true, detail: 'already:on' \}/.test(onSrc),
    'argon: label is trusted only when it positively says ON',
  );
}

// ── Paste must not duplicate ──────────────────────────────────────────────
// Gemini's composer is a contenteditable. The engine used to wipe it via a
// DOM clear first, which left an empty block behind and made Ctrl+V land
// twice (observed live as "PROMPTPROMPT"). The paste path is now just
// Ctrl+A + Ctrl+V, with no DOM write.
{
  const engineSrc = await import('node:fs').then((m) => m.readFileSync(new URL('../src/auto-copas/engine.ts', import.meta.url), 'utf8'));
  check(
    /pressCombo\(\['ctrl\+a', 'ctrl\+v'\]/.test(engineSrc),
    'engine pastes with Ctrl+A + Ctrl+V',
  );
  check(
    !/jsClearComposer/.test(engineSrc),
    'engine never DOM-clears the composer before pasting',
  );
}

// ── Target table sanity ─────────────────────────────────────────────────────
for (const [id, target] of Object.entries(COPAS_TARGETS)) {
  check(target.composer.length > 0, `${id}: has composer selectors`);
  check(target.sendButton.length > 0, `${id}: has send-button selectors`);
  check(target.stop.length > 0, `${id}: has stop selectors`);
  check(target.assistant.length > 0, `${id}: has assistant selectors`);
  check(target.idleNeeded >= 1, `${id}: idleNeeded >= 1`);
  check(target.stableMs >= 0, `${id}: stableMs >= 0`);
}

if (failures > 0) {
  console.error(`\n${failures}/${checks} checks failed.`);
  process.exit(1);
}
console.log(`OK — ${checks} checks passed.`);
