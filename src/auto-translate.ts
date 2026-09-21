// @module auto-translate.ts — API Integration for Automated AI Translation

import { state, ui, isTranslated, isIlustrasiLine } from './state';
import { buildSelectedTranslationExport, applyPromptVariables } from './ai-format';
import { getGlossaryPrompt, sanitizeTagsForChatgpt } from './glossary';
import { DEFAULT_PROMPT_HEADER, DEFAULT_GLOSSARY_PROMPT } from './constants';
import { flashHint } from './render';
import { openModal, closeModal } from './project';
import * as Translate from './translate';
import { TranslationApplyError } from './translate';
import { onSaveGlossary } from './glossary';
import { onApplyAiCheckCorrections } from './ai-check';
import { appendProjectLog, updateStreamingLog, finishStreamingLog } from './logging';
import { applyAnthropicOptions, applyGeminiOptions, applyOpenAIOptions } from './api-request-options';
import { getDisplayOrderedLines } from './selection';

const API_STORAGE_KEY = 'cstl_api_settings';

function numberFromInput(el: any, fallback: number): number {
  const value = Number((el as HTMLInputElement | undefined)?.value);
  return Number.isFinite(value) ? value : fallback;
}

function optionalIntegerFromInput(el: any): number | null {
  const raw = String((el as HTMLInputElement | undefined)?.value || '').trim();
  if (!raw) return null;
  const value = Number(raw);
  return Number.isInteger(value) ? value : null;
}

export function loadApiSettings(): void {
  try {
    const saved = localStorage.getItem(API_STORAGE_KEY);
    if (saved) {
      const p = JSON.parse(saved);
      if (p.aiApiType) state.aiApiType = p.aiApiType;
      if (p.aiApiUrl) state.aiApiUrl = p.aiApiUrl;
      if (p.aiApiKey) state.aiApiKey = p.aiApiKey;
      if (p.aiModel) state.aiModel = p.aiModel;
      if (p.aiTemperature !== undefined) state.aiTemperature = Number(p.aiTemperature);
      if (p.aiTopP !== undefined) state.aiTopP = Number(p.aiTopP);
      if (p.aiMaxTokens !== undefined) state.aiMaxTokens = Number(p.aiMaxTokens);
      if (p.aiFrequencyPenalty !== undefined) state.aiFrequencyPenalty = Number(p.aiFrequencyPenalty);
      if (p.aiPresencePenalty !== undefined) state.aiPresencePenalty = Number(p.aiPresencePenalty);
      if (p.aiSeed !== undefined) state.aiSeed = p.aiSeed === null ? null : Number(p.aiSeed);
      if (p.aiReasoningEffort) state.aiReasoningEffort = p.aiReasoningEffort;
      if (p.aiRpm !== undefined) state.aiRpm = Number(p.aiRpm);
      if (p.aiThinkingMode) state.aiThinkingMode = p.aiThinkingMode;
      if (p.aiFilterThinkingOutput !== undefined) state.aiFilterThinkingOutput = !!p.aiFilterThinkingOutput;
      if (p.aiMergeSystemPrompt !== undefined) state.aiMergeSystemPrompt = !!p.aiMergeSystemPrompt;
      if (p.aiStreaming !== undefined) state.aiStreaming = !!p.aiStreaming;
      if (p.aiBackupKeys !== undefined) state.aiBackupKeys = p.aiBackupKeys;
      if (p.aiKeyStrategy) state.aiKeyStrategy = p.aiKeyStrategy;
      if (p.aiTranslateMode) state.aiTranslateMode = p.aiTranslateMode;
      if (p.tavilyApiKey !== undefined) state.tavilyApiKey = p.tavilyApiKey;
      if (p.autoRepeatOnFailure !== undefined) state.autoRepeatOnFailure = !!p.autoRepeatOnFailure;
    }
  } catch (e) {
    console.error('Failed to load API settings', e);
  }
  const modeSelect = document.getElementById('aiTranslateModeSelect') as HTMLSelectElement;
  if (modeSelect) modeSelect.value = state.aiTranslateMode || 'auto';
  const repeatCheck = document.getElementById('checkAutoRepeatOnFailure') as HTMLInputElement | null;
  if (repeatCheck) repeatCheck.checked = !!state.autoRepeatOnFailure;
  const repeatCached = ui.checkAutoRepeatOnFailure as HTMLInputElement | undefined;
  if (repeatCached) repeatCached.checked = !!state.autoRepeatOnFailure;
}

export function saveApiSettings(): void {
  const d = {
    aiApiType: state.aiApiType,
    aiApiUrl: state.aiApiUrl,
    aiApiKey: state.aiApiKey,
    aiModel: state.aiModel,
    aiTemperature: state.aiTemperature,
    aiTopP: state.aiTopP,
    aiMaxTokens: state.aiMaxTokens,
    aiFrequencyPenalty: state.aiFrequencyPenalty,
    aiPresencePenalty: state.aiPresencePenalty,
    aiSeed: state.aiSeed,
    aiReasoningEffort: state.aiReasoningEffort,
    aiRpm: state.aiRpm,
    aiThinkingMode: state.aiThinkingMode,
    aiFilterThinkingOutput: state.aiFilterThinkingOutput,
    aiMergeSystemPrompt: state.aiMergeSystemPrompt,
    aiStreaming: state.aiStreaming,
    aiBackupKeys: state.aiBackupKeys,
    aiKeyStrategy: state.aiKeyStrategy, aiTranslateMode: state.aiTranslateMode,
    tavilyApiKey: state.tavilyApiKey,
    autoRepeatOnFailure: state.autoRepeatOnFailure,
  };
  localStorage.setItem(API_STORAGE_KEY, JSON.stringify(d));
}

export function onOpenApiSettings(): void {
  if (ui.apiTypeSelect) (ui.apiTypeSelect as HTMLSelectElement).value = state.aiApiType || 'openai';
  if (ui.apiUrlInput) (ui.apiUrlInput as HTMLInputElement).value = state.aiApiUrl || '';
  if (ui.apiKeyInput) (ui.apiKeyInput as HTMLInputElement).value = state.aiApiKey || '';
  if (ui.apiModelInput) (ui.apiModelInput as HTMLInputElement).value = state.aiModel || 'gpt-4o-mini';
  if (ui.apiModelSelect) (ui.apiModelSelect as HTMLSelectElement).style.display = 'none';
  if (ui.apiModelInput) (ui.apiModelInput as HTMLInputElement).style.display = '';
  if (ui.apiModelFetchStatus) (ui.apiModelFetchStatus as HTMLElement).style.display = 'none';
  if (ui.apiTemperatureInput) (ui.apiTemperatureInput as HTMLInputElement).value = String(state.aiTemperature ?? 1.0);
  if (ui.apiTopPInput) (ui.apiTopPInput as HTMLInputElement).value = String(state.aiTopP ?? 1.0);
  if (ui.apiMaxTokensInput) (ui.apiMaxTokensInput as HTMLInputElement).value = String(state.aiMaxTokens ?? 8192);
  if (ui.apiFrequencyPenaltyInput) (ui.apiFrequencyPenaltyInput as HTMLInputElement).value = String(state.aiFrequencyPenalty ?? 0);
  if (ui.apiPresencePenaltyInput) (ui.apiPresencePenaltyInput as HTMLInputElement).value = String(state.aiPresencePenalty ?? 0);
  if (ui.apiSeedInput) (ui.apiSeedInput as HTMLInputElement).value = state.aiSeed === null ? '' : String(state.aiSeed);
  if (ui.apiReasoningEffortSelect) (ui.apiReasoningEffortSelect as HTMLSelectElement).value = state.aiReasoningEffort || 'default';
  if (ui.apiRpmInput) (ui.apiRpmInput as HTMLInputElement).value = String(state.aiRpm ?? 10);
  if (ui.apiThinkingSelect) (ui.apiThinkingSelect as HTMLSelectElement).value = state.aiThinkingMode || 'default';
  if (ui.apiFilterThinkingCheck) (ui.apiFilterThinkingCheck as HTMLInputElement).checked = state.aiFilterThinkingOutput !== false;
  if (ui.apiMergeSystemCheck) (ui.apiMergeSystemCheck as HTMLInputElement).checked = !!state.aiMergeSystemPrompt;
  if (ui.apiStreamingCheck) (ui.apiStreamingCheck as HTMLInputElement).checked = !!state.aiStreaming;
  if (ui.apiBackupKeysInput) (ui.apiBackupKeysInput as HTMLTextAreaElement).value = state.aiBackupKeys || '';
  if (ui.apiKeyStrategySelect) (ui.apiKeyStrategySelect as HTMLSelectElement).value = state.aiKeyStrategy || 'fallback';
  if (ui.aiTranslateModeSelect) (ui.aiTranslateModeSelect as HTMLSelectElement).value = state.aiTranslateMode || 'auto';
  if (ui.tavilyKeyInput) (ui.tavilyKeyInput as HTMLInputElement).value = state.tavilyApiKey || '';
  updateDelayPreview();
  renderProfileSelect();
  if (ui.apiSettingsModal) openModal(ui.apiSettingsModal as HTMLElement);
}

// ─── API Profiles Management ──────────────────────────────────────────────────

const PROFILES_STORAGE_KEY = 'cstl_api_profiles';

export type ApiProfileData = {
  aiApiType?: 'openai' | 'gemini' | 'anthropic';
  aiApiUrl?: string;
  aiApiKey?: string;
  aiModel?: string;
  aiTemperature?: number;
  aiTopP?: number;
  aiMaxTokens?: number;
  aiFrequencyPenalty?: number;
  aiPresencePenalty?: number;
  aiSeed?: number | null;
  aiReasoningEffort?: 'default' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
  aiRpm?: number;
  aiThinkingMode?: 'default' | 'off' | 'on';
  aiFilterThinkingOutput?: boolean;
  aiMergeSystemPrompt?: boolean;
  aiStreaming?: boolean;
  aiBackupKeys?: string;
  aiKeyStrategy?: 'fallback' | 'random';
  tavilyApiKey?: string;
};

export function loadProfiles(): Record<string, ApiProfileData> {
  try {
    const raw = localStorage.getItem(PROFILES_STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch (e) {
    console.error('Failed to load API profiles', e);
  }
  return {};
}

export function saveProfiles(profiles: Record<string, ApiProfileData>): void {
  localStorage.setItem(PROFILES_STORAGE_KEY, JSON.stringify(profiles));
}

export function renderProfileSelect(): void {
  const select = ui.apiProfileSelect as HTMLSelectElement | undefined;
  if (!select) return;
  const profiles = loadProfiles();
  const names = Object.keys(profiles).sort();
  select.innerHTML = '<option value="">-- Pilih profil --</option>';
  for (const name of names) {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    select.appendChild(opt);
  }
  updateProfileButtonsState();
}

export function updateProfileButtonsState(): void {
  const select = ui.apiProfileSelect as HTMLSelectElement | undefined;
  const btnLoad = ui.btnLoadProfile as HTMLButtonElement | undefined;
  const btnDelete = ui.btnDeleteProfile as HTMLButtonElement | undefined;
  if (!select) return;
  const hasSelection = !!select.value;
  if (btnLoad) btnLoad.disabled = !hasSelection;
  if (btnDelete) btnDelete.disabled = !hasSelection;
}

export function onLoadProfile(): void {
  const select = ui.apiProfileSelect as HTMLSelectElement | undefined;
  if (!select || !select.value) return;
  const name = select.value;
  const profiles = loadProfiles();
  const p = profiles[name];
  if (!p) {
    flashHint(`Profil "${name}" tidak ditemukan.`);
    return;
  }
  if (p.aiApiType && ui.apiTypeSelect) (ui.apiTypeSelect as HTMLSelectElement).value = p.aiApiType;
  if (p.aiApiUrl !== undefined && ui.apiUrlInput) (ui.apiUrlInput as HTMLInputElement).value = p.aiApiUrl;
  if (p.aiApiKey !== undefined && ui.apiKeyInput) (ui.apiKeyInput as HTMLInputElement).value = p.aiApiKey;
  if (p.aiModel !== undefined && ui.apiModelInput) (ui.apiModelInput as HTMLInputElement).value = p.aiModel;
  if (p.aiTemperature !== undefined && ui.apiTemperatureInput) (ui.apiTemperatureInput as HTMLInputElement).value = String(p.aiTemperature);
  if (p.aiTopP !== undefined && ui.apiTopPInput) (ui.apiTopPInput as HTMLInputElement).value = String(p.aiTopP);
  if (p.aiMaxTokens !== undefined && ui.apiMaxTokensInput) (ui.apiMaxTokensInput as HTMLInputElement).value = String(p.aiMaxTokens);
  if (p.aiFrequencyPenalty !== undefined && ui.apiFrequencyPenaltyInput) (ui.apiFrequencyPenaltyInput as HTMLInputElement).value = String(p.aiFrequencyPenalty);
  if (p.aiPresencePenalty !== undefined && ui.apiPresencePenaltyInput) (ui.apiPresencePenaltyInput as HTMLInputElement).value = String(p.aiPresencePenalty);
  if (p.aiSeed !== undefined && ui.apiSeedInput) (ui.apiSeedInput as HTMLInputElement).value = p.aiSeed === null ? '' : String(p.aiSeed);
  if (p.aiReasoningEffort && ui.apiReasoningEffortSelect) (ui.apiReasoningEffortSelect as HTMLSelectElement).value = p.aiReasoningEffort;
  if (p.aiRpm !== undefined && ui.apiRpmInput) (ui.apiRpmInput as HTMLInputElement).value = String(p.aiRpm);
  if (p.aiThinkingMode && ui.apiThinkingSelect) (ui.apiThinkingSelect as HTMLSelectElement).value = p.aiThinkingMode;
  if (p.aiFilterThinkingOutput !== undefined && ui.apiFilterThinkingCheck) (ui.apiFilterThinkingCheck as HTMLInputElement).checked = !!p.aiFilterThinkingOutput;
  if (p.aiMergeSystemPrompt !== undefined && ui.apiMergeSystemCheck) (ui.apiMergeSystemCheck as HTMLInputElement).checked = !!p.aiMergeSystemPrompt;
  if (p.aiStreaming !== undefined && ui.apiStreamingCheck) (ui.apiStreamingCheck as HTMLInputElement).checked = !!p.aiStreaming;
  if (p.aiBackupKeys !== undefined && ui.apiBackupKeysInput) (ui.apiBackupKeysInput as HTMLTextAreaElement).value = p.aiBackupKeys;
  if (p.aiKeyStrategy && ui.apiKeyStrategySelect) (ui.apiKeyStrategySelect as HTMLSelectElement).value = p.aiKeyStrategy;
  if (p.tavilyApiKey !== undefined && ui.tavilyKeyInput) (ui.tavilyKeyInput as HTMLInputElement).value = p.tavilyApiKey;
  updateDelayPreview();
  flashHint(`Profil "${name}" dimuat ke formulir.`);
}

export function onSaveProfile(): void {
  const nameInput = ui.apiProfileNameInput as HTMLInputElement | undefined;
  const select = ui.apiProfileSelect as HTMLSelectElement | undefined;
  let name = nameInput?.value?.trim() || '';
  if (!name && select?.value) {
    name = select.value;
  }
  if (!name) {
    flashHint('Masukkan nama profil yang ingin disimpan.');
    return;
  }
  const profiles = loadProfiles();
  profiles[name] = {
    aiApiType: (ui.apiTypeSelect as HTMLSelectElement | undefined)?.value as any || 'openai',
    aiApiUrl: (ui.apiUrlInput as HTMLInputElement | undefined)?.value?.trim() || '',
    aiApiKey: (ui.apiKeyInput as HTMLInputElement | undefined)?.value?.trim() || '',
    aiModel: (ui.apiModelInput as HTMLInputElement | undefined)?.value?.trim() || 'gpt-4o-mini',
    aiTemperature: numberFromInput(ui.apiTemperatureInput, 1),
    aiTopP: numberFromInput(ui.apiTopPInput, 1),
    aiMaxTokens: numberFromInput(ui.apiMaxTokensInput, 8192),
    aiFrequencyPenalty: numberFromInput(ui.apiFrequencyPenaltyInput, 0),
    aiPresencePenalty: numberFromInput(ui.apiPresencePenaltyInput, 0),
    aiSeed: optionalIntegerFromInput(ui.apiSeedInput),
    aiReasoningEffort: (ui.apiReasoningEffortSelect as HTMLSelectElement | undefined)?.value as any || 'default',
    aiRpm: parseInt((ui.apiRpmInput as HTMLInputElement | undefined)?.value || '10') || 10,
    aiThinkingMode: (ui.apiThinkingSelect as HTMLSelectElement | undefined)?.value as any || 'default',
    aiFilterThinkingOutput: (ui.apiFilterThinkingCheck as HTMLInputElement | undefined)?.checked ?? true,
    aiMergeSystemPrompt: (ui.apiMergeSystemCheck as HTMLInputElement | undefined)?.checked ?? false,
    aiStreaming: (ui.apiStreamingCheck as HTMLInputElement | undefined)?.checked ?? false,
    aiBackupKeys: (ui.apiBackupKeysInput as HTMLTextAreaElement | undefined)?.value || '',
    aiKeyStrategy: (ui.apiKeyStrategySelect as HTMLSelectElement | undefined)?.value as any || 'fallback',
    tavilyApiKey: (ui.tavilyKeyInput as HTMLInputElement | undefined)?.value?.trim() || '',
  };
  saveProfiles(profiles);
  if (nameInput) nameInput.value = '';
  renderProfileSelect();
  if (select) select.value = name;
  updateProfileButtonsState();
  flashHint(`Profil "${name}" berhasil disimpan.`);
}

export function onDeleteProfile(): void {
  const select = ui.apiProfileSelect as HTMLSelectElement | undefined;
  if (!select || !select.value) return;
  const name = select.value;
  const profiles = loadProfiles();
  delete profiles[name];
  saveProfiles(profiles);
  renderProfileSelect();
  updateProfileButtonsState();
  flashHint(`Profil "${name}" telah dihapus.`);
}

// ─── Model Fetcher ────────────────────────────────────────────────────────────

function appendQueryParams(rawUrl: string, values: Record<string, string>, overwrite = false): string {
  const hashIndex = rawUrl.indexOf('#');
  const hash = hashIndex >= 0 ? rawUrl.slice(hashIndex) : '';
  const withoutHash = hashIndex >= 0 ? rawUrl.slice(0, hashIndex) : rawUrl;
  const queryIndex = withoutHash.indexOf('?');
  const base = queryIndex >= 0 ? withoutHash.slice(0, queryIndex) : withoutHash;
  const params = new URLSearchParams(queryIndex >= 0 ? withoutHash.slice(queryIndex + 1) : '');
  for (const [key, value] of Object.entries(values)) {
    if (overwrite || !params.has(key)) params.set(key, value);
  }
  const query = params.toString();
  return base + (query ? `?${query}` : '') + hash;
}

export async function onFetchModels(): Promise<void> {
  const apiType = (ui.apiTypeSelect as HTMLSelectElement)?.value || state.aiApiType || 'openai';
  const apiKey = (ui.apiKeyInput as HTMLInputElement)?.value?.trim() || state.aiApiKey;
  const apiUrl = (ui.apiUrlInput as HTMLInputElement)?.value?.trim() || state.aiApiUrl;
  const btn = ui.btnFetchModels as HTMLButtonElement;
  const select = ui.apiModelSelect as HTMLSelectElement;
  const statusEl = ui.apiModelFetchStatus as HTMLElement;
  const modelInput = ui.apiModelInput as HTMLInputElement;

  if (!apiKey) {
    statusEl.style.display = 'block';
    statusEl.textContent = 'API Key belum diisi.';
    return;
  }

  btn.disabled = true;
  statusEl.style.display = 'block';
  statusEl.textContent = 'Mengambil daftar model...';

  try {
    let models: string[] = [];

    if (apiType === 'gemini') {
      const baseUrl = apiUrl || 'https://generativelanguage.googleapis.com/v1beta/models';
      const url = appendQueryParams(baseUrl, { key: apiKey }, true);
      const res = await fetch(url);
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error('Gemini API error ' + res.status + (detail ? ': ' + detail.slice(0, 200) : ''));
      }
      const data = await res.json();
      const rawModels = Array.isArray(data.models) ? data.models : [];
      models = rawModels
        .filter((m: any) => m.supportedGenerationMethods?.includes('generateContent'))
        .map((m: any) => (m.name?.replace('models/', '') || m.name))
        .filter(Boolean)
        .sort();
    } else {
      // OpenAI + Anthropic-compatible gateways usually expose GET /v1/models
      let url = apiUrl || 'https://api.openai.com/v1/models';
      url = url.replace(/\/chat\/completions\/?$/, '');
      url = url.replace(/\/messages\/?$/, '');
      if (!url.endsWith('/models')) {
        if (!url.endsWith('/')) url += '/';
        url += 'models';
      }
      const res = await fetch(url, {
        headers: {
          'Authorization': 'Bearer ' + apiKey,
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error('API error ' + res.status + (detail ? ': ' + detail.slice(0, 200) : ''));
      }
      const data = await res.json();
      const rawModels = Array.isArray(data.data) ? data.data : [];
      models = rawModels
        .map((m: any) => (m.id || m.name))
        .filter(Boolean)
        .sort();
    }

    if (!models.length) {
      statusEl.textContent = 'Tidak ada model yang ditemukan.';
      select.style.display = 'none';
      modelInput.style.display = '';
      return;
    }

    // Populate the select dropdown
    select.textContent = '';
    const defaultOpt = document.createElement('option');
    defaultOpt.value = '';
    defaultOpt.textContent = '-- Pilih model --';
    select.appendChild(defaultOpt);
    for (const m of models) {
      const opt = document.createElement('option');
      opt.value = m;
      opt.textContent = m;
      if (m === (modelInput.value || state.aiModel)) opt.selected = true;
      select.appendChild(opt);
    }

    // Show dropdown, hide text input
    select.style.display = '';
    modelInput.style.display = 'none';

    // Sync selected model back to the text input
    select.onchange = () => {
      modelInput.value = select.value;
    };

    statusEl.textContent = String(models.length) + ' model ditemukan.';
  } catch (err: any) {
    statusEl.textContent = 'Gagal: ' + err.message;
    select.style.display = 'none';
    modelInput.style.display = '';
  } finally {
    btn.disabled = false;
  }
}

export function updateDelayPreview(): void {
  if (!ui.apiRpmInput || !ui.apiDelayPreview) return;
  let rpm = parseInt((ui.apiRpmInput as HTMLInputElement).value) || 10;
  if (rpm < 1) rpm = 1;
  const delay = Math.round(60000 / rpm);
  (ui.apiDelayPreview as HTMLElement).textContent = String(delay);
}

export function onSaveApiSettings(): void {
  if (ui.apiTypeSelect) state.aiApiType = (ui.apiTypeSelect as HTMLSelectElement).value as any;
  if (ui.apiUrlInput) state.aiApiUrl = (ui.apiUrlInput as HTMLInputElement).value.trim();
  if (ui.apiKeyInput) state.aiApiKey = (ui.apiKeyInput as HTMLInputElement).value.trim();
  if (ui.apiModelSelect && ui.apiModelInput) {
    const select = ui.apiModelSelect as HTMLSelectElement;
    const input = ui.apiModelInput as HTMLInputElement;
    if (select.style.display !== 'none' && select.value) {
      input.value = select.value;
    }
  }
  if (ui.apiModelInput) state.aiModel = (ui.apiModelInput as HTMLInputElement).value.trim();
  state.aiTemperature = numberFromInput(ui.apiTemperatureInput, 1);
  state.aiTopP = numberFromInput(ui.apiTopPInput, 1);
  state.aiMaxTokens = Math.max(1, Math.trunc(numberFromInput(ui.apiMaxTokensInput, 8192)));
  state.aiFrequencyPenalty = numberFromInput(ui.apiFrequencyPenaltyInput, 0);
  state.aiPresencePenalty = numberFromInput(ui.apiPresencePenaltyInput, 0);
  state.aiSeed = optionalIntegerFromInput(ui.apiSeedInput);
  if (ui.apiReasoningEffortSelect) state.aiReasoningEffort = (ui.apiReasoningEffortSelect as HTMLSelectElement).value as any;
  if (ui.apiRpmInput) state.aiRpm = parseInt((ui.apiRpmInput as HTMLInputElement).value) || 10;
  if (ui.apiThinkingSelect) state.aiThinkingMode = (ui.apiThinkingSelect as HTMLSelectElement).value as any;
  if (ui.apiFilterThinkingCheck) state.aiFilterThinkingOutput = (ui.apiFilterThinkingCheck as HTMLInputElement).checked;
  if (ui.apiMergeSystemCheck) state.aiMergeSystemPrompt = (ui.apiMergeSystemCheck as HTMLInputElement).checked;
  if (ui.apiStreamingCheck) state.aiStreaming = (ui.apiStreamingCheck as HTMLInputElement).checked;
  if (ui.apiBackupKeysInput) state.aiBackupKeys = (ui.apiBackupKeysInput as HTMLTextAreaElement).value;
  if (ui.apiKeyStrategySelect) state.aiKeyStrategy = (ui.apiKeyStrategySelect as HTMLSelectElement).value as any;
  if (ui.aiTranslateModeSelect) state.aiTranslateMode = (ui.aiTranslateModeSelect as HTMLSelectElement).value as any;
  if (ui.tavilyKeyInput) state.tavilyApiKey = (ui.tavilyKeyInput as HTMLInputElement).value.trim();
  saveApiSettings();
  if (ui.apiSettingsModal) closeModal(ui.apiSettingsModal as HTMLElement);
  flashHint('Pengaturan API disimpan.');
}

export function delay(ms: number, shouldCancel?: () => boolean): Promise<void> {
  if (!shouldCancel) return new Promise(resolve => setTimeout(resolve, ms));
  return new Promise(resolve => {
    const start = Date.now();
    const check = () => {
      if (shouldCancel() || Date.now() - start >= ms) {
        resolve();
      } else {
        setTimeout(check, 200);
      }
    };
    check();
  });
}

type RetryState = {
  attempt: number;
  maxRetries: number;
  waitMs: number;
  reason: string;
};

type AutoTranslateAttemptError = Error & {
  retryable?: boolean;
};

function formatRetryLabel(retry: RetryState): string {
  return `Retry API ${retry.attempt}/${retry.maxRetries} (${retry.reason})`;
}

function createRetryableAiFormatError(err: TranslationApplyError): AutoTranslateAttemptError {
  const detail = err.details.length ? ` ${err.details.join(' ')}` : '';
  const retryableError = new Error(`Format respons AI tidak sesuai.${detail}`) as AutoTranslateAttemptError;
  retryableError.retryable = true;
  return retryableError;
}

function isAuthFailureMessage(msg: string): boolean {
  const m = msg.toLowerCase();
  return m.includes('401') || m.includes('403') || m.includes('unauthorized') || m.includes('forbidden') || m.includes('invalid api') || m.includes('invalid_api') || m.includes('api key') && m.includes('invalid') || m.includes('authentication');
}

function getRepeatDelayMs(): number {
  const rpm = Number(state.aiRpm);
  if (!Number.isFinite(rpm) || rpm <= 0) return 2000;
  return Math.max(1000, Math.round(60000 / rpm));
}

let isAutoTranslating = false;

export async function onAutoTranslate(): Promise<void> {
  if (state.aiTranslateMode === 'agent') {
    const { onAgentTranslate } = await import('./agent-translate');
    return onAgentTranslate();
  }
  const btn = ui.btnAutoTranslate as HTMLButtonElement;

  if (isAutoTranslating) {
    isAutoTranslating = false;
    void import('./notify').then(m => m.notifyStop('Auto Translate dihentikan.', 'warn'));
    btn.textContent = 'Menghentikan...';
    btn.classList.remove('btn-danger');
    btn.classList.add('btn-success');
    return;
  }

  if (!state.aiApiKey) {
    alert('API Key belum diisi! Klik tombol robot di pojok kanan bawah untuk mengatur.');
    onOpenApiSettings();
    return;
  }

  isAutoTranslating = true;
  btn.classList.remove('btn-success');
  btn.classList.add('btn-danger');
  btn.textContent = 'Hentikan Auto Translate';

  const orderedLines = getDisplayOrderedLines();
  let targetLines = Array.from(state.selectedLines)
    .map(num => state.lines.find(l => l.line_num === num))
    .filter(l => l && !isTranslated(l) && !l._hidden) as typeof state.lines;

  if (targetLines.length === 0) {
    targetLines = orderedLines.filter(l => !isTranslated(l) && !l._hidden);
  } else {
    const rankMap = new Map<number, number>();
    orderedLines.forEach((l, idx) => rankMap.set(l.line_num, idx));
    targetLines.sort((a, b) => (rankMap.get(a.line_num) ?? 0) - (rankMap.get(b.line_num) ?? 0));
  }

  try {
    while (isAutoTranslating) {
      // Find untranslated lines from top
      const untranslatedLines = targetLines.filter(l => !isTranslated(l) && !l._hidden);
      if (untranslatedLines.length === 0) {
        void import('./notify').then(m => m.notifyStop('Auto Translate selesai.', 'success'));
        alert('Selesai! Semua baris target telah diterjemahkan.');
        break;
      }

      // Take batch size from settings
      const batchSize = state.selectionBatchSize || 100;
      const batch = untranslatedLines.slice(0, batchSize);

      // Select them in UI
      state.selectedLines.clear();
      for (const l of batch) {
        state.selectedLines.add(l.line_num);
      }
      
      // Update UI selection
      import('./render').then(m => m.syncCheckboxUI());
      import('./selection').then(m => m.scrollPreviewToLine(batch[0].line_num));

      const sel = batch;
      
      const parallelSize = Math.max(1, Math.min(10, state.parallelBatchSize || 1));

      if (parallelSize === 1) {
        btn.textContent = `Menerjemahkan ${sel.length} baris... (Klik untuk Stop)`;

        let contextBlock = '';
        if (state.contextLines > 0) {
          const firstSelLineNum = sel[0].line_num;
          const firstSelIdx = orderedLines.findIndex(l => l.line_num === firstSelLineNum);
          if (firstSelIdx > 0) {
            const visiblePreceding = orderedLines.slice(0, firstSelIdx).filter(l => !l._hidden && !isIlustrasiLine(l));
            const ctxLines = visiblePreceding.slice(-state.contextLines);
            const ctxOut: string[] = [];
            for (const l of ctxLines) {
              const origNameStr = l.name ? `${l.name}: ` : '';
              const transNameStr = (l.trans_name || l.name) ? `${(l.trans_name || l.name)!.trim()}: ` : '';
              if (state.contextType === 'raw') {
                ctxOut.push(`${origNameStr}${l.message}`);
              } else if (state.contextType === 'both') {
                ctxOut.push(`[Original] ${origNameStr}${l.message}\n[Translated] ${transNameStr}${l.trans_message || ''}`);
              } else {
                ctxOut.push(`${transNameStr}${l.trans_message || l.message}`);
              }
            }
            if (ctxOut.length > 0) {
              contextBlock = sanitizeTagsForChatgpt(`\n\n<Context>\nThese lines are for context only. Do NOT translate them.\n${ctxOut.join('\n')}\n</Context>`);
            }
          }
        }

        const joinedText = buildSelectedTranslationExport(false);
        const glossaryBlock = getGlossaryPrompt(joinedText);
        const baseHeader = applyPromptVariables((state.aiInstructionHeader || DEFAULT_PROMPT_HEADER).trim());

        const sections: string[] = [baseHeader];
        if (glossaryBlock) sections.push(glossaryBlock.trim());
        if (contextBlock) sections.push(contextBlock.trim());
        if (state.enableUncertainMarking) {
          sections.push('If you are uncertain about a translation, prefix it with [?].');
        }
        sections.push(joinedText.trim());
        const prompt = sections.join('\n\n');

        let repeatAttempt = 0;
        while (true) {
          try {
            const rawResult = await fetchWithRetry(async () => {
              const result = await fetchApiResult(prompt);
              if (!isAutoTranslating) throw new Error('Dibatalkan oleh pengguna.');
              (ui.pasteArea as HTMLTextAreaElement).value = result;
              try {
                Translate.onApplyTranslation({ suppressAlerts: true });
              } catch (err: any) {
                if (err instanceof TranslationApplyError) {
                  throw createRetryableAiFormatError(err);
                }
                throw err;
              }
              return result;
            }, (retry) => {
              btn.textContent = `${formatRetryLabel(retry)}... (Klik Stop)`;
            }, () => !isAutoTranslating);

            if (!rawResult || !rawResult.trim()) {
              throw new Error('Respons dari API kosong.');
            }
            break;
          } catch (err: any) {
            const msg = String(err?.message || err);
            if (msg.includes('Dibatalkan')) throw err;
            if (isAuthFailureMessage(msg)) throw err;
            if (!state.autoRepeatOnFailure) throw err;
            if (!isAutoTranslating) throw new Error('Dibatalkan oleh pengguna.');
            repeatAttempt++;
            const waitMs = getRepeatDelayMs();
            btn.textContent = `Gagal: ${msg.slice(0, 80)} — coba lagi ke-${repeatAttempt} dalam ${Math.round(waitMs / 1000)}s... (Klik Stop)`;
            await delay(waitMs, () => !isAutoTranslating);
            if (!isAutoTranslating) throw new Error('Dibatalkan oleh pengguna.');
          }
        }

        if (isAutoTranslating && state.aiRpm > 0) {
          const waitMs = Math.round(60000 / state.aiRpm);
          btn.textContent = `Menunggu delay (${Math.round(waitMs/1000)}s)... (Klik untuk Stop)`;
          await delay(waitMs, () => !isAutoTranslating);
        }
      } else {
        // Parallel mode: split batch into sub-batches and send concurrently
        const subBatchSize = Math.ceil(sel.length / parallelSize);
        const subBatches: typeof sel[] = [];
        for (let i = 0; i < sel.length; i += subBatchSize) {
          subBatches.push(sel.slice(i, i + subBatchSize));
        }

        btn.textContent = `Menerjemahkan ${sel.length} baris (${subBatches.length}x paralel)... (Klik untuk Stop)`;

        const baseHeader = applyPromptVariables((state.aiInstructionHeader || DEFAULT_PROMPT_HEADER).trim());
        const glossaryBlock = getGlossaryPrompt('');

        const buildSubPrompt = (subBatch: typeof sel): string => {
          const subText = buildSelectedTranslationExport(false, new Set(subBatch.map(l => l.line_num)));

          let contextBlock = '';
          if (state.contextLines > 0) {
            const firstSelLineNum = subBatch[0].line_num;
            const firstSelIdx = orderedLines.findIndex(l => l.line_num === firstSelLineNum);
            if (firstSelIdx > 0) {
              const visiblePreceding = orderedLines.slice(0, firstSelIdx).filter(l => !l._hidden && !isIlustrasiLine(l));
              const ctxLines = visiblePreceding.slice(-state.contextLines);
              const ctxOut: string[] = [];
              for (const l of ctxLines) {
                const origNameStr = l.name ? `${l.name}: ` : '';
                const transNameStr = (l.trans_name || l.name) ? `${(l.trans_name || l.name)!.trim()}: ` : '';
                if (state.contextType === 'raw') {
                  ctxOut.push(`${origNameStr}${l.message}`);
                } else if (state.contextType === 'both') {
                  ctxOut.push(`[Original] ${origNameStr}${l.message}\n[Translated] ${transNameStr}${l.trans_message || ''}`);
                } else {
                  ctxOut.push(`${transNameStr}${l.trans_message || l.message}`);
                }
              }
              if (ctxOut.length > 0) {
                contextBlock = sanitizeTagsForChatgpt(`\n\n<Context>\nThese lines are for context only. Do NOT translate them.\n${ctxOut.join('\n')}\n</Context>`);
              }
            }
          }

          const sections: string[] = [baseHeader];
          if (glossaryBlock) sections.push(glossaryBlock.trim());
          if (contextBlock) sections.push(contextBlock.trim());
          if (state.enableUncertainMarking) {
            sections.push('If you are uncertain about a translation, prefix it with [?].');
          }
          sections.push(subText.trim());
          return sections.join('\n\n');
        };

        // Build all prompts without changing the user's selection.
        const subPrompts = subBatches.map(sb => ({ batch: sb, prompt: buildSubPrompt(sb) }));

        let parallelRepeatAttempt = 0;
        let fetchResults: PromiseSettledResult<{ sp: typeof subPrompts[number]; result: string }>[] = [];
        while (true) {
          fetchResults = await Promise.allSettled(subPrompts.map(async (sp, idx) => {
            if (!isAutoTranslating) throw new Error('Dibatalkan oleh pengguna.');
            const result = await fetchWithRetry(async () => {
              const attemptResult = await fetchApiResult(sp.prompt);
              if (!isAutoTranslating) throw new Error('Dibatalkan oleh pengguna.');
              const pasteArea = ui.pasteArea as HTMLTextAreaElement;
              const prevVal = pasteArea.value;
              pasteArea.value = attemptResult;
              try {
                Translate.onApplyTranslation({
                  suppressAlerts: true,
                  selectedLineNums: new Set(sp.batch.map(l => l.line_num)),
                });
              } catch (err: any) {
                if (err instanceof TranslationApplyError) throw createRetryableAiFormatError(err);
                throw err;
              } finally {
                pasteArea.value = prevVal;
              }
              return attemptResult;
            }, (retry) => {
              btn.textContent = `Paralel ${idx + 1}/${subPrompts.length}: ${formatRetryLabel(retry)}... (Klik Stop)`;
            }, () => !isAutoTranslating);
            return { sp, result };
          }));

          state.selectedLines.clear();
          for (const l of sel) state.selectedLines.add(l.line_num);

          let successCount = 0;
          let lastErr = '';
          for (let i = 0; i < fetchResults.length; i++) {
            const r = fetchResults[i];
            if (r.status === 'fulfilled') successCount++;
            else lastErr = String((r as any).reason?.message || r);
          }
          if (successCount > 0) break;
          if (isAuthFailureMessage(lastErr)) throw new Error(lastErr);
          if (!state.autoRepeatOnFailure) throw new Error(`Semua ${subPrompts.length} request paralel gagal. ${lastErr}`);
          if (!isAutoTranslating) throw new Error('Dibatalkan oleh pengguna.');
          parallelRepeatAttempt++;
          const waitMs = getRepeatDelayMs();
          btn.textContent = `Paralel gagal: ${lastErr.slice(0, 60)} — coba lagi ke-${parallelRepeatAttempt} dalam ${Math.round(waitMs / 1000)}s... (Klik Stop)`;
          await delay(waitMs, () => !isAutoTranslating);
          if (!isAutoTranslating) throw new Error('Dibatalkan oleh pengguna.');
        }

        if (isAutoTranslating && state.aiRpm > 0) {
          const waitMs = Math.round(60000 / state.aiRpm);
          btn.textContent = `Menunggu delay (${Math.round(waitMs/1000)}s)... (Klik untuk Stop)`;
          await delay(waitMs, () => !isAutoTranslating);
        }
      }
    }
  } catch (err: any) {
    if (isAutoTranslating) {
      void import('./notify').then(m => m.notifyStop(`Auto Translate berhenti: ${String(err?.message || err)}`, 'danger'));
      alert('Auto Translate berhenti karena error:\n\n' + err.message);
    }
  } finally {
    isAutoTranslating = false;
    btn.classList.remove('btn-danger');
    btn.classList.add('btn-success');
    btn.textContent = 'Jalankan Auto Translate';
  }
}

export interface ApiConfig {
  key: string;
  url: string;
  model: string;
}

export function parseBackupKeys(): ApiConfig[] {
  const configs: ApiConfig[] = [];
  // Primary key is always first
  if (state.aiApiKey) {
    configs.push({ key: state.aiApiKey, url: state.aiApiUrl, model: state.aiModel });
  }
  // Parse backup keys
  const lines = (state.aiBackupKeys || '').split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'));
  for (const line of lines) {
    const parts = line.split('|');
    if (parts.length === 1) {
      // Just a key — use primary url and model
      configs.push({ key: parts[0], url: state.aiApiUrl, model: state.aiModel });
    } else if (parts.length >= 3) {
      // key|url|model
      configs.push({ key: parts[0], url: parts[1], model: parts[2] });
    } else if (parts.length === 2) {
      // key|url — use primary model
      configs.push({ key: parts[0], url: parts[1], model: state.aiModel });
    }
  }
  return configs;
}

export function shouldTryNextKey(err: any): boolean {
  const msg = String(err?.message || '');
  return msg.includes('HTTP 429') || msg.includes('HTTP 5') || msg.includes('Failed to fetch') || msg.includes('NetworkError') || msg.includes('fetch');
}

export function shuffleArray<T>(arr: T[]): T[] {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

async function fetchOpenAIWithConfig(prompt: string, config: ApiConfig): Promise<string> {
  let url = config.url || 'https://api.openai.com/v1/chat/completions';
  if (!url.includes('/chat/completions')) {
    if (!url.endsWith('/')) url += '/';
    url += 'chat/completions';
  }

  const userContent = state.aiMergeSystemPrompt
    ? `[System instructions]\n${prompt}`
    : prompt;
  const body: any = {
    model: config.model,
    messages: [{ role: 'user', content: userContent }],
    stream: state.aiStreaming,
  };
  applyOpenAIOptions(body, config.model, config.url || '');

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.key}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`HTTP ${res.status}: ${errorText}`);
  }

  if (state.aiStreaming && res.body) {
    const result = await readAutoTranslateStream(res, (data) => {
      const choice = data.choices?.[0];
      return choice?.delta?.content || choice?.message?.content || '';
    });
    appendProjectLog(`OpenAI stream selesai (${config.model})`, result ? `Karakter: ${result.length}` : 'Tidak ada content pada stream');
    if (!result.trim()) throw new Error('Streaming selesai tetapi tidak menghasilkan delta.content. Coba matikan streaming.');
    return result;
  }

  appendProjectLog(`OpenAI request selesai (${config.model})`);

  const data = await res.json();
  const rawText = data.choices?.[0]?.message?.content || '';
  return state.aiFilterThinkingOutput ? stripThinkingTags(rawText) : rawText;
}

async function fetchAnthropicWithConfig(prompt: string, config: ApiConfig): Promise<string> {
  let url = (config.url || '').trim() || 'https://api.anthropic.com/v1/messages';
  // Accept base .../v1, .../v1/, or full .../messages
  if (!/\/messages\/?$/.test(url)) {
    url = url.replace(/\/chat\/completions\/?$/, '');
    url = url.replace(/\/$/, '') + '/messages';
  }

  const body: any = {
    model: config.model || 'claude-haiku-4-5-20251001',
    max_tokens: 8192,
    messages: [{ role: 'user', content: prompt }],
    stream: false,
  };
  body.stream = state.aiStreaming;
  applyAnthropicOptions(body);

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': config.key,
      'Authorization': `Bearer ${config.key}`,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`HTTP ${res.status}: ${errorText}`);
  }

  appendProjectLog(`Anthropic request selesai (${config.model})`);
  if (state.aiStreaming && res.body) {
    return readAutoTranslateStream(res, (data) => data.delta?.text || data.content_block?.text || '');
  }

  const data = await res.json();
  let rawText = '';
  if (Array.isArray(data.content)) {
    rawText = data.content
      .filter((p: any) => p && (p.type === 'text' || typeof p.text === 'string'))
      .map((p: any) => p.text || '')
      .join('');
  } else if (data.choices?.[0]?.message?.content) {
    // Some gateways wrap Anthropic in OpenAI shape
    rawText = data.choices[0].message.content;
  }
  return state.aiFilterThinkingOutput ? stripThinkingTags(rawText) : rawText;
}

async function fetchGeminiWithConfig(prompt: string, config: ApiConfig): Promise<string> {
  const model = config.model || 'gemini-1.5-flash';
  let url = (config.url || '').trim() || `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  url = url.replace(':generateContent', state.aiStreaming ? ':streamGenerateContent' : ':generateContent');
  url = appendQueryParams(url, { key: config.key }, false);
  if (state.aiStreaming) {
    url = appendQueryParams(url, { alt: 'sse' }, true);
  }

  const genConfig: any = {};
  applyGeminiOptions(genConfig, model);

  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: genConfig,
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`HTTP ${res.status}: ${errorText}`);
  }

  appendProjectLog(`Gemini request selesai (${model})`);
  if (state.aiStreaming && res.body) {
    return readAutoTranslateStream(res, (data) => data.candidates?.[0]?.content?.parts?.filter((p: any) => !p.thought).map((p: any) => p.text || '').join('') || '');
  }

  const data = await res.json();
  const parts: any[] = data.candidates?.[0]?.content?.parts || [];
  const rawText = parts
    .filter((p: any) => !p.thought)
    .map((p: any) => p.text || '')
    .join('')
    .trim();
  return state.aiFilterThinkingOutput ? stripThinkingTags(rawText) : rawText;
}

async function readAutoTranslateStream(res: Response, extractDelta: (data: any) => string): Promise<string> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let result = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split(/\r?\n\r?\n/);
      buffer = events.pop() || '';
      for (const event of events) {
        for (const line of event.split(/\r?\n/)) {
          const payload = line.replace(/^data:\s*/, '').trim();
          if (!payload || payload === '[DONE]') continue;
          try {
            const parsed = JSON.parse(payload);
            const delta = extractDelta(parsed);
            if (delta) {
              result += delta;
              updateStreamingLog(result);
            }
          } catch (err) {
            appendProjectLog('Chunk streaming tidak valid', payload.slice(0, 160));
          }
        }
      }
    }
    for (const line of buffer.split(/\r?\n/)) {
      const payload = line.replace(/^data:\s*/, '').trim();
      if (!payload || payload === '[DONE]') continue;
      try {
        const parsed = JSON.parse(payload);
        const delta = extractDelta(parsed);
        if (delta) result += delta;
      } catch (err) {
        appendProjectLog('Chunk streaming akhir tidak valid', payload.slice(0, 160));
      }
    }
    return state.aiFilterThinkingOutput ? stripThinkingTags(result) : result;
  } finally {
    finishStreamingLog();
  }
}

export async function fetchApiResult(prompt: string): Promise<string> {
  const configs = parseBackupKeys();
  if (configs.length === 0) {
    throw new Error('Tidak ada API key yang dikonfigurasi.');
  }

  let ordered = configs;
  if (state.aiKeyStrategy === 'random') {
    ordered = shuffleArray(configs);
  }

  let lastError: Error | null = null;
  for (let i = 0; i < ordered.length; i++) {
    const config = ordered[i];
    try {
      appendProjectLog(`Mengirim request AI via ${state.aiApiType}`, `Model: ${config.model}${state.aiStreaming ? ' | streaming' : ''}`);
      if (state.aiApiType === 'gemini') {
        return await fetchGeminiWithConfig(prompt, config);
      }
      if (state.aiApiType === 'anthropic') {
        return await fetchAnthropicWithConfig(prompt, config);
      }
      return await fetchOpenAIWithConfig(prompt, config);
    } catch (err: any) {
      lastError = err;
      appendProjectLog('Request AI gagal', err.message);
      // Only try next key on rate-limit, server, or network errors
      if (i < ordered.length - 1 && shouldTryNextKey(err)) {
        console.warn(`API key ${i + 1} failed (${err.message}), trying next key...`);
        continue;
      }
      throw err;
    }
  }
  throw lastError || new Error('Semua API key gagal.');
}

// ─── Strip Thinking Tags ──────────────────────────────────────────────────────
export function stripThinkingTags(text: string): string {
  return text
    .replace(/<\|think\|>[\s\S]*?<\/\|think\|>/gi, '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .trim();
}

let isAutoGlossary = false;
export async function onAutoGlossary(): Promise<void> {
  const btn = ui.btnAutoGlossaryAi as HTMLButtonElement;
  if (isAutoGlossary) {
    isAutoGlossary = false;
    void import('./notify').then(m => m.notifyStop('Auto Glossary dihentikan.', 'warn'));
    btn.textContent = 'Menghentikan...';
    btn.classList.remove('btn-danger');
    btn.classList.add('btn-success');
    return;
  }

  if (!state.aiApiKey) {
    alert('API Key belum diisi! Klik tombol robot di pojok kanan bawah untuk mengatur.');
    onOpenApiSettings();
    return;
  }

  const targetLines = getDisplayOrderedLines().filter(l => !l._glossary_extracted && !l._hidden && !isIlustrasiLine(l));
  if (targetLines.length === 0) {
    alert('Selesai! Semua baris telah diekstrak glossary-nya.');
    return;
  }

  isAutoGlossary = true;
  btn.classList.remove('btn-success');
  btn.classList.add('btn-danger');

  try {
    while (isAutoGlossary) {
      const untranslatedLines = getDisplayOrderedLines().filter(l => !l._glossary_extracted && !l._hidden && !isIlustrasiLine(l));
      if (untranslatedLines.length === 0) {
        void import('./notify').then(m => m.notifyStop('Auto Glossary selesai.', 'success'));
        alert('Selesai! Semua baris telah diekstrak glossary-nya.');
        break;
      }

      const batchSize = state.glossaryBatchSize || 100;
      const batchLines = untranslatedLines.slice(0, batchSize);

      state.selectedLines.clear();
      for (const l of batchLines) {
        state.selectedLines.add(l.line_num);
      }
      import('./render').then(m => m.syncCheckboxUI());
      import('./selection').then(m => m.scrollPreviewToLine(batchLines[0].line_num));

      btn.textContent = `Ekstrak Batch (${batchLines.length} baris)... (Klik Stop)`;

      const out = batchLines.map(l => {
        let namePart = '';
        if (l.name) namePart = l.trans_name ? `${l.trans_name}: ` : `${l.name}: `;
        return `${namePart}${l.trans_message || l.message}`;
      }).filter(Boolean);

      const { applyPromptVariables } = await import('./ai-format');
      const { buildExistingGlossaryHint } = await import('./glossary');
      const basePrompt = applyPromptVariables((state.glossaryPrompt || DEFAULT_GLOSSARY_PROMPT).trim());
      const existingHint = buildExistingGlossaryHint(out.join('\n'));
      const prompt = `${basePrompt}${existingHint}\n\n${out.join('\n')}\n`;

      let rawResult = await fetchWithRetry(() => fetchApiResult(prompt), (retry) => {
        btn.textContent = `${formatRetryLabel(retry)}... (Klik Stop)`;
      }, () => !isAutoGlossary);

      if (!rawResult || !rawResult.trim()) {
        throw new Error('Respons dari API kosong.');
      }

      (ui.pasteGlossaryArea as HTMLTextAreaElement).value = rawResult;
      onSaveGlossary();

      for (const l of batchLines) l._glossary_extracted = true;

      if (isAutoGlossary && state.aiRpm > 0) {
        const waitMs = Math.round(60000 / state.aiRpm);
        btn.textContent = `Menunggu delay (${Math.round(waitMs/1000)}s)... (Klik untuk Stop)`;
        await delay(waitMs, () => !isAutoGlossary);
      }
    }
  } catch (err: any) {
    if (isAutoGlossary) {
      void import('./notify').then(m => m.notifyStop(`Auto Glossary berhenti: ${String(err?.message || err)}`, 'danger'));
      alert('Auto Ekstrak berhenti karena error:\n\n' + err.message);
    }
  } finally {
    isAutoGlossary = false;
    btn.classList.remove('btn-danger');
    btn.classList.add('btn-success');
    btn.textContent = 'Jalankan Auto Ekstrak';
  }
}

let isAutoAiCheck = false;
let autoAiCheckStats = { totalChecked: 0, totalCorrections: 0, totalApplied: 0, byCategory: new Map<string, number>() };
export async function onAutoAiCheck(): Promise<void> {
  const btn = ui.btnAutoAiCheck as HTMLButtonElement;
  if (isAutoAiCheck) {
    isAutoAiCheck = false;
    resolveReviewAction('stop');
    void import('./notify').then(m => m.notifyStop('Auto AI Check dihentikan.', 'warn'));
    btn.textContent = 'Menghentikan...';
    btn.classList.remove('btn-danger');
    btn.classList.add('btn-success');
    return;
  }

  if (!state.aiApiKey) {
    alert('API Key belum diisi! Klik tombol robot di pojok kanan bawah untuk mengatur.');
    onOpenApiSettings();
    return;
  }

  // Skip confirmed lines and QC-flagged lines (if QC results exist)
  const targetLines = getDisplayOrderedLines().filter(l => isTranslated(l) && !l._ai_checked && !l._ai_confirmed && !l._hidden);
  if (targetLines.length === 0) {
    alert('Selesai! Semua baris terjemahan telah di-cek AI.');
    return;
  }

  // Check if review mode is enabled
  const reviewMode = (document.getElementById('settingsAiCheckReviewMode') as HTMLInputElement)?.checked ?? false;

  isAutoAiCheck = true;
  btn.classList.remove('btn-success');
  btn.classList.add('btn-danger');
  autoAiCheckStats = { totalChecked: 0, totalCorrections: 0, totalApplied: 0, byCategory: new Map<string, number>() };

  try {
    while (isAutoAiCheck) {
      const uncheckedLines = getDisplayOrderedLines().filter(l => isTranslated(l) && !l._ai_checked && !l._ai_confirmed && !l._hidden);
      if (uncheckedLines.length === 0) {
        // Show summary
        void import('./notify').then(m => m.notifyStop('Auto AI Check selesai.', 'success'));
        const catSummary = Array.from(autoAiCheckStats.byCategory.entries()).map(([k, v]) => `${k}: ${v}`).join(', ');
        alert(`Selesai! AI Check selesai.\n\nTotal dicek: ${autoAiCheckStats.totalChecked}\nKoreksi ditemukan: ${autoAiCheckStats.totalCorrections}\nKoreksi diterapkan: ${autoAiCheckStats.totalApplied}${catSummary ? `\n\nKategori: ${catSummary}` : ''}`);
        break;
      }

      const batchSize = state.aiCheckBatchSize || 100;
      const batchLines = uncheckedLines.slice(0, batchSize);

      state.selectedLines.clear();
      for (const l of batchLines) {
        state.selectedLines.add(l.line_num);
      }
      import('./render').then(m => m.syncCheckboxUI());
      import('./selection').then(m => m.scrollPreviewToLine(batchLines[0].line_num));

      btn.textContent = `Cek Batch (${batchLines.length} baris)... (Klik Stop)`;

      // Build prompt with context (once at start) + glossary + lines
      const { buildAiCheckPrompt } = await import('./ai-check');
      const prompt = buildAiCheckPrompt(batchLines);

      let rawResult = await fetchWithRetry(() => fetchApiResult(prompt), (retry) => {
        btn.textContent = `${formatRetryLabel(retry)}... (Klik Stop)`;
      }, () => !isAutoAiCheck);

      if (!rawResult || !rawResult.trim()) {
        throw new Error('Respons dari API kosong.');
      }

      (ui.pasteAiCheckArea as HTMLTextAreaElement).value = rawResult;

      const { onParseAiCheck, onApplyAiCheckCorrections, renderAiCheckCorrections } = await import('./ai-check');
      if (!onParseAiCheck(new Set(batchLines.map(l => l.line_num)))) {
        // A rejected/malformed response must not advance this batch as checked.
        isAutoAiCheck = false;
        break;
      }
      autoAiCheckStats.totalCorrections += state.aiCheckCorrections.length;
      // One undo must cover both corrections and the checked flags, including
      // batches with no corrections or batches skipped in review mode.
      const { pushUndoSnapshot } = await import('./render');
      pushUndoSnapshot();

      if (!isAutoAiCheck) break;

      if (reviewMode && state.aiCheckCorrections.length > 0) {
        // Pause for review — show corrections, wait for user to apply or skip
        renderAiCheckCorrections();
        btn.textContent = `Review ${state.aiCheckCorrections.length} koreksi... (Klik Stop untuk batalkan)`;
        btn.classList.remove('btn-danger');
        btn.classList.add('btn-success');

        // Wait for user action (apply or skip)
        const reviewResult = await waitForReviewAction();
        if (reviewResult === 'stop') {
          isAutoAiCheck = false;
          break;
        }
        if (reviewResult === 'apply') {
          const { applied, categories } = onApplyAiCheckCorrections(false);
          autoAiCheckStats.totalApplied += applied;
          for (const [cat, count] of categories) {
            autoAiCheckStats.byCategory.set(cat, (autoAiCheckStats.byCategory.get(cat) || 0) + count);
          }
        }
        btn.classList.remove('btn-success');
        btn.classList.add('btn-danger');
      } else {
        // Auto-apply (original behavior)
        const { applied, categories } = onApplyAiCheckCorrections(false);
        autoAiCheckStats.totalApplied += applied;
        for (const [cat, count] of categories) {
          autoAiCheckStats.byCategory.set(cat, (autoAiCheckStats.byCategory.get(cat) || 0) + count);
        }
      }

      for (const l of batchLines) l._ai_checked = true;
      autoAiCheckStats.totalChecked += batchLines.length;

      if (isAutoAiCheck && state.aiRpm > 0) {
        const waitMs = Math.round(60000 / state.aiRpm);
        btn.textContent = `Menunggu delay (${Math.round(waitMs/1000)}s)... (Klik untuk Stop)`;
        await delay(waitMs, () => !isAutoAiCheck);
      }
    }
    if (isAutoAiCheck) {
      void import('./notify').then(m => m.notifyStop('Auto AI Check selesai.', 'success'));
      const catSummary = Array.from(autoAiCheckStats.byCategory.entries()).map(([k, v]) => `${k}: ${v}`).join(', ');
      alert(`AI Check selesai.\n\nTotal dicek: ${autoAiCheckStats.totalChecked}\nKoreksi ditemukan: ${autoAiCheckStats.totalCorrections}\nKoreksi diterapkan: ${autoAiCheckStats.totalApplied}${catSummary ? `\n\nKategori: ${catSummary}` : ''}`);
    }
    isAutoAiCheck = false;
    btn.classList.remove('btn-danger');
    btn.classList.add('btn-success');
    btn.textContent = 'Jalankan Auto Cek';
  } catch (err: any) {
    if (isAutoAiCheck) {
      void import('./notify').then(m => m.notifyStop(`Auto AI Check berhenti: ${String(err?.message || err)}`, 'danger'));
      alert('Auto Cek berhenti karena error:\n\n' + err.message);
    }
  } finally {
    isAutoAiCheck = false;
    btn.classList.remove('btn-danger');
    btn.classList.add('btn-success');
    btn.textContent = 'Jalankan Auto Cek';
  }
}

// ─── Review mode helpers ───────────────────────────────────────────────────────

let reviewResolve: ((value: string) => void) | null = null;

function waitForReviewAction(): Promise<string> {
  return new Promise((resolve) => {
    reviewResolve = resolve;
    // Auto-resolve after 5 minutes (timeout safety)
    setTimeout(() => {
      if (reviewResolve === resolve) {
        reviewResolve = null;
        resolve('skip');
      }
    }, 300000);
  });
}

export function resolveReviewAction(action: 'apply' | 'skip' | 'stop'): void {
  if (reviewResolve) {
    const r = reviewResolve;
    reviewResolve = null;
    r(action);
  }
}
async function fetchWithRetry(runAttempt: () => Promise<string>, onRetry: (retry: RetryState) => void, shouldCancel?: () => boolean): Promise<string> {
  let attempt = 0;
  const maxRetries = 5;
  while (attempt < maxRetries) {
    if (shouldCancel?.()) throw new Error('Dibatalkan oleh pengguna.');
    try {
      return await runAttempt();
    } catch (err: any) {
      if (err?.retryable) {
        attempt++;
        if (attempt >= maxRetries) {
          throw new Error(`Gagal setelah ${maxRetries} percobaan karena format respons AI terus tidak cocok. ${String(err?.message || err || '')}`.trim());
        }
        onRetry({ attempt, maxRetries, waitMs: 2000, reason: 'format respons AI tidak cocok' });
        await delay(2000, shouldCancel);
        continue;
      }

      throw err;
    }
  }
  return '';
}
