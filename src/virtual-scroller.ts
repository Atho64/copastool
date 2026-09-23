// @module virtual-scroller.ts — Virtual scrolling engine

export class VirtualScroller<T = any> {
  viewport: HTMLElement;
  container: HTMLElement;
  estimatedHeight: number;
  renderItem: (item: T, recycledElement?: HTMLElement) => HTMLElement;
  items: T[];
  heights: number[];
  private heightTree: Float64Array;
  totalHeight: number;
  scrollTop: number;
  ticking: boolean;
  lastStart: number;
  lastEnd: number;
  onVisibleRangeChange?: (startIndex: number, endIndex: number) => void;
  private rowMap: Map<number, HTMLElement>;
  private elementPool: HTMLElement[];
  private positioned: boolean;
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
    renderItem: (item: T, recycledElement?: HTMLElement) => HTMLElement,
    positioned = false,
  ) {
    this.viewport = viewport;
    this.container = container;
    this.estimatedHeight = estimatedHeight;
    this.renderItem = renderItem;
    this.items = [];
    this.heights = [];
    this.heightTree = new Float64Array(1);
    this.totalHeight = 0;
    this.scrollTop = 0;
    this.ticking = false;
    this.lastStart = -1;
    this.lastEnd = -1;
    this.rowMap = new Map();
    this.elementPool = [];
    this.positioned = positioned;
    if (positioned) this.container.classList.add('virtualized-absolute');
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
    this.elementPool.length = 0;
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
    this.rebuildHeightIndex();
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
      this.elementPool.length = 0;
      this.topSpacer = null;
      this.bottomSpacer = null;
      this.render(true);
    }
  }

  private rebuildHeightIndex(): void {
    const count = this.heights.length;
    const tree = new Float64Array(count + 1);
    for (let i = 1; i <= count; i++) tree[i] = this.heights[i - 1];
    for (let i = 1; i <= count; i++) {
      const parent = i + (i & -i);
      if (parent <= count) tree[parent] += tree[i];
    }
    this.heightTree = tree;
    this.totalHeight = this.prefixHeight(count);
  }

  private prefixHeight(endExclusive: number): number {
    let sum = 0;
    for (let i = Math.min(endExclusive, this.heights.length); i > 0; i -= i & -i) {
      sum += this.heightTree[i];
    }
    return sum;
  }

  private positionAt(index: number): number {
    return this.prefixHeight(index);
  }

  private addHeightDelta(index: number, delta: number): void {
    for (let i = index + 1; i < this.heightTree.length; i += i & -i) {
      this.heightTree[i] += delta;
    }
    this.totalHeight += delta;
  }

  private findIndexAtOffset(offset: number): number {
    const count = this.items.length;
    if (!count) return 0;
    let index = 0;
    let sum = 0;
    let step = 1;
    while ((step << 1) <= count) step <<= 1;
    for (; step > 0; step >>= 1) {
      const next = index + step;
      if (next <= count && sum + this.heightTree[next] <= offset) {
        index = next;
        sum += this.heightTree[next];
      }
    }
    return Math.min(index, count - 1);
  }

  scrollToIndex(index: number): void {
    if (this.disposed) return;
    if (index < 0 || index >= this.items.length) return;
    this.viewport.scrollTop = this.positionAt(index);
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
    return this.findIndexAtOffset(this.scrollTop);
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
    const h = el.offsetHeight;
    if (h <= 0) return false;
    const viewportHeight = this.viewport.clientHeight || 800;
    const maxReasonableHeight = Math.max(viewportHeight * 2, this.estimatedHeight * 12);
    const actualHeight = Math.min(h, maxReasonableHeight);
    if (Math.abs(actualHeight - this.heights[idx]) <= 1) return false;
    const delta = actualHeight - this.heights[idx];
    this.heights[idx] = actualHeight;
    this.addHeightDelta(idx, delta);
    return true;
  }

  private applyMeasuredChanges(anchorIndex: number, anchorOffset: number): void {
    if (!this.isUserScrolling && anchorIndex >= 0 && anchorIndex < this.items.length) {
      const nextScrollTop = this.positionAt(anchorIndex) + anchorOffset;
      if (Math.abs(this.viewport.scrollTop - nextScrollTop) > 1) {
        this.viewport.scrollTop = nextScrollTop;
        this.scrollTop = this.viewport.scrollTop;
      }
    } else {
      this.scrollTop = this.viewport.scrollTop;
    }

    if (this.positioned) {
      this.container.style.height = `${this.totalHeight}px`;
      this.positionVisibleRows();
    } else if (this.topSpacer) {
      this.topSpacer.style.height = `${this.positionAt(this.lastStart)}px`;
    }
    if (!this.positioned && this.bottomSpacer) {
      const endTop = this.lastEnd < this.items.length ? this.positionAt(this.lastEnd) : this.totalHeight;
      const bottomPad = this.lastEnd < this.items.length ? this.totalHeight - endTop : 0;
      this.bottomSpacer.style.height = `${Math.max(0, bottomPad)}px`;
    }

    this.requestRangeRefresh();
  }

  private positionRow(el: HTMLElement, index: number): void {
    el.style.position = 'absolute';
    el.style.top = '0';
    el.style.left = '8px';
    el.style.right = '8px';
    el.style.width = 'auto';
    el.style.margin = '0';
    el.style.setProperty('--virtual-y', `${Math.round(this.positionAt(index))}px`);
  }

  private positionVisibleRows(): void {
    if (!this.positioned) return;
    for (const [index, el] of this.rowMap) this.positionRow(el, index);
  }

  private requestRangeRefresh(): void {
    if (this.rerenderRAF !== null) return;
    this.rerenderRAF = requestAnimationFrame(() => {
      this.rerenderRAF = null;
      this.render(false);
    });
  }

  private remeasure(): void {
    const anchorIndex = this.findStartIndex();
    const anchorOffset = anchorIndex >= 0 ? this.scrollTop - this.positionAt(anchorIndex) : 0;
    let changed = false;
    for (const [idx, el] of this.rowMap) {
      if (idx < this.lastStart || idx >= this.lastEnd) continue;
      if (this.updateMeasuredHeight(idx, el)) {
        changed = true;
      }
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
      this.container.style.height = this.positioned ? '0px' : '';
      this.rowMap.clear();
      this.elementPool.length = 0;
      this.topSpacer = null;
      this.bottomSpacer = null;
      this.onVisibleRangeChange?.(-1, -1);
      return;
    }

    // Keep the overscan smaller on touch devices. Low/mid-range Android GPUs
    // benefit from fewer live row subtrees, while desktop keeps a larger
    // cushion for high-speed wheel scrolling.
    const buffer = window.matchMedia('(pointer: coarse)').matches ? 8 : 16;
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
      // Heal: rowMap must mirror container membership. If a retained row was
      // detached behind our back (container cleared/replaced mid-cycle), the
      // early return below would freeze the broken DOM forever.
      for (const el of this.rowMap.values()) {
        if (el.parentNode !== this.container) {
          this.render(true);
          return;
        }
      }
      this.onVisibleRangeChange?.(targetStart, end);
      return;
    }

    this.lastStart = targetStart;
    this.lastEnd = end;

    if (this.positioned) {
      this.container.style.height = `${this.totalHeight}px`;
    } else {
      if (!this.topSpacer || !this.topSpacer.parentNode) {
        this.topSpacer = document.createElement('div');
        this.container.insertBefore(this.topSpacer, this.container.firstChild);
      }
      if (!this.bottomSpacer || !this.bottomSpacer.parentNode) {
        this.bottomSpacer = document.createElement('div');
        this.container.appendChild(this.bottomSpacer);
      }
    }

    if (!this.positioned) {
      const topPad = this.positionAt(targetStart);
      const bottomPad = end < total ? this.totalHeight - this.positionAt(end) : 0;
      this.topSpacer!.style.height = `${topPad}px`;
      this.bottomSpacer!.style.height = `${bottomPad}px`;
    }

    const recyclePool = this.elementPool.splice(0);
    if (force) {
      for (const [, el] of this.rowMap) {
        recyclePool.push(el);
      }
      this.rowMap.clear();
    }

    const toRemove: number[] = [];
    for (const [idx] of this.rowMap) {
      if (idx < targetStart || idx >= end) {
        toRemove.push(idx);
      }
    }
    for (const idx of toRemove) {
      const el = this.rowMap.get(idx)!;
      recyclePool.push(el);
      this.rowMap.delete(idx);
    }

    // Create new rows first, then insert each contiguous run as one fragment.
    // Scrolling usually adds a run at one edge; batching avoids repeated DOM
    // insertions and layout work on slower mobile WebViews.
    const newElements: Array<{ index: number; element: HTMLElement }> = [];
    for (let i = targetStart; i < end; i++) {
      let el = this.rowMap.get(i);
      if (!el) {
        const recycled = recyclePool.pop();
        el = this.renderItem(this.items[i], recycled);
        if (recycled && recycled !== el) recycled.remove();
        (el as any).dataset.vindex = i;
        this.rowMap.set(i, el);
        if (this.positioned) this.positionRow(el, i);
        newElements.push({ index: i, element: el });
      }
    }

    for (let runStart = 0; !this.positioned && runStart < newElements.length;) {
      let runEnd = runStart + 1;
      while (
        runEnd < newElements.length &&
        newElements[runEnd].index === newElements[runEnd - 1].index + 1
      ) {
        runEnd++;
      }

      // Insert before the next retained row, or before the bottom spacer when
      // this run extends to the end of the visible window.
      let nextNode: HTMLElement | null = null;
      for (let i = newElements[runEnd - 1].index + 1; i < end; i++) {
        const candidate = this.rowMap.get(i);
        if (candidate && candidate.parentNode === this.container) {
          nextNode = candidate;
          break;
        }
      }

      const fragment = document.createDocumentFragment();
      for (let i = runStart; i < runEnd; i++) fragment.appendChild(newElements[i].element);
      this.container.insertBefore(fragment, nextNode || this.bottomSpacer);
      runStart = runEnd;
    }

    if (this.positioned) {
      const fragment = document.createDocumentFragment();
      for (const { element } of newElements) fragment.appendChild(element);
      this.container.appendChild(fragment);
      this.positionVisibleRows();
    }

    for (const unused of recyclePool) {
      unused.remove();
      this.elementPool.push(unused);
    }

    this.onVisibleRangeChange?.(targetStart, end);

    if (newElements.length > 0) {
      if (this.measureRAF !== null) cancelAnimationFrame(this.measureRAF);
      this.measureRAF = requestAnimationFrame(() => {
        this.measureRAF = null;
        if (this.disposed) return;
        const anchorIndex = this.findStartIndex();
        const anchorOffset = anchorIndex >= 0 ? this.scrollTop - this.positionAt(anchorIndex) : 0;
        let changed = false;
        for (const { index: idx, element: el } of newElements) {
          if (this.updateMeasuredHeight(idx, el)) {
            changed = true;
          }
        }
        if (changed) {
          this.applyMeasuredChanges(anchorIndex, anchorOffset);
        }
      });
    }
  }
}
