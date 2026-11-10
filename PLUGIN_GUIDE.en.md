# CSTL plugin & parser development guide (official reference)

> **The official guide to building CSTL (Copas Tool) plugins & custom parsers**

> **Updated 2 October 2026**, synchronized with `src/plugins.ts`, `src/plugin-types.ts`, and `src/plugin-host-bridge.ts`. Host API version: **1**.

**English** · [Bahasa Indonesia](./PLUGIN_GUIDE.md)

---

## Prompt templates for AI (copy-paste into ChatGPT / Claude / Gemini)

How to use it: **attach the sample file** (or paste part of its contents), fill in the reference section if you have one, and ask the AI to read this guide. The expected answer is ready-to-use plugin package or parser code, complete with a simulated test run.

Full guide: **https://github.com/Atho64/cstl**, `PLUGIN_GUIDE.md` in the repo root.

---

### 1. Prompt template: modern plugin package (`.zip` / `manifest.json` + `plugin.js`)

```text
Build me a CSTL (Copas Tool) Plugin package for the visual novel script file format below.

MANDATORY REFERENCE, read the guide first:
PLUGIN_GUIDE.md from the repo https://github.com/Atho64/cstl
(Follow the entire manifest.json spec, the permissions list, and the CommonJS module.exports lifecycle.)

MY INPUT:
1. Sample file   : <attach the original file, or paste its first 10-30 lines verbatim / hexdump>
2. Extension/Magic: <e.g. .dat, .bin, .ks, or a binary byte signature>
3. Reference tool: <repo link / similar parser tool if any, may be empty>
4. Companion files (key.bin / character table / font.dat, if needed): <attach the original files>
5. Special notes : <optional, e.g. "dialogue can be multi-line word-wrapped", "Shift-JIS binary file">

WHAT I NEED:
1. A complete, valid "manifest.json" file (manifest_version: 1, api: 1, id, permissions, extensions/magic, settings).
2. A "plugin.js" file using a pure CommonJS module (module.exports = { ... }), NOT export default.
3. A short explanation of the file structure (header, offset table, string table, encoding) and the round-trip simulation result.

PLUGIN FEATURE REQUIREMENTS, ALL MANDATORY:
- Sandbox & Module: Use module.exports = { async init, async extract, async pack, ... }. Do not use ESM import/export.
- Extraction (extract):
  * Input: { fileName, buffer, settings, globalSettings, sharedSettings, api }
  * Use api.decode(buffer, ['shift_jis', 'cp932', 'utf-8']) to read binary text.
  * Return: { lines: [{ file, name, message, raw, index }] }
  * The "message" field is MANDATORY and must contain the dialogue text; it must NOT be empty:
    lines without a message are dropped by the host. (Also accepted as aliases: original,
    original_text, text.)
  * Keep the whole raw line in "raw" and the byte offset / index number in "index" as the patch anchor.
- Packing (pack):
  * Input: { fileName, origBuffer, buffer, lines, sourceMap, projectName, settings, globalSettings, sharedSettings, api }
  * Use line.translation when present, or fall back to line.original.
  * Use line.trans_name when the speaker name is translated, or fall back to line.name.
  * Return one of: Uint8Array | string | Blob | { buffer } | { files: [...] } for multi-file.
- Settings form (settings in the manifest):
  * Build the relevant settings form (e.g. encoding choice, word-wrap width, or language slot).
  * "key" must be a valid JS variable name (e.g. maxDepth) and unique across the global/project/shared scopes.
- Companion Assets:
  * If you need a character table or companion file, put it in an assets/ folder and read it via await api.asset('assets/<name>').
- Error Handling:
  * Give a clear error message when the file is corrupt or the byte signature does not match.

ROUND-TRIP TEST & SELF-CHECK: do a MENTAL SIMULATION on 2 sample lines before answering, and write the result after the code:
1. extract(): Show the extracted line entries.
2. translate: Assume translation = "Hello, good morning!" and trans_name (if any).
3. pack()   : Show the final output line character by character, and make sure no other byte/tag is broken or shifted.
```

---

### 2. Prompt template: single-script custom parser (JavaScript / Python)

Use this template when you want a script parser for CSTL's **Custom Parser** editor:

```text
Build me a CSTL Custom Parser script (JavaScript / Python) for the script format below.

MANDATORY REFERENCE:
PLUGIN_GUIDE.md from the repo https://github.com/Atho64/cstl

MY INPUT:
1. Sample file   : <attach the original file, or paste its first 10-30 lines verbatim>
2. Script language: <"js" (default Web Worker) or "python" (Pyodide)>
3. Special notes : <optional, e.g. "Name: dialogue format">

WHAT I NEED:
parse(ctx) and serialize(ctx) function code ready to paste into the CSTL Custom Parser editor.

PARSER CONTRACT:
1. parse(ctx), import:
   * ctx: { fileName, text, bytes, startLineNum, options, assets, progress }
   * Return: an array of { name, message, raw, index }; message is mandatory and must not be empty.
   * Skip comment / decoration lines (just leave them out of the array).
2. serialize(ctx), round-trip export:
   * ctx: { fileName, text, bytes, lines, options, assets }
   * lines: an array of { name, message, trans_name, trans_message, is_translated, raw, index }
   * Use trans_message when is_translated is true, or fall back to the original message.
   * Return the whole text as a string (or Uint8Array / bytes for binary formats).
3. Do a round-trip simulation on 2 sample lines after the code.
```

---

## 1. Plugin package file architecture (`.zip`)

CSTL plugins are distributed as a standard `.zip` archive:

```text
plugin-name.zip
├── manifest.json       (Required: metadata, permissions, extensions, settings, UI)
├── plugin.js           (Required: the main CommonJS module code)
├── theme.css           (Optional: visual theme & watermark stylesheet)
└── assets/             (Optional: character tables, dictionary assets, images)
    ├── tbl.bin
    └── dictionary.txt
```

`manifest.json` and `plugin.js` are read from the **archive root** (not from inside a subfolder).

### How a plugin is loaded

The `plugin.js` code is wrapped and executed with `new Function('module', 'exports', 'CSTL', 'document', 'window', code)`.

> ⚠️ Even though `document` and `window` are available, **do not manipulate the global DOM directly.**
> Use the official APIs (`api.ui()`, `api.createModal()`, `api.injectStyle()`) so a plugin panel can be
> cleaned up automatically when it closes. Direct DOM manipulation risks leaks when the plugin unmounts.

`plugin.js` **must** export an object. Otherwise the host throws:
`Plugin "<name>" does not export an object (module.exports).`

---

## 2. Full `manifest.json` specification (v1)

The `manifest.json` file defines the plugin identity, permission declarations, supported file extensions, and the settings form schema.

```json
{
  "manifest_version": 1,
  "id": "my-vn-engine-plugin",
  "name": "XYZ Engine Parser & Tools",
  "version": "1.0.0",
  "author": "Translation Community",
  "description": "Parser for the .dat binary script format of Visual Novel Engine XYZ.",
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
    "title": "XYZ Utility Panel",
    "height": 260
  },
  "settings": {
    "global": [
      {
        "key": "defaultEncoding",
        "label": "Character Encoding",
        "type": "select",
        "default": "shift_jis",
        "options": [
          { "value": "utf-8", "label": "UTF-8" },
          { "value": "shift_jis", "label": "Shift-JIS (CP932 / Windows-31J)" }
        ],
        "description": "Text encoding of the binary file."
      }
    ],
    "project": [
      {
        "key": "wrapWidth",
        "label": "Word Wrap Width",
        "type": "number",
        "default": 42,
        "min": 0,
        "max": 120,
        "description": "Character limit per line (0 = no wrap)."
      }
    ],
    "shared": []
  }
}
```

### `manifest.json` attribute table

| Attribute | Type | Required | Validation rule |
|---|---|---|---|
| `manifest_version` | `number` | ✅ | Must be `1`. The older alias `manifestVersion` (camelCase) is also accepted, but **snake_case is recommended**. |
| `id` | `string` | ✅ | Regex `^[a-z0-9][a-z0-9_-]{0,63}$`: **lowercase letters**, digits, `_`, `-`. 1–64 characters, starting with an alphanumeric. |
| `name` | `string` | ✅ | 1–120 characters. |
| `version` | `string` | ✅ | 1–32 characters (semver recommended, e.g. `"1.0.0"`). |
| `author` | `string` | ➖ | At most 120 characters. |
| `description` | `string` | ➖ | At most 600 characters. |
| `api` | `number` | ➖ | When present, must be the integer `1`–`1` (the app's API version). |
| `permissions` | `string[]` | ➖ | Must come from the §3 list. An unknown permission name rejects the manifest. |
| `extensions` | `string[]` | ➖ | At most 64 entries. Each entry matches `^\.[a-z0-9]{1,16}$` (e.g. `.ks`). **Must not** claim `.copas` or `.cstl` (built-in formats). |
| `magic` | `object[]` | ➖ | At most 32 entries. Each entry has `hex` **or** `text`, **not both**. `offset` is optional, an integer 0–8192. |
| `ui` | `object` | ➖ | `{ "title": string (1–200), "height": number }`. **`height` must be 60–2000 px.** |
| `settings` | `object` | ➖ | `{ global?, project?, shared? }`, see §4. |

### `magic` details

```json
{ "offset": 0, "hex": "504b0304" }
{ "offset": 4, "text": "SCRIP" }
```

- `hex`: hexadecimal, an **even** number of digits, at most **128 bytes** (256 digits). Spaces are ignored.
- `text`: a non-empty string, at most **128 bytes** after UTF-8 encoding.
- `offset`: 0–8192, default `0`.

---

## 3. Permissions

Declare only the permissions you actually use; this list is shown in the Plugin Manager UI as information for the user.

| Permission | UI label | Related API / feature |
|---|---|---|
| `project` | Read project | `api.getProject()`, `api.getLines()`, `api.getLine()`, `api.getState()` |
| `workspace` | Change selection | `api.getSelection()`, `api.selectRange()`, `api.clearSelection()`, `api.copySelection()`, `api.updateLine()`, `api.addLine()`, `api.removeLine()`, `api.markTranslated()` |
| `clipboard` | Clipboard | `api.copy(text)` |
| `files` | Pick files | `api.pickFile(accept)` |
| `downloads` | Downloads | `api.download(data, filename)` |
| `storage` | Storage | `api.saveBlob()`, `api.loadBlob()`, `api.deleteBlob()`, `api.listBlobs()`, `api.blobExists()` |
| `wasm` | WebAssembly | `api.wasm(source, imports)`, `api.runWasm(...)` |
| `jszip` | JSZip | `api.JSZip` |
| `theme` | Theme | `theme.css` and `api.setTheme()` / `api.injectStyle()` |
| `net` | Internet access | `api.fetch(url, options)` |
| `hooks` | Copy/paste | `onCopy` and `onApply` |

> ⚠️ **Important: permissions are declarative, not a gate.**
> The runtime currently does **not** reject API calls whose permission was not declared
> (`_assertGranted` is deliberately permissive so the Aera plugin can run without declarations).
> So do not rely on `permissions` as a security sandbox; it is a **trust contract and
> information for the user**. Still declare them honestly.

---

## 4. Settings form input types (settings spec)

CSTL builds the settings form UI automatically from the `settings` schema:

```json
{
  "key": "wrapWidth",
  "label": "Word Wrap Limit",
  "type": "number",
  "default": 40,
  "min": 0,
  "max": 120,
  "step": 1,
  "placeholder": "0–120",
  "description": "Characters per line."
}
```

### Supported types

| `type` | UI control | Extra fields |
|---|---|---|
| `"string"` | Single-line text box | `placeholder` |
| `"number"` | Number input | `min`, `max`, `step` (all must be numbers) |
| `"boolean"` | Checkbox / switch | - |
| `"select"` | Dropdown | `options` **required**, at least 1, at most 100 choices |
| `"textarea"` | Multi-line text area | `placeholder` |

`type` may be omitted → treated as `"string"`.

### Validation rules

| Field | Rule |
|---|---|
| `key` | **Required.** Must be a valid JS variable name: `^[a-zA-Z_$][a-zA-Z0-9_$]*$` (e.g. `maxDepth`). **Unique across scopes**: the same key must not appear in both `global` and `project`. |
| `label` | **Required.** 1–200 characters. |
| `description` | At most 600 characters. |
| `placeholder` | At most 400 characters. |
| `options[].value` | A string of 1–400 characters. A plain string (instead of an object) is also allowed. |

**Overall limits:** at most **64 entries per scope**, at most **128 entries in total**. `settings` keys outside `global`/`project`/`shared` are rejected.

### Settings scopes

| Scope | Nature | Accessed via |
|---|---|---|
| `global` | Applies across projects, stored in the app settings. | `api.globalSettings` |
| `project` | Stored per project. | `api.settings` |
| `shared` | Shared between plugins (e.g. a common language profile). | `api.sharedSettings` |

---

## 5. Host API reference (`api`)

The `api` object is passed to every lifecycle method and is always available as `pluginObj.api`.

### Identity & settings

```javascript
api.version        // 1, the Host API version
api.pluginId       // "my-plugin"
api.settings       // the active settings for this plugin (project scope)
api.globalSettings // global-scope settings
api.sharedSettings // shared-scope settings
api.getPluginMeta()  // { id, name, version, author, description, permissions, extensions, ... }
```

### Reading & writing lines

```javascript
const info = await api.getProject();   // { name, type, fileCount, lineCount, translatedCount, rawLineCount }
const lines = await api.getLines();    // the project's RAW lines, see §7-C for the shape
const line = api.getLine(42);          // one line by line_num, or null

api.updateLine(42, { trans_message: 'Hello', is_translated: true }); // true when it succeeds
api.addLine({ line_num: 999, file: 'x.txt', name: null, message: 'New line' });
api.removeLine(42);
api.markTranslated(42, 'Hello', 'Budi');  // mark translated + fill the translation in one call

const snap = api.getState();           // { projectId, projectName, projectType, files, lineCount, translatedCount, selected, bookmarks }
```

> ℹ️ `getProject()`, `getLines()`, and `getLine()` are **synchronous** (not Promises), but they are still safe to `await`.

### Selection & clipboard

```javascript
const sel = api.getSelection();        // [1, 2, 3], the selected line numbers
api.selectRange(1, 50);                // fill the range form + trigger selection (1 ≤ from ≤ to)
api.clearSelection();
api.copySelection();                   // trigger copy-for-AI (respects the onCopy hook)

await api.copy('text');                // copy straight to the system clipboard
```

`api.selectRange()` throws when the range is invalid (`from < 1`, `to < from`, or a range larger than 1,000,000 lines).

### Feedback & dialogs

```javascript
api.toast('Extraction finished!');
await api.prompt('Profile name', 'default');   // → string | null
await api.confirm('Delete the data?', 'This cannot be undone.');  // → boolean | null
await api.alert('Done', 'Saved.');      // → void
```

### Encoding & binary

```javascript
const text = api.decode(uint8Array, ['shift_jis', 'utf-8', 'windows-31j']);
const buffer = api.encode('Hello world!', 'shift_jis');   // → Uint8Array
```

> ℹ️ **`api.encode`**: supports `utf-8` (default) and **full Shift_JIS/CP932**
> (labels: `shift_jis`, `sjis`, `cp932`, `windows-31j`; including the Windows variants such as
> fullwidth tilde U+FF5E and wave dash U+301C). Any other encoding, or a character that is not
> in the Shift_JIS table (e.g. emoji), will **throw an error** instead of being silently
> encoded as UTF-8.
>
> `api.decode` tries each encoding in order with `fatal: true`; if all fail, it falls back to
> non-fatal UTF-8. Default order: `utf-8`, `shift_jis`, `windows-31j`, `cp932`.

### Plugin package assets

```javascript
const names = api.listAssets();                        // EVERY file inside the zip
const bytes = await api.asset('assets/tbl.bin');       // Uint8Array
const text  = await api.assetText('assets/dict.txt');  // string
```

### Persistent storage

Stored per project + per plugin (OPFS).

```javascript
await api.saveBlob('cache.bin', uint8Array);
const data  = await api.loadBlob('cache.bin');   // Blob | null
await api.deleteBlob('cache.bin');
const keys  = await api.listBlobs();             // ['cache.bin', ...]
const has   = await api.blobExists('cache.bin'); // boolean
```

`Data` aliases (older names, still supported): `saveData`, `loadData`, `deleteData`, `listData`, `dataExists`.

> ℹ️ `key` must be a plain file name: at most 255 characters, no `/`, `\`, or control characters,
> and not `.` or `..`.

### Network: `api.fetch(url, options)` (needs the `net` permission)

Network requests are **proxied by the host** with security restrictions:

- **http/https** only. Targets on localhost / private IPs / loopback are **blocked** (anti-SSRF), including on redirected URLs.
- Only the `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `HEAD`, `OPTIONS` methods.
- `credentials: 'omit'`, `redirect: 'follow'`, `cache: 'no-store'`, `referrerPolicy: 'no-referrer'`.
- `options.timeoutMs` / `options.timeout`: 1000–120000 ms, default **30000**.
- An object `options.body` is JSON-encoded automatically.
- **`options.asBytes: true`** (alias `options.binary: true`) → `body` comes back as a `Uint8Array` instead of a string.
- **Return**: `{ ok, status, statusText, url, headers, body, buffer }`; `buffer` is always a raw `ArrayBuffer`.

```javascript
const res = await api.fetch('https://example.com/api', {
  method: 'POST',
  body: { q: 'hello' },
  timeoutMs: 10000
});
if (res.ok) console.log(res.body);

// Download binary
const bin = await api.fetch('https://example.com/font.dat', { asBytes: true });
await api.saveBlob('font.dat', bin.body);
```

> ⚠️ **No rate limit** is enforced at the moment (`_rateOk()` always returns `true`).
> Still throttle requests on the plugin side; do not flood third-party servers.

### File dialogs & downloads

```javascript
const file = await api.pickFile('.dat,.bin');   // { name, buffer: ArrayBuffer } | null
api.download(bytesOrStringOrBlob, 'script_translated.dat');
```

### WebAssembly

```javascript
// One shot: compile + instantiate, return both
const { module, instance } = await api.wasm(wasmBytes, imports);
const out = instance.exports.myFunc(42);

// Alternative: run a specific export in a separate worker (with a timeout + module cache)
const result = await api.runWasm('assets/lib.wasm', 'process', [inputPtr, len], { timeoutMs: 5000 });
```

> ℹ️ `api.runWasm(wasmPathOrBytes, fnName, args, opts)` accepts an **asset path inside the zip**
> or the WASM bytes directly. The module must export `memory` along with `alloc`/`malloc`.
> Timeout 1000–60000 ms, default 10000.

### JSZip & GPU

```javascript
const zip = new api.JSZip();
const gpu = api.gpu;   // navigator.gpu, or undefined when unavailable
```

### UI: menus, toolbar, modals, dashboard cards

```javascript
const menuBtn = api.addMenuItem('import', 'Import from XYZ', () => { /* ... */ });
api.removeMenuItem(menuBtn);

const tbBtn = api.addToolbarButton('Check XYZ', () => { /* ... */ }, { title: 'Check XYZ', className: 'btn-ghost btn-sm' });
api.removeToolbarButton(tbBtn);

const modal = api.createModal('XYZ Panel', '<p>Content</p>', {
  wide: true,                       // use .modal-wide
  confirmLabel: 'Save',
  cancelLabel: 'Cancel',
  actions: '',                      // custom button HTML (replaces the default action row)
  onConfirm: (overlay) => { /* ... */ }
});
api.closeModal(modal);

const card = api.addDashboardCard(cardElement);   // HTMLElement
api.removeDashboardCard(card);

const section = api.addSettingsSection('plugins', 'XYZ Settings', (bodyEl) => {
  bodyEl.innerHTML = '<p>Content</p>';
});
api.removeSettingsSection(section);
```

`addMenuItem` accepts a menu name (`'import'`, `'export'`, or an element id). `addSettingsSection` accepts the target `'settings'`/`'plugins'`/`'glossary'`/`'summary'` or a CSS selector.

### UI: region access

```javascript
const panel = api.ui('panel');         // the plugin's own panel element
const body  = api.ui('body');          // document.body (alias: 'app')
const el    = api.ui('toolbarActions'); // a named region, or a CSS selector / id
```

Available named regions:

`importMenu`, `exportMenu`, `settingsModal`, `glossaryModal`, `summaryModal`, `toolsPanel`,
`textPanel`, `previewContainer`, `toolbar`, `toolbarActions`, `pluginPanels`, `dashboard`,
`dashboardContent`, `lineEditorModal`, `lineEditorBody`, `proofreadModal`, `pasteArea`,
`progressOverlay`, `progressText`

### Theme & styling

```javascript
api.setTheme({ '--primary': '#0284c7', '--accent': '#38bdf8' });  // set CSS variables on :root
const styleEl = api.injectStyle('/* css */', 'my-plugin-style');
api.removeStyle('my-plugin-style');
```

### Hook & event system

```javascript
// Named hook, see §8 for the names the host actually calls
const token = api.hook('lineOpen', (num, line) => { /* ... */ });
api.unhook(token);

// Events
const off = api.on('projectOpen', (payload) => { /* ... */ });
off();                    // unsubscribe
api.off('projectOpen');   // remove every listener for that event
api.emit('myEvent', { a: 1 });   // send a custom event to other plugins
```

### Registering importers / exporters / shortcuts

```javascript
api.registerImporter('xyz', (input) => { /* ... */ });
api.unregisterImporter('xyz');

api.registerExporter('xyz', (input) => { /* ... */ });
api.unregisterExporter('xyz');

api.registerShortcut('xyz-check', 'Check XYZ', 'Alt+X', () => { /* ... */ }, { scope: 'workspace' });
api.unregisterShortcut('xyz-check');
```

### Miscellaneous

```javascript
api.abort();               // cancel every fetch/operation the plugin currently has running
await api.getStorage();    // the OPFS root FileSystemDirectoryHandle (async)
```

---

## 6. Lifecycle & writing `plugin.js`

> ⚠️ **Critical code-writing rules**:
> - Use **CommonJS (`module.exports`)**. Do not use `export default` / `import`.
> - Run asynchronous operations with `async/await`.
> - Use the official DOM APIs; do not manipulate globals directly (see §1).

### Method names the host recognizes

| Method | Called when | Signature |
|---|---|---|
| `init` | The plugin is loaded for the first time | `init(api)` |
| `activate` | Right after `init` finishes | `activate(api)` |
| `extract` | Importing a file with a matching extension/magic | `extract({ fileName, buffer, settings, globalSettings, sharedSettings, api })` |
| `pack` | Export / patch build | `pack({ fileName, origBuffer, buffer, lines, sourceMap, projectName, settings, globalSettings, sharedSettings, api })` |
| `panel` **or** `mount` | The plugin panel is mounted in the workspace | `panel(parentEl, api)` |
| `unmount` | The plugin panel is removed | `unmount()` |
| `onSettings` | Settings changed / project switched | `onSettings({ settings, globalSettings, sharedSettings })` |
| `onCopy` | Text is about to be copied for the AI | `onCopy({ text, ctx, api })` → string |
| `onApply` | A translation is about to be applied | `onApply({ text, ctx, api })` → string |
| `onEvent` | Every host event is emitted | `onEvent(event, payload, api)` |
| `commands` | Shortcut command list | Array or object, see below |

> ⚠️ **`onMount` and `onUnmount` are NOT recognized.** The correct names are **`panel`**
> (or `mount`) and **`unmount`**. If you use the old names, your panel will never be mounted,
> with no error message at all.

### The `commands` shape

The host accepts **two** shapes. Both use the function name as the key:

```javascript
// Shape 1: object. Clearest, recommended.
module.exports = {
  commands: {
    formatTags(api) { api.toast('Tags formatted.'); },
    checkEmpty(api) { /* ... */ }
  }
};
```

```javascript
// Shape 2: array. MUST include a top-level function whose name equals `key`.
module.exports = {
  commands: [
    { key: 'formatTags', label: 'Format Character Tags' },
    { key: 'checkEmpty', label: 'Check Empty Lines' }
  ],
  formatTags(api) { api.toast('Tags formatted.'); },   // matched through `key`
  checkEmpty(api) { /* ... */ }
};
```

> ❌ **Do not use `{ id, label, run }`.** The host only reads `key` and `label`.
> The `id` and `run` fields are ignored entirely: the command appears in the shortcut list
> but does nothing when run.

### Full example

```javascript
module.exports = {
  // 1. Initialization
  async init(api) {
    console.log('[Plugin]', api.pluginId, 'v' + api.getPluginMeta().version, 'ready.');
  },

  // 2. File import / extraction
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
          message: match[2],   // ← the canonical field
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
      sourceMap: { totalRawLines: num } // optional metadata for the pack stage
    };
  },

  // 3. Export / repacking
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

  // 4. Pre-copy AI hook
  async onCopy({ text, ctx, api }) {
    return text;
  },

  // 5. Post-apply translation hook
  async onApply({ text, ctx, api }) {
    return text.replace(/""/g, '"');
  },

  // 6. Custom UI panel in the workspace
  async panel(rootElement, api) {
    rootElement.innerHTML = `
      <div style="padding: 12px; font-family: sans-serif;">
        <button id="btnQuickCheck" class="btn btn-primary btn-sm">Check Empty Lines</button>
      </div>
    `;
    rootElement.querySelector('#btnQuickCheck').onclick = async () => {
      const lines = await api.getLines();
      // IMPORTANT: getLines() returns the project's RAW lines; the translated text
      // lives in `trans_message`, NOT `translation` (see §7-C).
      const empty = lines.filter(l => !l.trans_message);
      api.toast(`Remaining untranslated lines: ${empty.length}`);
    };
  },

  // 7. Cleanup when the panel closes
  async unmount() {
    // Remove listeners / styles / intervals you created
  },

  // 8. Custom keyboard shortcut commands
  commands: {
    formatTags(api) {
      api.toast('Tag formatting ran.');
    }
  }
};
```

---

## 7. Data formats: script lines & return types

There are **three different line object shapes**; note where each one is used:

### A. Lines RETURNED from `extract()` (plugin → host)

| Property | Type | Notes |
|---|---|---|
| `file` | `string` | The source file name. When empty, `fileName` is filled in automatically. |
| `name` | `string \| null` | The original character / speaker name. Alias: `character_name`. |
| `message` | `string` | **Required: this is the dialogue text.** Aliases: `original`, `original_text`, `text`. |
| `raw` | `string \| null` | The whole original line fragment, the anchor for the export patch. |
| `index` | `number \| null` | Byte offset / unique index of the binary entry. Alias: `number`. |

> ⚠️ Lines with an empty `message` are **dropped** by the host. Make sure you only include
> dialogue lines. `message` is also normalized: newlines inside it become a literal `\n`.

### B. Lines in `ctx.lines` during `pack()` (host → plugin)

Contains the internal fields **plus** convenience aliases:

| Property | Notes |
|---|---|
| `line_num`, `file` | The line number (1-based) and the source file name. |
| `name`, `message` | The original name & text. |
| `trans_name`, `trans_message`, `is_translated` | The translation results. |
| `original`, `translation` | Aliases of `message` / `trans_message`. `translation` is `undefined` when the line is not translated yet. |
| `character_name` | Alias of `trans_name \|\| name`. |
| `raw`, `index` | The anchors from the `extract()` result. |

> ⚠️ This shape has **no `number` field**: use `line_num`.

### C. Lines RETURNED from `api.getLines()` (host → plugin, raw)

| Property | Notes |
|---|---|
| `line_num` | The line number (1-based). **Not `number`.** |
| `file` | The source file name. |
| `name`, `message` | The original name & text. **Not `original`.** |
| `trans_name`, `trans_message` | The translated name & text. **Not `translation`.** |
| `is_translated` | `true` when the line is already translated. |

### Return types for `pack()`

Every shape below is accepted:

| Return | Host treatment |
|---|---|
| `Uint8Array` / `ArrayBuffer` | Wrapped as a binary blob. |
| `string` | Wrapped as a UTF-8 text blob. |
| `{ content: string }` | Same as above. |
| `Blob` | Used directly. |
| `{ blob: Blob }` | Used directly. |
| `{ buffer: Uint8Array \| ArrayBuffer }` | Wrapped as a binary blob. |
| `{ files: [...] }` | **Multi-file**, see below. |

Any other shape → the host throws `did not return valid pack output`.

**Multi-file**: when `files` contains valid entries, it **takes priority** over `buffer`:

```javascript
return {
  fileName: "export_result",       // optional, fallback only, see the naming note below
  files: [
    { name: "script01.dat", buffer: file1Bytes },   // Uint8Array / ArrayBuffer
    { name: "sub/script02.dat", content: "text" }   // or content: string
  ]
};
```

- `files` with **1 entry** → that file is returned as-is.
- `files` with **2 or more entries** → the host automatically wraps them all into
  a single ZIP archive (DEFLATE compression) for the user to download.

> ℹ️ **Output file naming** (decided by the host, not the plugin):
> - Single output → **the imported file name** (e.g. importing `script01.dat` → output `script01.dat`).
> - Multi-file output (archive) → **the project name** + `.zip`.
> - The plugin's `fileName`/`filename` is only used as a fallback when neither of those is available.

---

## 8. Hooks & events

### Lifecycle hooks (methods on `module.exports`)

Only **two** are called by the host:

| Hook | When | Signature | Return |
|---|---|---|---|
| `onCopy` | Before text is copied for the AI | `onCopy({ text, ctx, api })` | `string`, the modified text |
| `onApply` | Before a translation is applied | `onApply({ text, ctx, api })` | `string`, the modified text |

`ctx` contains `{ projectName, lineCount, selectedLines }`. If a hook throws, the host logs it to the console and **continues with the original text**.

### Named hooks (via `api.hook(name, fn)`)

| Name | When | Signature |
|---|---|---|
| `lineOpen` | The line editor opens | `(lineNum, line) => void` |
| `lineSave` | A line is saved from the editor | `(lineNum, line, before) => void`; `before` = `{ trans_message, trans_name, is_translated }` before the change |

Both are synchronous (`runHooksSync`). `api.hook()` accepts any name, but only the two above are actually called by the host; other names are registered and never fire.

### Events

| Event | Payload | Fired when |
|---|---|---|
| `projectOpen` | `{ name, type, lineCount, translatedCount }` or `null` | The user opens a project |
| `projectClose` | `null` | The user returns to the dashboard |

`api.on(ev, fn)` returns an unsubscribe function. The `onEvent` hook receives ALL events.
`api.emit(event, payload)` sends a custom event to other plugins (the host emits no other built-in events).

---

## 9. Visual theme guide (`theme.css`)

A visual theme plugin controls CSTL's color palette and can include background art. CSTL's default theme is **dark**; override only the variables you need.

### Core variables

| Variable | Default (dark theme) | Purpose |
|---|---|---|
| `--bg` | `#0f0e0d` | Main background |
| `--surface` | `#1d1b19` | Panel/card surface |
| `--surface-2` | `#26231f` | Lighter surface |
| `--surface-3` | `#332f2b` | Lightest surface |
| `--hairline` | `#332f2b` | Subtle divider line |
| `--hairline-2` | `#43403c` | Stronger divider line |
| `--ink` | `#f0ece4` | Primary text |
| `--ink-dim` | `#a8a29c` | Secondary text |
| `--ink-muted` | `#7e7974` | Tertiary text |
| `--primary` | `#c84e18` | Primary action color |
| `--primary-hover` | `#a93f12` | Primary action on hover |
| `--primary-soft` | `rgba(200,78,24,0.14)` | Soft accent background |
| `--accent` | `#b9975b` | Secondary accent |
| `--success` | `#2d7d5f` | Success status |
| `--danger` | `#c82a3a` | Danger status |
| `--warning` | `#c98a12` | Warning status |

**Compatibility aliases** (older names, still mapped): `--bg-2`, `--bg-elev`, `--panel`, `--panel-2`, `--line`, `--line-2`, `--text`, `--muted`, `--muted-2`, `--bg-card`, `--border`, `--text-base`.

### Light theme example

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

The theme is applied automatically when a project is opened/closed, and only when `theme.css` exists **and** the `theme` permission is declared.

> ⚠️ **`theme.css` is sanitized before it is applied.** What gets blocked:
> - **`@import`**: removed entirely.
> - **`url()` to external sources**: only `data:` URIs and `#` fragments are allowed.
>   So background art **must** use base64 (`url("data:image/jpeg;base64,...")`) or inline SVG;
>   `url("https://...")` is dropped.
>
> This prevents a theme plugin from loading network content without the user knowing.

---

## 10. Keyboard shortcut integration

Commands registered in `commands` on `plugin.js` appear automatically in the **Keyboard Shortcut Manager** (the **Plugin** group). Their internal id has the form `plugin.<plugin-id>.<key>`.

A plugin can also register its own shortcuts at any time through `api.registerShortcut(id, label, combo, handler, opts)`.

### CSTL built-in shortcuts

| Scope | Action | Default shortcut |
|---|---|---|
| **Dashboard** | Create New Project | *(empty)* |
| | Restore Project | *(empty)* |
| | Open Settings Defaults | *(empty)* |
| | Focus Project Search | `/` |
| **Workspace (Import/Export/General)** | Import File | *(empty)* |
| | Import Folder | *(empty)* |
| | Import ZIP | *(empty)* |
| | Export Translation | `Alt + E` |
| | Open Find & Replace | `Alt + R` |
| | Open the Glossary Tab | `Alt + G` |
| | Open the AI Check Tab | `Alt + K` |
| | Open the Plugin & Parser Manager | `Alt + P` |
| | Open Project Settings | `Alt + S` |
| | Back to Dashboard | `Alt + B` |
| | Open the Bookmark List | `Alt + M` |
| | Run Auto Translate | `Alt + T` |
| | Open Immersive Mode | `Alt + I` |
| **Selection & Navigation** | Select All Lines | `Alt + A` |
| | Clear Line Selection | `Alt + Q` |
| | Select a Line Range | `Alt + L` |
| | Previous Batch | `Alt + ↑` |
| | Next Batch | `Alt + ↓` |
| **Translation & Undo** | Copy for the AI | `Alt + C` |
| | Focus the AI Paste Box | `Alt + V` |
| | Apply Translation | `Ctrl + Enter` |
| | Undo Translation | `Alt + Z` |
| | Redo Translation | `Alt + Y` |
| **Plugin Commands** | Custom Plugin Commands | *Configured in the Shortcut menu* |

`dashboard`-scoped actions only work on the dashboard, `workspace` ones only inside a project. Actions with `inInputs: true` (Focus AI Paste, Apply Translation) still run even while the cursor is inside an input field.

---

## 11. Troubleshooting checklist

- **`manifest_version is required (use 1)`**
  &rarr; Add `"manifest_version": 1`. `manifestVersion` (camelCase) is still accepted as an alias, but use snake_case.
- **`"id" is required: lowercase letters/digits/underscore/hyphen…`**
  &rarr; `id` must be **all lowercase**. `"MyPlugin"` is rejected; use `"my-plugin"`.
- **`Unknown permission: "…"`**
  &rarr; Check the list of 11 permissions in §3. The smallest typo rejects the manifest.
- **`The .copas extension is a built-in CSTL format and cannot be claimed by a plugin`**
  &rarr; Remove `.copas` / `.cstl` from `extensions`.
- **`Unexpected token 'export'`**
  &rarr; The sandbox uses CommonJS. Use `module.exports = { ... }`, not `export default` / `import`.
- **`Plugin "…" does not export an object (module.exports)`**
  &rarr; `module.exports` must be an object. If you write `module.exports = function`, the host rejects it.
- **The plugin panel does not appear, but there is no error**
  &rarr; You are most likely using `onMount`. The correct name is **`panel`** (or `mount`). For cleanup use **`unmount`**, not `onUnmount`.
- **The command appears in the shortcut list but does nothing**
  &rarr; You are using `{ id, label, run }`. The host only reads `{ key, label }` and looks for a function with that `key` as its name. Use the object form `commands: { myCommand(api) {…} }` to avoid the mistake.
- **`Plugin "…" did not return an array of text lines`**
  &rarr; `extract()` must return `{ lines: [...] }` (or a bare array). Make sure every line has a **non-empty** `message`; empty lines are dropped.
- **`Plugin "…" did not return valid pack output`**
  &rarr; Return one of the shapes in §7: `Uint8Array`, `string`, `Blob`, `{ buffer }`, or `{ files }`.
- **`Character not available in Shift_JIS/CP932: "…"`**
  &rarr; `api.encode` deliberately throws instead of silently switching to UTF-8. Remove characters that are not in the table (emoji, exotic symbols) or switch to UTF-8.
- **The theme colors do not change after installing**
  &rarr; Make sure the manifest includes `"permissions": ["theme"]` and that `theme.css` exists in the zip root.
- **`Local/private hosts are not allowed`**
  &rarr; `api.fetch` blocks localhost and private IPs (anti-SSRF). Use a public host.
- **A binary file produces random text / strange characters**
  &rarr; Use `api.decode(buffer, ['shift_jis', 'cp932'])` for older Japanese games.
- **`ui.height` is rejected**
  &rarr; The valid range is **60–2000** px, not 120–600.

---

## 12. Version notes

| Item | Value |
|---|---|
| Host API version (`api.version`, `api` in the manifest) | `1` |
| Manifest version (`manifest_version`) | `1` |
| Index schema | `1` |
| Boot timeout | 8000 ms |
| Default call timeout | 30000 ms |
| `extract` / `pack` timeout | 120000 ms |
| WASM timeout | 1000–60000 ms (default 10000) |
| Network timeout | 1000–120000 ms (default 30000) |

If you find a mismatch between this guide and the app's behavior, **the code in `src/plugins.ts` wins**; please open an issue so the guide can be updated.
