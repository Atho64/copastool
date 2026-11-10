// @module i18n/index.ts: UI language for the app chrome (Indonesian / English).
//
// The dictionary keys are the Indonesian source strings, not invented ids. That
// keeps `index.html` free of key attributes and lets the runtime translate text
// that TypeScript builds on the fly: a MutationObserver walks whatever the app
// renders and swaps any text node whose content matches a dictionary entry.
//
// Entries may contain `{name}` placeholders. Those compile to anchored regular
// expressions, so `t('Gagal memuat 3 file')` still matches `Gagal memuat {n}
// file` and interpolated messages translate without touching the call site.

import { EN } from './dictionary';

export type UiLang = 'id' | 'en';

export const LANG_EVENT = 'copastool:langchange';

const STORAGE_KEY = 'copastool.uiLang';

/** Subtrees holding project text, AI output, or logs. Never translated. */
const SKIP_SELECTOR = '[data-i18n-skip],script,style,noscript,template';

/**
 * Subtrees where only the text is off limits. Row lists (the text list, the
 * bookmark list) mix project text with UI tooltips, so their text stays but
 * their `title`/`aria-label` still get translated.
 */
const SKIP_TEXT_SELECTOR = '[data-i18n-skip],[data-i18n-skip-text],script,style,noscript,template';

const ATTRS = ['placeholder', 'title', 'aria-label', 'alt'] as const;

let currentLang: UiLang = 'id';
let patternCache: CompiledPattern[] | null = null;
let normalizedIndex: Map<string, string> | null = null;
let observer: MutationObserver | null = null;
// The observer can ask about the same string thousands of times per second
// (tooltips, status lines, tutorial progress). Without this cache every miss
// would re-run the whole pattern list.
let memo = new Map<string, string>();

interface CompiledPattern {
  re: RegExp;
  tpl: string;
}

interface TextState {
  orig: string;
  out: string;
}

const textState = new WeakMap<Text, TextState>();
const attrState = new WeakMap<Element, Map<string, TextState>>();

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function compilePatterns(): CompiledPattern[] {
  const compiled: CompiledPattern[] = [];
  for (const [source, target] of Object.entries(EN)) {
    if (!source.includes('{')) continue;
    const chunks = source.split(/\{\w+\}/g);
    if (chunks.length < 2) continue;
    // `[\s\S]` rather than `.` so patterns also match the multi-line strings
    // that alert() bodies are built from.
    compiled.push({
      re: new RegExp(`^${chunks.map(escapeRegExp).join('([\\s\\S]+?)')}$`),
      tpl: target,
    });
  }
  // Longest literal first so a specific pattern wins over a generic one.
  compiled.sort((a, b) => b.re.source.length - a.re.source.length);
  return compiled;
}

function fill(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    key in vars ? String(vars[key]) : match,
  );
}

function normalize(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/**
 * Exact lookup first, then a whitespace-insensitive one. The second pass exists
 * because DOM text nodes have their newlines collapsed before lookup while the
 * dictionary keeps the `\n` an `alert()` string was written with.
 */
function lookup(source: string): string | undefined {
  const exact = EN[source];
  if (exact !== undefined) return exact;

  normalizedIndex ??= new Map(
    Object.entries(EN).map(([key, value]) => [normalize(key), value]),
  );
  return normalizedIndex.get(normalize(source));
}

/**
 * Translates one UI string. Returns the input unchanged when the language is
 * Indonesian or the string is not in the dictionary (project text, AI output).
 */
export function t(source: string, vars?: Record<string, string | number>): string {
  if (currentLang !== 'en') return vars ? fill(source, vars) : source;

  const cached = memo.get(source);
  if (cached !== undefined) return vars ? fill(cached, vars) : cached;

  const out = translate(source);
  memo.set(source, out);
  return vars ? fill(out, vars) : out;
}

// Guards the nested lookup below. Two levels is enough for the cases that
// exist (status bar "Baris: 12", batch labels "untuk Hapus") and makes a
// self-referencing pattern impossible to spin on.
let nestedDepth = 0;

function translate(source: string): string {
  const exact = lookup(source);
  if (exact !== undefined) return exact;

  patternCache ??= compilePatterns();
  for (const pattern of patternCache) {
    const match = pattern.re.exec(source);
    if (!match) continue;
    let group = 0;
    return pattern.tpl.replace(/\{\w+\}/g, () => {
      const captured = match[++group] ?? '';
      if (!captured || nestedDepth >= 2) return captured;
      // Captured fragments are often UI strings themselves ("Baris: 12",
      // "untuk Hapus"), so they get one more lookup.
      nestedDepth++;
      const nested = translate(captured);
      nestedDepth--;
      return nested;
    });
  }

  return source;
}

export function getLang(): UiLang {
  return currentLang;
}

function skipText(node: Node): boolean {
  const element = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
  return !!element?.closest(SKIP_TEXT_SELECTOR);
}

function skipElement(element: Element): boolean {
  return !!element.closest(SKIP_SELECTOR);
}

function translateTextNode(node: Text): void {
  const raw = node.data;
  if (!raw || !raw.trim()) return;
  if (skipText(node)) return;

  const trimmed = normalize(raw);
  if (!trimmed) return;

  if (currentLang === 'en') {
    const out = t(trimmed);
    if (out === trimmed) return;
    const lead = /^\s*/.exec(raw)?.[0] ?? '';
    const trail = /\s*$/.exec(raw)?.[0] ?? '';
    const rendered = lead + out + trail;
    textState.set(node, { orig: raw, out: rendered });
    node.data = rendered;
    return;
  }

  const state = textState.get(node);
  if (state && node.data === state.out) node.data = state.orig;
}

function translateAttribute(element: Element, name: string): void {
  const value = element.getAttribute(name);
  if (!value) return;
  const trimmed = normalize(value);
  if (!trimmed) return;

  if (currentLang !== 'en') {
    const state = attrState.get(element)?.get(name);
    if (state && value === state.out) element.setAttribute(name, state.orig);
    return;
  }

  const out = t(trimmed);
  if (out === trimmed) return;
  let map = attrState.get(element);
  if (!map) {
    map = new Map();
    attrState.set(element, map);
  }
  // The app rewrites tooltips (tutorial progress, ref-lang counts), so the
  // saved original has to follow the new source text, not the first one.
  const previous = map.get(name);
  if (!previous || previous.out !== value) map.set(name, { orig: value, out });
  element.setAttribute(name, out);
}

function translateAttributes(element: Element, only?: string): void {
  if (only) {
    translateAttribute(element, only);
    return;
  }
  for (const name of ATTRS) translateAttribute(element, name);
}

function walkText(root: Node): void {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node) {
    translateTextNode(node as Text);
    node = walker.nextNode();
  }
}

/** Applies the active language to a subtree (defaults to the whole document). */
export function applyDomI18n(root: ParentNode | null = document.body): void {
  if (!root) return;

  if (root.nodeType === Node.TEXT_NODE) {
    translateTextNode(root as unknown as Text);
    return;
  }
  if (root.nodeType === Node.ELEMENT_NODE) {
    const element = root as Element;
    if (skipElement(element)) return;
    translateAttributes(element);
  }

  walkText(root as Node);
  for (const element of root.querySelectorAll?.(
    '[placeholder],[title],[aria-label],[alt]',
  ) ?? []) {
    if (skipElement(element)) continue;
    translateAttributes(element);
  }
}

function startObserver(): void {
  if (observer || typeof MutationObserver === 'undefined' || !document.body) return;
  observer = new MutationObserver((mutations) => {
    // Indonesian is the source language: the app already renders it, and
    // setLang() does a full restore pass. Nothing to do here.
    if (currentLang !== 'en') return;

    for (const mutation of mutations) {
      if (mutation.type === 'characterData') {
        translateTextNode(mutation.target as Text);
        continue;
      }
      if (mutation.type === 'attributes') {
        const target = mutation.target as Element;
        const name = mutation.attributeName || '';
        // Ignore our own writes; otherwise every translation would bounce
        // straight back through the observer.
        if (attrState.get(target)?.get(name)?.out === target.getAttribute(name)) continue;
        if (!skipElement(target)) translateAttributes(target, name);
        continue;
      }
      for (const added of mutation.addedNodes) {
        if (added.nodeType === Node.TEXT_NODE) translateTextNode(added as Text);
        else if (added.nodeType === Node.ELEMENT_NODE) applyDomI18n(added as Element);
      }
    }
  });
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: [...ATTRS],
  });
}

let dialogsPatched = false;

/**
 * Native alert/confirm/prompt are not DOM, so the observer never sees them.
 * Wrapping the three globals translates every existing call site at once.
 */
function installNativeDialogI18n(): void {
  if (dialogsPatched || typeof window === 'undefined') return;
  dialogsPatched = true;

  const nativeAlert = window.alert.bind(window);
  const nativeConfirm = window.confirm.bind(window);
  const nativePrompt = window.prompt.bind(window);

  window.alert = (message?: unknown) => nativeAlert(t(String(message ?? '')));
  window.confirm = (message?: unknown) => nativeConfirm(t(String(message ?? '')));
  window.prompt = (message?: unknown, defaultValue?: string) =>
    nativePrompt(t(String(message ?? '')), defaultValue);
}

let descriptionOriginal: string | null = null;

function syncDocumentChrome(): void {
  const html = document.documentElement;
  html.lang = currentLang === 'en' ? 'en' : 'id';
  const description = document.querySelector('meta[name="description"]');
  if (!description) return;
  // Keep the authored text so switching back to Indonesian restores it instead
  // of leaving the translated copy in place.
  descriptionOriginal ??= description.getAttribute('content') || '';
  description.setAttribute('content', t(descriptionOriginal));
}

/** Restores the saved language and translates the already-parsed document. */
export function initI18n(): void {
  let saved: string | null = null;
  try {
    saved = localStorage.getItem(STORAGE_KEY);
  } catch {
    saved = null;
  }
  currentLang = saved === 'en' ? 'en' : 'id';
  syncDocumentChrome();
  installNativeDialogI18n();
  applyDomI18n(document.body);
  startObserver();
}

/** Switches language, persists it, and re-renders the chrome in place. */
export function setLang(lang: UiLang): void {
  const next: UiLang = lang === 'en' ? 'en' : 'id';
  const changed = next !== currentLang;
  currentLang = next;
  memo = new Map();
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    /* private mode / storage disabled: language still applies for this session */
  }
  syncDocumentChrome();
  applyDomI18n(document.body);
  if (changed) {
    window.dispatchEvent(new CustomEvent(LANG_EVENT, { detail: { lang: next } }));
  }
}

/** Subscribes to language changes. Returns an unsubscribe function. */
export function onLangChange(handler: (lang: UiLang) => void): () => void {
  const listener = (event: Event) => handler((event as CustomEvent).detail.lang as UiLang);
  window.addEventListener(LANG_EVENT, listener);
  return () => window.removeEventListener(LANG_EVENT, listener);
}
