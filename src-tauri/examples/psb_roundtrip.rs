//! Isolates the PSB codec: decompile -> (optional JSON text round trip) ->
//! compile -> decompile, then reports how many values moved.
//!
//! cargo run --example psb_roundtrip -- <file.scn> [--text]

use copas_tool_lib::engine::psb;
use std::path::Path;

fn diff(a: &serde_json::Value, b: &serde_json::Value, path: &str, out: &mut Vec<String>) {
    match (a, b) {
        (serde_json::Value::Object(x), serde_json::Value::Object(y)) => {
            for (k, v) in x {
                match y.get(k) {
                    Some(w) => diff(v, w, &format!("{}.{}", path, k), out),
                    None => out.push(format!("{}.{}: missing", path, k)),
                }
            }
        }
        (serde_json::Value::Array(x), serde_json::Value::Array(y)) => {
            if x.len() != y.len() {
                out.push(format!("{}: len {} vs {}", path, x.len(), y.len()));
            }
            for (i, (v, w)) in x.iter().zip(y.iter()).enumerate() {
                diff(v, w, &format!("{}[{}]", path, i), out);
            }
        }
        _ => {
            if a != b {
                out.push(format!("{}: {} vs {}", path, a, b));
            }
        }
    }
}

fn main() {
    let mut args = std::env::args().skip(1);
    let path = args.next().expect("file");
    let via_text = args.any(|a| a == "--text");

    let first = psb::decompile(Path::new(&path)).expect("decompile");
    let value = if via_text {
        let text = serde_json::to_string_pretty(&first).expect("serialize");
        serde_json::from_str(&text).expect("parse")
    } else {
        first.clone()
    };

    let out = std::env::temp_dir().join("psb_roundtrip_out.scn");
    psb::compile(&value, &out, psb::is_mdf(Path::new(&path))).expect("compile");
    let second = psb::decompile(&out).expect("re-decompile");

    let mut diffs = Vec::new();
    diff(&first, &second, "", &mut diffs);
    println!("json text round trip: {}", via_text);
    println!("diffs: {}", diffs.len());
    for d in diffs.iter().take(5) {
        println!("  {}", d);
    }
}
