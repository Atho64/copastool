# CopasTool

<div align="center">

  ![Version](https://img.shields.io/badge/Version-v0.1.14--beta.4-purple?style=for-the-badge)
  ![Platform](https://img.shields.io/badge/Platform-Windows%20%7C%20Android-blue?style=for-the-badge)
  ![Engine](https://img.shields.io/badge/Engine-Tauri%20v2-orange?style=for-the-badge)

</div>

**English** · [Bahasa Indonesia](./README.md)

A translation helper for visual novels and EPUB novels. It runs as a native Tauri v2 app on Windows and Android, and as a PWA in the browser.

There are two main workflows: send selected text to a web AI through the clipboard and paste the result back, or let the app call an AI API directly. Character glossaries, story context between batches, and export back to the original file format are handled along the way.

---

## Features

### Import
- **File / Folder**: import `.json` or `.epub` one at a time or a whole folder at once. On Android the native folder picker reads subfolders through the Storage Access Framework.
- **ZIP**: import many files from a single `.zip` archive.
- **Plugin / Parser**: import game formats supported by installed plugins, through a dedicated menu or automatic routing by extension and magic signature.
- **Translation**: merge translation results into an existing project.
- **Language reference**: import text in another language (English, Mandarin) per file or for a whole folder, then use it as extra reference while translating.

### Plugin & parser system
Formats that are not supported yet can be added through a `.zip` plugin package, or by writing your own parser in **Settings → Plugin & Parser Manager** (`Alt + P`).

What you can install:

1. **Game format parser**: `extract` extraction and `pack` repacking, including binary formats and multi-file archives.
2. **Visual theme**: `theme.css` and `api.setTheme()` for palettes and watermarks.
3. **Custom panel**: extra widgets in the workspace through `panel(parentEl, api)`.
4. **Clipboard hook**: `onCopy` before text is copied, `onApply` before a translation is applied.
5. **Custom command**: registered automatically in the Keyboard Shortcut Manager through `api.registerShortcut()`.
6. **Single-script parser (JS / Python)**: the legacy one-file parser. Python runs in a Pyodide worker loaded from a CDN the first time it is used (±10 MB).

Plugin permissions are declarative, not a sandbox. The runtime does not refuse API calls whose permission was not declared, so `permissions` is a trust contract, not a security boundary. Architecture details, `manifest.json`, and code examples are in [PLUGIN_GUIDE.en.md](./PLUGIN_GUIDE.en.md).

### Copy-paste translation
Select lines, copy them into an AI, paste the result back, apply. The app maps the AI result to the correct line numbers.

- The prompt format is selectable: numbered list, block, XML, JSONL, or JSON array.
- The numbered format marks the active file with a `[File: file-name]` line at the start of a batch and whenever the file changes, plus `[D]` (dialogue) / `[N]` (narration) tags on every line. The AI repeats the same tags in its reply, and apply rejects lines whose type changed. Older stored default prompt headers are updated automatically when a project is opened.
- The prompt header is editable, including the variants that use Japanese quotation marks (kagikakko).
- **AI Check**: copy existing translations to have them re-checked, then apply the corrections. Correction reasons are written in the target language.
- Undo and redo for every translation apply.

### Global API (AI)
Connect the app to an AI API so translation, glossary extraction, AI Check, and the AI Agent run without copy-paste.

- **OpenAI Compatible** (GPT, Claude via OpenRouter, DeepSeek, local LLMs), **Gemini API** (Google AI Studio), and **Anthropic**.
- The model list can be fetched straight from the API with the fetch button.
- **Thinking / Reasoning**: turn thinking mode off or on. Each provider uses its own parameter.
- **` thinking` filter**: ` thinking...</think>` blocks and `thought: true` parts from Gemini responses are dropped before a translation is applied.
- **Global generation parameters**: max output tokens, seed, frequency penalty, presence penalty, and reasoning effort (`minimal` through `xhigh`). Used consistently by Auto Translate and the AI Agent.
- **Gemma 4**: `gemma-4-*` models are recognized automatically, and thinking off is sent as `thinkingLevel: "minimal"`.
- **RPM limit** with an automatic pause between requests.

### Auto Copas (BETA)
An alternative to Auto Translate, Auto Extract, and Auto Check that uses no API at all. The app drives the AI site in a browser and moves text **through the clipboard**, exactly like manual copy-paste: paste the prompt (`Ctrl+V`), press Enter, wait for it to finish, click the site's own Copy button, read the result from the clipboard. No text is manipulated through the DOM.

- **Targets:** Gemini, ChatGPT, DeepSeek, Arena.
- **Windows**: [Camoufox](https://github.com/daijro/camoufox), an anti-detect browser built on Firefox. The app downloads the official release from GitHub the first time it is used (about 500 MB) via `curl.exe`, then runs it as a child process. No Node.js or npm needed. After the first download, opening the browser is instant. Login sessions live in the app profile, so you only log in once per site through the **Open Browser** button.
- **Android**: in-app WebView (`AutoCopasActivity`). Pasting goes through `InputConnection` and uses the real clipboard.
- **New chat every X batches**: set it in Project/Dashboard Settings → **Auto Copas**. A value of 0 means never. The site's New chat button is pressed directly; URL navigation is only a fallback when the button is not found. Applies to every target; model selection stays manual.
- **Thinking**: force **Always ON / Always OFF / Site default**. Only applies to DeepSeek (the DeepThink toggle) and Gemini (the Thinking/Reasoning row). Applied before every batch, and failing to set thinking does not fail the batch.
- **Retry**: once, with a new chat. If **Retry if it fails** is enabled, the same batch repeats until stopped.
- Native app only, not in the PWA.
- AI sites change their page structure often, so the automation can break at any time.

### AI Agent
Chat with an AI that has direct access to the project data. The agent can read, analyze, and change translations through conversation.

**Read tools:**

| Tool | Purpose |
|---|---|
| `getProjectStats()` | Progress summary, line count, file list |
| `getLines(start, end)` | Original text and translations for a line range |
| `getContext(line_num, radius)` | Context around one line, radius 1 to 20 |
| `searchLines(query)` | Search original text, translations, and character names |
| `getCharacterNames()` | Character name list, inconsistencies flagged |
| `analyzeQuality(limit)` | Untranslated lines, translations that are too short, inconsistent names |
| `getProgressReport()` | Progress per file |
| `getGlossary()` | The active glossary |
| `listSettings()` | Every setting that can be changed |
| `getMemory(category?)` / `listMemory()` | Agent memory, with an optional category filter |
| `webSearch(query, source?)` | Search Wikipedia, Jisho, VNDB, or Tavily (needs an API key) |
| `searchVn(query, source?)` | Look up a VN/anime through VNDB or AniList |
| `extractGlossary(query, source?)` | Extract a glossary from VN/anime characters |

**Write tools:**

| Tool | Purpose |
|---|---|
| `applyTranslations(updates)` | Apply translations: `[{num, trans_message, trans_name?}]` |
| `editLine(line_num, fields)` | Edit a single line |
| `editLines(updates)` | Edit several lines at once |
| `clearTranslations(line_nums)` | Delete the translations of specific lines |
| `undoLastAction()` / `redoLastAction()` | Undo or redo the last action |
| `editPrompt(prompt_type, new_prompt)` | Edit the translation, glossary, ai_check, or agent prompt |
| `editGlossary(new_glossary)` | Rewrite the glossary |
| `toggleSetting(setting_name, value)` | Change an app setting |
| `saveMemory(key, value, category, scope?)` / `deleteMemory(key)` | Manage agent memory |

**Delegation and workflow tools:**

| Tool | Purpose |
|---|---|
| `delegateParallelTranslate(startLine, endLine, instruction?)` | Translate a large range through parallel subagents |
| `delegateTranslate(lineNums, instruction?)` | Translate a specific set of lines |
| `delegateAnalyze(lineNums, focus?)` | Analyze translation quality |
| `delegateGlossaryExtract(queries, source?)` | Extract glossaries from several VNs/anime at once |
| `delegateAgent(task, max_turns?)` | An autonomous subagent with its own tool loop |
| `askUser(question, options?)` | An interactive question card; the agent loop pauses until it is answered |
| `setPlan(steps)` / `updatePlanStep(step, status)` / `completePlan()` | A plan checklist shown live in the chat |

Mutations touching more than 10 lines show a diff preview and wait for confirmation.

### Glossary
Character names, places, and special terms, so translations stay consistent.

- Built-in glossary editor with a live preview in the workspace.
- Copy a text selection into an AI for automatic terminology extraction.
- Import names from **VNDB** (VN ID) or **AniList** (media ID).
- Extract names from ruby annotations in an EPUB.
- Import and export the glossary to a text file.

### Proofread & search
- Search both original text and translations.
- Regex, case-sensitive, and exact match options.
- Scope filters: all lines, selected lines only, and so on.
- Replace All.

### Line editor
Click any line to edit the character name, original text, translation, and translation status. On Android the editor slides up from the bottom so the keyboard does not cover it.

Trailing spaces in a translated sentence are preserved as-is (they are used to position text inside the game), and character names may contain commas, e.g. `123. Nino, Menoa, Ichito: hello` is still read as a single name when pasting numbered AI output.

### EPUB
- Standalone images are shown as illustrations between lines and do not add a line number.
- Images attached to a paragraph stay on that text line.

### Immersive mode
A full-screen reader for novels and visual novels.
- Toggle original text and translation from the header.
- Font size stepper, text width (Narrow, Medium, Wide), and theme (Dark, Sepia, Light).
- Bookmark drawer to jump to a line without leaving reading mode.
- `Alt + I` to open and close, `Esc` to exit, and a hide-header button for distraction-free reading.

### Furigana & dictionary
- Furigana conversion uses Kuroshiro and Kuromoji in a separate Web Worker, so the UI does not wait while a long script is processed.
- Output formats: Hiragana (default), Katakana, or Romaji.
- Kanji conversion results are cached, so repeated scrolling does not recompute them.
- Word lookup shows the reading, base form, part of speech, and translation.

### Selection & auto-increment
- Select all, select a range, or click manually.
- After a translation is applied, the "From - To" range advances automatically and the next range is selected according to the Translate Batch size.
- Undo for the last apply, plus a progress bar.

### Settings
- Source and target language.
- Lines per batch for translation, glossary, and AI Check.
- How many context lines are copied to the AI, before and after.
- Custom regex filter with a case-sensitive option.
- HTML tag for EPUB parsing.

### Tools menu
The **Tools** menu in the workspace contains:
- **File List** and **QC Validation**.
- **Dictionary History**: reopen earlier vocabulary lookups.
- **Text Replacer**: bulk text replacement outside the proofread flow.
- **File Explorer (OPFS)**: see file sizes, download, or clean up the storage directory.
- **Immersive Mode**.
- **Luna Hooker & VN Overlay**: translate dialogue while playing, see the section below.
- **Export to Spreadsheet** and **Import Spreadsheet into This Project**.

### Luna Hooker & VN Overlay (translate while playing)
Connects CopasTool to a [LunaTranslator](https://github.com/HIllya51/LunaTranslator) instance that is hooking the game text, then matches the dialogue that appears to project lines.

- **Setup**: enable *Network Services* in LunaTranslator on port `2333`, attach the Text Hooker to the game, then click **Connect** in CopasTool's Luna Hooker menu.
- **Check mode**: only shows whether the game dialogue matches a project line.
- **TL mode**: lines that are not translated yet are translated as they appear, then saved to the project. The result shows in the overlay and can be undone like any other edit.
- **TL engine**: choose **API** or **Copas** in the TL Mode section. Copas uses an AI site already logged in inside the automated browser, so TL Mode can run without an API key. The site picker and the **Open Browser** button are on the same row.
- **VN Overlay (Windows)**: a floating window that shows the active dialogue on top of a fullscreen game, with a click-through mode and a **Fullscreen Diagnostics** button for inspecting the z-order.

One note about Copas for TL Mode: Auto Copas only has one browser tab and one conversation, so TL Mode stops itself while Auto Translate, Auto Extract, or Auto Check is running. Stop that batch first.

### Storage
Projects are stored in the app's storage: the native filesystem when running as a Tauri app, or OPFS in the browser. Projects can be backed up and restored through `.copas` files; the older `.cstl` format is still supported.

Binary data and file assets are stored separately from metadata, so auto-save stays light and the dashboard does not need to load a whole project's contents.

#### Backup to folder

Available in Chrome, Edge, Brave, Opera, the Windows app, and the Android app. Desktop uses the File System Access API, the Windows app uses the native folder picker dialog (`tauri-plugin-dialog`), and Android uses Storage Access Framework folder permission. Firefox, Safari, and other mobile browsers use **Backup All ZIP**.

**How to use it:**
1. Click **Backup to Folder** on the dashboard, then pick a folder.
2. The project is written as `project_name_backup.copas`, including the original EPUB file and supporting assets. Later backups update the same file.
3. Click **Restore from Folder** to pick a `.copas`, `.copas.zip`, or `.cstl` file. Restoring creates a new project.

**Android:** the folder may live on device storage or in a document provider such as Google Drive. Grant access when the dialog asks for it.

**Desktop:** the browser may ask for folder permission again after a restart. Choose **Allow on every visit** when that option appears.

**Cloud sync:** the destination is an ordinary folder, so it can point at a folder owned by a sync app. For example: pick a folder inside Google Drive for Desktop's `My Drive`, or run `rclone sync D:\CSTLBackups drive:CSTL` from Task Scheduler. Dropbox, OneDrive, and Syncthing work the same way.

#### Backup & export save folder (native app)

In the Windows and Android apps, every backup and export (Backup, Backup All ZIP, Export, glossary export) is written to a single save folder.

- The folder is chosen once through a native dialog, then remembered for later saves.
- If the folder can no longer be written to (moved or deleted), the folder picker appears again automatically.
- On Android, cancelling the folder picker still saves the file to the **Download** folder.

**"Always ask where to save" mode:** enable this option in *Dashboard Settings* if you want a Save As dialog on every save, like the browser's "Ask where to save each file" option. While it is on, the remembered save folder is ignored. Cancelling the dialog cancels the save.

#### Spreadsheet (.xlsx)

A project can be exported to `.xlsx`, edited together with other translators in Excel, LibreOffice, or Google Sheets, then pulled back into CopasTool. There is no Google account integration; Google Sheets is just used as a file editor.

**Export** from the **Tools → Export to Spreadsheet** menu, or the **Sheet** button on a project card on the dashboard. The result is one workbook with three tabs:

| Tab | Contents |
|-----|----------|
| `Lines` | `line_num`, `file`, `name`, `message`, `trans_name`, `trans_message`, `is_translated`, `bookmarked`, `status`, plus an `extra` column (JSON) for structural fields such as Luca, EPUB, language references, and custom parsers. |
| `Glossary` | `source`, `target`, `type`, `description`, one row per entry. |
| `Info` | Project settings (`context_lines`, batch sizes, prompts, languages) as `key` / `value` rows, plus a format marker. |

**In Google Sheets:** open [sheets.google.com](https://sheets.google.com), choose **File → Import**, upload the `.xlsx`, then *Replace spreadsheet*. When you are done editing, download it again through **File → Download → Microsoft Excel (.xlsx)**.

**Import** has two entry points:

- **Workspace → Tools → Import Spreadsheet into This Project**, used while a project is open.
- **Dashboard → ⚙ → Restore from Spreadsheet (.xlsx)**, used when no project is open. The result is always a new project, because the dashboard always closes the open project.

After a file is selected, CopasTool asks:

- **Merge into This Project** (only when a project is open): translations are matched by `line_num` + `file`. Only translation columns and flags are taken; the original `message` text is untouched, so exporting to a game format stays in sync. New numbered rows are appended, the glossary is merged, and existing entries are updated.
- **Create New Project**: the whole sheet, the glossary, and the `Info` settings become a new project.

Import is never automatic. The spreadsheet file is not read when a project is opened, and merging never runs without explicit confirmation.

Columns are read by header name, so column order can change and tab names can be renamed (for example `Lines` to `Script`) as long as a `message` column exists. Unknown `Info` rows are ignored.

Not included in the spreadsheet: the original EPUB file, raw Luca and custom-parser sources (`lucaRawFiles`, `customRawFiles`), and EPUB image assets. To move between devices with the original files, use **Backup** (`.copas`).

### Keyboard shortcuts
Every shortcut can be re-recorded in the **Keyboard Shortcuts** menu.

| Category | Action | Default |
|---|---|---|
| **Dashboard** | Focus the project search box | `/` |
| **Workspace** | Export translation | `Alt + E` |
| | Open Find & Replace (Proofread) | `Alt + R` |
| | Open the Glossary tab | `Alt + G` |
| | Open the AI Check tab | `Alt + K` |
| | Open the Plugin & Parser Manager | `Alt + P` |
| | Open Project Settings | `Alt + S` |
| | Back to Dashboard | `Alt + B` |
| | Open the Bookmark List | `Alt + M` |
| | Run Auto Translate | `Alt + T` |
| | Open Immersive Mode | `Alt + I` |
| **Selection & navigation** | Select all lines | `Alt + A` |
| | Clear the line selection | `Alt + Q` |
| | Select a line range | `Alt + L` |
| | Previous batch | `Alt + ↑` |
| | Next batch | `Alt + ↓` |
| **Translation & undo** | Copy for the AI | `Alt + C` |
| | Focus the AI paste box | `Alt + V` |
| | Apply translation | `Ctrl + Enter` |
| | Undo translation | `Alt + Z` |
| | Redo translation | `Alt + Y` |
| **Plugin** | Custom commands | Registered by the plugin itself |

To change one: open the **Keyboard Shortcuts** menu, click the combination on the action you want to change, then press the new combination. `Backspace` clears a shortcut, `Reset` restores the defaults.

---

## Tutorial

### Start a new project
Click **New Project**, enter a project name, choose the file type you will import (JSON or EPUB), then click **Open**.

### Import a script
In the workspace, click **Import** in the toolbar and pick a file or folder. Every line appears in the table immediately. Files that were already imported are skipped automatically.

### Manual translation (copy-paste)
1. Select lines one by one, or use **Select Range** to select many at once.
2. Click **Copy Translation**, then paste it into ChatGPT, Gemini, or another AI.
3. When the AI finishes, copy its whole response and paste it into the **Paste AI Result** box.
4. Click **Apply**. CopasTool parses the result and fills the translations into the matching lines.

If the result is off, click **Undo**.

### Auto translate via API
1. Click the API settings button in the bottom-right corner of the workspace (the robot icon).
2. Choose the **API type**: OpenAI Compatible, Gemini, or Anthropic.
3. Fill in the **API key** and **Model**. The ↻ button fetches the model list straight from the API.
4. Set **RPM** to match your account limit, then click **Save API**.
5. Select the lines you want to translate and click **Run Auto Translate**.

For thinking models that emit ` thinking...</think>` blocks, enable the **` thinking...</think>` filter** in the API settings.

#### Auto Translate / Auto Extract / Auto Check via Copas
If you do not have an API key:
1. Choose **Copas** in the mode dropdown (Translate: Auto/Agent/Copas; Glossary & AI Check: API/Copas), then pick the target site.
2. Click **Open Browser**, then log in once in the window that appears. The session is kept.
3. Click the Auto button as usual. The prompt is pasted automatically, the response is read through the site's Copy button, and the result is applied batch by batch.

### Glossary
Fill in the glossary before translating many lines.
1. Open the **Glossary** tab in the workspace.
2. Type character names, places, or special terms into the editor.
3. Or click **Import VNDB/AniList** and enter the VN or media ID.
4. The active glossary is copied automatically every time you copy text to the AI.

### AI Agent
1. Click the agent button in the bottom-right corner of the workspace (the chat icon).
2. Example requests:
   - *"Translate lines 1 to 10"*: the agent fetches the text, translates it, and applies it itself.
   - *"Check character name consistency"*: the agent analyzes and reports inconsistencies.
   - *"Which lines are not translated yet?"*: the agent gives a progress summary.
   - *"Find lines containing 'sayonara'"*: the agent searches and shows the results.
3. Every change can be undone by typing *"undo"* or through the Undo button.

### AI Check
1. Select lines that are already translated.
2. Click **Copy AI Check** to copy the original text and translations in a special format.
3. Paste it into an AI and ask for corrections.
4. Copy the result, paste it into the **Paste AI Check** box, then click **Apply Corrections**.

What also runs during Auto Check:

- **Confidence scoring**: the AI rates each correction (high/medium/low). High-confidence corrections (typos, grammar, wrong names, leftover Japanese characters) are applied automatically, while medium and low go into a manual review queue in the AI Check tab. The **Auto-apply high-confidence corrections** option can be turned off so everything is reviewed manually.
- **Local sanity gate**: corrections identical to the current text are dropped. Rewrites that change more than 60% of the tokens are flagged for review and are not applied automatically.
- **Local linter**: leftover Japanese punctuation (。、・〜ー) and double spaces are fixed without the AI. Leftover CJK characters and names that violate the glossary are sent to the AI as hints.
- **Two-way context**: besides the previous-line context, following-line context is available in Dashboard Settings.
- **JSON format** for the API path, with automatic JSON repair. Plaintext is still supported for the Copas path.
- **Rejection memory**: corrections you reject are recorded as `REJECTED` entries, so later batches do not propose the same change again.
- **Deep Check**: two passes per batch. The first pass focuses on meaning accuracy, the second on naturalness.
- The default prompt follows a minimal-edit principle: the AI only changes the parts that are wrong.

### Proofread & replace
Open the **Proofread** tab. Enable **Regex** if you need complex patterns, tick **Case Sensitive** or **Exact Match** as needed, then click **Replace All**.

### Export
Click **Export** in the toolbar. The translated file is downloaded in its original format (`.json` or `.epub`). For other game formats, an installed parser plugin runs `pack()`, including binary formats and multi-file archives.

To back up a project with all of its data, click **Backup** on the dashboard. A `.copas` file can be restored at any time through the **Restore** button.

---

## Supported formats

| Format | Import | Export | Notes |
|--------|:------:|:------:|-------|
| `.json` | ✅ | ✅ | |
| `.epub` | ✅ | ✅ | |
| `.zip` | ✅ | no | Contains many files |
| `.copas` / `.cstl` | ✅ | ✅ | Project backup; `.cstl` is the older format |
| `.xlsx` | ✅ | ✅ | Spreadsheet, see the Spreadsheet section |
| Plugin / custom parser | ✅ | ✅ | Extra formats through a `.zip` plugin package |

---

## Security

CopasTool loads third-party AI pages in a separate window, so the trust boundary is defined explicitly.

- **Per-window capabilities.** `src-tauri/capabilities/default.json` only applies to `"windows": ["main"]`. The `vn-overlay` window uses the minimal `capabilities/overlay.json`: events, drag, position/size, close, hide. No clipboard, dialog, filesystem, or opener, because the overlay only renders local dialogue text. The `ai-companion` window gets no capability at all.
- **Every native command checks its caller.** Commands in `src-tauri/src/lib.rs` take a `tauri::WebviewWindow` parameter and then call `ensure_main_window` or `ensure_trusted_window`. Only overlay commands also accept `vn-overlay`. An AI page cannot touch the filesystem even if the capability configuration is changed.
- **Host allowlist for the AI window.** `open_ai_window` only accepts `https` URLs to hosts in `ALLOWED_AI_HOSTS`: `gemini.google.com`, `aistudio.google.com`, `chatgpt.com`, `chat.openai.com`, `chat.deepseek.com`, `meta.ai`, `claude.ai`, `chat.qwenlm.ai`, `lmarena.ai`, `arena.ai`, including their subdomains. When adding a new target, the site URL list lives in `COPAS_TARGETS` (`src/auto-copas/targets.ts`) and the host must be added to `ALLOWED_AI_HOSTS`.
- **`eval_ai_script` only injects into allowed hosts.** The script is rejected if the AI window has navigated to another host. The URL is moved into `window.location.href` through `serde_json`, so it cannot escape a JS string literal.
- **`withGlobalTauri: false`.** `window.__TAURI__` is not injected into every webview. The frontend uses the bundled `@tauri-apps/api` import, and runtime detection uses `window.__TAURI_INTERNALS__`.
- **Storage paths are sanitized.** `native_save_file`, `native_read_file`, `native_delete_file`, and `native_list_files` reject absolute paths and `..`, then make sure the target stays inside the app data folder.
- **Writes to a user-chosen folder are guarded.** `native_write_file_to`, `native_read_file_from`, and `native_list_dir` only accept absolute folders that came from the native folder picker dialog. The `dialog:allow-open` permission is only granted to the `main` window. File names are sanitized against `..`, `:`, and absolute paths, and the resulting path must stay inside that folder.
- **The overlay window is created on demand.** `vn-overlay` is not registered as a hidden window in `tauri.conf.json`, so there is no extra webview until the overlay button is pressed, and Android, which does not support overlays, is unaffected. `toggle_vn_overlay_window` is `async` because a synchronous command that creates a window would deadlock on Windows.
- **Camoufox Auto Copas only talks over loopback.** The browser is downloaded from the official GitHub release, runs as a child process owned by the app, and is controlled over WebDriver BiDi at `ws://127.0.0.1:<port>`. The browser can only be opened from the `main` window. On Android, every `copas*` command only drives the in-app WebView that loads the target site.
- **`csp: null` is kept on purpose.** A strict CSP on the main window would also restrict the AI window that loads third-party content, while the app needs inline styles and scripts, Web Workers, and connections to the AI API you choose. The real security boundary is the capabilities and the Rust guards above.

---

## Stack

TypeScript and Vite, compiled to vanilla JS with no framework runtime.

- **Tauri v2**: desktop runtime (NSIS and MSI) and mobile (APK).
- **@tauri-apps/plugin-clipboard-manager**: native clipboard that does not depend on window focus.
- **@tauri-apps/plugin-dialog**: native folder picker for the backup and export save folder, used on Windows and Android.
- **Web Worker storage**: `JSON.stringify` and `JSON.parse` for the project run on a separate thread, so auto-save does not stall the UI.
- **Android native bridge**: in-app WebView window, Storage Access Framework folder picker, saving to `Download` through MediaStore, and the Auto Copas WebView.
- **Camoufox + tokio-tungstenite**: the automated browser for Auto Copas on Windows, controlled over **WebDriver BiDi** on a loopback WebSocket. Downloads use `curl.exe`; no Node.js and no npm.
- **JSZip**: `.zip` archive parsing and `.xlsx` writing.
- **Kuroshiro + Kuromoji**: furigana conversion.
- **Pako**: compression and decompression.
- **OPFS and IndexedDB**: local file storage and the project database.
- **vite-plugin-pwa**: PWA, install to homescreen, and offline cache.

---

## Development & build

### Prerequisites

- **Node.js 20+** and npm.
- **Rust stable** plus the Tauri dependencies.
- For Android: **Android SDK**, **NDK 26.3.11579264**, and **JDK 17**.
- For the Camoufox download on Windows: `curl.exe`, which ships with Windows 10 version 1803 and later.

### Commands

| Command | Purpose |
|---------|---------|
| `npm run dev` | Vite dev server on port 5173 |
| `npm run build` | Type-check (`tsc`) then production build into `dist/` |
| `npm run preview` | Local preview of the production build |
| `npm run typecheck` | Type-check TypeScript without emitting |
| `npm run version:check` | Make sure every version marker matches `package.json` |
| `npm run test:copas` | Test the Auto Copas page-script invariants |
| `npm run tauri:dev` | Tauri desktop app in dev mode |
| `npm run tauri:build` | Build the Windows installers (NSIS and MSI) |
| `npm run android:init` | Scaffold Android in `src-tauri/gen/` then patch the bridge |
| `npm run android:build` | Patch the Android bridge then build the APK |
| `scripts\build-and-install-android.ps1` | Build, align, sign, and install to a phone over ADB |

`src-tauri/gen/` is in `.gitignore`, so **a fresh clone must run `npm run android:init`** before an Android build. Both Android scripts above already call `scripts/patch-android-bridge.mjs`, which copies `AndroidBridge.kt` and `AutoCopasActivity.kt` from `src-tauri/android/` into the scaffolded project. Without that step the build still runs, but the native bridge is empty. Desktop builds do not need it.

### App version

`package.json → "version"` is the single source of truth. During build and dev, `vite.config.ts` injects the version into the frontend as `__APP_VERSION__` for the dashboard badge and the status bar.

`npm run version:check` is also the first gate in CI. It verifies `tauri.conf.json`, `Cargo.toml`, `Cargo.lock`, the README version badge, and the `__APP_VERSION__` placeholder in `index.html`. To bump the version, change all four places at once and re-run the command.

### CI (`.github/workflows/build-tauri.yml`)

- `version-check`: verify the version, run `npm run test:copas`, and make sure the release tag matches `package.json`.
- `build-windows`: produces `CopasTool_<version>_x64-setup.exe` (NSIS) and `CopasTool_<version>_x64_en-US.msi` (MSI).
- `build-android`: produces aligned and signed APKs for `arm64-v8a`, `armeabi-v7a`, and `x86_64`. The three architectures are built as separate APKs, not one universal APK; each APK is named after the Gradle output target, e.g. `app-arm64-release-unsigned-signed.apk`. The release keystore comes from a repository secret. When the secret is unavailable, the workflow generates a temporary keystore so the build stays green, but the resulting APK cannot update an existing CopasTool installation.
- `publish-release`: uploads the `.exe`, `.msi`, and `.apk` files to a GitHub Release when a `v*` tag is pushed.

Caches used: `Swatinem/rust-cache` for the Windows and Android jobs, `actions/cache` for `~/.gradle`, and the built-in npm cache of `actions/setup-node`. The NDK is not cached because GitHub runners already provide it.

The Kuromoji dictionary in `public/dict/` is about 17 MB. It stays bundled into the APK because furigana needs it, but it is not precached by the service worker. The first launch only downloads the app shell (about 1 MB), and the dictionary is cached the first time furigana is used.

---

## Platform & compatibility

**Windows Desktop (native):**
- Windows 10 and Windows 11, 64-bit.
- Installers are available as NSIS (`.exe`) and Windows Installer (`.msi`).
- Storage uses the native filesystem with no browser quota, and the AI Companion window is separate.

**Android (native):**
- `minSdk` 24, which is Android 7.0 (Nougat) and later.
- APKs are built for `arm64-v8a`, `armeabi-v7a`, and `x86_64`.
- In-app WebView window, folder picking and backup through the Storage Access Framework, and saving to the `Download` collection through MediaStore. On Android 10 and later, MediaStore needs no extra storage permission.

**Browser and PWA:**
- Can be installed as a PWA with an offline cache.
- Storage uses OPFS (`navigator.storage.getDirectory()`) with an IndexedDB fallback.
- Chrome / Edge 102+ (recommended), Firefox 111+, Safari 15.2+ (uses the IndexedDB fallback).

---

## Credits

Created by [Atho64](https://github.com/atho64), forked by [LuKazuu](https://github.com/LuKazuu), then forked back and developed further by [Atho64](https://github.com/atho64).

---

## License & third-party attribution

CopasTool is released under the **[MIT License](./LICENSE)**.

The npm dependencies (JSZip, Kuroshiro, Kuromoji, Pako, path-browserify) use permissive licenses. The furigana dictionary uses Kuromoji and IPADIC (Apache 2.0 / NAIST). No copyleft or non-commercial component is bundled or required.

The full list is in **[THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)**.
