// @module state.ts — Shared application state, ui cache, and module-level variables

import type { AppState, UiCache, Line } from './types';
import {
  DEFAULT_LUCA_MC_DISPLAY_NAME,
  DEFAULT_PROMPT_HEADER,
  DEFAULT_AI_TRANSLATION_FORMAT,
  DEFAULT_GLOSSARY_PROMPT,
  DEFAULT_AI_CHECK_PROMPT,
  DEFAULT_AGENT_PROMPT,
  DEFAULT_SELECTION_BATCH_SIZE,
  DEFAULT_GLOSSARY_BATCH_SIZE,
  DEFAULT_AI_CHECK_BATCH_SIZE,
} from './constants';

// ─── Shared Application State ────────────────────────────────────────────────────
export const state: AppState = {
  sourceLang: 'Japanese',
  targetLang: 'Indonesian',
  regexFilter: '',
  regexFilterCase: false,
  preReplaceRules: '',
  postReplaceRules: '',
  enableBackgroundChaining: false,
  currentBackground: '',
  summaryPrompt: '',
  disableEmptyLineValidation: false,
  showFurigana: false,
  furiganaType: 'furigana',
  fontSize: 14,
  enableDictionary: false,
  dictionaryEngine: 'llm',
  dictionaryPrompt: 'Jelaskan arti kata "{word}" dalam konteks kalimat "{context}". Berikan bentuk dasar, cara baca (hiragana/romaji), kelas kata, dan terjemahan/penjelasan singkat dalam bahasa Indonesia.',
  checkKanaResidue: false,
  checkSimilarity: false,
  similarityThreshold: 0.7,
  checkLinebreak: false,
  checkLengthRatio: false,
  lengthRatioThreshold: 2.5,
  checkLanguage: false,
  checkPunctuation: false,
  checkUntransName: false,
  ignorePasteNames: false,
  enableUncertainMarking: false,
  safeTagsForChatgpt: false,
  aiBackupKeys: '',
  aiKeyStrategy: 'fallback',
  aiTranslateMode: 'auto',
  tavilyApiKey: '',
  agentMaxTurns: 10,
  currentProjectId: null,
  projectName: '',
  projectType: '',
  translationMode: 'ai', // "ai" or "htl" — HTL hides all AI features
  jsonRefLang: '', // optional reference language code for json projects: "en", "zh", etc. (empty = disabled)
  epubTags: 'p',
  epubSourceId: null,
  showEpubImages: true,
  lucaExportLang: 'en',
  lucaProfile: 'summer-pockets-steam',
  lucaMcDisplayName: DEFAULT_LUCA_MC_DISPLAY_NAME,
  lucaRawFiles: {},
  lucaRawBuffers: {},
  customParserId: null,
  customRawFiles: {},
  customRawBuffers: {},
  lines: [],
  importedFiles: [],
  fileOrder: [],
  aiInstructionHeader: DEFAULT_PROMPT_HEADER,
  aiTranslationFormat: DEFAULT_AI_TRANSLATION_FORMAT,
  aiApiType: 'openai',
  /** Number of untranslated lines exported by the most recent Copy for AI call. Used to populate {{lineCount}} in prompts. */
  _lastExportedLineCount: 0,
  aiApiUrl: '',
  aiApiKey: '',
  aiModel: 'gpt-4o-mini',
  aiTemperature: 1.0,
  aiTopP: 1.0,
  aiMaxTokens: 8192,
  aiFrequencyPenalty: 0,
  aiPresencePenalty: 0,
  aiSeed: null,
  aiReasoningEffort: 'default',
  aiRpm: 10,
  aiThinkingMode: 'default',
  aiFilterThinkingOutput: true,
  aiMergeSystemPrompt: false,
  aiStreaming: false,
  glossaryPrompt: DEFAULT_GLOSSARY_PROMPT,
  aiCheckPrompt: DEFAULT_AI_CHECK_PROMPT,
  agentPrompt: DEFAULT_AGENT_PROMPT,
  glossaryText: '',
  contextLines: 10,
  contextType: 'raw',
  selectionBatchSize: DEFAULT_SELECTION_BATCH_SIZE,
  glossaryBatchSize: DEFAULT_GLOSSARY_BATCH_SIZE,
  aiCheckBatchSize: DEFAULT_AI_CHECK_BATCH_SIZE,
  parallelBatchSize: 1,
  subagentWorkers: 3,
  undoStack: [],
  redoStack: [],
  selectedLines: new Set(),
  selectionHistory: [],
  selectionHistoryIndex: -1,
  activeWorkspaceTab: 'translate',
  displayRows: [],
  lineByNum: new Map(),
  proofreadMatches: [],
  qaMatches: [],
  aiCheckCorrections: [],
  dashboardProjects: [],
  agentMemories: [],
  projectLoggingEnabled: false,
  autoRepeatOnFailure: false,
  incrementEnabled: false,
  enableAiCheckChaining: true,
  enableAiCheckStoryContext: true,
  aiCheckStoryContext: '',
  aiCheckSummaryPrompt: '',
  enableAiCheckAgentMemory: true,
  aiCheckLocalizationNotes: '',
  aiCheckRevisionsSummary: '',
};

// ─── Shared UI Element Cache ──────────────────────────────────────────────────
export const ui: UiCache = {};

// ─── Module-Level Variables ───────────────────────────────────────────────────
// These are mutable references shared across modules via getters/setters.

let _mainScroller: any = null;
let _proofreadScroller: any = null;
let _qaScroller: any = null;
let _activeLineEditorLineNum: number | null = null;
let _saveTimeout: ReturnType<typeof setTimeout> | null = null;
let _hintToken = 0;

export function getMainScroller() { return _mainScroller; }
export function setMainScroller(s: any) {
  if (_mainScroller && _mainScroller !== s) _mainScroller.dispose?.();
  _mainScroller = s;
}

export function getProofreadScroller() { return _proofreadScroller; }
export function setProofreadScroller(s: any) {
  if (_proofreadScroller && _proofreadScroller !== s) _proofreadScroller.dispose?.();
  _proofreadScroller = s;
}

export function getQaScroller() { return _qaScroller; }
export function setQaScroller(s: any) {
  if (_qaScroller && _qaScroller !== s) _qaScroller.dispose?.();
  _qaScroller = s;
}

export function getActiveLineEditorLineNum() { return _activeLineEditorLineNum; }
export function setActiveLineEditorLineNum(n: number | null) { _activeLineEditorLineNum = n; }

export function getSaveTimeout() { return _saveTimeout; }
export function setSaveTimeout(t: ReturnType<typeof setTimeout> | null) { _saveTimeout = t; }

export function getHintToken() { return _hintToken; }
export function incrementHintToken() { return ++_hintToken; }

// ─── Core Helpers (used everywhere) ──────────────────────────────────────────

/** Marker message used for EPUB illustration-only lines (no text to translate). */
export const EPUB_ILUSTRASI_MARKER = '[Ilustrasi]';

/** True for EPUB placeholder lines that only carry an illustration — nothing to translate. */
export function isIlustrasiLine(line: any): boolean {
  return !!line && line.message === EPUB_ILUSTRASI_MARKER && !!line.epub_img_src;
}

export function isTranslated(line: Line): boolean {
  if (isIlustrasiLine(line)) return true;
  return !!line.is_translated && (state.disableEmptyLineValidation || !!String(line.trans_message).trim());
}

export function normalizeLineDict(line: any): Line {
  const normalized: Line = {
    line_num: Number(line.line_num),
    file: String(line.file),
    name: line.name == null ? null : String(line.name).replace(/\r?\n/g, '\\n').trim(),
    message: String(line.message).replace(/\r?\n/g, '\\n').trim(),
    trans_name: line.trans_name == null ? null : String(line.trans_name).replace(/\r?\n/g, '\\n').trim(),
    trans_message: line.trans_message == null ? null : String(line.trans_message).replace(/\r?\n/g, '\\n').trim(),
    is_translated: Boolean(line.is_translated),
    ...(line.bookmarked != null ? { bookmarked: Boolean(line.bookmarked) } : {}),
    ...(line.luca_jp != null ? { luca_jp: String(line.luca_jp) } : {}),
    ...(line.luca_en != null ? { luca_en: String(line.luca_en) } : {}),
    ...(line.luca_zh != null ? { luca_zh: String(line.luca_zh) } : {}),
    ...(line.ref_lang_1 != null ? { ref_lang_1: String(line.ref_lang_1) } : {}),
    ...(line.ref_lang_1_name != null ? { ref_lang_1_name: String(line.ref_lang_1_name) } : {}),
    ...(line.ref_lang_2 != null ? { ref_lang_2: String(line.ref_lang_2) } : {}),
    ...(line.ref_lang_2_name != null ? { ref_lang_2_name: String(line.ref_lang_2_name) } : {}),
  };
  if (line.luca_command) normalized.luca_command = String(line.luca_command);
  if (line.luca_choice_index != null) normalized.luca_choice_index = Number(line.luca_choice_index);
  if (line.luca_choice_count != null) normalized.luca_choice_count = Number(line.luca_choice_count);
  if (line.luca_pre != null) normalized.luca_pre = String(line.luca_pre);
  if (line.luca_post != null) normalized.luca_post = String(line.luca_post);
  if (line.luca_slot_index != null) normalized.luca_slot_index = Number(line.luca_slot_index);
  if (line.luca_file != null) normalized.luca_file = String(line.luca_file);
  if (line.luca_line_index != null) normalized.luca_line_index = Number(line.luca_line_index);
  if (line.luca_raw_index != null) normalized.luca_raw_index = Number(line.luca_raw_index);
  if (line.luca_raw != null) normalized.luca_raw = String(line.luca_raw);
  if (line.luca_profile != null) normalized.luca_profile = String(line.luca_profile);
  if (line.luca_heavy_quotes != null) normalized.luca_heavy_quotes = Boolean(line.luca_heavy_quotes);
  if (line.luca_text_prefix != null) normalized.luca_text_prefix = String(line.luca_text_prefix);
  if (line.luca_prefix_b64 != null) normalized.luca_prefix_b64 = String(line.luca_prefix_b64);
  if (line.epub_selector != null) normalized.epub_selector = String(line.epub_selector);
  if (line.epub_id != null) normalized.epub_id = String(line.epub_id);
  if (line.epub_img_src != null) normalized.epub_img_src = String(line.epub_img_src);
  if (line.custom_raw != null) normalized.custom_raw = String(line.custom_raw);
  if (line.custom_index !== undefined) normalized.custom_index = line.custom_index;
  if (line._hidden != null) normalized._hidden = Boolean(line._hidden);
  if (line._glossary_extracted != null) normalized._glossary_extracted = Boolean(line._glossary_extracted);
  if (line._ai_checked != null) normalized._ai_checked = Boolean(line._ai_checked);
  if (line._ai_confirmed != null) normalized._ai_confirmed = Boolean(line._ai_confirmed);
  return normalized;
}

export function getOpfsRoot(): Promise<FileSystemDirectoryHandle> {
  return navigator.storage.getDirectory();
}
