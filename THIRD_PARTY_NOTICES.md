# Third-Party Notices

CopasTool sendiri dirilis di bawah **MIT License** (lihat [LICENSE](./LICENSE)).

CopasTool **menggunakan atau mengandalkan** karya pihak ketiga di bawah ini. Masing-masing tetap milik pembuatnya dan tunduk pada lisensinya sendiri. Berkas ini mencatat atribusi dan syarat yang berlaku.

> **Catatan:** seluruh dependensi pihak ketiga di sini berlisensi permisif dan
> kompatibel dengan MIT. Tidak ada komponen copyleft atau non-komersial yang
> dibundel maupun dibutuhkan oleh CopasTool.

---

## Dependensi npm (dibundel ke aplikasi)

| Paket | Lisensi | Pemegang Hak |
|---|---|---|
| `jszip` | MIT *atau* GPL-3.0-or-later (dipakai sebagai **MIT**) | Stuart Knightley, David Duponchel, Juan Mellado |
| `kuroshiro` | MIT | Hexenq |
| `kuroshiro-analyzer-kuromoji` | MIT | Hexenq |
| `pako` | MIT *dan* Zlib | Vitaly Puzrin, Andrei Tuputcyn |
| `path-browserify` | MIT | Jason Palmer |

Aplikasi memilih opsi **MIT** pada `jszip` yang berlisensi ganda.

## Kredensial furigana

Kamus morfologi Jepang yang dipakai untuk konversi furigana berasal dari **Kuromoji** (Atilika Inc.), berlisensi **Apache License 2.0**. Kamus IPADIC yang dibundel di `public/dict/` tunduk pada lisensi **NAIST** yang mengizinkannya untuk redistribusi.

## Parser & plugin pihak ketiga

Format game tambahan yang didukung lewat sistem plugin (lihat [PLUGIN_GUIDE.md](./PLUGIN_GUIDE.md))
mungkin menyertakan parser yang ditulis oleh pihak lain. Setiap paket plugin membawa
`manifest.json` sendiri; tanggung jawab lisensi ada pada penulis plugin masing-masing.

## Melaporkan masalah

Jika kamu pemegang hak cipta dari salah satu komponen di atas dan merasa atribusi atau
penggunaannya perlu diperbaiki, buka issue di repositori CopasTool.
