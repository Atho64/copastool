import { state } from './state';

export type ReasoningEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

const OPENAI_REASONING_MODEL = /(^|[\/:_-])(o1|o3|o4|gpt-5(?:\.|-|$)|gpt-oss(?:-|$))/i;

export function isOpenAIReasoningModel(model: string): boolean {
  return OPENAI_REASONING_MODEL.test(model || '');
}

function selectedEffort(): ReasoningEffort {
  if (state.aiReasoningEffort !== 'default') return state.aiReasoningEffort;
  return 'high';
}

function openAiEffort(): Exclude<ReasoningEffort, 'xhigh'> | 'xhigh' {
  return selectedEffort();
}

export function applyOpenAIOptions(body: Record<string, any>, model: string, apiUrl: string): void {
  const reasoningModel = isOpenAIReasoningModel(model);
  // Several reasoning endpoints reject sampling controls. Preserve them for regular chat models.
  if (!reasoningModel) {
    body.temperature = state.aiTemperature;
    body.top_p = state.aiTopP;
  }
  if (state.aiMaxTokens > 0) {
    body[reasoningModel ? 'max_completion_tokens' : 'max_tokens'] = state.aiMaxTokens;
  }
  if (state.aiFrequencyPenalty !== 0) body.frequency_penalty = state.aiFrequencyPenalty;
  if (state.aiPresencePenalty !== 0) body.presence_penalty = state.aiPresencePenalty;
  if (state.aiSeed !== null) body.seed = state.aiSeed;

  if (state.aiThinkingMode === 'default' && state.aiReasoningEffort === 'default') return;
  const enabled = state.aiThinkingMode !== 'off';
  if (/localhost|127\.0\.0\.1|11434/i.test(apiUrl)) {
    body.think = enabled;
  } else if (/openrouter\.ai/i.test(apiUrl)) {
    body.reasoning = enabled ? { effort: selectedEffort() } : { effort: 'none' };
  } else if (reasoningModel || state.aiReasoningEffort !== 'default') {
    // `low` is the broadest compatible way to minimize native reasoning models;
    // some o-series endpoints do not accept `none` or sampling controls.
    body.reasoning_effort = enabled ? openAiEffort() : 'low';
  }
}

export function applyAnthropicOptions(body: Record<string, any>): void {
  body.max_tokens = Math.max(1, state.aiMaxTokens);
  body.temperature = state.aiTemperature;
  if (state.aiTopP < 1) body.top_p = state.aiTopP;
  if (state.aiThinkingMode !== 'off' && (state.aiThinkingMode === 'on' || state.aiReasoningEffort !== 'default')) {
    const effort = selectedEffort();
    const budgets: Record<ReasoningEffort, number> = { minimal: 1024, low: 2048, medium: 4096, high: 8192, xhigh: 16384 };
    const budget = Math.min(budgets[effort], Math.max(1024, body.max_tokens - 1));
    body.max_tokens = Math.max(body.max_tokens, budget + 1);
    body.thinking = { type: 'enabled', budget_tokens: budget };
    // Extended thinking is incompatible with non-default temperature on native Anthropic.
    delete body.temperature;
    delete body.top_p;
  }
}

export function applyGeminiOptions(generationConfig: Record<string, any>, model = state.aiModel): void {
  generationConfig.temperature = state.aiTemperature;
  generationConfig.topP = state.aiTopP;
  generationConfig.maxOutputTokens = Math.max(1, state.aiMaxTokens);
  if (state.aiFrequencyPenalty !== 0) generationConfig.frequencyPenalty = state.aiFrequencyPenalty;
  if (state.aiPresencePenalty !== 0) generationConfig.presencePenalty = state.aiPresencePenalty;
  if (state.aiSeed !== null) generationConfig.seed = state.aiSeed;
  const isGemma4 = /^gemma-4(?:-|$)/i.test(model || '');
  if (isGemma4) {
    // Gemma 4 uses thinkingLevel, not Gemini 2.x's thinkingBudget.
    if (state.aiThinkingMode !== 'default' || state.aiReasoningEffort !== 'default') {
      generationConfig.thinkingConfig = {
        thinkingLevel: state.aiThinkingMode === 'off' ? 'minimal' : selectedEffort() === 'minimal' ? 'minimal' : 'high',
      };
    }
    return;
  }
  if (state.aiThinkingMode !== 'default' || state.aiReasoningEffort !== 'default') {
    const effort = selectedEffort();
    const budgets: Record<ReasoningEffort, number> = { minimal: 1024, low: 2048, medium: 4096, high: 8192, xhigh: 16384 };
    generationConfig.thinkingConfig = {
      thinkingBudget: state.aiThinkingMode === 'off' ? 0 : Math.min(budgets[effort], state.aiMaxTokens),
    };
  }
}
