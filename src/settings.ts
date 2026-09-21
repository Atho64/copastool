// @module settings.ts — Unified Settings modal: open, save, and reset all project settings with tabbed UI

import { state, ui } from './state';
import {
  DEFAULT_PROMPT_HEADER_NUMBERED, DEFAULT_PROMPT_HEADER_BLOCK,
  DEFAULT_PROMPT_HEADER_XML, DEFAULT_PROMPT_HEADER_JSONL, DEFAULT_PROMPT_HEADER_JSON_ARRAY,
  DEFAULT_AI_TRANSLATION_FORMAT,
  DEFAULT_GLOSSARY_PROMPT, DEFAULT_AI_CHECK_PROMPT,
  DEFAULT_SELECTION_BATCH_SIZE, DEFAULT_GLOSSARY_BATCH_SIZE, DEFAULT_AI_CHECK_BATCH_SIZE,
  DEFAULT_AGENT_PROMPT,
  DEFAULT_SUMMARY_PROMPT,
  DEFAULT_AI_CHECK_SUMMARY_PROMPT,
  DEFAULT_LUCA_MC_DISPLAY_NAME,
} from './constants';
import { getDefaultPromptHeaderForFormat, normalizeAiTranslationFormat } from './ai-format';
import { normalizeSelectionBatchSize } from './selection';
import { refreshAll, compileRegexFilter } from './render';
import { renderGlossaryPreview } from './glossary';
import { queueAutoSave, openModal, closeModal } from './project';
import { applyHtlMode } from './htl-mode';
import { prefillIncrement } from './increment';
import { getActiveLucaProfile, populateLucaExportSlotSelect, DEFAULT_LUCA_PROFILE } from './luca-engine';
import { Shortcuts } from './shortcuts';

export type SettingsTabName = 'general' | 'prompts' | 'glossary' | 'shortcuts' | 'plugins';

export function switchSettingsTab(tabName: SettingsTabName): void {
  const tabs: Record<SettingsTabName, { btnId: string; paneId: string }> = {
    general: { btnId: 'btnTabSettingsGeneral', paneId: 'settingsTabGeneral' },
    prompts: { btnId: 'btnTabSettingsPrompts', paneId: 'settingsTabPrompts' },
    glossary: { btnId: 'btnTabSettingsGlossary', paneId: 'settingsTabGlossary' },
    shortcuts: { btnId: 'btnTabSettingsShortcuts', paneId: 'settingsTabShortcuts' },
    plugins: { btnId: 'btnTabSettingsPlugins', paneId: 'settingsTabPlugins' }
  };

  for (const [k, v] of Object.entries(tabs)) {
    const isTarget = k === tabName;
    const btn = document.getElementById(v.btnId);
    const pane = document.getElementById(v.paneId);
    if (btn) {
      btn.className = isTarget ? 'btn btn-primary btn-sm grow is-active' : 'btn btn-outline btn-sm grow';
      btn.setAttribute('aria-selected', isTarget ? 'true' : 'false');
    }
    if (pane) {
      pane.style.display = isTarget ? 'block' : 'none';
    }
  }

  if (tabName === 'shortcuts') {
    Shortcuts.renderList();
  }
}

export function initSettingsTabs(): void {
  document.getElementById('btnTabSettingsGeneral')?.addEventListener('click', () => switchSettingsTab('general'));
  document.getElementById('btnTabSettingsPrompts')?.addEventListener('click', () => switchSettingsTab('prompts'));
  document.getElementById('btnTabSettingsGlossary')?.addEventListener('click', () => switchSettingsTab('glossary'));
  document.getElementById('btnTabSettingsShortcuts')?.addEventListener('click', () => switchSettingsTab('shortcuts'));
  document.getElementById('btnTabSettingsPlugins')?.addEventListener('click', () => switchSettingsTab('plugins'));

  document.getElementById('btnOpenPluginManagerFromSettings')?.addEventListener('click', () => {
    closeModal(ui.settingsModal as HTMLElement);
    (window as any).CSTL?.plugins?.openPluginManager?.();
  });
  document.getElementById('btnOpenPluginManagerFromDashboardSettings')?.addEventListener('click', () => {
    const dModal = document.getElementById('dashboardSettingsModal');
    if (dModal) closeModal(dModal);
    (window as any).CSTL?.plugins?.openPluginManager?.();
  });

  // Luca profile change updates slot options
  document.getElementById('settingsLucaProfileSelect')?.addEventListener('change', (e) => {
    const profileId = (e.target as HTMLSelectElement).value;
    populateLucaExportSlotSelect(profileId);
    const active = getActiveLucaProfile();
    const wrapMc = document.getElementById('settingsLucaMcWrap');
    if (wrapMc) wrapMc.style.display = active.nameAtFormat ? 'block' : 'none';
  });
}

/** Isi dropdown profil/slot/MC dari state untuk LucaSystem (jika container ada di UI) */
export function populateLucaSettingsUI(): void {
  const wrap = document.getElementById('settingsLucaWrap');
  if (!wrap) return;
  const showLuca = state.projectType !== 'epub';
  wrap.style.display = showLuca ? '' : 'none';
  if (!showLuca) return;
  const selProfile = document.getElementById('settingsLucaProfileSelect') as HTMLSelectElement | null;
  if (selProfile) {
    selProfile.value = state.lucaProfile || DEFAULT_LUCA_PROFILE;
    selProfile.disabled = state.lines.length > 0;
  }
  const active = getActiveLucaProfile();
  const wrapMc = document.getElementById('settingsLucaMcWrap');
  if (wrapMc) wrapMc.style.display = active.nameAtFormat ? 'block' : 'none';
  const inputMc = document.getElementById('settingsLucaMcDisplayNameInput') as HTMLInputElement | null;
  if (inputMc) {
    inputMc.value = state.lucaMcDisplayName || '';
  }
  const wrapLang = document.getElementById('settingsLucaExportLangWrap');
  if (wrapLang) wrapLang.style.display = 'flex';
  const selLang = document.getElementById('settingsLucaExportLangSelect') as HTMLSelectElement | null;
  if (selLang) {
    const profileId = selProfile?.value || state.lucaProfile || DEFAULT_LUCA_PROFILE;
    populateLucaExportSlotSelect(profileId);
    const saved = state.lucaExportLang || 'en';
    const options = active.exportSlotOptions || [];
    selLang.value = options.some((o: any) => o.value === saved) ? saved : selLang.value;
  }
}

/** Simpan nilai Luca dari UI ke state (jika container ada di UI) */
export function saveLucaSettingsFromUI(): void {
  const wrap = document.getElementById('settingsLucaWrap');
  if (!wrap || wrap.style.display === 'none') return;
  const selLang = document.getElementById('settingsLucaExportLangSelect') as HTMLSelectElement | null;
  if (selLang) {
    state.lucaExportLang = selLang.value || state.lucaExportLang || 'en';
  }
  const inputMc = document.getElementById('settingsLucaMcDisplayNameInput') as HTMLInputElement | null;
  if (inputMc) {
    state.lucaMcDisplayName = inputMc.value.trim() || DEFAULT_LUCA_MC_DISPLAY_NAME;
  }
  const selProfile = document.getElementById('settingsLucaProfileSelect') as HTMLSelectElement | null;
  if (selProfile && state.lines.length === 0) {
    state.lucaProfile = selProfile.value || DEFAULT_LUCA_PROFILE;
  }
}

export function onOpenSettings(tabName: SettingsTabName = 'general'): void {
  // === 1. General Settings ===
  if (ui.settingsSourceLangSelect) (ui.settingsSourceLangSelect as HTMLSelectElement).value = state.sourceLang || 'Japanese';
  if (ui.settingsTargetLangSelect) (ui.settingsTargetLangSelect as HTMLSelectElement).value = state.targetLang || 'Indonesian';
  if (ui.settingsTranslationModeSelect) {
    (ui.settingsTranslationModeSelect as HTMLSelectElement).value = state.translationMode || 'ai';
  }
  if (ui.settingsRegexFilterInput) (ui.settingsRegexFilterInput as HTMLInputElement).value = state.regexFilter || '';
  if (ui.settingsRegexFilterCaseCheck) {
    (ui.settingsRegexFilterCaseCheck as HTMLInputElement).checked = !!state.regexFilterCase;
  }
  const isJson = state.projectType === 'json';
  if (ui.settingsRefLangWrap) {
    (ui.settingsRefLangWrap as HTMLElement).style.display = isJson ? 'block' : 'none';
  }
  if (isJson) {
    const hasRef1 = state.lines.some(l => l.ref_lang_1 != null);
    const hasRef2 = state.lines.some(l => l.ref_lang_2 != null);
    if (ui.settingsRefLang1Select) {
      (ui.settingsRefLang1Select as HTMLInputElement).value = hasRef1 ? `Ada (${state.lines.filter(l => l.ref_lang_1 != null).length} baris)` : '';
    }
    if (ui.settingsRefLang2Select) {
      (ui.settingsRefLang2Select as HTMLInputElement).value = hasRef2 ? `Ada (${state.lines.filter(l => l.ref_lang_2 != null).length} baris)` : '';
    }
    if (ui.btnImportRefLang1) (ui.btnImportRefLang1 as HTMLButtonElement).disabled = !state.currentProjectId;
    if (ui.btnImportRefLang2) (ui.btnImportRefLang2 as HTMLButtonElement).disabled = !state.currentProjectId;
    if (ui.btnImportRefLang1Folder) (ui.btnImportRefLang1Folder as HTMLButtonElement).disabled = !state.currentProjectId;
    if (ui.btnImportRefLang2Folder) (ui.btnImportRefLang2Folder as HTMLButtonElement).disabled = !state.currentProjectId;
    if (ui.btnClearRefLang1) (ui.btnClearRefLang1 as HTMLButtonElement).disabled = !hasRef1;
    if (ui.btnClearRefLang2) (ui.btnClearRefLang2 as HTMLButtonElement).disabled = !hasRef2;
  }
  if (ui.settingsDisableEmptyLineValidation) (ui.settingsDisableEmptyLineValidation as HTMLInputElement).checked = !!state.disableEmptyLineValidation;
  if (ui.settingsShowFurigana) (ui.settingsShowFurigana as HTMLInputElement).checked = !!state.showFurigana;
  if (ui.settingsFuriganaType) (ui.settingsFuriganaType as HTMLSelectElement).value = state.furiganaType || 'hiragana';
  if (ui.settingsFontSize) (ui.settingsFontSize as HTMLInputElement).value = String(state.fontSize || 14);
  if (ui.settingsEnableDictionary) (ui.settingsEnableDictionary as HTMLInputElement).checked = !!state.enableDictionary;
  if (ui.settingsDictionaryEngine) (ui.settingsDictionaryEngine as HTMLSelectElement).value = state.dictionaryEngine || 'llm';
  if (ui.settingsDictionaryPrompt) (ui.settingsDictionaryPrompt as HTMLTextAreaElement).value = state.dictionaryPrompt || 'Jelaskan arti kata "{word}" dalam konteks kalimat "{context}". Berikan bentuk dasar, cara baca (hiragana/romaji), kelas kata, dan terjemahan/penjelasan singkat dalam bahasa Indonesia.';
  if (ui.settingsCheckKanaResidue) (ui.settingsCheckKanaResidue as HTMLInputElement).checked = !!state.checkKanaResidue;
  if (ui.settingsCheckSimilarity) {
    (ui.settingsCheckSimilarity as HTMLInputElement).checked = !!state.checkSimilarity;
    if (ui.settingsSimilarityThreshold) (ui.settingsSimilarityThreshold as HTMLInputElement).value = String(Math.round((state.similarityThreshold || 0.7) * 100));
    if (ui.settingsSimilarityThresholdWrap) (ui.settingsSimilarityThresholdWrap as HTMLElement).style.display = state.checkSimilarity ? 'flex' : 'none';
  }
  if (ui.settingsCheckLengthRatio) {
    (ui.settingsCheckLengthRatio as HTMLInputElement).checked = !!state.checkLengthRatio;
    if (ui.settingsLengthRatioThreshold) (ui.settingsLengthRatioThreshold as HTMLInputElement).value = String(state.lengthRatioThreshold || 2.5);
    const wrap = document.getElementById('settingsLengthRatioWrap');
    if (wrap) wrap.style.display = state.checkLengthRatio ? 'flex' : 'none';
  }
  if (ui.settingsCheckLinebreak) (ui.settingsCheckLinebreak as HTMLInputElement).checked = state.checkLinebreak !== false;
  if (ui.settingsCheckLanguage) (ui.settingsCheckLanguage as HTMLInputElement).checked = state.checkLanguage !== false;
  if (ui.settingsCheckPunctuation) (ui.settingsCheckPunctuation as HTMLInputElement).checked = state.checkPunctuation !== false;
  if (ui.settingsCheckUntransName) (ui.settingsCheckUntransName as HTMLInputElement).checked = !!state.checkUntransName;
  if (ui.settingsIgnorePasteNames) (ui.settingsIgnorePasteNames as HTMLInputElement).checked = !!state.ignorePasteNames;
  if (ui.settingsEnableUncertainMarking) (ui.settingsEnableUncertainMarking as HTMLInputElement).checked = !!state.enableUncertainMarking;
  if (ui.settingsSafeTagsForChatgpt) (ui.settingsSafeTagsForChatgpt as HTMLInputElement).checked = !!state.safeTagsForChatgpt;
  if (ui.settingsAgentMaxTurns) (ui.settingsAgentMaxTurns as HTMLInputElement).value = String(state.agentMaxTurns || 10);
  if (ui.settingsAiTranslationFormatSelect) {
    (ui.settingsAiTranslationFormatSelect as HTMLSelectElement).value = normalizeAiTranslationFormat(state.aiTranslationFormat);
  }
  if (ui.settingsContextLinesInput) (ui.settingsContextLinesInput as HTMLInputElement).value = String(state.contextLines);
  if (ui.settingsContextTypeSelect) {
    (ui.settingsContextTypeSelect as HTMLSelectElement).value = state.contextType || 'raw';
  }
  if (ui.settingsSelectionBatchSizeInput) (ui.settingsSelectionBatchSizeInput as HTMLInputElement).value = String(state.selectionBatchSize);
  if (ui.settingsGlossaryBatchSizeInput) (ui.settingsGlossaryBatchSizeInput as HTMLInputElement).value = String(state.glossaryBatchSize);
  if (ui.settingsAiCheckBatchSizeInput) (ui.settingsAiCheckBatchSizeInput as HTMLInputElement).value = String(state.aiCheckBatchSize);
  if (ui.settingsParallelBatchSizeInput) (ui.settingsParallelBatchSizeInput as HTMLInputElement).value = String(state.parallelBatchSize ?? 1);
  if (ui.settingsSubagentWorkersInput) (ui.settingsSubagentWorkersInput as HTMLInputElement).value = String(state.subagentWorkers ?? 3);

  const incCheck = document.getElementById('settingsIncrementCheck') as HTMLInputElement | null;
  if (incCheck) incCheck.checked = !!state.incrementEnabled;

  if (ui.settingsEpubTagsInput) (ui.settingsEpubTagsInput as HTMLInputElement).value = state.epubTags || 'p';
  const showEpubCheckbox = (document.getElementById('settingsShowEpubImages') || ui.settingsShowEpubImages) as HTMLInputElement | null;
  if (showEpubCheckbox) showEpubCheckbox.checked = state.showEpubImages !== false;

  // === 2. LucaSystem Settings ===
  populateLucaSettingsUI();

  // === 3. Prompt Settings ===
  if (ui.settingsEnableBackgroundChaining) {
    (ui.settingsEnableBackgroundChaining as HTMLInputElement).checked = !!state.enableBackgroundChaining;
  }
  if (ui.settingsBackgroundInput) {
    (ui.settingsBackgroundInput as HTMLTextAreaElement).value = state.currentBackground || '';
  }
  if (ui.settingsSummaryPromptInput) {
    (ui.settingsSummaryPromptInput as HTMLTextAreaElement).value = state.summaryPrompt !== undefined && state.summaryPrompt !== ''
      ? state.summaryPrompt
      : DEFAULT_SUMMARY_PROMPT;
  }

  if (state.projectName) {
    if (ui.settingsPromptInput) (ui.settingsPromptInput as HTMLTextAreaElement).value = state.aiInstructionHeader;
    if (ui.settingsGlossaryPromptInput) (ui.settingsGlossaryPromptInput as HTMLTextAreaElement).value = state.glossaryPrompt;
    if (ui.settingsAiCheckPromptInput) (ui.settingsAiCheckPromptInput as HTMLTextAreaElement).value = state.aiCheckPrompt;
    if (ui.settingsAgentPromptInput) (ui.settingsAgentPromptInput as HTMLTextAreaElement).value = state.agentPrompt;
  } else {
    const format = (ui.settingsAiTranslationFormatSelect as HTMLSelectElement)?.value || DEFAULT_AI_TRANSLATION_FORMAT;
    if (ui.settingsPromptInput) (ui.settingsPromptInput as HTMLTextAreaElement).value = getDefaultPromptHeaderForFormat(format);
    if (ui.settingsGlossaryPromptInput) (ui.settingsGlossaryPromptInput as HTMLTextAreaElement).value = DEFAULT_GLOSSARY_PROMPT;
    if (ui.settingsAiCheckPromptInput) (ui.settingsAiCheckPromptInput as HTMLTextAreaElement).value = DEFAULT_AI_CHECK_PROMPT;
    if (ui.settingsAgentPromptInput) (ui.settingsAgentPromptInput as HTMLTextAreaElement).value = DEFAULT_AGENT_PROMPT;
  }

  const aiChkChainEl = document.getElementById('settingsEnableAiCheckChaining') as HTMLInputElement | null;
  if (aiChkChainEl) aiChkChainEl.checked = state.enableAiCheckChaining !== false;
  const aiChkStoryEl = document.getElementById('settingsEnableAiCheckStoryContext') as HTMLInputElement | null;
  if (aiChkStoryEl) aiChkStoryEl.checked = state.enableAiCheckStoryContext !== false;
  const aiChkMemEl = document.getElementById('settingsEnableAiCheckAgentMemory') as HTMLInputElement | null;
  if (aiChkMemEl) aiChkMemEl.checked = state.enableAiCheckAgentMemory !== false;
  const aiChkLocEl = document.getElementById('settingsAiCheckLocalizationNotes') as HTMLTextAreaElement | null;
  if (aiChkLocEl) aiChkLocEl.value = state.aiCheckLocalizationNotes || '';
  const aiChkStoryCtxEl = document.getElementById('settingsAiCheckStoryContextInput') as HTMLTextAreaElement | null;
  if (aiChkStoryCtxEl) aiChkStoryCtxEl.value = state.aiCheckStoryContext || '';
  const aiChkRevEl = document.getElementById('settingsAiCheckRevisionsInput') as HTMLTextAreaElement | null;
  if (aiChkRevEl) aiChkRevEl.value = state.aiCheckRevisionsSummary || '';
  const aiChkSumPromptEl = document.getElementById('settingsAiCheckSummaryPromptInput') as HTMLTextAreaElement | null;
  if (aiChkSumPromptEl) {
    aiChkSumPromptEl.value = state.aiCheckSummaryPrompt !== undefined && state.aiCheckSummaryPrompt !== ''
      ? state.aiCheckSummaryPrompt
      : DEFAULT_AI_CHECK_SUMMARY_PROMPT;
  }

  // === 4. Glossary Settings ===
  if (ui.settingsGlossaryInput) {
    (ui.settingsGlossaryInput as HTMLTextAreaElement).value = state.glossaryText || '';
  }

  // === 5. Switch Tab & Show ===
  switchSettingsTab(tabName);
  openModal(ui.settingsModal as HTMLElement);
}

export function onOpenPromptsSettings(): void {
  onOpenSettings('prompts');
}

export function onOpenGlossarySettings(): void {
  onOpenSettings('glossary');
}

export function onSavePromptSettings(): void {
  // === General Settings ===
  const sourceLang = (ui.settingsSourceLangSelect as HTMLSelectElement)?.value || 'Japanese';
  const targetLang = (ui.settingsTargetLangSelect as HTMLSelectElement)?.value || 'Indonesian';
  const translationMode = (ui.settingsTranslationModeSelect as HTMLSelectElement)?.value === 'htl' ? 'htl' : 'ai';
  const regexFilter = (ui.settingsRegexFilterInput as HTMLInputElement)?.value || '';
  const regexFilterCase = !!((ui.settingsRegexFilterCaseCheck as HTMLInputElement)?.checked);
  const disableEmptyLineValidation = !!((ui.settingsDisableEmptyLineValidation as HTMLInputElement)?.checked);
  const showFurigana = !!((ui.settingsShowFurigana as HTMLInputElement)?.checked);
  const fontSize = parseInt((ui.settingsFontSize as HTMLInputElement)?.value) || 14;
  const enableDictionary = !!((ui.settingsEnableDictionary as HTMLInputElement)?.checked);
  const dictionaryEngine = (ui.settingsDictionaryEngine as HTMLSelectElement)?.value === 'jisho' ? 'jisho' : 'llm';
  const dictionaryPrompt = (ui.settingsDictionaryPrompt as HTMLTextAreaElement)?.value || 'Jelaskan arti kata "{word}" dalam konteks kalimat "{context}". Berikan bentuk dasar, cara baca (hiragana/romaji), kelas kata, dan terjemahan/penjelasan singkat dalam bahasa Indonesia.';
  const checkKanaResidue = !!((ui.settingsCheckKanaResidue as HTMLInputElement)?.checked);
  const checkSimilarity = !!((ui.settingsCheckSimilarity as HTMLInputElement)?.checked);
  const simThresholdRaw = parseInt((ui.settingsSimilarityThreshold as HTMLInputElement)?.value);
  const similarityThreshold = (!isNaN(simThresholdRaw) && simThresholdRaw >= 1 && simThresholdRaw <= 99)
    ? simThresholdRaw / 100 : 0.7;

  if (regexFilter) {
    try {
      compileRegexFilter(regexFilter, regexFilterCase);
    } catch (err: any) {
      return alert('Regex Filter tidak valid: ' + err.message);
    }
  }

  const aiTranslationFormat = normalizeAiTranslationFormat((ui.settingsAiTranslationFormatSelect as HTMLSelectElement)?.value);
  const contextLines = parseInt((ui.settingsContextLinesInput as HTMLInputElement)?.value) || 0;
  const contextType = ui.settingsContextTypeSelect ? (ui.settingsContextTypeSelect as HTMLSelectElement).value : 'raw';
  const selectionBatchSize = normalizeSelectionBatchSize((ui.settingsSelectionBatchSizeInput as HTMLInputElement)?.value);
  const glossaryBatchSize = normalizeSelectionBatchSize((ui.settingsGlossaryBatchSizeInput as HTMLInputElement)?.value, DEFAULT_GLOSSARY_BATCH_SIZE);
  const aiCheckBatchSize = normalizeSelectionBatchSize((ui.settingsAiCheckBatchSizeInput as HTMLInputElement)?.value, DEFAULT_AI_CHECK_BATCH_SIZE);
  const parallelBatchSize = Math.max(1, Math.min(10, parseInt((ui.settingsParallelBatchSizeInput as HTMLInputElement)?.value) || 1));

  const oldShowEpubImages = state.showEpubImages;
  const showEpubCheckbox = (document.getElementById('settingsShowEpubImages') || ui.settingsShowEpubImages) as HTMLInputElement | null;
  if (showEpubCheckbox) {
    state.showEpubImages = showEpubCheckbox.checked;
  }

  state.sourceLang = sourceLang;
  state.targetLang = targetLang;
  state.translationMode = translationMode as any;
  state.regexFilter = regexFilter;
  state.regexFilterCase = regexFilterCase;
  state.disableEmptyLineValidation = disableEmptyLineValidation;
  state.showFurigana = showFurigana;
  state.furiganaType = ((ui.settingsFuriganaType as HTMLSelectElement)?.value as any) || 'furigana';
  state.fontSize = fontSize;
  document.documentElement.style.setProperty('--content-font-size', state.fontSize + 'px');
  state.enableDictionary = enableDictionary;
  state.dictionaryEngine = dictionaryEngine;
  state.dictionaryPrompt = dictionaryPrompt;
  state.checkKanaResidue = checkKanaResidue;
  state.checkSimilarity = checkSimilarity;
  state.similarityThreshold = similarityThreshold;
  state.checkLengthRatio = !!((ui.settingsCheckLengthRatio as HTMLInputElement)?.checked);
  const lrRaw = parseFloat((ui.settingsLengthRatioThreshold as HTMLInputElement)?.value);
  state.lengthRatioThreshold = (!isNaN(lrRaw) && lrRaw >= 1 && lrRaw <= 10) ? lrRaw : 2.5;
  state.checkLinebreak = (ui.settingsCheckLinebreak as HTMLInputElement)?.checked !== false;
  state.checkLanguage = (ui.settingsCheckLanguage as HTMLInputElement)?.checked !== false;
  state.checkPunctuation = (ui.settingsCheckPunctuation as HTMLInputElement)?.checked !== false;
  state.checkUntransName = !!((ui.settingsCheckUntransName as HTMLInputElement)?.checked);
  state.ignorePasteNames = !!((ui.settingsIgnorePasteNames as HTMLInputElement)?.checked);
  state.enableUncertainMarking = !!((ui.settingsEnableUncertainMarking as HTMLInputElement)?.checked);
  state.safeTagsForChatgpt = !!((ui.settingsSafeTagsForChatgpt as HTMLInputElement)?.checked);
  const amtRaw = parseInt((ui.settingsAgentMaxTurns as HTMLInputElement)?.value);
  state.agentMaxTurns = (!isNaN(amtRaw) && amtRaw >= 3 && amtRaw <= 30) ? amtRaw : 10;
  state.aiTranslationFormat = aiTranslationFormat;
  state.contextLines = contextLines;
  state.contextType = contextType as any;
  state.selectionBatchSize = selectionBatchSize;
  state.glossaryBatchSize = glossaryBatchSize;
  state.aiCheckBatchSize = aiCheckBatchSize;
  state.parallelBatchSize = parallelBatchSize;
  state.subagentWorkers = Math.max(1, Math.min(10, parseInt((ui.settingsSubagentWorkersInput as HTMLInputElement)?.value) || 3));

  const prevInc = state.incrementEnabled;
  const incCheck = document.getElementById('settingsIncrementCheck') as HTMLInputElement | null;
  if (incCheck) state.incrementEnabled = incCheck.checked;

  if (ui.settingsSelectionBatchSizeInput) (ui.settingsSelectionBatchSizeInput as HTMLInputElement).value = String(selectionBatchSize);
  if (ui.settingsGlossaryBatchSizeInput) (ui.settingsGlossaryBatchSizeInput as HTMLInputElement).value = String(glossaryBatchSize);
  if (ui.settingsAiCheckBatchSizeInput) (ui.settingsAiCheckBatchSizeInput as HTMLInputElement).value = String(aiCheckBatchSize);

  // === Luca Settings ===
  saveLucaSettingsFromUI();

  // === Prompt Settings ===
  if (ui.settingsPromptInput) state.aiInstructionHeader = (ui.settingsPromptInput as HTMLTextAreaElement).value.trim();
  if (ui.settingsGlossaryPromptInput) state.glossaryPrompt = (ui.settingsGlossaryPromptInput as HTMLTextAreaElement).value.trim();
  if (ui.settingsAiCheckPromptInput) state.aiCheckPrompt = (ui.settingsAiCheckPromptInput as HTMLTextAreaElement).value.trim();
  if (ui.settingsAgentPromptInput) state.agentPrompt = (ui.settingsAgentPromptInput as HTMLTextAreaElement).value.trim();
  if (ui.settingsEpubTagsInput) state.epubTags = (ui.settingsEpubTagsInput as HTMLInputElement)?.value.trim() || 'p';
  if (ui.settingsEnableBackgroundChaining) state.enableBackgroundChaining = (ui.settingsEnableBackgroundChaining as HTMLInputElement).checked;
  if (ui.settingsBackgroundInput) state.currentBackground = (ui.settingsBackgroundInput as HTMLTextAreaElement).value.trim();
  if (ui.settingsSummaryPromptInput) state.summaryPrompt = (ui.settingsSummaryPromptInput as HTMLTextAreaElement)?.value.trim() || '';

  const aiChkChainEl = document.getElementById('settingsEnableAiCheckChaining') as HTMLInputElement | null;
  if (aiChkChainEl) state.enableAiCheckChaining = aiChkChainEl.checked;
  const aiChkStoryEl = document.getElementById('settingsEnableAiCheckStoryContext') as HTMLInputElement | null;
  if (aiChkStoryEl) state.enableAiCheckStoryContext = aiChkStoryEl.checked;
  const aiChkMemEl = document.getElementById('settingsEnableAiCheckAgentMemory') as HTMLInputElement | null;
  if (aiChkMemEl) state.enableAiCheckAgentMemory = aiChkMemEl.checked;
  const aiChkLocEl = document.getElementById('settingsAiCheckLocalizationNotes') as HTMLTextAreaElement | null;
  if (aiChkLocEl) state.aiCheckLocalizationNotes = aiChkLocEl.value.trim();
  const aiChkStoryCtxEl = document.getElementById('settingsAiCheckStoryContextInput') as HTMLTextAreaElement | null;
  if (aiChkStoryCtxEl) state.aiCheckStoryContext = aiChkStoryCtxEl.value.trim();
  const aiChkRevEl = document.getElementById('settingsAiCheckRevisionsInput') as HTMLTextAreaElement | null;
  if (aiChkRevEl) state.aiCheckRevisionsSummary = aiChkRevEl.value.trim();
  const aiChkSumPromptEl = document.getElementById('settingsAiCheckSummaryPromptInput') as HTMLTextAreaElement | null;
  if (aiChkSumPromptEl) state.aiCheckSummaryPrompt = aiChkSumPromptEl.value.trim();

  // === Glossary Settings ===
  if (ui.settingsGlossaryInput) {
    state.glossaryText = (ui.settingsGlossaryInput as HTMLTextAreaElement).value.trim();
  }

  import('./ai-check').then(m => m.renderAiCheckSettingsUI()).catch(() => {});

  closeModal(ui.settingsModal as HTMLElement);
  applyHtlMode();
  if (!oldShowEpubImages && state.showEpubImages && state.projectType === 'epub' && state.epubSourceId) {
    import('./epub-images').then(m => m.preloadEpubImages()).then(() => refreshAll());
  } else {
    refreshAll();
  }
  if (!prevInc && state.incrementEnabled && state.lines.length) {
    prefillIncrement();
  }
  renderGlossaryPreview();
  queueAutoSave();
}

export function onSavePromptsSettings(): void {
  onSavePromptSettings();
}

export function onSaveGlossarySettings(): void {
  onSavePromptSettings();
}

