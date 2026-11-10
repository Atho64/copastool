// English for strings the TypeScript modules build at runtime: toasts, dialogs,
// status lines, and validation messages.
//
// Template literals are keyed with `{name}` placeholders. The runtime compiles
// those into anchored patterns, so `Disalin 12 baris.` matches `Disalin {n}
// baris.` without changing the call site.
//
// Deliberately absent: AI prompt templates, agent tool schemas, console logs,
// and CSS selectors. Those are model-facing or developer-facing text, not UI.

export const RUNTIME_EN: Record<string, string> = {
  // ── Dashboard / projects ────────────────────────────────────────────────
  'Memuat daftar proyek...': 'Loading the project list...',
  'Gagal mengakses storage browser.': 'Could not access browser storage.',
  'Belum ada proyek tersimpan. Klik "+ Buat Project" atau "Pulihkan Project" untuk memulai.':
    'No saved projects yet. Click "+ New Project" or "Restore Project" to get started.',
  'Tidak ada proyek yang cocok dengan filter pencarian.':
    'No project matches the search filter.',
  'Gagal memperbaiki: ': 'Repair failed: ',
  'Hapus permanen proyek "{name}"?': 'Permanently delete the project "{name}"?',
  'Menghapus...': 'Deleting...',
  'Ubah nama': 'Rename',
  'Hapus project': 'Delete project',
  'Membuka...': 'Opening...',
  'Buka project': 'Open project',
  'Gagal membuka proyek: ': 'Failed to open the project: ',
  'Gagal membaca proyek untuk diekspor.': 'Failed to read the project for export.',
  'Masukkan nama proyek baru:': 'Enter a name for the new project:',
  'Buat proyek baru': 'New project',
  'Nama proyek baru...': 'New project name...',
  'Gagal membuat proyek: ': 'Failed to create the project: ',
  'Hapus proyek ini secara permanen?': 'Delete this project permanently?',
  'Gagal menghapus: ': 'Failed to delete: ',
  'File terbaca normal sekarang (kemungkinan error baca sementara). Daftar proyek dimuat ulang.':
    'The file reads normally now (likely a temporary read error). The project list was reloaded.',
  'Tidak ada data yang bisa diselamatkan dari file ini.\n\nPulihkan dari backup, atau hapus filenya.':
    'Nothing can be recovered from this file.\n\nRestore from a backup, or delete the file.',
  'File hanya berisi pengaturan tanpa nama proyek dan baris, tidak layak diselamatkan.\n\nPulihkan dari backup, atau hapus filenya.':
    'The file only holds settings, with no project name and no lines, so it is not worth recovering.\n\nRestore from a backup, or delete the file.',
  'Perbaikan selesai.\n\nData diselamatkan: {n} baris':
    'Repair finished.\n\nRecovered data: {n} lines',
  ' (perkiraan hingga ~{n} baris hilang di titik kerusakan)':
    ' (up to ~{n} lines likely lost at the corruption point)',
  '\nCek hasilnya: kalau ada yang kurang, pulihkan dari backup.':
    '\nCheck the result: if something is missing, restore from a backup.',
  'Masukkan nama baru untuk proyek:': 'Enter a new name for the project:',
  'Ubah nama proyek': 'Rename project',
  'Nama proyek...': 'Project name...',
  'Gagal mengubah nama proyek: ': 'Failed to rename the project: ',
  'Backup Luca dibatalkan: sidecar corrupt dan tidak dapat dibaca.':
    'Luca backup cancelled: the sidecar is corrupt and unreadable.',
  'JSZip tidak tersedia untuk backup proyek besar.': 'JSZip is unavailable for large project backups.',
  'JSZip tidak tersedia.': 'JSZip is unavailable.',
  'Belum ada proyek untuk dibackup.': 'No project to back up yet.',
  'Backup semua {n} proyek sebagai satu file ZIP?': 'Back up all {n} projects as a single ZIP file?',
  'Backup semua proyek': 'Back up all projects',
  'Backup semua ZIP': 'Backup All ZIP',
  'Menyiapkan backup semua proyek...': 'Preparing to back up all projects...',
  'Membackup proyek {i}/{total}: {name}': 'Backing up project {i}/{total}: {name}',
  'Data mentah Luca untuk proyek "{name}" tidak dapat dibaca: sidecar corrupt, backup semua dibatalkan.':
    'The raw Luca data for project "{name}" cannot be read: the sidecar is corrupt, so the full backup was cancelled.',
  'Backup semua proyek selesai.': 'All projects backed up.',
  'Gagal membuat backup ZIP: ': 'Failed to create the backup ZIP: ',
  'Penyimpanan browser penuh. Lakukan backup/ekspor proyek lalu bersihkan file yang tidak diperlukan.':
    'Browser storage is full. Back up or export the project, then remove files you no longer need.',
  'Gagal menyimpan ke storage.': 'Failed to save to storage.',
  'Proyek ini sedang terbuka di tab/jendela lain. Tutup dulu di sana untuk menghindari kehilangan data.':
    'This project is open in another tab/window. Close it there first to avoid losing data.',
  'Gagal memigrasikan data mentah Luca ke storage.': 'Failed to migrate the raw Luca data into storage.',
  'Furigana gagal dimuat: {x}': 'Furigana failed to load: {x}',
  'Gagal menyimpan proyek terakhir.\n\nBuka kembali proyek tersebut dan lakukan backup manual.\n\n':
    'Failed to save the last project.\n\nReopen that project and make a manual backup.\n\n',
  'JSZip tidak tersedia untuk restore backup besar.': 'JSZip is unavailable for restoring large backups.',
  'project.json tidak ditemukan di backup ZIP.': 'project.json was not found in the backup ZIP.',
  '\n\nCatatan: backup lama ini tidak menyimpan file EPUB asli.':
    '\n\nNote: this older backup does not include the original EPUB file.',
  '\n\nCatatan: definisi parser "{name}" ikut dipulihkan dari backup.':
    '\n\nNote: the definition of parser "{name}" was also restored from the backup.',
  'Proyek "{name}" dipulihkan.{note}': 'Project "{name}" restored.{note}',
  'Gagal memulihkan proyek: ': 'Failed to restore the project: ',
  'Parser custom sudah tidak ada, ekspor jatuh ke JSON':
    'The custom parser no longer exists; export falls back to JSON',

  // ── Export ──────────────────────────────────────────────────────────────
  '\n...dan {n} baris lainnya.': '\n...and {n} more lines.',
  'Masih ada {n} baris yang belum diterjemahkan.\n\n{preview}{rest}\n\nLanjut ekspor tetap?':
    'There are still {n} untranslated lines.\n\n{preview}{rest}\n\nExport anyway?',
  'Peringatan ekspor': 'Export warning',
  'File EPUB tidak dapat diakses.': 'The EPUB file is not accessible.',
  'EPUB berhasil diekspor': 'EPUB exported successfully',
  'Gagal mengekspor EPUB: ': 'Failed to export the EPUB: ',
  'Tomoyo export butuh impor ulang folder decompile lucksystem (SCRIPT.PAK\\*.txt) ':
    'Tomoyo export needs the lucksystem decompile folder (SCRIPT.PAK\\*.txt) to be re-imported ',
  'agar CSTL menyimpan raw buffer per file.\n\n': 'so CSTL can keep a raw buffer per file.\n\n',
  'Tomoyo txt masih berisi byte prefix (c1 ff / U+FFFD) di dalam tanda kutip. ':
    'The Tomoyo txt still contains prefix bytes (c1 ff / U+FFFD) inside the quotes. ',
  'Itu format decompile lucksystem lama, bukan decompiled_clean yang sudah diperbaiki.\n\n':
    'That is the old lucksystem decompile format, not the fixed decompiled_clean output.\n\n',
  'CSTL {v} | baris bermasalah: {n}/{total}\n':
    'CSTL {v} | affected lines: {n}/{total}\n',
  'Jalankan ulang script decompile dengan lucksystem terbaru, atau strip_tomoyo_prefix.py.':
    'Re-run the decompile script with the latest lucksystem, or strip_tomoyo_prefix.py.',
  'ZIP Luca berhasil diekspor': 'Luca ZIP exported successfully',
  'TXT Luca berhasil diekspor': 'Luca TXT exported successfully',
  'Parser custom untuk proyek ini sudah tidak ada (terhapus). Ekspor memakai format JSON.':
    'The custom parser for this project no longer exists (it was deleted). Export uses the JSON format.',
  'Parser "{name}" sedang nonaktif. Ekspor memakai format JSON.\n\nAktifkan parser di menu Parser Custom untuk round-trip.':
    'Parser "{name}" is disabled. Export uses the JSON format.\n\nEnable the parser in the Custom Parser menu for a round-trip.',
  'Parser "{name}" tidak punya serialize(), ekspor memakai format JSON.':
    'Parser "{name}" has no serialize(), so export uses the JSON format.',
  'Mengekspor dengan parser "{name}"...': 'Exporting with parser "{name}"...',
  'File asli untuk proyek ini tidak tersedia di sidecar (kemungkinan dipulihkan dari backup lama):\n':
    'The original files for this project are not in the sidecar (probably restored from an old backup):\n',
  'serialize() menerima text/bytes kosong untuk file tersebut. Impor ulang file asli untuk round-trip penuh.':
    'serialize() received empty text/bytes for those files. Re-import the original files for a full round-trip.',
  'Ekspor dengan parser "{name}" berhasil': 'Exported with parser "{name}"',
  'Gagal ekspor parser custom: {msg}\n\nMencoba ekspor JSON sebagai fallback...':
    'Custom parser export failed: {msg}\n\nTrying a JSON export as a fallback...',

  // ── Copy / paste / apply ────────────────────────────────────────────────
  'Disalin {n} baris.': 'Copied {n} lines.',
  'Tersimpan': 'Saved',
  'Tersimpan: {name}': 'Saved: {name}',
  'Ubah': 'Edit',
  '{a}/{b} baris': '{a}/{b} lines',

  // Example payloads shown as paste-box placeholders (ai-format.ts).
  '[line 12]\nspeaker: Spica\ntext: Selamat pagi\n\n[line 13]\nspeaker: Mugi\ntext: Mau ngapain hari ini?':
    '[line 12]\nspeaker: Spica\ntext: Good morning\n\n[line 13]\nspeaker: Mugi\ntext: What are we doing today?',
  '<?xml version="1.0" encoding="UTF-8"?>\n<lines>\n  <line num="12" speaker="Spica">\n    <text>Selamat pagi</text>\n  </line>\n  <line num="13">\n    <text>Mau ngapain hari ini?</text>\n  </line>\n</lines>':
    '<?xml version="1.0" encoding="UTF-8"?>\n<lines>\n  <line num="12" speaker="Spica">\n    <text>Good morning</text>\n  </line>\n  <line num="13">\n    <text>What are we doing today?</text>\n  </line>\n</lines>',
  '{"num":12,"speaker":"Spica","text":"Selamat pagi"}\n{"num":13,"text":"Mau ngapain hari ini?"}':
    '{"num":12,"speaker":"Spica","text":"Good morning"}\n{"num":13,"text":"What are we doing today?"}',
  '[12,"Spica","Selamat pagi"]\n[13,"Mau ngapain hari ini?"]':
    '[12,"Spica","Good morning"]\n[13,"What are we doing today?"]',
  '12. [D] Spica: Selamat pagi\n13. [N] Malam yang tenang.':
    '12. [D] Spica: Good morning\n13. [N] A quiet night.',
  'Belum ada sesi tersimpan. Sesi dibuat otomatis saat kamu mengirim pesan pertama.':
    'No saved session yet. A session is created automatically when you send your first message.',
  'Teks di kotak kosong atau tidak valid.': 'The text box is empty or invalid.',
  'Gagal parse terjemahan:': 'Failed to parse the translation:',
  '[#{n}] Duplikat nomor baris.': '[#{n}] Duplicate line number.',
  '[Validasi Checkbox] Copy {a} baris, tapi yang di-paste {b} baris.':
    '[Checkbox validation] Copied {a} lines, but {b} lines were pasted.',
  '[#{n}] Hilang dari hasil paste.': '[#{n}] Missing from the pasted result.',
  '[#{n}] Nyasar, baris ini tidak kamu centang sebelumnya.':
    '[#{n}] Stray line: you did not check this line earlier.',
  '[#{n}] Tidak ada di JSON asli.': '[#{n}] Not present in the original JSON.',
  '[#{n}] Tipe berubah: baris asli {orig} tapi hasil [{tag}].':
    '[#{n}] Type changed: the original line is {orig} but the result is [{tag}].',
  '[#{n}] Tiba-tiba ada nama karakter.': '[#{n}] A character name appeared out of nowhere.',
  '[#{n}] Nama karakter hilang.': '[#{n}] The character name is missing.',
  '[#{n}] Pesannya kosong.': '[#{n}] The message is empty.',
  '[#{n}] Kana residue: masih ada karakter hiragana/katakana di terjemahan.':
    '[#{n}] Kana residue: the translation still contains hiragana/katakana characters.',
  '[#{n}] Similarity: terjemahan terlalu mirip dengan teks asli ({a}% ≥ {b}%).':
    '[#{n}] Similarity: the translation is too close to the source text ({a}% ≥ {b}%).',
  '[#{n}] Untranslated Name: nama karakter JP belum diterjemahkan.':
    '[#{n}] Untranslated Name: the Japanese character name is not translated yet.',
  '[#{n}] Untranslated Name: nama masih salinan JP ({name}).':
    '[#{n}] Untranslated Name: the name is still a copy of the Japanese ({name}).',
  '[#{n}] Untranslated Name: nama masih mengandung karakter JP ({name}).':
    '[#{n}] Untranslated Name: the name still contains Japanese characters ({name}).',
  '{n} baris diterapkan.{extra}': '{n} lines applied.{extra}',
  '{n} baris sukses diterapkan.': '{n} lines applied successfully.',
  'Ringkasan cerita diperbarui!': 'Story summary updated!',
  'Undo berhasil (file).': 'Undo successful (file).',
  'Undo berhasil.': 'Undo successful.',
  'Redo berhasil (file).': 'Redo successful (file).',
  'Redo berhasil.': 'Redo successful.',
  'Gagal: Pesan terjemahan kosong.': 'Failed: the translation message is empty.',

  // ── Glossary ────────────────────────────────────────────────────────────
  'Disalin {n} baris untuk ekstraksi glossary.': 'Copied {n} lines for glossary extraction.',
  '{n} baris terjemahan dihapus.': '{n} translation lines deleted.',
  'Tidak ada terjemahan yang bisa dihapus pada baris yang dicentang.':
    'None of the checked lines has a translation to delete.',
  'Smart Glossary masih kosong.': 'The Smart Glossary is still empty.',
  'File glossary kosong atau formatnya tidak valid.': 'The glossary file is empty or malformed.',
  'Glossary file diimpor: {a} baru, {b} diperbarui.': 'Glossary file imported: {a} new, {b} updated.',
  'Gagal impor file glossary: ': 'Failed to import the glossary file: ',

  // ── File list ───────────────────────────────────────────────────────────
  'Belum ada file di proyek ini.': 'No files in this project yet.',
  'Hapus {n} file dari proyek ini? Semua baris terkait akan dihapus.':
    'Delete {n} files from this project? Every related line will be removed.',
  'Hapus File': 'Delete File',
  'Seret untuk mengubah urutan': 'Drag to reorder',
  '({n} baris / {m} terfilter)': '({n} lines / {m} filtered)',
  '({n} baris)': '({n} lines)',
  'Gagal melompat: File tidak memiliki baris atau disembunyikan oleh filter regex di menu utama.':
    'Jump failed: the file has no lines or they are hidden by the regex filter in the main menu.',

  // ── Line rendering ──────────────────────────────────────────────────────
  'Hapus bookmark': 'Remove bookmark',
  'Bookmark baris ini': 'Bookmark this line',
  'Klik untuk copy nama ke clipboard': 'Click to copy the name to the clipboard',
  'Nama "{name}" disalin.': 'Name "{name}" copied.',
  'Gagal menyalin teks.': 'Failed to copy the text.',
  'Ada {n} variasi terjemah nama. Isi untuk menyamakan semuanya.':
    'There are {n} name translation variants. Fill this in to make them all match.',
  'Terjemah nama karakter': 'Translate character names',
  'Nama "{a}" diganti menjadi "{b}".': 'Name "{a}" changed to "{b}".',
  'Terjemah nama "{name}" dikosongkan.': 'The translation of name "{name}" was cleared.',
  'Baris: {n} ({m} terfilter)': 'Lines: {n} ({m} filtered)',
  'Baris: {n}': 'Lines: {n}',
  '{v} | Mode: {mode} | File: {file} | {lines} | TL: {done}/{total} ({pct}%)':
    '{v} | Mode: {mode} | File: {file} | {lines} | TL: {done}/{total} ({pct}%)',
  'Edit Baris {n} - Select Choice {c}': 'Edit Line {n} - Select Choice {c}',
  'Edit Baris {n}': 'Edit Line {n}',

  // ── Selection / batching ────────────────────────────────────────────────
  'Tidak ada baris untuk Glossary.': 'No lines selected for Glossary.',
  'Tidak ada baris terjemahan untuk AI Check.': 'No translated lines selected for AI Check.',
  'Tidak ada baris terjemahan untuk Hapus.': 'No translated lines selected for Delete.',
  'Tidak ada baris belum diterjemahkan.': 'No untranslated lines selected.',
  'Sudah di batch terakhir.': 'Already at the last batch.',
  'Belum ada batch sebelumnya.': 'There is no previous batch yet.',
  'Sudah di batch pertama.': 'Already at the first batch.',
  'Dipilih {n} baris untuk {tab}.': 'Selected {n} lines for {tab}.',
  'Pilihan baris dibatalkan.': 'Line selection cleared.',
  'Range tidak valid.': 'Invalid range.',

  // ── Bookmarks ───────────────────────────────────────────────────────────
  'Daftar Bookmark ({n} baris tersimpan)': 'Bookmark List ({n} saved lines)',
  'Daftar Bookmark (Kosong)': 'Bookmark List (Empty)',
  'Baris {n} ditambahkan ke bookmark.': 'Line {n} added to bookmarks.',
  'Bookmark baris {n} dihapus.': 'Bookmark for line {n} removed.',
  'Gagal melompat: Baris mungkin disembunyikan oleh filter regex di menu utama.':
    'Jump failed: the line may be hidden by the regex filter in the main menu.',
  'Hapus semua {n} bookmark di proyek ini?': 'Delete all {n} bookmarks in this project?',
  'Hapus Semua Bookmark': 'Clear All Bookmarks',
  'Semua bookmark dihapus.': 'All bookmarks deleted.',
  'Tidak ada bookmark yang cocok dengan pencarian "{q}".':
    'No bookmark matches the search "{q}".',
  'Belum ada bookmark tersimpan': 'No saved bookmarks yet',
  'Arahkan kursor ke baris teks di panel Daftar Teks, lalu klik ikon bookmark':
    'Hover a text line in the Text List panel, then click the bookmark icon',
  'di pojok kanan atas baris untuk menyimpannya di sini.':
    'in the top-right corner of the row to save it here.',
  'Tidak ada bookmark yang cocok dengan pencarian "': 'No bookmark matches the search "',
  '(kosong → teks baru)': '(empty → new text)',
  'Baris {n}': 'Line {n}',
  'Lompat ke baris ini di daftar teks': 'Jump to this line in the text list',
  'Buka editor baris': 'Open the line editor',
  'Hapus dari bookmark': 'Remove from bookmarks',
  '(Belum diterjemahkan)': '(Not translated yet)',

  // ── Context menu ────────────────────────────────────────────────────────
  'Clipboard tidak dapat diakses.': 'The clipboard is not accessible.',
  'Salin Teks Dipilih': 'Copy Selected Text',
  'Salin Teks Asli': 'Copy Original Text',
  'Salin Terjemahan': 'Copy Translation',
  'Edit Baris': 'Edit Line',
  'Hapus dari Pilihan': 'Remove from Selection',
  'Pilih Baris': 'Select Line',
  'Salin': 'Copy',
  'Tempel': 'Paste',
  'Clipboard kosong atau tidak dapat diakses.': 'The clipboard is empty or inaccessible.',
  'Pilih Semua Teks': 'Select All Text',
  'Menu konteks': 'Context menu',

  // ── Import ──────────────────────────────────────────────────────────────
  'Tidak ada file .txt yang valid.': 'No valid .txt files.',
  'File skenario LucaSystem terdeteksi. Silakan tentukan game target untuk parsing perintah teks dengan akurat:':
    'LucaSystem scenario file detected. Choose the target game so text commands are parsed accurately:',
  'Slot Bahasa Ekspor': 'Export Language Slot',
  'Nama Protagonis (@nama di CLANNAD)': 'Protagonist Name (@name in CLANNAD)',
  'Format LucaSystem tidak cocok dengan tipe proyek saat ini. Buat proyek baru untuk mengimpor skenario Luca.':
    'The LucaSystem format does not match the current project type. Create a new project to import a Luca scenario.',
  'Memproses file TXT... Mohon tunggu.': 'Processing TXT files... Please wait.',
  'Berhasil impor {n} baris ({profile}).': 'Imported {n} lines ({profile}).',
  ' | Tomoyo: {n} baris masih punya byte prefix di txt (dinormalisasi saat export).':
    ' | Tomoyo: {n} lines still contain prefix bytes in the txt (normalized on export).',
  'Gagal impor: File duplikat.\n{files}': 'Import failed: duplicate files.\n{files}',
  'Tidak ada MESSAGE atau SELECT yang ditemukan dalam file TXT.':
    'No MESSAGE or SELECT entries were found in the TXT file.',
  'Terjadi kesalahan saat mengimpor TXT:\n{msg}': 'An error occurred while importing the TXT:\n{msg}',
  'Memproses file... Mohon tunggu.': 'Processing files... Please wait.',
  'Format ZIP/JSON tidak cocok dengan tipe proyek saat ini. Buat proyek JSON baru untuk mengimpor file JSON.':
    'The ZIP/JSON format does not match the current project type. Create a new JSON project to import JSON files.',
  '[Import ZIP] Gagal mem-parse file JSON: {n}': '[Import ZIP] Failed to parse JSON file: {n}',
  'Format JSON tidak cocok dengan tipe proyek saat ini. Buat proyek JSON baru untuk mengimpor JSON.':
    'The JSON format does not match the current project type. Create a new JSON project to import JSON.',
  'Format EPUB tidak cocok dengan tipe proyek saat ini. Buat proyek EPUB baru untuk mengimpor EPUB.':
    'The EPUB format does not match the current project type. Create a new EPUB project to import an EPUB.',
  'Modul pembaca ZIP EPUB belum siap. Muat ulang aplikasi lalu coba lagi.':
    'The EPUB ZIP reader is not ready yet. Reload the app and try again.',
  'Membuka EPUB: {name}…': 'Opening EPUB: {name}…',
  'File {name} bukan EPUB yang valid: META-INF/container.xml tidak ditemukan.':
    'File {name} is not a valid EPUB: META-INF/container.xml was not found.',
  'File {name} tidak memiliki OPF rootfile yang valid.':
    'File {name} has no valid OPF rootfile.',
  'Paket EPUB rusak: OPF tidak ditemukan ({path}).': 'Corrupt EPUB package: OPF not found ({path}).',
  'Jangan mencampur EPUB dan JSON dalam satu impor.':
    'Do not mix EPUB and JSON in a single import.',
  'Berhasil impor {n} baris.': 'Imported {n} lines.',
  'Gagal impor: File yang dipilih sudah ada di dalam proyek.\n\nFile duplikat:\n- {files}{more}':
    'Import failed: the selected files are already in the project.\n\nDuplicate files:\n- {files}{more}',
  '\n...dan lainnya': '\n...and more',
  'Tidak ada data valid yang diimpor.': 'No valid data was imported.',
  'Terjadi kesalahan saat mengimpor:\n{msg}': 'An error occurred while importing:\n{msg}',
  'Memproses file parser custom... Mohon tunggu.': 'Processing custom parser files... Please wait.',
  'Campur beberapa parser dalam satu impor tidak didukung. ':
    'Mixing several parsers in one import is not supported. ',
  'File "{file}" cocok dengan parser "{found}", bukan "{expected}". Impor per format.':
    'File "{file}" matches parser "{found}", not "{expected}". Import one format at a time.',
  'Tidak ada parser custom yang cocok dengan file yang dipilih.':
    'No custom parser matches the selected files.',
  'Tidak ada parser custom aktif untuk:\n- {files}': 'No active custom parser for:\n- {files}',
  'Format parser custom tidak cocok dengan tipe proyek saat ini. Buat proyek baru untuk memakai parser custom.':
    'The custom parser format does not match the current project type. Create a new project to use a custom parser.',
  'Proyek ini memakai parser "{name}". ': 'This project uses parser "{name}". ',
  'Yang dipilih: "{name}". Buat proyek baru atau impor dengan parser yang sama.':
    'Selected: "{name}". Create a new project or import with the same parser.',
  'Parser {name}: {done}/{total}{label}': 'Parser {name}: {done}/{total}{label}',
  'Berhasil impor {n} baris (parser "{name}").': 'Imported {n} lines (parser "{name}").',
  'Parser "{name}" tidak menemukan baris apa pun (message kosong semua).':
    'Parser "{name}" found no lines (every message is empty).',
  'Terjadi kesalahan saat impor parser custom:\n{msg}':
    'An error occurred while importing with the custom parser:\n{msg}',
  'Membaca folder Android ({label})… {done}/{total}': 'Reading the Android folder ({label})… {done}/{total}',
  'Tidak ada file yang cocok di folder {label}.': 'No matching files in folder {label}.',
  'Gagal membaca folder {label}: {msg}': 'Failed to read folder {label}: {msg}',

  // ── Auto translate / glossary / AI check ────────────────────────────────
  '-- Pilih profil --': '-- Select a profile --',
  'Profil "{name}" tidak ditemukan.': 'Profile "{name}" was not found.',
  'Masukkan nama profil yang ingin disimpan.': 'Enter a name for the profile you want to save.',
  'API Key belum diisi.': 'The API key is not filled in yet.',
  'Mengambil daftar model...': 'Fetching the model list...',
  'Tidak ada model yang ditemukan.': 'No models were found.',
  'Gagal: ': 'Failed: ',
  'Pengaturan API disimpan.': 'API settings saved.',
  'Format respons AI tidak sesuai.{detail}': 'The AI response format is not as expected.{detail}',
  'API Key belum diisi. Klik tombol robot di pojok kanan bawah untuk mengatur.':
    'The API key is not filled in yet. Click the robot button in the bottom-right corner to set it up.',
  'Auto Translate selesai.': 'Auto Translate finished.',
  'Semua baris target sudah diterjemahkan.': 'Every target line is already translated.',
  'Menerjemahkan {n} baris... (Klik untuk Stop)': 'Translating {n} lines... (click to stop)',
  '{label}... (Klik Stop)': '{label}... (click to stop)',
  'Respons dari API kosong.': 'The API response is empty.',
  'Gagal: {msg}. Coba lagi ke-{n} dalam {s}s... (Klik Stop)':
    'Failed: {msg}. Retry #{n} in {s}s... (click to stop)',
  'Menerjemahkan {n} baris ({p}x paralel)... (Klik untuk Stop)':
    'Translating {n} lines ({p}x parallel)... (click to stop)',
  'Paralel {i}/{total}: {label}... (Klik Stop)': 'Parallel {i}/{total}: {label}... (click to stop)',
  'Semua {n} request paralel gagal. {err}': 'All {n} parallel requests failed. {err}',
  'Paralel gagal: {msg}. Coba lagi ke-{n} dalam {s}s... (Klik Stop)':
    'Parallel request failed: {msg}. Retry #{n} in {s}s... (click to stop)',
  'Auto Translate berhenti karena error:\n\n{rest}':
    'Auto Translate stopped because of an error:\n\n{rest}',
  'Semua baris sudah diekstrak glossary-nya.': 'Every line already has its glossary extracted.',
  'Auto Glossary selesai.': 'Auto Glossary finished.',
  'Ekstrak Batch ({n} baris)... (Klik Stop)': 'Extract batch ({n} lines)... (click to stop)',
  'Auto Ekstrak berhenti karena error:\n\n{rest}':
    'Auto Extract stopped because of an error:\n\n{rest}',
  'Semua baris terjemahan sudah dicek AI.': 'Every translated line has been AI-checked.',
  'Auto AI Check selesai.': 'Auto AI Check finished.',
  'AI Check selesai.\n\nTotal dicek: {checked}\nKoreksi ditemukan: {found}\nKoreksi diterapkan: {applied}{cats}':
    'AI Check finished.\n\nTotal checked: {checked}\nCorrections found: {found}\nCorrections applied: {applied}{cats}',
  '\n\nKategori: {cats}': '\n\nCategories: {cats}',
  'Cek Batch ({n} baris)... (Klik Stop)': 'Check batch ({n} lines)... (click to stop)',
  '{label} (akurasi)... (Klik Stop)': '{label} (accuracy)... (click to stop)',
  '{label} (naturalness)... (Klik Stop)': '{label} (naturalness)... (click to stop)',
  'Review {n} koreksi... (Klik Stop untuk batalkan)':
    'Reviewing {n} corrections... (click Stop to cancel)',
  'Jalankan Auto Cek': 'Run Auto Check',
  'Auto Cek berhenti karena error:\n\n{rest}':
    'Auto Check stopped because of an error:\n\n{rest}',
  'respons AI terus kosong': 'the AI response kept coming back empty',
  'format respons AI terus tidak cocok': 'the AI response format kept not matching',
  'Gagal setelah {n} percobaan karena {reason}. {msg}':
    'Failed after {n} attempts because {reason}. {msg}',
  'respons AI kosong': 'the AI response was empty',
  'format respons AI tidak cocok': 'the AI response format did not match',

  // ── Settings ────────────────────────────────────────────────────────────
  'Ada ({n} baris)': 'Present ({n} lines)',
  'Regex Filter tidak valid: ': 'Invalid regex filter: ',

  // ── UI init / shell ─────────────────────────────────────────────────────
  'Gagal memasang plugin: {msg}': 'Failed to install the plugin: {msg}',
  'Membaca folder TL Android… {done}/{total}': 'Reading the Android TL folder… {done}/{total}',
  'Folder tidak berisi file TL .json, .epub, atau .txt.':
    'The folder contains no TL .json, .epub, or .txt files.',
  'Gagal membaca folder TL: {msg}': 'Failed to read the TL folder: {msg}',
  'Ringkasan cerita dikosongkan.': 'Story summary cleared.',
  'Kembalikan semua konfigurasi shortcut ke default?':
    'Restore every shortcut configuration to the default?',
  'Hapus semua riwayat chat untuk proyek ini?': 'Delete the whole chat history for this project?',
  'Hapus Riwayat Chat': 'Clear Chat History',
  'Belum ada memori tersimpan.': 'No memory saved yet.',
  'Key dan value tidak boleh kosong.': 'Key and value must not be empty.',
  'Browser kamu tidak mendukung Sistem File OPFS. Beberapa fitur tidak akan berjalan optimal.':
    'Your browser does not support the OPFS File System. Some features will not work optimally.',
  'Browser tidak mendukung OPFS. Sistem penyimpanan tidak dapat diakses.':
    'The browser does not support OPFS. The storage system is not accessible.',
  'Peringatan: Penyimpanan browser hampir penuh ({pct}% terpakai, sisa ~{free} MB). Harap lakukan backup proyek Anda ke .zip!':
    'Warning: browser storage is almost full ({pct}% used, ~{free} MB left). Please back your project up to .zip!',
  'Memuat runtime Python (pyodide ~10MB, sekali saja). Butuh internet...':
    'Loading the Python runtime (pyodide ~10MB, once only). Internet required...',

  // ── Reference languages (HTL) ───────────────────────────────────────────
  'File JSON harus berupa array of {name, message}.': 'The JSON file must be an array of {name, message}.',
  'File JSON kosong.': 'The JSON file is empty.',
  'Referensi bahasa tambahan hanya untuk proyek JSON VNTP.':
    'Extra language references are only for VNTP JSON projects.',
  'Impor {n} baris Referensi {slot} ({file}).': 'Imported {n} Reference {slot} lines ({file}).',
  'Gagal impor Referensi {slot}: {msg}': 'Failed to import Reference {slot}: {msg}',
  'Tidak ada file JSON dalam folder.': 'No JSON files in the folder.',
  '{file} → {target} ({n} baris)': '{file} → {target} ({n} lines)',
  'Impor {n} baris Referensi {slot} dari {files} file.':
    'Imported {n} Reference {slot} lines from {files} files.',
  'Tidak ada pasangan: {n} file': 'No match: {n} files',
  'Impor Referensi {slot} selesai:\n\n{rest}':
    'Reference {slot} import finished:\n\n{rest}',
  'Hapus data Referensi {slot} dari semua baris?': 'Clear Reference {slot} data from every line?',
  'Hapus Referensi {slot}': 'Clear Reference {slot}',
  'Referensi {slot} dihapus dari semua baris.': 'Reference {slot} cleared from every line.',
  'Membaca folder Referensi {slot}… {done}/{total}': 'Reading the Reference {slot} folder… {done}/{total}',
  'Folder tidak berisi file JSON Referensi.': 'The folder contains no reference JSON files.',
  'Gagal membaca folder Referensi {slot}: {msg}': 'Failed to read the Reference {slot} folder: {msg}',

  // ── Name translation ────────────────────────────────────────────────────
  'Disalin {n} nama untuk AI.': 'Copied {n} names for the AI.',
  'Clipboard gagal, prompt dimasukkan ke kotak paste nama.':
    'Clipboard failed; the prompt was put into the name paste box.',
  '[Baris {n}] Format harus "nama = terjemah".': '[Line {n}] The format must be "name = translation".',
  '[Baris {n}] Nama sumber tidak ada di tabel: "{name}".':
    '[Line {n}] The source name is not in the table: "{name}".',
  '[Baris {n}] Terjemah nama "{name}" kosong.': '[Line {n}] The translation of name "{name}" is empty.',
  'Teks di kotak nama kosong atau tidak valid.': 'The text in the name box is empty or invalid.',
  'TERJEMAH NAMA DITOLAK:\n\n{rest}': 'NAME TRANSLATIONS REJECTED:\n\n{rest}',
  'Tidak ada nama yang berubah.': 'No name changed.',
  'Diterapkan {n} nama ke {m} baris.': 'Applied {n} names to {m} lines.',
  'Reset semua terjemah nama karakter?\n\nIni akan mengosongkan {n} nama di {m} baris.':
    'Reset every character name translation?\n\nThis clears {n} names across {m} lines.',
  'Reset Terjemah Nama': 'Reset Name Translations',
  'Terjemah nama dikosongkan untuk {n} nama di {m} baris.':
    'Name translations cleared for {n} names across {m} lines.',

  // ── Shortcuts ───────────────────────────────────────────────────────────
  'Buat Project Baru': 'Create New Project',
  'Buka Default Pengaturan': 'Open Settings Defaults',
  'Ekspor Terjemahan': 'Export Translation',
  'Buka Cari & Ganti': 'Open Find & Replace',
  'Buka Tab Glossary': 'Open the Glossary Tab',
  'Buka Tab AI Check': 'Open the AI Check Tab',
  'Buka Plugin & Parser Manager': 'Open the Plugin & Parser Manager',
  'Buka Pengaturan Project': 'Open Project Settings',
  'Buka Daftar Bookmark': 'Open the Bookmark List',
  'Buka Mode Immersif': 'Open Immersive Mode',
  'Pilih Semua Baris': 'Select All Lines',
  'Batal Pilih Baris': 'Clear Line Selection',
  'Pilih Rentang Baris': 'Select a Line Range',
  'Copy untuk AI': 'Copy for the AI',
  'Fokus Kolom Paste AI': 'Focus the AI Paste Box',
  'Terapkan Terjemahan': 'Apply Translation',
  'Undo Terjemahan': 'Undo Translation',
  'Redo Terjemahan': 'Redo Translation',
  'Tekan tombol…': 'Press the keys…',
  '"{combo}" sudah digunakan untuk: {label}': '"{combo}" is already used for: {label}',
  'Tidak diatur': 'Not set',
  'Klik lalu tekan kombinasi tombol (Backspace menghapus, Escape batal)':
    'Click, then press the key combination (Backspace clears, Escape cancels)',

  // ── OPFS explorer ───────────────────────────────────────────────────────
  'Folder ini kosong.': 'This folder is empty.',
  'Folder tidak ditemukan. Kembali ke root OPFS.': 'Folder not found. Returning to the OPFS root.',
  'Gagal memuat daftar file: {msg}': 'Failed to load the file list: {msg}',
  'Buka folder': 'Open folder',
  'Hapus file/folder': 'Delete file/folder',
  'Gagal mengunduh "{name}": {msg}': 'Failed to download "{name}": {msg}',
  'Hapus "{name}" dari OPFS?\n\nPermanen, tidak bisa dibatalkan.':
    'Delete "{name}" from OPFS?\n\nPermanent, cannot be undone.',
  'Hapus File OPFS': 'Delete OPFS File',
  'Gagal menghapus "{name}": {msg}': 'Failed to delete "{name}": {msg}',
  'Gagal Menghapus': 'Delete Failed',

  // ── Folder backup / restore ─────────────────────────────────────────────
  'Folder Backup hanya tersedia di Chrome/Edge desktop. Di perangkat lain, pakai Backup Semua ZIP.':
    'Folder Backup is only available in desktop Chrome/Edge. On other devices, use Backup All ZIP.',
  'Folder Backup hanya tersedia di Chrome/Edge desktop. Di perangkat lain, pakai tombol Pulihkan Proyek.':
    'Folder Backup is only available in desktop Chrome/Edge. On other devices, use the Restore Project button.',
  'Folder Backup: {n} proyek tersimpan{suffix}': 'Folder Backup: {n} projects saved{suffix}',
  'Tidak ada file backup (.copas / .cstl) di folder backup.':
    'No backup files (.copas / .cstl) in the backup folder.',
  'Tidak dapat membaca folder backup. Pilih folder lagi lalu coba ulangi.\n\n{msg}':
    'Cannot read the backup folder. Pick the folder again and retry.\n\n{msg}',
  'Mencadangkan ke folder Android… {i}/{total}': 'Backing up to the Android folder… {i}/{total}',
  'Tidak ada file backup (.copas / .cstl) di folder yang dipilih.':
    'No backup files (.copas / .cstl) in the selected folder.',
  'Pulihkan dari Folder Backup': 'Restore from Backup Folder',
  '✓ Selesai': '✓ Done',

  // ── Spreadsheet ─────────────────────────────────────────────────────────
  'Tidak ada proyek yang sedang dibuka.': 'No project is open.',
  'Gagal mengekspor ke spreadsheet: ': 'Failed to export to the spreadsheet: ',
  'Sheet Lines kosong.': 'The Lines sheet is empty.',
  'Kolom "message" tidak ditemukan, tidak ada baris yang diimpor.':
    'The "message" column was not found, so no lines were imported.',
  'Baris {n}: kolom extra bukan JSON valid, diabaikan.':
    'Row {n}: the extra column is not valid JSON and was ignored.',
  'Spreadsheet ini tidak punya sheet "{sheet}" (atau sheet mana pun dengan kolom "message"). ':
    'This spreadsheet has no "{sheet}" sheet (or any sheet with a "message" column). ',
  'Pastikan file diekspor dari CopasTool, atau tambahkan header kolom yang benar.':
    'Make sure the file was exported from CopasTool, or add the correct column headers.',
  'Sheet Info tidak ditemukan, pengaturan proyek memakai default.':
    'The Info sheet was not found, so project settings use the defaults.',
  '{n} baris, {m} entri glossary.': '{n} lines, {m} glossary entries.',
  '{summary}\n\nImpor sebagai proyek baru?': '{summary}\n\nImport as a new project?',
  'Buat Proyek Baru': 'Create New Project',
  '{summary}\n\nProyek "{name}" sedang terbuka.\n': '{summary}\n\nThe project "{name}" is open.\n',
  'Gabungkan terjemahan + glossary dari spreadsheet ke proyek ini?\n\n':
    'Merge the translations + glossary from the spreadsheet into this project?\n\n',
  '(Terjemahan dicocokkan per line_num + file. Baris baru ditambahkan. Teks asli tidak diubah.)':
    '(Translations are matched by line_num + file. New lines are appended. Original text is untouched.)',
  'Gabung ke Proyek Ini': 'Merge into This Project',
  'Buat proyek BARU dari spreadsheet ini? Proyek yang sedang terbuka tidak akan diubah.':
    'Create a NEW project from this spreadsheet? The open project will not be changed.',
  'Spreadsheet tidak memuat baris yang bisa diimpor. Cek sheet Lines dan kolom "message".':
    'The spreadsheet has no importable lines. Check the Lines sheet and the "message" column.',
  'Terjemahan diperbarui: {n}\n': 'Translations updated: {n}\n',
  'Baris baru: {n}\n': 'New lines: {n}\n',
  'Glossary baru: {n}': 'New glossary entries: {n}',
  'Proyek "{name}" dibuat dari spreadsheet.\n\n': 'Project "{name}" created from the spreadsheet.\n\n',
  '\n\nCatatan: {n} peringatan saat impor.': '\n\nNote: {n} warnings during import.',
  'Gagal mengimpor spreadsheet: ': 'Failed to import the spreadsheet: ',

  // ── Proofread ───────────────────────────────────────────────────────────
  'Tidak ada hasil pencarian.': 'No search results.',
  'Ditemukan {n} baris.': 'Found {n} lines.',
  'Ditemukan {n} baris (semua {n} baris dikecualikan dari Replace All).':
    'Found {n} lines (all {n} lines are excluded from Replace All).',
  'Ditemukan {n} baris ({ex} dikecualikan, {active} akan di-replace).':
    'Found {n} lines ({ex} excluded, {active} will be replaced).',
  'Sertakan kembali ke Replace All (Include)': 'Include again in Replace All',
  'Kecualikan dari Replace All (Exclude)': 'Exclude from Replace All',
  'Semua baris disertakan kembali.': 'All lines included again.',
  'Semua baris dikecualikan.': 'All lines excluded.',
  'Pola Regex tidak valid.': 'Invalid regex pattern.',
  'File: {file} | Baris: {n}': 'File: {file} | Line: {n}',
  'Gagal melompat: Baris mungkin disembunyikan oleh filter di menu utama.':
    'Jump failed: the line may be hidden by the filter in the main menu.',
  'Pencarian masih kosong.': 'The search is still empty.',
  'Semua baris yang cocok sedang dikecualikan. Sertakan minimal 1 baris untuk melakukan Replace All.':
    'All matching lines are excluded. Include at least 1 line to run Replace All.',
  'Format Regex tidak valid.': 'Invalid regex format.',
  'Replace All diterapkan pada {n} baris teks ({ex} baris dikecualikan/dilewati).':
    'Replace All applied to {n} text lines ({ex} lines excluded/skipped).',
  'Replace All diterapkan pada {n} baris teks.': 'Replace All applied to {n} text lines.',
  'Tidak ada kata yang cocok dengan pencarian.': 'No word matches the search.',

  // ── QA ──────────────────────────────────────────────────────────────────
  'Status: Sedang memeriksa...': 'Status: Checking...',
  'Sim: Nama ({pct}%)': 'Sim: Name ({pct}%)',
  'Selesai. {n} pelanggaran pada {m} baris ({parts}).': 'Done. {n} violations across {m} lines ({parts}).',
  ' (Baris {n})': ' (Line {n})',

  // ── Dictionary ──────────────────────────────────────────────────────────
  'Gagal memuat riwayat kamus:': 'Failed to load the dictionary history:',
  'Gagal menyimpan riwayat kamus:': 'Failed to save the dictionary history:',
  'Yakin ingin menghapus semua riwayat kamus?': 'Delete the whole dictionary history?',
  'Hapus Riwayat Kamus': 'Clear Dictionary History',
  'Belum ada kata yang dicari.': 'No word has been looked up yet.',
  'Memuat penjelasan...': 'Loading the definition...',
  'Gagal memuat: {msg}': 'Failed to load: {msg}',
  'Semua proxy Jisho gagal. Silakan gunakan mode AI/LLM atau coba lagi nanti.':
    'Every Jisho proxy failed. Use the AI/LLM mode or try again later.',
  'Kata tidak ditemukan di Jisho.': 'Word not found on Jisho.',
  'Kata tidak ditemukan di kamus Inggris.': 'Word not found in the English dictionary.',

  // ── Live translator / TL mode ───────────────────────────────────────────
  'API Key CopasTool belum diatur. Buka Pengaturan API di CopasTool.':
    'The CopasTool API key is not set. Open API Settings in CopasTool.',
  'Menerjemahkan baris #{n} via Auto Copas...': 'Translating line #{n} via Auto Copas...',
  'Menerjemahkan baris #{n} via AI...': 'Translating line #{n} via AI...',
  'Respons dari situs AI kosong': 'The response from the AI site is empty',
  'Respons API kosong': 'The API response is empty',
  'Respons AI tidak bisa diurai sebagai terjemahan (format tidak dikenali).':
    'The AI response could not be parsed as a translation (unrecognized format).',
  '{n} baris tidak ada di respons, dilewati.': '{n} lines are missing from the response and were skipped.',
  'Baris aktif tidak ada di respons batch (baris lain tersimpan).':
    'The active line is missing from the batch response (the other lines were saved).',
  'Auto Copas hanya tersedia di aplikasi native (Windows atau Android).':
    'Auto Copas is only available in the native app (Windows or Android).',
  'Auto Copas sedang dipakai proses {name}. Hentikan dulu sebelum memakai TL Mode.':
    'Auto Copas is busy with {name}. Stop it before using TL Mode.',
  'Respons AI tidak memuat teks terjemahan.': 'The AI response contains no translation text.',

  // ── Increment ───────────────────────────────────────────────────────────
  ' Semua baris sudah tercakup.': ' Every line is already covered.',
  ' Auto-increment: Baris {a}–{b} terpilih.': ' Auto-increment: lines {a}–{b} selected.',

  // ── Downloads / native save ─────────────────────────────────────────────
  'Disimpan ke folder Download: {name}': 'Saved to the Download folder: {name}',
  'Gagal mendownload file: ': 'Failed to download the file: ',
  'Pilih folder simpan backup & export': 'Choose the backup & export save folder',
  'Native bridge tidak tersedia.': 'The native bridge is not available.',

  // ── EPUB ruby ───────────────────────────────────────────────────────────
  'Fitur ini hanya tersedia untuk proyek EPUB.': 'This feature is only available for EPUB projects.',
  'Membaca ruby text dari EPUB...': 'Reading ruby text from the EPUB...',
  'Tidak ada kandidat ruby name yang ditemukan.': 'No ruby name candidates were found.',
  'Gagal extract ruby EPUB: {msg}': 'Failed to extract EPUB ruby: {msg}',

  // ── VNDB / AniList ──────────────────────────────────────────────────────
  'VNDB mengembalikan terlalu banyak halaman.': 'VNDB returned too many pages.',
  'AniList query gagal.': 'The AniList query failed.',
  'Masukkan VNDB ID/URL yang valid, contoh: v17.': 'Enter a valid VNDB ID/URL, for example: v17.',
  'Mengambil nama karakter dari VNDB {id}...': 'Fetching character names from VNDB {id}...',
  '{n} nama langsung diterapkan ke {m} baris': '{n} names applied directly to {m} lines',
  '{a} glossary baru, {b} diperbarui': '{a} new glossary entries, {b} updated',
  'Tidak ada nama yang bisa diimpor dari VNDB.': 'No names can be imported from VNDB.',
  'Import selesai dari {n} karakter: {parts}.': 'Import finished from {n} characters: {parts}.',
  'Gagal import VNDB: {msg}': 'VNDB import failed: {msg}',
  'Masukkan link lengkap AniList manga/novel atau ID angka.':
    'Enter the full AniList manga/novel link or a numeric ID.',
  'Judul tidak ditemukan di AniList.': 'Title not found on AniList.',
  'AniList mengembalikan terlalu banyak halaman.': 'AniList returned too many pages.',
  'Mengambil nama karakter dari AniList...': 'Fetching character names from AniList...',
  'Tidak ada nama Jepang yang bisa diimpor dari {title}.':
    'No Japanese names can be imported from {title}.',
  'Import selesai dari {title}: {a} baru, {b} diperbarui.':
    'Import finished from {title}: {a} new, {b} updated.',
  'Gagal import AniList: {msg}': 'AniList import failed: {msg}',

  // ── Luna hooker / overlay ───────────────────────────────────────────────
  'Menerjemahkan dialog lewat {label} di browser otomatis (login sekali via Buka Browser)':
    'Translating dialogue through {label} in the automated browser (log in once via Open Browser)',
  '{model}: dipakai untuk menerjemahkan dialog mentah':
    '{model}: used to translate raw dialogue',
  'API Key belum diisi': 'The API key is not filled in yet',
  'Isi API Key di Setting → API Global, atau pilih mesin Copas di TL Mode':
    'Fill in the API key in Settings → Global API, or pick the Copas engine in TL Mode',
  'Buka Overlay': 'Open Overlay',
  'Diagnosa hanya di aplikasi native Windows.': 'Diagnostics only work in the native Windows app.',
  'Overlay belum dibuka.': 'The overlay is not open yet.',
  'TIDAK': 'NO',
  'Interaktif: overlay tutup': 'Interactive: overlay closed',
  'Buka overlay dulu': 'Open the overlay first',
  'Overlay menerima klik, matikan agar klik masuk ke game':
    'The overlay captures clicks; turn it off so clicks reach the game',
  'Klik-tembus, nyalakan untuk menggeser / tekan tombol':
    'Click-through; turn it on to drag / press the buttons',
  'Batch 1: hanya baris aktif yang diterjemahkan.': 'Batch 1: only the active line is translated.',
  'Batch {n}: baris aktif + {m} baris berikutnya diterjemahkan sekaligus, ':
    'Batch {n}: the active line + {m} following lines are translated at once, ',
  'jadi dialog selanjutnya sudah siap saat hook sampai ke sana.':
    'so the next dialogue is ready when the hook reaches it.',
  'Buka / Toggle Overlay': 'Open / Toggle Overlay',
  'Gagal inisialisasi WebSocket: {msg}': 'WebSocket initialization failed: {msg}',
  'Gagal terhubung ke ws://{host}:{port}': 'Failed to connect to ws://{host}:{port}',
  'Terputus dari LunaTranslator. Menjadwalkan koneksi ulang...':
    'Disconnected from LunaTranslator. Scheduling a reconnect...',
  'TL Mode: baris mentah diterjemahkan otomatis via API':
    'TL Mode: raw lines are translated automatically via the API',
  'Check Mode: cek sinkronisasi/QA dialog': 'Check Mode: check dialogue sync/QA',
  'Cocok lewat teks terjemahan': 'Matched through the translated text',
  'Menerjemahkan…': 'Translating…',
  'Belum diterjemahkan': 'Not translated yet',
  'Hapus tanda': 'Remove the mark',
  'Tandai baris ini': 'Mark this line',
  'Interaktif: klik & geser aktif': 'Interactive: click & drag active',
  'Klik-tembus: klik masuk ke game': 'Click-through: clicks reach the game',
  'Belum ada proyek': 'No project yet',
  'Tidak ada proyek terbuka': 'No project is open',
  'Proyek kosong di CopasTool': 'The project is empty in CopasTool',
  'Terjemahan': 'Translation',
  'TL Mode: Menyiapkan terjemahan #{n}{note}...': 'TL Mode: preparing the translation of #{n}{note}...',
  'TL selesai #{n} ({engine})': 'TL done #{n} ({engine})',
  'Gagal TL: {msg}': 'TL failed: {msg}',
  'Teks tidak ditemukan di proyek': 'Text not found in the project',

  // ── Immersive ───────────────────────────────────────────────────────────
  'Teks Asli (klik untuk terjemahan)': 'Original Text (click for the translation)',
  'Tidak ada baris untuk ditampilkan.': 'No lines to display.',
  'Baris mungkin disembunyikan oleh filter.': 'The line may be hidden by the filter.',

  // ── XLSX ────────────────────────────────────────────────────────────────
  'Workbook kosong.': 'The workbook is empty.',
  'File bukan spreadsheet XLSX yang valid (workbook.xml tidak ditemukan).':
    'The file is not a valid XLSX spreadsheet (workbook.xml was not found).',
  'Spreadsheet tidak memuat sheet apa pun.': 'The spreadsheet contains no sheet.',
  'Spreadsheet tidak dikenali.': 'Unrecognized spreadsheet.',

  // ── Semi-auto Copas ─────────────────────────────────────────────────────
  'Tutup Bubble': 'Close Bubble',
  'Tutup bubble mengambang di layar': 'Close the floating bubble on screen',
  'Clipboard kosong (salin jawaban AI dulu)': 'The clipboard is empty (copy the AI reply first)',
  'Teks di clipboard masih prompt CopasTool': 'The clipboard still holds the CopasTool prompt',
  'Teks terjemahan sudah pernah diterapkan sebelumnya':
    'This translation text has already been applied before',
  'Format payload terjemahan tidak ditemukan': 'The translation payload format was not found',
  'Gagal membaca format terjemahan': 'Failed to read the translation format',
  'Tidak ditemukan baris terjemahan bernomor': 'No numbered translation lines were found',
  'Baris #{n} bukan bagian dari batch yang ditunggu': 'Line #{n} is not part of the expected batch',
  'Jumlah baris hasil terjemahan tidak cocok dengan batch aktif':
    'The number of translated lines does not match the active batch',
  'Bukan hasil terjemahan AI': 'Not an AI translation result',
  'Menerapkan hasil AI untuk {n} baris...': 'Applying the AI result for {n} lines...',
  'Gagal menerapkan: {msg}': 'Failed to apply: {msg}',
  '{n} baris diterapkan': '{n} lines applied',
  'Semua baris sudah diterjemahkan.': 'Every line is already translated.',
  'Semua baris selesai diterjemahkan. Semi Auto berhenti.':
    'Every line is translated. Semi Auto stopped.',
  'Gagal membuat prompt batch berikutnya.': 'Failed to build the next batch prompt.',
  'Batch ({n} baris: {range}) siap. Paste di AI chat, lalu salin balasannya.':
    'Batch ({n} lines: {range}) is ready. Paste it into the AI chat, then copy the reply.',
  'Buka atau muat proyek terlebih dahulu.': 'Open or load a project first.',
  'Gagal membuat prompt terjemahan.': 'Failed to build the translation prompt.',
  'Prompt {range} disalin. Paste di AI chat, lalu salin balasannya.':
    'Prompt {range} copied. Paste it into the AI chat, then copy the reply.',
  'Aktifkan Bubble mengambang untuk 1-tap copas': 'Enable the floating Bubble for one-tap copas',
  'Bubble hanya tersedia di Android.': 'The Bubble is only available on Android.',
  'Aktifkan izin "Tampil di atas aplikasi lain" untuk CopasTool.':
    'Grant the "Display over other apps" permission to CopasTool.',

  // ── Import translated ───────────────────────────────────────────────────
  'JSZip tidak tersedia untuk membaca EPUB.': 'JSZip is unavailable for reading the EPUB.',
  'Impor file sumber dulu sebelum impor hasil terjemahan.':
    'Import the source files before importing the translation results.',
  'Memproses file terjemahan... Mohon tunggu.': 'Processing the translation files... Please wait.',
  'JSZip tidak tersedia untuk membaca ZIP.': 'JSZip is unavailable for reading the ZIP.',
  '{name}: jumlah baris {a}/{b}.': '{name}: line count {a}/{b}.',
  '{name}: {n} baris TXT tidak cocok dengan proyek.': '{name}: {n} TXT lines do not match the project.',
  '{name}: nama file ambigu, dilewati.': '{name}: ambiguous file name, skipped.',
  '{name}: target file sudah diimpor dari file lain, dilewati.':
    '{name}: the target file was already imported from another file, skipped.',
  '{name}: hanya bisa diimpor ke proyek TXT LucaSystem.':
    '{name}: can only be imported into a LucaSystem TXT project.',
  '{name}: tidak cocok dengan file proyek, dilewati.':
    '{name}: does not match any project file, skipped.',
  '{name}: {n} file EPUB proyek tidak ditemukan di EPUB terjemahan.':
    '{name}: {n} project EPUB files were not found in the translated EPUB.',
  '{name}: hanya bisa diimpor ke proyek EPUB.': '{name}: can only be imported into an EPUB project.',
  'Tidak ada baris terjemahan yang bisa diimpor.': 'No translation lines can be imported.',
  'Impor TL tidak menerapkan perubahan:\n\n{rest}':
    'The TL import applied no changes:\n\n{rest}',
  'Berhasil impor {n} baris TL dari {m} file.': 'Imported {n} TL lines from {m} files.',
  ' Ada {n} catatan.': ' There are {n} notes.',
  'Catatan impor TL:\n\n{rest}': 'TL import notes:\n\n{rest}',
  '\n...dan {n} lainnya.': '\n...and {n} more.',

  // ── AI Check ────────────────────────────────────────────────────────────
  'Tidak ada baris terjemahan yang dipilih.': 'No translated lines are selected.',
  'Disalin {n} baris untuk AI Check.': 'Copied {n} lines for AI Check.',
  'Clipboard gagal, prompt dimasukkan ke kotak paste.':
    'Clipboard failed; the prompt was put into the paste box.',
  'Tidak ada blok [line N] yang valid.': 'No valid [line N] block.',
  'Respons JSON kosong.': 'The JSON response is empty.',
  'Respons bukan JSON yang valid.': 'The response is not valid JSON.',
  'JSON tidak berisi array "corrections".': 'The JSON contains no "corrections" array.',
  'Rewrite besar (~{pct}% teks berubah), perlu review manual':
    'Large rewrite (~{pct}% of the text changed), needs manual review',
  '[#{n}] Tidak ada di proyek.': '[#{n}] Not in the project.',
  '[#{n}] Tidak termasuk baris terjemahan yang dipilih.':
    '[#{n}] Not one of the selected translated lines.',
  '[#{n}] Baris belum diterjemahkan.': '[#{n}] The line is not translated yet.',
  '[#{n}] Reason kosong.': '[#{n}] The reason is empty.',
  '[#{n}] Text koreksi kosong.': '[#{n}] The correction text is empty.',
  ', {n} perlu review': ', {n} need review',
  'Gagal parse AI Check:\n\n{rest}': 'Failed to parse AI Check:\n\n{rest}',
  'AI CHECK DITOLAK:\n\n{rest}': 'AI CHECK REJECTED:\n\n{rest}',
  'Confidence dari AI: high = aman auto-apply, low = mungkin tidak perlu diubah':
    'AI confidence: high = safe to auto-apply, low = may not need changing',
  'Perlu review manual': 'Needs manual review',

  // ── AI response format parsing ──────────────────────────────────────────
  'XML tidak valid: ': 'Invalid XML: ',
  'Tidak ada elemen <line> yang valid di XML.': 'No valid <line> element in the XML.',
  'Elemen <line> tanpa atribut num yang valid.': 'A <line> element has no valid num attribute.',
  '[#{n}] Tidak ada elemen <text>.': '[#{n}] No <text> element.',
  'Baris {n}: Format array tidak valid.': 'Line {n}: invalid array format.',
  'Baris {n}: Gagal parse JSON ({msg}).': 'Line {n}: failed to parse JSON ({msg}).',
  '[Baris {n}] JSON tidak valid: "{text}"': '[Line {n}] Invalid JSON: "{text}"',
  '[Baris {n}] Field "num" tidak ada atau bukan angka.':
    '[Line {n}] The "num" field is missing or not a number.',
  '[Baris {n} / #{num}] Field "text" tidak ada.': '[Line {n} / #{num}] The "text" field is missing.',
  'Baris tanpa header [line N]: "{text}"': 'Line without a [line N] header: "{text}"',
  'Format field rusak pada line {n}: "{text}"': 'Broken field format on line {n}: "{text}"',
  '[Baris {n}] Format rusak (Harus "Angka. Teks") -> "{text}..."':
    '[Line {n}] Broken format (must be "Number. Text") -> "{text}..."',

  // ── Auto Copas engine ───────────────────────────────────────────────────
  'Membuka browser otomatis…': 'Opening the automated browser…',
  'Gagal membuka browser: {msg}': 'Failed to open the browser: {msg}',
  'Masih ada proses Auto Copas lain yang berjalan. Selesaikan atau batalkan dulu.':
    'Another Auto Copas process is still running. Finish or cancel it first.',
  'Auto Copas selesai: semua baris sudah diterjemahkan.':
    'Auto Copas finished: every line is translated.',
  'Selesai: {n} baris diterapkan.': 'Done: {n} lines applied.',
  'Gagal menyusun prompt (pilih baris dulu).': 'Failed to build the prompt (select lines first).',
  'Batch gagal ({detail}). Coba lagi ke-{n} dalam {s}s…':
    'Batch failed ({detail}). Retry #{n} in {s}s…',
  'Auto Copas Glossary selesai.': 'Auto Copas Glossary finished.',
  'Membuka chat baru di {label}…': 'Opening a new chat in {label}…',
  'Thinking: {detail}': 'Thinking: {detail}',
  'Thinking: gagal diterapkan': 'Thinking: failed to apply',
  'Clipboard tidak bisa ditulis.': 'The clipboard cannot be written.',
  'Fokus ke kolom chat {label}…': 'Focusing the {label} chat box…',
  'Kolom chat {label} tidak ditemukan, buka halaman chat & login dulu.':
    'The {label} chat box was not found; open the chat page and log in first.',
  'Prompt tidak masuk ke kolom chat {label}.': 'The prompt did not reach the {label} chat box.',
  'Mengirim prompt ke {label}…': 'Sending the prompt to {label}…',
  'Enter tidak mengirim, klik tombol kirim…': 'Enter did not send; clicking the send button…',
  'Prompt tidak terkirim ke {label}.': 'The prompt was not sent to {label}.',
  'Respons {label} tidak selesai dalam {s}s.': 'The {label} response did not finish within {s}s.',
  'Teks respons {label} tidak terdeteksi: selector pesan situs mungkin berubah. ':
    'The {label} response text was not detected: the site message selector may have changed. ',
  'Coba buka halaman chat, pastikan respons benar-benar muncul, lalu jalankan ulang.':
    'Try opening the chat page, make sure the response really appears, then run it again.',
  'Menyalin respons dari {label}…': 'Copying the response from {label}…',
  'Clipboard tidak bisa ditulis (sentinel).': 'The clipboard cannot be written (sentinel).',
  'Tidak ada tombol Copy di {label}, membaca dari halaman…':
    'No Copy button in {label}; reading from the page…',
  'Menunggu clipboard dari {label} ({i}/{n})…': 'Waiting for the clipboard from {label} ({i}/{n})…',
  'Clipboard kosong, teks respons dibaca langsung dari halaman.':
    'The clipboard is empty; the response text was read straight from the page.',
  'Tombol Copy/Salin {label} tidak menghasilkan teks.': 'The {label} Copy button produced no text.',
  'Respons {label} kosong (kemungkinan diblokir filter).':
    'The {label} response is empty (likely blocked by a filter).',
  'camofox tidak bisa dihubungi.': 'camofox cannot be reached.',
  'Camoufox gagal dijalankan.': 'Camoufox failed to start.',
  'Camoufox tidak siap dalam batas waktu (unduhan pertama mungkin lambat). Coba lagi.':
    'Camoufox was not ready in time (the first download can be slow). Try again.',
  'Tidak bisa membuka tab {label} di browser otomatis.':
    'Cannot open the {label} tab in the automated browser.',
  'Tab {label} belum dibuka.': 'The {label} tab is not open yet.',
  'Tab browser otomatis belum dibuka.': 'The automated browser tab is not open yet.',
  'Versi APK ini belum mendukung Auto Copas. Update aplikasi dulu.':
    'This APK version does not support Auto Copas yet. Update the app first.',
  'Perintah {name} tidak selesai dalam {s}s.': 'The {name} command did not finish within {s}s.',
  '{name} gagal.': '{name} failed.',

  // ── Game engine modal ───────────────────────────────────────────────────
  'Izinkan akses semua file, lalu pilih folder game lagi.':
    'Allow access to all files, then pick the game folder again.',
  'Folder ini tidak bisa dipetakan ke path. Pilih folder di penyimpanan internal atau kartu SD.':
    'This folder cannot be mapped to a path. Pick a folder on internal storage or the SD card.',
  'Folder Android dipilih, tetapi pemindaian SAF belum tersedia.':
    'An Android folder was picked, but SAF scanning is not available yet.',
  'Gagal memilih folder game: ': 'Failed to pick the game folder: ',
  'Pilih folder game terlebih dahulu.': 'Pick a game folder first.',
  'Daftar arsip dan folder skenario diperbarui.': 'The archive and scenario folder list was refreshed.',
  'Memindai folder game dan mendeteksi engine...': 'Scanning the game folder and detecting the engine...',
  'Salin volume patch ke folder game': 'Copy the patch volume into the game folder',
  'Pasang {name} ke folder game': 'Install {name} into the game folder',
  'Tidak ada berkas .exe otomatis terdeteksi': 'No .exe file was detected automatically',
  'Pilih executable game lewat tombol "Pilih Manual (.exe)".':
    'Pick the game executable with the "Select Manually (.exe)" button.',
  'Folder Skenario': 'Scenario Folder',
  'Tidak ada arsip atau folder skenario yang terdeteksi':
    'No scenario archive or folder was detected',
  'Pilihan Kustom': 'Custom Selection',
  'Gagal memilih file executable: ': 'Failed to pick the executable file: ',
  'Pilih berkas executable (.exe) game di Tab 1.': 'Pick the game executable (.exe) in Tab 1.',
  'Gagal menjalankan game: ': 'Failed to launch the game: ',
  'Folder Kustom: {name}': 'Custom folder: {name}',
  'Folder terpilih: {name}': 'Selected folder: {name}',
  'Gagal memilih folder: ': 'Failed to pick the folder: ',
  'Gagal memilih arsip: ': 'Failed to pick the archive: ',
  'Folder cache belum ditentukan.': 'The cache folder is not set yet.',
  'Gagal membuka folder cache: ': 'Failed to open the cache folder: ',
  'Skenario belum diekstrak. Lakukan ekstraksi di Tab 2.':
    'The scenario has not been extracted yet. Extract it in Tab 2.',
  'Gagal membuka folder staging: ': 'Failed to open the staging folder: ',
  'Pilih folder game terlebih dahulu di Tab 1.': 'Pick the game folder in Tab 1 first.',
  'Memuat baris dialog ke editor...': 'Loading dialogue lines into the editor...',
  '{n} baris skenario dimuat ke CopasTool.': '{n} scenario lines loaded into CopasTool.',
  'Belum ada skenario yang dimuat di CopasTool. Lakukan ekstraksi terlebih dahulu di Tab 2.':
    'No scenario is loaded in CopasTool yet. Extract it in Tab 2 first.',

  // ── Plugin manager / consent ────────────────────────────────────────────
  'Sumber paket tidak valid.': 'Invalid package source.',
  'File .zip tidak valid atau rusak.': 'The .zip file is invalid or corrupt.',
  'File tidak ditemukan di paket plugin.': 'File not found in the plugin package.',
  'Metode kompresi {m} tidak didukung untuk "{name}".':
    'Compression method {m} is not supported for "{name}".',
  'Paket rusak: header lokal "{name}" tidak valid.': 'Corrupt package: invalid local header "{name}".',
  'Paket rusak: ukuran "{name}" tidak cocok.': 'Corrupt package: size mismatch for "{name}".',
  'Baris teks dan terjemahan project.': 'The project text and translation lines.',
  'Ubah seleksi': 'Change the selection',
  'Memilih baris dan memicu copy.': 'Select lines and trigger a copy.',
  'Pilih file': 'Pick files',
  'Membaca file yang kamu pilih.': 'Read the files you pick.',
  'Menyimpan file ke perangkat.': 'Save files to the device.',
  'Menyimpan data plugin per project.': 'Store plugin data per project.',
  'Menjalankan modul WASM dari paket.': 'Run a WASM module from the package.',
  'Memuat pustaka ZIP di sandbox.': 'Load a ZIP library in the sandbox.',
  'CSS tema tampilan.': 'Display theme CSS.',
  'Mengirim permintaan HTTP/HTTPS ke server mana pun.': 'Send HTTP/HTTPS requests to any server.',
  'Membaca dan mengubah teks copy/paste.': 'Read and change copy/paste text.',
  'manifest.json bukan JSON yang valid: {msg}': 'manifest.json is not valid JSON: {msg}',
  'manifest.json harus berisi objek JSON ( { ... } ).': 'manifest.json must contain a JSON object ( { ... } ).',
  'manifest harus objek.': 'manifest must be an object.',
  '"manifest_version" atau "manifestVersion" wajib diisi (gunakan 1).':
    '"manifest_version" or "manifestVersion" is required (use 1).',
  '"manifest_version" harus bilangan bulat positif.': '"manifest_version" must be a positive integer.',
  '"manifest_version" {v} lebih baru dari versi yang didukung ({max}).':
    '"manifest_version" {v} is newer than the supported version ({max}).',
  '"api" tidak valid, ditemukan {found}; versi API aplikasi ini {expected}.':
    'Invalid "api": found {found}, but this app uses API version {expected}.',
  '"permissions" harus array string.': '"permissions" must be an array of strings.',
  'Izin tidak dikenal: {found}. Izin yang valid: {valid}.':
    'Unknown permission: {found}. Valid permissions: {valid}.',
  '"extensions" harus array string.': '"extensions" must be an array of strings.',
  'Ekstensi tidak valid: {value}; harus diawali titik lalu 1-16 karakter alfanumerik (contoh: ".ks").':
    'Invalid extension: {value}; it must start with a dot followed by 1-16 alphanumeric characters (e.g. ".ks").',
  'Ekstensi {ext} adalah format bawaan CSTL dan tidak boleh diklaim plugin.':
    'The extension {ext} is a built-in CSTL format and cannot be claimed by a plugin.',
  '"magic" harus array objek.': '"magic" must be an array of objects.',
  '"ui" harus objek { title?, height? }.': '"ui" must be an object { title?, height? }.',
  'ui.title harus string 1-200 karakter.': 'ui.title must be a string of 1-200 characters.',
  'ui.height harus angka 60-2000 (piksel).': 'ui.height must be a number from 60-2000 (pixels).',
  'harus objek { hex } atau { text }, plus offset opsional.':
    'must be an object { hex } or { text }, plus an optional offset.',
  'harus punya hex ATAU text (tidak keduanya).': 'must have hex OR text (not both).',
  'hex harus string.': 'hex must be a string.',
  'hex harus heksadesimal genap, maks 128 byte (contoh: "504b0304").':
    'hex must be even-length hexadecimal, at most 128 bytes (e.g. "504b0304").',
  'text harus string tidak kosong.': 'text must be a non-empty string.',
  'offset harus bilangan bulat 0-8192.': 'offset must be an integer from 0-8192.',
  '"settings" harus objek { global?, project?, shared? }.':
    '"settings" must be an object { global?, project?, shared? }.',
  'Kunci "settings.{key}" tidak dikenal; hanya "global", "project", dan "shared".':
    'Unknown "settings.{key}" key; only "global", "project", and "shared" are allowed.',
  '"settings.{scope}" harus array.': '"settings.{scope}" must be an array.',
  'Kunci "{key}" dipakai di lebih dari satu scope ("{a}" dan "{b}").':
    'The key "{key}" is used in more than one scope ("{a}" and "{b}").',
  'Total entri settings maksimal 128.': 'At most 128 settings entries in total.',
  '{at}: harus objek.': '{at}: must be an object.',
  '{at}.key: harus nama variabel valid (contoh: "maxDepth").':
    '{at}.key: must be a valid variable name (e.g. "maxDepth").',
  '{at}.type: harus salah satu dari {types}.': '{at}.type: must be one of {types}.',
  '{at}.options: wajib untuk tipe select (minimal 1 pilihan).':
    '{at}.options: required for the select type (at least 1 choice).',
  '{at}.options: maksimal 100 pilihan.': '{at}.options: at most 100 choices.',
  '{at}.options: setiap pilihan harus string ≤ 400 karakter (atau { value, label }).':
    '{at}.options: each choice must be a string ≤ 400 characters (or { value, label }).',
  '{at}.{key}: harus angka.': '{at}.{key}: must be a number.',
  'Plugin ini tidak meminta izin khusus.': 'This plugin requests no special permissions.',
  'BARU': 'NEW',
  'Plugin ini': 'This plugin',
  'dapat mengakses internet': 'can access the internet',
  'dan mengirim permintaan ke server mana pun. Hanya pasang jika kamu memercayai sumbernya.':
    'and send requests to any server. Only install it if you trust its source.',
  'Plugin berjalan di sandbox dan hanya bisa melakukan hal di atas. Batalkan jika tidak memercayai sumbernya.':
    'The plugin runs in a sandbox and can only do the things listed above. Cancel if you do not trust its source.',
  'Hapus custom parser "': 'Delete custom parser "',
  '" secara permanen?': '" permanently?',
  'Hapus plugin "': 'Delete plugin "',
  'Impor .zip atau klik "+ Tulis parser" untuk membuat parser baru.':
    'Import a .zip or click "+ Write parser" to create a new parser.',
  'Panel UI': 'UI Panel',
  'Memperbarui plugin terpasang: v{from} → v{to}{state}{newPerms}':
    'Updating the installed plugin: v{from} → v{to}{state}{newPerms}',
  ' (saat ini nonaktif)': ' (currently disabled)',
  ', <strong>meminta izin baru</strong>': ', <strong>requests new permissions</strong>',
  'Paket ini berbeda dari yang terpasang meskipun versinya sama (SHA-256 tidak cocok). Tinjau sebelum melanjutkan.':
    'This package differs from the installed one even though the version is the same (SHA-256 mismatch). Review it before continuing.',
  'Klik untuk menyalin': 'Click to copy',
  'Versi ini meminta izin yang belum pernah kamu setujui. Tinjau sebelum melanjutkan.':
    'This version requests permissions you have never approved. Review them before continuing.',
  'Setujui izin baru?': 'Approve the new permissions?',
  'Pasang plugin ini?': 'Install this plugin?',
  'URL tidak valid.': 'Invalid URL.',
  'Hanya http/https diperbolehkan.': 'Only http/https is allowed.',
  'Host lokal/private tidak diperbolehkan.': 'Local/private hosts are not allowed.',
  'Metode HTTP "{method}" tidak didukung.': 'The HTTP method "{method}" is not supported.',
  'Permintaan gagal: ': 'The request failed: ',
  'Karakter tidak tersedia di Shift_JIS/CP932: "': 'Character not available in Shift_JIS/CP932: "',
  '" tidak didukung api.encode; gunakan utf-8 atau shift_jis.':
    '" is not supported by api.encode; use utf-8 or shift_jis.',
  'Rentang baris tidak valid.': 'Invalid line range.',
  'Key blob tidak valid.': 'Invalid key blob.',
  'Plugin "{name}" tidak mendukung extract.': 'Plugin "{name}" does not support extract.',
  'Plugin "{name}" tidak mendukung pack.': 'Plugin "{name}" does not support pack.',
  'Metode "{method}" tidak ditemukan pada plugin "{name}".':
    'Method "{method}" was not found in plugin "{name}".',
  'Plugin "{name}" tidak mengekspor objek (module.exports).':
    'Plugin "{name}" does not export an object (module.exports).',
  'Gagal memuat plugin "{name}": {msg}': 'Failed to load plugin "{name}": {msg}',
  'Modul WASM harus mengekspor memory.': 'The WASM module must export memory.',
  'Modul WASM harus mengekspor alloc(size) atau malloc(size).':
    'The WASM module must export alloc(size) or malloc(size).',
  'Export "{name}" tidak ditemukan.': 'Export "{name}" was not found.',
  'Hasil fungsi WASM tidak valid.': 'Invalid WASM function result.',
  'Kompilasi modul WASM gagal: ': 'WASM module compilation failed: ',
  'Sumber WASM harus Uint8Array atau ArrayBuffer (ambil dari api.asset()).':
    'The WASM source must be a Uint8Array or ArrayBuffer (get it from api.asset()).',
  'Nama fungsi WASM tidak valid.': 'Invalid WASM function name.',
  'Input WASM harus string, Uint8Array, atau ArrayBuffer.':
    'WASM input must be a string, Uint8Array, or ArrayBuffer.',
  'Worker WASM tidak dapat dibuat: ': 'The WASM worker could not be created: ',
  'runWasm melebihi batas waktu {n} ms; eksekusi dibatalkan.':
    'runWasm exceeded the {n} ms limit; execution cancelled.',
  'runWasm gagal.': 'runWasm failed.',
  'Parser bawaan untuk skrip skenario engine Luca System (.txt) seperti Summer Pockets Steam, CLANNAD Switch, Tomoyo After Switch, dan CLANNAD Side Stories.':
    'Built-in parser for Luca System engine scenario scripts (.txt) such as Summer Pockets Steam, CLANNAD Switch, Tomoyo After Switch, and CLANNAD Side Stories.',
  'Pilih format penanganan perintah MESSAGE dan SELECT sesuai game target.':
    'Pick how MESSAGE and SELECT commands are handled for the target game.',
  'Posisi slot teks terjemahan yang dituju saat mengekspor file.':
    'The translation text slot targeted when exporting files.',
  'Nama protagonis (CLANNAD / MC)': 'Protagonist name (CLANNAD / MC)',
  'Nama yang digunakan saat menemukan placeholder @nama karakter utama.':
    'The name used to find the @main-character placeholder.',
  'File JSON di dalam ZIP bukan format JSON yang valid.':
    'A JSON file inside the ZIP is not valid JSON.',
  'Tidak ada custom parser yang valid di dalam file ZIP.':
    'No valid custom parser inside the ZIP file.',
  'Paket plugin tidak memiliki file "manifest.json" atau "parser.json".':
    'The plugin package has no "manifest.json" or "parser.json" file.',
  'Paket plugin tidak memiliki file "plugin.js".': 'The plugin package has no "plugin.js" file.',
  'Manifest tidak valid.': 'Invalid manifest.',
  'Manifest tidak valid:\n{rest}': 'Invalid manifest:\n{rest}',
  'Plugin "{name}" terpasang tetapi gagal dimuat: {msg}':
    'Plugin "{name}" is installed but failed to load: {msg}',
  'Hapus custom parser': 'Delete custom parser',
  'Hapus custom parser "{name}" secara permanen?': 'Permanently delete custom parser "{name}"?',
  'Hapus plugin': 'Delete plugin',
  'Hapus plugin "{name}" secara permanen?': 'Permanently delete plugin "{name}"?',
  'Gagal mengaktifkan plugin: {msg}': 'Failed to enable the plugin: {msg}',
  'Custom parser lama "{name}" tidak ditemukan.': 'The legacy custom parser "{name}" was not found.',
  'Plugin "{name}" tidak aktif.': 'Plugin "{name}" is not active.',
  'Plugin "{name}" tidak mengembalikan array baris teks.':
    'Plugin "{name}" did not return an array of text lines.',
  'Plugin "{name}" mengembalikan files kosong/tidak valid.':
    'Plugin "{name}" returned empty/invalid files.',
  'Plugin "{name}" tidak mengembalikan output pack yang valid.':
    'Plugin "{name}" did not return valid pack output.',
  'Daftar plugin & parser dimuat ulang.': 'The plugin & parser list was reloaded.',
  'Gagal memasang plugin': 'Failed to install the plugin',
  'Izin untuk plugin "{name}" disetujui.': 'Permissions for plugin "{name}" approved.',
  'Belum ada paket plugin (.zip) terpasang.': 'No plugin package (.zip) installed yet.',
  'Belum ada script parser custom (JS/Python).': 'No custom parser script (JS/Python) yet.',
  'Belum ada plugin atau parser terpasang.': 'No plugin or parser installed yet.',
  'Izin belum disetujui: ': 'Permissions not approved: ',
  'Izin baru · {n}': 'New permissions · {n}',
  'Menyediakan panel UI': 'Provides a UI panel',
  'Pengaturan global': 'Global settings',
  'Pengaturan per project': 'Per-project settings',
  'Pengaturan bersama': 'Shared settings',
  'Bersama · {n}': 'Shared · {n}',
  'Parser/plugin standar, tidak memerlukan izin khusus.':
    'Standard parser/plugin; no special permissions needed.',
  'Setujui izin baru dulu': 'Approve the new permissions first',
  'Nonaktifkan': 'Disable',
  'Aktifkan': 'Enable',
  ' plugin': ' plugin',
  'Versi baru meminta izin yang belum disetujui; plugin nonaktif sampai kamu menyetujuinya.':
    'The new version requests permissions that are not approved; the plugin stays disabled until you approve them.',
  'Tinjau izin baru': 'Review the new permissions',
  'Hapus plugin/parser': 'Delete plugin/parser',
  'Hapus custom parser "{name}"?': 'Delete custom parser "{name}"?',
  'Hapus parser': 'Delete parser',
  'Pengaturan plugin': 'Plugin settings',
  'Plugin ini tidak memiliki setelan yang dapat dikonfigurasi.':
    'This plugin has no configurable settings.',
  'Buka project terlebih dahulu untuk mengubah setelan project.':
    'Open a project first to change project settings.',
  'Setelan bersama (global & semua project)': 'Shared settings (global & every project)',
  'Profil dikunci karena project sudah memiliki baris.':
    'The profile is locked because the project already has lines.',

  // ── Custom parser modal ─────────────────────────────────────────────────
  'serialize: raw tidak ditemukan di file asli: ': 'serialize: raw not found in the original file: ',
  'Setelan Parser bukan JSON yang valid.': 'Parser Settings is not valid JSON.',
  'Setelan Parser harus berupa array spec, mis. [{"key":"encoding",...}].':
    'Parser Settings must be an array of specs, e.g. [{"key":"encoding",...}].',
  'Setelan Parser tidak valid: ': 'Invalid Parser Settings: ',
  'Belum ada aset. Parser bisa membacanya lewat <code>ctx.assets["nama-file"]</code> (Uint8Array / bytes).':
    'No assets yet. The parser can read them through <code>ctx.assets["file-name"]</code> (Uint8Array / bytes).',
  'Belum ada aset. Parser bisa membacanya lewat': 'No assets yet. The parser can read them through',
  'Belum ada parser custom. Klik': 'No custom parser yet. Click',
  'Nama': 'Name',
  'Simpan Setelan': 'Save Settings',
  'Simpan setelan': 'Save settings',
  'Hapus aset': 'Delete asset',
  'Aset "{name}" sudah ada. Timpa?': 'Asset "{name}" already exists. Overwrite it?',
  'Aset Sudah Ada': 'Asset Already Exists',
  'Belum ada parser custom. Klik <b>Parser Baru</b> untuk membuat parser ':
    'No custom parser yet. Click <b>New Parser</b> to create a parser for ',
  'JavaScript/Python untuk format file game apa pun, atau salin template contoh yang tersedia.':
    'any game file format in JavaScript/Python, or copy one of the available example templates.',
  'Cocok regex nama file': 'Matches the file name regex',
  'Ekspor: zip berisi parser.json + file asset asli (folder assets/)':
    'Export: a zip containing parser.json + the original asset files (assets/ folder)',
  'Offset magic tidak valid: "{value}" (format: HEX@offset, mis. 4D41@0).':
    'Invalid magic offset: "{value}" (format: HEX@offset, e.g. 4D41@0).',
  'Hex magic tidak valid: "{value}" (harus digit heksadesimal berpasangan genap, spasi boleh).':
    'Invalid magic hex: "{value}" (must be an even number of hex digits; spaces allowed).',
  'Nama parser wajib diisi.': 'The parser name is required.',
  'Minimal satu ekstensi file (mis. .mgs), atau ganti strategi pencocokan.':
    'At least one file extension (e.g. .mgs), or switch the matching strategy.',
  'Isi pola regex nama file, mis. ^scene_\\w+.': 'Fill in the file name regex, e.g. ^scene_\\w+.',
  'Regex nama file tidak valid: {rx}': 'Invalid file name regex: {rx}',
  '(tanpa nama)': '(unnamed)',
  '{n} baris log parser': '{n} parser log lines',
  'parse() tidak mengembalikan baris dengan message, cek script.':
    'parse() returned no line with a message; check the script.',
  '...dan {n} baris lainnya (total {total})': '...and {n} more lines (total {total})',
  'Script parse(ctx) masih kosong.': 'The parse(ctx) script is still empty.',
  'Progres: {done}/{total}{label}': 'Progress: {done}/{total}{label}',
  'Uji parser OK: {n} baris.{logs}': 'Parser test OK: {n} lines.{logs}',
  'Uji parser gagal.': 'Parser test failed.',
  'JSZip tidak tersedia. Gunakan Ekspor JSON.': 'JSZip is unavailable. Use Export JSON.',
  'Gagal membuat zip: ': 'Failed to create the zip: ',
  'Impor parser: {a} baru, {b} diperbarui{extra}': 'Parsers imported: {a} new, {b} updated{extra}',
  ', aset dari zip dipasang ke {n} parser': ', assets from the zip were attached to {n} parsers',
  'File bukan JSON yang valid.': 'The file is not valid JSON.',
  'Format tidak dikenali. Gunakan file hasil "Ekspor Parser" CSTL.':
    'Unrecognized format. Use a file produced by CSTL "Export Parsers".',
  'Tidak ada parser valid di file tersebut.': 'No valid parser in that file.',
  'Impor gagal: ': 'Import failed: ',
  'JSZip tidak tersedia. Gunakan file .json.': 'JSZip is unavailable. Use a .json file.',
  'File ZIP rusak atau bukan zip yang valid.': 'The ZIP file is corrupt or not a valid zip.',
  'parser.json tidak ditemukan di root ZIP.': 'parser.json was not found in the ZIP root.',
  'parser.json bukan JSON yang valid.': 'parser.json is not valid JSON.',
  'Format tidak dikenali. Gunakan zip hasil "Ekspor Parser" CSTL.':
    'Unrecognized format. Use a zip produced by CSTL "Export Parsers".',
  'Tidak ada parser valid di parser.json tersebut.': 'No valid parser in that parser.json.',
  'Belum ada parser untuk diekspor.': 'No parser to export yet.',
  'Hapus parser "{name}"?\n\nProyek yang memakai parser ini tetap bisa dibuka, tapi ekspornya jatuh ke JSON.':
    'Delete parser "{name}"?\n\nProjects using this parser can still be opened, but their export falls back to JSON.',
  'Hapus Parser': 'Delete Parser',
  'Ganti isi parse(ctx) dengan template contoh?': 'Replace the parse(ctx) body with the example template?',
  'Ganti isi serialize(ctx) dengan template contoh?':
    'Replace the serialize(ctx) body with the example template?',
  'Total aset {size} melebihi batas nyaman {limit}. ':
    'Total assets {size} exceed the comfortable limit {limit}. ',
  'localStorage browser ±5MB dan dipakai bersama data lain, terlalu besar berisiko gagal simpan. Tetap simpan?':
    'Browser localStorage is about 5MB and shared with other data, so a large payload risks failing to save. Save anyway?',
  'Parser ini mendaftarkan ekstensi bawaan CSTL: {list}.\n':
    'This parser registers CSTL built-in extensions: {list}.\n',
  'Parser custom akan MENGALAHKAN impor built-in untuk ekstensi tersebut.\n\nTetap simpan?':
    'The custom parser will OVERRIDE the built-in import for those extensions.\n\nSave anyway?',
  'Sudah ada parser bernama "{name}". Simpan dengan nama yang sama?':
    'A parser named "{name}" already exists. Save with the same name?',
  'Nama Parser Sama': 'Duplicate Parser Name',

  // ── Tutorial ────────────────────────────────────────────────────────────
  'Mulai dari dashboard': 'Start from the dashboard',
  'Tekan tombol Dashboard untuk kembali ke halaman proyek. Lalu kita buat proyek latihan baru.':
    'Press the Dashboard button to return to the project page. Then we will create a new practice project.',
  'Buat proyek latihan': 'Create a practice project',
  'Klik Buat Project dan beri nama “Latihan Tutorial”. Proyek ini jadi tempat aman untuk mencoba alur kerja.':
    'Click New Project and name it “Tutorial Practice”. This project is a safe place to try the workflow.',
  'Buka menu Impor': 'Open the Import menu',
  'Klik menu Impor di toolbar proyek untuk memasukkan sumber.':
    'Click the Import menu in the project toolbar to bring in a source.',
  'Pilih Impor Contoh Latihan. Ini menjalankan alur impor JSON biasa dengan satu dialog contoh, tanpa perlu mencari berkas di perangkat.':
    'Choose Import Practice Sample. This runs the normal JSON import flow with one sample dialogue, without hunting for a file on the device.',
  'Pilih baris': 'Select lines',
  'Klik kotak centang di samping baris contoh. Tombol Copy akan aktif setelah baris dipilih.':
    'Click the checkbox next to the sample lines. The Copy button becomes active once lines are selected.',
  'Salin prompt': 'Copy the prompt',
  'Klik Copy. Prompt dan teks sumber masuk ke clipboard, sama seperti saat menyiapkan permintaan untuk AI.':
    'Click Copy. The prompt and source text go to the clipboard, just like preparing a request for an AI.',
  'Tidak perlu berpindah ke layanan AI. Klik Salin Jawaban Contoh untuk menaruh hasil contoh di clipboard, seperti menyalin balasan AI.':
    'No need to switch to an AI service. Click Copy Sample Answer to put the sample result on the clipboard, like copying an AI reply.',
  'Tempel sendiri hasilnya': 'Paste the result yourself',
  'Klik kotak terjemahan lalu tekan Ctrl+V (atau tempel dari menu). Tutorial menunggu sampai teks contoh masuk ke kotak.':
    'Click the translation box and press Ctrl+V (or paste from the menu). The tutorial waits until the sample text lands in the box.',
  'Terapkan terjemahan': 'Apply the translation',
  'Klik Terapkan. CopasTool akan mencocokkan nomor baris hasil dengan sumber dan memperbarui terjemahannya.':
    'Click Apply. CopasTool matches the result line numbers to the source and updates the translations.',
  'Buka pengaturan proyek': 'Open project settings',
  'Klik Pengaturan Proyek. Kita lihat tab umum dan coba mengubah prompt proyek latihan.':
    'Click Project Settings. We will look at the general tab and try changing the practice project prompt.',
  'Kenali pengaturan umum': 'Get to know the general settings',
  'Klik tab Umum. Di sini kamu dapat memeriksa bahasa sumber dan tujuan, tampilan, konteks, serta pemeriksaan kualitas.':
    'Click the General tab. Here you can review the source and target language, display, context, and quality checks.',
  'Buka pengaturan prompt': 'Open the prompt settings',
  'Klik tab Prompt untuk melihat instruksi yang disalin bersama teks sumber.':
    'Click the Prompt tab to see the instructions copied along with the source text.',
  'Coba ubah prompt': 'Try changing the prompt',
  'Klik kotak prompt dan tambahkan satu petunjuk singkat, misalnya “Gunakan bahasa Indonesia yang alami.” Perubahan teks akan membuka langkah berikutnya.':
    'Click the prompt box and add a short instruction, for example “Use natural-sounding English.” Changing the text unlocks the next step.',
  'Simpan perubahan': 'Save the changes',
  'Klik Simpan Pengaturan untuk menyimpan prompt pada proyek latihan.':
    'Click Save Settings to store the prompt in the practice project.',
  'Latihan selesai': 'Practice complete',
  'Kamu sudah mempraktikkan membuat proyek, impor, memilih baris, copy prompt, paste manual, menerapkan hasil, dan mengubah prompt. Proyek Latihan Tutorial tersimpan di dashboard. Tekan ✦ Tutorial untuk mengulang.':
    'You have practiced creating a project, importing, selecting lines, copying the prompt, pasting manually, applying the result, and changing the prompt. The Tutorial Practice project is saved on the dashboard. Press ✦ Tutorial to run it again.',
  'Selesai': 'Done',
  'Salin Jawaban Contoh': 'Copy Sample Answer',
  'Latihan interaktif, langkah {n} dari {total}': 'Interactive practice, step {n} of {total}',
  'Clipboard tidak tersedia. Salin teks ini secara manual: ':
    'The clipboard is unavailable. Copy this text manually: ',
  '1. Aoi: "Halo! Hari ini cuacanya cerah, ya."': '1. Aoi: "Hi! The weather is lovely today."',

  // ── Agent UI (chat surface only) ────────────────────────────────────────
  'Halo, saya CSTL Agent. Tanya soal proyek ini atau minta saya mengerjakan terjemahan.':
    'Hi, I am the CSTL Agent. Ask about this project or tell me to work on the translation.',
  'Klik untuk lompat ke baris {n}': 'Click to jump to line {n}',
  'Gagal menyimpan chat history:': 'Failed to save the chat history:',
  'Gagal memuat chat history:': 'Failed to load the chat history:',
  'Atau ketik jawaban lain di kotak input di bawah.': 'Or type another answer in the input box below.',
  'Ketik jawabanmu di kotak input di bawah.': 'Type your answer in the input box below.',
  'Tidak ada memori yang tersimpan.': 'No memory saved.',
  'Baca glosarium & nama karakter': 'Read the glossary & character names',
  'Terapkan perbaikan': 'Apply the fixes',
  '⚠️ Agent berhenti tanpa jawaban final. Coba kirim ulang instruksi.':
    '⚠️ The agent stopped without a final answer. Try sending the instruction again.',
  '⚠️ Batas {n} giliran tool tercapai sebelum agent selesai. Set "Agent Max Turns" ke 0 (unlimited) di pengaturan atau lanjutkan dengan instruksi baru.':
    '⚠️ The {n}-turn tool limit was reached before the agent finished. Set "Agent Max Turns" to 0 (unlimited) in the settings, or continue with a new instruction.',
  'Gunakan salah satu tool dari DAFTAR TOOL di system prompt.':
    'Use one of the tools from the TOOL LIST in the system prompt.',
  'Error: Tool tidak dikenal: "{name}". {hint}': 'Error: unknown tool: "{name}". {hint}',
  'Error: Respons JSON-mu tidak bisa diparse (kemungkinan terpotong atau malformed). ':
    'Error: your JSON response could not be parsed (likely truncated or malformed). ',
  'JANGAN ulangi seluruh tool call sebelumnya. Respon ulang HANYA dengan JSON valid ':
    'DO NOT repeat the whole previous tool call. Reply again with ONLY valid JSON ',
  'tanpa markdown fence, pastikan semua string tertutup dan objek seimbang.':
    'without a markdown fence, and make sure every string is closed and every object balanced.',
  '…(terpotong, {n} karakter lagi; persempit query atau minta rentang lebih kecil)':
    '…(truncated, {n} more characters; narrow the query or ask for a smaller range)',
  '(kosong)': '(empty)',
};
