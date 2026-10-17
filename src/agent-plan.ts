// @module agent-plan.ts — Plan-first todo checklist + steering for the AI Agent.
// The agent declares a plan via setPlan and updates it via updatePlanStep /
// completePlan; the plan renders as a live checklist in the chat. Steering
// queues user messages typed mid-run and injects them after the current turn.

import { ui } from './state';

// Side-channel so ai-agent's buildSystemPrompt can include the plan section
// without a circular static import (agent-plan ↔ ai-agent).
(globalThis as any).__cstlAgentPlanPrompt = () => getPlanPromptSection();
(globalThis as any).__cstlAgentPlanReset = () => resetPlanForNewRun();
(globalThis as any).__cstlAgentSteer = {
  drain: () => drainSteerMessages(),
  hasQueued: () => hasQueuedSteerMessages(),
  queue: (text: string) => queueSteerMessage(text),
};

// ── Agent running flag (drives steering vs new-turn routing) ────────────────

let agentRunning = false;

/** True while sendAgentMessage is executing (steering messages get queued). */
export function isAgentRunning(): boolean {
  return agentRunning;
}

export function setAgentRunning(running: boolean): void {
  agentRunning = running;
}

// ── Plan (todo checklist) ────────────────────────────────────────────────────

export interface PlanStep {
  text: string;
  status: 'pending' | 'active' | 'done';
}

interface PlanState {
  steps: PlanStep[];
  /** Chat element currently rendering the checklist (re-painted on change). */
  el: HTMLElement | null;
  /** True once the plan is considered finished (all done or cancelled). */
  settled: boolean;
}

let plan: PlanState | null = null;

/** Called when a turn starts so a stale finished plan from the previous run clears. */
export function resetPlanForNewRun(): void {
  plan = null;
}

function renderPlan(): void {
  if (!plan) return;
  // Find or create the checklist element in the chat history.
  let el = plan.el;
  if (!el || !el.isConnected) {
    const historyEl = ui.agentChatHistory as HTMLElement | null;
    if (!historyEl) return;
    el = historyEl.querySelector('.agent-plan-card:not([data-settled])') as HTMLElement | null;
    if (!el) {
      el = document.createElement('div');
      el.className = 'agent-msg assistant agent-plan-card';
      historyEl.appendChild(el);
    }
    plan.el = el;
  }
  el.innerHTML = '';
  const title = document.createElement('div');
  title.className = 'agent-plan-title';
  title.textContent = '📋 Rencana';
  el.appendChild(title);
  const list = document.createElement('div');
  list.className = 'agent-plan-steps';
  plan.steps.forEach((s, i) => {
    const row = document.createElement('div');
    row.className = `agent-plan-step ${s.status}`;
    const icon = s.status === 'done' ? '✅' : s.status === 'active' ? '⏳' : '⬚';
    row.textContent = `${icon} ${i + 1}. ${s.text}`;
    list.appendChild(row);
  });
  el.appendChild(list);
  const historyEl = ui.agentChatHistory as HTMLElement | null;
  if (historyEl) historyEl.scrollTop = historyEl.scrollHeight;
}

function settlePlanIfDone(): void {
  if (!plan) return;
  if (plan.steps.every(s => s.status === 'done') || plan.steps.every(s => s.status !== 'active' && s.status !== 'pending')) {
    if (plan.el) plan.el.dataset.settled = '1';
    plan.settled = true;
  }
}

// ── Tool handlers (called from ai-agent executeTool) ─────────────────────────

export function toolSetPlan(steps: unknown): string {
  if (!Array.isArray(steps) || !steps.length) return 'Error: steps harus array of strings.';
  const texts = steps.map(s => String(s).trim()).filter(Boolean).slice(0, 12);
  if (!texts.length) return 'Error: steps tidak boleh kosong.';
  plan = { steps: texts.map(t => ({ text: t, status: 'pending' })), el: null, settled: false };
  if (plan.steps.length) plan.steps[0].status = 'active';
  renderPlan();
  return `Rencana ${texts.length} langkah ditampilkan. Update progres dengan updatePlanStep(index, status) — status: pending | active | done.`;
}

export function toolUpdatePlanStep(index: number, status: string): string {
  if (!plan) return 'Error: belum ada rencana aktif — panggil setPlan dulu.';
  const i = Math.trunc(Number(index));
  if (!Number.isInteger(i) || i < 1 || i > plan.steps.length) {
    return `Error: index harus 1–${plan.steps.length}.`;
  }
  const s = String(status || '').toLowerCase();
  if (s !== 'pending' && s !== 'active' && s !== 'done') {
    return 'Error: status harus pending | active | done.';
  }
  const step = plan.steps[i - 1];
  step.status = s as PlanStep['status'];
  // Auto-advance: first pending step becomes active when a step completes.
  if (s === 'done') {
    const next = plan.steps.find(x => x.status === 'pending');
    if (next) next.status = 'active';
  }
  renderPlan();
  settlePlanIfDone();
  return `Step ${i} → ${s}.`;
}

export function toolCompletePlan(): string {
  if (!plan) return 'Error: belum ada rencana aktif.';
  plan.steps.forEach(s => { if (s.status !== 'done') s.status = 'done'; });
  if (plan.el) plan.el.dataset.settled = '1';
  plan.settled = true;
  renderPlan();
  return 'Semua step ditandai selesai.';
}

/** Current plan as compact text for the system prompt (keeps the model aware across turns). */
export function getPlanPromptSection(): string {
  if (!plan || plan.settled) return '';
  const lines = plan.steps.map((s, i) => {
    const mark = s.status === 'done' ? '[x]' : s.status === 'active' ? '[~]' : '[ ]';
    return `${mark} ${i + 1}. ${s.text}`;
  });
  return `\n\n## RENCANA AKTIF (update dengan updatePlanStep tiap ganti langkah)\n${lines.join('\n')}`;
}

// ── Steering (queue messages typed mid-run) ──────────────────────────────────

interface SteeringEntry {
  text: string;
  at: number;
}

let steerQueue: SteeringEntry[] = [];

/** Queue a user message typed while the agent is running. Returns false if not running. */
export function queueSteerMessage(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  steerQueue.push({ text: t, at: Date.now() });
  return true;
}

/** True when at least one steering message waits for injection. */
export function hasQueuedSteerMessages(): boolean {
  return steerQueue.length > 0;
}

/**
 * Drain queued steering messages. Called by the agent loop after the current
 * tool round finishes; the returned text (if any) is injected as a user
 * message so the model adjusts course.
 */
export function drainSteerMessages(): string | null {
  if (!steerQueue.length) return null;
  const msgs = steerQueue.map(s => s.text);
  steerQueue = [];
  const stamp = new Date().toLocaleTimeString();
  return `[Steering dari user @ ${stamp}]\n${msgs.join('\n---\n')}`;
}
