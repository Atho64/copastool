// @module speaker-name.ts: heuristik "teks sebelum titik dua ini nama pembicara?".
//
// Dipakai parser paste berformat nomor ("123. Nama: teks"), yang harus menebak
// apakah bagian sebelum titik dua adalah nama karakter atau bagian kalimat. Nama
// boleh memuat koma ("Nino, Menoa, Ichito", "Yuki, Sang Ketua"), tapi kalimat
// seperti "Yah, aku tidak tahu: ..." tidak boleh terpotong jadi nama.
// Tanpa dependensi runtime selain string-utils supaya bisa diuji di Node.

import { stripDecorativeWrapping } from './string-utils.ts';

/** Awal yang masuk akal untuk sebuah nama: huruf besar Latin atau aksara non-Latin. */
const NAME_PART_START_RE = /^[A-Z\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u024F\u0370-\u052F\u0590-\u06FF\u0900-\u0DFF\u0E00-\u0E7F\u1100-\u11FF\u3040-\u30FF\u3130-\u318F\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF\uFF21-\uFF3A]/;

/** Tanda baca yang tidak mungkin bagian dari nama karakter. */
const NAME_FORBIDDEN_RE = /[.…—–\n\r"“”«»「」『』]/;

/** Batas aman supaya kalimat panjang tidak lolos sebagai nama. */
const MAX_PLAIN_NAME_LENGTH = 40;
const MAX_COMMA_NAME_LENGTH = 60;
const MAX_PLAIN_NAME_WORDS = 5;
const MAX_COMMA_NAME_WORDS = 8;
const MAX_NAME_PARTS = 6;
const MAX_NAME_PART_LENGTH = 30;

/**
 * Apakah `cand` (teks sebelum titik dua) terlihat seperti nama karakter? Koma
 * diperbolehkan selama tiap bagian tetap terlihat seperti nama: diawali huruf
 * besar atau aksara non-Latin, tanpa koma menggantung, dengan jumlah dibatasi.
 */
export function isPlausibleSpeakerName(cand: string): boolean {
  let clean = String(cand || '').replace(/^\[\?\]\s*/, '').trim();
  if (!clean) return false;
  clean = stripDecorativeWrapping(clean);
  if (!clean) return false;
  // Karakter misterius/anonim seperti "???", "？？？", "??", "？", "!"
  if (/^[?？!！]+$/.test(clean)) return true;
  if (/^\d+$/.test(clean)) return false;

  const commaParts = clean.split(/\s*[,，]\s*/);
  const hasComma = commaParts.length > 1;
  if (hasComma) {
    if (commaParts.length > MAX_NAME_PARTS) return false;
    // "Nino," (koma menggantung) atau "Nino,, Menoa" bukan nama.
    if (commaParts.some(part => !part)) return false;
    if (commaParts.some(part => part.length > MAX_NAME_PART_LENGTH)) return false;
    // Ini yang membedakan "Nino, Menoa, Ichito" (nama) dari
    // "Yah, aku tidak tahu" (kalimat).
    if (commaParts.some(part => !NAME_PART_START_RE.test(part))) return false;
  }

  if (clean.length > (hasComma ? MAX_COMMA_NAME_LENGTH : MAX_PLAIN_NAME_LENGTH)) return false;
  if (clean.split(/\s+/).filter(Boolean).length > (hasComma ? MAX_COMMA_NAME_WORDS : MAX_PLAIN_NAME_WORDS)) return false;
  // Tanda tanya, tanda seru, tilde, kurung, koma, dan apostrof boleh ada di nama
  // (misal "Nama???", "Sosok (???)", "Shin'ichirō").
  if (NAME_FORBIDDEN_RE.test(clean)) return false;
  return true;
}
