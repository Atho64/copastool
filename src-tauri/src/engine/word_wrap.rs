use regex::Regex;
use std::sync::OnceLock;

static CONTROL_CODE_REGEX: OnceLock<Regex> = OnceLock::new();

fn get_control_regex() -> &'static Regex {
    CONTROL_CODE_REGEX.get_or_init(|| {
        Regex::new(r"(?x)
            \\\.                # Escape sequence like \.
            | \[.+?\]           # Ruby text or tags like [r]
            | %f.*?;            # Font tags
            | %[bisecrCLRBSpwdD].*? # Kirikiri format flags (%b., %i., %r, %B, etc.)
            | \#[0-9a-fA-F]+;   # Color tags like #ffffff;
            | \$.*?;            # Script eval tags
            | &.*?;             # Inline image tags
        ").unwrap()
    })
}

/// Measures the display length of a string, ignoring Kirikiri / VN control codes.
pub fn visual_length(text: &str) -> usize {
    let re = get_control_regex();
    let stripped = re.replace_all(text, "");
    // East Asian characters (fullwidth) count as 2 chars, ASCII counts as 1.
    stripped.chars().map(|c| {
        if c as u32 > 0x7f { 2 } else { 1 }
    }).sum()
}

/// Wraps text at word boundaries (spaces/hyphens) without splitting words,
/// preserving control codes.
pub fn wrap_text(text: &str, max_width: usize, line_break: &str) -> String {
    if text.is_empty() || max_width == 0 {
        return text.to_string();
    }

    let mut result = String::with_capacity(text.len() + 32);
    
    let normalized = text.replace("\r\n", "\n");
    let paragraphs = normalized.split('\n');

    for (p_idx, paragraph) in paragraphs.enumerate() {
        if p_idx > 0 {
            result.push_str(line_break);
        }

        if paragraph.trim().is_empty() {
            continue;
        }

        let mut words: Vec<&str> = Vec::new();
        let mut start = 0;
        let bytes = paragraph.as_bytes();
        let len = bytes.len();

        for i in 0..len {
            if bytes[i] == b' ' || bytes[i] == b'\t' {
                if start < i {
                    words.push(&paragraph[start..i]);
                }
                words.push(&paragraph[i..=i]);
                start = i + 1;
            }
        }
        if start < len {
            words.push(&paragraph[start..]);
        }

        let mut current_line = String::new();
        let mut current_line_width = 0;

        for word in words {
            let is_space = word == " " || word == "\t";
            let word_w = visual_length(word);

            if is_space {
                if !current_line.is_empty() && current_line_width + word_w <= max_width {
                    current_line.push_str(word);
                    current_line_width += word_w;
                }
                continue;
            }

            // Word longer than a whole line (e.g. unspaced CJK runs):
            // hard-break it at the width limit instead of overflowing.
            if word_w > max_width {
                if !current_line.is_empty() {
                    if !result.is_empty() && !result.ends_with(line_break) {
                        result.push_str(line_break);
                    }
                    result.push_str(current_line.trim_end());
                    result.push_str(line_break);
                    current_line.clear();
                    current_line_width = 0;
                }
                for ch in word.chars() {
                    let cw = visual_length(&ch.to_string());
                    if current_line_width + cw > max_width && !current_line.is_empty() {
                        result.push_str(current_line.trim_end());
                        result.push_str(line_break);
                        current_line.clear();
                        current_line_width = 0;
                    }
                    current_line.push(ch);
                    current_line_width += cw;
                }
                continue;
            }

            if current_line_width + word_w > max_width && !current_line.is_empty() {
                if !result.is_empty() && !result.ends_with(line_break) {
                    result.push_str(line_break);
                }
                result.push_str(current_line.trim_end());
                result.push_str(line_break);
                current_line.clear();
                current_line_width = 0;
            }

            current_line.push_str(word);
            current_line_width += word_w;
        }

        if !current_line.is_empty() {
            if !result.is_empty() && !result.ends_with(line_break) {
                result.push_str(line_break);
            }
            result.push_str(current_line.trim_end());
        }
    }

    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_word_wrap_basic() {
        let text = "Ini adalah contoh kalimat panjang yang akan dibungkus dengan benar tanpa memotong kata.";
        let wrapped = wrap_text(text, 30, "\n");
        assert!(wrapped.contains('\n'));
        for line in wrapped.lines() {
            assert!(visual_length(line) <= 30);
        }
    }

    #[test]
    fn test_word_wrap_hard_breaks_long_words() {
        // No spaces: must still respect the width limit.
        let wrapped = wrap_text("abcdefgh", 4, "\n");
        assert_eq!(wrapped, "abcd\nefgh");
        let wrapped_cjk = wrap_text("あいうえおかきくけこ", 6, "\n");
        for line in wrapped_cjk.lines() {
            assert!(visual_length(line) <= 6, "line too wide: {}", line);
        }
    }

    #[test]
    fn test_word_wrap_with_tags() {
        let text = "Kalimat dengan [ruby=furigana]kata[/ruby] dan %f=msg;tag formatting%r panjang sekali.";
        let wrapped = wrap_text(text, 30, "\n");
        assert!(wrapped.contains('\n'));
    }
}
