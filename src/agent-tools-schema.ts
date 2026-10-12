// @module agent-tools-schema.ts — Declarative tool schemas for native
// function calling (OpenAI tools / Anthropic tools / Gemini functionDeclarations).
// The same JSON Schema shape works for all three providers.

export interface ToolSchema {
  name: string;
  description: string;
  parameters: Record<string, any>; // JSON Schema object
}

const S = (name: string, description: string, parameters: Record<string, any>): ToolSchema => ({
  name, description, parameters,
});

const obj = (properties: Record<string, any>, required: string[] = []): Record<string, any> => ({
  type: 'object',
  properties,
  required,
});

const str = (description: string) => ({ type: 'string', description });
const num = (description: string) => ({ type: 'number', description });
const bool = (description: string) => ({ type: 'boolean', description });
const arr = (description: string, items: any) => ({ type: 'array', description, items });

/** All tools available to the MAIN agent via native function calling. */
export const AGENT_TOOL_SCHEMAS: ToolSchema[] = [
  S('getProjectStats', 'Ringkasan progress, jumlah baris, daftar file proyek.', obj({})),
  S('getLines', 'Ambil teks asli + terjemahan untuk rentang baris.', obj({
    start: num('Nomor baris awal'),
    end: num('Nomor baris akhir (inklusif)'),
  }, ['start', 'end'])),
  S('getContext', 'Lihat baris sekitar sebuah baris target (konteks atas-bawah).', obj({
    line_num: num('Nomor baris target'),
    radius: num('Jumlah baris di atas & bawah (default 3)'),
  }, ['line_num'])),
  S('searchLines', 'Cari kata kunci di teks asli, terjemahan, atau nama karakter.', obj({
    query: str('Kata kunci pencarian'),
  }, ['query'])),
  S('getCharacterNames', 'Daftar semua nama karakter + deteksi inkonsistensi otomatis.', obj({})),
  S('analyzeQuality', 'Cek baris belum diterjemahkan, terjemahan terlalu pendek, nama tidak konsisten.', obj({
    limit: num('Maks baris dilaporkan (default 20, maks 50)'),
  })),
  S('getProgressReport', 'Laporan progress terjemahan per file.', obj({})),
  S('applyTranslations', 'Terapkan terjemahan langsung ke proyek. >10 baris akan menampilkan preview konfirmasi ke user.', obj({
    updates: arr('Daftar {num, trans_message, trans_name?}', obj({
      num: num('Nomor baris'),
      trans_message: str('Teks terjemahan'),
      trans_name: str('Nama karakter terjemahan (opsional)'),
    })),
  }, ['updates'])),
  S('editLine', 'Edit satu baris (semua field: message, name, trans_message, trans_name, dll).', obj({
    line_num: num('Nomor baris'),
    fields: obj({}, []),
  }, ['line_num', 'fields'])),
  S('editLines', 'Edit beberapa baris sekaligus. >10 baris menampilkan preview konfirmasi.', obj({
    updates: arr('Daftar {line_num, fields}', obj({
      line_num: num('Nomor baris'),
      fields: obj({}, []),
    })),
  }, ['updates'])),
  S('clearTranslations', 'Hapus terjemahan untuk baris tertentu.', obj({
    line_nums: arr('Nomor baris', { type: 'number' }),
  }, ['line_nums'])),
  S('undoLastAction', 'Batalkan aksi terakhir.', obj({})),
  S('redoLastAction', 'Kembalikan aksi yang dibatalkan.', obj({})),
  S('getGlossary', 'Ambil daftar glosarium yang didefinisikan pengguna.', obj({})),
  S('editPrompt', 'Edit prompt terjemahan/glosarium/AI check/agent.', obj({
    prompt_type: str('translation | glossary | ai_check | agent'),
    new_prompt: str('Teks prompt baru'),
  }, ['prompt_type', 'new_prompt'])),
  S('editGlossary', 'Edit teks glosarium (satu baris per entri).', obj({
    new_glossary: str('Teks glosarium lengkap'),
  }, ['new_glossary'])),
  S('listSettings', 'Tampilkan daftar semua setting yang bisa diubah.', obj({})),
  S('toggleSetting', 'Ubah/toggle setting aplikasi.', obj({
    setting_name: str('Nama setting (lihat listSettings)'),
    value: { description: 'Nilai baru (boolean/number/string sesuai tipe setting)' },
  }, ['setting_name', 'value'])),
  S('getMemory', 'Ambil memori agent (opsional filter kategori).', obj({
    category: str('Filter kategori (opsional)'),
  })),
  S('listMemory', 'Tampilkan semua memori agent.', obj({})),
  S('saveMemory', 'Simpan/update memori (global/project).', obj({
    key: str('Kunci memori'),
    value: str('Isi memori'),
    category: str('Kategori: style | character | preference | note'),
    scope: str('global | project (opsional)'),
  }, ['key', 'value', 'category'])),
  S('deleteMemory', 'Hapus memori by key.', obj({
    key: str('Kunci memori'),
  }, ['key'])),
  S('webSearch', 'Cari web: wikipedia, jisho (kamus JP), vndb, tavily, auto.', obj({
    query: str('Query pencarian'),
    source: str('wikipedia | jisho | vndb | tavily | auto (opsional)'),
  }, ['query'])),
  S('delegateTranslate', 'Terjemahkan kumpulan baris spesifik via subagent.', obj({
    lineNums: arr('Nomor baris', { type: 'number' }),
    instruction: str('Instruksi tambahan (opsional)'),
  }, ['lineNums'])),
  S('delegateAnalyze', 'Analisis kualitas terjemahan via subagent.', obj({
    lineNums: arr('Nomor baris', { type: 'number' }),
    focus: str('Fokus analisis (opsional)'),
  }, ['lineNums'])),
  S('delegateParallelTranslate', 'Terjemahkan rentang baris via subagent paralel — untuk rentang besar (>30 baris).', obj({
    startLine: num('Baris awal'),
    endLine: num('Baris akhir'),
    instruction: str('Instruksi tambahan (opsional)'),
  }, ['startLine', 'endLine'])),
  S('delegateGlossaryExtract', 'Ekstrak glosarium paralel dari beberapa VN/anime.', obj({
    queries: arr('Nama VN/anime', { type: 'string' }),
    source: str('vndb | anilist (default vndb)'),
  }, ['queries'])),
  S('delegateAgent', 'Spawn subagent otonom (loop tool sendiri, tanpa batas turn) untuk tugas kompleks/multi-langkah. Subagent bisa bertanya ke user dan mengirim laporan progress.', obj({
    task: str('Deskripsi tugas lengkap dan jelas'),
    max_turns: num('Batas turn opsional (default unlimited)'),
  }, ['task'])),
  S('askUser', 'TANYA USER dengan kartu pertanyaan interaktif (tombol pilihan). Loop berhenti sampai user menjawab. WAJIB untuk keputusan penting.', obj({
    question: str('Pertanyaan'),
    options: arr('Maks 6 pilihan singkat; kosongkan untuk jawaban bebas', { type: 'string' }),
  }, ['question'])),
  S('setPlan', 'TAMPILKAN RENCANA sebagai checklist live. WAJIB di awal tugas multi-langkah.', obj({
    steps: arr('Langkah 1-6, ringkas & konkret', { type: 'string' }),
  }, ['steps'])),
  S('updatePlanStep', 'Update status langkah rencana.', obj({
    step: num('Nomor langkah (1-based)'),
    status: str('pending | active | done'),
  }, ['step', 'status'])),
  S('completePlan', 'Tandai semua langkah selesai.', obj({})),
  S('searchVn', 'Cari VN/anime by nama (vndb/anilist).', obj({
    query: str('Nama VN/anime'),
    source: str('vndb | anilist (default vndb)'),
  }, ['query'])),
  S('extractGlossary', 'Ekstrak glosarium dari karakter VN/anime.', obj({
    query: str('Nama VN/anime'),
    source: str('vndb | anilist (default vndb)'),
  }, ['query'])),
];

/**
 * Filter schemas by name (used by subagents that expose a subset).
 * Unknown names are ignored silently.
 */
export function filterToolSchemas(names: string[] | null): ToolSchema[] {
  if (!names) return AGENT_TOOL_SCHEMAS;
  const set = new Set(names);
  return AGENT_TOOL_SCHEMAS.filter(t => set.has(t.name));
}
