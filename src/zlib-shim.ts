/**
 * Shim for zlibjs/bin/gunzip.min.js: a pako-based Zlib.Gunzip with the API kuromoji
 * expects. The old zlibjs breaks in ES module scope (it uses `var aa = this`).
 */
import * as pako from 'pako';

class Gunzip {
  private _data: Uint8Array;

  constructor(data: Uint8Array) {
    this._data = data;
  }
  decompress(): Uint8Array {
    try {
      const res = pako.ungzip(this._data);
      if (res.byteOffset !== 0 || res.byteLength !== res.buffer.byteLength) {
        return new Uint8Array(res.buffer.slice(res.byteOffset, res.byteOffset + res.byteLength));
      }
      return res;
    } catch (e: any) {
      // Passing the compressed bytes through made Kuromoji fail later with an
      // unrelated Int32Array alignment RangeError, so keep the original cause.
      throw new Error(`Dictionary gzip decompression failed: ${e?.message || e}`);
    }
  }
}

const Zlib: any = { Gunzip };
Zlib.Zlib = Zlib;

export { Zlib, Gunzip };
export default { Zlib, Gunzip };
