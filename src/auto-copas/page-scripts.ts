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
    const rects = el.getClientRects();
    if (!rects || rects.length === 0) return false;
    const style = getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) > 0.01;
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
    const cfg = ${inject(cfg)};
    const stopVisible = cfg.stop.some((sel) =>
      Array.from(document.querySelectorAll(sel)).some(__cstlVisible));
    let lastResponseLength = 0;
    for (const sel of cfg.assistant) {
      const nodes = Array.from(document.querySelectorAll(sel)).filter(__cstlVisible);
      if (nodes.length) {
        const node = nodes[nodes.length - 1];
        lastResponseLength = ((node.innerText || node.textContent || '')).length;
        break;
      }
    }
    let composerEmpty = false;
    for (const sel of cfg.composer) {
      const nodes = Array.from(document.querySelectorAll(sel)).filter(__cstlVisible);
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

    // 3) copy buttons around the last assistant message
    for (const sel of cfg.assistant) {
      const nodes = Array.from(document.querySelectorAll(sel)).filter(__cstlVisible);
      if (!nodes.length) continue;
      let scope = nodes[nodes.length - 1];
      for (let up = 0; up < 4 && scope; up++) {
        for (const b of Array.from(scope.querySelectorAll('button, [role="button"]'))) {
          if (__cstlMatchesCopy(b)) push(b);
        }
        scope = scope.parentElement;
      }
      break;
    }

    // 4) last copy-ish button on the page
    const pageCopy = interactive().filter((b) => __cstlVisible(b) && __cstlMatchesCopy(b));
    if (pageCopy.length) push(pageCopy[pageCopy.length - 1]);

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
 * Gemini thinking toggle — written against the REAL UI (verified via camofox
 * evaluate on a live session): the picker chip is a button whose aria-label
 * reads "Buka pemilih mode, saat ini Flash" (OFF) / "…saat ini Flash
 * Mendalam" (ON) — that aria-label is the state oracle, since menu rows
 * carry no aria-checked and their innerText drops letters. The toggle row is
 * the <gem-menu-item role="menuitem"> mentioning reasoning WITHOUT a version
 * number ("Penalaran yang diperluas…"); model rows ("3.1 Pro") are excluded
 * by their version digits, so clicking can never switch the model.
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
      return (a.includes('saat ini') || a.includes('currently')) && /(flash|pro|thinking|lite)/.test(a);
    });
    const chipAria = () => { const c = findChip(); return c ? norm(c.getAttribute('aria-label') || '') : ''; };
    // The chip label names the active mode: "Flash" (off) / "Flash Mendalam"
    // (on) — "mendalam"/"thinking"/"penalaran" appear only when reasoning is on.
    const isOn = (aria) => /mendalam|thinking|penalaran|reasoning/.test(aria);
    const collectItems = () => Array.from(document.querySelectorAll('gem-menu-item, [role="menuitem"], [role="menuitemcheckbox"]')).filter((el) => el instanceof HTMLElement && __cstlVisible(el));
    const isToggleRow = (el) => {
      const t = norm(el.innerText || el.textContent || '');
      if (!t) return false;
      // Reasoning toggle text without a model version — "3.1 Pro" style rows
      // are excluded so the model can never change.
      return (/penalaran|diperlu|thinking|extended reasoning|mendalam/.test(t)) && !/\\d\\.\\d/.test(t);
    };
    // The chip button toggles the menu; Escape does NOT close a gem-menu.
    // The chip's aria-label only refreshes after the menu closed, so verify
    // with the menu shut (verified live: OFF→"saat ini Flash", ON→"…Mendalam").
    const closeMenu = async () => {
      for (let i = 0; i < 3 && collectItems().length; i++) {
        (findChip() || chip).click();
        await sleep(350);
      }
    };
    try {
      const chip = findChip();
      if (!chip) return { ok: false, detail: 'picker_not_found' };
      if (isOn(chipAria()) === wantOn) return { ok: true, detail: 'already:' + (wantOn ? 'on' : 'off') };

      // Open the menu (guarded — a blind chip click would CLOSE an open menu).
      const openMenu = async () => {
        let items = collectItems();
        if (!items.length) {
          (findChip() || chip).click();
          await sleep(700);
          items = collectItems();
        }
        return items;
      };

      for (let attempt = 0; attempt < 2; attempt++) {
        const items = await openMenu();
        const toggleRow = items.find(isToggleRow);
        if (!toggleRow) {
          await closeMenu();
          return { ok: false, detail: 'thinking_row_not_found' };
        }
        toggleRow.click(); // toggling keeps the menu open — close it explicitly
        await sleep(500);
        await closeMenu();
        await sleep(300);
        if (isOn(chipAria()) === wantOn) {
          return { ok: true, detail: 'changed:' + (wantOn ? 'on' : 'off') };
        }
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
