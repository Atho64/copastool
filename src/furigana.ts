/// <reference types="vite/client" />

let worker: Worker | null = null;
let initPromise: Promise<void> | null = null;
let messageIdCounter = 0;
const pendingRequests = new Map<number, { resolve: Function, reject: Function }>();

function getWorker() {
  if (!worker) {
    worker = new Worker(new URL('./furigana.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e) => {
      const { id, type, result, error } = e.data;
      const req = pendingRequests.get(id);
      if (req) {
        if (type === 'error') req.reject(new Error(error));
        else req.resolve(result);
        pendingRequests.delete(id);
      }
    };
  }
  return worker;
}

/**
 * Initialize Kuroshiro with Kuromoji Analyzer in Web Worker
 */
export async function initFurigana(): Promise<void> {
  if (initPromise) return initPromise;
  
  initPromise = new Promise((resolve, reject) => {
    const id = ++messageIdCounter;
    pendingRequests.set(id, { resolve, reject });
    getWorker().postMessage({ id, type: 'init' });
  });
  
  return initPromise;
}

/**
 * Convert text to ruby HTML via Web Worker
 */
export async function convertToFurigana(text: string): Promise<string> {
  if (!text) return text;
  
  try {
    const { state } = await import('./state');
    const fType = state.furiganaType || 'hiragana';
    
    let to = 'hiragana';
    if (fType === 'katakana') to = 'katakana';
    if (fType === 'romaji') to = 'romaji';
    
    return await new Promise<string>((resolve, reject) => {
      const id = ++messageIdCounter;
      pendingRequests.set(id, { resolve, reject });
      getWorker().postMessage({ id, type: 'convert', payload: { text, to } });
    });
  } catch (error: any) {
    console.error('[CSTL] Furigana worker error:', error);
    return text;
  }
}
