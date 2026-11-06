/** Escape source text before inserting it into a furigana HTML result. */
export function escapeFuriganaText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Kuroshiro returns ruby markup but leaves source HTML untouched. Keep HTML
 * delimiters out of the tokenizer and join them back as escaped text, so source
 * tags stay literal while generated ruby annotations still render normally.
 * Escaping the whole input first would split entities in romaji furigana mode.
 */
export async function convertFuriganaHtml(
  text: string,
  convert: (text: string) => Promise<string>,
): Promise<string> {
  const parts = text.split(/([&<>])/);
  const html = await Promise.all(parts.map(part => {
    if (!part || /^[&<>]$/.test(part)) return escapeFuriganaText(part);
    return convert(part);
  }));
  return html.join('');
}
