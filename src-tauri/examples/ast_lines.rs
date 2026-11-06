//! Counts the dialogue lines the Artemis parser finds in one .ast file.
//!
//! cargo run --example ast_lines -- <file.ast>

use copas_tool_lib::engine::engines::artemis::ArtemisEngine;
use copas_tool_lib::engine::traits::GameEngine;
use std::path::PathBuf;

fn main() {
    let path = PathBuf::from(std::env::args().nth(1).expect("file"));
    let cache = std::env::temp_dir().join("copastool_ast_lines");
    let _ = std::fs::remove_dir_all(&cache);
    let script = cache.join("raw_extracted").join("script");
    std::fs::create_dir_all(&script).unwrap();
    std::fs::copy(&path, script.join(path.file_name().unwrap())).unwrap();

    let engine = ArtemisEngine;
    let lines = engine.read_lines(&cache, None).expect("read_lines");
    println!("lines: {}", lines.len());
    for line in lines.iter() {
        println!("  {}:{} {}", line.file, line.line_num, line.message);
    }
    if let Some(last) = lines.last() {
        println!("  last {}:{} {}", last.file, last.line_num, last.message);
    }
    let _ = std::fs::remove_dir_all(&cache);
}
