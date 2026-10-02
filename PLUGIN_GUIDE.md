# CSTL Plugin & Parser Development Guide (Official Reference)

> 📖 **Panduan Resmi Pembuatan Plugin & Custom Parser CSTL (Copas Tool)**
> Dokumen ini dirancang sebagai referensi tunggal dan lengkap, baik untuk developer manusia maupun **AI Assistant (ChatGPT, Claude, Gemini, Cursor, dll.)** untuk membuat plugin format game visual novel, tema tampilan, utilitas, atau parser skrip tunggal yang langsung berfungsi.

> ✅ **Diperbarui 2 Oktober 2026** — disinkronkan dengan `src/plugins.ts`, `src/plugin-types.ts`, dan `src/plugin-host-bridge.ts`. Versi Host API: **1**.

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
(Patuhi seluruh spesifikasi manifest.json, daftar permissions, dan siklus hidup CommonJS module.exports.)

INPUT DARI SAYA:
1. File contoh   : <lampirkan file asli, atau tempel 10–30 baris pertamanya verbatim / hexdump>
2. Ekstensi/Magic: <misal: .dat, .bin, .ks, atau signature byte biner>
3. Tool referensi: <link repo / tool parser serupa jika ada, boleh kosong>
4. File pendamping (key.bin / tabel karakter / font.dat, jika butuh): <lampirkan file aslinya>
5. Catatan khusus: <opsional — misal: "dialog bisa multi-baris word-wrap", "file biner Shift-JIS">

OUTPUT YANG SAYA BUTUHKAN:
1. File "manifest.json" lengkap dan valid (manifest_version: 1, api: 1, id, permissions, extensions/magic, settings).
2. File "plugin.js" menggunakan modul CommonJS murni (module.exports = { ... }), BUKAN export default.
3. Penjelasan singkat struktur file (header, offset table, string table, encoding) dan hasil simulasi round-trip.

SYARAT FITUR PLUGIN — WAJIB TERPENUHI:
- Sandbox & Modul: Gunakan module.exports = { async init, async extract, async pack, ... }. Jangan gunakan import/export ESM.
- Ekstraksi (extract):
  • Input: { fileName, buffer, settings, globalSettings, sharedSettings, api }
  • Gunakan api.decode(buffer, ['shift_jis', 'cp932', 'utf-8']) untuk membaca teks biner.
  • Return: { lines: [{ file, name, message, raw, index }] }
  • Field "message" WAJIB berisi teks dialog dan TIDAK BOLEH kosong — baris tanpa message akan
    dibuang oleh host. (Alias yang juga diterima: original, original_text, text.)
  • Simpan baris mentah utuh di "raw" dan offset byte / nomor indeks di "index" sebagai anchor patch.
- Pengemasan (pack):
  • Input: { fileName, origBuffer, buffer, lines, sourceMap, projectName, settings, globalSettings, sharedSettings, api }
  • Gunakan line.translation jika ada, atau fallback ke line.original.
  • Gunakan line.trans_name jika nama pembicara diterjemahkan, atau fallback ke line.name.
  • Return salah satu: Uint8Array | string | Blob | { buffer } | { files: [...] } untuk multi-file.
- Form Setelan (settings di manifest):
  • Buat form setelan yang relevan (misal pilihan encoding, lebar word-wrap, atau slot bahasa).
  • "key" harus nama variabel JS valid (contoh: maxDepth), dan unik lintas scope global/project/shared.
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

`manifest.json` dan `plugin.js` dibaca dari **root arsip** (bukan di dalam subfolder).

### Cara plugin dimuat

Kode `plugin.js` dibungkus dan dijalankan dengan `new Function('module', 'exports', 'CSTL', 'document', 'window', code)`.
Artinya di dalam `plugin.js` tersedia: `module`, `exports`, `CSTL`, `document`, `window`.

> ⚠️ Meski `document` dan `window` tersedia, **jangan memanipulasi DOM global secara langsung.**
> Gunakan API resmi (`api.ui()`, `api.createModal()`, `api.injectStyle()`) agar panel plugin bisa
> dibersihkan otomatis saat ditutup. Manipulasi DOM langsung berisiko bocor saat plugin di-unmount.

`plugin.js` **wajib** mengekspor objek. Kalau tidak, host melempar:
`Plugin "<nama>" tidak mengekspor objek (module.exports).`

---

## 2. Spesifikasi Lengkap `manifest.json` (v1)

File `manifest.json` mendefinisikan identitas plugin, deklarasi izin, ekstensi file yang didukung, dan skema pengaturan form.

```json
{
  "manifest_version": 1,
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

### Tabel Atribut `manifest.json`

| Atribut | Tipe | Wajib | Aturan Validasi |
|---|---|---|---|
| `manifest_version` | `number` | ✅ | Harus `1`. Alias lama `manifestVersion` (camelCase) juga diterima, tapi **snake_case yang dianjurkan**. |
| `id` | `string` | ✅ | Regex `^[a-z0-9][a-z0-9_-]{0,63}$` — **huruf kecil**, angka, `_`, `-`. 1–64 karakter, diawali alfanumerik. |
| `name` | `string` | ✅ | 1–120 karakter. |
| `version` | `string` | ✅ | 1–32 karakter (disarankan semver, contoh: `"1.0.0"`). |
| `author` | `string` | ➖ | Maks 120 karakter. |
| `description` | `string` | ➖ | Maks 600 karakter. |
| `api` | `number` | ➖ | Bila diisi, harus bilangan bulat `1`–`1` (versi API aplikasi). |
| `permissions` | `string[]` | ➖ | Harus dari daftar §3. Nama izin tak dikenal → manifest ditolak. |
| `extensions` | `string[]` | ➖ | Maks 64 entri. Tiap entri cocok `^\.[a-z0-9]{1,16}$` (contoh `.ks`). **Tidak boleh** mengklaim `.copas` atau `.cstl` (format bawaan). |
| `magic` | `object[]` | ➖ | Maks 32 entri. Tiap entri punya `hex` **atau** `text` — **tidak keduanya**. `offset` opsional, bilangan bulat 0–8192. |
| `ui` | `object` | ➖ | `{ "title": string (1–200), "height": number }`. **`height` valid 60–2000 px.** |
| `settings` | `object` | ➖ | `{ global?, project?, shared? }` — lihat §4. |

### Detail `magic`

```json
{ "offset": 0, "hex": "504b0304" }
{ "offset": 4, "text": "SCRIP" }
```

- `hex` — heksadesimal, jumlah digit **genap**, maks **128 byte** (256 digit). Spasi diabaikan.
- `text` — string tidak kosong, maks **128 byte** setelah UTF-8.
- `offset` — 0–8192, default `0`.

---

## 3. Izin (Permissions)

Plugin mendeklarasikan izin di manifest. Deklarasikan hanya yang benar-benar dipakai — daftar ini tampil di UI Plugin Manager sebagai informasi bagi pengguna.

| Izin | Label UI | API / Fitur yang Berkaitan |
|---|---|---|
| `project` | Baca project | `api.getProject()`, `api.getLines()`, `api.getLine()`, `api.getState()` |
| `workspace` | Ubah seleksi | `api.getSelection()`, `api.selectRange()`, `api.clearSelection()`, `api.copySelection()`, `api.updateLine()`, `api.addLine()`, `api.removeLine()`, `api.markTranslated()` |
| `clipboard` | Clipboard | `api.copy(text)` |
| `files` | Pilih file | `api.pickFile(accept)` |
| `downloads` | Unduhan | `api.download(data, filename)` |
| `storage` | Penyimpanan | `api.saveBlob()`, `api.loadBlob()`, `api.deleteBlob()`, `api.listBlobs()`, `api.blobExists()` |
| `wasm` | WebAssembly | `api.wasm(source, imports)`, `api.runWasm(...)` |
| `jszip` | JSZip | `api.JSZip` |
| `theme` | Tema | `theme.css` dan `api.setTheme()` / `api.injectStyle()` |
| `net` | Akses Internet | `api.fetch(url, options)` |
| `hooks` | Copy/paste | `onCopy` dan `onApply` |

> ⚠️ **Penting — izin bersifat deklaratif, bukan penggerbang.**
> Runtime saat ini **tidak menolak** pemanggilan API yang izinnya belum dideklarasikan
> (`_assertGranted` sengaja permisif agar plugin Aera bisa berjalan tanpa deklarasi).
> Jadi jangan mengandalkan `permissions` sebagai sandbox keamanan — ia adalah
> **kontrak kepercayaan dan informasi bagi pengguna**. Tetap deklarasikan dengan jujur.

---

## 4. Tipe Input Form Setelan (Settings Spec)

CSTL membuatkan antarmuka form pengaturan otomatis berdasarkan skema `settings`:

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

### Tipe yang didukung

| `type` | Kontrol UI | Field Tambahan |
|---|---|---|
| `"string"` | Kotak teks satu baris | `placeholder` |
| `"number"` | Input angka | `min`, `max`, `step` (semua harus angka) |
| `"boolean"` | Checkbox / switch | — |
| `"select"` | Dropdown | `options` **wajib**, min 1, maks 100 pilihan |
| `"textarea"` | Area teks multi-baris | `placeholder` |

`type` boleh dikosongkan → dianggap `"string"`.

### Aturan validasi

| Field | Aturan |
|---|---|
| `key` | **Wajib.** Harus nama variabel JS valid: `^[a-zA-Z_$][a-zA-Z0-9_$]*$` (contoh `maxDepth`). **Unik lintas scope** — tidak boleh sama di `global` dan `project`. |
| `label` | **Wajib.** 1–200 karakter. |
| `description` | Maks 600 karakter. |
| `placeholder` | Maks 400 karakter. |
| `options[].value` | String 1–400 karakter. Boleh juga string langsung (bukan objek). |

**Batas keseluruhan:** maks **64 entri per scope**, total maks **128 entri**. Kunci `settings` di luar `global`/`project`/`shared` akan ditolak.

### Scope setelan

| Scope | Sifat | Diakses via |
|---|---|---|
| `global` | Berlaku lintas project, disimpan di pengaturan aplikasi. | `api.globalSettings` |
| `project` | Tersimpan per project. | `api.settings` |
| `shared` | Dibagikan antar plugin (mis. profil bahasa bersama). | `api.sharedSettings` |

---

## 5. Host API Reference (`api`)

Objek `api` dioperkan ke semua lifecycle method dan selalu tersedia sebagai `pluginObj.api`.

### Identitas & Setelan

```javascript
api.version        // 1 — versi Host API
api.pluginId       // "my-plugin"
api.settings       // setelan aktif untuk plugin ini (scope project)
api.globalSettings // setelan scope global
api.sharedSettings // setelan scope shared
api.getPluginMeta()  // { id, name, version, author, description, permissions, extensions, ... }
```

### Membaca & Menulis Baris

```javascript
const info = await api.getProject();   // { name, type, fileCount, lineCount, translatedCount, rawLineCount }
const lines = await api.getLines();    // baris MENTAH proyek — bentuknya lihat §7-C
const line = api.getLine(42);          // satu baris berdasarkan line_num, atau null

api.updateLine(42, { trans_message: 'Halo', is_translated: true }); // true bila berhasil
api.addLine({ line_num: 999, file: 'x.txt', name: null, message: 'Baris baru' });
api.removeLine(42);
api.markTranslated(42, 'Halo', 'Budi');  // tandai diterjemahkan + isi terjemahan sekaligus

const snap = api.getState();           // { projectId, projectName, projectType, files, lineCount, translatedCount, selected, bookmarks }
```

> ℹ️ `getProject()`, `getLines()`, dan `getLine()` adalah **sinkron** (bukan Promise) —
> tapi tetap aman di-`await`.

### Seleksi & Clipboard

```javascript
const sel = api.getSelection();        // [1, 2, 3] — nomor baris terpilih
api.selectRange(1, 50);                // isi form rentang + picu seleksi (1 ≤ from ≤ to)
api.clearSelection();
api.copySelection();                   // picu copy-untuk-AI (menghormati hook onCopy)

await api.copy('teks');                // salin langsung ke clipboard sistem
```

`api.selectRange()` melempar error bila rentang tidak valid (`from < 1`, `to < from`, atau rentang > 1.000.000 baris).

### Feedback & Dialog

```javascript
api.toast('Ekstraksi selesai!');
await api.prompt('Nama profil', 'default');   // → string | null
await api.confirm('Hapus data?', 'Tidak bisa dibatalkan.');  // → boolean | null
await api.alert('Selesai', 'Tersimpan.');      // → void
```

### Enkoding & Biner

```javascript
const text = api.decode(uint8Array, ['shift_jis', 'utf-8', 'windows-31j']);
const buffer = api.encode('Halo dunia!', 'shift_jis');   // → Uint8Array
```

> ℹ️ **`api.encode`**: mendukung `utf-8` (default) dan **Shift_JIS/CP932 penuh**
> (label: `shift_jis`, `sjis`, `cp932`, `windows-31j`; termasuk varian Windows seperti
> fullwidth tilde U+FF5E dan wave dash U+301C). Encoding lain, atau karakter yang tidak
> ada di tabel Shift_JIS (mis. emoji), akan **melempar error** — bukan diam-diam
> dikodekan sebagai UTF-8.
>
> `api.decode` mencoba tiap encoding berurutan dengan `fatal: true`; bila semua gagal,
> jatuh ke UTF-8 non-fatal. Default urutan: `utf-8`, `shift_jis`, `windows-31j`, `cp932`.

### Aset Paket Plugin

```javascript
const names = api.listAssets();                        // daftar SEMUA file di dalam zip
const bytes = await api.asset('assets/tbl.bin');       // Uint8Array
const text  = await api.assetText('assets/dict.txt');  // string
```

### Penyimpanan Persisten (Storage)

Disimpan per project + per plugin (OPFS).

```javascript
await api.saveBlob('cache.bin', uint8Array);
const data  = await api.loadBlob('cache.bin');   // Blob | null
await api.deleteBlob('cache.bin');
const keys  = await api.listBlobs();             // ['cache.bin', ...]
const has   = await api.blobExists('cache.bin'); // boolean
```

Alias `Data` (nama lama, masih didukung): `saveData`, `loadData`, `deleteData`, `listData`, `dataExists`.

> ℹ️ `key` harus nama berkas polos — maks 255 karakter, tanpa `/`, `\`, karakter kontrol,
> dan bukan `.` atau `..`.

### Jaringan — `api.fetch(url, options)` (butuh izin `net`)

Permintaan jaringan **diproxikan oleh host** dengan batasan keamanan:

- Hanya protokol **http/https**. Target ke localhost / IP privat / loopback **diblokir** (anti-SSRF), termasuk pada URL hasil redirect.
- Hanya method `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `HEAD`, `OPTIONS`.
- `credentials: 'omit'`, `redirect: 'follow'`, `cache: 'no-store'`, `referrerPolicy: 'no-referrer'`.
- `options.timeoutMs` / `options.timeout` — 1000–120000 ms, default **30000**.
- `options.body` berupa object otomatis di-JSON-kan.
- **`options.asBytes: true`** (alias `options.binary: true`) → `body` dikembalikan sebagai `Uint8Array` alih-alih string.
- **Return**: `{ ok, status, statusText, url, headers, body, buffer }` — `buffer` selalu `ArrayBuffer` mentah.

```javascript
const res = await api.fetch('https://example.com/api', {
  method: 'POST',
  body: { q: 'halo' },
  timeoutMs: 10000
});
if (res.ok) console.log(res.body);

// Unduh biner
const bin = await api.fetch('https://example.com/font.dat', { asBytes: true });
await api.saveBlob('font.dat', bin.body);
```

> ⚠️ **Tidak ada rate limit** yang ditegakkan saat ini (`_rateOk()` selalu mengembalikan `true`).
> Tetap batasi permintaan di sisi plugin — jangan membanjiri server pihak ketiga.

### Dialog File & Unduhan

```javascript
const file = await api.pickFile('.dat,.bin');   // { name, buffer: ArrayBuffer } | null
api.download(bytesOrStringOrBlob, 'script_translated.dat');
```

### WebAssembly

```javascript
// Sekali jalan: compile + instantiate, kembalikan keduanya
const { module, instance } = await api.wasm(wasmBytes, imports);
const out = instance.exports.myFunc(42);

// Alternatif: jalankan export tertentu di worker terpisah (dengan timeout + cache modul)
const result = await api.runWasm('assets/lib.wasm', 'process', [inputPtr, len], { timeoutMs: 5000 });
```

> ℹ️ `api.runWasm(wasmPathOrBytes, fnName, args, opts)` menerima **path aset di dalam zip**
> atau byte WASM langsung. Modul wajib mengekspor `memory` beserta `alloc`/`malloc`.
> Timeout 1000–60000 ms, default 10000.

### JSZip & GPU

```javascript
const zip = new api.JSZip();
const gpu = api.gpu;   // navigator.gpu, atau undefined bila tak tersedia
```

### UI: Menu, Toolbar, Modal, Kartu Dashboard

```javascript
const menuBtn = api.addMenuItem('import', 'Impor dari XYZ', () => { /* ... */ });
api.removeMenuItem(menuBtn);

const tbBtn = api.addToolbarButton('Cek XYZ', () => { /* ... */ }, { title: 'Cek XYZ', className: 'btn-ghost btn-sm' });
api.removeToolbarButton(tbBtn);

const modal = api.createModal('Panel XYZ', '<p>Isi</p>', {
  wide: true,                       // pakai .modal-wide
  confirmLabel: 'Simpan',
  cancelLabel: 'Batal',
  actions: '',                      // HTML tombol kustom (menggantikan baris aksi default)
  onConfirm: (overlay) => { /* ... */ }
});
api.closeModal(modal);

const card = api.addDashboardCard(cardElement);   // HTMLElement
api.removeDashboardCard(card);

const section = api.addSettingsSection('plugins', 'Pengaturan XYZ', (bodyEl) => {
  bodyEl.innerHTML = '<p>Konten</p>';
});
api.removeSettingsSection(section);
```

`addMenuItem` menerima nama menu (`'import'`, `'export'`, atau id elemen). `addSettingsSection` menerima target `'settings'`/`'plugins'`/`'glossary'`/`'summary'` atau selector CSS.

### UI: Akses Region

```javascript
const panel = api.ui('panel');         // elemen panel plugin sendiri
const body  = api.ui('body');          // document.body (alias: 'app')
const el    = api.ui('toolbarActions'); // region bernama, atau selector CSS / id
```

Region bernama yang tersedia:

`importMenu`, `exportMenu`, `settingsModal`, `glossaryModal`, `summaryModal`, `toolsPanel`,
`textPanel`, `previewContainer`, `toolbar`, `toolbarActions`, `pluginPanels`, `dashboard`,
`dashboardContent`, `lineEditorModal`, `lineEditorBody`, `proofreadModal`, `pasteArea`,
`progressOverlay`, `progressText`

### Tema & Gaya

```javascript
api.setTheme({ '--primary': '#0284c7', '--accent': '#38bdf8' });  // set variabel CSS di :root
const styleEl = api.injectStyle('/* css */', 'my-plugin-style');
api.removeStyle('my-plugin-style');
```

### Sistem Hook & Event

```javascript
// Hook bernama — lihat §8 untuk daftar nama yang benar-benar dipanggil host
const token = api.hook('lineOpen', (num, line) => { /* ... */ });
api.unhook(token);

// Event
const off = api.on('projectOpen', (payload) => { /* ... */ });
off();                    // berhenti berlangganan
api.off('projectOpen');   // hapus semua listener event itu
api.emit('myEvent', { a: 1 });   // kirim event kustom ke plugin lain
```

### Registrasi Importer / Exporter / Shortcut

```javascript
api.registerImporter('xyz', (input) => { /* ... */ });
api.unregisterImporter('xyz');

api.registerExporter('xyz', (input) => { /* ... */ });
api.unregisterExporter('xyz');

api.registerShortcut('xyz-check', 'Cek XYZ', 'Alt+X', () => { /* ... */ }, { scope: 'workspace' });
api.unregisterShortcut('xyz-check');
```

### Lain-lain

```javascript
api.abort();               // batalkan semua fetch/operasi plugin yang sedang berjalan
await api.getStorage();    // FileSystemDirectoryHandle root OPFS (async)
```

---

## 6. Siklus Hidup & Penulisan `plugin.js`

> ⚠️ **Aturan Kritis Penulisan Kode**:
> - Gunakan **CommonJS (`module.exports`)**. Jangan gunakan `export default` / `import`.
> - Jalankan operasi asinkron dengan `async/await`.
> - Gunakan API resmi untuk DOM, jangan manipulasi global langsung (lihat §1).

### Nama method yang dikenali host

| Method | Dipanggil saat | Signature |
|---|---|---|
| `init` | Plugin dimuat pertama kali | `init(api)` |
| `activate` | Tepat setelah `init` selesai | `activate(api)` |
| `extract` | Impor file dengan ekstensi/magic yang cocok | `extract({ fileName, buffer, settings, globalSettings, sharedSettings, api })` |
| `pack` | Ekspor / build patch | `pack({ fileName, origBuffer, buffer, lines, sourceMap, projectName, settings, globalSettings, sharedSettings, api })` |
| `panel` **atau** `mount` | Panel plugin dipasang di workspace | `panel(parentEl, api)` |
| `unmount` | Panel plugin dilepas | `unmount()` |
| `onSettings` | Setelan berubah / project berganti | `onSettings({ settings, globalSettings, sharedSettings })` |
| `onCopy` | Teks akan dicopy untuk AI | `onCopy({ text, ctx, api })` → string |
| `onApply` | Terjemahan akan diterapkan | `onApply({ text, ctx, api })` → string |
| `onEvent` | Setiap event host dipancarkan | `onEvent(event, payload, api)` |
| `commands` | Daftar perintah shortcut | Array atau objek — lihat di bawah |

> ⚠️ **`onMount` dan `onUnmount` TIDAK dikenali.** Nama yang benar adalah **`panel`**
> (atau `mount`) dan **`unmount`**. Kalau kamu memakai nama lama, panelmu tidak akan
> pernah dipasang — tanpa pesan error apa pun.

### Bentuk `commands`

Host menerima **dua** bentuk. Keduanya memakai nama fungsi sebagai kunci:

```javascript
// Bentuk 1 — objek. Paling jelas, direkomendasikan.
module.exports = {
  commands: {
    formatTags(api) { api.toast('Tag diformat.'); },
    cekKosong(api) { /* ... */ }
  }
};
```

```javascript
// Bentuk 2 — array. WAJIB menyertakan fungsi top-level dengan nama = `key`.
module.exports = {
  commands: [
    { key: 'formatTags', label: 'Format Tag Karakter' },
    { key: 'cekKosong',  label: 'Cek Baris Kosong' }
  ],
  formatTags(api) { api.toast('Tag diformat.'); },   // dicocokkan lewat `key`
  cekKosong(api) { /* ... */ }
};
```

> ❌ **Jangan pakai `{ id, label, run }`.** Host hanya membaca `key` dan `label`.
> Field `id` dan `run` diabaikan sepenuhnya — perintahnya akan muncul di daftar shortcut
> tapi tidak melakukan apa pun saat dijalankan.

### Contoh lengkap

```javascript
module.exports = {
  // 1. Inisialisasi
  async init(api) {
    console.log('[Plugin]', api.pluginId, 'v' + api.getPluginMeta().version, 'siap.');
  },

  // 2. Impor / Ekstraksi File
  async extract({ fileName, buffer, settings, globalSettings, api }) {
    const lines = [];
    const text = api.decode(buffer, [settings.defaultEncoding || globalSettings.defaultEncoding || 'shift_jis']);
    let num = 1;

    for (const raw of text.split(/\r?\n/)) {
      const match = raw.match(/^([A-Za-z0-9_]+)\s*:\s*(.+)$/);
      if (match) {
        lines.push({
          file: fileName,
          name: match[1],
          message: match[2],   // ← field kanonik
          raw: raw,
          index: num++
        });
      } else if (raw.trim()) {
        lines.push({
          file: fileName,
          name: null,
          message: raw,
          raw: raw,
          index: num++
        });
      }
    }

    return {
      lines,
      sourceMap: { totalRawLines: num } // metadata opsional untuk tahap pack
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
  async onCopy({ text, ctx, api }) {
    return text;
  },

  // 5. Hook Post-apply Translation
  async onApply({ text, ctx, api }) {
    return text.replace(/""/g, '"');
  },

  // 6. Panel Antarmuka Kustom di Workspace
  async panel(rootElement, api) {
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

  // 7. Pembersihan saat panel ditutup
  async unmount() {
    // Hapus listener / style / interval yang kamu buat
  },

  // 8. Perintah Shortcut Keyboard Kustom
  commands: {
    formatTags(api) {
      api.toast('Format tag berhasil dieksekusi.');
    }
  }
};
```

---

## 7. Format Data: Baris Naskah & Tipe Return

Ada **tiga bentuk objek baris yang berbeda** — perhatikan masing-masing dipakai di mana:

### A. Baris yang di-RETURN dari `extract()` (plugin → host)

| Properti | Tipe | Keterangan |
|---|---|---|
| `file` | `string` | Nama file sumber. Bila kosong, diisi `fileName` otomatis. |
| `name` | `string \| null` | Nama karakter / pembicara asli. Alias: `character_name`. |
| `message` | `string` | **Wajib — inilah teks dialognya.** Alias: `original`, `original_text`, `text`. |
| `raw` | `string \| null` | Potongan baris asli utuh — anchor saat patch ekspor. |
| `index` | `number \| null` | Offset byte / indeks unik entri biner. Alias: `number`. |

> ⚠️ Baris dengan `message` kosong **dibuang** oleh host. Pastikan hanya baris dialog
> yang dimasukkan. `message` juga dinormalisasi: baris baru di dalamnya diubah jadi `\n` literal.

### B. Baris di `ctx.lines` pada `pack()` (host → plugin)

Berisi field internal **plus** alias praktis:

| Properti | Keterangan |
|---|---|
| `line_num`, `file` | Nomor baris (1-based) dan nama file sumber. |
| `name`, `message` | Nama & teks asli. |
| `trans_name`, `trans_message`, `is_translated` | Hasil terjemahan. |
| `original`, `translation` | Alias dari `message` / `trans_message`. `translation` bernilai `undefined` bila baris belum diterjemahkan. |
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

### Tipe return pada `pack()`

Semua bentuk berikut diterima:

| Return | Perlakuan host |
|---|---|
| `Uint8Array` / `ArrayBuffer` | Dibungkus jadi blob biner. |
| `string` | Dibungkus jadi blob teks UTF-8. |
| `{ content: string }` | Sama seperti di atas. |
| `Blob` | Dipakai langsung. |
| `{ blob: Blob }` | Dipakai langsung. |
| `{ buffer: Uint8Array \| ArrayBuffer }` | Dibungkus jadi blob biner. |
| `{ files: [...] }` | **Multi-file** — lihat di bawah. |

Bentuk lain → host melempar `tidak mengembalikan output pack yang valid`.

**Multi-file** — bila `files` berisi entri valid, ia **diprioritaskan** di atas `buffer`:

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
  satu arsip ZIP (kompresi DEFLATE) untuk diunduh pengguna.

> ℹ️ **Penamaan file keluaran** (ditentukan host, bukan plugin):
> - Output tunggal → **nama file yang diimpor** (mis. impor `script01.dat` → hasil `script01.dat`).
> - Output multi-file (arsip) → **nama proyek** + `.zip`.
> - `fileName`/`filename` dari plugin hanya dipakai sebagai fallback bila keduanya tidak tersedia.

---

## 8. Hook & Event

### Hook lifecycle (method di `module.exports`)

Hanya **dua** yang dipanggil host:

| Hook | Kapan | Signature | Return |
|---|---|---|---|
| `onCopy` | Sebelum teks dikopy untuk AI | `onCopy({ text, ctx, api })` | `string` — teks hasil modifikasi |
| `onApply` | Sebelum terjemahan diterapkan | `onApply({ text, ctx, api })` | `string` — teks hasil modifikasi |

`ctx` berisi `{ projectName, lineCount, selectedLines }`. Bila hook melempar error, host mencatatnya ke console dan **melanjutkan dengan teks asli**.

### Hook bernama (via `api.hook(name, fn)`)

| Nama | Kapan | Signature |
|---|---|---|
| `lineOpen` | Editor baris dibuka | `(lineNum, line) => void` |
| `lineSave` | Baris disimpan dari editor | `(lineNum, line, before) => void` — `before` = `{ trans_message, trans_name, is_translated }` sebelum perubahan |

Keduanya sinkron (`runHooksSync`). `api.hook()` menerima nama apa pun, tapi hanya dua di atas yang benar-benar dipanggil host — nama lain terdaftar tanpa pernah terpicu.

### Event

| Event | Payload | Dipicu saat |
|---|---|---|
| `projectOpen` | `{ name, type, lineCount, translatedCount }` atau `null` | Pengguna membuka proyek |
| `projectClose` | `null` | Pengguna kembali ke dashboard |

`api.on(ev, fn)` mengembalikan fungsi unsubscribe. Hook `onEvent` menerima SEMUA event.
`api.emit(event, payload)` mengirim event kustom ke plugin lain (tidak ada event bawaan lain yang dipancarkan host).

---

## 9. Panduan Tema Visual (`theme.css`)

Plugin tema visual mengontrol palet warna CSTL dan dapat menyertakan background art. Tema default CSTL adalah **gelap** — timpa variabel yang perlu saja.

### Variabel inti

| Variabel | Default (tema gelap) | Kegunaan |
|---|---|---|
| `--bg` | `#0f0e0d` | Latar utama |
| `--surface` | `#1d1b19` | Permukaan panel/kartu |
| `--surface-2` | `#26231f` | Permukaan lebih terang |
| `--surface-3` | `#332f2b` | Permukaan paling terang |
| `--hairline` | `#332f2b` | Garis pemisah halus |
| `--hairline-2` | `#43403c` | Garis pemisah lebih tegas |
| `--ink` | `#f0ece4` | Teks utama |
| `--ink-dim` | `#a8a29c` | Teks sekunder |
| `--ink-muted` | `#7e7974` | Teks tersier |
| `--primary` | `#c84e18` | Warna aksi utama |
| `--primary-hover` | `#a93f12` | Aksi utama saat hover |
| `--primary-soft` | `rgba(200,78,24,0.14)` | Latar aksen lembut |
| `--accent` | `#b9975b` | Aksen sekunder |
| `--success` | `#2d7d5f` | Status berhasil |
| `--danger` | `#c82a3a` | Status bahaya |
| `--warning` | `#c98a12` | Status peringatan |

**Alias kompatibilitas** (nama lama, masih dipetakan): `--bg-2`, `--bg-elev`, `--panel`, `--panel-2`, `--line`, `--line-2`, `--text`, `--muted`, `--muted-2`, `--bg-card`, `--border`, `--text-base`.

### Contoh tema terang

```css
:root {
  --bg: #f3f8fd;
  --surface: #ffffff;
  --surface-2: #f0f7fe;
  --surface-3: #e5f0fa;
  --hairline: #d1e4f5;
  --hairline-2: #b9d7f0;
  --ink: #0f172a;
  --ink-dim: #475569;
  --ink-muted: #64748b;
  --primary: #0284c7;
  --primary-hover: #0369a1;
  --primary-soft: rgba(2, 132, 199, 0.12);
  --accent: #38bdf8;
}
```

### Background artwork

```css
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

Tema diterapkan otomatis saat proyek dibuka/ditutup, dan hanya bila `theme.css` ada **dan** izin `theme` dideklarasikan.

> ⚠️ **`theme.css` disanitasi sebelum diterapkan.** Yang diblokir:
> - **`@import`** — dihapus seluruhnya.
> - **`url()` ke sumber eksternal** — hanya `data:` URI dan fragmen `#` yang diizinkan.
>   Jadi background art **wajib** memakai base64 (`url("data:image/jpeg;base64,...")`) atau SVG inline;
>   `url("https://...")` akan dibuang.
>
> Ini mencegah plugin tema memuat konten jaringan tanpa sepengetahuan pengguna.

---

## 10. Integrasi Pintasan Keyboard (Shortcuts)

Perintah yang didaftarkan di `commands` pada `plugin.js` akan otomatis muncul di **Shortcut Keyboard Manager** (grup **Plugin**). ID internalnya berbentuk `plugin.<id-plugin>.<key>`.

Selain itu, plugin dapat mendaftarkan shortcut sendiri kapan saja lewat `api.registerShortcut(id, label, combo, handler, opts)`.

### Pintasan Bawaan CSTL

| Scope | Aksi | Shortcut Default |
|---|---|---|
| **Dashboard** | Buat Project Baru | *(kosong)* |
| | Pulihkan Project | *(kosong)* |
| | Buka Default Pengaturan | *(kosong)* |
| | Fokus Cari Project | `/` |
| **Workspace (Impor/Ekspor/Umum)** | Impor File | *(kosong)* |
| | Impor Folder | *(kosong)* |
| | Impor ZIP | *(kosong)* |
| | Ekspor Terjemahan | `Alt + E` |
| | Buka Cari & Ganti | `Alt + R` |
| | Buka Tab Glossary | `Alt + G` |
| | Buka Tab AI Check | `Alt + K` |
| | Buka Plugin & Parser Manager | `Alt + P` |
| | Buka Pengaturan Project | `Alt + S` |
| | Kembali ke Dashboard | `Alt + B` |
| | Buka Daftar Bookmark | `Alt + M` |
| | Jalankan Auto Translate | `Alt + T` |
| | Buka Mode Immersif | `Alt + I` |
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

Aksi ber-scope `dashboard` hanya aktif di dashboard, `workspace` hanya di dalam proyek. Aksi dengan `inInputs: true` (Fokus Paste AI, Terapkan Terjemahan) tetap berjalan walau kursor sedang di dalam kolom input.

---

## 11. Checklist Pemecahan Masalah (Troubleshooting)

- ❌ **`manifest_version` wajib diisi (gunakan 1)**
  &rarr; Tambahkan `"manifest_version": 1`. `manifestVersion` (camelCase) masih diterima sebagai alias, tapi pakai snake_case.
- ❌ **`"id" wajib: huruf kecil/angka/garisbawah/tanda hubung…`**
  &rarr; `id` harus **huruf kecil semua**. `"MyPlugin"` ditolak; pakai `"my-plugin"`.
- ❌ **`Izin tidak dikenal: "…"`**
  &rarr; Cek daftar 11 izin di §3. Typo sekecil apa pun membuat manifest ditolak.
- ❌ **`Ekstensi .copas adalah format bawaan CSTL dan tidak boleh diklaim plugin`**
  &rarr; Hapus `.copas` / `.cstl` dari `extensions`.
- ❌ **`Unexpected token 'export'`**
  &rarr; Sandbox memakai CommonJS. Gunakan `module.exports = { ... }`, bukan `export default` / `import`.
- ❌ **`Plugin "…" tidak mengekspor objek (module.exports)`**
  &rarr; `module.exports` harus objek. Kalau kamu menulis `module.exports = function`, host menolaknya.
- ❌ **Panel plugin tidak muncul, tapi tidak ada error**
  &rarr; Kemungkinan besar kamu memakai `onMount`. Nama yang benar adalah **`panel`** (atau `mount`). Untuk pembersihan gunakan **`unmount`**, bukan `onUnmount`.
- ❌ **Perintah muncul di daftar shortcut tapi tidak melakukan apa pun**
  &rarr; Kamu memakai `{ id, label, run }`. Host hanya membaca `{ key, label }` dan mencari fungsi dengan nama `key` tersebut. Pakai bentuk objek `commands: { namaku(api) {…} }` agar tidak salah.
- ❌ **`Plugin "…" tidak mengembalikan array baris teks`**
  &rarr; `extract()` harus mengembalikan `{ lines: [...] }` (atau array langsung). Pastikan setiap baris punya `message` **tidak kosong** — baris kosong dibuang.
- ❌ **`Plugin "…" tidak mengembalikan output pack yang valid`**
  &rarr; Kembalikan salah satu bentuk di §7: `Uint8Array`, `string`, `Blob`, `{ buffer }`, atau `{ files }`.
- ❌ **`Karakter tidak tersedia di Shift_JIS/CP932: "…"`**
  &rarr; `api.encode` sengaja melempar error, bukan diam-diam beralih ke UTF-8. Buang karakter yang tak ada di tabel (emoji, simbol eksotis) atau ubah ke UTF-8.
- ❌ **Warna tema tidak berubah saat dipasang**
  &rarr; Pastikan manifest menyertakan `"permissions": ["theme"]` dan ada file `theme.css` di root zip.
- ❌ **`Host lokal/private tidak diperbolehkan`**
  &rarr; `api.fetch` memblokir localhost dan IP privat (anti-SSRF). Gunakan host publik.
- ❌ **File biner menghasilkan teks acak/karakter aneh**
  &rarr; Gunakan `api.decode(buffer, ['shift_jis', 'cp932'])` untuk game bahasa Jepang jadul.
- ❌ **`ui.height` ditolak**
  &rarr; Rentang valid **60–2000** px, bukan 120–600.

---

## 12. Catatan Versi

| Item | Nilai |
|---|---|
| Host API version (`api.version`, `api` di manifest) | `1` |
| Manifest version (`manifest_version`) | `1` |
| Index schema | `1` |
| Boot timeout | 8000 ms |
| Timeout pemanggilan default | 30000 ms |
| Timeout `extract` / `pack` | 120000 ms |
| Timeout WASM | 1000–60000 ms (default 10000) |
| Timeout jaringan | 1000–120000 ms (default 30000) |

Dokumen ini disinkronkan dengan kode pada **2 Oktober 2026**. Bila menemukan ketidaksesuaian antara panduan ini dan perilaku aplikasi, **kode di `src/plugins.ts` yang berlaku** — silakan buka issue agar panduan diperbarui.
