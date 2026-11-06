// @module artemis.rs: Artemis engine support (PFS archives + AST Lua scripts).
//
// Pure Rust, no external tools, so it runs on every platform this app builds
// for, including Android. Formats reverse-engineered from a PS4 dump (CUSA14324)
// and cross-checked against GARbro's ArcPFS.cs:
//   - PFS "pfN" volumes: magic "pf" + version char, uint32 index_size at
//     offset 3, int32 count at offset 7, index bytes [7 .. 7+index_size)
//     starting with the count field. Entry (v6/v8): name_len i32, name bytes,
//     4 reserved bytes, offset u32, size u32. Versions 4/5/8/9 encrypt every
//     entry's data with XOR(key[i % 20]) where key = SHA-1(index bytes); the
//     keystream restarts at each entry. v2 uses a wider, unverified stride.
//   - Each volume (root.pfs, root.pfs.000 ...) is an independent archive.
//   - .ast scripts are Lua: `ast = { {flow pages}, ..., text = { [N] = {
//     ja = { name={"name", name="..."}, { "part", {"rt2"}, "part" } } } } }`.
//     Flow pages reference text entries in order; `{"rt2"}` is an inline
//     line-break marker; choices are `{"select", label=..., text=...}` where
//     only `text` is displayed and `label` is a routing key that must stay
//     untouched.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use sha1::{Digest, Sha1};
use walkdir::WalkDir;

use crate::engine::cache::GameCache;
use crate::engine::traits::GameEngine;use crate::engine::types::{
    ArchiveCandidate, EngineDetectionResult, ExportPatchOptions, ExtractionOptions, PatchArtifact,
    ReadScenarioOptions, ScenarioTextLine,
};
use crate::engine::word_wrap::wrap_text;

/// Flow-page `select` choices are keyed `scene_index = OFFSET + page_position`
/// so they never collide with `text[N]` scene indexes.
const SELECT_SCENE_OFFSET: usize = 1_000_000;

pub struct ArtemisEngine;

struct PfsEntry {
    name: String,
    offset: u64,
    size: u64,
}

struct PfsVolume {
    path: PathBuf,
    version: u8,
    /// Raw index bytes: file[7 .. 7+index_size), including the leading count
    /// field, because the SHA-1 data key is computed over exactly these bytes.
    index_bytes: Vec<u8>,
    entries: Vec<PfsEntry>,
}

fn read_u32(b: &[u8], pos: usize) -> u32 {
    u32::from(b[pos]) | (u32::from(b[pos + 1]) << 8) | (u32::from(b[pos + 2]) << 16) | (u32::from(b[pos + 3]) << 24)
}

fn read_i32(b: &[u8], pos: usize) -> i32 {
    read_u32(b, pos) as i32
}

impl PfsVolume {
    /// Matches `*.pfs` and split volumes `*.pfs.000` to `*.pfs.999`.
    fn is_pfs(path: &Path) -> bool {
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("").to_lowercase();
        let parts: Vec<&str> = name.split('.').collect();
        if parts.len() == 2 {
            parts[1] == "pfs" && !parts[0].is_empty()
        } else if parts.len() == 3 {
            parts[1] == "pfs" && parts[2].len() == 3 && parts[2].bytes().all(|b| b.is_ascii_digit())
        } else {
            false
        }
    }

    fn open(path: &Path) -> Result<Self, String> {
        use std::io::{Read, Seek, SeekFrom};
        let mut f = fs::File::open(path).map_err(|e| format!("Gagal membuka {}: {}", path.display(), e))?;
        let mut head = [0u8; 11];
        f.read_exact(&mut head).map_err(|e| format!("Header {} terlalu pendek: {}", path.display(), e))?;

        if &head[0..2] != b"pf" || !head[2].is_ascii_digit() {
            return Err(format!("{} bukan arsip PFS (magic {:?}).", path.display(), String::from_utf8_lossy(&head[0..3])));
        }
        let version = head[2];
        let index_size = read_u32(&head, 3);
        let count = read_i32(&head, 7);
        if count < 0 || index_size < 4 {
            return Err(format!("{}: header PFS tidak valid.", path.display()));
        }

        f.seek(SeekFrom::Start(7)).map_err(|e| format!("Gagal membaca index {}: {}", path.display(), e))?;
        let mut index_bytes = vec![0u8; index_size as usize];
        f.read_exact(&mut index_bytes).map_err(|e| format!("Gagal membaca index {}: {}", path.display(), e))?;

        let mut entries = Vec::with_capacity(count as usize);
        // v6/v8 entries begin right after the 4-byte count field.
        let mut pos: usize = if version == b'2' { 8 } else { 4 };
        for i in 0..count as usize {
            if pos + 4 > index_bytes.len() {
                return Err(format!("{}: index terpotong di entri {}.", path.display(), i));
            }
            let nlen = read_i32(&index_bytes, pos) as usize;
            if pos + 4 + nlen > index_bytes.len() {
                return Err(format!("{}: panjang nama tidak valid di entri {}.", path.display(), i));
            }
            pos += 4;
            let name = String::from_utf8_lossy(&index_bytes[pos..pos + nlen]).to_string();
            pos += nlen;
            // v6/v8: 4 reserved bytes before offset; pf2's name section is
            // padded to nlen + 0x10 (best-effort, unverified).
            pos += if version == b'2' { 0x10 - 4 } else { 4 };
            if pos + 8 > index_bytes.len() {
                return Err(format!("{}: index terpotong (offset/size) di entri {}.", path.display(), i));
            }
            let offset = read_u32(&index_bytes, pos);
            let size = read_u32(&index_bytes, pos + 4);
            pos += 8;
            entries.push(PfsEntry { name, offset: offset as u64, size: size as u64 });
        }

        Ok(PfsVolume { path: path.to_path_buf(), version, index_bytes, entries })
    }

    fn encrypted(&self) -> bool {
        matches!(self.version, b'4' | b'5' | b'8' | b'9')
    }

    fn data_key(&self) -> Vec<u8> {
        let mut hasher = Sha1::new();
        hasher.update(&self.index_bytes);
        hasher.finalize().to_vec()
    }

    /// Decrypts a single entry. The XOR keystream restarts at each entry.
    fn read_entry(&self, entry: &PfsEntry) -> Result<Vec<u8>, String> {
        use std::io::{Read, Seek, SeekFrom};
        let mut f = fs::File::open(&self.path).map_err(|e| format!("Gagal membuka {}: {}", self.path.display(), e))?;
        f.seek(SeekFrom::Start(entry.offset)).map_err(|e| format!("Gagal membaca entri {}: {}", entry.name, e))?;
        let mut data = vec![0u8; entry.size as usize];
        f.read_exact(&mut data).map_err(|e| format!("Gagal membaca entri {}: {}", entry.name, e))?;
        if self.encrypted() {
            let key = self.data_key();
            for (i, b) in data.iter_mut().enumerate() {
                *b ^= key[i % key.len()];
            }
        }
        Ok(data)
    }

    fn ast_entries(&self) -> Vec<&PfsEntry> {
        self.entries.iter().filter(|e| e.name.to_lowercase().ends_with(".ast")).collect()
    }
}

/// All PFS volumes directly inside `game_dir` (not recursive).
fn find_pfs_volumes(game_dir: &Path) -> Vec<PathBuf> {
    let mut vols: Vec<PathBuf> = fs::read_dir(game_dir)
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_file() && PfsVolume::is_pfs(p))
        .collect();
    vols.sort();
    vols
}

/// A string literal's byte span (inclusive of quotes) plus its unescaped value.
#[derive(Clone)]
struct StrSpan {
    start: usize,
    end: usize, // exclusive, after closing quote
    value: String,
}

#[derive(Clone)]
struct AstRun {
    /// Byte span of the whole run table, for verbatim reconstruction.
    start: usize,
    end: usize,
    parts: Vec<StrSpan>,
}

#[derive(Clone)]
struct AstLangBlock {
    lang: String,
    /// Span of the block CONTENT (between `lang={` and the matching `}`).
    content_start: usize,
    content_end: usize,
    /// Span of the whole `name={...}` def, if the block has one.
    name_def: Option<(usize, usize)>,
    /// Span of the DISPLAYED speaker string. Artemis name defs carry the
    /// identity in `name=` and may override the nameplate with `text=` (e.g.
    /// ？？？ before a character is revealed); the displayed one is translated.
    speaker: Option<StrSpan>,
    runs: Vec<AstRun>,
}

struct AstTextEntry {
    scene_index: usize,
    lang_block: AstLangBlock,
}

struct AstSelect {
    page_pos: usize,
    select_idx: usize,
    /// Span of the display string inside `text="..."`.
    text: StrSpan,
}

struct AstFile {
    text_entries: Vec<AstTextEntry>,
    selects: Vec<AstSelect>,
}

fn lua_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 8);
    for c in s.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            _ => out.push(c),
        }
    }
    out
}

/// Minimal Lua-table scanner: whitespace, idents, numbers, quoted strings
/// (escape-aware) and `{}` blocks (string-aware brace matching). Spans are
/// absolute byte offsets in the source it was created from.
struct Scanner<'a> {
    src: &'a str,
    bytes: &'a [u8],
    pos: usize,
}

impl<'a> Scanner<'a> {
    fn new(src: &'a str) -> Self {
        Scanner { src, bytes: src.as_bytes(), pos: 0 }
    }

    /// Scanner over a sub-slice; spans returned by helpers stay relative to
    /// `src` start, so callers add `base` to map them onto the full file.
    fn new_at(src: &'a str, pos: usize) -> Self {
        Scanner { src, bytes: src.as_bytes(), pos }
    }

    fn peek(&self) -> Option<u8> {
        self.bytes.get(self.pos).copied()
    }

    fn skip_ws(&mut self) {
        while let Some(c) = self.peek() {
            if c.is_ascii_whitespace() {
                self.pos += 1;
            } else {
                break;
            }
        }
    }

    fn eat(&mut self, c: u8) -> bool {
        self.skip_ws();
        if self.peek() == Some(c) {
            self.pos += 1;
            true
        } else {
            false
        }
    }

    fn read_ident(&mut self) -> Option<String> {
        self.skip_ws();
        let start = self.pos;
        while let Some(c) = self.peek() {
            if c.is_ascii_alphanumeric() || c == b'_' {
                self.pos += 1;
            } else {
                break;
            }
        }
        if self.pos == start {
            None
        } else {
            Some(self.src[start..self.pos].to_string())
        }
    }

    fn read_number(&mut self) -> Option<i64> {
        self.skip_ws();
        let start = self.pos;
        while let Some(c) = self.peek() {
            if c.is_ascii_digit() {
                self.pos += 1;
            } else {
                break;
            }
        }
        if self.pos == start {
            None
        } else {
            self.src[start..self.pos].parse().ok()
        }
    }

    /// Reads a double-quoted Lua string. Returns a span relative to this
    /// scanner's `src`.
    fn read_string(&mut self) -> Option<StrSpan> {
        self.skip_ws();
        if self.peek() != Some(b'"') {
            return None;
        }
        let start = self.pos;
        self.pos += 1;
        let mut value = String::new();
        let mut escaped = false;
        while let Some(c) = self.src[self.pos..].chars().next() {
            self.pos += c.len_utf8();
            if escaped {
                match c {
                    'n' => value.push('\n'),
                    't' => value.push('\t'),
                    'r' => value.push('\r'),
                    other => value.push(other),
                }
                escaped = false;
                continue;
            }
            match c {
                '\\' => escaped = true,
                '"' => return Some(StrSpan { start, end: self.pos, value }),
                _ => value.push(c),
            }
        }
        None // unterminated
    }

    /// Starting at `{`, advances past the matching `}` (ignoring braces inside
    /// strings) and returns the offset just after it, relative to `src`.
    fn read_block_end(&mut self) -> Option<usize> {
        self.skip_ws();
        if self.peek() != Some(b'{') {
            return None;
        }
        let mut depth = 0usize;
        let mut i = self.pos;
        while i < self.bytes.len() {
            match self.bytes[i] {
                b'"' => {
                    i += 1;
                    while i < self.bytes.len() {
                        if self.bytes[i] == b'\\' {
                            i += 2;
                            continue;
                        }
                        if self.bytes[i] == b'"' {
                            break;
                        }
                        i += 1;
                    }
                }
                b'{' => depth += 1,
                b'}' => {
                    depth -= 1;
                    if depth == 0 {
                        self.pos = i + 1;
                        return Some(i + 1);
                    }
                }
                _ => {}
            }
            i += 1;
        }
        None
    }
}

fn parse_ast(src: &str) -> AstFile {
    let mut out = AstFile { text_entries: Vec::new(), selects: Vec::new() };

    // Header fields (astver, astname) may precede the table, so locate `ast = {`
    // instead of assuming it is the first statement.
    let mut probe = Scanner::new(src);
    let mut brace_pos = None;
    loop {
        probe.skip_ws();
        if probe.peek().is_none() {
            break;
        }
        let save = probe.pos;
        let mut found = false;
        if let Some(id) = probe.read_ident() {
            if id == "ast" && probe.eat(b'=') {
                probe.skip_ws();
                if probe.peek() == Some(b'{') {
                    brace_pos = Some(probe.pos);
                    found = true;
                }
            }
        }
        if found {
            break;
        }
        probe.pos = save + 1;
    }
    let Some(brace_pos) = brace_pos else { return out };

    let mut sc = Scanner::new_at(src, brace_pos);
    let Some(outer_end) = sc.read_block_end() else { return out };

    let mut page_pos = 0usize;
    let mut next_scene = 0usize;
    let mut body = Scanner::new_at(&src[..outer_end], brace_pos + 1);
    scan_ast_body(&mut body, &mut page_pos, &mut next_scene, &mut out);
    out
}

/// Walks one table body. Handles flow pages, `[N] =` pages, `text = {...}`, and
/// the `block_* = {...}` wrappers that hold both.
fn scan_ast_body(sc: &mut Scanner, page_pos: &mut usize, next_scene: &mut usize, out: &mut AstFile) {
    loop {
        sc.skip_ws();
        match sc.peek() {
            None | Some(b'}') => break,
            Some(b',') => {
                sc.pos += 1;
            }
            Some(b'{') => {
                parse_flow_page(sc, *page_pos, &mut out.selects);
                *page_pos += 1;
            }
            Some(b'[') => {
                sc.pos += 1;
                let _ = sc.read_number();
                let _ = sc.eat(b']');
                let _ = sc.eat(b'=');
                parse_flow_page(sc, *page_pos, &mut out.selects);
                *page_pos += 1;
            }
            Some(_) => {
                let save = sc.pos;
                let Some(id) = sc.read_ident() else {
                    sc.pos = save + 1;
                    continue;
                };
                if !sc.eat(b'=') {
                    sc.pos = save + 1;
                    continue;
                }
                sc.skip_ws();
                if sc.peek() != Some(b'{') {
                    if sc.read_string().is_none() {
                        sc.pos = save + 1;
                    }
                    continue;
                }
                if id == "text" {
                    parse_text_table(sc, &mut out.text_entries, next_scene);
                    continue;
                }
                let base = sc.pos;
                let Some(block_end) = sc.read_block_end() else { break };
                if id.starts_with("block") || id.starts_with("page") {
                    let mut inner = Scanner::new_at(&sc.src[..block_end], base + 1);
                    scan_ast_body(&mut inner, page_pos, next_scene, out);
                }
            }
        }
    }
}

/// Parses a flow page `{ {"cmd", ...}, ..., line=N }`, collecting the display
/// strings of `{"select", label=..., text="..."}` commands.
fn parse_flow_page(sc: &mut Scanner, page_pos: usize, selects: &mut Vec<AstSelect>) {
    sc.skip_ws();
    if sc.peek() != Some(b'{') {
        return;
    }
    let base = sc.pos;
    let page_end = match sc.read_block_end() {
        Some(e) => e,
        None => return,
    };

    let mut inner = Scanner::new_at(&sc.src[..page_end], base + 1);
    let mut select_idx = 0usize;
    loop {
        inner.skip_ws();
        match inner.peek() {
            None | Some(b'}') => break,
            Some(b',') => {
                inner.pos += 1;
            }
            Some(b'{') => {
                let cmd_base = inner.pos;
                let cmd_end = inner.read_block_end().unwrap_or(cmd_base + 1);
                let cmd_text = &inner.src[cmd_base..cmd_end];
                if cmd_text.starts_with("{\"select\"") {
                    if let Some(v) = find_keyed_string(cmd_text, "text") {
                        selects.push(AstSelect {
                            page_pos,
                            select_idx,
                            text: StrSpan {
                                start: cmd_base + v.start,
                                end: cmd_base + v.end,
                                value: v.value,
                            },
                        });
                    }
                    select_idx += 1;
                }
            }
            Some(_) => {
                inner.pos += 1;
            }
        }
    }
}

/// Scans `key="value", ...` style items for the string value of `wanted`.
/// Descends into nested tables: `name={"name", name="朝陽"}` resolves to the
/// inner string, and whole commands like `{"select", label=..., text=...}`
/// can be passed including their braces. Spans are relative to `src`.
fn find_keyed_string(src: &str, wanted: &str) -> Option<StrSpan> {
    let mut sc = Scanner::new(src);
    loop {
        sc.skip_ws();
        match sc.peek() {
            None | Some(b'}') => break,
            Some(b',') => {
                sc.pos += 1;
            }
            Some(b'{') => {
                // Nested table: the wanted key may live inside.
                let base = sc.pos;
                let end = sc.read_block_end()?;
                if let Some(found) = find_keyed_string(&src[base + 1..end - 1], wanted) {
                    return Some(StrSpan {
                        start: base + 1 + found.start,
                        end: base + 1 + found.end,
                        value: found.value,
                    });
                }
            }
            Some(_) => {
                let save = sc.pos;
                match sc.read_ident() {
                    Some(key) if sc.eat(b'=') => {
                        if sc.peek() == Some(b'"') {
                            if key == wanted {
                                return sc.read_string();
                            }
                            let _ = sc.read_string();
                        } else if sc.peek() == Some(b'{') {
                            // Descend into table values regardless of the key:
                            // name={"name", name="X", text="Y"} holds both inside.
                            let base = sc.pos;
                            let end = sc.read_block_end()?;
                            if let Some(found) = find_keyed_string(&src[base + 1..end - 1], wanted) {
                                return Some(StrSpan {
                                    start: base + 1 + found.start,
                                    end: base + 1 + found.end,
                                    value: found.value,
                                });
                            }
                        } else {
                            // number / bool / nil bare token
                            while let Some(c) = sc.peek() {
                                if c == b',' || c == b'}' {
                                    break;
                                }
                                sc.pos += 1;
                            }
                        }
                    }
                    // Bare string element (e.g. the "name" tag inside a name
                    // def) or anything unparsable: step past it.
                    _ => {
                        sc.pos = save + 1;
                    }
                }
            }
        }
    }
    None
}

/// Parses `text = { [N] = { lang = {...}, ... }, ... }` (called after the
/// `text` ident and `=` were consumed).
fn parse_text_table(sc: &mut Scanner, entries: &mut Vec<AstTextEntry>, next_scene: &mut usize) {
    sc.skip_ws();
    if sc.peek() != Some(b'{') {
        return;
    }
    let base = sc.pos;
    let table_end = match sc.read_block_end() {
        Some(e) => e,
        None => return,
    };

    // Two layouts ship in the wild:
    //   text = { [0] = { ja = {...} }, [1] = { ja = {...} } }
    //   text = { ja = { {"line"}, {"line"} }, en = {...} }
    // The indexed form is detected first; otherwise the whole table is one entry.
    let mut inner = Scanner::new_at(&sc.src[..table_end], base + 1);
    let mut indexed: Vec<AstTextEntry> = Vec::new();
    let mut has_index = false;

    loop {
        inner.skip_ws();
        match inner.peek() {
            None | Some(b'}') => break,
            Some(b',') => {
                inner.pos += 1;
            }
            Some(b'[') => {
                has_index = true;
                inner.pos += 1;
                let scene_index = inner.read_number().unwrap_or(0).max(0) as usize;
                let _ = inner.eat(b']');
                let _ = inner.eat(b'=');
                if let Some(entry) = parse_text_entry(&mut inner, scene_index) {
                    indexed.push(entry);
                }
            }
            // Dialogue text can contain `[`, so a bare byte scan would mistake
            // it for the indexed layout and drop the whole table.
            Some(b'"') => {
                let _ = inner.read_string();
            }
            Some(_) => {
                inner.pos += 1;
            }
        }
    }

    if has_index {
        *next_scene += indexed.len();
        entries.extend(indexed);
        return;
    }

    // No explicit index, so number the table positionally. Read and export both
    // derive the key from this counter, which keeps them in sync.
    let mut direct = Scanner::new_at(&sc.src[..table_end], base + 1);
    if let Some(entry) = parse_lang_blocks(&mut direct, *next_scene) {
        entries.push(entry);
    }
    *next_scene += 1;
}

/// Parses one text entry `{ ja = {...}, en = {...} }`. Prefers the `ja`
/// language block; falls back to the first language found.
fn parse_text_entry(sc: &mut Scanner, scene_index: usize) -> Option<AstTextEntry> {
    sc.skip_ws();
    if sc.peek() != Some(b'{') {
        return None;
    }
    let base = sc.pos;
    let entry_end = sc.read_block_end()?;

    let mut inner = Scanner::new_at(&sc.src[..entry_end], base + 1);
    parse_lang_blocks(&mut inner, scene_index)
}

/// Collects `lang = {...}` blocks and keeps `ja`, falling back to the first one.
fn parse_lang_blocks(inner: &mut Scanner, scene_index: usize) -> Option<AstTextEntry> {
    let mut blocks: Vec<AstLangBlock> = Vec::new();
    loop {
        inner.skip_ws();
        match inner.peek() {
            None | Some(b'}') => break,
            Some(b',') => {
                inner.pos += 1;
            }
            Some(b'"') => {
                let _ = inner.read_string();
            }
            Some(_) => {
                let save = inner.pos;
                match inner.read_ident() {
                    Some(lang) if inner.eat(b'=') => {
                        if let Some(block) = parse_lang_block(&lang, inner) {
                            blocks.push(block);
                        } else {
                            inner.pos = save + 1;
                        }
                    }
                    _ => {
                        inner.pos = save + 1;
                    }
                }
            }
        }
    }

    blocks
        .iter()
        .find(|b| b.lang == "ja")
        .or_else(|| blocks.first())
        .map(|b| AstTextEntry { scene_index, lang_block: b.clone() })
}

/// Parses `lang = { [name={...}] [runs...] }`, called after the lang ident and
/// `=` were consumed. Spans are relative to the scanner's `src`.
fn parse_lang_block(lang: &str, sc: &mut Scanner) -> Option<AstLangBlock> {
    sc.skip_ws();
    if sc.peek() != Some(b'{') {
        return None;
    }
    let base = sc.pos;
    let block_end = sc.read_block_end()?;

    let mut inner = Scanner::new_at(&sc.src[..block_end], base + 1);
    let mut name_def: Option<(usize, usize)> = None;
    let mut speaker: Option<StrSpan> = None;
    let mut runs: Vec<AstRun> = Vec::new();

    loop {
        inner.skip_ws();
        match inner.peek() {
            None | Some(b'}') => break,
            Some(b',') => {
                inner.pos += 1;
            }
            Some(b'{') => {
                // A run: array of string parts + inline command tables.
                let run_base = inner.pos;
                let run_end = inner.read_block_end()?;
                let mut run_inner = Scanner::new_at(&inner.src[..run_end], run_base + 1);
                let mut parts: Vec<StrSpan> = Vec::new();
                loop {
                    run_inner.skip_ws();
                    match run_inner.peek() {
                        None | Some(b'}') => break,
                        Some(b',') => {
                            run_inner.pos += 1;
                        }
                        Some(b'"') => {
                            if let Some(s) = run_inner.read_string() {
                                // run_inner slices from offset 0, so its spans
                                // are already absolute.
                                parts.push(s);
                            } else {
                                run_inner.pos += 1;
                            }
                        }
                        Some(b'{') => {
                            let _ = run_inner.read_block_end(); // inline cmd like {"rt2"}
                        }
                        Some(_) => {
                            run_inner.pos += 1;
                        }
                    }
                }
                runs.push(AstRun { start: run_base, end: run_end, parts });
            }
            Some(_) => {
                let save = inner.pos;
                if let Some(id) = inner.read_ident() {
                    if id == "name" && inner.eat(b'=') {
                        if let Some(def_end) = inner.read_block_end() {
                            name_def = Some((save, def_end));
                            let def_src = &inner.src[save..def_end];
                            let display = find_keyed_string(def_src, "text")
                                .or_else(|| find_keyed_string(def_src, "name"));
                            if let Some(s) = display {
                                speaker = Some(StrSpan {
                                    start: save + s.start,
                                    end: save + s.end,
                                    value: s.value,
                                });
                            }
                        }
                        continue;
                    }
                }
                inner.pos = save + 1;
            }
        }
    }

    Some(AstLangBlock {
        lang: lang.to_string(),
        content_start: base + 1,
        content_end: block_end - 1,
        name_def,
        speaker,
        runs,
    })
}

/// Message text of a run: string parts concatenated (`{"rt2"}` markers dropped).
fn run_message(run: &AstRun) -> String {
    run.parts.iter().map(|p| p.value.as_str()).collect()
}

/// Serializes a translated message as a Lua run: wrapped to `max_chars`,
/// quoted, re-joined with `{"rt2"}` line-break markers:
/// `{ "part1", {"rt2"}, "part2" }`.
fn build_run_parts(trans: &str, max_chars: usize, wrap: bool) -> String {
    let wrapped = if wrap { wrap_text(trans, max_chars, "\u{0}") } else { trans.to_string() };
    let marker = if wrap { '\u{0}' } else { '\n' };
    wrapped
        .split(marker)
        .flat_map(|s| s.split('\n'))
        .filter(|s| !s.is_empty())
        .map(|s| format!("\"{}\"", lua_escape(s)))
        .collect::<Vec<_>>()
        .join(", {\"rt2\"}, ")
}

struct VolumeSummary {
    volume: PfsVolume,
    ast_count: usize,
}

impl GameEngine for ArtemisEngine {
    fn id(&self) -> &'static str {
        "artemis"
    }

    fn display_name(&self) -> &'static str {
        "Artemis (PFS / AST)"
    }

    fn detect(&self, game_dir: &Path) -> Option<EngineDetectionResult> {
        let volumes = find_pfs_volumes(game_dir);
        if volumes.is_empty() {
            return None;
        }

        let mut summaries: Vec<VolumeSummary> = Vec::new();
        for path in &volumes {
            if let Ok(volume) = PfsVolume::open(path) {
                let ast_count = volume.ast_entries().len();
                summaries.push(VolumeSummary { volume, ast_count });
            }
        }
        if summaries.iter().all(|s| s.ast_count == 0) {
            return None;
        }

        // Volumes holding .ast scripts first, most scripts first.
        summaries.sort_by(|a, b| b.ast_count.cmp(&a.ast_count));

        let archives: Vec<ArchiveCandidate> = summaries
            .iter()
            .map(|s| ArchiveCandidate {
                name: s.volume.path.file_name().unwrap_or_default().to_string_lossy().to_string(),
                path: s.volume.path.to_string_lossy().to_string(),
                size_bytes: fs::metadata(&s.volume.path).map(|m| m.len()).unwrap_or(0),
                is_likely_scenario: s.ast_count > 0,
            })
            .collect();

        let primary = summaries
            .iter()
            .find(|s| s.ast_count > 0)
            .map(|s| s.volume.path.file_name().unwrap_or_default().to_string_lossy().to_string());
        let total_asts: usize = summaries.iter().map(|s| s.ast_count).sum();
        let main_vol = primary.clone().unwrap_or_default();

        Some(EngineDetectionResult {
            engine_id: self.id().to_string(),
            engine_name: self.display_name().to_string(),
            publisher: "Artemis Engine".to_string(),
            encryption_type: format!("PFS pf{}", summaries[0].volume.version as char),
            game_exe_path: None,
            game_exe_name: None,
            detected_exes: Vec::new(),
            primary_archive: primary,
            archives,
            notes: vec![format!("{} berkas skenario .ast terdeteksi di {}", total_asts, main_vol)],
            default_cache_dir: None,
        })
    }

    fn extract(
        &self,
        game_dir: &Path,
        archive_name: &str,
        cache_dir: &Path,
        _options: &ExtractionOptions,
        on_progress: &dyn Fn(&str, f32),
    ) -> Result<usize, String> {
        let cache = GameCache::at(cache_dir.to_path_buf())
            .map_err(|e| format!("Inisialisasi cache gagal: {}", e))?;

        // Reset the derived cache so switching targets never mixes runs.
        if cache.raw_extracted.exists() {
            fs::remove_dir_all(&cache.raw_extracted)
                .map_err(|e| format!("Gagal membersihkan cache lama: {}", e))?;
        }
        fs::create_dir_all(&cache.raw_extracted)
            .map_err(|e| format!("Gagal menyiapkan folder cache: {}", e))?;

        let volume_path = if Path::new(archive_name).exists() {
            PathBuf::from(archive_name)
        } else {
            game_dir.join(archive_name)
        };
        let volume = PfsVolume::open(&volume_path)?;
        let asts = volume.ast_entries();
        if asts.is_empty() {
            return Err(format!(
                "Tidak ada berkas .ast di {}. Pilih volume PFS yang berisi skenario.",
                volume_path.display()
            ));
        }

        on_progress(&format!("Mengekstrak {} skrip .ast...", asts.len()), 0.2);

        let total = asts.len();
        for (i, entry) in asts.iter().enumerate() {
            let data = volume.read_entry(entry)?;
            let rel = entry.name.replace('\\', "/");
            let dest = cache.raw_extracted.join(&rel);
            if let Some(parent) = dest.parent() {
                fs::create_dir_all(parent).map_err(|e| format!("Gagal membuat folder {}: {}", parent.display(), e))?;
            }
            fs::write(&dest, &data).map_err(|e| format!("Gagal menulis {}: {}", dest.display(), e))?;
            if i % 25 == 0 || i + 1 == total {
                on_progress(
                    &format!("Mengekstrak skrip .ast ({}/{})...", i + 1, total),
                    0.2 + 0.7 * (i as f32 + 1.0) / total as f32,
                );
            }
        }

        fs::write(cache_dir.join("engine.txt"), self.id())
            .map_err(|e| format!("Gagal menulis penanda engine: {}", e))?;

        on_progress(&format!("Ekstraksi selesai: {} skrip .ast.", total), 1.0);
        Ok(total)
    }

    fn read_lines(&self, cache_dir: &Path, _options: Option<&ReadScenarioOptions>) -> Result<Vec<ScenarioTextLine>, String> {
        let ast_root = cache_dir.join("raw_extracted");
        if !ast_root.exists() {
            return Err("Cache ekstraksi tidak ditemukan. Lakukan ekstraksi terlebih dahulu.".to_string());
        }

        let mut files: Vec<PathBuf> = WalkDir::new(&ast_root)
            .into_iter()
            .flatten()
            .filter(|e| {
                e.file_type().is_file()
                    && e.path().extension().and_then(|x| x.to_str()).map(|x| x.to_lowercase()).as_deref() == Some("ast")
            })
            .map(|e| e.path().to_path_buf())
            .collect();
        files.sort_by(|a, b| natural_cmp(&a.to_string_lossy(), &b.to_string_lossy()));

        let mut lines = Vec::new();
        let mut line_num = 1usize;

        for path in &files {
            let rel = path.strip_prefix(&ast_root).unwrap_or(path).to_string_lossy().replace('\\', "/");
            let src = fs::read_to_string(path).map_err(|e| format!("Gagal membaca {}: {}", path.display(), e))?;
            let ast = parse_ast(&src);

            for entry in &ast.text_entries {
                let block = &entry.lang_block;
                let speaker = block.speaker.as_ref().map(|s| s.value.clone());
                for (run_idx, run) in block.runs.iter().enumerate() {
                    let message = run_message(run);
                    if message.trim().is_empty() {
                        continue;
                    }
                    lines.push(ScenarioTextLine {
                        file: rel.clone(),
                        line_num,
                        scene_index: entry.scene_index,
                        text_index: run_idx,
                        speaker: speaker.clone(),
                        message,
                        trans_speaker: None,
                        trans_message: None,
                    });
                    line_num += 1;
                }
            }

            for sel in &ast.selects {
                if sel.text.value.trim().is_empty() {
                    continue;
                }
                lines.push(ScenarioTextLine {
                    file: rel.clone(),
                    line_num,
                    scene_index: SELECT_SCENE_OFFSET + sel.page_pos,
                    text_index: sel.select_idx,
                    speaker: None,
                    message: sel.text.value.clone(),
                    trans_speaker: None,
                    trans_message: None,
                });
                line_num += 1;
            }
        }

        Ok(lines)
    }

    fn export_patch(
        &self,
        game_dir: &Path,
        cache_dir: &Path,
        lines: &[ScenarioTextLine],
        options: &ExportPatchOptions,
        on_progress: &dyn Fn(&str, f32),
    ) -> Result<PatchArtifact, String> {
        let ast_root = cache_dir.join("raw_extracted");

        // Only translated lines produce edits; everything else in the volume
        // stays byte-identical. Speaker translation applies to the whole text
        // entry because all runs share the name field.
        let mut msgs: HashMap<(String, usize, usize), String> = HashMap::new();
        let mut speakers: HashMap<(String, usize), String> = HashMap::new();
        for l in lines {
            let trans = l.trans_message.as_deref().map(str::trim).filter(|s| !s.is_empty());
            let trans_speaker = l.trans_speaker.as_deref().map(str::trim).filter(|s| !s.is_empty());
            let key = (normalize_rel(&l.file), l.scene_index);
            if let Some(t) = trans {
                msgs.insert((key.0.clone(), key.1, l.text_index), t.to_string());
            }
            if let Some(s) = trans_speaker {
                speakers.insert(key.clone(), s.to_string());
            }
        }
        if msgs.is_empty() && speakers.is_empty() {
            return Err("Tidak ada terjemahan untuk diekspor.".to_string());
        }

        let mut ast_paths: Vec<PathBuf> = WalkDir::new(&ast_root)
            .into_iter()
            .flatten()
            .filter(|e| {
                e.file_type().is_file()
                    && e.path().extension().and_then(|x| x.to_str()).map(|x| x.to_lowercase()).as_deref() == Some("ast")
            })
            .map(|e| e.path().to_path_buf())
            .collect();
        ast_paths.sort();

        let mut edited_files: HashMap<String, Vec<u8>> = HashMap::new();
        for path in &ast_paths {
            let rel = normalize_rel(path.strip_prefix(&ast_root).unwrap_or(path).to_string_lossy().as_ref());
            let has_file_edits = msgs.keys().any(|k| k.0 == rel) || speakers.keys().any(|k| k.0 == rel);
            if !has_file_edits {
                continue;
            }

            let src = fs::read_to_string(path).map_err(|e| format!("Gagal membaca {}: {}", path.display(), e))?;
            let ast = parse_ast(&src);
            let mut edits: Vec<(usize, usize, String)> = Vec::new();

            for entry in &ast.text_entries {
                let block = &entry.lang_block;
                let new_msg = |run_idx: usize| msgs.get(&(rel.clone(), entry.scene_index, run_idx)).cloned();
                let new_speaker = speakers.get(&(rel.clone(), entry.scene_index));

                let runs_changed: Vec<Option<String>> =
                    block.runs.iter().enumerate().map(|(i, _)| new_msg(i)).collect();
                let any_msg = runs_changed.iter().any(|r| r.is_some());
                let speaker_changed = new_speaker.is_some() && block.speaker.is_some();
                if !any_msg && !speaker_changed {
                    continue;
                }

                // Rebuild the block: the original name def (only the displayed
                // string swapped) then the runs, comma-joined. Untouched runs
                // are copied verbatim.
                let mut pieces: Vec<String> = Vec::new();
                if let Some((ds, de)) = block.name_def {
                    let mut def_text = src[ds..de].to_string();
                    if let (Some(s), Some(trans)) = (block.speaker.as_ref(), new_speaker) {
                        let quoted = format!("\"{}\"", lua_escape(trans));
                        def_text.replace_range((s.start - ds)..(s.end - ds), &quoted);
                    }
                    pieces.push(def_text);
                }
                for (run, replacement) in block.runs.iter().zip(runs_changed.iter()) {
                    match replacement {
                        Some(trans) => pieces.push(format!("{{ {} }}", build_run_parts(trans, options.max_chars_per_line, options.enable_word_wrap))),
                        None => pieces.push(src[run.start..run.end].to_string()),
                    }
                }

                edits.push((block.content_start, block.content_end, pieces.join(",\n")));
            }

            for sel in &ast.selects {
                if let Some(trans) = msgs.get(&(rel.clone(), SELECT_SCENE_OFFSET + sel.page_pos, sel.select_idx)) {
                    edits.push((
                        sel.text.start,
                        sel.text.end,
                        format!("\"{}\"", lua_escape(trans)),
                    ));
                }
            }

            if edits.is_empty() {
                continue;
            }

            // Splice edits back-to-front so spans stay valid.
            edits.sort_by(|a, b| b.0.cmp(&a.0));
            let mut bytes = src.into_bytes();
            for (start, end, replacement) in edits {
                bytes.splice(start..end, replacement.into_bytes());
            }
            edited_files.insert(entry_name_for(&rel), bytes);
        }

        if edited_files.is_empty() {
            return Err("Tidak ada berkas .ast yang cocok dengan terjemahan.".to_string());
        }

        on_progress("Menyusun volume patch PFS...", 0.5);

        // The engine mounts `root.pfs` then `root.pfs.000`, `.001`, ... in
        // ascending order, and later volumes override earlier ones on name
        // collisions. A patch therefore ships as a small override volume
        // holding only the edited scripts; the originals stay untouched.
        let volumes = find_pfs_volumes(game_dir);
        let mut source: Option<(PathBuf, PfsVolume)> = None;
        for p in &volumes {
            if let Ok(v) = PfsVolume::open(p) {
                if v.entries.iter().any(|e| edited_files.contains_key(e.name.as_str())) {
                    source = Some((p.clone(), v));
                    break;
                }
            }
        }
        let (source_path, source_volume) =
            source.ok_or_else(|| "Arsip PFS sumber tidak ditemukan di folder game.".to_string())?;

        let out_dir = options
            .output_dir
            .as_ref()
            .map(PathBuf::from)
            .unwrap_or_else(|| game_dir.join("patch_output"));
        fs::create_dir_all(&out_dir).map_err(|e| format!("Gagal membuat folder output: {}", e))?;

        let source_name = source_path.file_name().unwrap_or_default().to_string_lossy().to_string();
        let patch_name = next_volume_name(game_dir, &source_name)?;
        let out_path = out_dir.join(&patch_name);
        build_override_volume(&source_volume, &edited_files, &out_path, on_progress)?;

        if options.install_to_game {
            fs::copy(&out_path, game_dir.join(&patch_name))
                .map_err(|e| format!("Gagal menyalin volume patch ke folder game: {}", e))?;
        }

        on_progress(&format!("Volume patch {} selesai.", patch_name), 1.0);
        // Artemis volumes are plain PFS, so there is no encryption step to skip.
        Ok(PatchArtifact {
            path: out_path,
            warning: None,
        })
    }
}

fn normalize_rel(name: &str) -> String {
    name.replace('\\', "/")
}

/// Cache-relative path ('/') → original PFS entry name ('\').
fn entry_name_for(rel: &str) -> String {
    rel.replace('/', "\\")
}

/// Name for the patch override volume: `<base>.pfs.<NNN>`, one past the highest
/// numbered volume already in the game folder, so the engine mounts (and
/// overrides with) the patch last. E.g. `root.pfs` plus `.000` to `.002` gives
/// `root.pfs.003`.
fn next_volume_name(game_dir: &Path, source_name: &str) -> Result<String, String> {
    let lower = source_name.to_lowercase();
    let base_end = lower
        .find(".pfs")
        .map(|i| i + 4)
        .ok_or_else(|| format!("Nama volume tidak valid: {}", source_name))?;
    let base = &source_name[..base_end];
    let base_lower = &lower[..base_end];

    let mut max_n: i32 = -1;
    for p in find_pfs_volumes(game_dir) {
        let name = p.file_name().unwrap_or_default().to_string_lossy().to_string();
        let nl = name.to_lowercase();
        if let Some(rest) = nl.strip_prefix(base_lower) {
            if rest.len() == 4 && rest.starts_with('.') && rest[1..].bytes().all(|b| b.is_ascii_digit()) {
                max_n = max_n.max(rest[1..].parse::<i32>().unwrap_or(-1));
            }
        }
    }

    if max_n >= 999 {
        return Err("Slot volume PFS habis (root.pfs.999 sudah ada).".to_string());
    }
    Ok(format!("{}.{:03}", base, max_n + 1))
}

/// Serializes a PFS index: count field + entries (name_len, name, 4 reserved
/// bytes, offset u32, size u32), the layout observed in source volumes.
fn pfs_index_bytes(names: &[&str], layout: &[(u64, u64)]) -> Vec<u8> {
    let mut index = Vec::new();
    index.extend_from_slice(&(names.len() as i32).to_le_bytes());
    for (name, (off, size)) in names.iter().zip(layout.iter()) {
        let nb = name.as_bytes();
        index.extend_from_slice(&(nb.len() as i32).to_le_bytes());
        index.extend_from_slice(nb);
        index.extend_from_slice(&[0, 0, 0, 0]);
        index.extend_from_slice(&(*off as u32).to_le_bytes());
        index.extend_from_slice(&(*size as u32).to_le_bytes());
    }
    index
}

/// Writes a new override volume holding only the edited entries. Version and
/// encryption match the source volume; for encrypted versions the data key is
/// SHA-1 of this volume's own index.
fn build_override_volume(
    source: &PfsVolume,
    edits: &HashMap<String, Vec<u8>>,
    out_path: &Path,
    on_progress: &dyn Fn(&str, f32),
) -> Result<(), String> {
    use std::io::{Seek, SeekFrom, Write};

    let mut names: Vec<&str> = edits.keys().map(|s| s.as_str()).collect();
    names.sort_by(|a, b| natural_cmp(a, b));

    // Index length is fixed (name lengths known), so one placeholder pass
    // gives the data start and the real pass fills absolute offsets.
    let zero_layout: Vec<(u64, u64)> = vec![(0, 0); names.len()];
    let placeholder = pfs_index_bytes(&names, &zero_layout);
    let mut data_offset = 7 + placeholder.len() as u64;
    let mut layout: Vec<(u64, u64)> = Vec::with_capacity(names.len());
    for name in &names {
        let size = edits[*name].len() as u64;
        layout.push((data_offset, size));
        data_offset += size;
    }
    let index = pfs_index_bytes(&names, &layout);
    debug_assert_eq!(index.len(), placeholder.len());

    let key = source.encrypted().then(|| {
        let mut hasher = Sha1::new();
        hasher.update(&index);
        hasher.finalize().to_vec()
    });

    let mut header = Vec::with_capacity(11);
    header.extend_from_slice(b"pf");
    header.push(source.version);
    header.extend_from_slice(&(index.len() as u32).to_le_bytes());
    header.extend_from_slice(&(names.len() as i32).to_le_bytes());

    let mut out = fs::File::create(out_path).map_err(|e| format!("Gagal membuat {}: {}", out_path.display(), e))?;
    out.write_all(&header).map_err(|e| e.to_string())?;
    // The header already carries the count (file offset 7); the keyed index
    // blob includes that same count field, so only the entry part goes here.
    out.write_all(&index[4..]).map_err(|e| e.to_string())?;

    for (i, name) in names.iter().enumerate() {
        let mut data = edits[*name].clone();
        if let Some(key) = &key {
            for (j, b) in data.iter_mut().enumerate() {
                *b ^= key[j % key.len()];
            }
        }
        out.seek(SeekFrom::Start(layout[i].0))
            .and_then(|_| out.write_all(&data))
            .map_err(|e| format!("Gagal menulis entri {}: {}", name, e))?;
    }

    on_progress(&format!("{} entri dikemas.", names.len()), 0.9);
    Ok(())
}

/// Natural alphanumeric comparator (mirrors the Kirikiri engine's ordering).
fn natural_cmp(s1: &str, s2: &str) -> std::cmp::Ordering {
    let mut a = s1.chars().peekable();
    let mut b = s2.chars().peekable();
    loop {
        match (a.peek().copied(), b.peek().copied()) {
            (None, None) => return std::cmp::Ordering::Equal,
            (None, Some(_)) => return std::cmp::Ordering::Less,
            (Some(_), None) => return std::cmp::Ordering::Greater,
            (Some(x), Some(y)) => {
                if x.is_ascii_digit() && y.is_ascii_digit() {
                    let mut na = String::new();
                    while let Some(c) = a.peek() {
                        if c.is_ascii_digit() {
                            na.push(*c);
                            a.next();
                        } else {
                            break;
                        }
                    }
                    let mut nb = String::new();
                    while let Some(c) = b.peek() {
                        if c.is_ascii_digit() {
                            nb.push(*c);
                            b.next();
                        } else {
                            break;
                        }
                    }
                    let va: u64 = na.parse().unwrap_or(0);
                    let vb: u64 = nb.parse().unwrap_or(0);
                    if va != vb {
                        return va.cmp(&vb);
                    }
                } else {
                    a.next();
                    b.next();
                    if x != y {
                        return x.cmp(&y);
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    

    const TEST_GAME_DIR: &str = r"F:\Visual Novels\CUSA14324";

    #[test]
    fn test_parse_ast_names_selects_and_runs() {
        // Mirrors the real structure: flow pages + text table with a speaker
        // name def, an rt2-split run, and select choices.
        let src = r#"ast = {
	{"bg", file="bg01", path=":bg/"},
	{
		{"select", label="１いや、違う", text="『いや、違う』"},
		{"select", label="２わかった", text="『わかった』"},
		{"select"},
		line=42,
	},
	{"text"},
	line=44,
	text={
		[1]={
			ja={
				{
					"地紋の電話、。",
				},
			},
		},
		[2]={
			ja={
				name={"name", name="朝陽"},
				{
					"「えーっと、この書類は……って、",
					{"rt2"},
					"下手すぎて全然読めないんですけど！」",
				},
			},
		},
		[3]={
			ja={
				name={"name", name="エリサ", text="少女"},
				{
					"「……」",
				},
			},
		},
	},
}"#;

        let ast = parse_ast(src);
        assert_eq!(ast.text_entries.len(), 3);
        assert_eq!(ast.selects.len(), 2, "select choices must be extracted");

        let narration = &ast.text_entries[0];
        assert_eq!(narration.scene_index, 1);
        assert!(narration.lang_block.speaker.is_none(), "narration has no speaker");
        assert_eq!(narration.lang_block.runs.len(), 1);
        assert_eq!(run_message(&narration.lang_block.runs[0]), "地紋の電話、。");

        let dialogue = &ast.text_entries[1];
        assert_eq!(dialogue.scene_index, 2);
        let speaker = dialogue.lang_block.speaker.as_ref().expect("speaker must be extracted");
        assert_eq!(speaker.value, "朝陽");
        assert_eq!(dialogue.lang_block.runs.len(), 1);
        assert_eq!(
            run_message(&dialogue.lang_block.runs[0]),
            "「えーっと、この書類は……って、下手すぎて全然読めないんですけど！」",
            "rt2-separated parts must join into one message"
        );

        assert_eq!(ast.selects[0].text.value, "『いや、違う』");
        assert_eq!(ast.selects[1].text.value, "『わかった』");

        // The speaker span must point at the real string (round-trip edit).
        let spk = dialogue.lang_block.speaker.as_ref().unwrap();
        assert_eq!(&src[spk.start..spk.end], "\"朝陽\"");

        // When the name def carries text=, that is the DISPLAYED nameplate
        // (identity stays in name=), so extract and point at it.
        let masked = &ast.text_entries[2];
        let mspk = masked.lang_block.speaker.as_ref().expect("masked speaker");
        assert_eq!(mspk.value, "少女", "text= overrides the displayed name");
        assert_eq!(&src[mspk.start..mspk.end], "\"少女\"");

        // Translated runs must be emitted as QUOTED Lua strings, re-joined
        // with rt2 markers.
        assert_eq!(
            build_run_parts("abcdefghij", 5, true),
            "\"abcde\", {\"rt2\"}, \"fghij\""
        );
        assert_eq!(build_run_parts("そのまま", 42, true), "\"そのまま\"");
    }

    #[test]
    fn test_detect_extract_read_export_artemis() {
        let game_dir = Path::new(TEST_GAME_DIR);
        if !game_dir.is_dir() {
            return; // machine-gated integration test
        }

        let engine = ArtemisEngine;

        // Regression: Kirikiri must NOT claim PS4 dumps (its old dir-scan
        // treated loose .json metadata as scenario evidence), so the registry
        // dispatcher has to fall through to Artemis.
        let registry = crate::engine::get_registered_engines();
        assert!(
            registry[0].detect(game_dir).is_none(),
            "Kirikiri detect must not match an Artemis PS4 dump"
        );
        assert!(registry[1].detect(game_dir).is_some(), "Artemis must match");

        let detection = engine.detect(game_dir).expect("Artemis must be detected");
        assert_eq!(detection.engine_id, "artemis");
        let primary = detection.primary_archive.expect("primary archive");
        println!("primary volume: {}", primary);
        println!("notes: {:?}", detection.notes);
        assert!(detection.archives.iter().any(|a| a.is_likely_scenario));

        let cache_dir = std::env::temp_dir().join("copastool_test_artemis");
        let opts = ExtractionOptions {
            target_archive: detection
                .archives
                .iter()
                .find(|a| a.name == primary)
                .map(|a| a.path.clone())
                .expect("primary archive path"),
            custom_cache_dir: None,
            force_refresh: false,
        };
        let count = engine
            .extract(game_dir, &opts.target_archive, &cache_dir, &opts, &|_s, _p| {})
            .expect("extraction succeeded");
        println!("extracted {} ast files", count);
        assert!(count > 0, "must extract AST scripts");

        let lines = engine.read_lines(&cache_dir, None).expect("read lines");
        println!("read {} lines", lines.len());
        assert!(lines.len() > 100, "must read dialogue lines");
        let sample: Vec<_> = lines.iter().take(3).map(|l| (l.file.as_str(), l.speaker.clone(), l.message.as_str())).collect();
        for s in &sample {
            println!("  {:?}", s);
        }
        assert!(lines.iter().any(|l| !l.message.is_empty()));

        // Speaker names must be extracted (dialogue lines carry name defs).
        let named = lines.iter().filter(|l| l.speaker.is_some()).count();
        println!("lines with speaker names: {}", named);
        assert!(named > 1000, "expected thousands of named dialogue lines, got {}", named);
        let some_name = lines.iter().find_map(|l| l.speaker.clone()).expect("at least one speaker");
        println!("example speaker: {}", some_name);

        let mut translated: Vec<ScenarioTextLine> = Vec::new();
        for (i, l) in lines.iter().enumerate().take(3) {
            let mut l = l.clone();
            l.trans_message = Some(format!("[Terjemahan uji {}] {}", i + 1, l.message));
            translated.push(l);
        }
        let out_dir = std::env::temp_dir().join("copastool_test_artemis_out");
        let export_opts = ExportPatchOptions {
            game_dir: game_dir.to_string_lossy().to_string(),
            cache_dir: cache_dir.to_string_lossy().to_string(),
            output_dir: Some(out_dir.to_string_lossy().to_string()),
            target_archive: opts.target_archive.clone(),
            language_index: 0,
            enable_word_wrap: true,
            max_chars_per_line: 42,
            extra_files_dir: None,
            install_to_game: false,
            patch_file_name: None,
        };
        let patch_path = engine
            .export_patch(game_dir, &cache_dir, &translated, &export_opts, &|_s, _p| {})
            .expect("export succeeded")
            .path;
        println!("patched volume: {}", patch_path.display());
        assert!(patch_path.exists());

        // The patch must be a new OVERRIDE volume (next free number after the
        // highest existing one), not a rewrite of the original: the engine
        // mounts ascending numbers and later volumes win.
        let expected_name = {
            let mut max_n: i32 = -1;
            for e in fs::read_dir(game_dir).expect("game dir").flatten() {
                let name = e.file_name().to_string_lossy().to_lowercase();
                if let Some(rest) = name.strip_prefix("root.pfs.") {
                    if rest.len() == 3 && rest.bytes().all(|b| b.is_ascii_digit()) {
                        max_n = max_n.max(rest.parse::<i32>().unwrap_or(-1));
                    }
                }
            }
            format!("root.pfs.{:03}", max_n + 1)
        };
        assert_eq!(
            patch_path.file_name().and_then(|n| n.to_str()),
            Some(expected_name.as_str()),
            "patch must be the next free override volume"
        );
        let original_size = fs::metadata(game_dir.join("root.pfs")).unwrap().len();

        // The patched volume must parse, decrypt, and contain the translation;
        // every unedited scene must stay byte-identical to the original, and
        // the file must be strict UTF-8 (catches mid-character splice
        // corruption).
        let patched = PfsVolume::open(&patch_path).expect("patched volume parses");
        assert_eq!(patched.ast_entries().len(), 1, "only the edited AST ships in the override volume");
        let mut found_translation = false;
        for entry in patched.ast_entries() {
            let data = patched.read_entry(entry).expect("decrypt entry");
            let text = String::from_utf8(data.clone()).expect("edited AST must be valid UTF-8");
            if text.contains("[Terjemahan uji 1]") {
                found_translation = true;
            }
            if let Some(first) = text.lines().next() {
                assert!(first.contains("ast"), "AST header broken in {}", entry.name);
            }

            // Unedited scenes must be untouched: parse both versions and
            // compare every scene outside the edited ones (1..=3).
            let patched_ast = parse_ast(&text);
            let source_volume = PfsVolume::open(game_dir.join("root.pfs").as_path()).expect("source volume");
            let source_entry = source_volume
                .entries
                .iter()
                .find(|e| e.name == entry.name)
                .expect("entry exists in source volume");
            let orig_text = String::from_utf8(source_volume.read_entry(source_entry).expect("decrypt original"))
                .expect("original AST is UTF-8");
            let orig_ast = parse_ast(&orig_text);
            assert_eq!(orig_ast.text_entries.len(), patched_ast.text_entries.len());
            assert_eq!(orig_ast.selects.len(), patched_ast.selects.len());
            for (o, p) in orig_ast.text_entries.iter().zip(patched_ast.text_entries.iter()) {
                if o.scene_index <= 3 {
                    continue; // intentionally edited
                }
                assert_eq!(o.scene_index, p.scene_index);
                match (&o.lang_block.speaker, &p.lang_block.speaker) {
                    (None, None) => {}
                    (Some(a), Some(b)) => assert_eq!(a.value, b.value, "speaker changed in scene {}", o.scene_index),
                    _ => panic!("speaker presence changed in scene {}", o.scene_index),
                }
                assert_eq!(
                    o.lang_block.runs.len(),
                    p.lang_block.runs.len(),
                    "run count changed in scene {}",
                    o.scene_index
                );
                for (ro, rp) in o.lang_block.runs.iter().zip(p.lang_block.runs.iter()) {
                    assert_eq!(run_message(ro), run_message(rp), "message changed in scene {}", o.scene_index);
                }
            }
            for (so, sp) in orig_ast.selects.iter().zip(patched_ast.selects.iter()) {
                assert_eq!(so.page_pos, sp.page_pos);
                assert_eq!(so.text.value, sp.text.value, "select text changed");
            }
        }
        assert!(found_translation, "translation must be present in patched volume");
        assert_eq!(
            fs::metadata(game_dir.join("root.pfs")).unwrap().len(),
            original_size,
            "original volume must stay untouched"
        );

        // Cleanup (keep artifacts for inspection with CT_KEEP_ARTIFACTS=1)
        if std::env::var("CT_KEEP_ARTIFACTS").is_err() {
            let _ = fs::remove_dir_all(&cache_dir);
            let _ = fs::remove_dir_all(&out_dir);
        }
    }
}
