// Exercise the real renderer helper and worker with Kuroshiro/Kuromoji, without
// a browser. A VM supplies only the browser/worker boundary; source is compiled
// unchanged apart from import.meta values supplied by Vite in the application.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import KuroshiroModule from 'kuroshiro';
import KuromojiModule from 'kuroshiro-analyzer-kuromoji';
import * as htmlHelpers from '../src/furigana-html.ts';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const moduleValue = mod => mod?.default?.default || mod?.default || mod;
const kuroshiro = new (moduleValue(KuroshiroModule))();
await kuroshiro.init(new (moduleValue(KuromojiModule))({ dictPath: path.join(root, 'public/dict') }));

function compile(file) {
  const source = fs.readFileSync(path.join(root, 'src', file), 'utf8')
    .replaceAll('import.meta.env.BASE_URL', "'./'")
    .replaceAll('import.meta.url', "'file:///furigana.ts'");
  return ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
}
const mainSource = compile('furigana.ts');
const workerSource = compile('furigana.worker.ts');

class WorkingWorker {
  constructor() {
    const self = {
      location: new URL('http://localhost/assets/furigana.worker.js'),
      postMessage: data => queueMicrotask(() => this.onmessage?.({ data })),
    };
    this.context = vm.createContext({
      exports: {}, self, URL, console, __kuroshiro: kuroshiro,
      require: name => name === './furigana-html' ? htmlHelpers : require(name),
    });
    vm.runInContext(workerSource, this.context);
    vm.runInContext('kuroshiroInstance = __kuroshiro;', this.context);
  }
  postMessage(data) { void this.context.self.onmessage({ data }); }
  terminate() {}
}
class UnavailableWorker {
  constructor() { throw new Error('Worker unavailable'); }
}

function client(Worker) {
  const state = { furiganaType: 'hiragana' };
  const context = {
    exports: {}, Worker, URL,
    window: { location: new URL('http://localhost/app/index.html'), setTimeout, clearTimeout },
    console: { error() {}, warn() {} },
    require(name) {
      if (name === './state') return { state };
      if (name === './string-utils') return { kanaToRomaji: value => value };
      if (name === './furigana-html') return htmlHelpers;
      throw new Error('Unexpected import: ' + name);
    },
  };
  vm.runInNewContext(mainSource, context);
  return { ...context.exports, state };
}

function assertSafeHtml(html) {
  // Only Kuroshiro's annotation tags may be active markup. Attributes, SVG,
  // image handlers, scripts and caller-supplied ruby tags must remain text.
  for (const tag of html.match(/<[^>]*>/g) || []) {
    assert.match(tag, /^<\/?(?:ruby|rt|rp)>$/, `unexpected active markup: ${tag}`);
  }
  assert.ok(!html.includes('<img'));
  assert.ok(!html.includes('<svg'));
  assert.ok(!html.includes('<script'));
}

const fast = client(UnavailableWorker);
const asciiAttack = '<img src=x onerror="alert(1)"> &lt;svg&gt;';
assert.equal(fast.getCachedFurigana(asciiAttack), '&lt;img src=x onerror="alert(1)"&gt; &amp;lt;svg&amp;gt;');
assert.equal(await fast.convertToFurigana(asciiAttack), fast.getCachedFurigana(asciiAttack));
assert.equal(fast.getCachedFurigana('A & B < C > D'), 'A &amp; B &lt; C &gt; D');
assert.equal(fast.getCachedFurigana(' plain text '), ' plain text ');
assert.equal(await fast.convertToFurigana(''), '');
for (const type of ['hiragana', 'katakana']) {
  fast.state.furiganaType = type;
  assert.equal(fast.getCachedFurigana('あ' + asciiAttack), 'あ' + htmlHelpers.escapeFuriganaText(asciiAttack));
}
assert.equal(await fast.convertToFurigana('日本' + asciiAttack), '日本' + htmlHelpers.escapeFuriganaText(asciiAttack),
  'a failed conversion must also escape source text');

const working = client(WorkingWorker);
for (const type of ['hiragana', 'katakana', 'romaji']) {
  working.state.furiganaType = type;
  for (const text of [
    '日本<img src=x onerror="alert(1)">',
    '日本<svg/onload=alert(1)> &lt;script&gt;',
    '日本<ruby onclick="alert(1)">あ</ruby>',
    '日本<script>alert(1)</script>',
  ]) {
    const html = await working.convertToFurigana(text);
    assertSafeHtml(html);
    assert.ok(html.includes('&lt;') && html.includes('&gt;'));
    assert.equal(working.getCachedFurigana(text), html, 'cached converted markup must remain safe');
    assert.equal(await working.convertToFurigana(text), html);
  }
}
working.state.furiganaType = 'hiragana';
assert.match(await working.convertToFurigana('日本'), /<ruby>日本<rp>\(<\/rp><rt>に(?:ほん|っぽん)<\/rt>/);
working.state.furiganaType = 'katakana';
assert.match(await working.convertToFurigana('日本'), /<rt>ニ(?:ホン|ッポン)<\/rt>/);
working.clearFuriganaCache();
assert.equal(working.getCachedFurigana('日本'), null);
assert.ok((await working.convertToRomaji('日本<test>')).includes('<'),
  'plain romaji for textContent callers must not be HTML-escaped');

console.log('Furigana: cached, converted, fallback and ruby-preservation checks passed.');
