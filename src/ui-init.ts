// @module ui-init.ts — DOM element caching, scroller initialization, and event binding

import { state, ui, setMainScroller, setProofreadScroller, setQaScroller, getActiveLineEditorLineNum } from './state';
import {
  DEFAULT_AI_TRANSLATION_FORMAT, DEFAULT_GLOSSARY_PROMPT, DEFAULT_AI_CHECK_PROMPT,
  DEFAULT_PROMPT_HEADER_NUMBERED, DEFAULT_PROMPT_HEADER_BLOCK,
  DEFAULT_PROMPT_HEADER_XML, DEFAULT_PROMPT_HEADER_JSONL, DEFAULT_PROMPT_HEADER_JSON_ARRAY,
  DEFAULT_PROMPT_HEADER_COMPLEX_ID, DEFAULT_PROMPT_HEADER_COMPLEX_EN,
  DEFAULT_PROMPT_HEADER_NUMBERED_KAGIKAKKO, DEFAULT_PROMPT_HEADER_BLOCK_KAGIKAKKO,
  DEFAULT_PROMPT_HEADER_XML_KAGIKAKKO, DEFAULT_PROMPT_HEADER_JSONL_KAGIKAKKO, DEFAULT_PROMPT_HEADER_JSON_ARRAY_KAGIKAKKO,
  DEFAULT_AGENT_PROMPT, DEFAULT_SUMMARY_PROMPT,
  DEFAULT_AI_CHECK_SUMMARY_PROMPT,
  DEFAULT_PROMPT_HEADER_AERA_SIMPLE, DEFAULT_SUMMARY_PROMPT_AERA_SIMPLE
} from './constants';
import { VirtualScroller } from './virtual-scroller';
import { renderMainRow, syncCheckboxUI, updateButtonStates, onSaveLineEditor, flashHint, updateCurrentFileBar } from './render';
import { renderProofreadRow } from './proofread';
import { renderQaRow } from './qa';
import { onSelectionHistoryKeydown, isSelectableForActiveTab, recordSelectionHistory, switchWorkspaceTab, selectActiveWorkspaceBatch, getActiveBatchConfig } from './selection';
import { onSaveGlossary, onImportGlossaryFile, onExportGlossaryFile, onDeleteTranslation, onCopyForGlossaryAi } from './glossary';
import { onCopyForAi, onApplyTranslation, onUndoLastApply, onRedoLastUndo } from './translate';
import { onCopyNamesForAi, onApplyNameTranslations, onResetNameTranslations } from './name-translation';
import { onCopyForAiCheck, onParseAiCheck, onApplyAiCheckCorrections, onClearAiCheck } from './ai-check';
import { onOpenProofread, onResetProofread, onProofreadReplaceAll, renderProofreadResults, onProofreadIncludeAll, onProofreadExcludeAll } from './proofread';
import { onOpenQa, onResetQa, runQaCheck, onRetranslateFlagged } from './qa';
import { onOpenSettings, onSavePromptSettings, onOpenPromptsSettings, onOpenGlossarySettings, onSavePromptsSettings, onSaveGlossarySettings, initSettingsTabs } from './settings';
import { onExport } from './export';
import { Shortcuts } from './shortcuts';
import { OpfsExplorer } from './opfs-explorer';
import { onImportVndbNames, onImportAnilistNames } from './vndb-anilist';
import { onExtractEpubRubyNames } from './epub-ruby';
import { openFileListModal, closeFileListModal, onAddFile, onDeleteSelectedFiles } from './file-list';
import {
  onImportRefLang1, onImportRefLang2, onImportRefLang1Folder, onImportRefLang2Folder,
  onRefLang1FileChange, onRefLang2FileChange, onRefLang1FolderChange, onRefLang2FolderChange,
  onClearRefLang1, onClearRefLang2, applyHtlMode, refreshHtlPanels,
} from './htl-mode';
import { loadApiSettings, onOpenApiSettings, onSaveApiSettings, onAutoTranslate, updateDelayPreview, onFetchModels, resolveReviewAction, onLoadProfile, onSaveProfile, onDeleteProfile, updateProfileButtonsState } from './auto-translate';
import {
  onImportFileChange, onImportFolderChange, onImportZipChange,
  onImportLucaTxtChange, onImportLucaTxtFolderChange,
  onImportCustomChange, onImportCustomFolderChange,
} from './import-source';
import { initCustomParserModal, updateCustomImportAccept } from './custom-parser-modal';
import { setPyodideColdStartHint } from './custom-parser-runner';
import { onImportTranslatedFileChange, onImportTranslatedFolderChange } from './import-translated';
import {
  createNewProject, closeProject, onRestoreProject, renderDashboardProjects,
  openDashboardSettings, saveDashboardSettings, resetDashboardSettings,
  queueAutoSave, openModal, closeModal, loadDashboardProjects,
  backupCurrentProject, backupAllProjectsAsZip, flushAutoSaveNow,
} from './project';
import { isFolderBackupSupported, backupAllToFolder, openFolderRestorePicker } from './folder-backup';
import { getDefaultPromptHeaderForFormat, getKagikakkoPromptHeaderForFormat } from './ai-format';
import { getLucaProfile, populateLucaExportSlotSelect, DEFAULT_LUCA_PROFILE } from './luca-engine';
import { getMainScroller } from './state';
import { initDictionary } from './dictionary';
import { initExtensionBridge, isExtensionAvailable } from './extension-bridge';
import { applyProjectLoggingVisibility, appendProjectLog, updateStreamingLog, finishStreamingLog } from './logging';
import './plugins';
import { createPluginHostBridge } from './plugin-host-bridge';
import { ensureStoragePersistence, checkStorageQuota } from './project';

// ─── Debounce Utility ─────────────────────────────────────────────────────────

function debounce(func: Function, wait: number) {
  let timeout: any;
  return function (this: any, ...args: any[]) {
    clearTimeout(timeout);
    timeout = setTimeout(() => func.apply(this, args), wait);
  };
}

// ─── Element Caching ──────────────────────────────────────────────────────────

export function cacheElements(): void {
  const ids = [
    'dashboardView', 'workspaceView', 'projectList', 'projectFilterInput', 'projectSortSelect', 'projectCountBadge', 'btnNewProject', 'btnRestoreProject', 'btnBackupAllProjects', 'btnFolderBackup', 'btnFolderRestore',
    'btnBackToDashboard', 'btnBackupProject', 'btnBatchPrev', 'btnBatchNext', 'projectNameDisplay', 'restoreProjectInput', 'btnDropdownImport', 'dropdownImportMenu', 'btnDropdownImportOther', 'dropdownImportOtherMenu', 'btnImportFile', 'btnDropdownTools', 'dropdownToolsMenu',
    'btnDropdownDashboardSettings', 'dropdownDashboardSettingsMenu', 'btnDashboardSettings', 'dashboardSettingsModal', 'btnDashboardSettingsSave', 'btnDashboardSettingsReset', 'paletteSelect', 'btnDashboardSettingsCancel', 'btnDashboardPrompts', 'dashboardPromptsModal', 'dpPromptInput', 'dpPromptTemplateSelect', 'dpGlossaryPromptInput', 'dpAiCheckPromptInput', 'dpAgentPromptInput', 'dpSummaryPromptInput', 'btnDashboardPromptsSave', 'btnDashboardPromptsReset', 'btnDashboardPromptsCancel',
    'dsSourceLang', 'dsTargetLang', 'dsTranslationMode', 'dsAiFormat', 'dsContextLines', 'dsContextType', 'dsSelectionBatch', 'dsGlossaryBatch', 'dsAiCheckBatch', 'dsParallelBatch', 'dsSubagentWorkers', 'dsShowFurigana', 'dsFuriganaType', 'dsFontSize', 'dsEnableDictionary', 'dsDictionaryEngine', 'dsDictionaryPrompt', 'dsRegexFilter', 'dsRegexFilterCase', 'dsDisableEmptyLineValidation', 'dsCheckKanaResidue', 'dsCheckSimilarity', 'dsSimilarityThreshold', 'dsSimilarityThresholdWrap', 'dsCheckLengthRatio', 'dsLengthRatioThreshold', 'dsLengthRatioWrap', 'dsCheckLinebreak', 'dsCheckLanguage', 'dsCheckPunctuation', 'dsCheckUntransName', 'dsIgnorePasteNames', 'dsEnableBackgroundChaining', 'dsEnableUncertainMarking', 'dsSafeTagsForChatgpt', 'dsAgentMaxTurns', 'dsEpubTags', 'dsShowEpubImages', 'dsEnableLogging',
    'btnImportFolder', 'btnImportZip', 'btnImportTranslatedFile', 'btnImportTranslatedFolder', 'btnExport', 'btnProofread',
    'previewViewport', 'previewContainer', 'currentFileBar', 'progressFill', 'progressText', 'btnSelectAll',
    'btnClearSelection', 'copyCount', 'btnCopyForAi', 'copyStatus', 'pasteArea', 'btnApply',
    'autoCopasControls', 'btnAutoCopas', 'btnFetchCopasResult', 'autoCopasStatus', 'btnAutoCopasCancel', 'checkAutoRepeatOnFailure',
    'autoCopasGlossaryControls', 'btnAutoCopasGlossary', 'btnFetchCopasGlossaryResult', 'autoCopasGlossaryStatus', 'btnAutoCopasGlossaryCancel',
    'autoCopasAiCheckControls', 'btnAutoCopasAiCheck', 'btnFetchCopasAiCheckResult', 'autoCopasAiCheckStatus', 'btnAutoCopasAiCheckCancel',
    'btnUndo', 'btnRedo', 'nameTableBody', 'statusBar', 'importFileInput', 'importFolderInput', 'importTranslatedFileInput', 'importTranslatedFolderInput',
    'btnCopyNamesForAi', 'copyNameCount', 'pasteNameArea', 'btnApplyNameTranslations', 'btnResetNameTranslations',
    'glossaryPreviewWrap', 'glossaryPreviewText',
    'importZipInput', 'importLucaTxtInput', 'importLucaTxtFolderInput', 'btnImportLucaTxt', 'btnImportLucaTxtFolder',
    'glossaryFileInput', 'settingsModal', 'settingsPromptInput', 'settingsGlossaryPromptInput', 'settingsAiCheckPromptInput', 'settingsAgentPromptInput', 'settingsEpubTagsInput', 'settingsShowEpubImages',
    'settingsLucaWrap', 'settingsLucaProfileSelect', 'settingsLucaMcWrap', 'settingsLucaMcDisplayNameInput', 'settingsLucaExportLangWrap', 'settingsLucaExportLangSelect', 'settingsSourceLangSelect', 'settingsTargetLangSelect', 'settingsTranslationModeSelect', 'settingsRegexFilterInput', 'settingsRegexFilterCaseCheck', 'settingsRefLangWrap', 'settingsRefLang1Select', 'settingsRefLang2Select', 'btnImportRefLang1', 'btnImportRefLang2', 'btnImportRefLang1Folder', 'btnImportRefLang2Folder', 'btnClearRefLang1', 'btnClearRefLang2', 'refLang1Input', 'refLang2Input', 'refLang1FolderInput', 'refLang2FolderInput',
    'settingsDisableEmptyLineValidation', 'settingsShowFurigana', 'settingsFuriganaType', 'settingsFontSize', 'settingsEnableDictionary', 'settingsDictionaryEngine', 'settingsDictionaryPrompt', 'settingsAiCheckReviewMode', 'dictionaryPopup', 'dictPopupWord', 'dictPopupClose', 'dictPopupContent', 'settingsAiTranslationFormatSelect', 'settingsGlossaryInput', 'settingsContextLinesInput', 'settingsSelectionBatchSizeInput', 'settingsGlossaryBatchSizeInput', 'settingsAiCheckBatchSizeInput', 'settingsParallelBatchSizeInput', 'settingsSubagentWorkersInput', 'btnSettingsReset', 'btnSettingsGlossaryReset', 'btnSettingsAiCheckReset', 'btnSettingsAgentPromptReset', 'btnSettingsCancel', 'btnSettingsSave', 'lineEditorModal', 'lineEditorTitle',
    'btnDropdownSettings', 'dropdownSettingsMenu', 'btnSettingsGeneral', 'btnSettingsPrompts', 'btnSettingsGlossary', 'settingsPromptsModal', 'settingsGlossaryModal', 'btnSettingsPromptsCancel', 'btnSettingsPromptsSave', 'btnSettingsGlossaryCancel', 'btnSettingsGlossarySave', 'settingsEnableBackgroundChaining', 'settingsBackgroundInput', 'settingsSummaryPromptInput', 'btnSettingsSummaryPromptReset', 'settingsPromptTemplateSelect', 'btnSettingsClearBackground',
    'tabTranslate', 'tabGlossary', 'viewTranslate', 'viewGlossary', 'btnCopyForGlossaryAi', 'pasteGlossaryArea', 'btnSaveGlossary', 'btnImportGlossaryFile', 'btnExportGlossaryFile', 'copyGlossaryCount', 'btnDeleteTranslation', 'deleteTranslationCount', 'tabDelete', 'viewDelete',
    'tabAiCheck', 'viewAiCheck', 'btnCopyForAiCheck', 'copyAiCheckCount', 'aiCheckStatus', 'pasteAiCheckArea', 'btnParseAiCheck', 'btnApplyAiCheck', 'btnClearAiCheck', 'aiCheckResults',
    'aiCheckEnableChainingCheck', 'aiCheckEnableStoryContextCheck', 'aiCheckEnableAgentMemoryCheck', 'aiCheckLocalizationNotesInput', 'aiCheckRevisionsInput', 'btnAiCheckClearRevisions', 'btnAiCheckOpenMemoryModal', 'aiCheckChainingBadge',
    'aiCheckStoryContextInput', 'btnAiCheckCopyStoryFromTranslate', 'btnAiCheckClearStoryContext',
    'btnOpenAgentMemoryFromSettings', 'settingsEnableAiCheckChaining', 'settingsEnableAiCheckStoryContext', 'settingsEnableAiCheckAgentMemory', 'settingsAiCheckLocalizationNotes',
    'settingsAiCheckStoryContextInput', 'btnSettingsAiCheckCopyStoryFromTranslate', 'btnSettingsAiCheckClearStoryContext', 'settingsAiCheckSummaryPromptInput', 'btnSettingsAiCheckSummaryPromptReset',
    'settingsAiCheckRevisionsInput', 'btnSettingsAiCheckClearRevisions',
    'vndbInput', 'btnImportVndbNames', 'vndbStatus',
    'btnExtractEpubRubyNames', 'epubRubyStatus', 'anilistInput', 'btnImportAnilistNames', 'anilistStatus',
    'lineOriginalView', 'lineNameWrap', 'lineNameInput', 'lineMessageInput', 'lineTranslatedCheck',
    'lucaRefWrap', 'lineRefEnView', 'lineRefZhView',
    'jsonRefLang1Wrap', 'lineRefLang1Label', 'lineRefLang1View',
    'jsonRefLang2Wrap', 'lineRefLang2Label', 'lineRefLang2View',
    'btnLineCancel', 'btnLineSave', 'proofreadModal', 'proofreadSearchInput', 'proofreadScope',
    'proofreadRegexCheck', 'proofreadCaseCheck', 'proofreadExactCheck', 'proofreadTranslatedOnlyCheck',
    'btnProofreadReset', 'proofreadStatus', 'proofreadExclusionActions', 'btnProofreadIncludeAll', 'btnProofreadExcludeAll', 'proofreadContainer', 'btnProofreadClose',
    'proofreadReplaceInput', 'btnProofreadReplaceAll', 'proofreadPreserveCaseCheck', 'proofreadJumpCheck', 'rangeFromInput', 'rangeToInput', 'btnSelectRange',
    'settingsCheckKanaResidue', 'settingsCheckSimilarity', 'settingsSimilarityThreshold', 'settingsSimilarityThresholdWrap',
    'settingsContextTypeSelect',
    'btnQaCheck', 'qaModal', 'qaCheckGlossary', 'qaCheckKana', 'qaCheckSimilarity', 'qaCheckLinebreak', 'qaCheckLength', 'qaCheckLanguage', 'qaCheckPunctuation', 'btnRunQa', 'btnQaReset', 'qaStats', 'qaResults', 'btnQaClose', 'btnRetranslateFlagged', 'settingsCheckLengthRatio', 'settingsLengthRatioThreshold', 'settingsLengthRatioWrap', 'settingsCheckLinebreak', 'settingsCheckLanguage', 'settingsCheckPunctuation', 'settingsCheckUntransName', 'settingsIgnorePasteNames', 'settingsEnableUncertainMarking', 'settingsSafeTagsForChatgpt', 'qaCheckUncertain', 'qaCheckUntransName', 'aiTranslateModeSelect', 'settingsAgentMaxTurns',
    'btnAutoTranslate', 'btnAutoGlossaryAi', 'btnAutoAiCheck', 'btnFloatingApiSettings', 'apiSettingsModal', 'apiTypeSelect', 'apiUrlInput', 'apiKeyInput', 'apiModelInput', 'apiModelSelect', 'btnFetchModels', 'apiModelFetchStatus', 'apiTemperatureInput', 'apiTopPInput', 'apiMaxTokensInput', 'apiFrequencyPenaltyInput', 'apiPresencePenaltyInput', 'apiSeedInput', 'apiReasoningEffortSelect', 'apiRpmInput', 'apiDelayPreview', 'apiThinkingSelect', 'apiFilterThinkingCheck', 'apiMergeSystemCheck', 'apiStreamingCheck', 'apiBackupKeysInput', 'apiKeyStrategySelect', 'btnApiSettingsCancel', 'btnApiSettingsSave', 'tavilyKeyInput', 'apiProfileSelect', 'btnLoadProfile', 'btnDeleteProfile', 'apiProfileNameInput', 'btnSaveProfile',
 'aiCheckReviewActions', 'btnReviewApply', 'btnReviewSkip',
    'btnFloatingAiAgent', 'btnFloatingLogging', 'loggingPanel', 'loggingHistory', 'btnLoggingClear', 'btnLoggingClose', 'aiAgentChatPanel', 'btnAgentClose', 'btnAgentClear', 'btnAgentMemory', 'agentChatHistory', 'agentInput', 'btnAgentSend',
    'agentMemoryModal', 'agentMemoryList', 'agentMemoryKey', 'agentMemoryCategory', 'agentMemoryScope', 'agentMemoryValue', 'btnAgentMemoryCancel', 'btnAgentMemorySave',
    'btnTextReplacer', 'textReplacerModal', 'replacerPreInput', 'replacerPostInput', 'btnTextReplacerCancel', 'btnTextReplacerSave',
    'btnImportCustom', 'btnImportCustomFolder', 'btnCustomParsers', 'importCustomInput', 'importCustomFolderInput', 'customParserModal',
    'cpListView', 'cpEditView', 'cpParserList', 'btnCpNew', 'btnCpImportNow', 'btnCpImportFolderNow',
    'btnCpExportAll', 'btnCpImportParsers', 'cpParserImportInput',
    'cpNameInput', 'cpLanguageSelect', 'cpExtensionsInput', 'cpParseInput', 'cpSerializeInput',
    'cpMatchSelect', 'cpMagicInput', 'cpFilenameRegexInput',
    'btnCpAddAssets', 'cpAssetsInput', 'cpAssetList', 'cpAssetsSize',
    'cpSettingsInput',
    'cpSettingsEditor',
    'btnCpParseTemplate', 'btnCpSerializeTemplate', 'btnCpTestFile', 'btnCpTestRun',
    'cpTestFileName', 'cpTestFileInput', 'cpTestResult', 'btnCpCancel', 'btnCpSave',
    'btnFileList', 'fileListModal', 'fileListContainer', 'btnFileListAdd', 'btnFileListDelete', 'btnFileListClose',
    'btnToolbarBookmark', 'toolbarBookmarkBadge', 'btnLineBookmark',
    'bookmarkModal', 'bookmarkModalCount', 'btnBookmarkModalCloseIcon', 'bookmarkSearchInput', 'btnClearAllBookmarks', 'bookmarkListContainer', 'btnBookmarkClose',
    'imageLightboxModal', 'imageLightboxImg', 'btnImageLightboxClose',
    'btnPluginManagerOpen', 'btnWorkspacePluginsOpen', 'pluginManagerModal', 'btnPluginRefresh', 'btnInstallPlugin', 'btnCreateCustomParser', 'btnPluginFilterAll', 'btnPluginFilterPlugins', 'btnPluginFilterParsers', 'pluginCountAll', 'pluginCountPlugins', 'pluginCountParsers', 'pluginFileInput', 'pluginList', 'btnPluginManagerClose', 'btnOpenPlugins', 'pluginMenu', 'pluginPanels', 'storageWarningBanner', 'storageWarningText',
    'btnShortcutsOpen', 'btnWorkspaceShortcutsOpen', 'shortcutModal', 'shortcutList', 'shortcutStatus', 'btnShortcutsResetAll', 'btnShortcutsClose',
    'settingsIncrementCheck', 'dsIncrementCheck',
    'opfsExplorerModal', 'btnOpfsExplorerOpen', 'btnWorkspaceOpfsExplorerOpen', 'btnOpfsExplorerClose', 'btnOpfsRefresh', 'opfsCrumbs', 'opfsList', 'opfsEmpty', 'opfsEmptyText', 'opfsLoading',
    'btnTabSettingsGeneral', 'btnTabSettingsPrompts', 'btnTabSettingsGlossary', 'btnTabSettingsShortcuts'
  ];
  for (const id of ids) {
    ui[id] = document.getElementById(id);
  }
}

// ─── Scroller Initialization ──────────────────────────────────────────────────

export function initScrollers(): void {
  const mainScroller = new VirtualScroller(ui.previewViewport as HTMLElement, ui.previewContainer as HTMLElement, 85, renderMainRow);
  mainScroller.onVisibleRangeChange = (start) => updateCurrentFileBar(start);
  setMainScroller(mainScroller);
  const proofreadViewport = (ui.proofreadContainer as HTMLElement).closest('.proofread-results-wrap') as HTMLElement;
  setProofreadScroller(new VirtualScroller(proofreadViewport, ui.proofreadContainer as HTMLElement, 90, renderProofreadRow));
  const qaViewport = (ui.qaResults as HTMLElement).closest('.proofread-results-wrap') as HTMLElement;
  setQaScroller(new VirtualScroller(qaViewport, ui.qaResults as HTMLElement, 90, renderQaRow));
}

// ─── Event Binding ────────────────────────────────────────────────────────────

export function bindEvents(): void {
  document.addEventListener('click', e => {
    const target = e.target as HTMLElement;
    const isImportBtn = target.closest('#btnDropdownImport');
    const isImportOtherBtn = target.closest('#btnDropdownImportOther');
    const isInsideImportMenu = target.closest('#dropdownImportMenu');
    if (isImportBtn) {
      e.preventDefault();
      const btn = isImportBtn as HTMLElement;
      const menu = ui.dropdownImportMenu as HTMLElement;
      const willShow = !menu.classList.contains('show');
      document.querySelectorAll('.dropdown-content.show').forEach(el => { if (el !== menu) el.classList.remove('show'); });
      document.querySelectorAll('.dropdown-toggle[aria-expanded="true"]').forEach(el => el.setAttribute('aria-expanded', 'false'));
      if (willShow) {
        menu.classList.add('show');
        void menu.offsetWidth;
        const rect = btn.getBoundingClientRect();
        const mw = menu.offsetWidth || 220;
        const mh = menu.offsetHeight || 220;
        let top = rect.bottom + 6;
        if (top + mh > window.innerHeight - 8) top = Math.max(8, rect.top - mh - 6);
        menu.style.top = top + 'px';
        let left = rect.left;
        const maxLeft = window.innerWidth - mw - 8;
        if (maxLeft < left) left = Math.max(8, maxLeft);
        menu.style.left = left + 'px';
        menu.style.right = 'auto';
        btn.setAttribute('aria-expanded', 'true');
      } else {
        menu.classList.remove('show');
        btn.setAttribute('aria-expanded', 'false');
        if (ui.dropdownImportOtherMenu) (ui.dropdownImportOtherMenu as HTMLElement).classList.remove('show');
      }
    } else if (isImportOtherBtn) {
      e.preventDefault();
      e.stopPropagation();
      if (ui.dropdownImportOtherMenu) {
        (ui.dropdownImportOtherMenu as HTMLElement).classList.toggle('show');
      }
    } else if (!isInsideImportMenu) {
      if (ui.dropdownImportMenu) {
        (ui.dropdownImportMenu as HTMLElement).classList.remove('show');
      }
      if (ui.dropdownImportOtherMenu) {
        (ui.dropdownImportOtherMenu as HTMLElement).classList.remove('show');
      }
    } else {
      // Clicked an action item inside the import menu — close everything
      if (ui.dropdownImportMenu) {
        (ui.dropdownImportMenu as HTMLElement).classList.remove('show');
      }
      if (ui.dropdownImportOtherMenu) {
        (ui.dropdownImportOtherMenu as HTMLElement).classList.remove('show');
      }
    }
    const isDashboardSettingsBtn = target.closest('#btnDropdownDashboardSettings');
    if (isDashboardSettingsBtn) {
      e.preventDefault();
      const btn = isDashboardSettingsBtn as HTMLElement;
      const menu = ui.dropdownDashboardSettingsMenu as HTMLElement;
      const willShow = !menu.classList.contains('show');
      document.querySelectorAll('.dropdown-content.show').forEach(el => { if (el !== menu) el.classList.remove('show'); });
      document.querySelectorAll('.dropdown-toggle[aria-expanded="true"]').forEach(el => el.setAttribute('aria-expanded', 'false'));
      if (willShow) {
        menu.classList.add('show');
        void menu.offsetWidth;
        const rect = btn.getBoundingClientRect();
        const mw = menu.offsetWidth || 220;
        const mh = menu.offsetHeight || 88;
        let top = rect.bottom + 6;
        if (top + mh > window.innerHeight - 8) top = Math.max(8, rect.top - mh - 6);
        menu.style.top = top + 'px';
        let left = rect.right - mw;
        const minLeft = 8;
        const maxLeft = window.innerWidth - mw - 8;
        left = Math.max(minLeft, Math.min(left, maxLeft));
        menu.style.left = left + 'px';
        menu.style.right = 'auto';
        btn.setAttribute('aria-expanded', 'true');
      } else {
        menu.classList.remove('show');
        btn.setAttribute('aria-expanded', 'false');
      }
    } else if (!target.closest('#dropdownDashboardSettingsMenu')) {
      if (ui.dropdownDashboardSettingsMenu) {
        (ui.dropdownDashboardSettingsMenu as HTMLElement).classList.remove('show');
        const b = document.getElementById('btnDropdownDashboardSettings');
        if (b) b.setAttribute('aria-expanded', 'false');
      }
    }


    const isToolsBtn = target.closest('#btnDropdownTools');
    if (isToolsBtn) {
      e.preventDefault();
      const btn = isToolsBtn as HTMLElement;
      const menu = ui.dropdownToolsMenu as HTMLElement;
      const willShow = !menu?.classList.contains('show');
      document.querySelectorAll('.dropdown-content.show').forEach(el => { if (el !== menu) el.classList.remove('show'); });
      document.querySelectorAll('.dropdown-toggle[aria-expanded="true"]').forEach(el => el.setAttribute('aria-expanded', 'false'));
      if (willShow && menu) {
        menu.classList.add('show');
        void menu.offsetWidth;
        const rect = btn.getBoundingClientRect();
        const mw = menu.offsetWidth || 200;
        const mh = menu.offsetHeight || 160;
        let top = rect.bottom + 6;
        if (top + mh > window.innerHeight - 8) top = Math.max(8, rect.top - mh - 6);
        menu.style.top = top + 'px';
        let left = rect.left;
        const maxLeft = window.innerWidth - mw - 8;
        if (maxLeft < left) left = Math.max(8, maxLeft);
        menu.style.left = left + 'px';
        menu.style.right = 'auto';
        btn.setAttribute('aria-expanded', 'true');
      } else if (menu) {
        menu.classList.remove('show');
        btn.setAttribute('aria-expanded', 'false');
      }
    } else if (!target.closest('#dropdownToolsMenu') || target.closest('#dropdownToolsMenu .dropdown-item')) {
      if (ui.dropdownToolsMenu) {
        (ui.dropdownToolsMenu as HTMLElement).classList.remove('show');
        const bTools = document.getElementById('btnDropdownTools');
        if (bTools) bTools.setAttribute('aria-expanded', 'false');
      }
    }

    const isPluginBtn = target.closest('#btnOpenPlugins');
    if (isPluginBtn) {
      e.preventDefault();
      const btn = isPluginBtn as HTMLElement;
      const menu = document.getElementById('pluginMenu') || (ui.pluginMenu as HTMLElement);
      const willShow = !menu?.classList.contains('show');
      document.querySelectorAll('.dropdown-content.show').forEach(el => { if (el !== menu) el.classList.remove('show'); });
      document.querySelectorAll('.dropdown-toggle[aria-expanded="true"]').forEach(el => el.setAttribute('aria-expanded', 'false'));
      if (willShow && menu) {
        (window as any).CSTL?.plugins?.renderPluginMenu();
        menu.classList.add('show');
        void menu.offsetWidth;
        const rect = btn.getBoundingClientRect();
        const mw = menu.offsetWidth || 220;
        const mh = menu.offsetHeight || 140;
        let top = rect.bottom + 6;
        if (top + mh > window.innerHeight - 8) top = Math.max(8, rect.top - mh - 6);
        menu.style.top = top + 'px';
        let left = rect.right - mw;
        const minLeft = 8;
        const maxLeft = window.innerWidth - mw - 8;
        left = Math.max(minLeft, Math.min(left, maxLeft));
        menu.style.left = left + 'px';
        menu.style.right = 'auto';
        btn.setAttribute('aria-expanded', 'true');
      } else if (menu) {
        menu.classList.remove('show');
        btn.setAttribute('aria-expanded', 'false');
      }
    } else if (!target.closest('#pluginMenu')) {
      const menu = document.getElementById('pluginMenu') || ui.pluginMenu;
      if (menu) {
        menu.classList.remove('show');
        const b = document.getElementById('btnOpenPlugins');
        if (b) b.setAttribute('aria-expanded', 'false');
      }
    }
  });

  document.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    if (Shortcuts._recording) return;

    // 1. Close open dropdown menus first
    const openDropdowns = document.querySelectorAll('.dropdown-content.show');
    if (openDropdowns.length > 0) {
      openDropdowns.forEach(el => el.classList.remove('show'));
      document.querySelectorAll('.dropdown-toggle[aria-expanded="true"]').forEach(el => el.setAttribute('aria-expanded', 'false'));
      e.preventDefault();
      return;
    }

    // 2. Close dictionary popup if visible
    const dictPopup = document.getElementById('dictionaryPopup');
    if (dictPopup && dictPopup.style.display !== 'none') {
      const dictClose = document.getElementById('dictPopupClose');
      if (dictClose) dictClose.click();
      else dictPopup.style.display = 'none';
      e.preventDefault();
      return;
    }

    // 3. Close topmost open modal if any
    const openModals = Array.from(document.querySelectorAll<HTMLElement>('.modal-backdrop')).filter(m => {
      if (m.classList.contains('closing')) return false;
      if (m.classList.contains('open')) return true;
      const comp = window.getComputedStyle(m);
      return comp.display !== 'none' && comp.visibility !== 'hidden';
    });

    if (openModals.length > 0) {
      openModals.sort((a, b) => {
        const za = parseFloat(window.getComputedStyle(a).zIndex) || 0;
        const zb = parseFloat(window.getComputedStyle(b).zIndex) || 0;
        if (za !== zb) return zb - za;
        return a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? 1 : -1;
      });

      const topModal = openModals[0];
      const closeBtn = topModal.querySelector<HTMLElement>(
        '#btnSettingsCancel, #btnDashboardSettingsCancel, #btnDashboardPromptsCancel, #btnSettingsPromptsCancel, #btnSettingsGlossaryCancel, #btnAgentMemoryCancel, #btnLineCancel, #btnProofreadClose, #btnQaClose, #btnApiSettingsCancel, #btnDictHistoryClose, #btnTextReplacerClose, #btnCpClose, #btnFileListClose, #btnBookmarkClose, #btnImageLightboxClose, #btnOpfsExplorerClose, #btnPluginManagerClose, .btn-modal-close, .btn-modal-dismiss, .cstl-plugin-modal-close, [data-modal-close], .btn-close, .modal-close'
      );
      if (closeBtn && !(closeBtn as HTMLButtonElement).disabled) {
        closeBtn.click();
      } else {
        closeModal(topModal);
      }
      e.preventDefault();
      return;
    }

    // 4. Close floating agent panel or logging panel if open
    const agentChat = document.getElementById('aiAgentChatPanel');
    if (agentChat && window.getComputedStyle(agentChat).display !== 'none') {
      const agentClose = document.getElementById('btnAgentClose');
      if (agentClose) agentClose.click();
      else agentChat.style.display = 'none';
      e.preventDefault();
      return;
    }

    const loggingPanel = document.getElementById('loggingPanel');
    if (loggingPanel && window.getComputedStyle(loggingPanel).display !== 'none') {
      const loggingClose = document.getElementById('btnLoggingClose');
      if (loggingClose) loggingClose.click();
      else loggingPanel.style.display = 'none';
      e.preventDefault();
      return;
    }
  });
  window.addEventListener('resize', () => {
    document.querySelectorAll('.dropdown-content.show').forEach(el => el.classList.remove('show'));
    document.querySelectorAll('.dropdown-toggle[aria-expanded="true"]').forEach(el => el.setAttribute('aria-expanded', 'false'));
  });
  window.addEventListener('scroll', () => {
    document.querySelectorAll('.dropdown-content.show').forEach(el => el.classList.remove('show'));
    document.querySelectorAll('.dropdown-toggle[aria-expanded="true"]').forEach(el => el.setAttribute('aria-expanded', 'false'));
  }, true);
  document.addEventListener('keydown', onSelectionHistoryKeydown);
  document.addEventListener('keydown', (event) => {
    if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 's') return;
    if (!state.currentProjectId) return;
    event.preventDefault();
    backupCurrentProject();
  });
  ui.btnNewProject?.addEventListener('click', createNewProject);
  ui.btnBackupAllProjects?.addEventListener('click', backupAllProjectsAsZip);
  // Folder Backup butuh showDirectoryPicker (desktop Chromium) — di browser
  // lain tombolnya disembunyikan dan user pakai ZIP/download seperti biasa.
  if (isFolderBackupSupported()) {
    ui.btnFolderBackup?.addEventListener('click', backupAllToFolder);
    ui.btnFolderRestore?.addEventListener('click', openFolderRestorePicker);
  } else {
    (ui.btnFolderBackup as HTMLElement | null)?.style.setProperty('display', 'none');
    (ui.btnFolderRestore as HTMLElement | null)?.style.setProperty('display', 'none');
  }
  ui.projectFilterInput?.addEventListener('input', () => renderDashboardProjects());
  ui.projectSortSelect?.addEventListener('change', () => renderDashboardProjects());
  ui.btnBackToDashboard?.addEventListener('click', closeProject);
  ui.btnBackupProject?.addEventListener('click', backupCurrentProject);
  ui.btnBatchPrev?.addEventListener('click', () => selectActiveWorkspaceBatch(-1));
  ui.btnBatchNext?.addEventListener('click', () => selectActiveWorkspaceBatch(1));
  ui.btnRestoreProject?.addEventListener('click', () => (ui.restoreProjectInput as HTMLInputElement).click());
  ui.restoreProjectInput?.addEventListener('change', onRestoreProject);
  ui.btnImageLightboxClose?.addEventListener('click', () => {
    (ui.imageLightboxModal as HTMLElement | null)?.classList.remove('open');
  });
  ui.imageLightboxModal?.addEventListener('click', (e: MouseEvent) => {
    if (e.target === ui.imageLightboxModal) {
      (ui.imageLightboxModal as HTMLElement).classList.remove('open');
    }
  });

  // Closing the tab within the 1s autosave debounce would drop the last edit —
  // flush it best-effort on pagehide (OPFS writes are atomic-swap, so a write
  // that does not finish leaves the previous file intact).
  window.addEventListener('pagehide', flushAutoSaveNow);

  ui.btnDashboardSettings?.addEventListener('click', openDashboardSettings);
  const paletteSel = document.getElementById('paletteSelect');
  if (paletteSel) {
    paletteSel.addEventListener('change', () => {
      const val = (paletteSel as HTMLSelectElement).value;
      localStorage.setItem('cstl_color_palette', val);
      applyPalette(val);
    });
  }
  ui.btnDashboardPrompts?.addEventListener('click', () => { import('./project').then(m => m.openDashboardPrompts()); });
  document.getElementById('btnPluginManagerOpen')?.addEventListener('click', () => {
    (window as any).CSTL?.plugins?.openPluginManager?.();
  });
  document.getElementById('btnWorkspacePluginsOpen')?.addEventListener('click', () => {
    (window as any).CSTL?.plugins?.openPluginManager?.();
  });
  document.getElementById('btnPluginManagerClose')?.addEventListener('click', () => {
    const modal = document.getElementById('pluginManagerModal') || ui.pluginManagerModal;
    if (modal) modal.classList.remove('open');
  });
  document.getElementById('btnPluginRefresh')?.addEventListener('click', () => {
    (window as any).CSTL?.plugins?.renderPluginList();
  });
  document.getElementById('btnInstallPlugin')?.addEventListener('click', () => {
    (document.getElementById('pluginFileInput') as HTMLInputElement)?.click();
  });
  document.getElementById('pluginFileInput')?.addEventListener('change', async (e: Event) => {
    const target = e.target as HTMLInputElement;
    const file = target.files?.[0];
    target.value = '';
    if (!file) return;
    try {
      await (window as any).CSTL?.plugins?.installZip(file);
    } catch (err: any) {
      alert(`Gagal memasang plugin: ${err.message || err}`);
    }
  });
  ui.btnDashboardPromptsSave?.addEventListener('click', () => { import('./project').then(m => m.saveDashboardPrompts()); });
  ui.btnDashboardPromptsReset?.addEventListener('click', () => { import('./project').then(m => m.resetDashboardPrompts()); });
  ui.btnDashboardPromptsCancel?.addEventListener('click', () => (ui.dashboardPromptsModal as HTMLElement).classList.remove('open'));
  ui.dpPromptTemplateSelect?.addEventListener('change', () => {
    const val = (ui.dpPromptTemplateSelect as HTMLSelectElement).value;
    if (val === 'aera-simple') {
      (ui.dpPromptInput as HTMLTextAreaElement).value = DEFAULT_PROMPT_HEADER_AERA_SIMPLE;
      if (ui.dpSummaryPromptInput) {
        (ui.dpSummaryPromptInput as HTMLTextAreaElement).value = DEFAULT_SUMMARY_PROMPT_AERA_SIMPLE;
      }
    } else if (val === 'complex-id') {
      (ui.dpPromptInput as HTMLTextAreaElement).value = DEFAULT_PROMPT_HEADER_COMPLEX_ID;
    } else if (val === 'complex-en') {
      (ui.dpPromptInput as HTMLTextAreaElement).value = DEFAULT_PROMPT_HEADER_COMPLEX_EN;
    } else if (val === 'kagikakko') {
      const format = (ui.dsAiFormat as HTMLSelectElement)?.value || DEFAULT_AI_TRANSLATION_FORMAT;
      (ui.dpPromptInput as HTMLTextAreaElement).value = getKagikakkoPromptHeaderForFormat(format);
    } else {
      const format = (ui.dsAiFormat as HTMLSelectElement)?.value || DEFAULT_AI_TRANSLATION_FORMAT;
      (ui.dpPromptInput as HTMLTextAreaElement).value = getDefaultPromptHeaderForFormat(format);
    }
  });
  ui.dsCheckSimilarity?.addEventListener('change', () => {
    if (ui.dsSimilarityThresholdWrap) {
      (ui.dsSimilarityThresholdWrap as HTMLElement).style.display = (ui.dsCheckSimilarity as HTMLInputElement).checked ? 'flex' : 'none';
    }
  });
  ui.dsCheckLengthRatio?.addEventListener('change', () => {
    if (ui.dsLengthRatioWrap) {
      (ui.dsLengthRatioWrap as HTMLElement).style.display = (ui.dsCheckLengthRatio as HTMLInputElement).checked ? 'flex' : 'none';
    }
  });
  ui.btnDashboardSettingsSave?.addEventListener('click', saveDashboardSettings);
  ui.btnDashboardSettingsReset?.addEventListener('click', resetDashboardSettings);
  ui.btnDashboardSettingsCancel?.addEventListener('click', () => (ui.dashboardSettingsModal as HTMLElement).classList.remove('open'));
  ui.btnImportFile?.addEventListener('click', () => (ui.importFileInput as HTMLInputElement).click());
  ui.btnImportFolder?.addEventListener('click', () => (ui.importFolderInput as HTMLInputElement).click());
  ui.btnImportZip?.addEventListener('click', () => (ui.importZipInput as HTMLInputElement).click());
  ui.btnImportLucaTxt?.addEventListener('click', () => (ui.importLucaTxtInput as HTMLInputElement).click());
  ui.btnImportLucaTxtFolder?.addEventListener('click', () => (ui.importLucaTxtFolderInput as HTMLInputElement).click());
  ui.btnImportCustom?.addEventListener('click', () => (ui.importCustomInput as HTMLInputElement).click());
  ui.btnImportCustomFolder?.addEventListener('click', () => (ui.importCustomFolderInput as HTMLInputElement).click());
  ui.btnImportTranslatedFile?.addEventListener('click', () => (ui.importTranslatedFileInput as HTMLInputElement).click());
  ui.btnImportTranslatedFolder?.addEventListener('click', () => (ui.importTranslatedFolderInput as HTMLInputElement).click());

  ui.importFileInput?.addEventListener('change', onImportFileChange);
  ui.importFolderInput?.addEventListener('change', onImportFolderChange);
  ui.importZipInput?.addEventListener('change', onImportZipChange);
  ui.importLucaTxtInput?.addEventListener('change', onImportLucaTxtChange);
  ui.importLucaTxtFolderInput?.addEventListener('change', onImportLucaTxtFolderChange);
  ui.importCustomInput?.addEventListener('change', onImportCustomChange);
  ui.importCustomFolderInput?.addEventListener('change', onImportCustomFolderChange);
  ui.importTranslatedFileInput?.addEventListener('change', onImportTranslatedFileChange);
  ui.importTranslatedFolderInput?.addEventListener('change', onImportTranslatedFolderChange);
  ui.glossaryFileInput?.addEventListener('change', onImportGlossaryFile);

  ui.btnExport?.addEventListener('click', onExport);
  ui.btnCopyForAi?.addEventListener('click', onCopyForAi);
  ui.btnCopyNamesForAi?.addEventListener('click', onCopyNamesForAi);
  ui.btnCopyForGlossaryAi?.addEventListener('click', onCopyForGlossaryAi);
  ui.btnApply?.addEventListener('click', () => { try { onApplyTranslation(); } catch (_) {} });
  ui.btnApplyNameTranslations?.addEventListener('click', onApplyNameTranslations);
  ui.btnResetNameTranslations?.addEventListener('click', onResetNameTranslations);
  ui.pasteNameArea?.addEventListener('input', updateButtonStates);
  ui.btnSaveGlossary?.addEventListener('click', onSaveGlossary);
  ui.btnImportGlossaryFile?.addEventListener('click', () => (ui.glossaryFileInput as HTMLInputElement).click());
  ui.btnExportGlossaryFile?.addEventListener('click', onExportGlossaryFile);
  ui.btnDeleteTranslation?.addEventListener('click', onDeleteTranslation);
  ui.btnImportVndbNames?.addEventListener('click', onImportVndbNames);
  ui.btnExtractEpubRubyNames?.addEventListener('click', onExtractEpubRubyNames);
  ui.btnImportAnilistNames?.addEventListener('click', onImportAnilistNames);

  if (ui.btnImportRefLang1) ui.btnImportRefLang1.addEventListener('click', onImportRefLang1);
  if (ui.btnImportRefLang2) ui.btnImportRefLang2.addEventListener('click', onImportRefLang2);
  if (ui.btnImportRefLang1Folder) ui.btnImportRefLang1Folder.addEventListener('click', onImportRefLang1Folder);
  if (ui.btnImportRefLang2Folder) ui.btnImportRefLang2Folder.addEventListener('click', onImportRefLang2Folder);
  if (ui.refLang1Input) ui.refLang1Input.addEventListener('change', onRefLang1FileChange);
  if (ui.refLang2Input) ui.refLang2Input.addEventListener('change', onRefLang2FileChange);
  if (ui.refLang1FolderInput) ui.refLang1FolderInput.addEventListener('change', onRefLang1FolderChange);
  if (ui.refLang2FolderInput) ui.refLang2FolderInput.addEventListener('change', onRefLang2FolderChange);
  if (ui.btnClearRefLang1) ui.btnClearRefLang1.addEventListener('click', onClearRefLang1);
  if (ui.btnClearRefLang2) ui.btnClearRefLang2.addEventListener('click', onClearRefLang2);

  ui.tabTranslate?.addEventListener('click', () => switchWorkspaceTab('translate'));
  ui.tabGlossary?.addEventListener('click', () => switchWorkspaceTab('glossary'));
  ui.tabAiCheck?.addEventListener('click', () => {
    switchWorkspaceTab('aiCheck');
    import('./ai-check').then(m => m.renderAiCheckSettingsUI()).catch(() => {});
  });
  ui.tabDelete?.addEventListener('click', () => switchWorkspaceTab('delete'));

  ui.btnCopyForAiCheck?.addEventListener('click', onCopyForAiCheck);
  ui.btnParseAiCheck?.addEventListener('click', () => onParseAiCheck());
  ui.btnApplyAiCheck?.addEventListener('click', onApplyAiCheckCorrections);
  ui.btnClearAiCheck?.addEventListener('click', onClearAiCheck);
  ui.pasteAiCheckArea?.addEventListener('input', updateButtonStates);

  ui.aiCheckEnableChainingCheck?.addEventListener('change', (e: Event) => {
    state.enableAiCheckChaining = (e.target as HTMLInputElement).checked;
    import('./ai-check').then(m => m.renderAiCheckSettingsUI()).catch(() => {});
    queueAutoSave();
  });
  ui.aiCheckEnableStoryContextCheck?.addEventListener('change', (e: Event) => {
    state.enableAiCheckStoryContext = (e.target as HTMLInputElement).checked;
    queueAutoSave();
  });
  ui.aiCheckEnableAgentMemoryCheck?.addEventListener('change', (e: Event) => {
    state.enableAiCheckAgentMemory = (e.target as HTMLInputElement).checked;
    queueAutoSave();
  });
  ui.aiCheckLocalizationNotesInput?.addEventListener('input', (e: Event) => {
    state.aiCheckLocalizationNotes = (e.target as HTMLTextAreaElement).value;
    queueAutoSave();
  });
  ui.aiCheckRevisionsInput?.addEventListener('input', (e: Event) => {
    state.aiCheckRevisionsSummary = (e.target as HTMLTextAreaElement).value;
    queueAutoSave();
  });
  ui.btnAiCheckClearRevisions?.addEventListener('click', () => {
    state.aiCheckRevisionsSummary = '';
    import('./ai-check').then(m => m.renderAiCheckSettingsUI()).catch(() => {});
    queueAutoSave();
  });

  ui.aiCheckStoryContextInput?.addEventListener('input', (e: Event) => {
    state.aiCheckStoryContext = (e.target as HTMLTextAreaElement).value;
    queueAutoSave();
  });
  ui.btnAiCheckClearStoryContext?.addEventListener('click', () => {
    state.aiCheckStoryContext = '';
    import('./ai-check').then(m => m.renderAiCheckSettingsUI()).catch(() => {});
    queueAutoSave();
  });
  ui.btnAiCheckCopyStoryFromTranslate?.addEventListener('click', () => {
    state.aiCheckStoryContext = state.currentBackground || '';
    import('./ai-check').then(m => m.renderAiCheckSettingsUI()).catch(() => {});
    queueAutoSave();
  });
  ui.btnSettingsAiCheckClearStoryContext?.addEventListener('click', () => {
    state.aiCheckStoryContext = '';
    import('./ai-check').then(m => m.renderAiCheckSettingsUI()).catch(() => {});
    queueAutoSave();
  });
  ui.btnSettingsAiCheckCopyStoryFromTranslate?.addEventListener('click', () => {
    state.aiCheckStoryContext = state.currentBackground || '';
    import('./ai-check').then(m => m.renderAiCheckSettingsUI()).catch(() => {});
    queueAutoSave();
  });
  ui.btnSettingsAiCheckSummaryPromptReset?.addEventListener('click', () => {
    state.aiCheckSummaryPrompt = DEFAULT_AI_CHECK_SUMMARY_PROMPT;
    if (ui.settingsAiCheckSummaryPromptInput) {
      (ui.settingsAiCheckSummaryPromptInput as HTMLTextAreaElement).value = DEFAULT_AI_CHECK_SUMMARY_PROMPT;
    }
    queueAutoSave();
  });
  ui.btnSettingsAiCheckClearRevisions?.addEventListener('click', () => {
    state.aiCheckRevisionsSummary = '';
    import('./ai-check').then(m => m.renderAiCheckSettingsUI()).catch(() => {});
    queueAutoSave();
  });
  ui.settingsAiCheckRevisionsInput?.addEventListener('input', (e: Event) => {
    state.aiCheckRevisionsSummary = (e.target as HTMLTextAreaElement).value;
    queueAutoSave();
  });
  ui.btnUndo?.addEventListener('click', onUndoLastApply);
  ui.btnRedo?.addEventListener('click', onRedoLastUndo);
  ui.btnProofread?.addEventListener('click', onOpenProofread);

  ui.btnSelectAll?.addEventListener('click', () => {
    state.selectedLines.clear();
    state.lines.forEach(l => { if (isSelectableForActiveTab(l)) state.selectedLines.add(l.line_num); });
    recordSelectionHistory();
    syncCheckboxUI();
    const config = getActiveBatchConfig();
    flashHint(`Dipilih ${state.selectedLines.size} baris untuk ${config.tabLabel}.`);
  });
  ui.btnClearSelection?.addEventListener('click', () => {
    state.selectedLines.clear();
    recordSelectionHistory();
    syncCheckboxUI();
    flashHint('Pilihan baris dibatalkan.');
  });

  ui.btnSelectRange?.addEventListener('click', () => {
    const f = parseInt((ui.rangeFromInput as HTMLInputElement).value);
    const t = parseInt((ui.rangeToInput as HTMLInputElement).value);
    if (isNaN(f) || isNaN(t) || f > t) return alert('Range tidak valid.');
    state.selectedLines.clear();
    for (let i = f; i <= t; i++) {
      const l = state.lineByNum.get(i);
      if (l && isSelectableForActiveTab(l)) state.selectedLines.add(i);
    }
    recordSelectionHistory();
    syncCheckboxUI();
    const config = getActiveBatchConfig();
    flashHint(`Dipilih ${state.selectedLines.size} baris untuk ${config.tabLabel}.`);
    const mainScroller = getMainScroller();
    const targetIndex = state.displayRows.findIndex(row => row.type === 'line' && row.line?.line_num === f);
    if (targetIndex !== -1) {
      mainScroller.scrollToIndex(targetIndex);
      setTimeout(() => {
        const targetEl = document.querySelector(`input[data-num="${f}"]`);
        if (targetEl) {
          const rowEl = targetEl.closest('.preview-row') as HTMLElement;
          rowEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
          const originalBg = rowEl.style.backgroundColor;
          rowEl.style.transition = 'background-color 0.3s ease';
          rowEl.style.backgroundColor = 'rgba(200, 78, 24, 0.28)';
          setTimeout(() => { rowEl.style.backgroundColor = originalBg; }, 800);
        }
      }, 50);
    }
  });

  initSettingsTabs();
  ui.btnSettingsGeneral?.addEventListener('click', () => onOpenSettings('general'));
  ui.btnSettingsPrompts?.addEventListener('click', () => onOpenSettings('prompts'));
  ui.btnSettingsGlossary?.addEventListener('click', () => onOpenSettings('glossary'));
  ui.btnSettingsReset?.addEventListener('click', () => {
    const format = (ui.settingsAiTranslationFormatSelect as HTMLSelectElement)?.value || DEFAULT_AI_TRANSLATION_FORMAT;
    (ui.settingsPromptInput as HTMLTextAreaElement).value = getDefaultPromptHeaderForFormat(format);
    (ui.settingsEpubTagsInput as HTMLInputElement).value = 'p';
  });
  if (ui.settingsAiTranslationFormatSelect) {
    ui.settingsAiTranslationFormatSelect.addEventListener('change', () => {
      const format = (ui.settingsAiTranslationFormatSelect as HTMLSelectElement).value || DEFAULT_AI_TRANSLATION_FORMAT;
      const templateVal = (ui.settingsPromptTemplateSelect as HTMLSelectElement)?.value;
      const currentDefault = templateVal === 'kagikakko'
        ? getKagikakkoPromptHeaderForFormat(format)
        : getDefaultPromptHeaderForFormat(format);
      
      const allDefaults = [
        DEFAULT_PROMPT_HEADER_NUMBERED, DEFAULT_PROMPT_HEADER_BLOCK,
        DEFAULT_PROMPT_HEADER_XML, DEFAULT_PROMPT_HEADER_JSONL, DEFAULT_PROMPT_HEADER_JSON_ARRAY,
        DEFAULT_PROMPT_HEADER_NUMBERED_KAGIKAKKO, DEFAULT_PROMPT_HEADER_BLOCK_KAGIKAKKO,
        DEFAULT_PROMPT_HEADER_XML_KAGIKAKKO, DEFAULT_PROMPT_HEADER_JSONL_KAGIKAKKO, DEFAULT_PROMPT_HEADER_JSON_ARRAY_KAGIKAKKO,
      ];
      if (allDefaults.some(d => (ui.settingsPromptInput as HTMLTextAreaElement).value.trim() === d.trim()) ||
          (ui.settingsPromptInput as HTMLTextAreaElement).value.trim() === DEFAULT_PROMPT_HEADER_COMPLEX_ID.trim() ||
          (ui.settingsPromptInput as HTMLTextAreaElement).value.trim() === DEFAULT_PROMPT_HEADER_COMPLEX_EN.trim() ||
          (ui.settingsPromptInput as HTMLTextAreaElement).value.trim() === DEFAULT_PROMPT_HEADER_AERA_SIMPLE.trim()) {
        (ui.settingsPromptInput as HTMLTextAreaElement).value = currentDefault;
      }
    });
  }

  ui.settingsPromptTemplateSelect?.addEventListener('change', () => {
    const val = (ui.settingsPromptTemplateSelect as HTMLSelectElement).value;
    if (val === 'aera-simple') {
      (ui.settingsPromptInput as HTMLTextAreaElement).value = DEFAULT_PROMPT_HEADER_AERA_SIMPLE;
      if (ui.settingsSummaryPromptInput) {
        (ui.settingsSummaryPromptInput as HTMLTextAreaElement).value = DEFAULT_SUMMARY_PROMPT_AERA_SIMPLE;
      }
    } else if (val === 'complex-id') {
      (ui.settingsPromptInput as HTMLTextAreaElement).value = DEFAULT_PROMPT_HEADER_COMPLEX_ID;
    } else if (val === 'complex-en') {
      (ui.settingsPromptInput as HTMLTextAreaElement).value = DEFAULT_PROMPT_HEADER_COMPLEX_EN;
    } else if (val === 'kagikakko') {
      const format = (ui.settingsAiTranslationFormatSelect as HTMLSelectElement)?.value || DEFAULT_AI_TRANSLATION_FORMAT;
      (ui.settingsPromptInput as HTMLTextAreaElement).value = getKagikakkoPromptHeaderForFormat(format);
    } else {
      const format = (ui.settingsAiTranslationFormatSelect as HTMLSelectElement)?.value || DEFAULT_AI_TRANSLATION_FORMAT;
      (ui.settingsPromptInput as HTMLTextAreaElement).value = getDefaultPromptHeaderForFormat(format);
    }
  });

  ui.btnSettingsClearBackground?.addEventListener('click', () => {
    state.currentBackground = '';
    (ui.settingsBackgroundInput as HTMLTextAreaElement).value = '';
    import('./project').then(m => m.queueAutoSave());
    flashHint('Ringkasan cerita dikosongkan.');
  });

  ui.btnSettingsSummaryPromptReset?.addEventListener('click', () => {
    if (ui.settingsSummaryPromptInput) {
      (ui.settingsSummaryPromptInput as HTMLTextAreaElement).value = DEFAULT_SUMMARY_PROMPT;
    }
  });

  ui.btnSettingsGlossaryReset?.addEventListener('click', () => { (ui.settingsGlossaryPromptInput as HTMLTextAreaElement).value = DEFAULT_GLOSSARY_PROMPT; });
  ui.btnSettingsAiCheckReset?.addEventListener('click', () => { (ui.settingsAiCheckPromptInput as HTMLTextAreaElement).value = DEFAULT_AI_CHECK_PROMPT; });
  ui.btnSettingsAgentPromptReset?.addEventListener('click', () => { (ui.settingsAgentPromptInput as HTMLTextAreaElement).value = DEFAULT_AGENT_PROMPT; });
  ui.btnSettingsCancel?.addEventListener('click', () => {
    closeModal(ui.settingsModal as HTMLElement);
    if(ui.settingsPromptsModal) closeModal(ui.settingsPromptsModal as HTMLElement);
    if(ui.settingsGlossaryModal) closeModal(ui.settingsGlossaryModal as HTMLElement);
  });
  ui.btnSettingsPromptsCancel?.addEventListener('click', () => closeModal(ui.settingsPromptsModal as HTMLElement));
  ui.btnSettingsGlossaryCancel?.addEventListener('click', () => closeModal(ui.settingsGlossaryModal as HTMLElement));
  ui.btnSettingsSave?.addEventListener('click', onSavePromptSettings);
  ui.btnSettingsPromptsSave?.addEventListener('click', onSavePromptsSettings);
  ui.btnSettingsGlossarySave?.addEventListener('click', onSaveGlossarySettings);

  ui.btnShortcutsOpen?.addEventListener('click', () => Shortcuts.openModal());
  ui.btnWorkspaceShortcutsOpen?.addEventListener('click', () => Shortcuts.openModal());
  ui.btnShortcutsClose?.addEventListener('click', () => Shortcuts.closeModal());
  ui.btnShortcutsResetAll?.addEventListener('click', () => {
    if (!confirm('Kembalikan semua konfigurasi shortcut ke default?')) return;
    Shortcuts.resetBindings();
  });

  if (ui.settingsCheckLengthRatio) {
    ui.settingsCheckLengthRatio.addEventListener('change', () => {
      (document.getElementById('settingsLengthRatioWrap') as HTMLElement).style.display = (ui.settingsCheckLengthRatio as HTMLInputElement).checked ? 'flex' : 'none';
    });
  }
if (ui.settingsCheckSimilarity) {
    ui.settingsCheckSimilarity.addEventListener('change', () => {
      (ui.settingsSimilarityThresholdWrap as HTMLElement).style.display = (ui.settingsCheckSimilarity as HTMLInputElement).checked ? 'flex' : 'none';
    });
  }

  if (ui.settingsLucaProfileSelect) {
    ui.settingsLucaProfileSelect.addEventListener('change', () => {
      if (state.lines.length > 0) return;
      const profileId = (ui.settingsLucaProfileSelect as HTMLSelectElement).value || DEFAULT_LUCA_PROFILE;
      populateLucaExportSlotSelect(profileId);
      const profile = getLucaProfile(profileId);
      if (ui.settingsLucaMcWrap) (ui.settingsLucaMcWrap as HTMLElement).style.display = profile.nameAtFormat ? 'block' : 'none';
    });
  }

  ui.btnLineCancel?.addEventListener('click', () => closeModal(ui.lineEditorModal as HTMLElement));
  ui.btnLineSave?.addEventListener('click', onSaveLineEditor);
  ui.btnProofreadClose?.addEventListener('click', () => closeModal(ui.proofreadModal as HTMLElement));
  ui.btnProofreadReset?.addEventListener('click', onResetProofread);
  ui.btnProofreadIncludeAll?.addEventListener('click', onProofreadIncludeAll);
  ui.btnProofreadExcludeAll?.addEventListener('click', onProofreadExcludeAll);
  ui.btnProofreadReplaceAll?.addEventListener('click', onProofreadReplaceAll);

  const debouncedSearch = debounce(renderProofreadResults, 250);
  ui.proofreadSearchInput?.addEventListener('input', debouncedSearch);
  ui.proofreadSearchInput?.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      renderProofreadResults();
    }
  });
  ui.proofreadReplaceInput?.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      onProofreadReplaceAll();
    }
  });
  const onChangeProofreadSetting = () => {
    renderProofreadResults();
    queueAutoSave();
  };
  ui.proofreadScope?.addEventListener('change', onChangeProofreadSetting);
  ui.proofreadRegexCheck?.addEventListener('change', onChangeProofreadSetting);
  ui.proofreadCaseCheck?.addEventListener('change', onChangeProofreadSetting);
  ui.proofreadExactCheck?.addEventListener('change', onChangeProofreadSetting);
  ui.proofreadTranslatedOnlyCheck?.addEventListener('change', onChangeProofreadSetting);
  ui.proofreadJumpCheck?.addEventListener('change', onChangeProofreadSetting);
  ui.proofreadPreserveCaseCheck?.addEventListener('change', () => queueAutoSave());

  ui.btnQaCheck?.addEventListener('click', onOpenQa);
  ui.btnQaClose?.addEventListener('click', () => closeModal(ui.qaModal as HTMLElement));
  ui.btnQaReset?.addEventListener('click', onResetQa);
  ui.btnRunQa?.addEventListener('click', runQaCheck);
  document.getElementById('btnRetranslateFlagged')?.addEventListener('click', onRetranslateFlagged);

  // AI Check review mode buttons
  document.getElementById('btnReviewApply')?.addEventListener('click', () => {
    resolveReviewAction('apply');
    const reviewActions = document.getElementById('aiCheckReviewActions');
    if (reviewActions) reviewActions.style.display = 'none';
  });
  document.getElementById('btnReviewSkip')?.addEventListener('click', () => {
    resolveReviewAction('skip');
    const reviewActions = document.getElementById('aiCheckReviewActions');
    if (reviewActions) reviewActions.style.display = 'none';
  });


  ui.btnAutoTranslate?.addEventListener('click', onAutoTranslate);
  const modeSelect = document.getElementById('aiTranslateModeSelect') as HTMLSelectElement;
  if (modeSelect) {
    modeSelect.addEventListener('change', () => {
      state.aiTranslateMode = (modeSelect.value as 'auto' | 'agent');
      import('./auto-translate').then(m => m.saveApiSettings());
    });
  }
  const repeatCheck = (ui.checkAutoRepeatOnFailure || document.getElementById('checkAutoRepeatOnFailure')) as HTMLInputElement | null;
  if (repeatCheck) {
    repeatCheck.checked = !!state.autoRepeatOnFailure;
    repeatCheck.addEventListener('change', () => {
      state.autoRepeatOnFailure = repeatCheck.checked;
      const cached = ui.checkAutoRepeatOnFailure as HTMLInputElement | undefined;
      if (cached && cached !== repeatCheck) cached.checked = repeatCheck.checked;
      import('./auto-translate').then(m => m.saveApiSettings());
    });
  }
  ui.btnAutoGlossaryAi?.addEventListener('click', () => import('./auto-translate').then(m => m.onAutoGlossary()));
  ui.btnAutoAiCheck?.addEventListener('click', () => import('./auto-translate').then(m => m.onAutoAiCheck()));

  ui.btnTextReplacer?.addEventListener('click', () => {
    import('./project').then(m => m.openModal(ui.textReplacerModal as HTMLElement));
    (ui.replacerPreInput as HTMLTextAreaElement).value = state.preReplaceRules || '';
    (ui.replacerPostInput as HTMLTextAreaElement).value = state.postReplaceRules || '';
  });
  ui.btnTextReplacerCancel?.addEventListener('click', () => {
    import('./project').then(m => m.closeModal(ui.textReplacerModal as HTMLElement));
  });
  ui.btnTextReplacerSave?.addEventListener('click', () => {
    state.preReplaceRules = (ui.replacerPreInput as HTMLTextAreaElement).value;
    state.postReplaceRules = (ui.replacerPostInput as HTMLTextAreaElement).value;
    import('./project').then(m => {
      m.queueAutoSave();
      m.closeModal(ui.textReplacerModal as HTMLElement);
      import('./render').then(r => r.flashHint('Aturan Replacer berhasil disimpan.'));
    });
  });

  // File List
  ui.btnFileList?.addEventListener('click', () => openFileListModal());
  ui.btnFileListClose?.addEventListener('click', () => closeFileListModal());
  ui.btnFileListAdd?.addEventListener('click', () => onAddFile());
  ui.btnFileListDelete?.addEventListener('click', () => onDeleteSelectedFiles());

  let isDraggingRobot = false;
  let robotStartX = 0, robotStartY = 0;
  let initialLeft = 0, initialTop = 0;

  if (ui.btnFloatingApiSettings) {
    const btn = ui.btnFloatingApiSettings as HTMLElement;
    const onStart = (e: MouseEvent | TouchEvent) => {
      isDraggingRobot = false;
      const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX;
      const clientY = 'touches' in e ? e.touches[0].clientY : e.clientY;
      robotStartX = clientX;
      robotStartY = clientY;
      const rect = btn.getBoundingClientRect();
      initialLeft = rect.left;
      initialTop = rect.top;

      const onMove = (moveEvent: MouseEvent | TouchEvent) => {
        const moveX = 'touches' in moveEvent ? moveEvent.touches[0].clientX : moveEvent.clientX;
        const moveY = 'touches' in moveEvent ? moveEvent.touches[0].clientY : moveEvent.clientY;
        const dx = moveX - robotStartX;
        const dy = moveY - robotStartY;
        if (Math.abs(dx) > 5 || Math.abs(dy) > 5) {
          isDraggingRobot = true;
          moveEvent.preventDefault();
          let newLeft = initialLeft + dx;
          let newTop = initialTop + dy;
          newLeft = Math.max(0, Math.min(window.innerWidth - btn.offsetWidth, newLeft));
          newTop = Math.max(0, Math.min(window.innerHeight - btn.offsetHeight, newTop));
          btn.style.left = newLeft + 'px';
          btn.style.top = newTop + 'px';
          btn.style.bottom = 'auto';
          btn.style.right = 'auto';
        }
      };

      const onEnd = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onEnd);
        document.removeEventListener('touchmove', onMove);
        document.removeEventListener('touchend', onEnd);
        if (isDraggingRobot) {
          setTimeout(() => { isDraggingRobot = false; }, 50);
        }
      };

      document.addEventListener('mousemove', onMove, { passive: false });
      document.addEventListener('mouseup', onEnd);
      document.addEventListener('touchmove', onMove, { passive: false });
      document.addEventListener('touchend', onEnd);
    };

    btn.addEventListener('mousedown', onStart);
    btn.addEventListener('touchstart', onStart, { passive: false });

    btn.addEventListener('click', (e) => {
      if (isDraggingRobot) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      onOpenApiSettings();
    });
  }

  ui.btnApiSettingsCancel?.addEventListener('click', () => closeModal(ui.apiSettingsModal as HTMLElement));
  ui.btnApiSettingsSave?.addEventListener('click', onSaveApiSettings);
  ui.btnFetchModels?.addEventListener('click', onFetchModels);
  ui.apiRpmInput?.addEventListener('input', updateDelayPreview);
  ui.btnLoadProfile?.addEventListener('click', onLoadProfile);
  ui.btnDeleteProfile?.addEventListener('click', onDeleteProfile);
  ui.btnSaveProfile?.addEventListener('click', onSaveProfile);
  ui.apiProfileSelect?.addEventListener('change', updateProfileButtonsState);

  if (ui.btnFloatingLogging) {
    const btn = ui.btnFloatingLogging as HTMLElement;
    let dragging = false;
    let moved = false;
    let startX = 0, startY = 0, initialLeft = 0, initialTop = 0;
    const onStart = (event: MouseEvent | TouchEvent) => {
      dragging = false;
      moved = false;
      const point = 'touches' in event ? event.touches[0] : event;
      startX = point.clientX;
      startY = point.clientY;
      const rect = btn.getBoundingClientRect();
      initialLeft = rect.left;
      initialTop = rect.top;
      const onMove = (moveEvent: MouseEvent | TouchEvent) => {
        const movePoint = 'touches' in moveEvent ? moveEvent.touches[0] : moveEvent;
        const dx = movePoint.clientX - startX;
        const dy = movePoint.clientY - startY;
        if (Math.abs(dx) > 5 || Math.abs(dy) > 5) {
          dragging = true;
          moved = true;
          moveEvent.preventDefault();
          btn.style.left = `${Math.max(0, Math.min(window.innerWidth - btn.offsetWidth, initialLeft + dx))}px`;
          btn.style.top = `${Math.max(0, Math.min(window.innerHeight - btn.offsetHeight, initialTop + dy))}px`;
          btn.style.right = 'auto';
          btn.style.bottom = 'auto';
        }
      };
      const onEnd = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onEnd);
        document.removeEventListener('touchmove', onMove);
        document.removeEventListener('touchend', onEnd);
        if (dragging) setTimeout(() => { moved = false; }, 50);
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onEnd);
      document.addEventListener('touchmove', onMove, { passive: false });
      document.addEventListener('touchend', onEnd);
    };
    btn.addEventListener('mousedown', onStart);
    btn.addEventListener('touchstart', onStart, { passive: false });
    btn.addEventListener('click', (event) => {
      if (moved) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      const panel = ui.loggingPanel as HTMLElement;
      panel.style.display = panel.style.display === 'none' ? 'flex' : 'none';
    });
  }
  ui.btnLoggingClose?.addEventListener('click', () => { (ui.loggingPanel as HTMLElement).style.display = 'none'; });
  ui.btnLoggingClear?.addEventListener('click', () => { if (ui.loggingHistory) (ui.loggingHistory as HTMLElement).textContent = ''; });

  // AI Agent Events
  let isDraggingChat = false;
  let chatStartX = 0, chatStartY = 0;
  let chatInitLeft = 0, chatInitTop = 0;

  if (ui.btnFloatingAiAgent) {
    const btn = ui.btnFloatingAiAgent as HTMLElement;
    const onStart = (e: MouseEvent | TouchEvent) => {
      isDraggingChat = false;
      const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX;
      const clientY = 'touches' in e ? e.touches[0].clientY : e.clientY;
      chatStartX = clientX;
      chatStartY = clientY;
      const rect = btn.getBoundingClientRect();
      chatInitLeft = rect.left;
      chatInitTop = rect.top;

      const onMove = (moveEvent: MouseEvent | TouchEvent) => {
        const moveX = 'touches' in moveEvent ? moveEvent.touches[0].clientX : moveEvent.clientX;
        const moveY = 'touches' in moveEvent ? moveEvent.touches[0].clientY : moveEvent.clientY;
        const dx = moveX - chatStartX;
        const dy = moveY - chatStartY;
        if (Math.abs(dx) > 5 || Math.abs(dy) > 5) {
          isDraggingChat = true;
          moveEvent.preventDefault();
          let newLeft = chatInitLeft + dx;
          let newTop = chatInitTop + dy;
          newLeft = Math.max(0, Math.min(window.innerWidth - btn.offsetWidth, newLeft));
          newTop = Math.max(0, Math.min(window.innerHeight - btn.offsetHeight, newTop));
          btn.style.left = newLeft + 'px';
          btn.style.top = newTop + 'px';
          btn.style.bottom = 'auto';
          btn.style.right = 'auto';
        }
      };

      const onEnd = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onEnd);
        document.removeEventListener('touchmove', onMove);
        document.removeEventListener('touchend', onEnd);
        if (isDraggingChat) {
          setTimeout(() => { isDraggingChat = false; }, 50);
        }
      };

      document.addEventListener('mousemove', onMove, { passive: false });
      document.addEventListener('mouseup', onEnd);
      document.addEventListener('touchmove', onMove, { passive: false });
      document.addEventListener('touchend', onEnd);
    };

    btn.addEventListener('mousedown', onStart);
    btn.addEventListener('touchstart', onStart, { passive: false });

    btn.addEventListener('click', async (e) => {
      if (isDraggingChat) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      const panel = ui.aiAgentChatPanel as HTMLElement;
      const isHidden = panel.style.display === 'none';
      panel.style.display = isHidden ? 'flex' : 'none';
      if (isHidden) {
        const { loadChatHistory, renderChatHistory } = await import('./ai-agent');
        loadChatHistory();
        renderChatHistory();
      }
    });
  }

  ui.btnAgentClose?.addEventListener('click', () => {
    (ui.aiAgentChatPanel as HTMLElement).style.display = 'none';
  });
  // Make the AI Agent chat panel draggable by its header, mirroring the robot icon.
  if (ui.aiAgentChatPanel) {
    const panel = ui.aiAgentChatPanel as HTMLElement;
    const header = panel.querySelector<HTMLElement>('.agent-header');
    if (header) {
      let isDraggingPanel = false;
      let panelStartX = 0, panelStartY = 0;
      let panelInitLeft = 0, panelInitTop = 0;

      const onPanelStart = (e: MouseEvent | TouchEvent) => {
        // Ignore presses that start on the header buttons (clear/close).
        const target = e.target as HTMLElement;
        if (target.closest('button')) return;
        isDraggingPanel = false;
        const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX;
        const clientY = 'touches' in e ? e.touches[0].clientY : e.clientY;
        panelStartX = clientX;
        panelStartY = clientY;
        const rect = panel.getBoundingClientRect();
        panelInitLeft = rect.left;
        panelInitTop = rect.top;

        const onPanelMove = (moveEvent: MouseEvent | TouchEvent) => {
          const moveX = 'touches' in moveEvent ? moveEvent.touches[0].clientX : moveEvent.clientX;
          const moveY = 'touches' in moveEvent ? moveEvent.touches[0].clientY : moveEvent.clientY;
          const dx = moveX - panelStartX;
          const dy = moveY - panelStartY;
          if (Math.abs(dx) > 5 || Math.abs(dy) > 5) {
            isDraggingPanel = true;
            moveEvent.preventDefault();
            let newLeft = panelInitLeft + dx;
            let newTop = panelInitTop + dy;
            newLeft = Math.max(0, Math.min(window.innerWidth - panel.offsetWidth, newLeft));
            newTop = Math.max(0, Math.min(window.innerHeight - panel.offsetHeight, newTop));
            panel.style.left = newLeft + 'px';
            panel.style.top = newTop + 'px';
            panel.style.bottom = 'auto';
            panel.style.right = 'auto';
            header.style.cursor = 'grabbing';
          }
        };

        const onPanelEnd = () => {
          document.removeEventListener('mousemove', onPanelMove);
          document.removeEventListener('mouseup', onPanelEnd);
          document.removeEventListener('touchmove', onPanelMove);
          document.removeEventListener('touchend', onPanelEnd);
          header.style.cursor = 'grab';
          if (isDraggingPanel) {
            setTimeout(() => { isDraggingPanel = false; }, 50);
          }
        };

        document.addEventListener('mousemove', onPanelMove, { passive: false });
        document.addEventListener('mouseup', onPanelEnd);
        document.addEventListener('touchmove', onPanelMove, { passive: false });
        document.addEventListener('touchend', onPanelEnd);
      };

      header.addEventListener('mousedown', onPanelStart);
      header.addEventListener('touchstart', onPanelStart, { passive: false });
    }
  }

  // Make the logging panel draggable by its header.
  if (ui.loggingPanel) {
    const panel = ui.loggingPanel as HTMLElement;
    const header = panel.querySelector<HTMLElement>('.agent-header');
    if (header) {
      let startX = 0, startY = 0, initialLeft = 0, initialTop = 0;
      const onStart = (event: MouseEvent | TouchEvent) => {
        if ((event.target as HTMLElement).closest('button')) return;
        const point = 'touches' in event ? event.touches[0] : event;
        startX = point.clientX;
        startY = point.clientY;
        const rect = panel.getBoundingClientRect();
        initialLeft = rect.left;
        initialTop = rect.top;
        header.style.cursor = 'grabbing';
        const onMove = (moveEvent: MouseEvent | TouchEvent) => {
          const movePoint = 'touches' in moveEvent ? moveEvent.touches[0] : moveEvent;
          const dx = movePoint.clientX - startX;
          const dy = movePoint.clientY - startY;
          if (Math.abs(dx) <= 3 && Math.abs(dy) <= 3) return;
          moveEvent.preventDefault();
          panel.style.left = `${Math.max(0, Math.min(window.innerWidth - panel.offsetWidth, initialLeft + dx))}px`;
          panel.style.top = `${Math.max(0, Math.min(window.innerHeight - panel.offsetHeight, initialTop + dy))}px`;
          panel.style.right = 'auto';
          panel.style.bottom = 'auto';
        };
        const onEnd = () => {
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onEnd);
          document.removeEventListener('touchmove', onMove);
          document.removeEventListener('touchend', onEnd);
          header.style.cursor = 'grab';
        };
        document.addEventListener('mousemove', onMove, { passive: false });
        document.addEventListener('mouseup', onEnd);
        document.addEventListener('touchmove', onMove, { passive: false });
        document.addEventListener('touchend', onEnd);
      };
      header.style.cursor = 'grab';
      header.addEventListener('mousedown', onStart);
      header.addEventListener('touchstart', onStart, { passive: false });
    }
  }

  ui.btnAgentClear?.addEventListener('click', async () => {
    if (!confirm('Hapus semua riwayat chat untuk proyek ini?')) return;
    const { clearChatHistory } = await import('./ai-agent');
    clearChatHistory();
  });

  // ── Agent Memory UI ──
  function renderAgentMemoryList(): void {
    const listEl = ui.agentMemoryList as HTMLElement;
    if (!listEl) return;
    listEl.innerHTML = '';
    if (!state.agentMemories.length) {
      listEl.innerHTML = '<p class="hint">Belum ada memori tersimpan.</p>';
      return;
    }
    for (const m of state.agentMemories) {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex; gap:8px; align-items:flex-start; padding:8px; border-bottom:1px solid var(--border-base);';
      const info = document.createElement('div');
      info.style.flex = '1';
      const meta = document.createElement('span');
      meta.style.cssText = 'opacity:0.6;font-size:0.85em;';
      meta.textContent = `[${m.scope}/${m.category}] `;
      const key = document.createElement('strong');
      key.textContent = m.key;
      const value = document.createElement('span');
      value.style.fontSize = '0.9em';
      value.textContent = m.value;
      info.append(meta, key, document.createElement('br'), value);
      row.appendChild(info);
      const editBtn = document.createElement('button');
      editBtn.className = 'icon-btn';
      editBtn.innerHTML = '<svg class="lucide-icon" xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z" /><path d="m15 5 4 4" /></svg>';
      editBtn.title = 'Edit';
      editBtn.onclick = () => {
        (ui.agentMemoryKey as HTMLInputElement).value = m.key;
        (ui.agentMemoryValue as HTMLTextAreaElement).value = m.value;
        (ui.agentMemoryCategory as HTMLSelectElement).value = m.category;
        (ui.agentMemoryScope as HTMLSelectElement).value = m.scope;
      };
      row.appendChild(editBtn);
      const delBtn = document.createElement('button');
      delBtn.className = 'icon-btn';
      delBtn.innerHTML = '<svg class="lucide-icon" xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 11v6" /><path d="M14 11v6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /><path d="M3 6h18" /><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /></svg>';
      delBtn.title = 'Hapus';
      delBtn.onclick = () => {
        state.agentMemories = state.agentMemories.filter(x => x.key !== m.key || x.scope !== m.scope);
        // Persist
        const scopeMems = state.agentMemories.filter(x => x.scope === m.scope);
        try {
          const key = m.scope === 'global' ? 'cstl_agent_memory_global' : `cstl_agent_memory_${state.currentProjectId}`;
          localStorage.setItem(key, JSON.stringify(scopeMems));
        } catch {}
        renderAgentMemoryList();
      };
      row.appendChild(delBtn);
      listEl.appendChild(row);
    }
  }

  const openAgentMemoryModal = () => {
    renderAgentMemoryList();
    openModal(ui.agentMemoryModal as HTMLElement);
  };
  ui.btnAgentMemory?.addEventListener('click', openAgentMemoryModal);
  ui.btnAiCheckOpenMemoryModal?.addEventListener('click', openAgentMemoryModal);
  ui.btnOpenAgentMemoryFromSettings?.addEventListener('click', openAgentMemoryModal);
  ui.btnAgentMemoryCancel?.addEventListener('click', () => {
    closeModal(ui.agentMemoryModal as HTMLElement);
  });
  ui.agentMemoryModal?.addEventListener('click', (e: MouseEvent) => {
    if (e.target === ui.agentMemoryModal) {
      closeModal(ui.agentMemoryModal as HTMLElement);
    }
  });
  ui.btnAgentMemorySave?.addEventListener('click', async () => {
    const key = (ui.agentMemoryKey as HTMLInputElement).value.trim();
    const value = (ui.agentMemoryValue as HTMLTextAreaElement).value.trim();
    const category = (ui.agentMemoryCategory as HTMLSelectElement).value;
    const scope = (ui.agentMemoryScope as HTMLSelectElement).value as 'global' | 'project';
    if (!key || !value) { alert('Key dan value tidak boleh kosong.'); return; }
    const now = Date.now();
    const existing = state.agentMemories.findIndex(m => m.key === key && m.scope === scope);
    if (existing >= 0) {
      state.agentMemories[existing].value = value;
      state.agentMemories[existing].category = category as any;
      state.agentMemories[existing].updated = now;
    } else {
      state.agentMemories.push({ key, value, category: category as any, scope, created: now, updated: now });
    }
    const scopeMems = state.agentMemories.filter(m => m.scope === scope);
    try {
      const storageKey = scope === 'global' ? 'cstl_agent_memory_global' : `cstl_agent_memory_${state.currentProjectId}`;
      localStorage.setItem(storageKey, JSON.stringify(scopeMems));
    } catch {}
    (ui.agentMemoryKey as HTMLInputElement).value = '';
    (ui.agentMemoryValue as HTMLTextAreaElement).value = '';
    renderAgentMemoryList();
  });

  const doAgentSend = async () => {
    const input = ui.agentInput as HTMLTextAreaElement;
    const text = input.value.trim();
    if (!text) return;
    
    input.value = '';
    
    const historyEl = ui.agentChatHistory as HTMLElement;
    const userDiv = document.createElement('div');
    userDiv.className = 'agent-msg user';
    userDiv.textContent = text;
    historyEl.appendChild(userDiv);
    historyEl.scrollTop = historyEl.scrollHeight;
    
    const respDiv = document.createElement('div');
    respDiv.className = 'agent-msg system';
    respDiv.textContent = 'Agent is thinking...';
    historyEl.appendChild(respDiv);
    historyEl.scrollTop = historyEl.scrollHeight;
    
    const sendAgentMessage = (await import('./ai-agent')).sendAgentMessage;

    // Disable input while agent runs
    const sendBtn = ui.btnAgentSend as HTMLButtonElement | null;
    if (sendBtn) sendBtn.disabled = true;
    input.disabled = true;

    try {
      await sendAgentMessage(text, (msg, role, meta) => {
        respDiv.className = `agent-msg ${role}`;
        if (meta?.streaming) respDiv.classList.add('streaming');
        else respDiv.classList.remove('streaming');

        let html = msg
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/\n/g, '<br>')
          .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
          .replace(/\*(.*?)\*/g, '<em>$1</em>')
          .replace(/`(.*?)`/g, '<code>$1</code>');

        respDiv.innerHTML = html;
        historyEl.scrollTop = historyEl.scrollHeight;
      });
      respDiv.classList.remove('streaming');
    } catch (e: any) {
      respDiv.className = 'agent-msg system';
      respDiv.classList.remove('streaming');
      respDiv.style.color = 'var(--danger)';
      respDiv.textContent = `Error: ${e.message}`;
    } finally {
      if (sendBtn) sendBtn.disabled = false;
      input.disabled = false;
      input.focus();
    }
  };

  ui.btnAgentSend?.addEventListener('click', doAgentSend);
  ui.agentInput?.addEventListener('keydown', (e: Event) => {
    const ke = e as KeyboardEvent;
    if (ke.key === 'Enter' && !ke.shiftKey) {
      ke.preventDefault();
      doAgentSend();
    }
  });

  // Bookmark Feature Events
  ui.btnToolbarBookmark?.addEventListener('click', () => {
    import('./bookmark').then(m => m.openBookmarkModal());
  });
  ui.btnLineBookmark?.addEventListener('click', () => {
    const num = getActiveLineEditorLineNum();
    if (!num) return;
    import('./bookmark').then(m => {
      m.toggleBookmark(num);
      const l = state.lineByNum.get(num);
      if (ui.btnLineBookmark && l) {
        const isBm = !!l.bookmarked;
        (ui.btnLineBookmark as HTMLElement).classList.toggle('is-bookmarked', isBm);
        const txt = document.getElementById('lineBookmarkBtnText');
        if (txt) txt.textContent = isBm ? 'Tersimpan' : 'Bookmark';
      }
    });
  });
  ui.btnBookmarkClose?.addEventListener('click', () => {
    import('./bookmark').then(m => m.closeBookmarkModal());
  });
  ui.btnBookmarkModalCloseIcon?.addEventListener('click', () => {
    import('./bookmark').then(m => m.closeBookmarkModal());
  });
  ui.btnClearAllBookmarks?.addEventListener('click', () => {
    import('./bookmark').then(m => m.clearAllBookmarks());
  });
  ui.bookmarkModal?.addEventListener('click', (e: MouseEvent) => {
    if (e.target === ui.bookmarkModal) {
      import('./bookmark').then(m => m.closeBookmarkModal());
    }
  });
  ui.bookmarkSearchInput?.addEventListener('input', debounce((e: Event) => {
    const val = (e.target as HTMLInputElement).value;
    import('./bookmark').then(m => m.renderBookmarkList(val));
  }, 150));
}

// ─── Bootstrap ────────────────────────────────────────────────────────────────

// ─── Color Palette System ────────────────────────────────────────────────────
interface ColorPalette {
  '--bg': string; '--bg-2': string; '--panel': string; '--panel-2': string;
  '--line': string; '--line-2': string; '--primary': string; '--primary-hover': string;
  '--primary-soft': string; '--accent': string;
}

const PALETTES: Record<string, ColorPalette> = {
  indigo: {
    '--bg': '#0f0e0d', '--bg-2': '#161412', '--panel': '#1d1b19', '--panel-2': '#26231f',
    '--line': '#332f2b', '--line-2': '#43403c', '--primary': '#c84e18', '--primary-hover': '#a93f12',
    '--primary-soft': 'rgba(200, 78, 24, 0.14)', '--accent': '#b9975b',
  },
  ocean: {
    '--bg': '#0e1418', '--bg-2': '#121a1e', '--panel': '#182025', '--panel-2': '#1e2a30',
    '--line': '#2a363c', '--line-2': '#34444c', '--primary': '#1e6b8a', '--primary-hover': '#16546e',
    '--primary-soft': 'rgba(30,107,138,0.16)', '--accent': '#8fb4c0',
  },
  forest: {
    '--bg': '#0e1210', '--bg-2': '#121814', '--panel': '#181e1a', '--panel-2': '#1f2822',
    '--line': '#2c352e', '--line-2': '#36443a', '--primary': '#3d6b4a', '--primary-hover': '#2f5239',
    '--primary-soft': 'rgba(61,107,74,0.16)', '--accent': '#9ab89e',
  },
  sunset: {
    '--bg': '#14100e', '--bg-2': '#1a1410', '--panel': '#201a16', '--panel-2': '#2a211c',
    '--line': '#352e28', '--line-2': '#443c34', '--primary': '#8a4a1a', '--primary-hover': '#6e3b15',
    '--primary-soft': 'rgba(138,74,26,0.16)', '--accent': '#c9a47a',
  },
  rose: {
    '--bg': '#141012', '--bg-2': '#1a1416', '--panel': '#201a1c', '--panel-2': '#2a2024',
    '--line': '#352a2e', '--line-2': '#44383c', '--primary': '#8b2d3a', '--primary-hover': '#6e2430',
    '--primary-soft': 'rgba(139,45,58,0.16)', '--accent': '#c49aa0',
  },
};

function applyPalette(name: string): void {
  // Resolve the key first so an unknown name falls back fully to indigo (icon included).
  const paletteKey = PALETTES[name] ? name : 'indigo';
  const palette = PALETTES[paletteKey];
  const root = document.documentElement;
  const hasPluginTheme = (window as any).CSTL?.plugins?.hasActiveTheme?.();
  if (!hasPluginTheme) {
    for (const [key, value] of Object.entries(palette)) {
      root.style.setProperty(key, value);
    }
  } else {
    for (const key of Object.keys(palette)) {
      root.style.removeProperty(key);
    }
  }
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', palette['--bg']);

  const iconUrl = `./icon-${paletteKey}.svg`;
  const logoImg = document.querySelector('.hero-logo-img') as HTMLImageElement | null;
  if (logoImg) logoImg.src = iconUrl;
  const favicon = document.querySelector('link[rel="icon"]') as HTMLLinkElement | null;
  if (favicon) favicon.href = iconUrl;
}

function loadPalette(): void {
  const saved = localStorage.getItem('cstl_color_palette') || 'indigo';
  applyPalette(saved);
  const select = document.getElementById('paletteSelect') as HTMLSelectElement;
  if (select) select.value = saved;
}

export async function init(): Promise<void> {
  const globalWindow = window as any;
  if (globalWindow.__cstlInitialized) return;
  globalWindow.__cstlInitialized = true;

  // Register PWA service worker
  if ('serviceWorker' in navigator) {
    import('virtual:pwa-register').then(({ registerSW }) => {
      registerSW({ immediate: true });
    }).catch(console.error);
  }

  loadPalette();
  cacheElements();
  initScrollers();
  bindEvents();

  if (!navigator.storage || !navigator.storage.getDirectory) {
    alert('Browser kamu tidak mendukung Sistem File OPFS. Beberapa fitur tidak akan berjalan optimal.');
    (ui.projectList as HTMLElement).innerHTML = `<p class="hint" style="grid-column: 1/-1; color: var(--danger);">Browser tidak mendukung OPFS. Sistem penyimpanan tidak dapat diakses.</p>`;
  } else {
    // OPFS is best-effort by default: under disk pressure the browser may evict
    // the whole origin's storage without any user action. Ensure persistent storage.
    ensureStoragePersistence().catch(() => {});
    checkStorageQuota().then(quota => {
      if (quota && quota.isLow) {
        const banner = document.getElementById('storageWarningBanner');
        const text = document.getElementById('storageWarningText');
        if (banner && text) {
          banner.style.display = 'block';
          const freeMB = Math.round(quota.free / (1024 * 1024));
          text.textContent = `Peringatan: Penyimpanan browser hampir penuh (${quota.percentUsed.toFixed(0)}% terpakai, sisa ~${freeMB} MB). Harap lakukan backup proyek Anda ke .zip!`;
        }
      }
    }).catch(() => {});

    await loadDashboardProjects();
  }

  loadApiSettings();
  initDictionary();
  initCustomParserModal();
  updateCustomImportAccept();
  setPyodideColdStartHint(() => flashHint('Memuat runtime Python (pyodide ~10MB, hanya sekali) — butuh internet...', true));

  // Initialize CSTL Plugins
  try {
    const bridge = createPluginHostBridge();
    (window as any).CSTL?.plugins?.attach(bridge);
    await (window as any).CSTL?.plugins?.init();
  } catch (err) {
    console.warn('[CSTL] Plugin initialization error:', err);
  }

  // Initialize Shortcuts
  Shortcuts.init();

  // Initialize OPFS Explorer
  OpfsExplorer.init();
}


