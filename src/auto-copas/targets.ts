// @module auto-copas/targets.ts — per-site automation table for Auto Copas.
//
// Selectors and timing are ported from the cstl-extension reference
// (src/shared/targets-config.ts + per-target content scripts), which were
// battle-tested against each site's markup — including Indonesian locale
// labels ("Kirim", "Salin", "Hentikan"). Sites drift constantly; keep the
// fallback chains broad.

export type CopasTargetId = 'gemini' | 'chatgpt' | 'deepseek' | 'arena';

export interface CopasTargetConfig {
  id: CopasTargetId;
  label: string;
  /** Canonical chat URL opened for a fresh conversation / first login. */
  url: string;
  /** Hostname prefix used to recognize "our" tab in the driver's tab list. */
  urlPrefix: string;
  /** Composer candidates, tried in order (first visible match wins). */
  composer: string[];
  /** Send button candidates (fallback when Enter does not start a run). */
  sendButton: string[];
  /** "Stop generating" indicators — visible => still streaming. */
  stop: string[];
  /** Assistant message containers, ordered; the LAST visible match is ours. */
  assistant: string[];
  /**
   * true  => only a visible Stop control means "generating" (the site keeps its
   *          send button enabled while streaming — DeepSeek, Arena).
   * false => an ENABLED send button also counts as idle (Gemini, ChatGPT
   *          hide/disable send while streaming).
   */
  preferStop: boolean;
  /** Consecutive idle samples required before a response counts as done. */
  idleNeeded: number;
  /** Response text must be unchanged this long (ms) before we copy it. */
  stableMs: number;
  /** Sleep after Enter before polling starts (lets the request register). */
  preSendSettleMs: number;
  /** Extra composer-attachment recovery (ChatGPT turns long pastes into a
   * document card with a "show in text field" button). */
  attachmentRecovery: boolean;
  /** Accessible-label text of the sidebar "New chat" control (lowercase,
   * EN + ID). Used by the new-chat page script; navigation is the fallback. */
  newChatLabels: string[];
}

const GENERIC_STOP = [
  'button[aria-label*="Stop" i]',
  'button[aria-label*="Hentikan" i]',
  'button[aria-label*="Berhenti" i]',
  '[data-testid*="stop" i]',
];

export const COPAS_TARGETS: Record<CopasTargetId, CopasTargetConfig> = {
  gemini: {
    id: 'gemini',
    label: 'Gemini',
    url: 'https://gemini.google.com/app',
    urlPrefix: 'https://gemini.google.com',
    composer: [
      'div.ql-editor.textarea[contenteditable="true"]',
      'rich-textarea div[contenteditable="true"]',
      'div[contenteditable="true"][aria-label*="prompt" i]',
      'div[contenteditable="true"][aria-label*="Enter" i]',
      'div[contenteditable="true"].ql-editor',
      'div[contenteditable="true"]',
    ],
    sendButton: [
      'button[aria-label*="Send" i]',
      'button[aria-label*="Kirim" i]',
      'button.send-button',
      'button[mattooltip*="Send" i]',
    ],
    stop: [
      'button[aria-label*="Stop generating" i]',
      'button[aria-label*="Hentikan pembuatan" i]',
      '.stop-generating-button',
      '[data-testid="stop-button"]',
    ],
    assistant: [
      'model-response .markdown',
      'message-content.model-response-text',
      '.model-response-text',
      '[data-message-author-role="model"]',
      'model-response',
      '.response-container',
    ],
    preferStop: false,
    idleNeeded: 2,
    stableMs: 1800,
    preSendSettleMs: 1200,
    attachmentRecovery: false,
    newChatLabels: ['new chat', 'chat baru', 'percakapan baru'],
  },

  chatgpt: {
    id: 'chatgpt',
    label: 'ChatGPT',
    url: 'https://chatgpt.com/',
    urlPrefix: 'https://chatgpt.com',
    composer: [
      '#prompt-textarea',
      'div[contenteditable="true"]#prompt-textarea',
      'div[contenteditable="true"][aria-label*="Message" i]',
      'textarea[placeholder*="Message" i]',
      'div[contenteditable="true"]',
    ],
    sendButton: [
      'button[data-testid="send-button"]',
      'button[aria-label*="Send" i]',
      'button[aria-label*="Kirim" i]',
    ],
    stop: [
      'button[data-testid="stop-button"]',
      ...GENERIC_STOP,
    ],
    assistant: [
      'div[data-message-author-role="assistant"] .markdown',
      'div[data-message-author-role="assistant"]',
      'article[data-testid*="conversation-turn"] .markdown',
      '[class*="prose"]',
      '.markdown.prose',
    ],
    preferStop: false,
    idleNeeded: 2,
    stableMs: 1800,
    preSendSettleMs: 1500,
    attachmentRecovery: true,
    newChatLabels: ['new chat', 'chat baru'],
  },

  deepseek: {
    id: 'deepseek',
    label: 'DeepSeek',
    url: 'https://chat.deepseek.com/',
    urlPrefix: 'https://chat.deepseek.com',
    composer: [
      'textarea#chat-input',
      'textarea[placeholder*="Message" i]',
      'textarea[placeholder*="Ask" i]',
      'textarea[placeholder*="DeepSeek" i]',
      'div[contenteditable="true"]#chat-input',
      'textarea',
      'div[contenteditable="true"]',
    ],
    sendButton: [
      'button[aria-label*="Send" i]',
      'div[role="button"][aria-label*="Send" i]',
      'button[type="submit"]',
      'button[aria-label*="Kirim" i]',
    ],
    // DeepSeek keeps its send button usable while the stream is still writing,
    // so send-state must be ignored (port of preferStop=true).
    stop: GENERIC_STOP,
    assistant: [
      '.ds-markdown',
      '[class*="markdown"]',
      '.message-content',
      '[data-role="assistant"]',
      '.assistant-message',
    ],
    preferStop: true,
    idleNeeded: 8,
    stableMs: 2500,
    preSendSettleMs: 1800,
    // DeepSeek converts long pastes into attachment cards with a
    // "Paste original" link — same recovery flow as ChatGPT.
    attachmentRecovery: true,
    newChatLabels: ['new chat', 'chat baru', 'obrolan baru', 'mulai obrolan baru'],
  },

  arena: {
    id: 'arena',
    label: 'Arena',
    url: 'https://arena.ai/text/direct',
    urlPrefix: 'https://arena.ai',
    composer: [
      'textarea[placeholder="Ask anything"]',
      'textarea[placeholder="Ask anything…"]',
      'textarea[placeholder*="Ask anything" i]',
      'textarea[placeholder*="Ask" i]',
      'textarea',
      'div[contenteditable="true"]',
      '[contenteditable="true"][role="textbox"]',
    ],
    sendButton: [
      'button[aria-label="Send message"]',
      'button[aria-label*="Send" i]',
      'button[aria-label*="Kirim" i]',
      'button[type="submit"]',
      'button:has(svg.lucide-arrow-up)',
    ],
    stop: GENERIC_STOP,
    assistant: [
      'code.whitespace-pre-wrap.break-words',
      '.code-block_container__lbMX4 code',
      'div.chat-markdown',
      '.chat-markdown',
      '[data-message-author-role="assistant"]',
      'main article',
    ],
    preferStop: true,
    idleNeeded: 8,
    stableMs: 2500,
    preSendSettleMs: 1800,
    attachmentRecovery: false,
    newChatLabels: ['new chat', 'chat baru', 'obrolan baru', 'new conversation', 'percakapan baru', 'mulai chat', 'baru'],
  },

};


export const COPAS_TARGET_IDS: CopasTargetId[] = ['gemini', 'chatgpt', 'deepseek', 'arena'];

export function normalizeCopasTarget(value: unknown): CopasTargetId {
  return COPAS_TARGET_IDS.includes(value as CopasTargetId) ? (value as CopasTargetId) : 'gemini';
}
