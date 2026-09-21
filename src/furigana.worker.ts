import Kuroshiro from 'kuroshiro';
// @ts-ignore
import KuromojiAnalyzer from 'kuroshiro-analyzer-kuromoji';

let kuroshiroInstance: Kuroshiro | null = null;
let initPromise: Promise<void> | null = null;

async function init() {
  if (kuroshiroInstance) return;
  if (!initPromise) {
    initPromise = (async () => {
      const kuroshiro = new Kuroshiro();
      const dictPath = import.meta.env.BASE_URL + 'dict/';
      await kuroshiro.init(new KuromojiAnalyzer({ dictPath }));
      kuroshiroInstance = kuroshiro;
    })();
  }
  return initPromise;
}

self.onmessage = async (e) => {
  const { id, type, payload } = e.data;
  
  try {
    if (type === 'init') {
      await init();
      self.postMessage({ id, type: 'init_done' });
    } else if (type === 'convert') {
      await init();
      const result = await kuroshiroInstance!.convert(payload.text, {
        mode: 'furigana',
        to: payload.to
      });
      self.postMessage({ id, type: 'convert_done', result });
    }
  } catch (error: any) {
    self.postMessage({ id, type: 'error', error: error?.message || String(error) });
  }
};
