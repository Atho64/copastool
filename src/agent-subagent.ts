// @module agent-subagent.ts: ReAct subagent engine for the AI Agent chat.
// A subagent spawned via delegateAgent has its own history and the main agent's
// tool loop with a restricted toolset. It can ask the user directly (askUser,
// clickable options) and report progress to the main agent (reportToMain).

import { state, ui } from './state';
import type { ChatMessage } from './ai-client';

export type SubagentActivity =
  | { kind: 'status'; message: string }
  | { kind: 'question'; id: string; question: string; options: string[] }
  | { kind: 'report'; message: string };

let pendingQuestion: {
  id: string;
  resolve: (answer: string) => void;
} | null = null;

export function resolveSubagentQuestion(id: string, answer: string): void {
  if (pendingQuestion && pendingQuestion.id === id) {
    const q = pendingQuestion;
    pendingQuestion = null;
    q.resolve(answer);
  }
}

/** True while a question waits for the user; the main input stays blocked. */
export function hasPendingSubagentQuestion(): boolean {
  return !!pendingQuestion;
}

/**
 * Subagent asks the user a question with clickable options; free text is
 * allowed via the main input. Rejects on cancel (Stop) so the loop can bail.
 */
export function askUserSubagent(
  question: string,
  options: string[],
  emit: (activity: SubagentActivity) => void,
  isCancelled: () => boolean
): Promise<string> {
  return new Promise((resolve, reject) => {
    if (isCancelled()) {
      reject(new Error('Dibatalkan.'));
      return;
    }
    const id = `q${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
    pendingQuestion = { id, resolve };
    emit({ kind: 'question', id, question, options });
    const check = setInterval(() => {
      if (isCancelled()) {
        clearInterval(check);
        if (pendingQuestion && pendingQuestion.id === id) pendingQuestion = null;
        emit({ kind: 'status', message: 'Pertanyaan ke user dibatalkan.' });
        reject(new Error('Dibatalkan.'));
      }
    }, 500);
    // Wrap resolve so the interval is cleared when answered.
    const origResolve = resolve;
    pendingQuestion.resolve = (answer: string) => {
      clearInterval(check);
      origResolve(answer);
    };
  });
}

/**
 * Main agent asks the user; pauses the turn loop until an answer or cancel.
 * Same question card and pending-question plumbing as subagents.
 */
export function askUserMainThread(
  question: string,
  options: string[],
  isCancelled: () => boolean
): Promise<string> {
  return new Promise((resolve, reject) => {
    if (isCancelled()) {
      reject(new Error('Dibatalkan.'));
      return;
    }
    const id = `q${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
    pendingQuestion = { id, resolve };
    import('./ai-agent').then(({ showSubagentQuestion }) => showSubagentQuestion(id, question, options));
    const check = setInterval(() => {
      if (isCancelled()) {
        clearInterval(check);
        if (pendingQuestion && pendingQuestion.id === id) pendingQuestion = null;
        reject(new Error('Dibatalkan.'));
      }
    }, 500);
    const origResolve = resolve;
    pendingQuestion.resolve = (answer: string) => {
      clearInterval(check);
      origResolve(answer);
    };
  });
}

export interface SubagentToolContext {
  /** Forward a line to the main agent chat as a system message. */
  emit: (activity: SubagentActivity) => void;
  isCancelled: () => boolean;
  /** Abort epoch captured at spawn; Stop must kill subagent turns too. */
  startEpoch: number;
}

/**
 * Tools the subagent may call. Delegation is excluded (no recursive spawning);
 * mutations reuse the main agent's helpers via lazy imports to avoid cycles.
 */
const SUBAGENT_TOOL_NAMES = [
  'getProjectStats', 'getLines', 'getContext', 'searchLines', 'getCharacterNames',
  'analyzeQuality', 'getProgressReport', 'getGlossary', 'applyTranslations',
  'editLines', 'editGlossary', 'listSettings', 'getMemory', 'listMemory',
  'saveMemory', 'webSearch', 'searchVn', 'askUser', 'reportToMain',
] as const;

// askUser is blocking and the subagent loop runs tools sequentially, so no
// parallel-batch gating is needed here (unlike the main agent loop).

async function executeSubagentTool(
  name: string,
  args: any,
  ctx: SubagentToolContext,
  onProgress?: (msg: string) => void
): Promise<string> {
  const safe = (fn: () => string | Promise<string>): Promise<string> =>
    Promise.resolve().then(fn).catch((e: any) => `Error: ${e?.message || String(e)}`);
  const a = (args && typeof args === 'object') ? args : {};

  if (name === 'askUser') {
    const question = String(a.question ?? a.q ?? '').trim();
    if (!question) return 'Error: question tidak boleh kosong.';
    const options = Array.isArray(a.options) ? a.options.map((o: any) => String(o)).filter(Boolean).slice(0, 6) : [];
    try {
      const answer = await askUserSubagent(question, options, ctx.emit, ctx.isCancelled);
      return `Jawaban user: ${answer}`;
    } catch (e: any) {
      return `Error: ${e?.message || 'user tidak menjawab'}`;
    }
  }
  if (name === 'reportToMain') {
    const message = String(a.message ?? '').trim();
    if (!message) return 'Error: message tidak boleh kosong.';
    ctx.emit({ kind: 'report', message });
    return 'Laporan terkirim ke main agent.';
  }

  const { executeTool } = await import('./ai-agent');
  return executeTool(name, args, onProgress);
}

export function isSubagentToolAllowed(name: string): boolean {
  return (SUBAGENT_TOOL_NAMES as readonly string[]).includes(name);
}

// Subagents run unlimited turns by default (like interactive coding-agent CLIs);
// a cap can still be set per call via delegateAgent's max_turns argument.
const SUBAGENT_RESULT_LIMIT = 8000;

/**
 * Run a subagent turn loop; returns the final answer text.
 * maxTurnsArg: hard turn cap, 0/undefined = unlimited (Stop is the only exit).
 * When a cap is set and exhausted, one forced final turn asks for the report.
 */
export async function runSubagent(
  task: string,
  ctx: SubagentToolContext,
  onStatus?: (msg: string) => void,
  maxTurnsArg?: number
): Promise<string> {
  const { currentAbortEpoch, stripThinkingTagsForStream } = await import('./ai-client');
  const { buildSubagentSystemPrompt } = await import('./ai-agent');

  const history: ChatMessage[] = [
    { role: 'system', content: buildSubagentSystemPrompt() },
    { role: 'user', content: task },
  ];

  const isCancelled = () => currentAbortEpoch() > ctx.startEpoch;
  const requested = Number(maxTurnsArg) || 0;
  const maxTurns = requested > 0 ? Math.max(2, requested) : 0; // 0 = unlimited

  let finalText = '';
  let turn = 0;
  let malformedRetries = 0;
  // Native function calling with the subagent's tool subset; falls back to
  // JSON-in-text when the provider ignores the tool declaration.
  let nativeToolsActive = false;
  const { AGENT_TOOL_SCHEMAS } = await import('./agent-tools-schema');
  const allowedSchemas = AGENT_TOOL_SCHEMAS.filter(t => isSubagentToolAllowed(t.name));
  while (true) {
    if (isCancelled()) throw new Error('Dibatalkan.');
    turn++;
    onStatus?.(maxTurns > 0
      ? `Subagent turn ${turn}/${maxTurns}...`
      : `Subagent turn ${turn}... (tanpa batas, Stop untuk menghentikan)`);

    let responseText = '';
    let nativeToolCalls: { name: string; arguments: any }[] = [];
    try {
      const { chatCompletionStructured } = await import('./ai-client');
      const structured = await chatCompletionStructured(history, {
        rateLimited: true,
        tools: nativeToolsActive ? allowedSchemas : undefined,
      });
      responseText = structured.text;
      nativeToolCalls = structured.toolCalls;
      if (nativeToolCalls.length) nativeToolsActive = true;
    } catch (e: any) {
      throw new Error(`Subagent request gagal: ${e?.message || e}`);
    }

    const { parseToolCalls } = await import('./ai-agent');
    const parsed = nativeToolCalls.length
      ? { calls: nativeToolCalls.map(tc => ({ name: tc.name, arguments: tc.arguments })), raw: '' }
      : parseToolCalls(responseText);
    const looksLikeTool = !nativeToolsActive && (/^\s*\{/.test(responseText) || /```json\s*\{/.test(responseText));

    if (!parsed && looksLikeTool) {
      malformedRetries++;
      // Unlimited turns must not mean an infinite malformed-JSON loop.
      if (malformedRetries >= 5) {
        finalText = `(Subagent dihentikan: 5x berturut-turut menghasilkan JSON malformed/terpotong. Hasil parsial tersimpan di riwayat internal subagent.)`;
        break;
      }
      history.push({ role: 'assistant', content: responseText, _internal: true });
      history.push({
        role: 'user',
        content: 'Error: JSON-mu tidak bisa diparse. Ulangi HANYA JSON valid berformat {"tool_calls": [...]} tanpa teks lain.',
        _internal: true,
      });
      continue;
    }

    history.push({
      role: 'assistant',
      content: responseText || (nativeToolCalls.length
        ? `[Calling tools: ${nativeToolCalls.map(tc => tc.name).join(', ')}]`
        : ''),
      _internal: !!(parsed && parsed.calls.length > 0),
    });

    if (parsed && parsed.calls.length > 0) {
      const results: string[] = [];
      for (const call of parsed.calls) {
        if (isCancelled()) throw new Error('Dibatalkan.');
        if (!isSubagentToolAllowed(call.name)) {
          results.push(`Tool "${call.name}" tidak tersedia untuk subagent. Gunakan: ${SUBAGENT_TOOL_NAMES.join(', ')}`);
          continue;
        }
        const described = `${call.name}(${Object.entries(call.arguments || {}).slice(0, 2).map(([k, v]) => `${k}=${JSON.stringify(v)?.slice(0, 30)}`).join(', ')})`;
        onStatus?.(`Subagent: ${described}`);
        results.push(await executeSubagentTool(call.name, call.arguments, ctx, (m) => onStatus?.(m)));
      }
      const toolResults = parsed.calls.map((call, i) => {
        const clipped = results[i].length > SUBAGENT_RESULT_LIMIT
          ? results[i].slice(0, SUBAGENT_RESULT_LIMIT) + '\n…(terpotong)'
          : results[i];
        return `Tool "${call.name}" result:\n${clipped}`;
      });
      history.push({ role: 'user', content: toolResults.join('\n\n'), _internal: true });
      malformedRetries = 0;
      // Unlimited turns accumulate tool results; compact when the subagent's
      // own history grows past the model's context window.
      try {
        const { compactAgentContextIfNeeded } = await import('./agent-context');
        await compactAgentContextIfNeeded(history, async (msgs) => {
          const { chatCompletion: cc } = await import('./ai-client');
          return cc(msgs, { rateLimited: true });
        });
      } catch { /* compaction is best-effort, never kill the run for it */ }
      continue;
    }

    // Thinking tags are ALWAYS stripped here: a reasoning model's <think>
    // block is internal work, never part of the report (unlike the translation
    // pipelines, this is not gated on aiFilterThinkingOutput).
    finalText = stripThinkingTagsForStream(responseText).trim();
    break;
  }

  if (!finalText && maxTurns > 0) {
    // Turn cap exhausted before any text reply (the model kept calling tools).
    // Force ONE final turn with no tools so a big analysis still returns a report.
    onStatus?.('Subagent kehabisan turn, memaksa laporan final...');
    history.push({
      role: 'user',
      content: 'KEHABISAN TURN. Kamu TIDAK boleh memanggil tool lagi. Berdasarkan SEMUA hasil tool yang sudah kamu terima di atas, tulis SEKARANG laporan/jawaban final dalam teks biasa (bukan JSON). Sertakan temuan yang sudah terkumpul, jangan mulai analisis baru.',
      _internal: true,
    });
    try {
      const { chatCompletionStructured: ccStructured } = await import('./ai-client');
      // No tools on the forced turn: the model must answer with text.
      const forcedRes = await ccStructured(history, { rateLimited: true });
      finalText = stripThinkingTagsForStream(forcedRes.text).trim();
    } catch (e: any) {
      finalText = `(Subagent mencapai batas turn tanpa jawaban final; laporan paksa juga gagal: ${e?.message || e})`;
    }
  }
  return finalText.trim();
}
