// @module auto-copas/page-scripts.ts — JS expressions evaluated INSIDE the AI
// chat tab (camofox `evaluate` endpoint / Android `evaluateJavascript`).
//
// These scripts never transfer text through the DOM. They only:
//   * focus the composer (so the real Ctrl+A / Ctrl+V keyboard flow lands there),
//   * read state (is a stop button visible? how long is the last response?),
//   * click the site's own Copy button so the response lands on the OS clipboard.
//
// Every builder returns a self-contained IIFE string — both transports evaluate
// strings, and each expression must survive on its own (no shared scope).

import type { CopasTargetConfig } from './targets';

/** Shared helper block: visibility check used by every script. */
const VISIBILITY_HELPER = `
  const __cstlVisible = (el) => {
    if (!el || !(el instanceof Element)) return false;
    if (el.closest('[hidden], [aria-hidden="true"]')) return false;
    // A child of a display:none parent still reports client rects in some
    // engines, and getComputedStyle(el) only reflects the element itself. Walk
    // up so a closed menu (or a hover-hidden action bar) never counts as shown.
    for (let node = el; node && node instanceof Element; node = node.parentElement) {
      const s = getComputedStyle(node);
      if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) <= 0.01) return false;
    }
    if (!el.getClientRects || el.getClientRects().length === 0) return false;
    // offsetParent is null for display:none subtrees; body/html are exempt.
    if (el.offsetParent === null) {
      const tag = el.tagName ? el.tagName.toLowerCase() : '';
      if (tag !== 'body' && tag !== 'html') return false;
    }
    return true;
  };
`;

/** The copy-button matcher ported from the extension (aria-label / title /
 * data-testid / class / innerText / icon hints, EN + ID labels). */
const COPY_MATCHER_HELPER = `
  const __cstlCopyRe = /(^|\\b)(copy|salin|copy text|copy response|menyalin)(\\b|$)/i;
  const __cstlMatchesCopy = (btn) => {
    const hay = [
      btn.getAttribute('aria-label'),
      btn.getAttribute('title'),
      btn.getAttribute('data-testid'),
      typeof btn.className === 'string' ? btn.className : '',
      btn.innerText || '',
    ].join(' ');
    if (__cstlCopyRe.test(hay)) return true;
    const icon = btn.querySelector('[data-icon], use, svg[data-icon]');
    if (icon) {
      const iconKey = icon.getAttribute('data-icon')
        || icon.getAttribute('href')
        || icon.getAttribute('xlink:href')
        || '';
      if (/copy/i.test(iconKey)) return true;
    }
    return false;
  };
`;

function inject(cfg: CopasTargetConfig, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    composer: cfg.composer,
    stop: cfg.stop,
    assistant: cfg.assistant,
    sendButton: cfg.sendButton,
    newChatLabels: cfg.newChatLabels,
    ...extra,
  });
}

/**
 * Click the site's "New chat" control the way a user would (port of the
 * extension's scored search). Two tiers: sidebar-like roots first (nav, aside,
 * sidebar classes) — the left-rail New Chat preserves the model selection,
 * unlike header buttons — and header/body only when the sidebar has no
 * candidate. Within a tier: exact accessible label > visible text, shorter
 * labels, higher-on-page and further-left preferred; history items are
 * excluded outright.
 */
export function jsClickNewChat(cfg: CopasTargetConfig): string {
  return `(() => {
    ${VISIBILITY_HELPER}
    const cfg = ${inject(cfg)};
    const norm = (t) => (t || '').replace(/\\s+/g, ' ').trim().toLowerCase();
    const want = (cfg.newChatLabels && cfg.newChatLabels.length ? cfg.newChatLabels : ['new chat', 'chat baru', 'baru']).map(norm);
    const looksLikeSettings = (el) => {
      const t = norm([el.getAttribute('aria-label'), el.getAttribute('data-test-id'), el.innerText || el.textContent || ''].join(' '));
      return /\\b(settings|pengaturan|setting|gear|account|akun|profile|profil|privacy|privasi)\\b/.test(t);
    };
    const isHistoryItem = (el) => {
      const href = norm(el.getAttribute('href') || '');
      if (href.includes('/a/chat')) return true;
      const marker = norm([el.getAttribute('data-testid') || el.getAttribute('data-test-id') || '', typeof el.className === 'string' ? el.className : ''].join(' '));
      return /(^|[-_ ])history([-_ ]|$)|chat-item|conversation-item/.test(marker);
    };
    const collect = (root) => {
      const found = [];
      let nodes = [];
      try { nodes = Array.from(root.querySelectorAll('button, a, div[role="button"], [role="link"], span[role="button"]')); } catch (_) { return found; }
      for (const node of nodes) {
        if (!(node instanceof HTMLElement) || !__cstlVisible(node)) continue;
        const aria = norm(node.getAttribute('aria-label') || '');
        const title = norm(node.getAttribute('title') || '');
        const testId = norm(node.getAttribute('data-testid') || node.getAttribute('data-test-id') || '');
        const text = norm([aria, title, node.innerText || node.textContent || ''].join(' '));
        if (!text || text.length > 48) continue;
        if (looksLikeSettings(node) || isHistoryItem(node)) continue;
        for (const w of want) {
          if (text === w || text.indexOf(w) >= 0) {
            const rect = node.getBoundingClientRect();
            const exactControl = aria === w || title === w || testId === w || testId.includes('new-chat');
            // Higher-on-page and further-left win; the sidebar New Chat is top-left.
            const score = (exactControl ? 10000 : 2000) - text.length - Math.floor(rect.top) - Math.floor(rect.left / 5);
            found.push({ el: node, score });
            break;
          }
        }
      }
      return found;
    };
    const sidebarRoots = [];
    for (const sel of ['nav', 'aside', '[class*="sidebar" i]', '[class*="side-bar" i]', '[class*="sidenav" i]', '[class*="side-nav" i]', '[class*="rail" i]']) {
      try { document.querySelectorAll(sel).forEach((el) => sidebarRoots.push(el)); } catch (_) {}
    }
    let candidates = [];
    const seen = new Set();
    for (const root of sidebarRoots) {
      if (seen.has(root)) continue;
      seen.add(root);
      candidates = candidates.concat(collect(root));
    }
    if (!candidates.length) {
      // Tier 2: header / whole document — only when the sidebar had nothing.
      const fallbackRoots = [];
      try { document.querySelectorAll('header').forEach((el) => fallbackRoots.push(el)); } catch (_) {}
      fallbackRoots.push(document.body);
      for (const root of fallbackRoots) {
        if (seen.has(root)) continue;
        seen.add(root);
        candidates = candidates.concat(collect(root));
      }
    }
    if (!candidates.length) return { clicked: false, best: 0 };
    candidates.sort((a, b) => b.score - a.score);
    const best = candidates[0];
    try { best.el.scrollIntoView({ block: 'center' }); } catch (_) {}
    try { best.el.click(); } catch (_) {}
    return { clicked: true, best: best.score };
  })()`;
}

/** Focus the first visible composer so Ctrl+A / Ctrl+V / Enter hit it. */
export function jsFocusComposer(cfg: CopasTargetConfig): string {
  return `(() => {
    ${VISIBILITY_HELPER}
    const cfg = ${inject(cfg)};
    for (const sel of cfg.composer) {
      const nodes = Array.from(document.querySelectorAll(sel)).filter(__cstlVisible);
      if (!nodes.length) continue;
      const el = nodes[nodes.length - 1];
      try { el.scrollIntoView({ block: 'center' }); } catch (_) {}
      try { el.focus({ preventScroll: true }); } catch (_) { try { el.focus(); } catch (_) {} }
      // Collapse any existing selection to the end so Ctrl+A scopes to the editor.
      try {
        const range = document.createRange();
        range.selectNodeContents(el);
        range.collapse(false);
        const selection = window.getSelection();
        if (selection) { selection.removeAllRanges(); selection.addRange(range); }
      } catch (_) {}
      const isEditable = el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' || el.isContentEditable;
      if (isEditable) return { found: true, tag: el.tagName };
    }
    return { found: false, tag: '' };
  })()`;
}

/** Length of the text currently in the focused composer — used to verify a
 * paste actually landed before pressing Enter. */
export function jsComposerTextLength(cfg: CopasTargetConfig): string {
  return `(() => {
    ${VISIBILITY_HELPER}
    const cfg = ${inject(cfg)};
    for (const sel of cfg.composer) {
      const nodes = Array.from(document.querySelectorAll(sel)).filter(__cstlVisible);
      if (!nodes.length) continue;
      const el = nodes[nodes.length - 1];
      const isEditable = el.tagName === 'TEXTAREA' || el.tagName === 'INPUT';
      if (isEditable) return { length: (el.value || '').length };
      if (el.isContentEditable) return { length: ((el.innerText || el.textContent || '')).length };
    }
    return { length: -1 };
  })()`;
}

/** Read-only completion-detection state. */
export function jsReadPageState(cfg: CopasTargetConfig): string {
  return `(() => {
    ${VISIBILITY_HELPER}
    ${REASONING_EXCLUDE_HELPER}
    const cfg = ${inject(cfg)};
    // Label drift guard: sites rename this control constantly (Gemini shipped
    // "Stop generating" -> "Stop response"). A hardcoded selector list rots
    // silently and takes completion detection with it, so any visible button
    // whose accessible label says "stop/hentikan" also counts.
    const __cstlStopLabelRe = /\\b(stop|hentikan|berhenti|batalkan)\\b/i;
    const __cstlIsStop = (el) => {
      if (!__cstlVisible(el)) return false;
      const label = [
        el.getAttribute('aria-label'),
        el.getAttribute('title'),
        el.getAttribute('data-testid'),
        el.getAttribute('data-tooltip'),
      ].filter(Boolean).join(' ');
      if (__cstlStopLabelRe.test(label)) return true;
      return cfg.stop.some((sel) => {
        try { return el.matches(sel); } catch (_) { return false; }
      });
    };
    let stopVisible = cfg.stop.some((sel) => {
      try { return Array.from(document.querySelectorAll(sel)).some(__cstlVisible); }
      catch (_) { return false; }
    });
    if (!stopVisible) {
      stopVisible = Array.from(document.querySelectorAll('button, [role="button"]'))
        .some(__cstlIsStop);
    }
    // Pick the LONGEST visible candidate across every selector instead of
    // breaking on the first match. A site's chrome (toolbars, "copy" buttons)
    // often shares a loose class with the answer body, and first-match
    // ordering would silently latch onto that 4-character node — which
    // freezes lastResponseLength and stalls the completion loop.
    //
    // Reasoning/thinking subtrees are excluded: their text grows first and is
    // often longer than the answer, which would both inflate the length signal
    // and leak into anything read from this node.
    let lastResponseLength = 0;
    for (const sel of cfg.assistant) {
      let nodes;
      try { nodes = Array.from(document.querySelectorAll(sel)).filter(__cstlVisible); }
      catch (_) { continue; }
      for (const node of nodes) {
        if (__cstlIsReasoning(node)) continue;
        const nodeText = (node.innerText || node.textContent || '');
        let len = nodeText.length;
        // Subtract the reasoning block's own length when it is nested inside.
        for (const inner of Array.from(node.querySelectorAll('*'))) {
          if (!__cstlIsReasoning(inner)) continue;
          len -= ((inner.innerText || inner.textContent || '').length);
        }
        if (len > lastResponseLength) lastResponseLength = len;
      }
    }
    let composerEmpty = false;
    for (const sel of cfg.composer) {
      let nodes;
      try { nodes = Array.from(document.querySelectorAll(sel)).filter(__cstlVisible); }
      catch (_) { continue; }
      if (!nodes.length) continue;
      const el = nodes[nodes.length - 1];
      const isEditable = el.tagName === 'TEXTAREA' || el.tagName === 'INPUT';
      composerEmpty = isEditable ? (el.value || '').length === 0 : ((el.innerText || el.textContent || '')).length === 0;
      break;
    }
    return { stopVisible, lastResponseLength, composerEmpty };
  })()`;
}

/**
 * Click the newest Copy/Salin control. Candidates (in order):
 *   1. Buttons whose aria-label IS the text ("Copy: ..."); the text is returned
 *      directly, no click needed.
 *   2. Copy button inside the last code block (Arena ships translations there).
 *   3. Copy buttons near the last assistant message (≤4 ancestor levels —
 *      response actions are usually siblings of the markdown node).
 *   4. Last copy-ish button anywhere on the page (latest turn wins).
 *
 * `attempt` picks the next candidate when a previous click did not change the
 * clipboard (the engine retries with attempt+1).
 */
export function jsClickCopyButton(cfg: CopasTargetConfig, attempt: number): string {
  return `(() => {
    ${VISIBILITY_HELPER}
    ${COPY_MATCHER_HELPER}
    ${REASONING_EXCLUDE_HELPER}
    const cfg = ${inject(cfg, { attempt })};
    const attempt = Number(cfg.attempt) || 0;
    const seen = new Set();
    const candidates = [];
    const push = (el, ariaText) => {
      if (!el || seen.has(el)) return;
      seen.add(el);
      candidates.push({ el, ariaText: ariaText || null });
    };
    const interactive = () => Array.from(document.querySelectorAll('button, [role="button"]'));

    // 1) aria-label carries the whole response ("Copy: <text>")
    for (const b of interactive()) {
      if (!__cstlVisible(b)) continue;
      const aria = (b.getAttribute('aria-label') || '').trim();
      if (/^copy:/i.test(aria)) push(b, aria.slice(5).trim());
    }

    // 2) Arena: the copy control inside the last code block is icon-only and
    // often carries NO copy-like label — take any button in the block, exactly
    // like the extension's copyArenaResponse().
    const blocks = Array.from(document.querySelectorAll('[data-code-block="true"]'));
    const lastBlock = blocks[blocks.length - 1];
    if (lastBlock) {
      const firstBtn = lastBlock.querySelector('button');
      if (firstBtn) push(firstBtn);
      const scope = [lastBlock, lastBlock.parentElement].filter(Boolean);
      for (const node of scope) {
        const btns = Array.from(node.querySelectorAll('button, [role="button"]'))
          .filter((b) => __cstlVisible(b) && __cstlMatchesCopy(b));
        if (btns.length) push(btns[btns.length - 1]);
      }
    }

    // 3) copy buttons around the last assistant message. Reasoning blocks may
    // carry their own copy control, so those are collected separately and used
    // only as a last resort — otherwise "copy thinking" can win over
    // "copy answer" purely on DOM order.
    let answerScoped = [];
    let reasoningScoped = [];
    for (const sel of cfg.assistant) {
      const nodes = Array.from(document.querySelectorAll(sel)).filter(__cstlVisible);
      if (!nodes.length) continue;
      let scope = nodes[nodes.length - 1];
      for (let up = 0; up < 4 && scope; up++) {
        for (const b of Array.from(scope.querySelectorAll('button, [role="button"]'))) {
          if (!__cstlMatchesCopy(b)) continue;
          const host = b.closest('[class*="think" i], [class*="reason" i], [class*="cot" i], [data-testid*="think" i], [aria-label*="think" i]');
          if (__cstlIsReasoning(b) || host) reasoningScoped.push(b);
          else answerScoped.push(b);
        }
        scope = scope.parentElement;
      }
      break;
    }
    for (const b of answerScoped) push(b);

    // 4) last copy-ish button on the page — only if nothing was found near the
    // answer itself. This is what previously let a "Copy prompt"/thinking
    // control win when the answer-scoped search came up empty.
    if (candidates.length === 0) {
      const pageCopy = interactive().filter((b) =>
        __cstlVisible(b) && __cstlMatchesCopy(b) && !__cstlIsReasoning(b));
      if (pageCopy.length) push(pageCopy[pageCopy.length - 1]);
    }
    // Reasoning-scoped controls are the very last resort.
    for (const b of reasoningScoped) push(b);

    if (!candidates.length) return { clicked: false, total: 0, ariaText: null };
    const pick = candidates[Math.min(attempt, candidates.length - 1)];
    if (pick.ariaText) return { clicked: false, total: candidates.length, ariaText: pick.ariaText };

    const el = pick.el;
    try { el.scrollIntoView({ block: 'center' }); } catch (_) {}
    // Hover reveal (DeepSeek shows response actions only on hover)
    for (const type of ['mouseover', 'mouseenter']) {
      try { el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window })); } catch (_) {}
    }
    try { el.click(); } catch (_) {}
    return { clicked: true, total: candidates.length, ariaText: null };
  })()`;
}

/** DeepSeek (and other reasoning models) render a collapsible "thinking" /
 * "reasoning" block next to the answer. That block often sits inside the
 * assistant container and is usually LONGER than the answer, so a naive
 * longest-text read returns the model's internal monologue instead of the
 * translation. Mark such nodes and skip them everywhere. */
const REASONING_EXCLUDE_HELPER = `
  const __cstlIsReasoning = (el) => {
    if (!el || !(el instanceof Element)) return false;
    const hay = [
      el.getAttribute('class'),
      el.getAttribute('data-testid'),
      el.getAttribute('data-role'),
      el.getAttribute('aria-label'),
      el.getAttribute('data-type'),
    ].filter(Boolean).join(' ');
    if (/think|reason|chain-of-thought|cot|analysis/i.test(hay)) return true;
    // A visible short header like "Thought for 12 seconds" / "Thinking…".
    const header = (el.innerText || '').slice(0, 60);
    return /^(thought|thinking|reasoning|berpikir|menalar|analisis)\\b/i.test(header.trim());
  };
`;

/**
 * Read the full text of the last assistant response from the DOM.
 *
 * Fallback for when the site's own Copy control cannot be used (it only
 * exposes "Copy prompt", sits behind a hover menu, or needs a clipboard
 * permission we do not have). Kept read-only: it never mutates the page.
 *
 * Uses the same longest-visible-candidate rule as jsReadPageState so page
 * chrome (toolbars, action rows) can never shadow the answer body, and skips
 * reasoning/thinking nodes so a model's internal monologue is not mistaken for
 * the answer.
 */
export function jsReadLastResponseText(cfg: CopasTargetConfig): string {
  return `(() => {
    ${VISIBILITY_HELPER}
    ${REASONING_EXCLUDE_HELPER}
    const cfg = ${inject(cfg)};
    // Text that is page chrome, not answer content. Reading a wrapper node
    // (e.g. <model-response>) otherwise picks up its header and its hover-only
    // action bar, so a reply could come back as "Copy" or "Gemini says".
    const CHROME_TAGS = ['button', 'svg', 'script', 'style', 'noscript', 'textarea', 'input'];
    const CHROME_ROLES = /^(button|menu|menubar|toolbar|tooltip)$/i;
    const CHROME_CLASS = /(^|[\s_-])(actions?|toolbar|toolbar-container|response-footer|buttons?|mat-mdc-tooltip|menu|controls?)([\s_-]|$)/i;
    const isChrome = (el) => {
      if (!(el instanceof Element)) return false;
      const tag = el.tagName ? el.tagName.toLowerCase() : '';
      if (CHROME_TAGS.includes(tag)) return true;
      if (CHROME_ROLES.test(el.getAttribute('role') || '')) return true;
      const cls = el.getAttribute('class') || '';
      if (cls && CHROME_CLASS.test(cls)) return true;
      return false;
    };
    const textOf = (el) => {
      if (!el) return '';
      const clone = el.cloneNode(true);
      // Remove reasoning subtrees and chrome before reading, so neither the
      // model's monologue nor a control label can bleed into the answer.
      for (const bad of Array.from(clone.querySelectorAll('*'))) {
        if (isChrome(bad) || __cstlIsReasoning(bad)) bad.remove();
      }
      const text = (clone.innerText || clone.textContent || '');
      // A bare control label is never an answer.
      return /^(copy|salin|share|bagikan|edit|retry|coba lagi|good response|bad response)$/i.test(text.trim()) ? '' : text;
    };
    let best = '';
    let bestLen = 0;
    // Prefer the MOST SPECIFIC selector that yields text. cfg.assistant is
    // ordered from the answer body outward, so the first non-empty hit is the
    // cleanest. Taking the LONGEST hit instead picked the outer wrapper and
    // prepended the speaker header to every translation.
    for (const sel of cfg.assistant) {
      let nodes;
      try { nodes = Array.from(document.querySelectorAll(sel)).filter(__cstlVisible); }
      catch (_) { continue; }
      if (!nodes.length) continue;
      const node = nodes[nodes.length - 1];
      if (__cstlIsReasoning(node)) continue;
      const text = textOf(node).trim();
      if (text) { return text; }
    }
    return best.trim();
  })()`;
}

/** Click the site's send button (fallback when Enter did not start a run). */
export function jsClickSendButton(cfg: CopasTargetConfig): string {
  return `(() => {
    ${VISIBILITY_HELPER}
    const cfg = ${inject(cfg)};
    for (const sel of cfg.sendButton) {
      for (const btn of Array.from(document.querySelectorAll(sel))) {
        if (!__cstlVisible(btn)) continue;
        const disabled = btn.disabled || btn.getAttribute('aria-disabled') === 'true';
        if (disabled) continue;
        try { btn.click(); } catch (_) { continue; }
        return { clicked: true };
      }
    }
    return { clicked: false };
  })()`;
}

/**
 * Arena last resort (extension's scrapeArenaCodeBlock): read the translation
 * payload straight out of the last Monaco-style code block. Only used when
 * every copy-button attempt failed to change the clipboard.
 */
export function jsScrapeArenaCodeBlock(): string {
  return `(() => {
    const codes = Array.from(document.querySelectorAll('.code-block_container__lbMX4 code, code.whitespace-pre-wrap.break-words'));
    for (let i = codes.length - 1; i >= 0; i--) {
      const code = codes[i];
      const lineEls = code.querySelectorAll('.line');
      let text = '';
      if (lineEls.length) {
        text = Array.from(lineEls).map((el) => (el.innerText || el.textContent || '').replace(/\\s+$/g, '')).join('\\n').trim();
      } else {
        text = (code.innerText || code.textContent || '').trim();
      }
      if (text.length >= 12) return text;
    }
    return '';
  })()`;
}

/**
 * DeepSeek "Pikir Mendalam" / DeepThink toggle (port of selectDeepseekMode's
 * think step). Reads aria-pressed/checked/class state and only clicks when the
 * current state differs, so re-applying never toggles it off.
 */
export function jsDeepSeekSetThinking(wantOn: boolean): string {
  return `(async () => {
    ${VISIBILITY_HELPER}
    const wantOn = ${JSON.stringify(wantOn)};
    const norm = (t) => (t || '').replace(/\\s+/g, ' ').trim().toLowerCase();
    const isPressed = (el) => {
      const aria = (el.getAttribute('aria-pressed') || el.getAttribute('aria-checked') || '').toLowerCase();
      if (aria === 'true') return true;
      if (aria === 'false') return false;
      const cls = typeof el.className === 'string' ? el.className.toLowerCase() : '';
      if (/\\b(active|selected|checked|on|enabled|pressed)\\b/.test(cls)) return true;
      const ds = (el.getAttribute('data-state') || el.getAttribute('data-active') || '').toLowerCase();
      return ds === 'on' || ds === 'true' || ds === 'checked' || ds === 'active';
    };
    const sels = ['button', 'div[role="button"]', '[role="tab"]', '[role="radio"]', '[role="switch"]', '[role="checkbox"]', 'label', 'span[role="button"]', '[aria-pressed]'];
    const needles = ['pikir mendalam', 'deepthink', 'deep think', 'deep thinking'];
    let best = null;
    let bestScore = -1;
    const seen = new Set();
    for (const sel of sels) {
      let nodes = [];
      try { nodes = document.querySelectorAll(sel); } catch (_) { continue; }
      for (const el of nodes) {
        if (seen.has(el)) continue;
        seen.add(el);
        if (!(el instanceof HTMLElement) || !__cstlVisible(el)) continue;
        const text = norm([el.getAttribute('aria-label') || '', el.innerText || el.textContent || ''].join(' '));
        if (!text || text.length > 60) continue;
        for (const n of needles) {
          if (text === n) { best = el; bestScore = 100000; break; }
          if (text.includes(n)) {
            const s = 1000 - text.length + n.length;
            if (s > bestScore) { bestScore = s; best = el; }
          }
        }
      }
      if (bestScore >= 100000) break;
    }
    if (!best) return { ok: false, detail: 'deepthink_not_found' };
    const wasOn = isPressed(best);
    if (wasOn !== wantOn) {
      best.click();
      await new Promise((r) => setTimeout(r, 250));
    }
    return { ok: true, detail: (wasOn === wantOn ? 'already' : 'changed') + ':' + (wantOn ? 'on' : 'off') };
  })()`;
}

/**
 * Gemini thinking toggle.
 *
 * Gemini ships TWO different pickers depending on the model, and the live UI
 * (verified through Camoufox on a logged-in session) looks like this:
 *
 *   Older Flash/Pro:  the chip aria-label names the mode —
 *                     "…saat ini Flash" (off) / "…saat ini Flash Mendalam" (on).
 *   Argon:            the chip reads "…saat ini Argon" in BOTH states, and the
 *                     menu carries a separate "Tingkat penalaran" group with
 *                     Rendah / Sedang / Tinggi rows instead of a toggle.
 *
 * So the old "is the chip label saying Mendalam?" oracle is not enough: on
 * Argon it never reports ON. State is now read from whichever signal the
 * active model exposes, falling back to the reasoning-level row selection.
 *
 * Menu rows carry no aria-checked, and this Camoufox build drops the letter
 * "s" from innerText/aria-label ("Tingkat penalaran" -> "Tingkat penalaran",
 * "rendah" -> "rendah"), so every matcher is prefix/substring based and must
 * never compare whole words.
 */
export function jsGeminiSetThinking(wantOn: boolean): string {
  return `(async () => {
    ${VISIBILITY_HELPER}
    const wantOn = ${JSON.stringify(wantOn)};
    const norm = (t) => (t || '').replace(/\\s+/g, ' ').trim().toLowerCase();
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const findChip = () => Array.from(document.querySelectorAll('button')).find((b) => {
      const a = norm(b.getAttribute('aria-label') || '');
      if (!a) return false;
      if (a.includes('pemilih mode') || a.includes('pemilih model') || a.includes('mode picker') || a.includes('model picker')) return true;
      return (a.includes('aat ini') || a.includes('currently')) && /(fla h|flash|pro|lite|argon|thinking)/.test(a);
    });
    const chipAria = () => { const c = findChip(); return c ? norm(c.getAttribute('aria-label') || '') : ''; };
    // Legacy oracle: the chip label names the mode. "mendalam" (deep) only shows
    // up when extended reasoning is on.
    const labelSaysOn = (aria) => /mendalam|thinking|penalaran|reasoning/.test(aria);
    // The menu can contain rows that are laid out but report no client rects.
    // Filtering those out dropped the entire reasoning-level group on Argon,
    // so menu rows are collected by DOM membership; only explicit hiding
    // (display:none / aria-hidden / [hidden]) is excluded.
    const __cstlRowShown = (el) => {
      if (!el || !(el instanceof Element)) return false;
      if (el.closest('[hidden], [aria-hidden="true"]')) return false;
      for (let n = el; n && n instanceof Element; n = n.parentElement) {
        const st = getComputedStyle(n);
        if (st.display === 'none' || st.visibility === 'hidden') return false;
      }
      return true;
    };
    // Level rows can live inside a display:none submenu-container that is only
    // revealed by activating the "Tingkat penalaran" header row. They are
    // therefore collected WITHOUT a visibility requirement; the caller opens the
    // submenu first (see ensureLevelGroup).
    const collectAllItems = () => Array.from(document.querySelectorAll('gem-menu-item, [role="menuitem"], [role="menuitemcheckbox"]')).filter((el) => el instanceof HTMLElement);
    const collectItems = () => collectAllItems().filter(__cstlRowShown);
    const itemText = (el) => norm(el.innerText || el.textContent || '');
    // A model row like "3.1 Pro" / "4 Argon" must never be clicked as a toggle.
    const isModelRow = (t) => /\\d\\.\\d/.test(t) || /^(3\\.5|3\\.8|3\\.1|4)\\b/.test(t);
    // Legacy single toggle row ("Penalaran yang diperluas…").
    const isToggleRow = (el) => {
      const t = itemText(el);
      if (!t || isModelRow(t)) return false;
      return /penalaran|diperlu|thinking|extended reasoning|mendalam/.test(t);
    };
    // Argon: a "Tingkat penalaran" header row that opens a SUBMENU holding the
    // level rows (observed live: the levels sit in div.submenu-container with
    // display:none until that header is activated). So the group is never
    // present on a cold open — it must be opened first.
    const LEVELS = ['rendah', 'sedang', 'tinggi'];
    const levelOf = (t) => LEVELS.find((lv) => t.startsWith(lv)) || null;
    const levelRows = (items) => items.filter((el) => {
      const t = itemText(el);
      return levelOf(t) && !isModelRow(t);
    });
    const headerRow = (items) => items.find((el) => /tingkat penalaran|reasoning level/.test(itemText(el)));
    const hasLevelGroup = (items) => !!headerRow(items) || levelRows(items).length >= 2;
    /** Open the reasoning-level submenu so its rows can be read/clicked. */
    const ensureLevelGroup = async () => {
      let all = collectAllItems();
      if (levelRows(all).length >= 1) return all;
      const header = headerRow(all);
      if (!header) return all;
      // Activate the header with a full pointer sequence: gem-menu-item binds on
      // pointer events in some builds, and a plain .click() misses those.
      try { header.scrollIntoView({ block: 'center' }); } catch (_) {}
      for (const type of ['pointerover', 'mouseover', 'pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
        try {
          const Ctor = type.startsWith('pointer') ? PointerEvent : MouseEvent;
          header.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true, view: window }));
        } catch (_) {}
      }
      await sleep(600);
      if (!levelRows(collectAllItems()).length) {
        try { header.click(); } catch (_) {}
        await sleep(600);
      }
      return collectAllItems();
    };
    // Which level is active? The rows expose no aria-checked, so read the
    // selection class/material attribute that gem-menu-item uses instead.
    const activeLevel = (items) => {
      for (const el of levelRows(items)) {
        const lv = levelOf(itemText(el));
        if (!lv) continue;
        const cls = norm(el.getAttribute('class') || '');
        const aria = norm(el.getAttribute('aria-checked') || el.getAttribute('aria-selected') || '');
        if (aria === 'true') return lv;
        if (/selected|checked|active|highlight/.test(cls)) return lv;
        if (el.matches('[aria-pressed="true"], [data-selected="true"], [aria-current="true"]')) return lv;
      }
      return null;
    };
    const closeMenu = async () => {
      for (let i = 0; i < 3 && collectItems().length; i++) {
        (findChip() || chip).click();
        await sleep(350);
      }
    };
    try {
      const chip = findChip();
      if (!chip) return { ok: false, detail: 'picker_not_found' };

      // The chip label is only a reliable oracle on the LEGACY picker, where it
      // names the mode ("…saat ini Flash" / "…Flash Mendalam"). On Argon the
      // label reads "…saat ini Argon" in BOTH states, so trusting it reported
      // "already off" forever and the level rows were never reached.
      // Rule: a label that positively says ON is trusted for wantOn; any other
      // case inspects the menu, which carries the level rows on Argon.
      const chipLabel = chipAria();
      if (wantOn && labelSaysOn(chipLabel)) return { ok: true, detail: 'already:on' };

      const openMenu = async () => {
        let items = collectItems();
        if (!items.length) {
          (findChip() || chip).click();
          await sleep(800);
          items = collectItems();
        }
        return items;
      };

      for (let attempt = 0; attempt < 2; attempt++) {
        const items = await openMenu();
        if (!items.length) { await sleep(400); continue; }

        // ── Argon-style reasoning LEVEL group ──────────────────────────────
        if (hasLevelGroup(items)) {
          // The levels live in a submenu, so open it before reading state.
          const opened = await ensureLevelGroup();
          const rows = levelRows(opened);
          if (rows.length) {
            const current = activeLevel(opened);
            const wantLevel = wantOn ? 'tinggi' : 'rendah';
            if (current === wantLevel) {
              await closeMenu();
              return { ok: true, detail: 'already:' + wantLevel };
            }
            const target = rows.find((el) => levelOf(itemText(el)) === wantLevel) || rows[rows.length - 1];
            if (target) {
              try { target.scrollIntoView({ block: 'center' }); } catch (_) {}
              for (const type of ['pointerover', 'mouseover', 'pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
                try {
                  const Ctor = type.startsWith('pointer') ? PointerEvent : MouseEvent;
                  target.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true, view: window }));
                } catch (_) {}
              }
              await sleep(600);
              await closeMenu();
              await sleep(250);
              return { ok: true, detail: 'changed:' + (wantOn ? 'on' : 'off') + ':' + wantLevel + (current ? ' (was ' + current + ')' : '') };
            }
          }
        }

        // ── Legacy single toggle row ────────────────────────────────────
        const toggleRow = items.find(isToggleRow);
        if (toggleRow) {
          toggleRow.click();
          await sleep(500);
          await closeMenu();
          await sleep(300);
          if (labelSaysOn(chipAria()) === wantOn) {
            return { ok: true, detail: 'changed:' + (wantOn ? 'on' : 'off') };
          }
          continue;
        }

        await closeMenu();
        return { ok: false, detail: 'thinking_control_not_found:' + chipAria().slice(0, 60) };
      }
      return { ok: false, detail: 'state_unverified:' + (wantOn ? 'on' : 'off') + ':' + chipAria().slice(0, 50) };
    } catch (e) {
      try { const c = findChip(); if (c) c.click(); } catch (_) {}
      return { ok: false, detail: String((e && e.message) || e) };
    }
  })()`;
}

/**
 * Attachment-card recovery (ChatGPT + DeepSeek): long pastes are converted
 * into a document card with a "show in text field" / "Paste original" button.
 * Click it (realistic pointer sequence — React sometimes binds the handler on
 * a plain parent) so the prompt becomes text again.
 */
export function jsExpandAttachment(): string {
  return `(() => {
    const re = /(tampilkan di bidang teks|show in text field|open in canvas|buka di kanvas|paste original|tempel asli)/i;
    const buttons = Array.from(document.querySelectorAll('button, [role="button"], a, span[class*="link" i]'));
    const matches = buttons.filter((b) => {
      const hay = [b.getAttribute('aria-label'), b.getAttribute('title'), b.innerText || ''].join(' ');
      return re.test(hay);
    });
    if (!matches.length) return false;
    const el = matches[0];
    try { el.scrollIntoView({ block: 'center' }); } catch (_) {}
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      try {
        const ev = type.startsWith('pointer')
          ? new PointerEvent(type, { bubbles: true, cancelable: true, view: window })
          : new MouseEvent(type, { bubbles: true, cancelable: true, view: window });
        el.dispatchEvent(ev);
      } catch (_) { try { el.click(); } catch (_) {} }
    }
    try { el.click(); } catch (_) {}
    return true;
  })()`;
}
