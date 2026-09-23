import Kuroshiro from 'kuroshiro';
// @ts-ignore
import KuromojiAnalyzer from 'kuroshiro-analyzer-kuromoji';
// Kuromoji's legacy XHR loader accepts malformed/partial responses as valid
// buffers. Load and verify each gzip dictionary before giving it to Kuromoji.
// @ts-ignore
import BrowserDictionaryLoader from 'kuromoji/src/loader/BrowserDictionaryLoader.js';
// @ts-ignore
import KuromojiTokenizer from 'kuromoji/src/Tokenizer.js';
import * as pako from 'pako';

let kuroshiroInstance: any = null;
let initPromise: Promise<void> | null = null;

function moduleValue(mod: any): any {
  return mod?.default?.default || mod?.default || mod;
}

function loadVerifiedTokenizer(dictPath: string, analyzer: any): Promise<void> {
  const Loader = moduleValue(BrowserDictionaryLoader);
  const Tokenizer = moduleValue(KuromojiTokenizer);
  const loader = new Loader(dictPath);
  // kuromoji's path-browserify join turns an absolute URL such as
  // http://localhost:5173/dict/ into http:/localhost:5173/dict/.
  // Keep its requested filename, but resolve it against the original base.
  const dictionaryBase = new URL(dictPath, self.location.href);
  if (!dictionaryBase.pathname.endsWith('/')) dictionaryBase.pathname += '/';
  const expectedSizes: Record<string, number> = {
    'base.dat.gz': 8_388_608, 'check.dat.gz': 8_388_608,
    'cc.dat.gz': 3_463_716, 'tid.dat.gz': 10_485_760,
    'tid_pos.dat.gz': 41_943_040, 'tid_map.dat.gz': 4_194_304,
    'unk.dat.gz': 10_485_760, 'unk_pos.dat.gz': 10_485_760,
    'unk_map.dat.gz': 1_048_576, 'unk_char.dat.gz': 65_536,
    'unk_compat.dat.gz': 262_144, 'unk_invoke.dat.gz': 1_048_576,
  };
  let activeLoads = 0;
  const waitingLoads: Array<() => void> = [];

  loader.loadArrayBuffer = (requestUrl: string, callback: (error: Error | null, buffer: ArrayBuffer | null) => void) => {
    const run = () => {
      activeLoads++;
      void (async () => {
        const requestedFile = requestUrl.replace(/\\/g, '/').split('/').pop() || '';
        if (!requestedFile) throw new Error(`Invalid dictionary filename: ${requestUrl}`);
        const url = new URL(requestedFile, dictionaryBase);
        const response = await fetch(url.href, { cache: 'force-cache' });
        if (!response.ok) throw new Error(`${url.pathname} returned HTTP ${response.status}`);
        const responseBytes = new Uint8Array(await response.arrayBuffer());
        const filename = url.pathname.split('/').pop() || '';
        const expectedSize = expectedSizes[filename];
        let decoded: Uint8Array;
        if (responseBytes[0] === 0x1f && responseBytes[1] === 0x8b) {
          try {
            decoded = pako.ungzip(responseBytes);
          } catch (error: any) {
            throw new Error(`${url.pathname} gzip decode failed: ${error?.message || error}`);
          }
        } else if (expectedSize && responseBytes.byteLength === expectedSize) {
          // Vite serves public .gz files with Content-Encoding: gzip. Fetch
          // transparently decodes that HTTP encoding, so the body is already
          // the raw Kuromoji dictionary and has no gzip magic bytes.
          decoded = responseBytes;
        } else {
          throw new Error(`${url.pathname} is neither a gzip dictionary nor a recognized raw dictionary (received ${responseBytes.byteLength} bytes)`);
        }
        if (expectedSize && decoded.byteLength !== expectedSize) {
          throw new Error(`${filename} decoded to ${decoded.byteLength} bytes; expected ${expectedSize}. The dictionary download may be incomplete.`);
        }
        const exactBuffer = decoded.buffer.slice(decoded.byteOffset, decoded.byteOffset + decoded.byteLength) as ArrayBuffer;
        callback(null, exactBuffer);
      })().catch((error: any) => callback(error instanceof Error ? error : new Error(String(error)), null))
        .finally(() => {
          activeLoads--;
          waitingLoads.shift()?.();
        });
    };
    if (activeLoads < 2) run();
    else waitingLoads.push(run);
  };

  return new Promise((resolve, reject) => {
    loader.load((error: any, dictionaries: any) => {
      if (error) { reject(error); return; }
      try {
        analyzer._analyzer = new Tokenizer(dictionaries);
        resolve();
      } catch (loadError) { reject(loadError); }
    });
  });
}

async function init(customDictPath?: string) {
  if (kuroshiroInstance) return;
  if (!initPromise) {
    initPromise = (async () => {
      // Robust constructor resolution across ESM / CommonJS bundlers
      const KuroClass = (Kuroshiro as any).default?.default || (Kuroshiro as any).default || Kuroshiro;
      const kuroshiro = new KuroClass();

      const AnalyzerClass = (KuromojiAnalyzer as any).default?.default || (KuromojiAnalyzer as any).default || KuromojiAnalyzer;

      let dictPath = customDictPath;
      if (!dictPath) {
        if (typeof self !== 'undefined' && self.location && self.location.origin) {
          dictPath = new URL('dict/', self.location.origin).href;
        } else {
          dictPath = '/dict/';
        }
      }
      if (!dictPath.endsWith('/')) dictPath += '/';

      const analyzer = new AnalyzerClass({ dictPath });
      // Replace only initialization's dictionary loader; keep the analyzer's
      // stock parse implementation and Kuromoji tokenization behavior.
      analyzer.init = () => loadVerifiedTokenizer(dictPath!, analyzer);
      await kuroshiro.init(analyzer);
      kuroshiroInstance = kuroshiro;
    })().catch(err => {
      initPromise = null;
      throw err;
    });
  }
  return initPromise;
}

self.onmessage = async (e) => {
  const { id, type, payload } = e.data;
  
  try {
    if (type === 'init') {
      await init(payload?.dictPath);
      self.postMessage({ id, type: 'init_done' });
    } else if (type === 'convert') {
      await init(payload?.dictPath);
      const result = await kuroshiroInstance!.convert(payload.text, {
        mode: 'furigana',
        to: payload.to || 'hiragana'
      });
      self.postMessage({ id, type: 'convert_done', result });
    }
  } catch (error: any) {
    const detail = error?.message || String(error);
    const context = type === 'init' || !kuroshiroInstance ? `Dictionary at ${payload?.dictPath || '(default path)'}: ` : '';
    self.postMessage({ id, type: 'error', error: context + detail });
  }
};
