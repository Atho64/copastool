# CopasTool (Tauri Cross-Platform)

<div align="center">

  ![Version](https://img.shields.io/badge/Version-v0.1.7-purple?style=for-the-badge)
  ![Platform](https://img.shields.io/badge/Platform-Windows%20%7C%20Android-blue?style=for-the-badge)
  ![Engine](https://img.shields.io/badge/Engine-Tauri%20v2-orange?style=for-the-badge)

</div>

Tool bantu penerjemahan visual novel dan novel (EPUB) yang ditenagai oleh **Tauri v2** untuk platform **Windows (Desktop)** dan **Android (Mobile)**. Alur kerja utamanya berbasis **Copy-Paste cerdas** ke Web AI (Gemini, ChatGPT, Claude, DeepSeek, dll.) maupun terjemahan otomatis, dilengkapi injeksi glosarium karakter, story context chaining, jendela Web AI companion bawaan, hingga ekspor kembali naskah game dalam satu aplikasi native yang ringan dan cepat.

---

## Fitur

### Impor
- **File / Folder** — Impor file `.json` atau `.epub` satu-satu atau sekalian satu folder
- **ZIP** — Impor banyak file sekaligus dari arsip `.zip`
- **TXT LucaSystem** — Impor script dari game berbasis LucaSystem (format `.txt` khusus: Summer Pockets Steam, CLANNAD Switch, Tomoyo After Switch, CLANNAD Side Stories)
- **Impor File (Plugin/Parser)** — Impor format game lain yang didukung plugin terpasang (menu khusus + routing otomatis berdasarkan ekstensi/magic signature)
- **Sistem Plugin & Parser (.zip / JS / Python)** — Pasang plugin ekstensi untuk format game, tema kustom, atau utilitas khusus. Lihat panduan lengkap di [PLUGIN_GUIDE.md](./PLUGIN_GUIDE.md).
- **File / Folder Terjemahan** — Merge hasil terjemahan ke proyek yang sudah ada

### Plugin & Parser System
Format game tidak didukung bawaan? Kamu bisa memasang paket plugin (`.zip`) atau menulis parser custom sendiri lewat menu **Setting → Plugin & Parser Manager** (shortcut `Alt + P`).

Sistem plugin CSTL mencakup:
1. **Parser Format Game**: Ekstraksi (`extract`) dan pengemasan kembali (`pack`) naskah format biner/teks dengan round-trip export.
2. **Tema Visual & Watermark**: Personalisasi antarmuka dan palet warna via `theme.css`.
3. **Panel Kustom (UI Panel)**: Widget tambahan di workspace dengan antarmuka interaktif.
4. **Hook Clipboard & Terjemahan**: Pre-processing teks sebelum disalin ke AI dan post-processing sebelum terjemahan diterapkan.
5. **Perintah Kustom & Shortcut**: Perintah khusus yang terdaftar di Shortcut Keyboard Manager.
6. **Parser Legacy (JS / Python)**: Kompatibilitas penuh dengan parser skrip tunggal dan arsip `.zip` lama.

> 📖 **Panduan Pembuatan Plugin & Parser**:
> Untuk dokumentasi arsitektur, spesifikasi `manifest.json`, Host API, contoh kode lengkap, dan integrasi parser, silakan baca **[PLUGIN_GUIDE.md](./PLUGIN_GUIDE.md)**.

### Terjemahan AI
Alur kerjanya sederhana: pilih baris → copy → tempel ke AI → paste hasilnya → terapkan. CSTL yang urus parsing dan mapping ke baris yang benar.

- Copy teks yang dipilih ke format siap pakai untuk ChatGPT/Gemini/dll
- Paste hasil terjemahan dan terapkan otomatis
- **AI Check** — Copy terjemahan yang sudah ada ke AI untuk dicek ulang, lalu terapkan koreksinya
- Prompt terjemahan dan AI check bisa dikustomisasi sendiri
- Pilihan format output AI (numbered list, XML, dll.)

### API Global (AI)
Hubungkan aplikasi ke AI tanpa perlu copy-paste manual. Terjemahan, ekstrak glosarium, AI check, dan AI Agent berjalan otomatis dari dalam aplikasi.

- Dukung **OpenAI Compatible** (GPT, Claude via OpenRouter, DeepSeek, Local LLM) dan **Gemini API** (Google AI Studio)
- Ambil daftar model langsung dari API dengan tombol fetch
- **Thinking / Reasoning Mode** — Kontrol mode berpikir model untuk menghemat token atau meningkatkan akurasi:
  - *Matikan* — menonaktifkan reasoning bila provider yang dipilih mendukungnya
  - *Nyalakan* — kebalikannya, masing-masing provider pakai parameternya sendiri
- **Filter thinking output** — Blok `<think>...</think>` dari model seperti Gemma 4 atau QwQ dihapus otomatis sebelum terjemahan diterapkan, termasuk bagian `thought: true` dari respons Gemini API
- **Parameter generasi global** — Atur max output tokens, seed, frequency penalty, presence penalty, dan reasoning effort (minimal sampai extra-high) dari satu tempat. Konfigurasi ini dipakai konsisten oleh Auto Translate dan AI Agent untuk OpenAI-compatible, Anthropic, serta Gemini.
- **Gemma 4 via Gemini API** — Model `gemma-4-31b-it` dan `gemma-4-26b-a4b-it` dikenali otomatis; mode thinking off dikirim sebagai `thinkingLevel: "minimal"` sesuai API Gemma 4.
- Limit RPM dengan delay otomatis antar request

### AI Agent
Chat langsung dengan AI yang punya akses ke data proyek. Bisa tanya, analisis, dan modifikasi terjemahan lewat percakapan.

**Tool yang tersedia:**

| Tool | Fungsi |
|------|--------|
| `getProjectStats()` | Ringkasan progress, jumlah baris, daftar file |
| `getLines(start, end)` | Ambil teks asli + terjemahan untuk rentang baris tertentu |
| `getContext(line_num, radius)` | Lihat baris sekitar sebuah baris target (konteks atas-bawah) |
| `searchLines(query)` | Cari kata kunci di teks asli, terjemahan, atau nama karakter |
| `getCharacterNames()` | Daftar semua nama karakter + deteksi inkonsistensi otomatis |
| `analyzeQuality(limit)` | Cek baris belum diterjemahkan, terjemahan terlalu pendek, nama tidak konsisten |
| `getProgressReport()` | Laporan progress terjemahan per file dengan progress bar |
| `applyTranslations(updates)` | Terapkan terjemahan langsung ke proyek |
| `editLine(line_num, fields)` | Edit satu baris (semua field: message, name, trans_message, dll) |
| `editLines(updates)` | Edit beberapa baris sekaligus |
| `clearTranslations(line_nums)` | Hapus terjemahan untuk baris tertentu |
| `undoLastAction()` | Batalkan aksi terakhir |
| `redoLastAction()` | Kembalikan aksi yang dibatalkan |
| `getGlossary()` | Ambil daftar glosarium yang didefinisikan pengguna |
| `editPrompt(prompt_type, new_prompt)` | Edit prompt terjemahan/glosarium/AI check/agent |
| `editGlossary(new_glossary)` | Edit teks glosarium |
| `listSettings()` | Tampilkan daftar semua setting yang bisa diubah |
| `toggleSetting(setting_name, value)` | Ubah/toggle setting aplikasi |
| `getMemory(category?)` | Ambil memori agent (optional filter category) |
| `listMemory()` | Tampilkan semua memori agent |
| `saveMemory(key, value, category, scope?)` | Simpan/update memori (global/project) |
| `deleteMemory(key)` | Hapus memori by key |

### Glosarium
Kelola nama karakter, tempat, dan istilah khusus supaya terjemahan konsisten.

- Editor glosarium built-in
- Copy seleksi teks ke AI untuk ekstrak terminologi otomatis
- Import nama dari **VNDB** (pakai ID VN) atau **AniList** (pakai ID media)
- Ekstrak nama dari anotasi ruby di file EPUB
- Import/export glosarium ke file teks
- Preview glosarium aktif langsung di workspace

### Proofread & Pencarian
- Cari teks di semua baris — teks asli maupun terjemahan
- Support regex, case-sensitive, exact match
- Filter scope pencarian (semua baris, hanya yang dipilih, dll.)
- Replace All

### Editor Baris
Klik baris manapun untuk buka editor individual. Di sini bisa edit nama karakter, teks asli, terjemahan, dan tandai status terjemahan. Untuk proyek LucaSystem, referensi teks EN/ZH ditampilkan berdampingan.

### Seleksi & Auto-Increment
- Pilih semua, pilih range (baris X–Y), atau klik manual
- **Auto-Increment Baris** — Setelah terjemahan berhasil diterapkan, rentang baris "Dari - Sampai" otomatis maju dan rentang berikutnya langsung dipilih mengikuti ukuran **Batch Translate**. Mempercepat alur kerja terjemahan bertahap tanpa perlu memilih baris baru secara manual.
- **Shortcut Keyboard Manager** — Navigasi cepat dan pemicu aksi instan (buat proyek, navigasi batch, copy AI, terapkan terjemahan `Ctrl+Enter`, undo/redo) yang dapat dikustomisasi dan direkam langsung melalui menu **Shortcut Keyboard**.
- Undo untuk batalkan penerapan terjemahan terakhir
- Progress bar real-time

### Pengaturan
- Bahasa sumber & target
- Jumlah baris per batch (terjemahan, glosarium, AI check)
- Jumlah baris konteks yang ikut di-copy ke AI
- Regex filter kustom
- Konfigurasi LucaSystem: profil game, nama MC, bahasa ekspor
- Tag HTML untuk parsing EPUB

### Penyimpanan
Semua proyek disimpan langsung di penyimpanan native OS (bebas batas kuota browser) atau browser **OPFS**. Proyek bisa di-backup dan dipulihkan lewat file `.copas` (format `.cstl` tetap didukung penuh). Di desktop ada juga **Backup ke Folder** yang menulis backup langsung ke folder lokal pilihan (bisa disinkronkan ke cloud — lihat [di bawah](#backup-ke-folder-desktop)).

Data biner besar (file mentah LucaSystem) disimpan di file penyimpanan terpisah supaya auto-save tetap ringan. Dashboard hanya memuat metadata proyek, bukan seluruh isi data — jadi tetap cepat meski proyek sudah banyak.

#### Backup ke Folder (Desktop)

> Hanya tersedia di **Chrome / Edge / Brave / Opera desktop**. Di HP atau Firefox/Safari tombolnya otomatis disembunyikan — pakai **Backup Semua ZIP** sebagai gantinya.

CSTL bisa menulis file backup **langsung ke satu folder di komputer kamu** yang kamu pilih sendiri — tanpa download, tanpa upload, tanpa login akun apa pun. Ini pakai izin bawaan browser (*File System Access API*): kamu memberi CSTL akses ke **satu folder itu saja**, bukan seluruh komputer, dan CSTL tidak pernah tahu apa yang terjadi pada folder itu selanjutnya.

**Cara pakai:**

1. Klik **Backup ke Folder** di dashboard → muncul dialog pemilih folder bawaan Windows → pilih foldernya (misal `D:\CopasTool Backups`).
2. Semua proyek ditulis ke folder itu sebagai file `nama_proyek_backup.copas` — isinya sama persis dengan backup download (termasuk data mentah Luca dan file EPUB asli). Klik tombol yang sama lain kali untuk menimpa dengan versi terbaru.
3. Klik **Pulihkan dari Folder** untuk melihat daftar file backup (`.copas` dan `.cstl`) di folder itu beserta ukuran dan tanggalnya, lalu pulihkan yang kamu mau. Hasil pemulihan selalu jadi proyek baru — proyek yang sekarang tidak tertimpa.

**Soal izin "Allow":** selama browser masih jalan, izin diingat dan backup berjalan tanpa popup. Setelah browser ditutup dan dibuka lagi, klik backup pertama memunculkan satu popup kecil konfirmasi — pilih **Allow on every visit** supaya tidak ditanya lagi selamanya.

**Sinkron ke cloud (opsional):** folder itu folder biasa, jadi bisa diarahkan ke folder milik aplikasi sinkron supaya backup naik ke cloud otomatis:

- **Google Drive for Desktop** → saat memilih folder, arahkan ke folder di dalam `Drive saya`. File yang ditulis CSTL otomatis ikut naik ke Google Drive (dan bisa diakses dari HP).
- **rclone** (power user) → `rclone sync D:\CSTLBackups drive:CSTL` dijadwalkan lewat Task Scheduler. Bekerja juga untuk Dropbox, OneDrive, S3, dll.
- Dropbox / OneDrive / Syncthing juga sama saja — semua yang masuk ke folder itu ikut tersinkron.

### Shortcut Keyboard (Pintasan Keyboard)
CSTL dilengkapi sistem pintasan keyboard bawaan yang dapat dikustomisasi dan direkam secara interaktif melalui menu **Shortcut Keyboard**:

| Kategori | Aksi | Shortcut Bawaan |
|---|---|---|
| **Dashboard** | Fokus Kolom Cari Project | `/` |
| **Workspace (Umum)** | Ekspor Terjemahan | `Alt + E` |
| | Buka Cari & Ganti (Proofread) | `Alt + R` |
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
| **Plugin Commands** | Perintah Kustom Plugin | *Dikonfigurasi per perintah di menu Shortcut* |

> 💡 **Kustomisasi Shortcut**: Buka menu **Shortcut Keyboard** dari header atau dropdown settings &rarr; klik tombol kombinasi pada aksi yang diinginkan &rarr; tekan kombinasi tombol baru di keyboard. Tekan `Backspace` untuk menghapus shortcut atau tombol `Reset` untuk mengembalikan ke setelan default.

---

## Tutorial

### 1. Mulai Proyek Baru

Buka [atho64.github.io/cstl](https://atho64.github.io/cstl/), klik **Buat Proyek Baru**, isi nama proyek dan pilih tipe file yang akan diimpor (JSON, EPUB, atau LucaSystem). Setelah proyek dibuat, klik **Buka** untuk masuk ke workspace.

### 2. Impor Script

Di dalam workspace, klik tombol **Impor** di toolbar atas. Pilih file atau folder yang ingin diimpor. Semua baris akan langsung muncul di tabel. Kalau file sudah pernah diimpor sebelumnya, duplikat akan diabaikan otomatis.

### 3. Terjemahan Manual (Copy-Paste)

Ini alur dasar tanpa API:

1. **Pilih baris** — klik baris satu-satu, atau pakai "Pilih Range" untuk pilih banyak sekaligus
2. **Copy ke AI** — klik tombol **Copy Terjemahan**, lalu paste ke ChatGPT / Gemini / AI apapun
3. **Paste hasil** — setelah AI selesai, copy seluruh responnya, paste ke kotak **Paste Hasil AI** di CSTL
4. **Terapkan** — klik **Terapkan**, CSTL parsing otomatis dan isi terjemahan ke baris yang sesuai

Kalau hasilnya tidak sesuai, klik **Undo** untuk batalkan.

### 4. Auto Translate (Langsung via API)

Kalau tidak mau copy-paste manual, hubungkan ke API:

1. Klik ikon 🤖 di pojok kanan bawah
2. Pilih **Tipe API** (OpenAI Compatible atau Gemini)
3. Isi **API Key** dan **Model** (bisa klik tombol ↻ untuk fetch daftar model otomatis)
4. Atur **RPM** sesuai limit akun, lalu klik **Simpan API**
5. Pilih baris yang ingin diterjemahkan, klik **Jalankan Auto Translate**

Untuk model thinking yang mengeluarkan blok `<think>...</think>`, aktifkan **Filter `<think>...</think>`** di pengaturan API supaya output terjemahan bersih dari teks reasoning.

### 5. Glosarium

Sebelum mulai terjemahan besar, disarankan isi glosarium dulu:

1. Buka tab **Glosarium** di workspace
2. Ketik nama karakter, tempat, atau istilah khusus di editor
3. Atau klik **Import VNDB/AniList** — masukkan ID VN/media, nama karakter otomatis terisi
4. Glosarium aktif akan otomatis ikut di-copy saat kamu copy teks ke AI

### 6. AI Agent

AI Agent bisa bantu langsung tanpa perlu manual:

1. Klik ikon 💬 di pojok kanan bawah untuk buka panel chat
2. Contoh yang bisa diminta:
   - *"Terjemahkan baris 1 sampai 10"* — agent ambil teksnya, terjemahkan, dan terapkan sendiri
   - *"Cek konsistensi nama karakter"* — agent analisis dan laporkan inkonsistensi
   - *"Baris mana yang belum diterjemahkan?"* — agent beri ringkasan progress
   - *"Cari baris yang ada kata 'sayonara'"* — agent search dan tampilkan hasilnya
3. Semua perubahan yang dilakukan agent bisa di-undo dengan berkata *"undo"* atau klik tombol Undo

### 7. AI Check

Setelah selesai menerjemahkan, bisa minta AI untuk cek ulang kualitasnya:

1. Pilih baris yang sudah diterjemahkan
2. Klik **Copy AI Check** — teks asli + terjemahan di-copy ke format khusus
3. Paste ke AI, minta koreksi
4. Copy hasilnya, paste ke kotak **Paste AI Check**, klik **Terapkan Koreksi**

### 8. Proofread & Replace

Gunakan tab **Proofread** untuk cari dan ganti teks secara massal:

- Aktifkan **Regex** kalau perlu pola matching yang lebih kompleks
- Centang **Case Sensitive** atau **Exact Match** sesuai kebutuhan
- Klik **Replace All** untuk ganti semua sekaligus

### 9. Ekspor

Kalau sudah selesai, klik **Ekspor** di toolbar. File hasil terjemahan akan didownload dalam format aslinya (`.json`, `.epub`, atau `.txt` LucaSystem). Untuk format game lain, ekspor round-trip dijalankan oleh plugin parser terpasang (`pack()`) — termasuk format biner dan multi-file arsip.

Untuk backup proyek beserta semua datanya, klik **Backup** di halaman dashboard — file `.copas` akan tersimpan dan bisa dipulihkan kapanpun lewat tombol **Pulihkan** (file format lama `.cstl` juga tetap didukung).


## Format yang Didukung

| Format | Impor | Ekspor | Catatan |
|--------|:-----:|:------:|---------|
| `.json` | ✅ | ✅ | |
| `.epub` | ✅ | ✅ | |
| `.zip` | ✅ | — | Berisi banyak file |
| `.copas` / `.cstl` | ✅ | ✅ | Backup proyek (format baru `.copas`, legacy `.cstl` tetap didukung) |
| LucaSystem `.txt` | ✅ | ✅ | Format script khusus LucaSystem |

---

## Keamanan (Security)

CopasTool adalah aplikasi native (Tauri v2) yang memuat halaman AI pihak ketiga di jendela terpisah. Batas kepercayaannya diatur eksplisit:

- **Hanya jendela utama yang punya akses IPC.** `src-tauri/capabilities/default.json` membatasi izin ke `"windows": ["main"]`. Jendela `ai-companion` yang memuat situs AI pihak ketiga sengaja tidak diberi capability sama sekali.
- **Setiap perintah native memverifikasi pemanggilnya.** Semua command di `src-tauri/src/lib.rs` menerima parameter `tauri::WebviewWindow` dan menolak panggilan dari jendela selain `main`, jadi halaman AI tidak bisa menyentuh filesystem walau konfigurasi capability diubah.
- **Allowlist host untuk jendela AI.** `open_ai_window` hanya menerima URL `https` ke host di `ALLOWED_AI_HOSTS` (gemini.google.com, chatgpt.com, chat.deepseek.com, meta.ai, claude.ai, chat.qwenlm.ai, lmarena.ai, freebuff.chat, …). Kalau kamu menambah target baru di `AI_TARGET_URLS` (`src/ai-webview-controller.ts`), tambahkan juga host-nya di `ALLOWED_AI_HOSTS`.
- **`eval_ai_script` hanya menyuntik ke host yang diizinkan.** Script automasi ditolak bila jendela AI ternyata sudah bernavigasi ke host lain. URL dipindahkan ke `window.location.href` lewat `serde_json`, jadi tidak bisa keluar dari string literal JS.
- **`withGlobalTauri: false`.** Objek `window.__TAURI__` tidak lagi disuntikkan ke setiap webview. Frontend memakai import `@tauri-apps/api` yang di-bundle, sedangkan deteksi runtime memakai `window.__TAURI_INTERNALS__`.
- **Path penyimpanan disanitasi.** `native_save_file` / `native_read_file` / `native_delete_file` / `native_list_files` menolak path absolut dan `..` (path traversal), lalu memastikan target tetap berada di dalam folder data aplikasi.
- **`csp: null` dipertahankan dengan sengaja.** CSP ketat di jendela utama juga akan membatasi jendela AI yang memuat konten pihak ketiga, sementara aplikasi butuh inline style/script, Web Worker, dan koneksi ke API AI pilihanmu. Batas keamanan yang sebenarnya ada pada capability + guard Rust di atas.

---

## Stack

**TypeScript** + **Vite** — dicompile ke vanilla JS, tidak ada runtime framework berat. Dependensi utama:
- **Tauri v2** — runtime desktop (Windows NSIS & MSI) dan mobile (Android APK)
- **@tauri-apps/plugin-notification** — notifikasi sistem native (Windows Action Center & status toast)
- **@tauri-apps/plugin-clipboard-manager** — sinkronisasi clipboard background untuk Auto Copas
- **Web Worker Storage** — isolasi parsing dan commit IndexedDB/OPFS di thread terpisah agar UI tetap responsif 60fps
- **Android Native Bridge** — in-app AI companion WebView overlay, background lifecycle keep-alive, dan penyimpanan file langsung ke folder `Download`
- **JSZip** — parsing file `.zip`
- **Kuroshiro + Kuromoji** — konversi furigana (hiragana/romaji) untuk teks Jepang
- **Pako** — kompresi/dekompresi data (dipakai untuk format LucaSystem)
- **OPFS API & IndexedDB** — penyimpanan lokal file & database proyek
- **vite-plugin-pwa** — PWA support (install ke homescreen, offline cache)

---

## Pengembangan & Build (Developer)

### Prasyarat

- **Node.js 20+** dan npm
- **Rust stable** + dependensi Tauri
- Untuk Android: **Android SDK + NDK 26.3.11579264** dan **JDK 17**
- Untuk Icon Asset: **Python 3** + `Pillow`

### Perintah

| Perintah | Fungsi |
|----------|--------|
| `npm run dev` | Jalankan versi web (Vite dev server, port 5173) |
| `npm run build` | Type-check (`tsc`) lalu build produksi ke `dist/` |
| `npm run typecheck` | Type-check saja, tanpa emit |
| `npm run version:check` | Pastikan semua penanda versi sama dengan `package.json` |
| `npm run tauri:dev` | Jalankan aplikasi desktop Tauri (mode dev) |
| `npm run tauri:build` | Build installer Windows (NSIS/MSI) |
| `npm run android:init` | Buat scaffold Android di `src-tauri/gen/` (sekali per clone) |
| `npm run android:build` | Build APK Android |
| `python scripts/generate-icons.py` | Generate icon karakter anime, varian tema SVG, dan multi-resolution ICO/PNG |
| `scripts\gen-android-keystore.ps1` | Generate keystore rilis Android + file kredensial lokal |
| `scripts\build-and-install-android.ps1` | Build, align, sign & install langsung ke HP Android via ADB |

> `src-tauri/gen/` masuk `.gitignore`, jadi **clone baru wajib menjalankan `npm run android:init`** sebelum build Android. Build desktop tidak butuh langkah ini.

### Versi aplikasi

`package.json → "version"` adalah satu-satunya sumber kebenaran. Saat build/dev, versi diinjeksi ke frontend sebagai `__APP_VERSION__` oleh `vite.config.ts` (badge dashboard + status bar). `npm run version:check` — juga jadi gate pertama di CI sebelum semua job build — memverifikasi `tauri.conf.json`, `Cargo.toml`, `Cargo.lock`, badge README, dan placeholder `index.html` sudah sinkron. Untuk menaikkan versi, ubah keempat tempat itu sekaligus lalu jalankan `npm run version:check`.

### CI (`.github/workflows/build-tauri.yml`)

- `version-check` — gate verifikasi versi + memastikan tag rilis cocok dengan `package.json`.
- `build-windows` — menghasilkan installer Windows:
  - `CopasTool_<version>_x64-setup.exe` (NSIS)
  - `CopasTool_<version>_x64_en-US.msi` (MSI)
- `build-android` — menghasilkan APK Android yang sudah di-align dan di-sign:
  - `CopasTool_universal.apk` (APK universal untuk semua arsitektur: arm64-v8a, armeabi-v7a, x86_64)
- `publish-release` — mengunggah installer `.exe`, `.msi`, dan `.apk` ke GitHub Release saat tag `v*` di-push.

Cache yang dipakai: `Swatinem/rust-cache` (Cargo registry + `src-tauri/target`) untuk job Windows dan Android, `actions/cache` untuk `~/.gradle`, serta cache npm bawaan `actions/setup-node`. NDK tidak di-cache karena runner GitHub sudah menyediakannya dan ukurannya terlalu besar untuk batas cache repo.

> **Catatan ukuran:** kamus Kuromoji di `public/dict/` berukuran ±**17 MB**. Item ini tetap dibundle ke APK (dibutuhkan furigana), tetapi **tidak lagi di-precache** oleh service worker — pembukaan pertama hanya mengunduh shell aplikasi (±1 MB) dan kamus masuk cache saat furigana dipakai pertama kali, setelah itu tetap tersedia offline.

---

## Platform & Kompatibilitas

CopasTool dapat dijalankan sebagai aplikasi native maupun aplikasi web (PWA):

- **Windows Desktop (Native):**
  - Mendukung Windows 10 dan Windows 11 (64-bit).
  - Tersedia pilihan installer NSIS (`.exe`) dan Windows Installer (`.msi`).
  - Menggunakan penyimpanan filesystem native (bebas kuota browser), Action Center notification, dan jendela pendamping AI terpisah.

- **Android (Native):**
  - Mendukung Android 8.0 (Oreo / API level 26) ke atas.
  - APK Universal (`CopasTool_universal.apk`) mendukung arsitektur `arm64-v8a`, `armeabi-v7a`, dan `x86_64`.
  - Dilengkapi in-app AI companion WebView overlay, background lifecycle keep-alive saat multitasking, dan penyimpanan langsung ke folder `Download`.

- **Web Browser & PWA:**
  - Dapat diinstall sebagai PWA ke homescreen/desktop dengan dukungan offline cache.
  - Penyimpanan menggunakan OPFS (`navigator.storage.getDirectory()`) dengan fallback otomatis ke IndexedDB:
    - **Chrome / Edge 102+** (Sangat disarankan)
    - **Firefox 111+**
    - **Safari 15.2+** (menggunakan IndexedDB fallback)

---

## Kredit

Original dibuat oleh [Atho64](https://github.com/atho64), di-fork oleh [LuKazuu](https://github.com/LuKazuu), lalu di-fork balik dan dikembangkan lagi oleh [Atho64](https://github.com/atho64).
