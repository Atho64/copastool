// Regression tests for pasted-translation text handling.
// Exits non-zero on the first failed check, like test-hook-matcher.mjs.
//
// Two behaviours are easy to break silently and invisible until a user notices
// lost data, so they are pinned here:
//   1. Speaker names may contain commas ("Nino, Menoa, Ichito: halo"), while
//      ordinary sentences must not be chopped into a fake speaker.
//   2. Trailing spaces in a saved translation are intentional and must survive
//      escapeStoredNewlines() — the same helper used by the line editor, the
//      project loader and the plugin bridge.
//
// Requires Node >= 22.6 (native TypeScript type stripping).

import { isPlausibleSpeakerName } from '../src/speaker-name.ts';
import { escapeStoredNewlines } from '../src/string-utils.ts';
import {
  DEFAULT_PROMPT_HEADER_NUMBERED,
  DEFAULT_PROMPT_HEADER_NUMBERED_KAGIKAKKO,
  DEFAULT_PROMPT_HEADER_BLOCK,
  DEFAULT_PROMPT_HEADER_BLOCK_KAGIKAKKO,
  DEFAULT_PROMPT_HEADER_XML,
  DEFAULT_PROMPT_HEADER_XML_KAGIKAKKO,
  DEFAULT_PROMPT_HEADER_JSONL,
  DEFAULT_PROMPT_HEADER_JSONL_KAGIKAKKO,
  DEFAULT_PROMPT_HEADER_JSON_ARRAY,
  DEFAULT_PROMPT_HEADER_JSON_ARRAY_KAGIKAKKO,
  DEFAULT_PROMPT_HEADER_STANDARD_ID,
  DEFAULT_PROMPT_HEADER_STANDARD_EN,
  DEFAULT_GLOSSARY_PROMPT,
  DEFAULT_AI_CHECK_PROMPT,
  DEFAULT_AGENT_PROMPT,
  DEFAULT_DICTIONARY_PROMPT,
  LEGACY_PROMPT_MIGRATIONS,
} from '../src/constants.ts';

let failures = 0;
let checks = 0;

function check(condition, message) {
  checks++;
  if (condition) return;
  failures++;
  console.error(`  FAIL: ${message}`);
}

function checkEqual(actual, expected, message) {
  check(Object.is(actual, expected), `${message} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
}

// ── Speaker names with commas ────────────────────────────────────────────────
// The exact case reported by users: several names (or a name + epithet) before
// the colon used to be rejected because any comma failed the plausibility test.
const validNames = [
  'Nino, Menoa, Ichito',
  'Yuki, Sang Ketua',
  'Nino，Menoa',
  'Spica',
  '???',
  'Nama!',
  'Sosok (???)',
  "Shin'ichirō",
  '綾菜',
];
for (const name of validNames) {
  check(isPlausibleSpeakerName(name), `"${name}" is accepted as a speaker name`);
}

// Sentences must not be mistaken for names; a comma alone cannot make one.
const invalidNames = [
  'Yah, aku tidak tahu',
  'Nino,',            // dangling comma
  'Nino,, Menoa',     // empty part
  'Nino, Menoa, Ichito, Sora, Kaito, Aoi, Hina', // too many parts
  '123',
  'Laut biru membentang sejauh mata memandang.',
  'Tunggu. Aku',
  '',
];
for (const name of invalidNames) {
  check(!isPlausibleSpeakerName(name), `"${name}" is rejected as a speaker name`);
}

// ── Trailing spaces in saved translations ────────────────────────────────────
checkEqual(
  escapeStoredNewlines('halo ', { preserveTrailingSpace: true }),
  'halo ',
  'trailing space survives the save path',
);
checkEqual(
  escapeStoredNewlines('halo dua spasi  ', { preserveTrailingSpace: true }),
  'halo dua spasi  ',
  'multiple trailing spaces survive the save path',
);
checkEqual(
  escapeStoredNewlines('  halo ', { preserveTrailingSpace: true }),
  'halo ',
  'leading spaces are still cleaned up',
);
checkEqual(
  escapeStoredNewlines('   ', { preserveTrailingSpace: true }),
  '',
  'whitespace-only translation stays empty',
);
checkEqual(
  escapeStoredNewlines('baris1\nbaris2 ', { preserveTrailingSpace: true }),
  'baris1\\nbaris2 ',
  'real newlines are escaped and the tail space is kept',
);
// Existing (trimming) behaviour must not change for AI-generated text.
checkEqual(escapeStoredNewlines(' halo '), 'halo', 'default mode still trims');

// ── Default prompt invariants & legacy migrations ───────────────────────────
const allTranslationHeaders = [
  ['NUMBERED', DEFAULT_PROMPT_HEADER_NUMBERED],
  ['NUMBERED_KAGIKAKKO', DEFAULT_PROMPT_HEADER_NUMBERED_KAGIKAKKO],
  ['BLOCK', DEFAULT_PROMPT_HEADER_BLOCK],
  ['BLOCK_KAGIKAKKO', DEFAULT_PROMPT_HEADER_BLOCK_KAGIKAKKO],
  ['XML', DEFAULT_PROMPT_HEADER_XML],
  ['XML_KAGIKAKKO', DEFAULT_PROMPT_HEADER_XML_KAGIKAKKO],
  ['JSONL', DEFAULT_PROMPT_HEADER_JSONL],
  ['JSONL_KAGIKAKKO', DEFAULT_PROMPT_HEADER_JSONL_KAGIKAKKO],
  ['JSON_ARRAY', DEFAULT_PROMPT_HEADER_JSON_ARRAY],
  ['JSON_ARRAY_KAGIKAKKO', DEFAULT_PROMPT_HEADER_JSON_ARRAY_KAGIKAKKO],
  ['STANDARD_ID', DEFAULT_PROMPT_HEADER_STANDARD_ID],
  ['STANDARD_EN', DEFAULT_PROMPT_HEADER_STANDARD_EN],
];
for (const [label, header] of allTranslationHeaders) {
  check(header.startsWith('You are a Visual Novel translator.'), `${label} starts with canonical prefix required by UI format switcher`);
  check(header.includes('{{lineCount}}'), `${label} interpolates {{lineCount}}`);
  check(!header.includes('<summary>...</summary>'), `${label} does not hardcode <summary> output tag when chaining is off`);
}
check(DEFAULT_GLOSSARY_PROMPT.includes('{{sourceLang}}') && DEFAULT_GLOSSARY_PROMPT.includes('{{targetLang}}'), 'DEFAULT_GLOSSARY_PROMPT interpolates language variables');
check(DEFAULT_AI_CHECK_PROMPT.includes('confidence: high'), 'DEFAULT_AI_CHECK_PROMPT specifies confidence field');
check(DEFAULT_AGENT_PROMPT.includes('"action":"commit"'), 'DEFAULT_AGENT_PROMPT specifies commit action');
check(DEFAULT_DICTIONARY_PROMPT.includes('{word}') && DEFAULT_DICTIONARY_PROMPT.includes('{context}'), 'DEFAULT_DICTIONARY_PROMPT interpolates {word} and {context}');
check(LEGACY_PROMPT_MIGRATIONS.length >= 20, 'LEGACY_PROMPT_MIGRATIONS covers all historical default prompts');
for (const entry of LEGACY_PROMPT_MIGRATIONS) {
  check(Boolean(entry.legacy && entry.replacement && entry.legacy !== entry.replacement), 'every legacy prompt migration maps a non-empty legacy string to an updated replacement');
}

if (failures > 0) {
  console.error(`\n${failures} of ${checks} checks failed.`);
  process.exit(1);
}
console.log(`All ${checks} text-parsing checks passed.`);
