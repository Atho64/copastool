// @module virtual-scroller.ts — Virtual scrolling engine

export class VirtualScroller<T = any> {
  viewport: HTMLElement;
  container: HTMLElement;
  estimatedHeight: number;
  renderItem: (item: T) => HTMLElement;
  items: T[];
  heights: number[];
  positions: number[];
  totalHeight: number;
  scrollTop: number;
  ticking: boolean;
  lastStart: number;
  lastEnd: number;
  onVisibleRangeChange?: (startIndex: number, endIndex: number) => void;
  private rowMap: Map<number, HTMLElement>;
  private topSpacer: HTMLDivElement | null;
  private bottomSpacer: HTMLDivElement | null;
  private remeasureRAF: number | null;
  private rerenderRAF: number | null;
  private isUserScrolling: boolean;
  private scrollIdleTimer: number | null;
  private resizeObserver: ResizeObserver | null;
  private measureRAF: number | null;
  private disposed: boolean;

  constructor(
    viewport: HTMLElement,
    container: HTMLElement,
    estimatedHeight: number,
    renderItem: (item: T) => HTMLElement,
  ) {
    this.viewport = viewport;
    this.container = container;
    this.estimatedHeight = estimatedHeight;
    this.renderItem = renderItem;
    this.items = [];
    this.heights = [];
    this.positions = [];
    this.totalHeight = 0;
    this.scrollTop = 0;
    this.ticking = false;
    this.lastStart = -1;
    this.lastEnd = -1;
    this.rowMap = new Map();
    this.topSpacer = null;
    this.bottomSpacer = null;
    this.remeasureRAF = null;
    this.rerenderRAF = null;
    this.isUserScrolling = false;
    this.scrollIdleTimer = null;
    this.resizeObserver = null;
    this.measureRAF = null;
    this.disposed = false;

    this.onScroll = this.onScroll.bind(this);
    this.viewport.addEventListener('scroll', this.onScroll, { passive: true });
    if (window.ResizeObserver) {
      this.resizeObserver = new ResizeObserver(() => {
        if (this.viewport.clientHeight > 0) {
          this.render(false);
          this.requestRemeasure();
        }
      });
      this.resizeObserver.observe(this.viewport);
    }
  }

  dispose(): void {
    this.disposed = true;
    this.viewport.removeEventListener('scroll', this.onScroll);
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    if (this.remeasureRAF !== null) cancelAnimationFrame(this.remeasureRAF);
    if (this.rerenderRAF !== null) cancelAnimationFrame(this.rerenderRAF);
    if (this.measureRAF !== null) cancelAnimationFrame(this.measureRAF);
    if (this.scrollIdleTimer !== null) window.clearTimeout(this.scrollIdleTimer);
    this.remeasureRAF = null;
    this.rerenderRAF = null;
    this.measureRAF = null;
    this.scrollIdleTimer = null;
    this.rowMap.clear();
  }

  setItems(items: T[], preserveScroll = false): void {
    if (this.disposed) return;
    const prevScroll = preserveScroll ? this.viewport.scrollTop : 0;
    this.items = items;
    if (preserveScroll && this.heights.length === items.length) {
      // Retain existing heights
    } else {
      const newHeights = new Array(items.length).fill(this.estimatedHeight);
      if (preserveScroll) {
        const copyLen = Math.min(this.heights.length, items.length);
        for (let i = 0; i < copyLen; i++) newHeights[i] = this.heights[i];
      }
      this.heights = newHeights;
    }
    this.updatePositions();
    if (preserveScroll) {
      const maxScroll = Math.max(0, this.totalHeight - (this.viewport.clientHeight || 800));
      const targetScroll = Math.min(prevScroll, maxScroll);
      this.scrollTop = targetScroll;
      this.viewport.scrollTop = targetScroll;
      this.lastStart = -1;
      this.lastEnd = -1;
      this.render(true);
      this.viewport.scrollTop = targetScroll;
    } else {
      this.scrollTop = this.viewport.scrollTop = 0;
      this.lastStart = -1;
      this.lastEnd = -1;
      this.container.innerHTML = '';
      this.rowMap.clear();
      this.topSpacer = null;
      this.bottomSpacer = null;
      this.render(true);
    }
  }

  updatePositions(): void {
    let top = 0;
    this.positions = new Array(this.items.length);
    for (let i = 0; i < this.items.length; i++) {
      this.positions[i] = top;
      top += this.heights[i];
    }
    this.totalHeight = top;
  }

  scrollToIndex(index: number): void {
    if (this.disposed) return;
    if (index < 0 || index >= this.items.length) return;
    this.viewport.scrollTop = this.positions[index];
    this.scrollTop = this.viewport.scrollTop;
    this.render(false);
  }

  getRenderedElement(index: number): HTMLElement | undefined {
    return this.rowMap.get(index);
  }

  onScroll(): void {
    if (this.disposed) return;
    this.isUserScrolling = true;
    if (this.scrollIdleTimer !== null) window.clearTimeout(this.scrollIdleTimer);
    this.scrollIdleTimer = window.setTimeout(() => {
      this.isUserScrolling = false;
      this.scrollTop = this.viewport.scrollTop;
      this.requestRemeasure();
    }, 120);

    if (!this.ticking) {
      window.requestAnimationFrame(() => {
        this.scrollTop = this.viewport.scrollTop;
        this.render();
        this.ticking = false;
      });
      this.ticking = true;
    }
  }

  findStartIndex(): number {
    let low = 0;
    let high = this.items.length - 1;
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const midTop = this.positions[mid];
      const midBottom = midTop + this.heights[mid];
      if (this.scrollTop >= midTop && this.scrollTop < midBottom) {
        return mid;
      } else if (this.scrollTop < midTop) {
        high = mid - 1;
      } else {
        low = mid + 1;
      }
    }
    return Math.max(0, Math.min(low, this.items.length - 1));
  }

  requestRemeasure(): void {
    if (this.disposed) return;
    if (this.remeasureRAF !== null) return;
    this.remeasureRAF = requestAnimationFrame(() => {
      this.remeasureRAF = null;
      this.remeasure();
    });
  }

  private updateMeasuredHeight(idx: number, el: HTMLElement): boolean {
    const rect = el.getBoundingClientRect();
    if (rect.height <= 0) return false;
    const viewportHeight = this.viewport.clientHeight || 800;
    const maxReasonableHeight = Math.max(viewportHeight * 2, this.estimatedHeight * 12);
    const actualHeight = Math.min(rect.height, maxReasonableHeight);
    if (Math.abs(actualHeight - this.heights[idx]) <= 1) return false;
    this.heights[idx] = actualHeight;
    return true;
  }

  private applyMeasuredChanges(anchorIndex: number, anchorOffset: number): void {
    this.updatePositions();

    if (!this.isUserScrolling && anchorIndex >= 0 && anchorIndex < this.items.length) {
      const nextScrollTop = this.positions[anchorIndex] + anchorOffset;
      if (Math.abs(this.viewport.scrollTop - nextScrollTop) > 1) {
        this.viewport.scrollTop = nextScrollTop;
        this.scrollTop = this.viewport.scrollTop;
      }
    } else {
      this.scrollTop = this.viewport.scrollTop;
    }

    if (this.topSpacer) {
      this.topSpacer.style.height = `${this.positions[this.lastStart] || 0}px`;
    }
    if (this.bottomSpacer) {
      const endTop = this.positions[this.lastEnd] ?? this.totalHeight;
      const bottomPad = this.lastEnd < this.items.length ? this.totalHeight - endTop : 0;
      this.bottomSpacer.style.height = `${Math.max(0, bottomPad)}px`;
    }

    this.requestRangeRefresh();
  }

  private requestRangeRefresh(): void {
    if (this.rerenderRAF !== null) return;
    this.rerenderRAF = requestAnimationFrame(() => {
      this.rerenderRAF = null;
      this.lastStart = -1;
      this.lastEnd = -1;
      this.render(false);
    });
  }

  private remeasure(): void {
    const anchorIndex = this.findStartIndex();
    const anchorOffset = anchorIndex >= 0 ? this.scrollTop - this.positions[anchorIndex] : 0;
    let changed = false;
    for (const [idx, el] of this.rowMap) {
      if (idx < this.lastStart || idx >= this.lastEnd) continue;
      if (this.updateMeasuredHeight(idx, el)) changed = true;
    }
    if (changed) {
      this.applyMeasuredChanges(anchorIndex, anchorOffset);
    }
  }

  render(force = false): void {
    if (this.disposed) return;
    const viewportHeight = this.viewport.clientHeight || 800;
    const total = this.items.length;
    if (!total) {
      this.container.innerHTML = '';
      this.rowMap.clear();
      this.topSpacer = null;
      this.bottomSpacer = null;
      this.onVisibleRangeChange?.(-1, -1);
      return;
    }

    const buffer = 26;
    let targetStart = this.findStartIndex() - Math.floor(buffer / 2);
    targetStart = Math.max(0, targetStart);
    const minRenderedItems = Math.min(total - targetStart, buffer);

    let end = targetStart;
    let currentHeight = 0;
    while (
      end < total &&
      (
        currentHeight < viewportHeight + buffer * this.estimatedHeight ||
        end - targetStart < minRenderedItems
      )
    ) {
      currentHeight += this.heights[end];
      end++;
    }
    end = Math.min(total, end);

    if (!force && this.lastStart === targetStart && this.lastEnd === end) {
      this.onVisibleRangeChange?.(targetStart, end);
      return;
    }

    this.lastStart = targetStart;
    this.lastEnd = end;

    if (!this.topSpacer || !this.topSpacer.parentNode) {
      this.topSpacer = document.createElement('div');
      this.container.insertBefore(this.topSpacer, this.container.firstChild);
    }
    if (!this.bottomSpacer || !this.bottomSpacer.parentNode) {
      this.bottomSpacer = document.createElement('div');
      this.container.appendChild(this.bottomSpacer);
    }

    const topPad = this.positions[targetStart] || 0;
    const bottomPad = end < total ? this.totalHeight - this.positions[end] : 0;
    this.topSpacer.style.height = `${topPad}px`;
    this.bottomSpacer.style.height = `${bottomPad}px`;

    if (force) {
      for (const [, el] of this.rowMap) {
        el.remove();
      }
      this.rowMap.clear();
      this.updatePositions();
    }

    const toRemove: number[] = [];
    for (const [idx] of this.rowMap) {
      if (idx < targetStart || idx >= end) {
        toRemove.push(idx);
      }
    }
    for (const idx of toRemove) {
      const el = this.rowMap.get(idx)!;
      el.remove();
      this.rowMap.delete(idx);
    }

    const frag = document.createDocumentFragment();
    const newElements: HTMLElement[] = [];
    for (let i = targetStart; i < end; i++) {
      let el = this.rowMap.get(i);
      if (!el) {
        el = this.renderItem(this.items[i]);
        (el as any).dataset.vindex = i;
        this.rowMap.set(i, el);
        newElements.push(el);
      }
      frag.appendChild(el);
    }
    this.container.insertBefore(frag, this.bottomSpacer);

    this.onVisibleRangeChange?.(targetStart, end);

    if (newElements.length > 0) {
      if (this.measureRAF !== null) cancelAnimationFrame(this.measureRAF);
      this.measureRAF = requestAnimationFrame(() => {
        this.measureRAF = null;
        if (this.disposed) return;
        const anchorIndex = this.findStartIndex();
        const anchorOffset = anchorIndex >= 0 ? this.scrollTop - this.positions[anchorIndex] : 0;
        let changed = false;
        for (const el of newElements) {
          const idx = parseInt((el as any).dataset.vindex);
          if (this.updateMeasuredHeight(idx, el)) changed = true;
        }
        if (changed) {
          this.applyMeasuredChanges(anchorIndex, anchorOffset);
        }
      });
    }
  }
}
