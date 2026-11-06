//! Dependency-free XP3 writer (GARbro-compatible "version 1" layout).
//!
//! Kirikiri mounts `patch*.xp3` from the game folder, so a patch only has to be
//! a valid XP3. This writer produces the plain, unencrypted shape GARbro writes.
//!
//! Layout:
//! ```text
//! 0x00  11-byte magic "XP3\r\n \x1a\x8bg\x01"
//! 0x0b  u64 absolute offset of the index
//! 0x13  raw file data (uncompressed, unencrypted)
//! idx   u8 0 (index not compressed), u64 index size, then the entry list
//! ```
//! Each entry is a `File` section holding an `info` (flags/sizes/name), a `segm`
//! (one uncompressed data segment) and an `adlr` (Adler-32 of the data) section.

use std::fs;
use std::io::{BufWriter, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

/// "XP3\r\n \x1a\x8bg\x01": note the 0x0a (not 0x1a) at offset 6.
const XP3_MAGIC: [u8; 11] = [
    0x58, 0x50, 0x33, 0x0d, 0x0a, 0x20, 0x0a, 0x1a, 0x8b, 0x67, 0x01,
];

const SECTION_FILE: u32 = 0x656c_6946; // "File"
const SECTION_INFO: u32 = 0x6f66_6e69; // "info"
const SECTION_SEGM: u32 = 0x6d67_6573; // "segm"
const SECTION_ADLR: u32 = 0x726c_6461; // "adlr"

/// One file to store in the archive.
pub struct Xp3File {
    /// Name as the engine will look it up, using `/` for sub-folders.
    pub name: String,
    pub source: PathBuf,
}

struct Adler32 {
    a: u32,
    b: u32,
}

impl Adler32 {
    fn new() -> Self {
        Self { a: 1, b: 0 }
    }

    fn update(&mut self, data: &[u8]) {
        const MOD: u32 = 65521;
        // Modulo per byte: patch payloads are a few MB at most.
        for &byte in data {
            self.a = (self.a + byte as u32) % MOD;
            self.b = (self.b + self.a) % MOD;
        }
    }

    fn value(&self) -> u32 {
        (self.b << 16) | self.a
    }
}

/// Files that ended up in the archive, in write order.
struct WrittenEntry {
    name: String,
    offset: u64,
    size: u64,
    checksum: u32,
}

/// Every file under `root`, keyed by its `/`-separated relative path. A missing
/// folder is an error: an empty patch is never useful.
pub fn collect_files(root: &Path) -> Result<Vec<Xp3File>, String> {
    if !root.is_dir() {
        return Err(format!("Folder patch tidak ditemukan: {}", root.display()));
    }

    let mut files = Vec::new();
    for entry in walkdir::WalkDir::new(root).into_iter().flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let rel = match path.strip_prefix(root) {
            Ok(rel) => rel,
            Err(_) => continue,
        };
        let name = rel
            .components()
            .map(|c| c.as_os_str().to_string_lossy().to_string())
            .collect::<Vec<_>>()
            .join("/");
        if name.is_empty() {
            continue;
        }
        files.push(Xp3File {
            name,
            source: path.to_path_buf(),
        });
    }

    files.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(files)
}

/// Writes `files` to `output` as a plain (unencrypted, uncompressed) XP3.
pub fn write_plain_xp3(output: &Path, files: &[Xp3File]) -> Result<(), String> {
    if files.is_empty() {
        return Err("Tidak ada berkas untuk dikemas ke dalam patch.".to_string());
    }

    if let Some(parent) = output.parent() {
        let _ = fs::create_dir_all(parent);
    }

    {
        let handle = fs::File::create(output)
            .map_err(|e| format!("Gagal membuat {}: {}", output.display(), e))?;
        let mut out = BufWriter::new(handle);

        out.write_all(&XP3_MAGIC)
            .map_err(|e| format!("Gagal menulis header XP3: {}", e))?;
        // Index offset placeholder, patched once the index is written.
        out.write_all(&0u64.to_le_bytes())
            .map_err(|e| format!("Gagal menulis header XP3: {}", e))?;

        let mut written: Vec<WrittenEntry> = Vec::with_capacity(files.len());
        let mut position = (XP3_MAGIC.len() + 8) as u64;

        for file in files {
            let mut source = fs::File::open(&file.source)
                .map_err(|e| format!("Gagal membaca {}: {}", file.source.display(), e))?;

            let offset = position;
            let mut checksum = Adler32::new();
            let mut buffer = vec![0u8; 64 * 1024];
            let mut size: u64 = 0;

            loop {
                let read = source
                    .read(&mut buffer)
                    .map_err(|e| format!("Gagal membaca {}: {}", file.source.display(), e))?;
                if read == 0 {
                    break;
                }
                checksum.update(&buffer[..read]);
                out.write_all(&buffer[..read])
                    .map_err(|e| format!("Gagal menulis {}: {}", file.name, e))?;
                size += read as u64;
            }

            position += size;
            written.push(WrittenEntry {
                name: file.name.clone(),
                offset,
                size,
                checksum: checksum.value(),
            });
        }

        let index = build_index(&written)?;
        let index_offset = position;

        out.write_all(&index)
            .map_err(|e| format!("Gagal menulis indeks XP3: {}", e))?;
        out.flush()
            .map_err(|e| format!("Gagal menyelesaikan {}: {}", output.display(), e))?;

        // Fill in the real index offset now that its position is known.
        let mut handle = out
            .into_inner()
            .map_err(|e| format!("Gagal menulis {}: {}", output.display(), e))?;
        handle
            .seek(SeekFrom::Start(XP3_MAGIC.len() as u64))
            .map_err(|e| format!("Gagal memutakhirkan header XP3: {}", e))?;
        handle
            .write_all(&index_offset.to_le_bytes())
            .map_err(|e| format!("Gagal memutakhirkan header XP3: {}", e))?;
    }

    Ok(())
}

/// `u8 type(0 = plain) + u64 index_size + entries`, the shape Kirikiri's reader
/// (and GARbro) expect at the recorded index offset.
fn build_index(files: &[WrittenEntry]) -> Result<Vec<u8>, String> {
    let mut index = Vec::new();
    index.push(0u8); // index header type: 0 = stored uncompressed
    index.extend_from_slice(&0u64.to_le_bytes()); // size placeholder
    let entries_start = index.len();

    for file in files {
        let name_utf16: Vec<u16> = file.name.encode_utf16().collect();
        if name_utf16.len() > i16::MAX as usize {
            return Err(format!("Nama berkas terlalu panjang untuk XP3: {}", file.name));
        }

        let mut body = Vec::new();

        // info: flags + unpacked/packed size + name
        body.extend_from_slice(&SECTION_INFO.to_le_bytes());
        let info_size = 4 + 8 + 8 + 2 + name_utf16.len() * 2;
        body.extend_from_slice(&(info_size as i64).to_le_bytes());
        body.extend_from_slice(&0u32.to_le_bytes()); // flags: not encrypted
        body.extend_from_slice(&(file.size as i64).to_le_bytes()); // unpacked
        body.extend_from_slice(&(file.size as i64).to_le_bytes()); // packed
        body.extend_from_slice(&(name_utf16.len() as i16).to_le_bytes());
        for unit in &name_utf16 {
            body.extend_from_slice(&unit.to_le_bytes());
        }

        // segm: a single, uncompressed segment
        body.extend_from_slice(&SECTION_SEGM.to_le_bytes());
        body.extend_from_slice(&0x1ci64.to_le_bytes());
        body.extend_from_slice(&0i32.to_le_bytes()); // 0 = not compressed
        body.extend_from_slice(&(file.offset as i64).to_le_bytes());
        body.extend_from_slice(&(file.size as i64).to_le_bytes());
        body.extend_from_slice(&(file.size as i64).to_le_bytes());

        // adlr: Adler-32 of the stored data
        body.extend_from_slice(&SECTION_ADLR.to_le_bytes());
        body.extend_from_slice(&4i64.to_le_bytes());
        body.extend_from_slice(&file.checksum.to_le_bytes());

        index.extend_from_slice(&SECTION_FILE.to_le_bytes());
        index.extend_from_slice(&(body.len() as i64).to_le_bytes());
        index.extend_from_slice(&body);
    }

    let entries_size = index.len() - entries_start;
    index[1..9].copy_from_slice(&(entries_size as u64).to_le_bytes());
    Ok(index)
}

/// One stored file inside an archive. A file may be split across segments.
pub struct Xp3Entry {
    pub name: String,
    pub segments: Vec<Xp3Segment>,
}

pub struct Xp3Segment {
    pub offset: u64,
    pub unpacked: u64,
    pub packed: u64,
    pub compressed: bool,
}

fn read_u32_at(buf: &[u8], pos: usize) -> Option<u32> {
    buf.get(pos..pos + 4).map(|b| u32::from_le_bytes(b.try_into().unwrap()))
}

fn read_i64_at(buf: &[u8], pos: usize) -> Option<i64> {
    buf.get(pos..pos + 8).map(|b| i64::from_le_bytes(b.try_into().unwrap()))
}

/// Reads the index block. Type 0 is stored as-is; type 1 is zlib with the
/// packed and unpacked sizes ahead of the stream.
fn read_index_block(file: &mut fs::File) -> Result<Vec<u8>, String> {
    let mut kind = [0u8; 1];
    file.read_exact(&mut kind)
        .map_err(|e| format!("Gagal membaca tipe indeks XP3: {}", e))?;

    match kind[0] {
        0 => {
            let mut size = [0u8; 8];
            file.read_exact(&mut size)
                .map_err(|e| format!("Gagal membaca ukuran indeks XP3: {}", e))?;
            let size = u64::from_le_bytes(size) as usize;
            let mut buf = vec![0u8; size];
            file.read_exact(&mut buf)
                .map_err(|e| format!("Gagal membaca indeks XP3: {}", e))?;
            Ok(buf)
        }
        1 => {
            let mut sizes = [0u8; 16];
            file.read_exact(&mut sizes)
                .map_err(|e| format!("Gagal membaca ukuran indeks XP3: {}", e))?;
            let packed = u64::from_le_bytes(sizes[0..8].try_into().unwrap()) as usize;
            let unpacked = u64::from_le_bytes(sizes[8..16].try_into().unwrap()) as usize;

            let mut buf = vec![0u8; packed];
            file.read_exact(&mut buf)
                .map_err(|e| format!("Gagal membaca indeks XP3: {}", e))?;

            let mut out = Vec::with_capacity(unpacked);
            flate2::read::ZlibDecoder::new(&buf[..])
                .read_to_end(&mut out)
                .map_err(|e| format!("Indeks XP3 tidak bisa dibuka: {}", e))?;
            Ok(out)
        }
        other => Err(format!(
            "Indeks XP3 bertipe {} (terenkripsi). Arsip seperti ini tidak didukung.",
            other
        )),
    }
}

/// Parses the index into entries. Encrypted entries are dropped: their payload
/// cannot be read without the game key.
pub fn read_index(path: &Path) -> Result<Vec<Xp3Entry>, String> {
    let mut file = fs::File::open(path)
        .map_err(|e| format!("Gagal membuka {}: {}", path.display(), e))?;

    let mut header = [0u8; 19];
    file.read_exact(&mut header)
        .map_err(|e| format!("Gagal membaca header XP3: {}", e))?;
    if header[..11] != XP3_MAGIC {
        return Err(format!("{} bukan arsip XP3.", path.display()));
    }

    let index_offset = u64::from_le_bytes(header[11..19].try_into().unwrap());
    file.seek(SeekFrom::Start(index_offset))
        .map_err(|e| format!("Gagal menuju indeks XP3: {}", e))?;

    let index = read_index_block(&mut file)?;
    let mut entries = Vec::new();
    let mut pos = 0usize;

    while pos + 12 <= index.len() {
        let section = read_u32_at(&index, pos).unwrap_or(0);
        let section_size = read_i64_at(&index, pos + 4).unwrap_or(-1);
        if section != SECTION_FILE || section_size < 0 {
            break;
        }
        let body_start = pos + 12;
        let body_end = (body_start + section_size as usize).min(index.len());
        let body = &index[body_start..body_end];

        let mut name: Option<String> = None;
        let mut protected = false;
        let mut segments = Vec::new();
        let mut q = 0usize;

        while q + 12 <= body.len() {
            let sub = read_u32_at(body, q).unwrap_or(0);
            let sub_size = read_i64_at(body, q + 4).unwrap_or(-1);
            if sub_size < 0 {
                break;
            }
            let chunk_start = q + 12;
            let chunk_end = (chunk_start + sub_size as usize).min(body.len());
            let chunk = &body[chunk_start..chunk_end];

            match sub {
                SECTION_INFO => {
                    if let Some(flags) = read_u32_at(chunk, 0) {
                        protected = flags & 0x8000_0000 != 0;
                    }
                    if let Some(name_len) = chunk.get(20..22).map(|b| u16::from_le_bytes(b.try_into().unwrap())) {
                        let start = 22;
                        let end = start + name_len as usize * 2;
                        if let Some(raw) = chunk.get(start..end) {
                            let units: Vec<u16> = raw
                                .chunks_exact(2)
                                .map(|c| u16::from_le_bytes([c[0], c[1]]))
                                .collect();
                            name = Some(String::from_utf16_lossy(&units));
                        }
                    }
                }
                SECTION_SEGM => {
                    if let (Some(flags), Some(offset), Some(unpacked), Some(packed)) = (
                        read_u32_at(chunk, 0),
                        read_i64_at(chunk, 4),
                        read_i64_at(chunk, 12),
                        read_i64_at(chunk, 20),
                    ) {
                        segments.push(Xp3Segment {
                            offset: offset.max(0) as u64,
                            unpacked: unpacked.max(0) as u64,
                            packed: packed.max(0) as u64,
                            compressed: flags == 1,
                        });
                    }
                }
                _ => {}
            }

            q = chunk_end;
        }

        if let Some(name) = name {
            if !protected && !segments.is_empty() {
                entries.push(Xp3Entry { name, segments });
            }
        }

        pos = body_end;
    }

    Ok(entries)
}

pub fn read_entry(path: &Path, entry: &Xp3Entry) -> Result<Vec<u8>, String> {
    let mut file = fs::File::open(path)
        .map_err(|e| format!("Gagal membuka {}: {}", path.display(), e))?;
    let mut out = Vec::new();

    for segment in &entry.segments {
        file.seek(SeekFrom::Start(segment.offset))
            .map_err(|e| format!("Gagal menuju data {}: {}", entry.name, e))?;
        let mut raw = vec![0u8; segment.packed as usize];
        file.read_exact(&mut raw)
            .map_err(|e| format!("Gagal membaca data {}: {}", entry.name, e))?;

        if segment.compressed {
            let mut inflated = Vec::with_capacity(segment.unpacked as usize);
            flate2::read::ZlibDecoder::new(&raw[..])
                .read_to_end(&mut inflated)
                .map_err(|e| format!("Gagal membuka segmen {}: {}", entry.name, e))?;
            out.extend_from_slice(&inflated);
        } else {
            out.extend_from_slice(&raw);
        }
    }

    Ok(out)
}

/// Rejects names that would escape the destination folder.
fn safe_relative(name: &str) -> Option<PathBuf> {
    let mut out = PathBuf::new();
    for part in name.split(['/', '\\']) {
        if part.is_empty() || part == "." || part == ".." || part.contains(':') {
            return None;
        }
        out.push(part);
    }
    if out.as_os_str().is_empty() { None } else { Some(out) }
}

/// Extracts every readable entry into `dest`, returns the count written.
pub fn extract_all(path: &Path, dest: &Path) -> Result<usize, String> {
    let entries = read_index(path)?;
    let mut written = 0;

    for entry in &entries {
        let Some(rel) = safe_relative(&entry.name) else { continue };
        let target = dest.join(rel);
        if let Some(parent) = target.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let bytes = read_entry(path, entry)?;
        fs::write(&target, bytes)
            .map_err(|e| format!("Gagal menulis {}: {}", target.display(), e))?;
        written += 1;
    }

    Ok(written)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!("copastool_xp3_{}_{}", tag, nanos));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    #[test]
    fn test_adler32_matches_reference_value() {
        // Known vector: Adler-32("Wikipedia") == 0x11E60398.
        let mut sum = Adler32::new();
        sum.update(b"Wikipedia");
        assert_eq!(sum.value(), 0x11E6_0398);
        assert_eq!(Adler32::new().value(), 1, "empty input is 1");
    }

    #[test]
    fn test_plain_xp3_header_and_index_pointers_are_consistent() {
        let root = temp_dir("writer");
        let payload = root.join("payload");
        fs::create_dir_all(&payload).unwrap();
        fs::write(payload.join("a.ks.scn"), b"hello").unwrap();

        let files = vec![Xp3File {
            name: "a.ks.scn".to_string(),
            source: payload.join("a.ks.scn"),
        }];
        let out = root.join("patch.xp3");
        write_plain_xp3(&out, &files).expect("write xp3");

        let bytes = fs::read(&out).unwrap();
        assert_eq!(&bytes[..11], &XP3_MAGIC, "magic must match Kirikiri's");

        // The recorded index offset must land on a plain (type 0) index whose
        // size covers exactly the rest of the file.
        let index_offset = u64::from_le_bytes(bytes[11..19].try_into().unwrap()) as usize;
        assert_eq!(bytes[index_offset], 0, "index header type must be 0 (plain)");
        let index_size = u64::from_le_bytes(bytes[index_offset + 1..index_offset + 9].try_into().unwrap());
        assert_eq!(index_offset + 9 + index_size as usize, bytes.len());

        // Payload sits right after the header, and the entry name is stored as UTF-16.
        assert_eq!(&bytes[19..24], b"hello");
        let name: Vec<u16> = "a.ks.scn"
            .encode_utf16()
            .collect::<Vec<_>>();
        let needle: Vec<u8> = name.iter().flat_map(|u| u.to_le_bytes()).collect();
        assert!(bytes.windows(needle.len()).any(|w| w == needle));

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn test_collect_files_uses_relative_slash_paths() {
        let root = temp_dir("collect");
        fs::create_dir_all(root.join("sub")).unwrap();
        fs::write(root.join("top.scn"), b"1").unwrap();
        fs::write(root.join("sub").join("nested.txt"), b"2").unwrap();

        let files = collect_files(&root).unwrap();
        let names: Vec<&str> = files.iter().map(|f| f.name.as_str()).collect();
        assert_eq!(names, vec!["sub/nested.txt", "top.scn"]);

        let _ = fs::remove_dir_all(&root);
    }
}
