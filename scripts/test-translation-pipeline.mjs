// Run the actual prompt/parser/apply modules; replace only browser UI and storage.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as constants from '../src/constants.ts';
import * as strings from '../src/string-utils.ts';
import * as speakers from '../src/speaker-name.ts';

let saved = 0;
let snapshots = 0;
const modules = {
  './constants': constants,
  './string-utils': strings,
  './speaker-name': speakers,
  './selection': { getDisplayOrderedLines: () => modules['./state'].state.lines },
  './luca-engine': { getLineDisplayName: line => line.name },
  './file-list': {},
  './download-helper': {},
  './increment': {},
  './project': { queueAutoSave: () => saved++ },
  './render': {
    pushUndoSnapshot: () => snapshots++,
    syncCheckboxUI() {},
    refreshWorkspaceFast() {},
    flashHint() {},
  },
};

function load(name) {
  const source = fs.readFileSync(new URL('../src/' + name + '.ts', import.meta.url), 'utf8');
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  vm.runInNewContext(js, {
    exports,
    console,
    setTimeout: fn => { fn(); return 0; },
    alert: message => { throw new Error(message); },
    require(id) {
      if (id in modules) return modules[id];
      throw new Error('Unexpected import: ' + id);
    },
  }, { filename: name + '.ts' });
  modules['./' + name] = exports;
  return exports;
}

const { state, ui, normalizeLineDict } = load('state');
const formats = load('ai-format');
load('glossary');
const translate = load('translate');

function reset(useDialogueTags = true) {
  state.lines = [
    normalizeLineDict({ line_num: 1, file: 'scene.json', name: 'ニノ＆メノア', message: 'おはよう。' }),
    normalizeLineDict({ line_num: 2, file: 'scene.json', name: null, message: '静かな朝だった。' }),
  ];
  state.lineByNum = new Map(state.lines.map(line => [line.line_num, line]));
  state.selectedLines = new Set([1, 2]);
  state.aiTranslationFormat = 'numbered';
  state.aiInstructionHeader = constants.DEFAULT_PROMPT_HEADER;
  state.useDialogueTags = useDialogueTags;
  state.ignorePasteNames = false;
  ui.pasteArea = { value: '' };
  saved = 0;
  snapshots = 0;
}

for (const tags of [true, false]) {
  for (const name of [
    'Nino & Menoa',
    'Nino&Menoa',
    'Nino Sakuragi & Menoa Shibata & Ichito Takahashi',
    'Nino, Menoa & Ichito',
    'ニノ＆メノア',
    '??? & ???',
  ]) {
    reset(tags);
    ui.pasteArea.value = '1. ' + (tags ? '[D] ' : '') + name + ': Selamat pagi.\n' +
      '2. ' + (tags ? '[N] ' : '') + 'Catatan: pagi itu tenang.';
    translate.onApplyTranslation({ suppressAlerts: true });
    assert.equal(state.lines[0].trans_name, name, 'speaker must preserve ampersands');
    assert.equal(state.lines[0].trans_message, 'Selamat pagi.');
    assert.equal(state.lines[1].trans_name, null, 'narration colon must not become a speaker');
    assert.equal(state.lines[1].trans_message, 'Catatan: pagi itu tenang.');
    assert.equal(state.lines.every(line => line.is_translated), true);
    assert.equal(saved, 1);
    assert.equal(snapshots, 1);
  }
}

reset();
ui.pasteArea.value = '1. Nino & Menoa: Pagi.\n2. Pagi yang tenang.';
translate.onApplyTranslation({ suppressAlerts: true });
assert.equal(state.lines[0].trans_name, 'Nino & Menoa', 'legacy untagged replies stay accepted');

reset();
ui.pasteArea.value = '1. [N] Nino & Menoa: Pagi.\n2. [N] Pagi yang tenang.';
assert.throws(() => translate.onApplyTranslation({ suppressAlerts: true }),
  error => error.details?.some(detail => detail.includes('Tipe berubah')));
assert.equal(state.lines.some(line => line.is_translated), false, 'rejected batch must be atomic');
assert.equal(saved, 0);
assert.equal(snapshots, 0);

reset(false);
ui.pasteArea.value = '1. [N] Nino & Menoa: Pagi.\n2. [D] Pagi yang tenang.';
translate.onApplyTranslation({ suppressAlerts: true });
assert.equal(state.lines[0].trans_name, 'Nino & Menoa');
assert.equal(state.lines[1].trans_message, 'Pagi yang tenang.', 'disabled tags are stripped if AI still returns them');

for (const reply of [
  '1. Pagi.\n2. Pagi yang tenang.',
  '1. Nino & Menoa: Pagi.',
  '1. Nino & Menoa: Pagi.\n1. Nino & Menoa: Halo.',
  '1. Nino & Menoa: Pagi.\n3. Baris asing.',
]) {
  reset(false);
  ui.pasteArea.value = reply;
  assert.throws(() => translate.onApplyTranslation({ suppressAlerts: true }), /TRANSLASI DITOLAK/);
  assert.equal(state.lines.some(line => line.is_translated), false);
  assert.equal(saved, 0);
}

reset();
const tagged = translate.buildCopyForAiPrompt();
assert.match(tagged, /1\. \[D\] ニノ＆メノア: おはよう。/);
assert.match(tagged, /2\. \[N\] 静かな朝だった。/);
assert.match(formats.getTranslationPastePlaceholder(), /\[D\]/);
state.useDialogueTags = false;
const plain = translate.buildCopyForAiPrompt();
assert.doesNotMatch(plain, /\[(?:D|N)\]/);
assert.match(plain, /1\. ニノ＆メノア: おはよう。/);
assert.match(plain, /2\. 静かな朝だった。/);
assert.match(plain, /\[File: scene.json\]/);
assert.doesNotMatch(formats.getTranslationPastePlaceholder(), /\[(?:D|N)\]/);
state.useDialogueTags = true;
assert.equal(translate.buildCopyForAiPrompt(), tagged, 'turning tags back on must restore the prompt');

const headers = [
  constants.DEFAULT_PROMPT_HEADER_NUMBERED,
  constants.DEFAULT_PROMPT_HEADER_NUMBERED_KAGIKAKKO,
  constants.DEFAULT_PROMPT_HEADER_STANDARD_ID,
  constants.DEFAULT_PROMPT_HEADER_STANDARD_EN,
  ...['id', 'en'].flatMap(language =>
    [false, true].map(kagikakko => formats.getStandardPromptHeaderForFormat('numbered', language, kagikakko))),
];
for (const header of headers) {
  reset(false);
  state.aiInstructionHeader = header;
  const prompt = translate.buildCopyForAiPrompt();
  assert.doesNotMatch(prompt, /\[(?:D|N)\]/);
  assert.doesNotMatch(prompt, /Echo the (?:exact )?same/);
  assert.match(prompt, /Do not add dialogue\/narration type tags/);
  assert.match(prompt, /2 translated lines|outputs \(2\)/);
  assert.equal(state.aiInstructionHeader, header, 'saved prompt must not be rewritten');
}

reset(false);
state.aiInstructionHeader = 'Translate carefully.\nKeep the custom honorific glossary.';
assert.match(formats.getTranslationPromptHeader(), /^Translate carefully.\nKeep the custom honorific glossary./);
assert.match(formats.getTranslationPromptHeader(), /Numbered output format for this batch/);
for (const format of ['block', 'xml', 'jsonl', 'jsonarray']) {
  reset();
  state.aiTranslationFormat = format;
  state.aiInstructionHeader = formats.getDefaultPromptHeaderForFormat(format);
  const before = translate.buildCopyForAiPrompt();
  state.useDialogueTags = false;
  assert.equal(translate.buildCopyForAiPrompt(), before, format + ' must be unaffected');
}

console.log('Translation pipeline: ampersand names, tag toggle, prompt variants and apply validation passed.');
