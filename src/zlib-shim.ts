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
  decompress(): Uint8Array {
    try {
      const res = pako.ungzip(this._data);
      if (res.byteOffset !== 0 || res.byteLength !== res.buffer.byteLength) {
        return new Uint8Array(res.buffer.slice(res.byteOffset, res.byteOffset + res.byteLength));
      }
      return res;
    } catch (e: any) {
      // Passing the compressed bytes through made Kuromoji fail later with an
      // unrelated Int32Array alignment RangeError. Keep the original cause.
      throw new Error(`Dictionary gzip decompression failed: ${e?.message || e}`);
    }
  }
}

const Zlib: any = { Gunzip };
Zlib.Zlib = Zlib;

export { Zlib, Gunzip };
export default { Zlib, Gunzip };
