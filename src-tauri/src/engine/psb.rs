//! PSB scenario read and write.
//!
//! Kirikiri scenarios are PSB trees, sometimes wrapped in a zlib layer (MDF).
//! This module converts them to and from JSON, the shape the rest of the
//! engine works with.

use emote_psb::{
    mdf::{MdfReader, MdfWriter},
    psb::{read::PsbFile, write::PsbWriter},
    value::PsbValue,
};
use std::fs::{self, File};
use std::io::{BufReader, Cursor, Read, Write};
use std::path::Path;

/// PSB files carry this as their emitted format version.
const PSB_VERSION: u16 = 3;

/// MDF wraps zlib-compressed PSB. Level 9 matches what the games ship.
const MDF_LEVEL: u8 = 9;

fn read_signature(path: &Path) -> Result<[u8; 4], String> {
    let mut head = [0u8; 4];
    File::open(path)
        .and_then(|mut f| f.read_exact(&mut head))
        .map_err(|e| format!("Gagal membaca {}: {}", path.display(), e))?;
    Ok(head)
}

/// `true` when the file is zlib-wrapped PSB.
pub fn is_mdf(path: &Path) -> bool {
    matches!(read_signature(path), Ok(head) if &head == b"mdf\0" || &head == b"MDF\0")
}

/// `true` when the file starts with a PSB or MDF signature.
pub fn is_psb_or_mdf(path: &Path) -> bool {
    match read_signature(path) {
        Ok(head) => matches!(&head, b"PSB\0" | b"mdf\0" | b"MDF\0"),
        Err(_) => false,
    }
}

/// Reads a scenario file into JSON. MDF wrappers are inflated first.
pub fn decompile(path: &Path) -> Result<serde_json::Value, String> {
    let head = read_signature(path)?;
    let is_mdf = &head == b"mdf\0" || &head == b"MDF\0";

    let bytes = if is_mdf {
        let mut reader = MdfReader::open(BufReader::new(
            File::open(path).map_err(|e| format!("Gagal membuka {}: {}", path.display(), e))?,
        ))
        .map_err(|e| format!("Gagal membuka MDF {}: {:?}", path.display(), e))?;
        let mut out = Vec::new();
        reader
            .read_to_end(&mut out)
            .map_err(|e| format!("Gagal membuka MDF {}: {}", path.display(), e))?;
        out
    } else {
        fs::read(path).map_err(|e| format!("Gagal membaca {}: {}", path.display(), e))?
    };

    let mut psb = PsbFile::open(Cursor::new(bytes))
        .map_err(|e| format!("Gagal membaca PSB {}: {:?}", path.display(), e))?;
    let root: PsbValue = psb
        .deserialize_root()
        .map_err(|e| format!("Gagal mengurai PSB {}: {:?}", path.display(), e))?;

    serde_json::to_value(&root).map_err(|e| format!("Gagal mengubah PSB ke JSON: {}", e))
}

/// Writes JSON back to `out`. `as_mdf` keeps the zlib wrapper the source used.
pub fn compile(value: &serde_json::Value, out: &Path, as_mdf: bool) -> Result<(), String> {
    let root: PsbValue = serde_json::from_value(value.clone())
        .map_err(|e| format!("Gagal mengubah JSON ke PSB: {}", e))?;

    let mut psb_bytes = Vec::new();
    PsbWriter::new(PSB_VERSION, false, &root, Cursor::new(&mut psb_bytes))
        .map_err(|e| format!("Gagal menulis PSB: {:?}", e))?
        .finish()
        .map_err(|e| format!("Gagal menyelesaikan PSB: {:?}", e))?;

    if let Some(parent) = out.parent() {
        let _ = fs::create_dir_all(parent);
    }

    if as_mdf {
        let mut mdf = MdfWriter::new(
            File::create(out).map_err(|e| format!("Gagal membuat {}: {}", out.display(), e))?,
            MDF_LEVEL,
        )
        .map_err(|e| format!("Gagal membuat MDF {}: {:?}", out.display(), e))?;
        mdf.write_all(&psb_bytes)
            .map_err(|e| format!("Gagal menulis MDF {}: {}", out.display(), e))?;
        mdf.finish()
            .map_err(|e| format!("Gagal menyelesaikan MDF {}: {:?}", out.display(), e))?;
    } else {
        fs::write(out, &psb_bytes).map_err(|e| format!("Gagal menulis {}: {}", out.display(), e))?;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_signature_detection() {
        let dir = std::env::temp_dir().join("copastool_psb_sig");
        let _ = fs::create_dir_all(&dir);

        let psb = dir.join("a.scn");
        fs::write(&psb, b"PSB\0\x03\0").unwrap();
        assert!(is_psb_or_mdf(&psb));

        let mdf = dir.join("b.scn");
        fs::write(&mdf, b"mdf\0\x01\0").unwrap();
        assert!(is_psb_or_mdf(&mdf));

        let text = dir.join("c.ks");
        fs::write(&text, b"*start\r\nHello").unwrap();
        assert!(!is_psb_or_mdf(&text));

        let _ = fs::remove_dir_all(&dir);
    }
}
