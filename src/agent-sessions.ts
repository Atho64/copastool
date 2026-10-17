// @module agent-sessions.ts — Named chat sessions for the AI Agent.
// Each project can hold multiple named conversations; switching sessions saves
// the active one and loads the target. Unnamed legacy chats keep working.

import { state } from './state';

export interface AgentSessionMeta {
  id: string;
  name: string;
  updatedAt: number;
  messageCount: number;
}

const SESSIONS_INDEX_KEY = (projectId: string) => `cstl_agent_sessions_${projectId || 'global'}`;
const SESSION_DATA_KEY = (projectId: string, sessionId: string) => `cstl_agent_chat_${projectId || 'global'}_${sessionId}`;

// Legacy single-slot key (kept for migration).
export function legacyChatKey(projectId: string): string {
  return projectId ? `cstl_agent_chat_${projectId}` : 'cstl_agent_chat_global';
}

function loadIndex(): AgentSessionMeta[] {
  try {
    const raw = localStorage.getItem(SESSIONS_INDEX_KEY(state.currentProjectId));
    return raw ? (JSON.parse(raw) as AgentSessionMeta[]) : [];
  } catch { return []; }
}

function saveIndex(list: AgentSessionMeta[]): void {
  try {
    localStorage.setItem(SESSIONS_INDEX_KEY(state.currentProjectId), JSON.stringify(list));
  } catch { /* quota — ignore */ }
}

export function listSessions(): AgentSessionMeta[] {
  return loadIndex().sort((a, b) => b.updatedAt - a.updatedAt);
}

export function getSessionData(sessionId: string): string | null {
  try {
    return localStorage.getItem(SESSION_DATA_KEY(state.currentProjectId, sessionId));
  } catch { return null; }
}

export function saveSessionData(sessionId: string, data: string): void {
  try {
    localStorage.setItem(SESSION_DATA_KEY(state.currentProjectId, sessionId), data);
  } catch { /* quota — ignore */ }
}

export function deleteSessionData(sessionId: string): void {
  try {
    localStorage.removeItem(SESSION_DATA_KEY(state.currentProjectId, sessionId));
  } catch { /* ignore */ }
  // Also drop the entry from the sessions index, otherwise a ghost row
  // ("sesi hantu") stays in the list forever.
  try {
    const list = loadIndex().filter(s => s.id !== sessionId);
    saveIndex(list);
  } catch { /* ignore */ }
}

function upsertIndex(sessionId: string, name: string, messageCount: number): void {
  const list = loadIndex();
  const existing = list.find(s => s.id === sessionId);
  if (existing) {
    if (!existing.name || existing.name === 'Sesi baru') {
      existing.name = name;
    }
    existing.updatedAt = Date.now();
    existing.messageCount = messageCount;
  } else {
    list.push({ id: sessionId, name, updatedAt: Date.now(), messageCount });
  }
  saveIndex(list);
}

/** Rename a session without touching its data or timestamp. */
export function renameSession(sessionId: string, newName: string): void {
  const list = loadIndex();
  const s = list.find(x => x.id === sessionId);
  if (!s) return;
  s.name = String(newName || '').trim().slice(0, 60) || s.name;
  saveIndex(list);
}

/** Persist the current chat into its session slot and refresh the index. */
export function persistActiveSession(sessionId: string, name: string, serialized: string, messageCount: number): void {
  saveSessionData(sessionId, serialized);
  upsertIndex(sessionId, name, messageCount);
}

/** First-line derivation for auto session names. */
export function deriveSessionName(firstUserMessage: string): string {
  const t = String(firstUserMessage || '').trim().replace(/\s+/g, ' ');
  if (!t) return 'Sesi baru';
  return t.length > 32 ? t.slice(0, 30) + '…' : t;
}

// ── UI rendering ─────────────────────────────────────────────────────────────

export function renderSessionList(
  container: HTMLElement,
  activeId: string,
  callbacks: {
    onSwitch: (id: string) => void;
    onDelete: (id: string) => void;
    onRename: (id: string, newName: string) => void;
  }
): void {
  container.innerHTML = '';
  const sessions = listSessions();
  if (!sessions.length) {
    const empty = document.createElement('div');
    empty.className = 'agent-session-empty';
    empty.textContent = 'Belum ada sesi tersimpan. Sesi dibuat otomatis saat kamu mengirim pesan pertama.';
    container.appendChild(empty);
    return;
  }
  for (const s of sessions) {
    const row = document.createElement('div');
    row.className = 'agent-session-row' + (s.id === activeId ? ' active' : '');

    const nameBtn = document.createElement('button');
    nameBtn.type = 'button';
    nameBtn.className = 'agent-session-name';
    nameBtn.title = `${s.messageCount} pesan — klik untuk buka`;
    nameBtn.textContent = s.name;
    nameBtn.addEventListener('click', () => callbacks.onSwitch(s.id));

    // Inline rename on double click.
    nameBtn.addEventListener('dblclick', () => {
      const input = document.createElement('input');
      input.className = 'text-input agent-session-rename';
      input.value = s.name;
      input.maxLength = 60;
      nameBtn.replaceWith(input);
      input.focus();
      input.select();
      const commit = () => {
        const newName = input.value.trim() || s.name;
        callbacks.onRename(s.id, newName);
      };
      input.addEventListener('blur', commit);
      input.addEventListener('keydown', (e) => {
        if ((e as KeyboardEvent).key === 'Enter') { e.preventDefault(); input.blur(); }
        if ((e as KeyboardEvent).key === 'Escape') input.value = s.name;
      });
    });

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'icon-btn agent-session-delete';
    delBtn.title = 'Hapus sesi';
    delBtn.textContent = '✕';
    // Two-step confirm: first click arms the button (turns into a "?" with a
    // highlighted style), second click within 3s actually deletes. Any other
    // click / timeout / re-render disarms it — no accidental deletions.
    let armed = false;
    let disarmTimer: ReturnType<typeof setTimeout> | null = null;
    const disarm = () => {
      armed = false;
      delBtn.textContent = '✕';
      delBtn.classList.remove('agent-session-delete-armed');
      delBtn.title = 'Hapus sesi';
      if (disarmTimer) { clearTimeout(disarmTimer); disarmTimer = null; }
    };
    delBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!armed) {
        armed = true;
        delBtn.textContent = '?';
        delBtn.classList.add('agent-session-delete-armed');
        delBtn.title = `Klik lagi untuk hapus "${s.name}"`;
        disarmTimer = setTimeout(disarm, 3000);
        return;
      }
      disarm();
      callbacks.onDelete(s.id);
    });
    delBtn.addEventListener('blur', () => { if (armed) disarm(); });

    const meta = document.createElement('span');
    meta.className = 'agent-session-meta';
    const dt = new Date(s.updatedAt);
    meta.textContent = `${s.messageCount} pesan · ${dt.toLocaleDateString()} ${dt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;

    row.append(nameBtn, meta, delBtn);
    container.appendChild(row);
  }
}
