// @module vndb-anilist.ts — VNDB and AniList character name extractors

import { state, ui } from './state';
import { addNameGlossaryEntry, mergeGlossaryEntries, genderToDescription } from './glossary';
import { containsJapanese } from './string-utils';
import { flashHint, collectCharacterNameRows, pushUndoSnapshot, renderNameTable, renderPreviewRows } from './render';
import { queueAutoSave } from './project';

export function extractVndbId(input: string): string | null {
  const match = String(input || '').trim().match(/(?:^|\/)(v\d+)(?:[/?#].*)?$/i);
  return match ? match[1].toLowerCase() : null;
}

function buildNameToLinesMap(): Map<string, { lines: any[]; currentTransName: string }> {
  const nameRows = collectCharacterNameRows();
  const m = new Map<string, { lines: any[]; currentTransName: string }>();
  for (const row of nameRows) {
    const translatedNames = Array.from(row.translatedNames as Set<string>);
    m.set(row.name, { lines: row.lines, currentTransName: translatedNames.length === 1 ? translatedNames[0] : '' });
  }
  return m;
}

export function applyVndbNameTranslations(characters: any[]): { appliedNames: number; appliedLines: number } {
  const nameMap = buildNameToLinesMap();
  let appliedNames = 0;
  let appliedLines = 0;

  function tryApply(sourceName: string, targetName: string): boolean {
    if (!sourceName || !targetName || sourceName === targetName) return false;
    if (!nameMap.has(sourceName)) return false;
    const entry = nameMap.get(sourceName)!;
    if (entry.currentTransName) return false;
    for (const line of entry.lines) {
      line.trans_name = targetName;
      appliedLines++;
    }
    entry.currentTransName = targetName;
    appliedNames++;
    return true;
  }

  for (const ch of characters) {
    const enFull = String(ch.name || '').trim();
    if (!enFull) continue;
    const jpFull = String(ch.original || '').trim();
    const jpParts = jpFull ? jpFull.split(/\s+/).filter(Boolean) : [];
    const enParts = enFull.split(/\s+/).filter(Boolean);

    // ─── Nickname-only: no original Japanese name ───
    if (!jpFull || !containsJapanese(jpFull)) {
      const namesToCheck = [enFull];
      if (Array.isArray(ch.aliases)) {
        for (const a of ch.aliases) {
          const alias = String(a).trim();
          if (alias && !containsJapanese(alias) && alias !== enFull) namesToCheck.push(alias);
        }
      }
      for (const nameToCheck of namesToCheck) {
        tryApply(nameToCheck, enFull);
      }
      continue;
    }

    // ─── Full JP name match ───
    tryApply(jpFull.replace(/\s+/g, ''), enFull);

    // ─── Split name parts (family + given) ───
    if (jpParts.length === 2 && enParts.length === 2) {
      tryApply(jpParts[0], enParts[0]);
      tryApply(jpParts[1], enParts[1]);
    }

    // ─── Aliases matching name table ───
    if (Array.isArray(ch.aliases) && ch.aliases.length > 0) {
      const jpAliases: string[] = [];
      const enAliases: string[] = [];
      for (const a of ch.aliases) {
        const alias = String(a).trim();
        if (!alias) continue;
        if (containsJapanese(alias)) jpAliases.push(alias);
        else enAliases.push(alias);
      }

      // Pair JP and EN aliases positionally when counts match
      // e.g. aliases: ["タカ", "Taka"] → pair タカ with Taka
      if (jpAliases.length > 0 && jpAliases.length === enAliases.length) {
        for (let i = 0; i < jpAliases.length; i++) {
          const jpAlias = jpAliases[i].replace(/\s+/g, '');
          const enAlias = enAliases[i].trim();
          tryApply(jpAlias, enAlias);
          // Also try split parts of paired aliases
          const pairedJpParts = jpAliases[i].split(/\s+/).filter(Boolean);
          const pairedEnParts = enAlias.split(/\s+/).filter(Boolean);
          if (pairedJpParts.length === 2 && pairedEnParts.length === 2) {
            tryApply(pairedJpParts[0], pairedEnParts[0]);
            tryApply(pairedJpParts[1], pairedEnParts[1]);
          }
        }
      } else {
        // Unpaired JP aliases — try matching against full EN name
        for (const jpAlias of jpAliases) {
          const aliasNoSpace = jpAlias.replace(/\s+/g, '');
          tryApply(aliasNoSpace, enFull);
          // Also try split parts of JP aliases against split EN name parts
          const aliasParts = jpAlias.split(/\s+/).filter(Boolean);
          if (aliasParts.length === 2 && enParts.length === 2) {
            tryApply(aliasParts[0], enParts[0]);
            tryApply(aliasParts[1], enParts[1]);
          }
        }
      }

      // EN aliases can directly match name table entries (nickname case)
      for (const enAlias of enAliases) {
        if (enAlias !== enFull) tryApply(enAlias, enAlias);
      }
    }
  }

  return { appliedNames, appliedLines };
}

export function collectVndbGlossaryEntries(characters: any[]): Map<string, any> {
  const entries = new Map<string, any>();
  function processPair(jpFull: string, enFull: string, desc: string) {
    if (!jpFull || !enFull || !containsJapanese(jpFull)) return;
    const jpClean = jpFull.trim();
    const enClean = enFull.trim();
    if (!jpClean || !enClean) return;
    const jpNoSpace = jpClean.replace(/\s+/g, '');
    if (jpNoSpace && jpNoSpace !== enClean) addNameGlossaryEntry(entries, jpNoSpace, enClean, 'character', desc);
    const jpParts = jpClean.split(/\s+/).filter(Boolean);
    const enParts = enClean.split(/\s+/).filter(Boolean);
    if (jpParts.length === 2 && enParts.length === 2) {
      if (jpParts[0] !== enParts[0]) addNameGlossaryEntry(entries, jpParts[0], enParts[0], 'character', 'family name');
      if (jpParts[1] !== enParts[1]) addNameGlossaryEntry(entries, jpParts[1], enParts[1], 'character', desc);
    }
  }
  for (const ch of characters) {
    const target = String(ch.name || '').trim();
    if (!target) continue;
    const desc = genderToDescription(ch.gender);
    processPair(ch.original, target, desc);
    if (Array.isArray(ch.aliases) && ch.aliases.length > 0) {
      const jpAliases: string[] = [];
      const enAliases: string[] = [];
      for (const a of ch.aliases) {
        if (containsJapanese(a)) jpAliases.push(String(a));
        else enAliases.push(String(a));
      }
      if (jpAliases.length > 0 && jpAliases.length === enAliases.length) {
        for (let i = 0; i < jpAliases.length; i++) processPair(jpAliases[i], enAliases[i], desc);
      } else {
        for (const a of jpAliases) {
          const jpNoSpace = String(a).replace(/\s+/g, '');
          if (jpNoSpace && jpNoSpace !== target) addNameGlossaryEntry(entries, jpNoSpace, target, 'character', desc);
        }
      }
    }
  }
  return entries;
}

export async function fetchVndbCharacters(vnId: string): Promise<any[]> {
  const all: any[] = [];
  let page = 1;
  let more = true;
  while (more) {
    const res = await fetch('https://api.vndb.org/kana/character', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filters: ['vn', '=', ['id', '=', vnId]], fields: 'id,name,original,aliases,gender', sort: 'id', results: 100, page }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`VNDB API error ${res.status}${detail ? `: ${detail.slice(0, 120)}` : ''}`);
    }
    const data = await res.json();
    const results = Array.isArray(data.results) ? data.results : [];
    for(let _i=0; _i<results.length; _i++) all.push(results[_i]);
    more = !!data.more;
    page++;
    if (page > 20) throw new Error('VNDB mengembalikan terlalu banyak halaman.');
  }
  return all;
}

// ── Search VN by name (returns VN list with IDs) ────────────────────────────
export async function fetchVndbVnByName(query: string): Promise<any[]> {
  const res = await fetch('https://api.vndb.org/kana/vn', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      filters: ['search', '=', query],
      fields: 'id,title,alttitle,released,rating,length,tags.name',
      sort: 'searchrank',
      results: 5,
    }),
  });
  if (!res.ok) throw new Error(`VNDB search error ${res.status}`);
  const data = await res.json();
  return Array.isArray(data?.results) ? data.results : [];
}

// ── Search AniList media by name (returns media list with IDs) ───────────────
export async function fetchAnilistMediaByName(query: string): Promise<any[]> {
  const gqlQuery = `
    query ($search: String) {
      Page(perPage: 5) {
        media(search: $search) {
          id
          title { romaji english native }
          format type
        }
      }
    }
  `;
  const res = await fetch('https://graphql.anilist.co', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ query: gqlQuery, variables: { search: query } }),
  });
  if (!res.ok) throw new Error(`AniList search error ${res.status}`);
  const json = await res.json();
  if (json.errors?.length) throw new Error(json.errors[0].message || 'AniList query gagal.');
  return json.data?.Page?.media || [];
}

export async function onImportVndbNames(): Promise<void> {
  const vnId = extractVndbId((ui.vndbInput as HTMLInputElement).value);
  if (!vnId) { (ui.vndbStatus as HTMLElement).textContent = 'Masukkan VNDB ID/URL yang valid, contoh: v17.'; return; }
  (ui.btnImportVndbNames as HTMLButtonElement).disabled = true;
  (ui.vndbStatus as HTMLElement).textContent = `Mengambil nama karakter dari VNDB ${vnId}...`;
  try {
    const characters = await fetchVndbCharacters(vnId);
    const imported = collectVndbGlossaryEntries(characters);
    // ─── Auto-apply name translations for matching name table entries ───
    let nameResult = { appliedNames: 0, appliedLines: 0 };
    if (characters.length > 0) {
      pushUndoSnapshot();
      nameResult = applyVndbNameTranslations(characters);
      if (nameResult.appliedLines > 0) {
        renderNameTable();
        renderPreviewRows();
        queueAutoSave();
      }
    }
    // ─── Glossary merge ───
    let glossaryResult = { added: 0, updated: 0 };
    if (imported.size) {
      glossaryResult = mergeGlossaryEntries(imported);
    }
    const parts: string[] = [];
    if (nameResult.appliedLines > 0) parts.push(`${nameResult.appliedNames} nama langsung diterapkan ke ${nameResult.appliedLines} baris`);
    if (glossaryResult.added > 0 || glossaryResult.updated > 0) parts.push(`${glossaryResult.added} glossary baru, ${glossaryResult.updated} diperbarui`);
    if (!parts.length) {
      (ui.vndbStatus as HTMLElement).textContent = 'Tidak ada nama yang bisa diimpor dari VNDB.';
    } else {
      (ui.vndbStatus as HTMLElement).textContent = `Import selesai dari ${characters.length} karakter: ${parts.join(', ')}.`;
    }
  } catch (err: any) {
    (ui.vndbStatus as HTMLElement).textContent = `Gagal import VNDB: ${err.message}`;
  } finally {
    (ui.btnImportVndbNames as HTMLButtonElement).disabled = false;
  }
}

export function extractAnilistId(input: string): number | null {
  const trimmed = String(input || '').trim();
  const urlMatch = trimmed.match(/anilist\.co\/manga\/(\d+)(?:\/|$)/i);
  if (urlMatch) return Number(urlMatch[1]);
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  return null;
}

export function collectAnilistGlossaryEntries(media: any): Map<string, any> {
  const entries = new Map<string, any>();
  const edges = media?.characters?.edges || [];
  for (const edge of edges) {
    const name = edge?.node?.name || {};
    const target = String(name.full || '').trim();
    if (!target) continue;
    const desc = genderToDescription(edge?.node?.gender);
    const sources = [name.native, ...(Array.isArray(name.alternative) ? name.alternative : [])]
      .map(v => String(v || '').trim())
      .filter(v => v && v !== target && containsJapanese(v));
    for (const source of sources) addNameGlossaryEntry(entries, source, target, 'character', desc);
  }
  return entries;
}

export async function fetchAnilistMediaCharacters(input: string): Promise<any> {
  const id = extractAnilistId(input);
  if (!id) throw new Error('Masukkan link lengkap AniList manga/novel atau ID angka.');
  const allEdges: any[] = [];
  let mediaInfo: any = null;
  let page = 1;
  let hasNextPage = true;
  const query = `
    query ($id: Int, $page: Int) {
      Media(id: $id, type: MANGA) {
        id title { romaji english native } format
        characters(page: $page, perPage: 50, sort: [ROLE, ID]) {
          pageInfo { hasNextPage }
          edges { node { gender name { full native alternative } } }
        }
      }
    }
  `;
  while (hasNextPage) {
    const res = await fetch('https://graphql.anilist.co', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ query, variables: { id, page } }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`AniList API error ${res.status}${detail ? `: ${detail.slice(0, 120)}` : ''}`);
    }
    const json = await res.json();
    if (json.errors?.length) throw new Error(json.errors[0].message || 'AniList query gagal.');
    const media = json.data?.Media;
    if (!media) throw new Error('Judul tidak ditemukan di AniList.');
    if (!mediaInfo) mediaInfo = media;
    const edges = media.characters?.edges || [];
    for(let _i=0; _i<edges.length; _i++) allEdges.push(edges[_i]);
    hasNextPage = !!media.characters?.pageInfo?.hasNextPage;
    page++;
    if (page > 20) throw new Error('AniList mengembalikan terlalu banyak halaman.');
  }
  mediaInfo.characters = { edges: allEdges };
  return mediaInfo;
}

export async function onImportAnilistNames(): Promise<void> {
  const input = (ui.anilistInput as HTMLInputElement).value.trim();
  if (!input) { (ui.anilistStatus as HTMLElement).textContent = 'Masukkan link lengkap AniList manga/novel atau ID angka.'; return; }
  (ui.btnImportAnilistNames as HTMLButtonElement).disabled = true;
  (ui.anilistStatus as HTMLElement).textContent = 'Mengambil nama karakter dari AniList...';
  try {
    const media = await fetchAnilistMediaCharacters(input);
    const imported = collectAnilistGlossaryEntries(media);
    const title = media.title?.romaji || media.title?.english || media.title?.native || `AniList ${media.id}`;
    if (!imported.size) { (ui.anilistStatus as HTMLElement).textContent = `Tidak ada nama Jepang yang bisa diimpor dari ${title}.`; return; }
    const { added, updated } = mergeGlossaryEntries(imported);
    (ui.anilistStatus as HTMLElement).textContent = `Import selesai dari ${title}: ${added} baru, ${updated} diperbarui.`;
  } catch (err: any) {
    (ui.anilistStatus as HTMLElement).textContent = `Gagal import AniList: ${err.message}`;
  } finally {
    (ui.btnImportAnilistNames as HTMLButtonElement).disabled = false;
  }
}
