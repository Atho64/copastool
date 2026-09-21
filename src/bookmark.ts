// @module bookmark.ts — Bookmark management, workstation bubble badge, and modal interactions

import { state, ui, getMainScroller } from './state';
import { pushUndoSnapshot, openLineEditor, flashHint } from './render';
import { openModal, closeModal, queueAutoSave } from './project';
import { formatLineLabel } from './luca-engine';
import { isTranslated } from './state';
import type { Line } from './types';

export function getBookmarkedLines(): Line[] {
  return state.lines.filter(l => !!l.bookmarked);
}

export function updateBookmarkBadge(): void {
  const count = getBookmarkedLines().length;
  const countStr = count > 99 ? '99+' : String(count);

  const toolbarBadge = document.getElementById('toolbarBookmarkBadge');
  if (toolbarBadge) {
    toolbarBadge.textContent = countStr;
    if (count > 0) toolbarBadge.classList.remove('is-zero');
    else toolbarBadge.classList.add('is-zero');
  }

  const modalCount = document.getElementById('bookmarkModalCount');
  if (modalCount) {
    modalCount.textContent = String(count);
  }

  const tbBtn = document.getElementById('btnToolbarBookmark');
  if (tbBtn) {
    tbBtn.title = count > 0 ? `Daftar Bookmark (${count} baris tersimpan)` : 'Daftar Bookmark (Kosong)';
  }
}

export function toggleBookmark(lineNum: number, notify = true): void {
  const line = state.lineByNum.get(lineNum) || state.lines.find(l => l.line_num === lineNum);
  if (!line) return;

  pushUndoSnapshot();
  line.bookmarked = !line.bookmarked;

  // Direct DOM update for instant visual feedback on the line row
  const row = document.querySelector(`.preview-row[data-line-num="${lineNum}"]`);
  if (row) {
    const bmBtn = row.querySelector('.line-bookmark-btn');
    if (bmBtn) {
      if (line.bookmarked) {
        bmBtn.classList.add('is-bookmarked');
        bmBtn.setAttribute('title', 'Hapus bookmark');
        bmBtn.innerHTML = `<svg class="lucide-icon" xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z"/></svg>`;
      } else {
        bmBtn.classList.remove('is-bookmarked');
        bmBtn.setAttribute('title', 'Bookmark baris ini');
        bmBtn.innerHTML = `<svg class="lucide-icon" xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z"/></svg>`;
      }
    }
  }

  updateBookmarkBadge();

  // If bookmark modal is currently open, refresh list
  const modal = ui.bookmarkModal as HTMLElement | undefined;
  if (modal && modal.classList.contains('open')) {
    const searchInput = document.getElementById('bookmarkSearchInput') as HTMLInputElement | null;
    renderBookmarkList(searchInput?.value || '');
  }

  queueAutoSave();
  if (notify) {
    flashHint(line.bookmarked ? `Baris ${lineNum} ditambahkan ke bookmark.` : `Bookmark baris ${lineNum} dihapus.`);
  }
}

export function openBookmarkModal(): void {
  const modal = ui.bookmarkModal as HTMLElement | undefined;
  if (!modal) return;
  const searchInput = document.getElementById('bookmarkSearchInput') as HTMLInputElement | null;
  if (searchInput) searchInput.value = '';
  renderBookmarkList();
  openModal(modal);
}

export function closeBookmarkModal(): void {
  const modal = ui.bookmarkModal as HTMLElement | undefined;
  if (modal) closeModal(modal);
}

export function jumpToBookmarkedLine(lineNum: number): void {
  closeBookmarkModal();
  const scroller = getMainScroller();
  if (!scroller || !scroller.items) return;

  const items = scroller.items;
  const idx = items.findIndex((l: any) => l.type === 'line' && l.line?.line_num === lineNum);

  if (idx !== -1) {
    scroller.scrollToIndex(idx);
    setTimeout(() => {
      const rowDom = document.querySelector(`.preview-row[data-line-num="${lineNum}"]`);
      if (rowDom) {
        rowDom.classList.add('flash-highlight');
        setTimeout(() => rowDom.classList.remove('flash-highlight'), 1500);
      }
    }, 60);
  } else {
    alert('Gagal melompat: Baris mungkin disembunyikan oleh filter regex di menu utama.');
  }
}

export function clearAllBookmarks(): void {
  const bookmarked = getBookmarkedLines();
  if (bookmarked.length === 0) return;

  if (!confirm(`Hapus semua ${bookmarked.length} bookmark di proyek ini?`)) return;

  pushUndoSnapshot();
  for (const line of bookmarked) {
    line.bookmarked = false;
  }

  // Update rows currently in DOM
  document.querySelectorAll('.line-bookmark-btn.is-bookmarked').forEach(btn => {
    btn.classList.remove('is-bookmarked');
    btn.setAttribute('title', 'Bookmark baris ini');
    btn.innerHTML = `<svg class="lucide-icon" xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z"/></svg>`;
  });

  updateBookmarkBadge();
  renderBookmarkList();
  queueAutoSave();
  flashHint('Semua bookmark berhasil dihapus.');
}

export function renderBookmarkList(filterQuery = ''): void {
  const container = document.getElementById('bookmarkListContainer');
  if (!container) return;

  const q = filterQuery.trim().toLowerCase();
  let bookmarked = getBookmarkedLines();

  if (q) {
    bookmarked = bookmarked.filter(l => {
      const numMatch = String(l.line_num).includes(q);
      const fileMatch = (l.file || '').toLowerCase().includes(q);
      const nameMatch = (l.name || '').toLowerCase().includes(q) || (l.trans_name || '').toLowerCase().includes(q);
      const msgMatch = (l.message || '').toLowerCase().includes(q);
      const transMatch = (l.trans_message || '').toLowerCase().includes(q);
      return numMatch || fileMatch || nameMatch || msgMatch || transMatch;
    });
  }

  container.innerHTML = '';

  const totalAll = getBookmarkedLines().length;
  const modalCount = document.getElementById('bookmarkModalCount');
  if (modalCount) modalCount.textContent = String(totalAll);

  const clearBtn = document.getElementById('btnClearAllBookmarks') as HTMLButtonElement | null;
  if (clearBtn) clearBtn.disabled = totalAll === 0;

  if (totalAll === 0) {
    const emptyDiv = document.createElement('div');
    emptyDiv.className = 'bookmark-empty-state';
    emptyDiv.innerHTML = `
      <div class="bookmark-empty-icon">
        <svg class="lucide-icon" xmlns="http://www.w3.org/2000/svg" width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z"/></svg>
      </div>
      <div class="bookmark-empty-title">Belum ada bookmark tersimpan</div>
      <p class="hint">Arahkan kursor ke baris teks di panel Daftar Teks, lalu klik ikon bookmark <svg class="lucide-icon inline-icon" xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z"/></svg> di pojok kanan atas baris untuk menyimpannya di sini.</p>
    `;
    container.appendChild(emptyDiv);
    return;
  }

  if (bookmarked.length === 0) {
    const emptyDiv = document.createElement('div');
    emptyDiv.className = 'bookmark-empty-state';
    emptyDiv.innerHTML = `<p class="hint m-0">Tidak ada bookmark yang cocok dengan pencarian "<strong>${filterQuery}</strong>".</p>`;
    container.appendChild(emptyDiv);
    return;
  }

  const frag = document.createDocumentFragment();

  for (const line of bookmarked) {
    const card = document.createElement('div');
    card.className = 'bookmark-item-card';

    const header = document.createElement('div');
    header.className = 'bookmark-card-header';

    const meta = document.createElement('div');
    meta.className = 'bookmark-meta';
    meta.innerHTML = `<span class="bookmark-line-badge">Baris ${line.line_num}</span> <span class="bookmark-file-name" title="${line.file}">${line.file}</span>`;

    const actions = document.createElement('div');
    actions.className = 'bookmark-actions';

    const btnJump = document.createElement('button');
    btnJump.type = 'button';
    btnJump.className = 'btn btn-outline btn-xs';
    btnJump.title = 'Lompat ke baris ini di daftar teks';
    btnJump.innerHTML = `<svg class="lucide-icon" xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="m10 8 4 4-4 4"/></svg> Lompat`;
    btnJump.addEventListener('click', (e) => {
      e.stopPropagation();
      jumpToBookmarkedLine(line.line_num);
    });

    const btnEdit = document.createElement('button');
    btnEdit.type = 'button';
    btnEdit.className = 'btn btn-outline btn-xs';
    btnEdit.title = 'Buka editor baris';
    btnEdit.innerHTML = `<svg class="lucide-icon" xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg> Edit`;
    btnEdit.addEventListener('click', (e) => {
      e.stopPropagation();
      closeBookmarkModal();
      openLineEditor(line.line_num);
    });

    const btnRemove = document.createElement('button');
    btnRemove.type = 'button';
    btnRemove.className = 'icon-btn btn-xs text-danger';
    btnRemove.title = 'Hapus dari bookmark';
    btnRemove.style.width = '26px';
    btnRemove.style.height = '26px';
    btnRemove.style.minWidth = '26px';
    btnRemove.style.minHeight = '26px';
    btnRemove.innerHTML = `<svg class="lucide-icon" xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>`;
    btnRemove.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleBookmark(line.line_num, false);
      renderBookmarkList(filterQuery);
    });

    actions.append(btnJump, btnEdit, btnRemove);
    header.append(meta, actions);

    const content = document.createElement('div');
    content.className = 'bookmark-card-content';
    content.addEventListener('click', () => {
      jumpToBookmarkedLine(line.line_num);
    });

    const origDiv = document.createElement('div');
    origDiv.className = 'bookmark-orig';
    origDiv.textContent = formatLineLabel(line);

    const transDiv = document.createElement('div');
    transDiv.className = 'bookmark-trans';
    if (isTranslated(line)) {
      transDiv.textContent = formatLineLabel(line, { translated: true });
    } else {
      transDiv.className += ' text-muted';
      transDiv.textContent = '—— (Belum diterjemahkan)';
    }

    content.append(origDiv, transDiv);
    card.append(header, content);
    frag.appendChild(card);
  }

  container.appendChild(frag);
}
