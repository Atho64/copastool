// English for the markup in index.html and overlay.html.
//
// Keys are the Indonesian text exactly as it appears in the DOM (entities
// already decoded). Entries whose Indonesian and English text are identical are
// omitted: the runtime leaves unmatched strings untouched.

export const UI_EN: Record<string, string> = {
  // ── Boot, tutorial, dashboard ────────────────────────────────────────────
  'Alat bantu penerjemahan string dengan dukungan AI.':
    'A string translation helper with AI support.',
  'PANDUAN INTERAKTIF': 'INTERACTIVE GUIDE',
  'Lewati': 'Skip',
  'Berikutnya': 'Next',
  'Lewati tutorial': 'Skip tutorial',
  'Chibi pemandu tutorial': 'Tutorial guide chibi',
  'Putar ulang atau matikan suara': 'Replay or mute the voice-over',
  'Putar ulang tutorial': 'Replay the tutorial',
  'Penyimpanan perangkat hampir penuh. Backup proyek ke .zip untuk mencegah kehilangan data.':
    'Device storage is almost full. Back up the project to .zip to avoid losing data.',
  'Buat Project': 'New Project',
  'Pulihkan Project': 'Restore Project',
  'Project Tersimpan': 'Saved Projects',
  'Terbaru': 'Newest',
  'Terlama': 'Oldest',
  'Nama (A-Z)': 'Name (A-Z)',
  'Nama (Z-A)': 'Name (Z-A)',
  'Suara': 'Voice',
  'Progress Tertinggi': 'Highest Progress',
  'Progress Terendah': 'Lowest Progress',
  'Penerjemahan & Patching Game Engine Visual Novel': 'Visual Novel Engine Translation & Patching',
  'Cari project...': 'Search projects...',
  'Pengaturan & Backup Proyek': 'Project Settings & Backup',
  'Backup Semua (.zip)': 'Backup All (.zip)',
  'Pulihkan dari Spreadsheet (.xlsx)': 'Restore from Spreadsheet (.xlsx)',
  'Backup ke Folder': 'Backup to Folder',
  'Pulihkan dari Folder': 'Restore from Folder',

  // ── Workspace toolbar ───────────────────────────────────────────────────
  'Kembali ke Dashboard': 'Back to Dashboard',
  'Impor': 'Import',
  'Impor File': 'Import File',
  'Impor Contoh Latihan': 'Import Practice Sample',
  'Impor Folder': 'Import Folder',
  'Impor ZIP': 'Import ZIP',
  'Impor TL File': 'Import TL File',
  'Impor TL Folder': 'Import TL Folder',
  'Impor File (Plugin/Parser)…': 'Import File (Plugin/Parser)…',
  'Impor Folder (Plugin/Parser)': 'Import Folder (Plugin/Parser)',
  'Ekspor': 'Export',
  'Ekspor Terjemahan': 'Export Translation',
  'Cari': 'Search',
  'Cari / Ganti': 'Find / Replace',
  'Daftar File': 'File List',
  'Daftar Bookmark': 'Bookmark List',
  'Validasi QC': 'QC Validation',
  'Riwayat Kamus': 'Dictionary History',
  'Mode Immersif': 'Immersive Mode',
  'Ekspor ke Spreadsheet': 'Export to Spreadsheet',
  'Impor Spreadsheet ke Proyek Ini': 'Import Spreadsheet into This Project',
  'Ekspor proyek ke Google Spreadsheet (.xlsx)': 'Export the project to a spreadsheet (.xlsx)',
  'Gabung spreadsheet (.xlsx) ke proyek ini': 'Merge a spreadsheet (.xlsx) into this project',
  'Setting': 'Settings',
  'Pengaturan Proyek': 'Project Settings',
  'Backup proyek (Ctrl+S)': 'Back up the project (Ctrl+S)',
  'Undo (Batalkan aksi terakhir)': 'Undo (revert the last action)',
  'Redo (Ulangi aksi terakhir)': 'Redo (repeat the last action)',
  'Batch sebelumnya (Alt+ArrowUp)': 'Previous batch (Alt+ArrowUp)',
  'Batch berikutnya (Alt+ArrowDown)': 'Next batch (Alt+ArrowDown)',
  'Tools Tambahan': 'Extra Tools',
  'Plugin & Commands': 'Plugins & Commands',
  'Workspace actions': 'Workspace actions',
  'Workspace sections': 'Workspace sections',

  // ── Left panel / selection ──────────────────────────────────────────────
  'Daftar Teks': 'Text List',
  'Area Kerja': 'Workspace',
  'Pilih Range Baris': 'Select Line Range',
  'Centang': 'Check',
  'Pilih Semua': 'Select All',
  'Batal Pilih': 'Clear Selection',
  'Dari...': 'From...',
  'Sampai...': 'To...',
  'Tampilan Layar': 'Screen View',
  'Tampilkan Teks Layar Penuh': 'Show Text Full Screen',
  'Tampilkan Keduanya (Bagi Layar)': 'Show Both (Split Screen)',
  'Tampilkan Area Kerja / Terjemahan Penuh': 'Show Workspace / Translation Full Screen',

  // ── Translate tab ───────────────────────────────────────────────────────
  'Hapus': 'Delete',
  'Copy (': 'Copy (',
  'Buka Browser': 'Open Browser',
  'Mulai Semi-Auto': 'Start Semi-Auto',
  'Ulangi jika gagal': 'Retry if it fails',
  'Glossary yang ikut terkirim': 'Glossary sent with the prompt',
  'Paste Terjemahan': 'Paste Translation',
  'Terapkan': 'Apply',
  'Terjemahan Nama Karakter (Opsional)': 'Character Name Translations (Optional)',
  'Copy Nama (': 'Copy Names (',
  'Paste Terjemahan Nama': 'Paste Name Translations',
  'Nama Asli': 'Original Name',
  'Terjemahan': 'Translation',
  'Mode HTL (Human Translation)': 'HTL Mode (Human Translation)',
  'Klik baris untuk membuka editor dan mengetik terjemahan manual.':
    'Click a line to open the editor and type the translation manually.',
  'Referensi 1': 'Reference 1',
  'Referensi 2': 'Reference 2',
  'Hapus Terjemahan': 'Delete Translation',
  'Hapus (': 'Delete (',
  'Situs AI yang dijalankan browser otomatis': 'AI site the automated browser runs',
  'Buka situs di browser otomatis untuk login sekali, sesi tersimpan':
    'Open the site in the automated browser to log in once; the session is kept',
  'Auto pantau clipboard: salin balasan AI, otomatis terapkan dan salin batch berikutnya':
    'Auto-watch the clipboard: copy the AI reply, apply it, and copy the next batch automatically',
  'Tampilkan bubble mengambang di atas aplikasi AI untuk copy-paste 1 ketukan':
    'Show a floating bubble over the AI app for one-tap copy-paste',
  'Jika gagal, ulangi batch yang sama terus sampai dihentikan (jeda pakai RPM)':
    'If it fails, repeat the same batch until stopped (pacing uses RPM)',
  'Paste hasil dari AI di sini...': 'Paste the AI result here...',

  // ── Glossary tab ────────────────────────────────────────────────────────
  'Ekstrak Glossary': 'Extract Glossary',
  'Auto Ekstrak': 'Auto Extract',
  'Paste Glossary AI': 'Paste AI Glossary',
  'Simpan ke Glossary': 'Save to Glossary',
  'Import Eksternal (VNDB / AniList / Ruby)': 'External Import (VNDB / AniList / Ruby)',
  'Mesin Auto Ekstrak: API (HTTP) atau Copas (browser otomatis)':
    'Auto Extract engine: API (HTTP) or Copas (automated browser)',
  'v47937 atau URL VNDB': 'v47937 or a VNDB URL',
  'URL AniList manga/novel': 'AniList manga/novel URL',
  '[character] 速川麦 = Hayakawa Mugi {male name}\n[place] 渋谷 = Shibuya {place name}':
    '[character] 速川麦 = Hayakawa Mugi {male name}\n[place] 渋谷 = Shibuya {place name}',

  // ── AI Check tab ────────────────────────────────────────────────────────
  'Paste Hasil AI Check': 'Paste AI Check Result',
  'Apply & Lanjut': 'Apply & Continue',
  'Mesin Auto Check: API (HTTP) atau Copas (browser otomatis)':
    'Auto Check engine: API (HTTP) or Copas (automated browser)',
  '[line 12]\ncategory: Grammar\nreason: alasan koreksi\ncorrection: Nama: Teks terjemahan yang sudah dikoreksi':
    '[line 12]\ncategory: Grammar\nreason: reason for the correction\ncorrection: Name: The corrected translation text',

  // ── Status bar ──────────────────────────────────────────────────────────
  'File: - | Baris: 0 | Diterjemahkan: 0/0 (0%)': 'File: - | Lines: 0 | Translated: 0/0 (0%)',

  // ── Dashboard settings modal ────────────────────────────────────────────
  'Default Pengaturan Proyek Baru': 'New Project Defaults',
  'Bahasa & Mode': 'Language & Mode',
  'Bahasa Sumber (Source)': 'Source Language',
  'Bahasa Tujuan (Target)': 'Target Language',
  'Mode Terjemahan': 'Translation Mode',
  'AI (Bantuan AI)': 'AI (AI-assisted)',
  'HTL (Manual / Manusia)': 'HTL (Manual / Human)',
  'Regex Filter (Opsional)': 'Regex Filter (Optional)',
  'Contoh: ^[A-Za-z0-9_]+$ atau /pola/flags': 'Example: ^[A-Za-z0-9_]+$ or /pattern/flags',
  'Tampilan & Kamus': 'Display & Dictionary',
  'Tampilkan Furigana': 'Show Furigana',
  'Hiragana (Default)': 'Hiragana (Default)',
  'Ukuran Font Utama': 'Main Font Size',
  'Kamus Pop-up (Hover / Sentuh)': 'Pop-up Dictionary (Hover / Tap)',
  'AI / LLM (Direkomendasikan)': 'AI / LLM (Recommended)',
  'Tradisional (Jisho / FreeDict)': 'Traditional (Jisho / FreeDict)',
  'Kustomisasi Prompt Kamus AI': 'Customize the AI Dictionary Prompt',
  'Gunakan {word} dan {context}': 'Use {word} and {context}',
  'Validasi & QC Terjemahan': 'Translation Validation & QC',
  'Saring karakter Kana/Kanji tertinggal': 'Filter leftover Kana/Kanji characters',
  'Saring terjemahan terlalu mirip teks asli': 'Filter translations too similar to the source',
  'Saring terjemahan terlalu panjang (overflow)': 'Filter translations that are too long (overflow)',
  'Saring ketidaksesuaian jumlah baris': 'Filter line-count mismatches',
  'Saring teks terdeteksi bahasa Inggris': 'Filter text detected as English',
  'Saring tanda baca Jepang bocor': 'Filter leaked Japanese punctuation',
  'Saring nama karakter belum diterjemahkan': 'Filter untranslated character names',
  'Abaikan nama karakter saat paste': 'Ignore character names when pasting',
  'Izinkan simpan baris terjemahan kosong': 'Allow saving empty translation lines',
  'Aktifkan Memori Estafet (Summary Chaining)': 'Enable Relay Memory (Summary Chaining)',
  'Tandai terjemahan ragu dengan [?]': 'Mark uncertain translations with [?]',
  'Gunakan safe tag === LABEL ===': 'Use the === LABEL === safe tag',
  'Ambang Kemiripan (%):': 'Similarity Threshold (%):',
  'Rasio Panjang Maksimal:': 'Maximum Length Ratio:',
  'Batch & Konteks AI': 'Batch & AI Context',
  'Format Copy/Paste AI': 'AI Copy/Paste Format',
  'Konteks Baris Sebelumnya': 'Previous Line Context',
  'Konteks Baris Sesudah': 'Following Line Context',
  'Sumber Teks Konteks': 'Context Text Source',
  'Teks Asli Jepang': 'Original Japanese Text',
  'Teks Terjemahan': 'Translated Text',
  'Keduanya (Asli & Terjemahan)': 'Both (Original & Translation)',
  'Paralel Batch (Auto Translate)': 'Parallel Batches (Auto Translate)',
  'Auto-Increment Baris': 'Line Auto-Increment',
  'Aktifkan Auto-Increment (mengikuti ukuran Batch Translate)':
    'Enable Auto-Increment (follows the Translate Batch size)',
  'Penyimpanan (Backup & Export)': 'Storage (Backup & Export)',
  'Selalu tanya lokasi simpan (dialog Save As) setiap backup & export':
    'Always ask where to save (Save As dialog) on every backup & export',
  'Aktif: dialog Save As muncul tiap simpan, folder & nama file bisa diganti. Nonaktif: otomatis ke folder simpan terpilih (Download di Android jika belum ada).':
    'On: the Save As dialog appears on every save and the folder & file name can be changed. Off: saves automatically to the selected folder (Downloads on Android when none is set).',
  'Auto Copas (Browser Otomatis)': 'Auto Copas (Automated Browser)',
  'Chat baru setiap': 'New chat every',
  'batch': 'batch',
  'Default situs': 'Site default',
  'Selalu ON': 'Always ON',
  'Selalu OFF': 'Always OFF',
  'Chat baru: percakapan baru tiap X batch (0 = tidak pernah, 1 = tiap batch). Thinking: DeepSeek pakai tombol Pikir Mendalam/DeepThink, Gemini pakai varian Thinking/Penalaran di pemilih model. Diterapkan tiap batch sebelum kirim; target lain mengabaikannya.':
    'New chat: a new conversation every X batches (0 = never, 1 = every batch). Thinking: DeepSeek uses the DeepThink toggle, Gemini uses the Thinking/Reasoning model variant. Applied before every batch; other targets ignore it.',
  'Preferensi & Tema': 'Preferences & Theme',
  'Tema Warna (Color Palette)': 'Color Palette',
  'Tag Target EPUB': 'EPUB Target Tag',
  'Tampilkan preview gambar/ilustrasi di proyek EPUB':
    'Show image/illustration previews in EPUB projects',
  'Tampilkan bubble logging di semua proyek': 'Show the logging bubble in all projects',
  'Kelola plugin (.zip) atau buat parser baru.': 'Manage plugins (.zip) or create a new parser.',
  'Buka Plugin & Parser Manager': 'Open Plugin & Parser Manager',
  'Batal': 'Cancel',
  'Reset ke Bawaan': 'Reset to Defaults',
  'Simpan Default': 'Save Defaults',

  // ── Dashboard prompts modal ─────────────────────────────────────────────
  'Default Prompts Proyek Baru': 'New Project Prompt Defaults',
  'Prompt Terjemahan AI': 'AI Translation Prompt',
  'Standar Indonesia': 'Indonesian Standard',
  'Standar Indonesia (Kagikakko 「」)': 'Indonesian Standard (Kagikakko 「」)',
  'Prompt Ekstraksi Glosarium': 'Glossary Extraction Prompt',
  'Estafet Riwayat Koreksi AI Check (Chaining)': 'AI Check Correction History Relay (Chaining)',
  'Sertakan Ringkasan Cerita pada AI Check': 'Include the Story Summary in AI Check',
  'Koneksikan Memori AI Agent ke AI Check': 'Connect AI Agent Memory to AI Check',
  'Review mode: pause tiap batch, semua koreksi masuk antrean review manual':
    'Review mode: pause after each batch; every correction goes into a manual review queue',
  'Auto-apply koreksi high confidence (matikan agar high tetap direview manual)':
    'Auto-apply high-confidence corrections (turn off to review high-confidence ones manually)',
  'Deep Check: 2 pass spesialis (Akurasi lalu Naturalness, 2x request per batch)':
    'Deep Check: 2 specialist passes (Accuracy then Naturalness, 2x requests per batch)',
  'Ringkasan Cerita AI Check:': 'AI Check Story Summary:',
  'Prompt Ringkasan Cerita AI Check:': 'AI Check Story Summary Prompt:',
  'Catatan Khusus Lokalisasi AI Check:': 'AI Check Localization Notes:',
  'Riwayat Koreksi AI Check:': 'AI Check Correction History:',
  'Prompt Summary Chaining (Memori Estafet)': 'Summary Chaining Prompt (Relay Memory)',
  'Simpan Default Prompts': 'Save Prompt Defaults',

  // ── Settings modal ──────────────────────────────────────────────────────
  'Umum': 'General',
  'Glosarium': 'Glossary',
  'Shortcut': 'Shortcuts',
  'Tab Pengaturan Proyek': 'Project Settings Tabs',
  'Referensi Bahasa Tambahan (JSON)': 'Extra Language References (JSON)',
  'Impor Ref 1': 'Import Ref 1',
  'Folder Ref 1': 'Ref 1 Folder',
  'Hapus 1': 'Clear 1',
  'Impor Ref 2': 'Import Ref 2',
  'Folder Ref 2': 'Ref 2 Folder',
  'Hapus 2': 'Clear 2',
  'Ref 1 - Belum diimpor': 'Ref 1 - not imported yet',
  'Ref 2 - Belum diimpor': 'Ref 2 - not imported yet',
  'Impor satu file JSON untuk Referensi 1': 'Import a single JSON file for Reference 1',
  'Impor seluruh folder JSON untuk Referensi 1': 'Import a whole JSON folder for Reference 1',
  'Hapus data Referensi 1 dari seluruh baris': 'Clear Reference 1 data from every line',
  'Impor satu file JSON untuk Referensi 2': 'Import a single JSON file for Reference 2',
  'Impor seluruh folder JSON untuk Referensi 2': 'Import a whole JSON folder for Reference 2',
  'Hapus data Referensi 2 dari seluruh baris': 'Clear Reference 2 data from every line',
  'Ekstrak glossary sekalian saat menerjemah (istilah konsisten)':
    'Extract the glossary while translating (consistent terminology)',
  'Aktifkan Auto-Increment baris (mengikuti ukuran Batch Translate)':
    'Enable line Auto-Increment (follows the Translate Batch size)',
  'Istilah baru diekstrak sekalian saat menerjemah, dalam satu request yang sama. Batch berikutnya memakai istilah itu, jadi nama dan istilah konsisten tanpa menambah jumlah request.':
    'New terms are extracted while translating, in the same request. Later batches reuse those terms, so names and terminology stay consistent without extra requests.',
  'Abaikan nama karakter saat menerapkan hasil terjemahan dari AI (tidak memvalidasi nama jika AI hanya mengembalikan pesan)':
    'Ignore character names when applying AI translation results (names are not validated when the AI returns only the message)',
  'Format & Eksternal': 'Format & External',
  'Format Copy/Paste Terjemahan AI': 'AI Translation Copy/Paste Format',
  'Tag HTML Target EPUB': 'EPUB Target HTML Tag',
  'Tampilkan preview gambar/ilustrasi di daftar teks (EPUB)':
    'Show image/illustration previews in the text list (EPUB)',
  'Ringkasan Cerita Saat Ini (Current Summary)': 'Current Story Summary',
  'Kosongkan': 'Clear',
  'Kustomisasi Prompt Ringkasan (Summary Prompt)': 'Customize the Summary Prompt',
  'Sertakan Ringkasan Cerita (Story Context) pada AI Check': 'Include Story Context in AI Check',
  'Koneksikan Memori AI Agent (Karakter & Gaya) ke AI Check':
    'Connect AI Agent Memory (Characters & Style) to AI Check',
  'Format Output AI Check (mesin API):': 'AI Check Output Format (API engine):',
  'Plaintext (kompatibel copas)': 'Plaintext (copy-paste compatible)',
  'JSON (parse deterministik, API saja)': 'JSON (deterministic parsing, API only)',
  'Ringkasan Cerita AI Check Saat Ini (Story Context):': 'Current AI Check Story Context:',
  'Salin dari Translate': 'Copy from Translate',
  'Salin ringkasan cerita dari Translate ke AI Check':
    'Copy the story summary from Translate into AI Check',
  'Kosongkan ringkasan cerita AI Check': 'Clear the AI Check story summary',
  'Catatan panduan lokalisasi (misal: gaya panggilan, nada bicara karakter, dll)...':
    'Localization guidance notes (e.g. how characters address each other, tone of voice, etc.)...',
  'Kosongkan riwayat koreksi': 'Clear the correction history',
  '(Otomatis terakumulasi saat koreksi diterapkan, atau ketik langsung di sini)':
    '(Accumulates automatically as corrections are applied, or type directly here)',
  'Kustomisasi Prompt Ringkasan Cerita AI Check (Story Context Prompt):':
    'Customize the AI Check Story Context Prompt:',
  'Riwayat Koreksi Sebelumnya (Changelog):': 'Previous Corrections (Changelog):',
  'Memori AI Agent & Aturan Karakter': 'AI Agent Memory & Character Rules',
  'Buka Pengelola Memori AI Agent': 'Open the AI Agent Memory Manager',
  'Kelola pengetahuan karakter, gaya bahasa, istilah, dan preferensi untuk Agent Chat & AI Check.':
    'Manage character knowledge, writing style, terminology, and preferences for Agent Chat & AI Check.',
  'Daftar Istilah & Glosarium Proyek': 'Project Terms & Glossary',
  'Masukkan istilah per baris dalam format': 'Enter one term per line in the format',
  '[kategori] istilah_asli = terjemahan {catatan}': '[category] original_term = translation {note}',
  'atau': 'or',
  'istilah = terjemahan': 'term = translation',
  'Atur pintasan keyboard untuk Dashboard dan Workspace.':
    'Configure keyboard shortcuts for the Dashboard and Workspace.',
  'Buka Konfigurasi Shortcut Keyboard': 'Open the Keyboard Shortcut Configuration',
  'Kelola plugin (.zip), parser, atau buka pengaturan plugin format.':
    'Manage plugins (.zip), parsers, or open the format plugin settings.',
  'Simpan Pengaturan': 'Save Settings',

  // ── Agent memory modal ──────────────────────────────────────────────────
  'Memori AI Agent': 'AI Agent Memory',
  'Tambah / Edit Memori': 'Add / Edit Memory',
  'Tutup': 'Close',
  'Simpan Memori': 'Save Memory',
  'Panduan gaya panggilan, nada bicara, dan istilah.':
    'Guidance on how characters address each other, tone of voice, and terminology.',
  'Key (contoh: style_natural)': 'Key (example: style_natural)',
  'Isi memori (contoh: Gunakan bahasa santai dan natural)':
    'Memory content (example: Use casual, natural language)',
  '[character] 速川麦 = Hayakawa Mugi {male name}\n[place] 渋谷 = Shibuya {place name}\n魔王 = Demon Lord':
    '[character] 速川麦 = Hayakawa Mugi {male name}\n[place] 渋谷 = Shibuya {place name}\n魔王 = Demon Lord',

  // ── Line editor modal ───────────────────────────────────────────────────
  'Edit Terjemahan': 'Edit Translation',
  'Teks Asli': 'Original Text',
  'English (Referensi)': 'English (Reference)',
  '中文 (Referensi)': '中文 (Reference)',
  'Nama Karakter (Terjemahan)': 'Character Name (Translation)',
  'Terjemahan (Bisa di-replace)': 'Translation (replaceable)',
  'Tandai sebagai sudah diterjemahkan': 'Mark as translated',
  'Simpan Perubahan': 'Save Changes',

  // ── Proofread modal ─────────────────────────────────────────────────────
  'Cari & Replace': 'Find & Replace',
  'Cari:': 'Find:',
  'Ganti dengan:': 'Replace with:',
  'Ketik kata atau pola regex...': 'Type a word or regex pattern...',
  'Teks pengganti untuk Replace All...': 'Replacement text for Replace All...',
  'Sertakan Semua': 'Include All',
  'Kecualikan Semua': 'Exclude All',

  // ── QA modal ────────────────────────────────────────────────────────────
  'Filter Pengecekan': 'Check Filters',
  'Jalankan Validasi': 'Run Validation',
  'Hasil Validasi': 'Validation Results',
  'Status: Siap dijalankan.': 'Status: Ready to run.',

  // ── Logging + agent panel ───────────────────────────────────────────────
  'AI Request Log': 'AI Request Log',
  'Hapus log': 'Clear the log',
  'Estimasi token percakapan vs context window model':
    'Estimated conversation tokens vs the model context window',
  'Sesi Chat': 'Chat Sessions',
  '+ Sesi Baru': '+ New Session',
  'Memori Agent': 'Agent Memory',
  'Hentikan agent': 'Stop the agent',
  'Hapus riwayat chat': 'Clear the chat history',
  'Tanyakan arti kata, atau suruh terjemahkan... (Tekan Enter untuk kirim)':
    'Ask what a word means, or tell the agent to translate... (press Enter to send)',
  'Kirim': 'Send',
  'Halo! Saya CSTL Agent. Saya bisa menjawab pertanyaan seputar proyek ini atau membantu mengeksekusi terjemahan layaknya Vibecoding Agent.':
    "Hi! I'm the CSTL Agent. I can answer questions about this project or help execute translations like a vibecoding agent.",

  // ── API settings modal ──────────────────────────────────────────────────
  'Pengaturan API Global': 'Global API Settings',
  'Profil API': 'API Profiles',
  '-- Pilih profil tersimpan --': '-- Select a saved profile --',
  'Nama profil baru (mis. DeepSeek, Gemini)...': 'New profile name (e.g. DeepSeek, Gemini)...',
  'Simpan Profil': 'Save Profile',
  'Koneksi API & Model': 'API Connection & Model',
  'Tipe API Provider': 'API Provider Type',
  'API Base URL': 'API Base URL',
  'Kosongkan untuk default provider': 'Leave empty for the provider default',
  'Merge system prompt ke user message': 'Merge the system prompt into the user message',
  'API Key Utama': 'Primary API Key',
  'Key disimpan': 'Keys are stored',
  'tanpa enkripsi': 'without encryption',
  'di penyimpanan lokal aplikasi ini (sama seperti file konfigurasi biasa). Siapa pun yang punya akses ke perangkat atau profil browser ini bisa membacanya. Gunakan key dengan kuota terbatas, dan jangan pakai di komputer bersama.':
    "in this app's local storage (like any ordinary config file). Anyone with access to this device or browser profile can read them. Use keys with limited quota, and don't use them on a shared computer.",
  'Nama Model': 'Model Name',
  '-- Pilih model --': '-- Select a model --',
  'Ambil daftar model dari API': 'Fetch the model list from the API',
  'Context Window (token, 0 = otomatis per model)':
    'Context Window (tokens, 0 = automatic per model)',
  'Override manual context window model. Kosongkan/0 untuk deteksi otomatis dari nama model. Penting untuk model lokal/unknown.':
    'Manually override the model context window. Leave empty/0 to auto-detect it from the model name. Important for local/unknown models.',
  'Backup API Keys & Strategi': 'API Key Backups & Strategy',
  '1 key per baris (atau format: key|url|model)': '1 key per line (or format: key|url|model)',
  'Strategi Rotasi:': 'Rotation Strategy:',
  'Fallback (Gunakan utama dulu)': 'Fallback (use the primary key first)',
  'Random (Acak antar key)': 'Random (across keys)',
  'Acak': 'Random',
  'Parameter & Rate Limit': 'Parameters & Rate Limit',
  'Limit RPM': 'RPM Limit',
  'Timeout Diam': 'Idle Timeout',
  'detik · 0 = tanpa batas': 'seconds · 0 = unlimited',
  'Timeout Diam dihitung ulang setiap kali ada potongan balasan masuk. Jadi ia mengukur':
    'The idle timeout resets every time a piece of the reply arrives. So it measures',
  'sepi': 'silence',
  ', bukan total durasi. Naikkan kalau memakai model lokal yang lambat.':
    ', not total duration. Raise it when using a slow local model.',
  'Off (Hemat Token / Cepat)': 'Off (Saves Tokens / Faster)',
  'On (Lebih Akurat)': 'On (More Accurate)',
  'Streaming output (terjemahan & agent)': 'Streaming output (translation & agent)',
  'Filter tag <think>...</think> dari output': 'Filter <think>...</think> tags from the output',
  'Tavily API Key': 'Tavily API Key',
  'tvly-... (Opsional untuk web search)': 'tvly-... (optional, for web search)',
  'Simpan API': 'Save API',
  'Hapus Riwayat': 'Clear History',

  // ── Text replacer modal ─────────────────────────────────────────────────
  'Pra-Terjemahan (Sebelum AI)': 'Pre-translation (Before AI)',
  'Pasca-Terjemahan (Setelah AI)': 'Post-translation (After AI)',
  'Simpan': 'Save',
  'TeksAsli = Pengganti\n/\\s+/g =': 'OriginalText = Replacement\n/\\s+/g =',
  'Aku = Saya\n/"\\s*([^"]+?)\\s*"/g = "$1"': 'Aku = Saya\n/"\\s*([^"]+?)\\s*"/g = "$1"',

  // ── Custom parser modal ─────────────────────────────────────────────────
  'Parser Custom (JS/Python)': 'Custom Parser (JS/Python)',
  'Parser Baru': 'New Parser',
  'Ekspor Semua': 'Export All',
  'Impor Parser…': 'Import Parsers…',
  'Pengaturan LucaSystem': 'LucaSystem Settings',
  'Profil untuk impor TXT (Luca) di atas. Profil terkunci setelah proyek berisi baris.':
    'Profile for the TXT (Luca) import above. The profile is locked once the project has lines.',
  'Impor file TXT LucaSystem (Summer Pockets, CLANNAD, Tomoyo After), mesin natif':
    'Import LucaSystem TXT files (Summer Pockets, CLANNAD, Tomoyo After), native engine',
  'Impor satu folder file TXT LucaSystem, mesin natif':
    'Import a folder of LucaSystem TXT files, native engine',
  'Nama MC tampilan (mis. Tomoya)': 'MC display name (e.g. Tomoya)',
  'Cara kerja parser custom?': 'How does the custom parser work?',
  'Tulis fungsi': 'Write a',
  'untuk impor dan (opsional)': 'function for import and (optionally)',
  'untuk ekspor round-trip. JavaScript jalan di Web Worker, Python jalan di pyodide (unduhan pertama ~10MB, butuh internet sekali).':
    'for round-trip export. JavaScript runs in a Web Worker, Python runs in pyodide (first download ~10MB, needs internet once).',
  '. Return array': '. Return an array',
  '; field': '; the',
  'wajib,': 'field is required,',
  '= potongan baris asli yang disimpan untuk dipatch saat ekspor, dan':
    '= the original line fragment kept for patching on export, and',
  '(angka, opsional) = penanda posisi bebas buatan parser, dikembalikan di serialize() sebagai':
    '(number, optional) = a free position marker set by the parser, returned in serialize() as',
  ', berguna saat raw bisa duplikat.': ', useful when raw can be duplicated.',
  'berisi file asli + baris proyek (': 'holds the original file + project lines (',
  '). Return string (atau bytes untuk format biner). Tanpa serialize(), ekspor jatuh ke JSON generik.':
    '). Return a string (or bytes for binary formats). Without serialize(), export falls back to generic JSON.',
  'Satu proyek terkunci ke satu parser. Parser tersimpan global di browser dan bisa dipakai lintas proyek.':
    'A project is locked to one parser. Parsers are stored globally in the browser and can be reused across projects.',
  'Cocok ekstensi': 'Match extensions',
  'Cocok magic bytes': 'Match magic bytes',
  'Cocok nama file (regex)': 'Match file name (regex)',
  'parse(ctx): Impor': 'parse(ctx): Import',
  'Contoh': 'Example',
  'serialize(ctx): Ekspor (opsional)': 'serialize(ctx): Export (optional)',
  'Uji Parser': 'Test Parser',
  'Pilih File Uji…': 'Choose Test File…',
  'Uji parse()': 'Test parse()',
  'Aset Parser': 'Parser Assets',
  'Tambah File Aset…': 'Add Asset File…',
  'Setelan Parser (opsional)': 'Parser Settings (optional)',
  'Dibaca parser lewat': 'Read by the parser through',
  '. Tipe: string/number/boolean/select/textarea. Nilai yang dipilih user diedit lewat tombol':
    '. Types: string/number/boolean/select/textarea. The value the user picks is edited through the',
  'Setelan': 'Settings',
  'di daftar parser.': 'button in the parser list.',
  'Nama parser (mis. Script MGS)': 'Parser name (e.g. MGS Script)',
  'Ekstensi: .mgs, .scp': 'Extensions: .mgs, .scp',
  'Cara CSTL mencocokkan file dengan parser ini': 'How CSTL matches files to this parser',
  'Regex nama file: ^scene_\\w+': 'File name regex: ^scene_\\w+',
  'Isi contoh template': 'Fill in the template example',
  'async function parse(ctx) { ... return [{ name, message, raw }] }':
    'async function parse(ctx) { ... return [{ name, message, raw }] }',
  'async function serialize(ctx) { ... return teksHasil }':
    'async function serialize(ctx) { ... return resultText }',
  'Impor file game menggunakan parser yang cocok': 'Import game files using the matching parser',
  'Impor satu folder file game menggunakan parser yang cocok':
    'Import a folder of game files using the matching parser',
  'Semua parser dalam satu file JSON (aset base64)': 'All parsers in one JSON file (base64 assets)',
  'Impor parser dari file JSON atau zip hasil Ekspor Parser':
    'Import parsers from a JSON file or a zip produced by Export Parsers',

  // ── File list modal ─────────────────────────────────────────────────────
  'Daftar File Proyek': 'Project File List',
  'Tambah File': 'Add File',

  // ── Immersive view ──────────────────────────────────────────────────────
  'Ukuran Huruf': 'Font Size',
  'Lebar Teks': 'Text Width',
  'Sempit': 'Narrow',
  'Sedang': 'Medium',
  'Lebar': 'Wide',
  'Tema': 'Theme',
  'Gelap': 'Dark',
  'Terang': 'Light',
  'Terjemahan (klik untuk teks asli)': 'Translation (click for the original text)',
  'Tampilan Teks': 'Text Display',
  'Sembunyikan header': 'Hide the header',
  'Tutup (Escape)': 'Close (Escape)',
  'Perkecil': 'Smaller',
  'Perbesar': 'Larger',
  'Tampilkan header': 'Show the header',
  'Cari bookmark (no baris, nama file, atau isi teks)...':
    'Search bookmarks (line number, file name, or text content)...',
  'Hapus semua bookmark di proyek ini': 'Delete every bookmark in this project',
  'Tutup preview': 'Close the preview',
  'EPUB Image Full Preview': 'EPUB Image Full Preview',

  // ── Bookmark modal ──────────────────────────────────────────────────────
  'Daftar Bookmark (': 'Bookmark List (',
  'Hapus Semua': 'Clear All',

  // ── OPFS explorer ───────────────────────────────────────────────────────
  'Hati-hati: menghapus file atau folder sistem bisa membuat proyek tidak bisa dibuka. Hapus hanya file yang Anda kenali.':
    'Careful: deleting system files or folders can make the project unopenable. Only delete files you recognize.',
  'Belum ada file di OPFS.': 'No files in OPFS yet.',
  'Memuat...': 'Loading...',
  'Muat ulang daftar file': 'Reload the file list',

  // ── Plugin manager ──────────────────────────────────────────────────────
  'Kelola plugin (.zip) dan parser custom (JavaScript/Python) untuk membaca dan mengekspor format game visual novel.':
    'Manage plugins (.zip) and custom parsers (JavaScript/Python) for reading and exporting visual novel game formats.',
  '+ Pasang Plugin (.zip)': '+ Install Plugin (.zip)',
  'Semua (': 'All (',
  'Paket Plugin (': 'Plugin Packages (',
  'Script Parser (': 'Parser Scripts (',
  'Reset Semua': 'Reset All',
  'Muat ulang daftar plugin & parser': 'Reload the plugin & parser list',

  // ── Shortcut modal ──────────────────────────────────────────────────────
  'Klik kombinasi lalu tekan tombol keyboard.': 'Click a combination, then press the keyboard keys.',
  'untuk menghapus,': 'to clear,',
  'untuk membatalkan.': 'to cancel.',
  'Reset semua shortcut ke default': 'Reset every shortcut to the default',

  // ── Luna hooker modal ───────────────────────────────────────────────────
  'Terputus': 'Disconnected',
  'Hook teks dari LunaTranslator, cocokkan ke baris proyek, tampilkan di overlay.':
    'Hook text from LunaTranslator, match it to project lines, show it in the overlay.',
  'Koneksi LunaTranslator': 'LunaTranslator Connection',
  'Hubungkan': 'Connect',
  'Putuskan': 'Disconnect',
  ': cek sinkronisasi dialog': ': check dialogue sync',
  ': terjemahkan otomatis saat bermain': ': translate automatically while playing',
  'TL Mode aktif': 'TL Mode active',
  'Model: -': 'Model: -',
  'Baris mentah yang belum diterjemahkan akan diterjemahkan lalu disimpan.':
    'Raw lines that are not translated yet will be translated and saved.',
  'Auto-connect saat CopasTool dibuka': 'Auto-connect when CopasTool opens',
  'Auto-scroll editor mengikuti dialog': 'Auto-scroll the editor to follow the dialogue',
  'Jendela melayang selalu di atas game, menampilkan dialog aktif.':
    'A floating window always on top of the game, showing the active dialogue.',
  'Buka / Toggle VN Overlay': 'Open / Toggle VN Overlay',
  'Mode Interaktif: Nonaktif': 'Interactive Mode: Off',
  'Klik-tembus secara bawaan. Nyalakan': 'Click-through by default. Turn on',
  'Mode Interaktif': 'Interactive Mode',
  'untuk menggeser atau menekan tombol overlay.': 'to drag or press the overlay buttons.',
  'Diagnosa Fullscreen': 'Fullscreen Diagnostics',
  'VN Overlay hanya tersedia di aplikasi desktop Windows. Hook LunaTranslator tetap bisa dipakai di sini.':
    'The VN Overlay is only available in the Windows desktop app. The LunaTranslator hook still works here.',
  'Cara pakai': 'How to use',
  'Pengaturan': 'Settings',
  'Layanan Jaringan': 'Network Services',
  'Pasang Text Hooker ke game yang sedang dimainkan.': 'Attach the Text Hooker to the game you are playing.',
  'Klik': 'Click',
  ', lalu': ', then',
  'Buka VN Overlay': 'Open VN Overlay',
  'Mesin TL Mode: API (HTTP) atau Copas (browser otomatis)':
    'TL Mode engine: API (HTTP) or Copas (automated browser)',
  'Situs AI yang digerakkan Auto Copas': 'AI site driven by Auto Copas',
  'Terjemahkan baris ini plus N-1 baris berikutnya dalam satu request, supaya dialog selanjutnya sudah siap. 1 = hanya baris aktif.':
    'Translate this line plus the next N-1 lines in one request so the following dialogue is ready. 1 = only the active line.',
  'Buka situs di browser otomatis untuk login sekali. Sesi tersimpan.':
    'Open the site in the automated browser to log in once. The session is kept.',

  // ── Game engine modal ───────────────────────────────────────────────────
  '1. Deteksi': '1. Detect',
  '2. Ekstraksi Skenario': '2. Extract Scenario',
  '3. Bangun Patch (XP3)': '3. Build Patch (XP3)',
  '4. Panduan & Alat': '4. Guide & Tools',
  'Folder Game': 'Game Folder',
  'Executable Game': 'Game Executable',
  '-- Pilih folder game terlebih dahulu --': '-- Select a game folder first --',
  'Pilih Manual': 'Select Manually',
  'Jalankan': 'Launch',
  'Pilih folder game untuk mendeteksi executable.': 'Select a game folder to detect the executable.',
  'Engine Terdeteksi': 'Detected Engine',
  'Target Ekstraksi': 'Extraction Target',
  'data.xp3 (Standar Utama)': 'data.xp3 (Main Standard)',
  'Pilih Folder...': 'Select Folder...',
  'Pilih File (.xp3)...': 'Select File (.xp3)...',
  'Pilih arsip skenario atau folder hasil ekstraksi.':
    'Select a scenario archive or an extracted folder.',
  'Slot Bahasa': 'Language Slot',
  'Slot Teks Sumber:': 'Source Text Slot:',
  'Slot 0, Jepang (JP)': 'Slot 0, Japanese (JP)',
  'Slot 1, Inggris (EN)': 'Slot 1, English (EN)',
  'Slot 2, Mandarin (CN)': 'Slot 2, Mandarin (CN)',
  'Kolom Terjemahan:': 'Translation Column:',
  'Kosong (mulai baru)': 'Empty (start fresh)',
  'Impor dari Slot 1 (EN)': 'Import from Slot 1 (EN)',
  'Impor dari Slot 2 (CN)': 'Import from Slot 2 (CN)',
  'Impor dari Slot 0 (JP)': 'Import from Slot 0 (JP)',
  'Folder Cache': 'Cache Folder',
  'Buka': 'Open',
  'Ekstraksi': 'Extraction',
  'Ekstrak & Muat ke CopasTool': 'Extract & Load into CopasTool',
  'Menunggu ekstraksi...': 'Waiting for extraction...',
  'Slot Bahasa & Word Wrap': 'Language Slot & Word Wrap',
  'Slot Tujuan Terjemahan:': 'Target Translation Slot:',
  'Slot 1, EN / Terjemahan (standar)': 'Slot 1, EN / Translation (standard)',
  'Slot 0, Timpa teks JP': 'Slot 0, Overwrite JP text',
  'Karakter per Baris:': 'Characters per Line:',
  'Standar VN: 50-60.': 'VN standard: 50-60.',
  'Nama Berkas Patch:': 'Patch File Name:',
  'Otomatis pakai patch2.xp3, patch3.xp3… bila nama itu sudah ada di folder game.':
    'Automatically uses patch2.xp3, patch3.xp3… when that name already exists in the game folder.',
  'Word wrap otomatis (aman tag & ruby)': 'Automatic word wrap (tag & ruby safe)',
  'Pasang patch ke folder game': 'Install the patch into the game folder',
  'Aset Tambahan Patch': 'Extra Patch Assets',
  'Font kustom, gambar UI, dan aset non-skenario di folder ini otomatis dikemas ke dalam patch.':
    'Custom fonts, UI images, and non-scenario assets in this folder are packed into the patch automatically.',
  'Buka Folder Aset': 'Open the Assets Folder',
  'Bangun Patch Game (.xp3)': 'Build Game Patch (.xp3)',
  'Bangun Patch (.xp3)': 'Build Patch (.xp3)',
  'Uji Coba Game': 'Test the Game',
  'Menunggu ekspor patch...': 'Waiting for the patch export...',
  'Alur Kerja': 'Workflow',
  'pilih folder game & executable.': 'select the game folder & executable.',
  'ekstrak arsip atau folder skenario, hasilnya langsung masuk ke editor.':
    'extract the archive or scenario folder; the result goes straight into the editor.',
  'Terjemahkan di editor CopasTool (AI, glosarium, dsb).':
    'Translate in the CopasTool editor (AI, glossary, etc.).',
  'bangun': 'build',
  'dan pasang ke folder game.': 'and install it into the game folder.',
  'Alat Internal': 'Built-in Tools',
  ': baca arsip XP3, dekompilasi skenario PSB/MDF, dan susun ulang patch tanpa alat eksternal.':
    ': read XP3 archives, decompile PSB/MDF scenarios, and rebuild patches without external tools.',
  ': bongkar arsip .pfs dan dekripsi skrip .ast, seluruhnya di dalam aplikasi.':
    ': unpack .pfs archives and decrypt .ast scripts, entirely inside the app.',
  'Game Engine Tabs': 'Game Engine Tabs',
  'Pilih atau masukkan path folder visual novel...': 'Select or enter the visual novel folder path...',
  'Pindai ulang folder': 'Rescan the folder',
  'Pilih file .exe secara manual': 'Select the .exe file manually',
  'Jalankan executable terpilih': 'Launch the selected executable',
  'Pindai ulang arsip dan folder terbaru': 'Rescan for the latest archives and folders',
  'Pilih folder hasil ekstraksi / folder skenario secara manual':
    'Select the extracted folder / scenario folder manually',
  'Pilih berkas arsip secara manual': 'Select the archive file manually',
  'Default: %APPDATA%\\com.copastool.app\\game_cache\\<slug>':
    'Default: %APPDATA%\\com.copastool.app\\game_cache\\<slug>',
  'Buka folder cache di File Explorer': 'Open the cache folder in File Explorer',
  'Jalankan game untuk uji coba langsung': 'Launch the game to test it right away',

  // ── VN overlay window (overlay.html) ────────────────────────────────────
  'LunaTranslator: terputus': 'LunaTranslator: disconnected',
  'Mode interaktif: klik, geser, dan tombol aktif': 'Interactive mode: click, drag, and buttons active',
  'Ubah mode interaktif': 'Switch interactive mode',
  'Transparansi latar (85% → 60% → 35% → 100%)': 'Background opacity (85% → 60% → 35% → 100%)',
  'Ubah transparansi': 'Change opacity',
  'Tutup overlay': 'Close the overlay',
  'Tandai baris ini': 'Bookmark this line',
  'Bookmark baris': 'Bookmark line',
  'Menunggu dialog…': 'Waiting for dialogue…',

  // ── Interface language picker ───────────────────────────────────────────
  'Bahasa Antarmuka': 'Interface Language',
  'Bahasa Antarmuka / Interface Language': 'Interface Language',
  'Ganti bahasa antarmuka': 'Switch the interface language',
  'Mengubah bahasa antarmuka aplikasi. Bahasa sumber dan tujuan proyek tidak ikut berubah.':
    'Changes the app interface language. The project source and target languages are not affected.',
};
