// @module notify.ts — Top-center toast + stop sound (user-supplied mp3, bundled via Vite)

const notifUrl = `${import.meta.env.BASE_URL}notif.mp3`;

type ToastKind = 'success' | 'info' | 'warn' | 'danger';
type ToastOpts = { kind?: ToastKind; ms?: number; withSound?: boolean };

let audioEl: HTMLAudioElement | null = null;
let primed = false;

function getAudio(): HTMLAudioElement {
  if (audioEl) return audioEl;
  audioEl = new Audio(notifUrl);
  audioEl.preload = 'auto';
  return audioEl;
}

function primeOnGesture(): void {
  if (primed) return;
  try { void getAudio().play().then(() => { getAudio().pause(); getAudio().currentTime = 0; }).catch(() => {}); } catch {}
  primed = true;
  window.removeEventListener('pointerdown', primeOnGesture);
  window.removeEventListener('keydown', primeOnGesture);
}
window.addEventListener('pointerdown', primeOnGesture, { once: true } as any);
window.addEventListener('keydown', primeOnGesture, { once: true } as any);

export function playStopSound(): void {
  try {
    const a = getAudio();
    a.currentTime = 0;
    void a.play().catch(() => {});
  } catch {}
}

function ensureHost(): HTMLElement {
  let host = document.getElementById('notifyHost');
  if (host) return host;
  host = document.createElement('div');
  host.id = 'notifyHost';
  host.setAttribute('role', 'status');
  host.setAttribute('aria-live', 'polite');
  host.setAttribute('aria-atomic', 'true');
  document.body.appendChild(host);
  return host;
}

export function notify(message: string, opts: ToastOpts = {}): void {
  const kind = opts.kind ?? 'success';
  const ms = opts.ms ?? (kind === 'danger' ? 4200 : kind === 'warn' ? 3600 : 2800);
  const after = () => { if (opts.withSound) playStopSound(); };
  const host = ensureHost();
  const last = host.lastElementChild as HTMLElement | null;
  if (last && last.classList.contains('notify-toast') && (last as any)._notifyMessage === message && !last.dataset.dismissed) {
    const count = (((last as any)._notifyCount as number) || 1) + 1;
    (last as any)._notifyCount = count;
    const badge = last.querySelector('.notify-count') as HTMLElement | null;
    if (badge) badge.textContent = `x${count}`;
    else {
      const b = document.createElement('span');
      b.className = 'notify-count';
      b.textContent = `x${count}`;
      last.insertBefore(b, last.querySelector('.notify-close'));
    }
    const textEl = last.querySelector('.notify-text') as HTMLElement | null;
    if (textEl) { textEl.classList.add('bump'); void (textEl as any).offsetWidth; textEl.classList.remove('bump'); }
    last.classList.remove('out');
    last.classList.add('in');
    const prev = (last as any)._notifyTimer as number | undefined;
    if (prev) window.clearTimeout(prev);
    if (ms > 0) (last as any)._notifyTimer = window.setTimeout(() => {
      if ((last as HTMLElement).dataset.dismissed) return;
      (last as HTMLElement).dataset.dismissed = '1';
      last.classList.add('out');
      window.setTimeout(() => last.remove(), 220);
    }, ms) as unknown as number;
    if (opts.withSound) after();
    return;
  }
  const el = document.createElement('div') as any;
  (el as any)._notifyMessage = message;
  (el as any)._notifyCount = 1;
  el.className = `notify-toast notify-${kind}`;
  el.setAttribute('role', 'status');
  const text = document.createElement('span');
  text.className = 'notify-text';
  text.textContent = message;
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'notify-close';
  close.setAttribute('aria-label', 'Dismiss');
  close.textContent = '×';
  el.append(text, close);
  let timer: number | undefined;
  const dismiss = () => {
    if (el.dataset.dismissed) return;
    el.dataset.dismissed = '1';
    if (timer) window.clearTimeout(timer);
    const t2 = (el as any)._notifyTimer as number | undefined;
    if (t2) window.clearTimeout(t2);
    el.classList.add('out');
    window.setTimeout(() => el.remove(), 220);
  };
  close.addEventListener('click', dismiss);
  el.addEventListener('click', (e) => { if ((e.target as HTMLElement).closest('.notify-close')) return; dismiss(); });
  host.appendChild(el);
  void el.offsetWidth;
  el.classList.add('in');
  if (ms > 0) { timer = window.setTimeout(dismiss, ms) as unknown as number; (el as any)._notifyTimer = timer; }
  if (opts.withSound) after();
}

export function notifyStop(message: string, kind: ToastKind = 'info'): void {
  notify(message, { kind, withSound: true });
}
