// Test script for text hook matcher.
// Exits non-zero on the first failed check so CI and manual runs can actually
// detect regressions — `console.assert` only logs and always "passes".

import { normalizeDialogue, findMatchingLine } from '../src/text-hook-matcher.ts';

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

const mockLines = [
  { line_num: 1, file: 'scene01.txt', name: 'しろは', message: '「おはよう」', trans_name: 'Shiroha', trans_message: 'Selamat pagi', is_translated: true },
  { line_num: 2, file: 'scene01.txt', name: '羽依里', message: '「ああ、おはよう」', trans_name: 'Hairi', trans_message: 'Ah, selamat pagi', is_translated: true },
  { line_num: 3, file: 'scene01.txt', name: null, message: '青い海がどこまでも広がっている。', trans_name: null, trans_message: 'Laut biru membentang sejauh mata memandang.', is_translated: true },
  { line_num: 4, file: 'scene01.txt', name: 'しろは', message: '「うん」', trans_name: 'Shiroha', trans_message: 'Iya', is_translated: true },
  { line_num: 5, file: 'scene01.txt', name: 'しろは', message: '「今日も暑くなりそうね」', trans_name: 'Shiroha', trans_message: 'Hari ini sepertinya bakal panas ya', is_translated: true },
  // Line 12644 from TrymenT
  {
    line_num: 12644,
    file: 'op3_9_5',
    name: '三国',
    message: '「つまり、精神を疲弊した星乃にとって、記憶喪失こそが、身体が選択した自己回復の手段の一つでもあったという訳だ」',
    trans_name: 'Mikuni',
    trans_message: '"Artinya, bagi Hoshino yang jiwanya kelelahan, amnesia itu sendiri merupakan salah satu cara pemulihan diri yang dipilih oleh tubuhmu"',
    is_translated: true,
  },
  // Repeated 'うん'
  { line_num: 20000, file: 'scene02.txt', name: '鴎', message: '「うん」', trans_name: 'Kamome', trans_message: 'Iya', is_translated: true },
];

console.log('--- Test 1: Normalize dialogue ---');
const n1 = normalizeDialogue('「おはよう」');
const n2 = normalizeDialogue('おはよう');
checkEqual(n1, 'おはよう', 'Normalization should strip quotes');
checkEqual(n1, n2, 'Bracket removal should make both forms equal');
console.log('Passed normalize test:', n1);

console.log('\n--- Test 2: Match Indonesian translated dialogue (in-game patched) ---');
const mTrans = findMatchingLine('Selamat pagi', mockLines, -1);
check(mTrans !== null && mTrans.line.line_num === 1, `Expected line 1, got ${mTrans?.line.line_num}`);
checkEqual(mTrans?.matchedField, 'trans_message', 'Expected matchedField trans_message');
console.log('Match translated passed: Line', mTrans?.line.line_num, '| matchedField:', mTrans?.matchedField);

console.log('\n--- Test 3: Match TrymenT line 12644 with raw in-game Indonesian hook ---');
const rawHook = 'Artinya, bagi Hoshino yang jiwanya kelelahan, amnesia itu sendiri merupakan salah satu cara pemulihan diri yang dipilih oleh tubuhmu';
const mTryment = findMatchingLine(rawHook, mockLines, -1);
check(mTryment !== null && mTryment.line.line_num === 12644, `Expected line 12644, got ${mTryment?.line.line_num}`);
checkEqual(mTryment?.matchedField, 'trans_message', 'Expected matchedField trans_message');
console.log('Match TrymenT line 12644 passed! Score:', mTryment?.score, '| MatchedField:', mTryment?.matchedField);

console.log('\n--- Test 4: Match with Speaker prepended in hook ---');
const hookWithSpeaker = 'Mikuni: "Artinya, bagi Hoshino yang jiwanya kelelahan, amnesia itu sendiri merupakan salah satu cara pemulihan diri yang dipilih oleh tubuhmu"';
const mSpeaker = findMatchingLine(hookWithSpeaker, mockLines, 5);
check(mSpeaker !== null && mSpeaker.line.line_num === 12644, `Expected line 12644, got ${mSpeaker?.line.line_num}`);
console.log('Match with speaker passed! Line:', mSpeaker?.line.line_num, '| Score:', mSpeaker?.score);

console.log('\n--- Test 5: Match Japanese original dialogue (unpatched game fallback) ---');
const mOrig = findMatchingLine('「つまり、精神を疲弊した星乃にとって、記憶喪失こそが、身体が選択した自己回復の手段の一つでもあったという訳だ」', mockLines, -1);
check(mOrig !== null && mOrig.line.line_num === 12644, `Expected line 12644, got ${mOrig?.line.line_num}`);
checkEqual(mOrig?.matchedField, 'message', 'Expected matchedField message');
console.log('Match Japanese original passed! Line:', mOrig?.line.line_num, '| MatchedField:', mOrig?.matchedField);

console.log('\n--- Test 6: Progressive reveal (prefix) ---');
const hookPartial = 'Artinya, bagi Hoshino yang jiwanya kelelahan';
const mPartial = findMatchingLine(hookPartial, mockLines, 5);
check(mPartial !== null && mPartial.line.line_num === 12644, `Expected line 12644, got ${mPartial?.line.line_num}`);
console.log('Match progressive partial passed! Line:', mPartial?.line.line_num, '| Score:', mPartial?.score);

console.log('\n--- Test 7: Sequential locality disambiguation ---');
const mShort1 = findMatchingLine('Iya', mockLines, 3);
check(mShort1 !== null && mShort1.line.line_num === 4, `Expected line 4, got ${mShort1?.line.line_num}`);
console.log('Locality match 1 passed: line', mShort1?.line.line_num);

const mShort2 = findMatchingLine('Iya', mockLines, 5); // closer to line 20000
check(mShort2 !== null && mShort2.line.line_num === 20000, `Expected line 20000, got ${mShort2?.line.line_num}`);
console.log('Locality match 2 passed: line', mShort2?.line.line_num);

console.log('\n--- Test 8: Short hooks must not match unrelated long lines ---');
// A 4-char hook previously cleared the 0.65 cutoff by construction, so any line
// merely containing it won. It must now be rejected as too short to be trusted.
const mTooShort = findMatchingLine('tahu', [{ line_num: 1, file: 'a', name: null, message: 'x', trans_name: null, trans_message: 'Aku suka makan tahu goreng setiap pagi', is_translated: true }], -1);
check(mTooShort === null, `Expected null for a 4-char hook, got line ${mTooShort?.line.line_num}`);
console.log('Short hook rejected:', mTooShort === null);

console.log('\n--- Test 9: A distant duplicate must not beat the nearby line ---');
const dupLines = [];
for (let i = 1; i <= 3000; i++) {
  dupLines.push({ line_num: i, file: 'a', name: null, message: 'm' + i, trans_name: null, trans_message: 'terjemahan biasa ' + i, is_translated: true });
}
dupLines[500] = { line_num: 501, file: 'a', name: null, message: 'm501', trans_name: null, trans_message: 'Selamat pagi semuanya', is_translated: true };
dupLines[2500] = { line_num: 2501, file: 'a', name: null, message: 'm2501', trans_name: null, trans_message: 'Selamat pagi semuanya', is_translated: true };
const mDup = findMatchingLine('Selamat pagi semuanya', dupLines, 400);
check(mDup !== null && mDup.line.line_num === 501, `Expected nearby line 501, got ${mDup?.line.line_num}`);
console.log('Nearby duplicate preferred: line', mDup?.line.line_num);

console.log('\n--- Test 10: Hidden lines are skipped ---');
const hiddenLines = [
  { line_num: 1, file: 'a', name: null, message: 'x', trans_name: null, trans_message: 'Target kalimat panjang', is_translated: true, _hidden: true },
  { line_num: 2, file: 'a', name: null, message: 'x', trans_name: null, trans_message: 'Target kalimat panjang sekali', is_translated: true },
];
const mHidden = findMatchingLine('Target kalimat panjang', hiddenLines, -1);
check(mHidden !== null && mHidden.line.line_num === 2, `Expected visible line 2, got ${mHidden?.line.line_num}`);
console.log('Hidden line skipped: line', mHidden?.line.line_num);

console.log('\n--- Test 11: Unmatched text returns null ---');
const mMiss = findMatchingLine('zzzqqq teks yang sama sekali tidak ada', mockLines, -1);
check(mMiss === null, `Expected null for unrelated text, got line ${mMiss?.line.line_num}`);
console.log('Unrelated text rejected:', mMiss === null);

console.log(`\n${checks - failures}/${checks} checks passed.`);
if (failures > 0) {
  console.error(`${failures} check(s) FAILED.`);
  process.exit(1);
}
console.log('ALL MATCHER TESTS PASSED.');
