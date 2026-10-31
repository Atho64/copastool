// @module speaker-name.ts — Heuristik "teks sebelum titik dua ini nama pembicara?"
//
// Dipakai parser paste berformat nomor ("123. Nama: teks"), yang harus menebak
// apakah bagian sebelum titik dua adalah nama karakter atau bagian dari kalimat.
// Nama karakter boleh memuat koma — "Nino, Menoa, Ichito" (beberapa nama
// sekaligus) atau "Yuki, Sang Ketua" (nama + gelaran) — tapi kalimat biasa
// seperti "Yah, aku tidak tahu: ..." tidak boleh ikut terpotong jadi nama.
//
// Modul ini sengaja tanpa dependensi runtime selain string-utils supaya bisa
// diuji langsung dengan Node (lihat scripts/test-parse-speakers.mjs).

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
 * Apakah `cand` (teks sebelum titik dua) terlihat seperti nama karakter?
 *
 * Koma diperbolehkan selama setiap bagian tetap terlihat seperti nama: bagian
 * setelah koma wajib dimulai huruf besar atau aksara non-Latin, tidak boleh ada
 * koma menggantung ("A," atau "A,, B"), dan jumlah bagian dibatasi.
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
    // Setiap bagian harus dimulai seperti nama; ini yang membedakan
    // "Nino, Menoa, Ichito" (nama) dari "Yah, aku tidak tahu" (kalimat).
    if (commaParts.some(part => !NAME_PART_START_RE.test(part))) return false;
  }

  if (clean.length > (hasComma ? MAX_COMMA_NAME_LENGTH : MAX_PLAIN_NAME_LENGTH)) return false;
  if (clean.split(/\s+/).filter(Boolean).length > (hasComma ? MAX_COMMA_NAME_WORDS : MAX_PLAIN_NAME_WORDS)) return false;
  // Tanda tanya (?/？), tanda seru (!/！), tilde (~/〜), tanda kurung, koma, dan
  // apostrof diperbolehkan di nama karakter (misal: "Nama???", "Gadis?", "???",
  // "Nama!", "Sosok (???)", "Nino, Menoa, Ichito", "Shin'ichirō").
  if (NAME_FORBIDDEN_RE.test(clean)) return false;
  return true;
}
