# CopasTool

<div align="center">

  ![Version](https://img.shields.io/badge/Version-v0.1.14--beta.2-purple?style=for-the-badge)
  ![Platform](https://img.shields.io/badge/Platform-Windows%20%7C%20Android-blue?style=for-the-badge)
  ![Engine](https://img.shields.io/badge/Engine-Tauri%20v2-orange?style=for-the-badge)

</div>

Alat bantu terjemahan untuk visual novel dan novel EPUB. Berjalan sebagai aplikasi native Tauri v2 di Windows dan Android, dan sebagai PWA di browser.

Alur utamanya ada dua: kirim teks terpilih ke Web AI lewat clipboard lalu tempel hasilnya kembali, atau biarkan aplikasi yang memanggil API AI secara langsung. Sekalian diurus juga glosarium karakter, konteks cerita antar batch, dan ekspor balik ke format file aslinya.

---

## Fitur

### Impor
- **File / Folder**: impor `.json` atau `.epub` satu per satu atau sekaligus satu folder. Di Android, pemilih folder native membaca subfolder lewat Storage Access Framework.
- **ZIP**: impor banyak file dari satu arsip `.zip`.
- **Plugin / Parser**: impor format game yang didukung plugin terpasang, lewat menu khusus atau routing otomatis berdasarkan ekstensi dan magic signature.
- **Terjemahan**: gabungkan hasil terjemahan ke proyek yang sudah ada.
- **Referensi bahasa**: impor teks bahasa lain (Inggris, Mandarin) per file atau seluruh folder, lalu dipakai sebagai referensi tambahan saat menerjemahkan.

### Sistem Plugin & Parser
Format game yang belum didukung bisa ditambahkan lewat paket plugin `.zip`, atau dengan menulis parser sendiri di menu **Setting → Plugin & Parser Manager** (`Alt + P`).

Yang bisa dipasang:

1. **Parser format game**: ekstraksi `extract` dan pengemasan ulang `pack`, termasuk format biner dan arsip multi-file.
2. **Tema visual**: `theme.css` dan `api.setTheme()` untuk palet dan watermark.
3. **Panel kustom**: widget tambahan di workspace lewat `panel(parentEl, api)`.
4. **Hook clipboard**: `onCopy` sebelum teks disalin, `onApply` sebelum terjemahan diterapkan.
5. **Perintah kustom**: terdaftar otomatis di Shortcut Keyboard Manager lewat `api.registerShortcut()`.
6. **Parser skrip tunggal (JS / Python)**: parser legacy satu file. Python berjalan di worker Pyodide yang dimuat dari CDN saat dipakai pertama kali (±10 MB).

Izin plugin bersifat deklaratif, bukan sandbox. Runtime tidak menolak pemanggilan API yang izinnya belum dideklarasikan, jadi `permissions` adalah kontrak kepercayaan, bukan pengaman. Detail arsitektur, `manifest.json`, dan contoh kode ada di [PLUGIN_GUIDE.md](./PLUGIN_GUIDE.md).

### Terjemahan Copy-Paste
Pilih baris, salin ke AI, tempel balik hasilnya, terapkan. Aplikasi yang memetakan hasil AI ke nomor baris yang benar.

- Format prompt bisa dipilih: numbered list, block, XML, JSONL, atau JSON array.
- Prompt header bisa diedit sendiri, termasuk varian yang memakai tanda kutip Jepang (kagikakko).
- **AI Check**: salin terjemahan yang sudah ada untuk diperiksa ulang, lalu terapkan koreksinya.
- Undo dan redo untuk setiap penerapan terjemahan.

### API Global (AI)
Hubungkan aplikasi ke API AI supaya terjemahan, ekstraksi glosarium, AI Check, dan AI Agent berjalan tanpa copy-paste.

- **OpenAI Compatible** (GPT, Claude via OpenRouter, DeepSeek, LLM lokal), **Gemini API** (Google AI Studio), dan **Anthropic**.
- Daftar model bisa diambil langsung dari API lewat tombol fetch.
- **Thinking / Reasoning**: matikan atau nyalakan mode berpikir. Masing-masing provider memakai parameternya sendiri.
- **Filter `<think>`**: blok `<think>...</think>` dan part `thought: true` dari respons Gemini dibuang sebelum terjemahan diterapkan.
- **Parameter generasi global**: max output tokens, seed, frequency penalty, presence penalty, dan reasoning effort (`minimal` sampai `xhigh`). Dipakai konsisten oleh Auto Translate dan AI Agent.
- **Gemma 4**: model `gemma-4-*` dikenali otomatis, dan mode thinking off dikirim sebagai `thinkingLevel: "minimal"`.
- **Limit RPM** dengan jeda otomatis antar request.

### Auto Copas (BETA)
Mode alternatif untuk Auto Translate, Auto Ekstrak, dan Auto Check yang tidak memakai API sama sekali. Aplikasi menjalankan situs AI di browser, lalu memindahkan teks **lewat clipboard** persis seperti copy-paste manual: tempel prompt (`Ctrl+V`), tekan Enter, tunggu selesai, klik tombol Copy milik situs, baca hasilnya dari clipboard. Tidak ada manipulasi teks lewat DOM.

- **Target:** Gemini, ChatGPT, DeepSeek, Arena.
- **Windows**: [Camoufox](https://github.com/daijro/camoufox), browser anti-detect berbasis Firefox. Aplikasi mengunduh rilis resminya dari GitHub saat pertama dipakai (sekitar 500 MB) lewat `curl.exe`, lalu menjalankannya sebagai child process. Tidak butuh Node.js atau npm. Setelah unduhan pertama, membuka browser langsung instan. Sesi login tersimpan di profil aplikasi, jadi login cukup sekali per situs lewat tombol **Buka Browser**.
- **Android**: WebView in-app (`AutoCopasActivity`). Paste lewat `InputConnection`, memakai clipboard asli.
- **Chat baru tiap X batch**: atur di Project/Dashboard Settings → **Auto Copas**. Nilai 0 berarti tidak pernah. Tombol New chat situsnya ditekan langsung, dan navigasi URL hanya dipakai sebagai fallback kalau tombolnya tidak ditemukan. Berlaku untuk semua target; pemilihan model tetap manual.
- **Thinking**: paksa **Selalu ON / Selalu OFF / Default situs**. Hanya berlaku untuk DeepSeek (tombol Pikir Mendalam/DeepThink) dan Gemini (baris Thinking/Penalaran). Diterapkan tiap batch sebelum kirim, dan kegagalan mengatur thinking tidak menggagalkan batch.
- **Retry**: 1x dengan chat baru. Kalau **Ulangi jika gagal** aktif, batch yang sama diulang terus sampai dihentikan.
- Hanya tersedia di aplikasi native, tidak di PWA.
- **Status beta.** Situs AI sering mengubah struktur halamannya, jadi otomasi bisa gagal kapan saja.

### AI Agent
Chat dengan AI yang punya akses langsung ke data proyek. Agent bisa membaca, menganalisis, dan mengubah terjemahan lewat percakapan.

**Tool baca:**

| Tool | Fungsi |
|---|---|
| `getProjectStats()` | Ringkasan progress, jumlah baris, daftar file |
| `getLines(start, end)` | Teks asli dan terjemahan untuk rentang baris |
| `getContext(line_num, radius)` | Konteks sekitar satu baris, radius 1 sampai 20 |
| `searchLines(query)` | Cari di teks asli, terjemahan, dan nama karakter |
| `getCharacterNames()` | Daftar nama karakter, inkonsistensi ditandai |
| `analyzeQuality(limit)` | Baris belum diterjemahkan, terjemahan terlalu pendek, nama tidak konsisten |
| `getProgressReport()` | Progress per file |
| `getGlossary()` | Glosarium aktif |
| `listSettings()` | Semua setting yang bisa diubah |
| `getMemory(category?)` / `listMemory()` | Memori agent, dengan filter kategori opsional |
| `webSearch(query, source?)` | Cari di Wikipedia, Jisho, VNDB, atau Tavily (butuh API key) |
| `searchVn(query, source?)` | Cari VN/anime lewat VNDB atau AniList |
| `extractGlossary(query, source?)` | Ekstrak glosarium dari karakter VN/anime |

**Tool tulis:**

| Tool | Fungsi |
|---|---|
| `applyTranslations(updates)` | Terapkan terjemahan: `[{num, trans_message, trans_name?}]` |
| `editLine(line_num, fields)` | Edit satu baris |
| `editLines(updates)` | Edit beberapa baris sekaligus |
| `clearTranslations(line_nums)` | Hapus terjemahan baris tertentu |
| `undoLastAction()` / `redoLastAction()` | Batalkan atau kembalikan aksi terakhir |
| `editPrompt(prompt_type, new_prompt)` | Edit prompt translation, glossary, ai_check, atau agent |
| `editGlossary(new_glossary)` | Tulis ulang glosarium |
| `toggleSetting(setting_name, value)` | Ubah setting aplikasi |
| `saveMemory(key, value, category, scope?)` / `deleteMemory(key)` | Kelola memori agent |

**Tool delegasi dan alur kerja:**

| Tool | Fungsi |
|---|---|
| `delegateParallelTranslate(startLine, endLine, instruction?)` | Terjemahkan rentang besar lewat subagent paralel |
| `delegateTranslate(lineNums, instruction?)` | Terjemahkan kumpulan baris tertentu |
| `delegateAnalyze(lineNums, focus?)` | Analisis kualitas terjemahan |
| `delegateGlossaryExtract(queries, source?)` | Ekstrak glosarium dari beberapa VN/anime sekaligus |
| `delegateAgent(task, max_turns?)` | Subagent otonom dengan loop tool sendiri |
| `askUser(question, options?)` | Kartu pertanyaan interaktif; loop agent berhenti sampai dijawab |
| `setPlan(steps)` / `updatePlanStep(step, status)` / `completePlan()` | Checklist rencana yang tampil live di chat |

Mutasi lebih dari 10 baris menampilkan diff-preview dan menunggu konfirmasi.

### Glosarium
Nama karakter, tempat, dan istilah khusus supaya terjemahan konsisten.

- Editor glosarium built-in, dengan preview aktif di workspace.
- Salin seleksi teks ke AI untuk ekstraksi terminologi otomatis.
- Impor nama dari **VNDB** (ID VN) atau **AniList** (ID media).
- Ekstrak nama dari anotasi ruby di EPUB.
- Impor dan ekspor glosarium ke file teks.

### Proofread & Pencarian
- Cari di teks asli maupun terjemahan.
- Opsi regex, case-sensitive, dan exact match.
- Filter cakupan: semua baris, hanya baris terpilih, dan seterusnya.
- Replace All.

### Editor Baris
Klik baris mana pun untuk mengedit nama karakter, teks asli, terjemahan, dan status terjemahan. Di Android editor muncul sebagai panel dari bawah supaya tidak tertutup keyboard.

Spasi di akhir kalimat terjemahan disimpan apa adanya (dipakai untuk mengatur jarak teks di dalam game), dan nama karakter boleh memuat koma — mis. `123. Nino, Menoa, Ichito: halo` tetap terbaca sebagai satu nama saat menempel hasil AI berformat nomor.

### EPUB
- Gambar berdiri sendiri tampil sebagai ilustrasi di antara baris dan tidak menambah nomor baris.
- Gambar yang menyertai paragraf tetap tampil pada baris teksnya.

### Mode Immersif
Pembaca layar penuh untuk novel dan visual novel.
- Toggle teks asli dan terjemahan dari header.
- Ukuran font dengan stepper, lebar teks (Sempit, Sedang, Lebar), dan tema (Gelap, Sepia, Terang).
- Drawer bookmark untuk lompat ke baris tertentu tanpa keluar dari mode baca.
- `Alt + I` untuk buka tutup, `Esc` untuk keluar, dan tombol sembunyikan header untuk membaca tanpa distraksi.

### Furigana & Kamus
- Konversi furigana memakai Kuroshiro dan Kuromoji di Web Worker terpisah, jadi UI tidak ikut menunggu saat membaca naskah panjang.
- Format keluaran: Hiragana (default), Katakana, atau Romaji.
- Hasil konversi kanji di-cache, jadi scrolling berulang tidak mengulang perhitungan.
- Pencarian arti kata menampilkan cara baca, bentuk dasar, kelas kata, dan terjemahan.

### Seleksi & Auto-Increment
- Pilih semua, pilih rentang, atau klik manual.
- Setelah terjemahan diterapkan, rentang "Dari - Sampai" otomatis maju dan rentang berikutnya langsung terpilih mengikuti ukuran Batch Translate.
- Undo untuk penerapan terakhir, plus progress bar.

### Pengaturan
- Bahasa sumber dan target.
- Jumlah baris per batch untuk terjemahan, glosarium, dan AI Check.
- Jumlah baris konteks yang ikut disalin ke AI, sebelum dan sesudah.
- Regex filter kustom dengan opsi case-sensitive.
- Tag HTML untuk parsing EPUB.

### Menu Tools
Menu **Tools** di workspace berisi:
- **Daftar File** dan **Validasi QC**.
- **Riwayat Kamus**: buka kembali pencarian kosakata sebelumnya.
- **Text Replacer**: penggantian teks massal di luar alur proofread.
- **File Explorer (OPFS)**: lihat ukuran file, unduh, atau bersihkan direktori penyimpanan.
- **Mode Immersif**.
- **Luna Hooker & VN Overlay**: terjemahkan dialog saat bermain, lihat bagian di bawah.
- **Ekspor ke Spreadsheet** dan **Impor Spreadsheet ke Proyek Ini**.

### Luna Hooker & VN Overlay (Terjemahan Sambil Main)
Menghubungkan CopasTool ke [LunaTranslator](https://github.com/HIllya51/LunaTranslator) yang sedang menghook teks game, lalu mencocokkan dialog yang muncul ke baris proyek.

- **Setup**: aktifkan *Layanan Jaringan* di LunaTranslator pada port `2333`, pasang Text Hooker ke game, lalu klik **Hubungkan** di menu Luna Hooker CopasTool.
- **Mode Check**: hanya menunjukkan apakah dialog game cocok dengan baris di proyek.
- **Mode TL**: baris yang belum diterjemahkan langsung diterjemahkan saat muncul, lalu disimpan ke proyek. Hasilnya tampil di overlay dan bisa di-undo seperti edit biasa.
- **Mesin TL**: pilih **API** atau **Copas** di bagian TL Mode. Copas memakai situs AI yang sudah login di browser otomatis, jadi TL Mode bisa jalan tanpa API key. Pilihan situs dan tombol **Buka Browser** ada di baris yang sama.
- **VN Overlay (Windows)**: jendela melayang yang menampilkan dialog aktif di atas game fullscreen, dengan mode klik-tembus dan tombol **Diagnosa Fullscreen** untuk memeriksa z-order.

Satu catatan soal Copas untuk TL Mode: Auto Copas hanya punya satu tab browser dan satu percakapan, jadi TL Mode berhenti sendiri kalau Auto Translate, Auto Ekstrak, atau Auto Check sedang berjalan. Hentikan batch itu dulu.

### Penyimpanan
Proyek disimpan di penyimpanan aplikasi: filesystem native kalau berjalan sebagai aplikasi Tauri, atau OPFS kalau berjalan di browser. Proyek bisa di-backup dan dipulihkan lewat file `.copas`; format lama `.cstl` tetap didukung.

Data biner dan aset file disimpan terpisah dari metadata, jadi auto-save tetap ringan dan dashboard tidak perlu memuat seluruh isi proyek.

#### Backup ke Folder

Tersedia di Chrome, Edge, Brave, Opera, aplikasi Windows, dan aplikasi Android. Desktop memakai File System Access API, aplikasi Windows memakai dialog pemilih folder native (`tauri-plugin-dialog`), Android memakai izin folder Storage Access Framework. Firefox, Safari, dan browser mobile lain memakai **Backup Semua ZIP**.

**Cara pakai:**
1. Klik **Backup ke Folder** di dashboard, lalu pilih folder.
2. Proyek ditulis sebagai `nama_proyek_backup.copas`, termasuk file EPUB asli dan aset pendukung. Backup berikutnya memperbarui file yang sama.
3. Klik **Pulihkan dari Folder** untuk memilih `.copas`, `.copas.zip`, atau `.cstl`. Pemulihan membuat proyek baru.

**Android:** folder boleh berada di penyimpanan perangkat atau penyedia dokumen seperti Google Drive. Berikan akses saat dialog memintanya.

**Desktop:** browser bisa meminta izin folder lagi setelah dimulai ulang. Pilih **Allow on every visit** kalau opsi itu muncul.

**Sinkron ke cloud:** folder tujuannya folder biasa, jadi bisa diarahkan ke folder milik aplikasi sinkron. Contoh: pilih folder di dalam `Drive saya` milik Google Drive for Desktop, atau jalankan `rclone sync D:\CSTLBackups drive:CSTL` lewat Task Scheduler. Dropbox, OneDrive, dan Syncthing bekerja dengan cara yang sama.

#### Folder Simpan Backup & Export (Aplikasi Native)

Di aplikasi Windows dan Android, semua backup dan export (Backup, Backup Semua ZIP, Export, ekspor glosarium) ditulis ke satu folder simpan.

- Folder dipilih sekali lewat dialog native, lalu diingat untuk penyimpanan berikutnya.
- Kalau folder sudah tidak bisa ditulis (dipindah atau dihapus), pemilih folder muncul lagi otomatis.
- Di Android, membatalkan pemilihan folder membuat file tetap tersimpan ke folder **Download**.

**Mode "Selalu tanya lokasi simpan":** aktifkan opsi ini di *Pengaturan Dashboard* kalau ingin setiap penyimpanan memunculkan dialog Save As, seperti opsi "Ask where to save each file" di browser. Selama opsi aktif, folder simpan yang tersimpan diabaikan. Membatalkan dialog berarti penyimpanan dibatalkan.

#### Spreadsheet (.xlsx)

Proyek bisa diekspor ke `.xlsx`, diedit bersama penerjemah lain di Excel, LibreOffice, atau Google Sheets, lalu ditarik kembali ke CopasTool. Tidak ada integrasi akun Google; Google Sheets dipakai sebagai editor file biasa.

**Ekspor** dari menu **Tools → Ekspor ke Spreadsheet**, atau tombol **Sheet** pada kartu proyek di dashboard. Hasilnya satu workbook berisi tiga tab:

| Tab | Isi |
|-----|-----|
| `Lines` | `line_num`, `file`, `name`, `message`, `trans_name`, `trans_message`, `is_translated`, `bookmarked`, `status`, plus kolom `extra` (JSON) untuk field struktural seperti Luca, EPUB, referensi bahasa, dan custom parser. |
| `Glossary` | `source`, `target`, `type`, `description`, satu baris per entri. |
| `Info` | Pengaturan proyek (`context_lines`, batch size, prompt, bahasa) sebagai baris `key` / `value`, plus penanda format. |

**Di Google Sheets:** buka [sheets.google.com](https://sheets.google.com), pilih **File → Import**, unggah `.xlsx`, lalu *Replace spreadsheet*. Setelah diedit, unduh lagi lewat **File → Download → Microsoft Excel (.xlsx)**.

**Impor** punya dua pintu masuk, dan keduanya harus diklik sendiri:

- **Workspace → Tools → Impor Spreadsheet ke Proyek Ini**, dipakai saat proyek sedang terbuka.
- **Dashboard → ⚙ → Pulihkan dari Spreadsheet (.xlsx)**, dipakai saat tidak ada proyek terbuka. Hasilnya selalu proyek baru, karena dashboard selalu menutup proyek.

Setelah file dipilih, CopasTool menanyakan:

- **Gabung ke Proyek Ini** (hanya kalau ada proyek terbuka): terjemahan dicocokkan per `line_num` + `file`. Hanya kolom terjemahan dan flag yang diambil; teks asli `message` tidak diubah, jadi ekspor ke format game tetap sinkron. Baris bernomor baru ditambahkan, glosarium digabung dan entri yang sudah ada diperbarui.
- **Buat Proyek Baru**: seluruh isi sheet, glosarium, dan pengaturan `Info` menjadi proyek baru.

Impor tidak pernah otomatis. File spreadsheet tidak dibaca saat proyek dibuka, dan merge tidak berjalan tanpa konfirmasi eksplisit.

Kolom dibaca berdasarkan nama header, jadi urutan kolom boleh diubah dan nama tab boleh diganti (misalnya `Lines` menjadi `Script`) selama kolom `message` ada. Baris `Info` yang tidak dikenal diabaikan.

Yang tidak ikut dalam spreadsheet: file EPUB asli, source mentah Luca dan custom parser (`lucaRawFiles`, `customRawFiles`), dan aset gambar EPUB. Untuk pindah perangkat lengkap dengan file aslinya, pakai **Backup** (`.copas`).

### Shortcut Keyboard
Semua pintasan bisa direkam ulang lewat menu **Shortcut Keyboard**.

| Kategori | Aksi | Bawaan |
|---|---|---|
| **Dashboard** | Fokus Kolom Cari Project | `/` |
| **Workspace** | Ekspor Terjemahan | `Alt + E` |
| | Buka Cari & Ganti (Proofread) | `Alt + R` |
| | Buka Tab Glosarium | `Alt + G` |
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
| **Plugin** | Perintah Kustom | Didaftarkan plugin sendiri |

Untuk mengubah: buka menu **Shortcut Keyboard**, klik kombinasi pada aksi yang ingin diganti, lalu tekan kombinasi baru. `Backspace` menghapus pintasan, `Reset` mengembalikan ke setelan default.

---

## Tutorial

### Mulai Proyek Baru
Klik **Buat Project**, isi nama proyek, pilih tipe file yang akan diimpor (JSON atau EPUB), lalu klik **Buka**.

### Impor Script
Di workspace, klik **Impor** di toolbar dan pilih file atau folder. Semua baris langsung muncul di tabel. File yang sudah pernah diimpor dilewati otomatis.

### Terjemahan Manual (Copy-Paste)
1. Pilih baris satu per satu, atau pakai **Pilih Range** untuk memilih banyak sekaligus.
2. Klik **Copy Terjemahan**, lalu tempel ke ChatGPT, Gemini, atau AI lain.
3. Setelah AI selesai, salin seluruh responsnya dan tempel ke kotak **Paste Hasil AI**.
4. Klik **Terapkan**. CopasTool mem-parsing hasil dan mengisi terjemahan ke baris yang sesuai.

Kalau hasilnya meleset, klik **Undo**.

### Auto Translate via API
1. Klik tombol pengaturan API di pojok kanan bawah workspace (ikon robot).
2. Pilih **Tipe API**: OpenAI Compatible, Gemini, atau Anthropic.
3. Isi **API Key** dan **Model**. Tombol ↻ mengambil daftar model langsung dari API.
4. Atur **RPM** sesuai limit akun, lalu klik **Simpan API**.
5. Pilih baris yang ingin diterjemahkan, klik **Jalankan Auto Translate**.

Untuk model thinking yang mengeluarkan blok `<think>...</think>`, aktifkan **Filter `<think>...</think>`** di pengaturan API.

#### Auto Translate / Auto Ekstrak / Auto Check via Copas
Kalau tidak punya API key:
1. Pilih **Copas** di dropdown mode (Translate: Auto/Agent/Copas; Glossary & AI Check: API/Copas), lalu pilih target situsnya.
2. Klik **Buka Browser**, lalu login sekali di jendela yang muncul. Windows memakai Camoufox, Android memakai WebView in-app. Sesi tersimpan.
3. Klik tombol Auto seperti biasa. Prompt ditempel otomatis, respons diambil lewat tombol Copy situs, hasilnya diterapkan per batch.

### Glosarium
Isi glosarium sebelum mulai menerjemahkan banyak baris.
1. Buka tab **Glosarium** di workspace.
2. Ketik nama karakter, tempat, atau istilah khusus di editor.
3. Atau klik **Import VNDB/AniList** dan masukkan ID VN atau media.
4. Glosarium aktif ikut tersalin otomatis setiap kali kamu menyalin teks ke AI.

### AI Agent
1. Klik tombol agent di pojok kanan bawah workspace (ikon chat).
2. Contoh permintaan:
   - *"Terjemahkan baris 1 sampai 10"*: agent mengambil teksnya, menerjemahkan, lalu menerapkan sendiri.
   - *"Cek konsistensi nama karakter"*: agent menganalisis dan melaporkan inkonsistensi.
   - *"Baris mana yang belum diterjemahkan?"*: agent memberi ringkasan progress.
   - *"Cari baris yang ada kata 'sayonara'"*: agent mencari dan menampilkan hasilnya.
3. Semua perubahan bisa di-undo dengan mengetik *"undo"* atau lewat tombol Undo.

### AI Check
1. Pilih baris yang sudah diterjemahkan.
2. Klik **Copy AI Check** untuk menyalin teks asli dan terjemahan dalam format khusus.
3. Tempel ke AI dan minta koreksi.
4. Salin hasilnya, tempel ke kotak **Paste AI Check**, lalu klik **Terapkan Koreksi**.

Yang ikut bekerja saat Auto Check:

- **Confidence scoring**: AI memberi tingkat keyakinan (high/medium/low) per koreksi. Koreksi high confidence (typo, grammar, nama salah, sisa aksara Jepang) diterapkan otomatis, sementara medium dan low masuk antrian review manual di tab AI Check. Opsi **Auto-apply koreksi high confidence** bisa dimatikan supaya semua koreksi direview manual.
- **Sanity gate lokal**: koreksi yang identik dengan teks sekarang dibuang. Rewrite yang mengubah lebih dari 60% token ditandai untuk review dan tidak diterapkan otomatis.
- **Linter lokal**: sisa tanda baca Jepang (。、・〜ー) dan spasi ganda diperbaiki tanpa AI. Sisa aksara CJK dan nama yang melanggar glosarium dikirim sebagai hint ke AI.
- **Konteks dua arah**: selain konteks baris sebelumnya, tersedia konteks baris sesudah dari Dashboard Settings.
- **Format JSON** untuk jalur API, dengan perbaikan JSON otomatis. Plaintext tetap didukung untuk jalur Copas.
- **Memori penolakan**: koreksi yang kamu tolak dicatat sebagai entri `REJECTED`, jadi batch berikutnya tidak mengusulkan perubahan yang sama.
- **Deep Check**: dua pass per batch. Pass pertama fokus akurasi makna, pass kedua fokus naturalness. Dua request per batch.
- Prompt bawaan menganut prinsip minimal edit: AI hanya mengubah bagian yang bermasalah.

### Proofread & Replace
Buka tab **Proofread**. Aktifkan **Regex** kalau perlu pola kompleks, centang **Case Sensitive** atau **Exact Match** sesuai kebutuhan, lalu klik **Replace All**.

### Ekspor
Klik **Ekspor** di toolbar. File hasil terjemahan diunduh dalam format aslinya (`.json` atau `.epub`). Untuk format game lain, plugin parser terpasang yang menjalankan `pack()`, termasuk format biner dan arsip multi-file.

Untuk backup proyek beserta seluruh datanya, klik **Backup** di dashboard. File `.copas` bisa dipulihkan kapan pun lewat tombol **Pulihkan**. Format lama `.cstl` juga tetap didukung.

---

## Format yang Didukung

| Format | Impor | Ekspor | Catatan |
|--------|:-----:|:------:|---------|
| `.json` | ✅ | ✅ | |
| `.epub` | ✅ | ✅ | |
| `.zip` | ✅ | tidak | Berisi banyak file |
| `.copas` / `.cstl` | ✅ | ✅ | Backup proyek; `.cstl` adalah format lama |
| `.xlsx` | ✅ | ✅ | Spreadsheet, lihat bagian Spreadsheet |
| Plugin / Parser Kustom | ✅ | ✅ | Format tambahan lewat paket plugin `.zip` |

---

## Keamanan

CopasTool memuat halaman AI pihak ketiga di jendela terpisah, jadi batas kepercayaannya diatur eksplisit.

- **Capability per jendela.** `src-tauri/capabilities/default.json` hanya berlaku untuk `"windows": ["main"]`. Jendela `vn-overlay` memakai `capabilities/overlay.json` yang minimal: event, drag, posisi/ukuran, close, hide. Tanpa clipboard, dialog, filesystem, atau opener, karena overlay hanya merender teks dialog lokal. Jendela `ai-companion` tidak diberi capability sama sekali.
- **Setiap perintah native memeriksa pemanggilnya.** Command di `src-tauri/src/lib.rs` menerima parameter `tauri::WebviewWindow` lalu memanggil `ensure_main_window` atau `ensure_trusted_window`. Hanya command overlay yang juga menerima `vn-overlay`. Halaman AI tidak bisa menyentuh filesystem meskipun konfigurasi capability diubah.
- **Allowlist host untuk jendela AI.** `open_ai_window` hanya menerima URL `https` ke host di `ALLOWED_AI_HOSTS`: `gemini.google.com`, `aistudio.google.com`, `chatgpt.com`, `chat.openai.com`, `chat.deepseek.com`, `meta.ai`, `claude.ai`, `chat.qwenlm.ai`, `lmarena.ai`, `arena.ai`, termasuk subdomainnya. Kalau menambah target baru, daftar URL situsnya ada di `COPAS_TARGETS` (`src/auto-copas/targets.ts`) dan host-nya harus ditambahkan ke `ALLOWED_AI_HOSTS`.
- **`eval_ai_script` hanya menyuntik ke host yang diizinkan.** Script ditolak kalau jendela AI sudah bernavigasi ke host lain. URL dipindahkan ke `window.location.href` lewat `serde_json`, jadi tidak bisa keluar dari string literal JS.
- **`withGlobalTauri: false`.** `window.__TAURI__` tidak disuntikkan ke setiap webview. Frontend memakai import `@tauri-apps/api` yang di-bundle, dan deteksi runtime memakai `window.__TAURI_INTERNALS__`.
- **Path penyimpanan disanitasi.** `native_save_file`, `native_read_file`, `native_delete_file`, dan `native_list_files` menolak path absolut dan `..`, lalu memastikan target tetap di dalam folder data aplikasi.
- **Penulisan ke folder pilihan user dijaga.** `native_write_file_to`, `native_read_file_from`, dan `native_list_dir` hanya menerima folder absolut yang berasal dari dialog pemilih folder native. Izin `dialog:allow-open` hanya diberikan ke jendela `main`. Nama file disanitasi terhadap `..`, `:`, dan path absolut, dan path hasil harus tetap di dalam folder tersebut.
- **Jendela overlay dibuat sesuai permintaan.** `vn-overlay` tidak terdaftar sebagai window tersembunyi di `tauri.conf.json`, jadi tidak ada webview ekstra sampai tombol overlay ditekan, dan Android yang tidak mendukung overlay tidak terpengaruh. `toggle_vn_overlay_window` dibuat `async` karena command sinkron yang membuat window akan deadlock di Windows.
- **Camoufox Auto Copas hanya lewat loopback.** Browser diunduh dari rilis resmi GitHub, dijalankan sebagai child process milik aplikasi, dan dikendalikan lewat WebDriver BiDi di `ws://127.0.0.1:<port>`. Browser hanya bisa dibuka dari jendela `main`. Di Android, semua perintah `copas*` hanya menjalankan WebView in-app yang memuat situs target.
- **`csp: null` dipertahankan dengan sengaja.** CSP ketat di jendela utama juga akan membatasi jendela AI yang memuat konten pihak ketiga, sementara aplikasi butuh inline style dan script, Web Worker, serta koneksi ke API AI pilihanmu. Batas keamanan yang sebenarnya ada pada capability dan guard Rust di atas.

---

## Stack

TypeScript dan Vite, dikompilasi ke vanilla JS tanpa runtime framework.

- **Tauri v2**: runtime desktop (NSIS dan MSI) dan mobile (APK).
- **@tauri-apps/plugin-clipboard-manager**: clipboard native yang tidak bergantung fokus jendela.
- **@tauri-apps/plugin-dialog**: pemilih folder native untuk folder simpan backup dan export, dipakai di Windows dan Android.
- **Web Worker storage**: `JSON.stringify` dan `JSON.parse` proyek berjalan di thread terpisah, jadi auto-save tidak membuat UI tersendat.
- **Android native bridge**: jendela WebView in-app, pemilih folder Storage Access Framework, penyimpanan ke `Download` lewat MediaStore, dan WebView Auto Copas.
- **Camoufox + tokio-tungstenite**: browser otomatis untuk Auto Copas di Windows, dikendalikan lewat **WebDriver BiDi** di WebSocket loopback. Unduhan memakai `curl.exe`; tanpa Node.js dan npm.
- **JSZip**: parsing arsip `.zip` dan penulisan `.xlsx`.
- **Kuroshiro + Kuromoji**: konversi furigana.
- **Pako**: kompresi dan dekompresi.
- **OPFS dan IndexedDB**: penyimpanan lokal file dan database proyek.
- **vite-plugin-pwa**: PWA, install ke homescreen, dan cache offline.

---

## Pengembangan & Build

### Prasyarat

- **Node.js 20+** dan npm.
- **Rust stable** plus dependensi Tauri.
- Untuk Android: **Android SDK**, **NDK 26.3.11579264**, dan **JDK 17**.
- Untuk unduhan Camoufox di Windows: `curl.exe`, yang sudah tersedia di Windows 10 versi 1803 ke atas.

### Perintah

| Perintah | Fungsi |
|----------|--------|
| `npm run dev` | Vite dev server di port 5173 |
| `npm run build` | Type-check (`tsc`) lalu build produksi ke `dist/` |
| `npm run preview` | Pratinjau lokal build produksi |
| `npm run typecheck` | Type-check TypeScript tanpa emit |
| `npm run version:check` | Pastikan semua penanda versi sama dengan `package.json` |
| `npm run test:copas` | Test invariant page-script Auto Copas |
| `npm run tauri:dev` | Aplikasi desktop Tauri mode dev |
| `npm run tauri:build` | Build installer Windows (NSIS dan MSI) |
| `npm run android:init` | Scaffold Android di `src-tauri/gen/` lalu patch bridge |
| `npm run android:build` | Patch bridge Android lalu build APK |
| `scripts\build-and-install-android.ps1` | Build, align, sign, dan install ke HP lewat ADB |

`src-tauri/gen/` masuk `.gitignore`, jadi **clone baru wajib menjalankan `npm run android:init`** sebelum build Android. Kedua skrip Android di atas sudah memanggil `scripts/patch-android-bridge.mjs`, yang menyalin `AndroidBridge.kt` dan `AutoCopasActivity.kt` dari `src-tauri/android/` ke proyek hasil scaffold. Tanpa langkah itu, build akan jalan tetapi bridge native-nya kosong. Build desktop tidak butuh langkah ini.

### Versi aplikasi

`package.json → "version"` adalah satu-satunya sumber kebenaran. Saat build dan dev, `vite.config.ts` menginjeksi versi ke frontend sebagai `__APP_VERSION__` untuk badge dashboard dan status bar.

`npm run version:check` juga menjadi gate pertama di CI. Perintah ini memverifikasi `tauri.conf.json`, `Cargo.toml`, `Cargo.lock`, badge versi README, dan placeholder `__APP_VERSION__` di `index.html`. Untuk menaikkan versi, ubah keempat tempat itu sekaligus lalu jalankan ulang perintahnya.

### CI (`.github/workflows/build-tauri.yml`)

- `version-check`: verifikasi versi, jalankan `npm run test:copas`, dan pastikan tag rilis cocok dengan `package.json`.
- `build-windows`: menghasilkan `CopasTool_<version>_x64-setup.exe` (NSIS) dan `CopasTool_<version>_x64_en-US.msi` (MSI).
- `build-android`: menghasilkan APK yang sudah di-align dan di-sign untuk `arm64-v8a`, `armeabi-v7a`, dan `x86_64`. Tiga arsitektur dibangun sebagai APK terpisah, bukan satu APK universal; setiap APK dinamai mengikuti target output Gradle, misalnya `app-arm64-release-unsigned-signed.apk`. Keystore release diambil dari repository secret. Kalau secret tidak tersedia, workflow membuat keystore sementara supaya build tetap hijau, tetapi APK hasilnya tidak bisa memperbarui instalasi CopasTool yang sudah ada.
- `publish-release`: mengunggah `.exe`, `.msi`, dan `.apk` ke GitHub Release saat tag `v*` di-push.

Cache yang dipakai: `Swatinem/rust-cache` untuk job Windows dan Android, `actions/cache` untuk `~/.gradle`, dan cache npm bawaan `actions/setup-node`. NDK tidak di-cache karena runner GitHub sudah menyediakannya.

Kamus Kuromoji di `public/dict/` berukuran sekitar 17 MB. Item ini tetap dibundle ke APK karena dibutuhkan furigana, tetapi tidak di-precache service worker. Pembukaan pertama hanya mengunduh shell aplikasi (sekitar 1 MB), dan kamus masuk cache saat furigana dipakai pertama kali.

---

## Platform & Kompatibilitas

**Windows Desktop (native):**
- Windows 10 dan Windows 11, 64-bit.
- Installer tersedia dalam bentuk NSIS (`.exe`) dan Windows Installer (`.msi`).
- Penyimpanan memakai filesystem native tanpa batas kuota browser, dan jendela AI Companion terpisah.

**Android (native):**
- `minSdk` 24, yaitu Android 7.0 (Nougat) ke atas.
- APK dibangun untuk `arm64-v8a`, `armeabi-v7a`, dan `x86_64`.
- Jendela WebView in-app, pemilih folder dan backup lewat Storage Access Framework, serta penyimpanan ke koleksi `Download` lewat MediaStore. Pada Android 10 ke atas, MediaStore tidak memerlukan izin storage tambahan.

**Browser dan PWA:**
- Bisa di-install sebagai PWA dengan cache offline.
- Penyimpanan memakai OPFS (`navigator.storage.getDirectory()`) dengan fallback ke IndexedDB.
- Chrome / Edge 102+ (disarankan), Firefox 111+, Safari 15.2+ (memakai fallback IndexedDB).

---

## Kredit

Dibuat oleh [Atho64](https://github.com/atho64), di-fork oleh [LuKazuu](https://github.com/LuKazuu), lalu di-fork balik dan dikembangkan lagi oleh [Atho64](https://github.com/atho64).

---

## Lisensi & Atribusi Pihak Ketiga

CopasTool dirilis di bawah **[MIT License](./LICENSE)**.

Dependensi npm (JSZip, Kuroshiro, Kuromoji, Pako, path-browserify) berlisensi permisif. Kamus furigana memakai Kuromoji dan IPADIC (Apache 2.0 / NAIST). Tidak ada komponen copyleft atau non-komersial yang dibundel maupun dibutuhkan.

Daftar lengkap ada di **[THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)**.
