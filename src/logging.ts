import { state, ui } from './state';

export function applyProjectLoggingVisibility(): void {
  const button = ui.btnFloatingLogging as HTMLElement | undefined;
  const panel = ui.loggingPanel as HTMLElement | undefined;
  if (button) button.style.display = state.currentProjectId && state.projectLoggingEnabled ? 'flex' : 'none';
  if ((!state.currentProjectId || !state.projectLoggingEnabled) && panel) panel.style.display = 'none';
}

export function appendProjectLog(message: string, detail = ''): void {
  if (!state.projectLoggingEnabled) return;
  const history = ui.loggingHistory as HTMLElement | undefined;
  if (!history) return;
  const row = document.createElement('div');
  row.className = 'agent-msg system';
  const timestamp = new Date().toLocaleTimeString('id-ID');
  row.textContent = `[${timestamp}] ${message}${detail ? `\n${detail}` : ''}`;
  history.appendChild(row);
  history.scrollTop = history.scrollHeight;
}

export function updateStreamingLog(message: string): void {
  if (!state.projectLoggingEnabled) return;
  const history = ui.loggingHistory as HTMLElement | undefined;
  if (!history) return;
  let row = history.querySelector<HTMLElement>('[data-streaming-log="true"]');
  if (!row) {
    row = document.createElement('div');
    row.className = 'agent-msg assistant streaming';
    row.dataset.streamingLog = 'true';
    history.appendChild(row);
  }
  row.textContent = message;
  history.scrollTop = history.scrollHeight;
}

export function finishStreamingLog(): void {
  const row = (ui.loggingHistory as HTMLElement | undefined)?.querySelector<HTMLElement>('[data-streaming-log="true"]');
  if (!row) return;
  row.classList.remove('streaming');
  delete row.dataset.streamingLog;
}
