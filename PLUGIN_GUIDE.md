# CSTL Plugin & Parser Development Guide (Official Reference)

> 📖 **Panduan Resmi Pembuatan Plugin & Custom Parser CSTL (Copas Tool)**
> Dokumen ini dirancang sebagai referensi tunggal dan lengkap, baik untuk developer manusia maupun **AI Assistant (ChatGPT, Claude, Gemini, Cursor, dll.)** untuk membuat plugin format game visual novel, tema tampilan, utilitas, atau parser skrip tunggal yang langsung berfungsi.

---

## 🤖 Prompt Template untuk AI (Copy-Paste ke ChatGPT / Claude / Gemini)

Cara pakai: **Lampirkan file contoh** (atau tempel potongan isinya), isi bagian referensi bila ada, dan minta AI membaca panduan ini. Jawaban yang diharapkan berupa kode paket plugin atau parser siap pakai lengkap dengan simulasi uji coba.

Panduan lengkap: **https://github.com/Atho64/cstl** — `PLUGIN_GUIDE.md` di root repo.

---

### 1. Prompt Template: Paket Plugin Modern (`.zip` / `manifest.json` + `plugin.js`)

```text
Buatkan paket Plugin CSTL (Copas Tool) untuk format file naskah visual novel di bawah ini.

REFERENSI WAJIB — baca dulu panduannya:
PLUGIN_GUIDE.md dari repo https://github.com/Atho64/cstl
(Patuhi seluruh spesifikasi manifest.json, izin permissions, dan siklus hidup CommonJS module.exports).

INPUT DARI SAYA:
1. File contoh   : <lampirkan file asli, atau tempel 10–30 baris pertamanya verbatim / hexdump>
2. Ekstensi/Magic: <misal: .dat, .bin, .ks, atau signature byte biner>
3. Tool referensi: <link repo / tool parser serupa jika ada, boleh kosong>
4. File pendamping (key.bin / tabel karakter / font.dat, jika butuh): <lampirkan file aslinya>
5. Catatan khusus: <opsional — misal: "dialog bisa multi-baris word-wrap", "file biner Shift-JIS">

OUTPUT YANG SAYA BUTUHKAN:
1. File "manifest.json" lengkap dan valid (manifestVersion: 1, api: 1, id, permissions, extensions/magic, settings).
2. File "plugin.js" menggunakan modul CommonJS murni (module.exports = { ... }), BUKAN export default.
3. Penjelasan singkat struktur file (header, offset table, string table, encoding) dan hasil simulasi round-trip.

SYARAT FITUR PLUGIN — WAJIB TERPENUHI:
- Sandbox & Modul: Gunakan module.exports = { async init, async extract, async pack, ... }. Jangan gunakan import/export ESM.
- Ekstraksi (extract):
  • Input: { fileName, buffer, settings, api }
  • Gunakan api.decode(buffer, ['shift_jis', 'cp932', 'utf-8']) untuk membaca teks biner.
  • Return: { lines: [{ number, name, original, raw, index }] }
  • Properti "original" wajib berisi teks dialog (bukan baris kosong/header/perintah murni).
  • Simpan baris mentah utuh di "raw" dan offset byte / nomor indeks di "index" sebagai anchor patch.
- Pengemasan (pack):
  • Input: { fileName, origBuffer, buffer, lines, sourceMap, projectName, settings, api }
  • Gunakan line.translation jika ada, atau fallback ke line.original.
  • Gunakan line.trans_name jika nama pembicara diterjemahkan, atau fallback ke line.name.
  • Return data biner Uint8Array atau string naskah terjemahan yang valid dan siap dimainkan di game.
- Form Setelan (settings di manifest):
  • Buat form setelan yang relevan (misal pilihan encoding, lebar word-wrap, atau slot bahasa).
- Aset Pendamping:
  • Jika membutuhkan tabel karakter atau file pendamping, letakkan di folder assets/ dan baca via await api.asset('assets/<nama>').
- Error Handling:
  • Berikan pesan error yang jelas jika file corrupt atau signature byte tidak cocok.

ROUND-TRIP TEST & SELF-CHECK — lakukan SIMULASI mental pada 2 baris contoh sebelum menjawab, dan tuliskan hasilnya setelah kode:
1. extract(): Tampilkan entri baris hasil ekstraksi.
2. translate: Anggap translation = "Halo, selamat pagi!" dan trans_name (bila ada).
3. pack()   : Tampilkan baris hasil akhir karakter-per-karakter — pastikan tidak ada byte/tag lain yang rusak atau bergeser.
```

---

### 2. Prompt Template: Custom Parser Skrip Tunggal (JavaScript / Python)

Gunakan template ini jika ingin membuat parser skrip untuk editor **Custom Parser** CSTL:

```text
Buatkan skrip Custom Parser CSTL (JavaScript / Python) untuk format naskah di bawah ini.

REFERENSI WAJIB:
PLUGIN_GUIDE.md dari repo https://github.com/Atho64/cstl

INPUT DARI SAYA:
1. File contoh   : <lampirkan file asli, atau tempel 10–30 baris pertamanya verbatim>
2. Bahasa script : <"js" (default Web Worker) atau "python" (Pyodide)>
3. Catatan khusus: <opsional — misal: "format Nama: dialog">

OUTPUT YANG SAYA BUTUHKAN:
Kode fungsi parse(ctx) dan serialize(ctx) yang siap ditempel ke editor Custom Parser CSTL.

KONTRAK PARSER:
1. parse(ctx) — Impor:
   • ctx: { fileName, text, bytes, startLineNum, options, assets, progress }
   • Return: array of { name, message, raw, index } — message wajib dan tidak boleh kosong.
   • Lewati baris komentar / dekorasi (cukup jangan dimasukkan ke array).
2. serialize(ctx) — Ekspor round-trip:
   • ctx: { fileName, text, bytes, lines, options, assets }
   • lines: array of { name, message, trans_name, trans_message, is_translated, raw, index }
   • Gunakan trans_message jika is_translated true, atau fallback ke message asli.
   • Return string teks utuh (atau Uint8Array / bytes untuk format biner).
3. Lakukan simulasi round-trip pada 2 baris contoh setelah kode.
```

---

## 1. Arsitektur Berkas Paket Plugin (`.zip`)

Plugin CSTL didistribusikan dalam format arsip `.zip` standar:

```text
nama-plugin.zip
├── manifest.json       (Wajib: metadata, izin, ekstensi, setelan, UI)
├── plugin.js           (Wajib: kode utama modul CommonJS)
├── theme.css           (Opsional: stylesheet tema visual & watermark)
└── assets/             (Opsional: tabel karakter, aset kamus, gambar)
    ├── tbl.bin
    └── dictionary.txt
```

---

## 2. Spesifikasi Lengkap `manifest.json` (v1)

File `manifest.json` mendefinisikan identitas plugin, sistem perizinan sandbox, ekstensi file yang didukung, dan skema pengaturan form.

```json
{
  "manifestVersion": 1,
  "id": "my-vn-engine-plugin",
  "name": "XYZ Engine Parser & Tools",
  "version": "1.0.0",
  "author": "Komunitas Penerjemah",
  "description": "Parser format naskah biner .dat untuk Visual Novel Engine XYZ.",
  "api": 1,
  "permissions": [
    "project",
    "workspace",
    "clipboard",
    "storage",
    "theme"
  ],
  "extensions": [".dat", ".bin"],
  "magic": [
    { "offset": 0, "hex": "53 43 52 50" }
  ],
  "ui": {
    "title": "Panel XYZ Utility",
    "height": 260
  },
  "settings": {
    "global": [
      {
        "key": "defaultEncoding",
        "label": "Karakter Encoding",
        "type": "select",
        "default": "shift_jis",
        "options": [
          { "value": "utf-8", "label": "UTF-8" },
          { "value": "shift_jis", "label": "Shift-JIS (CP932 / Windows-31J)" }
        ],
        "description": "Encoding teks file biner."
      }
    ],
    "project": [
      {
        "key": "wrapWidth",
        "label": "Lebar Word Wrap",
        "type": "number",
        "default": 42,
        "min": 0,
        "max": 120,
        "description": "Batas karakter per baris (0 = tanpa wrap)."
      }
    ],
    "shared": []
  }
}
```

### Tabel Atribut `manifest.json`:

| Atribut | Tipe | Wajib | Deskripsi |
|---|---|---|---|
| `manifestVersion` | `number` | ✅ | **Harus `1`**. |
| `id` | `string` | ✅ | ID unik alfanumerik (contoh: `"softpal-engine"`, `"spica-theme"`). |
| `name` | `string` | ✅ | Nama judul plugin yang tampil di UI. |
| `version` | `string` | ✅ | Nomor versi (semver, contoh: `"1.0.0"`). |
| `author` | `string` | ➖ | Nama pembuat atau kelompok penerjemah. |
| `description` | `string` | ➖ | Deskripsi singkat fungsi plugin. |
| `api` | `number` | ✅ | Versi Host API CSTL (gunakan `1`). |
| `permissions` | `string[]` | ➖ | Daftar izin sandbox yang diminta (§3). |
| `extensions` | `string[]` | ➖ | Ekstensi file yang didukung (contoh: `[".dat", ".ks"]`). |
| `magic` | `object[]` | ➖ | Signature byte file biner: `[{ "offset": 0, "hex": "4d53" }]` atau varian teks `[{ "offset": 0, "text": "SCRIP" }]`. |
| `ui` | `object` | ➖ | Konfigurasi panel workspace: `{ "title": string, "height": number }` (120–600 px). |
| `settings` | `object` | ➖ | Skema form: `{ global: [], project: [], shared: [] }` (§4). |

---

## 3. Sistem Izin Keamanan (Permissions)

Plugin berjalan dalam sandbox iframe yang aman. Deklarasikan izin hanya sesuai kebutuhan:

| Izin | API yang Terbuka | Kapan Digunakan? |
|---|---|---|
| `project` | `api.getProject()`, `api.getLines()` | Membaca daftar baris proyek atau metadata proyek. |
| `workspace` | `api.copySelection()`, `api.selectRange()`, `api.clearSelection()` | Mengontrol navigasi seleksi baris di tabel editor. |
| `clipboard` | `api.copy(text)` | Menyalin teks langsung ke clipboard sistem. |
| `storage` | `api.saveBlob()`, `api.loadBlob()`, `api.deleteBlob()`, `api.listBlobs()` | Menyimpan file database, tabel cache, atau metadata persisten. |
| `net` | `api.fetch(url, options)` | Menghubungi API online, kamus web, atau LLM eksternal. |
| `files` | `api.pickFile(accept)` | Membuka dialog pemilih file lokal untuk pengguna. |
| `downloads` | `api.download(blob, filename)` | Mengunduh file hasil patch langsung ke komputer pengguna. |
| `theme` | Stylesheet `theme.css` | Mengubah palet warna, tema gelap/terang, dan gambar background. |
| `wasm` | `api.wasm(source, imports)` | Menjalankan modul WebAssembly berkecepatan tinggi (C/Rust). |
| `jszip` | `api.JSZip` | Mengekstrak dan membuat file arsip ZIP secara dinamis. |

---

## 4. Tipe Input Form Setelan (Settings Spec)

CSTL secara otomatis membuatkan antarmuka form pengaturan berdasarkan skema `settings` di manifest:

```json
{
  "key": "wrapWidth",
  "label": "Batas Word Wrap",
  "type": "number",
  "default": 40,
  "min": 0,
  "max": 120,
  "step": 1,
  "placeholder": "0–120",
  "description": "Karakter per baris."
}
```

Tipe input yang didukung:
- `"string"`: Kotak teks input tunggal.
- `"number"`: Input angka dengan opsi `min`, `max`, `step`.
- `"boolean"`: Checkbox tombol switch aktif/nonaktif.
- `"select"`: Dropdown pilihan dengan array `options: [{ value, label }]`.
- `"textarea"`: Area input teks multi-baris.

---

## 5. Host API Reference (`api`)

Objek `api` dioperkan ke semua lifecycle method pada `plugin.js`:

```javascript
// ── Pengaturan (Settings) ──
const wrap = api.settings.wrapWidth || 40;          // Setelan aktif
const enc = api.globalSettings.defaultEncoding;     // Setelan tingkat global

// ── UI Feedback ──
api.toast('Ekstraksi selesai! ' + lines.length + ' baris ditemukan.');

// ── Enkoding & Biner ──
const text = api.decode(uint8Array, ['shift_jis', 'utf-8', 'windows-31j']);
const buffer = api.encode('Halo dunia!', 'shift_jis');

// ── Aset Paket Plugin ──
const assetNames = api.listAssets();                 // ['assets/tbl.bin']
const tblBytes = await api.asset('assets/tbl.bin');  // Uint8Array
const dict = await api.assetText('assets/dict.txt'); // String

// ── Proyek & Workspace ──
const projectInfo = await api.getProject();          // { name, type, fileCount, lineCount, translatedCount }
const lines = await api.getLines();                  // Baris MENTAH proyek — bentuknya lihat §7-C
await api.selectRange(1, 50);                        // Pilih baris nomor 1 s/d 50 (juga isi form rentang)
await api.clearSelection();                          // Kosongkan seleksi
const selected = await api.getSelection();           // Array nomor baris yang sedang terpilih
await api.copySelection();                           // Pemicu copy untuk AI

// ── Penyimpanan Persisten (Storage) ──
await api.saveBlob('cache.bin', uint8Array);
const data = await api.loadBlob('cache.bin');        // ArrayBuffer / null
await api.deleteBlob('cache.bin');
const exists = await api.blobExists('cache.bin');    // boolean
const keys = await api.listBlobs();                  // ['cache.bin', ...]

// ── Dialog & Unduhan ──
const file = await api.pickFile('.dat,.bin');        // { name, buffer: ArrayBuffer }
api.download(blobData, 'script_translated.dat');

// ── WebAssembly & JSZip ──
const wasm = await api.wasm(wasmBinaryBytes);
const zip = new api.JSZip();
```

> ℹ️ **Catatan `api.encode`**: mendukung `utf-8` (default) dan **Shift_JIS/CP932 penuh**
> (label: `shift_jis`, `sjis`, `cp932`, `windows-31j`; termasuk varian Windows seperti
> fullwidth tilde U+FF5E dan wave dash U+301C). Encoding lain, atau karakter yang tidak
> ada di tabel Shift_JIS (mis. emoji), akan **melempar error** — bukan diam-diam
> dikodekan sebagai UTF-8.

### `api.fetch(url, options)` — butuh izin `net`

Permintaan jaringan **diproxikan oleh host** dengan batasan keamanan:

- Hanya method `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `HEAD`, `OPTIONS`.
- Target ke localhost / IP privat / loopback **diblokir** (anti-SSRF), termasuk saat redirect.
- `credentials: 'omit'`; `options.timeoutMs` / `options.timeout` (1000–120000, default 30000);
  `options.body` berupa object otomatis di-JSON-kan; `options.as: 'bytes'` untuk body biner.
- Rate limit 60 permintaan/menit per plugin.
- **Return**: `{ ok, status, statusText, url, headers, body, buffer }` — `body` string
  (atau `Uint8Array` bila `as: 'bytes'`), `buffer` `ArrayBuffer` mentah.

### `api.runWasm(source, input?, exportName?, options?)` — butuh izin `wasm`

Menjalankan modul WASM di worker terpisah dengan timeout dan cache modul. Modul wajib
mengekspor `memory` beserta `alloc`/`malloc`. Alternatif sekali-jalan dari `api.wasm()`
yang lebih lengkap (kontrol import/instantiate sendiri).

### Events — `api.on(event, fn)` dan hook `onEvent(event, payload, api)`

Plugin dapat mendengarkan event bawaan host (tanpa izin tambahan):

| Event | Payload | Dipicu saat |
|---|---|---|
| `projectOpen` | `{ name, type, lineCount, translatedCount }` atau `null` | Pengguna membuka proyek |
| `projectClose` | `null` | Pengguna kembali ke dashboard |

`api.on(ev, fn)` mengembalikan fungsi unsubscribe. Hook `onEvent` menerima SEMUA event.

---

## 6. Siklus Hidup & Penulisan `plugin.js`

> ⚠️ **Aturan Kritis Penulisan Kode**:
> - Gunakan **CommonJS (`module.exports`)**. Jangan gunakan `export default`.
> - Jalankan operasi asinkron dengan `async/await`.
> - Hindari manipulasi DOM `document` langsung di luar fungsi `onMount`.

```javascript
module.exports = {
  // 1. Dijalankan sekali saat plugin dimuat
  async init(api) {
    console.log('[Plugin]', api.pluginId, 'berhasil diinisialisasi.');
  },

  // 2. Impor / Ekstraksi File
  async extract({ fileName, buffer, settings, api }) {
    // buffer: Uint8Array data mentah file yang diimpor
    const lines = [];
    const text = api.decode(buffer, [settings.defaultEncoding || 'shift_jis']);
    let num = 1;

    for (const raw of text.split(/\r?\n/)) {
      const match = raw.match(/^([A-Za-z0-9_]+)\s*:\s*(.+)$/);
      if (match) {
        lines.push({
          number: num++,
          name: match[1],
          original: match[2],
          raw: raw
        });
      } else if (raw.trim()) {
        lines.push({
          number: num++,
          name: null,
          original: raw,
          raw: raw
        });
      }
    }

    return {
      lines,
      sourceMap: { totalRawLines: num } // Metadata opsional untuk tahap pack
    };
  },

  // 3. Ekspor / Pengemasan Kembali
  async pack({ fileName, origBuffer, buffer, lines, sourceMap, projectName, settings, api }) {
    let resultText = '';

    for (const line of lines) {
      const dialog = line.translation || line.original;
      const speaker = line.trans_name || line.name;

      if (speaker) {
        resultText += `${speaker}: ${dialog}\n`;
      } else {
        resultText += `${dialog}\n`;
      }
    }

    return api.encode(resultText, settings.defaultEncoding || 'shift_jis');
  },

  // 4. Hook Pre-copy AI
  async onCopy(text, api, ctx) {
    return text;
  },

  // 5. Hook Post-apply Translation
  async onApply(text, api, ctx) {
    return text.replace(/""/g, '"');
  },

  // 6. Panel Antarmuka Kustom di Workspace
  async onMount(rootElement, api) {
    rootElement.innerHTML = `
      <div style="padding: 12px; font-family: sans-serif;">
        <button id="btnQuickCheck" class="btn btn-primary btn-sm">Cek Baris Kosong</button>
      </div>
    `;
    rootElement.querySelector('#btnQuickCheck').onclick = async () => {
      const lines = await api.getLines();
      // PENTING: getLines() mengembalikan baris MENTAH proyek — teks terjemahan
      // ada di `trans_message`, BUKAN `translation` (lihat §7-C).
      const empty = lines.filter(l => !l.trans_message);
      api.toast(`Sisa baris belum diterjemahkan: ${empty.length}`);
    };
  },

  async onUnmount(api) {
    // Bersihkan resource saat panel ditutup
  },

  // 7. Perintah Shortcut Keyboard Kustom
  commands: [
    {
      id: 'format-tags',
      label: 'Format Tag Karakter Khusus',
      async run(api) {
        api.toast('Format tag berhasil dieksekusi.');
      }
    }
  ]
};
```

---

## 7. Format Data: Baris Naskah & Tipe Return

Ada **tiga bentuk objek baris yang berbeda** — perhatikan masing-masing dipakai di mana:

### A. Baris yang di-RETURN dari `extract()` (plugin → host)

| Properti | Tipe | Keterangan |
|---|---|---|
| `number` | `number` | Nomor urut (1-based); bila dikosongkan, host menomori otomatis. |
| `name` | `string \| null` | Nama karakter / pembicara asli (alias: `character_name`). |
| `original` | `string` | **Wajib.** Teks dialog asli (alias: `message`, `text`). |
| `raw` | `string \| null` | Potongan baris asli utuh — anchor saat patch ekspor. |
| `index` | `number \| null` | Offset byte / indeks unik entri biner. |

### B. Baris di `ctx.lines` pada `pack()` (host → plugin)

Berisi field internal **plus** alias praktis:

| Properti | Keterangan |
|---|---|
| `line_num`, `file` | Nomor baris (1-based) dan nama file sumber. |
| `name`, `message` | Nama & teks asli. |
| `trans_name`, `trans_message`, `is_translated` | Hasil terjemahan. |
| `original`, `translation` | Alias dari `message` / `trans_message` (`translation` = `''` bila belum diterjemahkan). |
| `character_name` | Alias dari `trans_name \|\| name`. |
| `raw`, `index` | Anchor dari hasil `extract()`. |

> ⚠️ Bentuk ini **tidak punya field `number`** — gunakan `line_num`.

### C. Baris yang di-RETURN dari `api.getLines()` (host → plugin, mentah)

| Properti | Keterangan |
|---|---|
| `line_num` | Nomor baris (1-based). **Bukan `number`.** |
| `file` | Nama file sumber. |
| `name`, `message` | Nama & teks asli. **Bukan `original`.** |
| `trans_name`, `trans_message` | Nama & teks terjemahan. **Bukan `translation`.** |
| `is_translated` | `true` bila baris sudah diterjemahkan. |

### Tipe Return pada `pack()`:
- `Uint8Array` / `ArrayBuffer`: Data biner naskah.
- `string`: Naskah teks.
- `Blob`: Objek blob file.
- **Multi-file** — bila `files` berisi entri valid, ia **diprioritaskan** di atas `buffer`:
  ```javascript
  return {
    fileName: "hasil_ekspor",        // opsional — hanya fallback, lihat catatan nama di bawah
    files: [
      { name: "script01.dat", buffer: file1Bytes },   // Uint8Array / ArrayBuffer
      { name: "sub/script02.dat", content: "teks" }   // atau content: string
    ]
  };
  ```
  - `files` berisi **1 entri** → file tersebut dikembalikan apa adanya.
  - `files` berisi **2 entri atau lebih** → host otomatis membungkus semuanya menjadi
    satu arsip untuk diunduh pengguna.

> ℹ️ **Penamaan file keluaran** (ditentukan host, bukan plugin):
> - Output tunggal → **nama file yang diimpor** (mis. impor `script01.dat` → hasil `script01.dat`).
> - Output multi-file (arsip) → **nama proyek** + `.zip`.
> - `fileName`/`filename` dari plugin hanya dipakai sebagai fallback bila keduanya tidak tersedia.

---

## 8. Panduan Tema Visual (`theme.css`)

Plugin tema visual mengontrol seluruh palet warna CSTL dan dapat menyertakan background art:

```css
/* Palet Warna Terang Bernuansa Biru */
:root {
  --bg: #f3f8fd;
  --bg-2: #e5f0fa;
  --panel: #ffffff;
  --panel-2: #f0f7fe;
  --line: #d1e4f5;
  --line-2: #b9d7f0;
  --text: #0f172a;
  --muted: #475569;
  --primary: #0284c7;
  --primary-hover: #0369a1;
  --primary-soft: rgba(2, 132, 199, 0.12);
  --accent: #38bdf8;
}

/* Background Artwork Karakter (Gunakan Base64 / SVG) */
#dashboardView::after,
body::after {
  content: "";
  position: fixed;
  right: 16px;
  bottom: 16px;
  width: 420px;
  height: 420px;
  background-image: url("data:image/jpeg;base64,...");
  background-size: contain;
  background-repeat: no-repeat;
  background-position: bottom right;
  opacity: 0.22;
  pointer-events: none;
  z-index: 0;
}
```

---

## 9. Integrasi Pintasan Keyboard (Shortcuts)

Perintah yang didaftarkan di array `commands` pada `plugin.js` akan otomatis muncul di **Shortcut Keyboard Manager** (grup **Plugin**).

### Pintasan Bawaan CSTL:

| Kategori | Aksi | Shortcut Default |
|---|---|---|
| **Dashboard** | Fokus Cari Project | `/` |
| **Workspace (Umum)** | Ekspor Terjemahan | `Alt + E` |
| | Buka Cari & Ganti (*Proofread*) | `Alt + R` |
| | Buka Tab Glosarium | `Alt + G` |
| | Buka Tab AI Check | `Alt + K` |
| | Buka Plugin & Parser Manager | `Alt + P` |
| | Buka Pengaturan Project | `Alt + S` |
| | Kembali ke Dashboard | `Alt + B` |
| | Buka Daftar Bookmark | `Alt + M` |
| | Jalankan Auto Translate | `Alt + T` |
| **Seleksi & Navigasi** | Pilih Semua Baris | `Alt + A` |
| | Batal Pilih Baris | `Alt + Q` |
| | Pilih Rentang Baris | `Alt + L` |
| | Batch Sebelumnya | `Alt + ↑` |
| | Batch Berikutnya | `Alt + ↓` |
| **Terjemahan & Undo** | Copy untuk AI | `Alt + C` |
| | Fokus Kolom Paste AI | `Alt + V` |
| | Terapkan Terjemahan | `Ctrl + Enter` |
| | Undo Terjemahan | `Alt + Z` |
| | Redo Terjemahan | `Alt + Y` |
| **Perintah Plugin** | Perintah Kustom Plugin | *Dikonfigurasi di menu Shortcut* |

---

## 10. Checklist Pemecahan Masalah (Troubleshooting)

- ❌ **Error: Manifest tidak valid: "manifestVersion" wajib diisi**
  &rarr; Pastikan file `manifest.json` memiliki `"manifestVersion": 1` dan `"api": 1`.
- ❌ **Error: Unexpected token 'export'**
  &rarr; Plugin sandbox menggunakan CommonJS. Gunakan `module.exports = { ... }`, bukan `export default`.
- ❌ **Warna tema tidak berubah saat dipasang**
  &rarr; Pastikan manifest menyertakan `"permissions": ["theme"]` dan terdapat file `theme.css`.
- ❌ **File biner menghasilkan teks acak/karakter aneh**
  &rarr; Gunakan `api.decode(buffer, ['shift_jis', 'cp932'])` untuk game bahasa Jepang jadul.
