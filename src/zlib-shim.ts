/**
 * Shim for zlibjs/bin/gunzip.min.js
 * Replaces the old zlibjs library (which breaks in ES module scope because it uses `var aa = this`)
 * with a pako-based implementation of the Zlib.Gunzip API that kuromoji expects.
 */
import * as pako from 'pako';

class Gunzip {
  private _data: Uint8Array;

  constructor(data: Uint8Array) {
    this._data = data;
  }
  decompress() {
    try {
      return pako.ungzip(this._data);
    } catch (e: any) {
      // If the browser already decompressed the gzip file transparently 
      // (due to Content-Encoding headers from the CDN or server), pako will throw an error.
      // In that case, the data is already decompressed, so we just return it.
      console.warn('[ZLIB-SHIM] pako.ungzip failed (likely already decompressed):', e?.message || e);
      return this._data;
    }
  }
}

export const Zlib = { Gunzip };
export default { Zlib };
