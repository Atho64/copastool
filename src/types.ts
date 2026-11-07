// @module types.ts: shared TypeScript interfaces.

export interface Line {
  line_num: number;
  file: string;
  name: string | null;
  message: string;
  trans_name: string | null;
  trans_message: string | null;
  is_translated: boolean;
  bookmarked?: boolean;
  _hidden?: boolean;
  _glossary_extracted?: boolean;
  _ai_checked?: boolean;
  _ai_confirmed?: boolean;

  luca_command?: string;
  luca_choice_index?: number;
  luca_choice_count?: number;
  luca_pre?: string;
  luca_post?: string;
  luca_slot_index?: number;
  luca_file?: string;
  luca_line_index?: number;
  luca_raw_index?: number;
  luca_prefix_b64?: string;
  luca_heavy_quotes?: boolean;
  luca_text_prefix?: string | null;
  luca_raw?: string;
  luca_profile?: string;

  ref_lang_1?: string | null;
  ref_lang_1_name?: string | null;
  ref_lang_2?: string | null;
  ref_lang_2_name?: string | null;

  epub_selector?: string;
  epub_id?: string;
  epub_img_src?: string;

  luca_jp?: string;
  luca_en?: string;
  luca_zh?: string;

  /** Original snippet captured at import, handed back to serialize() at export
   *  (patch-style round-trip). */
  custom_raw?: string;
  /** Parser-set position (entry number, byte offset), passed back to serialize()
   *  as line.index so patches do not depend on raw text matching. */
  custom_index?: any;
}

/** EPUB illustrations live outside the numbered, translatable line list. */
export interface EpubImageAsset {
  file: string;
  src: string;
  /** Text line before this image; 0 places it before the first text line. */
  afterLineNum: number;
}

export interface CustomParser {
  id: string;
  name: string;
  language: 'js' | 'python';
  /** Lowercase extensions including the dot, e.g. ['.xyz', '.dat'] */
  extensions: string[];
  /** Code defining parse(ctx); runs sandboxed in a worker. */
  parseScript: string;
  /** Optional code defining serialize(ctx) for round-trip export */
  serializeScript: string;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  /** Strategi pencocokan file saat impor. Default/tidak-ada = ['extension']. */
  matchStrategy?: CpMatchStrategy[];
  /** Wajib jika matchStrategy memuat 'magic'. */
  magic?: CpMagicPattern[];
  /** Wajib jika matchStrategy memuat 'filename'. Regex JS, dicoba case-insensitive. */
  filenameRegex?: string;
  /** File pendamping yang bisa dibaca parser via ctx.assets.<nama>. */
  assets?: CustomParserAsset[];
  /** Deklarasi setting (form otomatis). Nilai tersimpan terpisah per parser-id,
   *  dikirim ke parse()/serialize() sebagai ctx.options. */
  settings?: CpSettingSpec[];
}

/** Entry returned by a custom parse() call before normalization into Line.
 *  `index` is a parser-defined position (entry number, byte offset, array index)
 *  passed through to serialize(ctx) as line.index. */
export interface CustomParsedEntry {
  name?: string | null;
  message: string;
  raw?: string | null;
  index?: number | null;
}

export type CpMatchStrategy = 'extension' | 'magic' | 'filename';

/** Pattern magic bytes: bandingkan byte pada `offset` dengan hex (pasangan genap, spasi boleh). */
export interface CpMagicPattern {
  offset: number;
  hex: string;
}

/** Aset file yang dibundle bersama parser (base64). */
export interface CustomParserAsset {
  name: string;       // path relatif, forward slash, tanpa '..'
  dataBase64: string;
}

/** Spec setting per-parser: form otomatis; nilai dikirim ke parser sebagai ctx.options. */
export interface CpSettingSpec {
  key: string;            // /^[a-zA-Z_$][a-zA-Z0-9_$]*$/
  label: string;
  type?: 'string' | 'number' | 'boolean' | 'select' | 'textarea';
  default?: string | number | boolean | null;
  options?: { value: string | number | boolean; label: string }[]; // wajib utk select
  description?: string;
  placeholder?: string;
  min?: number; max?: number; step?: number;
}

export interface AppState {
  sourceLang: string;
  targetLang: string;
  regexFilter: string;
  regexFilterCase: boolean;
  preReplaceRules: string;
  postReplaceRules: string;
  enableBackgroundChaining: boolean;
  currentBackground: string;
  summaryPrompt: string;
  disableEmptyLineValidation: boolean;
  showFurigana: boolean;
  furiganaType: 'furigana' | 'hiragana' | 'katakana' | 'romaji';
  fontSize: number;
  enableDictionary: boolean;
  dictionaryEngine: 'llm' | 'jisho';
  dictionaryPrompt: string;
  checkKanaResidue: boolean;
  checkSimilarity: boolean;
  similarityThreshold: number;
  checkLinebreak: boolean;
  checkLengthRatio: boolean;
  lengthRatioThreshold: number;
  checkLanguage: boolean;
  checkPunctuation: boolean;
  checkUntransName: boolean;
  ignorePasteNames: boolean;
  enableUncertainMarking: boolean;
  /** Replace angle-bracket section tags (<Glossary>, <Context>, <lines>) with
   *  `=== LABEL ===` markers so ChatGPT does not strip them as HTML. */
  safeTagsForChatgpt: boolean;
  aiBackupKeys: string;
  aiKeyStrategy: 'fallback' | 'random';
  aiTranslateMode: 'auto' | 'agent' | 'copas';
  /** Engine for the Glossary Auto loop: HTTP API or Auto Copas (browser). */
  glossaryEngine: 'api' | 'copas';
  /** Engine for the AI Check Auto loop: HTTP API or Auto Copas (browser). */
  aiCheckEngine: 'api' | 'copas';
  /** Engine for Live Translate (on-the-fly during gameplay): HTTP API or Auto Copas. */
  liveTranslateEngine: 'api' | 'copas';
  /**
   * Look-ahead batch size for TL Mode: 1 translates only the hooked line, >1
   * also translates the next (n-1) untranslated lines. Only meaningful for the
   * Copas engine, where one round-trip is expensive.
   */
  liveBatchSize: number;
  /** AI chat site Auto Copas drives (Gemini/ChatGPT/DeepSeek/Arena). */
  copasTarget: 'gemini' | 'chatgpt' | 'deepseek' | 'arena';
  tavilyApiKey: string;
  agentMaxTurns: number;
  currentProjectId: string | null;
  projectName: string;
  projectType: string;
  translationMode: 'ai' | 'htl';
  jsonRefLang: string;
  epubTags: string;
  epubSourceId: string | null;
  epubImages: EpubImageAsset[];
  showEpubImages: boolean;
  lucaExportLang: string;
  lucaProfile: string;
  lucaMcDisplayName: string;
  lucaRawFiles: Record<string, string[]>;
  lucaRawBuffers: Record<string, string>;
  /** Active custom parser id when projectType === 'custom' */
  customParserId: string | null;
  /** Original decoded text per file for custom-parser round-trip export */
  customRawFiles: Record<string, string>;
  /** Original file bytes (base64) per file for custom-parser round-trip export */
  customRawBuffers: Record<string, string>;
  /** Game engine cache directory for patch export */
  gameEngineCacheDir?: string;
  /** Game executable directory */
  gameEngineGameDir?: string;
  lines: Line[];
  importedFiles: string[];
  fileOrder: string[];
  aiInstructionHeader: string;
  aiTranslationFormat: string;
  aiApiType: 'openai' | 'gemini' | 'anthropic';
  /** Number of untranslated lines exported by the most recent Copy for AI call. Used to populate {{lineCount}} in prompts. */
  _lastExportedLineCount: number;
  aiApiUrl: string;
  aiApiKey: string;
  aiModel: string;
  /** Manual context window override (tokens). 0 = auto per model lookup. */
  aiContextWindow: number;
  aiTemperature: number;
  aiTopP: number;
  aiMaxTokens: number;
  aiFrequencyPenalty: number;
  aiPresencePenalty: number;
  aiSeed: number | null;
  aiReasoningEffort: 'default' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
  aiRpm: number;
  /**
   * Idle timeout for an AI request, in milliseconds. The countdown restarts on
   * every chunk, so it measures silence, not total duration: a reasoning model
   * may think for a while before its first token. `0` disables it.
   */
  aiRequestTimeoutMs: number;
  aiThinkingMode: 'default' | 'off' | 'on';
  aiFilterThinkingOutput: boolean;
  /** Merge role:system into user message (workaround for gateways that drop system on OpenAI-compatible routes). */
  aiMergeSystemPrompt: boolean;
  glossaryPrompt: string;
  aiCheckPrompt: string;
  agentPrompt: string;
  glossaryText: string;
  contextLines: number;
  contextType: string;
  selectionBatchSize: number;
  glossaryBatchSize: number;
  glossaryInLoop: boolean;
  aiCheckBatchSize: number;
  parallelBatchSize: number;
  subagentWorkers: number;
  undoStack: UndoSnapshot[];
  redoStack: UndoSnapshot[];
  selectedLines: Set<number>;
  selectionHistory: number[][];
  selectionHistoryIndex: number;
  activeWorkspaceTab: WorkspaceTab;
  displayRows: DisplayRow[];
  lineByNum: Map<number, Line>;
  proofreadMatches: ProofreadMatch[];
  qaMatches: QaMatch[];
  aiCheckCorrections: AiCheckCorrection[];
  dashboardProjects: DashboardProject[];
  agentMemories: AgentMemory[];
  projectLoggingEnabled: boolean;
  aiStreaming: boolean;
  autoRepeatOnFailure: boolean;
  incrementEnabled?: boolean;
  enableAiCheckChaining: boolean;
  enableAiCheckStoryContext: boolean;
  aiCheckStoryContext: string;
  aiCheckSummaryPrompt: string;
  enableAiCheckAgentMemory: boolean;
  aiCheckLocalizationNotes: string;
  aiCheckRevisionsSummary: string;
  /** Auto-apply tier: high-confidence corrections apply without review. */
  aiCheckAutoApplyHigh: boolean;
  /** Review mode: pause after every batch so all corrections are reviewed manually. */
  aiCheckReviewMode: boolean;
  /** Include following lines (after selection) in the AI Check context block. */
  contextLinesAfter: number;
  /** AI Check output format for the API engine. */
  aiCheckOutputFormat: 'text' | 'json';
  /** Two-pass specialized review (Accuracy pass + Naturalness pass). */
  aiCheckDeepMode: boolean;
}

export type WorkspaceTab = 'translate' | 'glossary' | 'aiCheck' | 'delete';

export interface PartialLineSnapshot {
  line_num: number;
  file?: string;
  name?: string | null;
  message?: string;
  trans_name: string | null;
  trans_message: string | null;
  is_translated: boolean;
  bookmarked?: boolean;
  _hidden?: boolean;
  _glossary_extracted?: boolean;
  _ai_checked?: boolean;
  _ai_confirmed?: boolean;
  luca_command?: string;
  luca_pre?: string;
  luca_post?: string;
  luca_text_prefix?: string | null;
  epub_selector?: string;
  epub_id?: string;
}

export interface UndoSnapshot {
  lines: PartialLineSnapshot[];
  /** File-level operations (add/remove/reorder); when present, lines is empty. */
  fileAction?: FileActionSnapshot;
}

export interface FileActionSnapshot {
  type: 'add' | 'remove' | 'reorder';
  files: string[];
  /** Lines that were removed (for 'remove' action undo) */
  removedLines?: Line[];
  /** Lines added by the action, so undo can remove them. */
  addedLines?: Line[];
  /** Previous file order (for 'reorder' action undo) */
  prevOrder?: string[];
  /** New file order (for 'reorder' action redo) */
  newOrder?: string[];
  /** Full file lists for add/remove, needed for reliable redo. */
  prevImportedFiles?: string[];
  newImportedFiles?: string[];
  prevFileOrder?: string[];
  newFileOrder?: string[];
}

export interface DisplayRow {
  type: 'line' | 'separator' | 'image';
  line?: Line;
  file?: string;
  src?: string;
}

export interface ProofreadMatch {
  num: number;
  file: string;
  origName: string;
  origMsg: string;
  transName: string | null;
  transMsg: string | null;
  isTrans: boolean;
  excluded?: boolean;
}

export interface QaMatch {
  num: number;
  file: string;
  origName: string | null;
  origMsg: string;
  transName: string | null;
  transMsg: string | null;
  errors: string[];
}

export interface AiCheckCorrection {
  num: number;
  category: string;
  reason: string;
  name: string;
  text: string;
  checked: boolean;
  /** Confidence reported by the model (default 'medium' when absent). */
  confidence?: 'high' | 'medium' | 'low';
  /** Set when the local sanity gate flagged this correction for manual review. */
  needsReview?: boolean;
  /** Short reason why the sanity gate flagged this correction. */
  reviewNote?: string;
}

export interface DashboardProject {
  id: string;
  name: string;
  projectType: string;
  translationMode: string;
  totalLines: number;
  translatedLines: number;
  fileCount: number;
  lineCount?: number;
  updatedAt: number;
  /** Set when the .cstl file exists but cannot be parsed; shown as a recovery card. */
  corrupt?: boolean;
  /** For projectType 'custom': which custom parser the project uses. */
  customParserId?: string | null;
}

export type MemoryCategory = 'style' | 'terminology' | 'character' | 'preference' | 'note';
export type MemoryScope = 'global' | 'project';

export interface AgentMemory {
  key: string;
  value: string;
  category: MemoryCategory;
  scope: MemoryScope;
  created: number;
  updated: number;
}

export interface GlossaryEntry {
  target: string;
  type: string;
  desc: string;
}

export interface ShortcutParsed {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
  key: string;
}

export interface ParsedTranslationItem {
  num: number;
  name: string | null;
  msg: string;
  rawMsg: string;
  /** [D]/[N] tag echoed by the model, when present. Absent for other formats. */
  tag?: 'D' | 'N' | null;
}

// Populated dynamically by ui-init.ts.
export type UiCache = Record<string, HTMLElement | any>;
