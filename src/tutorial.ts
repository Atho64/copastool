import { handleImportLogic } from './import-source';
import { state } from './state';
import { writeClipboardText } from './native-clipboard';

type StepId = 'dashboard' | 'create' | 'open-import' | 'import-sample' | 'select-line' | 'copy-prompt' | 'copy-answer' | 'paste-answer' | 'apply-answer' | 'open-settings' | 'general-settings' | 'prompt-settings' | 'edit-prompt' | 'save-settings' | 'finish';
type TutorialStep = { id: StepId; title: string; text: string; target?: string; audio?: string };

const STEPS: TutorialStep[] = [
  { id: 'dashboard', title: 'Mulai dari dashboard', text: 'Tekan tombol Dashboard untuk kembali ke halaman proyek. Setelah itu kita akan membuat proyek latihan baru.', target: '#btnBackToDashboard', audio: '01-project.mp3' },
  { id: 'create', title: 'Buat proyek latihan', text: 'Klik Buat Project dan beri nama “Latihan Tutorial”. Proyek ini akan menjadi tempat aman untuk mencoba alur kerja.', target: '#btnNewProject', audio: '01-project.mp3' },
  { id: 'open-import', title: 'Buka menu Impor', text: 'Sekarang praktikkan cara memasukkan sumber. Klik menu Impor di toolbar proyek.', target: '#btnDropdownImport', audio: '02-import.mp3' },
  { id: 'import-sample', title: 'Impor contoh latihan', text: 'Pilih Impor Contoh Latihan di menu. Ini menjalankan alur impor JSON biasa dengan satu dialog contoh, tanpa perlu mencari berkas di perangkat.', target: '#btnTutorialSampleImport', audio: '02-import.mp3' },
  { id: 'select-line', title: 'Pilih baris', text: 'Klik kotak centang di samping baris contoh. Tombol Copy akan aktif setelah baris dipilih.', target: '.preview-row:not(.separator) input[type="checkbox"]', audio: '03-select.mp3' },
  { id: 'copy-prompt', title: 'Salin prompt', text: 'Klik Copy. Prompt dan teks sumber sekarang masuk ke clipboard, sama seperti saat kamu menyiapkan permintaan untuk AI.', target: '#btnCopyForAi', audio: '04-copy.mp3' },
  { id: 'copy-answer', title: 'Siapkan jawaban AI', text: 'Dalam praktik ini kita tidak perlu berpindah ke layanan AI. Klik Salin Jawaban Contoh untuk menaruh hasil contoh di clipboard, seperti menyalin balasan AI.', audio: '05-paste.mp3' },
  { id: 'paste-answer', title: 'Tempel sendiri hasilnya', text: 'Klik kotak terjemahan lalu tekan Ctrl+V (atau tempel dari menu). Tutorial menunggu sampai teks contoh benar-benar masuk ke kotak.', target: '#pasteArea', audio: '05-paste.mp3' },
  { id: 'apply-answer', title: 'Terapkan terjemahan', text: 'Klik Terapkan. CopasTool akan mencocokkan nomor baris hasil dengan sumber dan memperbarui terjemahannya.', target: '#btnApply', audio: '06-apply.mp3' },
  { id: 'open-settings', title: 'Buka pengaturan proyek', text: 'Klik Pengaturan Proyek. Kita akan melihat tab umum dan mencoba mengubah prompt untuk proyek latihan.', target: '#btnSettingsGeneral', audio: '08-settings.mp3' },
  { id: 'general-settings', title: 'Kenali pengaturan umum', text: 'Klik tab Umum. Di sini kamu dapat memeriksa bahasa sumber dan tujuan, tampilan, konteks, serta pemeriksaan kualitas.', target: '#btnTabSettingsGeneral', audio: '08-settings.mp3' },
  { id: 'prompt-settings', title: 'Buka pengaturan prompt', text: 'Klik tab Prompt untuk melihat instruksi yang disalin bersama teks sumber.', target: '#btnTabSettingsPrompts', audio: '07-prompt.mp3' },
  { id: 'edit-prompt', title: 'Coba ubah prompt', text: 'Klik kotak prompt dan tambahkan satu petunjuk singkat, misalnya “Gunakan bahasa Indonesia yang alami.” Perubahan teks akan membuka langkah berikutnya.', target: '#settingsPromptInput', audio: '07-prompt.mp3' },
  { id: 'save-settings', title: 'Simpan perubahan', text: 'Klik Simpan Pengaturan untuk menyimpan prompt pada proyek latihan.', target: '#btnSettingsSave', audio: '08-settings.mp3' },
  { id: 'finish', title: 'Latihan selesai!', text: 'Kamu sudah mempraktikkan membuat proyek, impor, memilih baris, copy prompt, paste manual, menerapkan hasil, dan mengubah prompt. Proyek Latihan Tutorial tersimpan di dashboard. Tekan ✦ Tutorial untuk mengulang latihan.' , audio: '09-done.mp3' },
];

const STORAGE_KEY = 'copastool-tutorial-v3-completed';
const SAMPLE_TRANSLATION = '1. Aoi: "Halo! Hari ini cuacanya cerah, ya."';
const SAMPLE_FILE = new File([JSON.stringify([{ name: 'Aoi', message: 'こんにちは！今日はいい天気だね。' }], null, 2)], 'Contoh-Latihan.json', { type: 'application/json' });
let stepIndex = 0;
let voiceEnabled = true;
let audio: HTMLAudioElement | null = null;
let lastTarget: HTMLElement | null = null;
let promptBeforeEdit = '';
let importBusy = false;
let tutorialActive = false;

const SOUND_ON = '<svg class="lucide-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07M19.07 4.93a10 10 0 0 1 0 14.14"/></svg><span>Suara</span>';
const SOUND_OFF = '<svg class="lucide-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 5 6 9H3v6h3l5 4z"/><path d="m22 9-6 6m0-6 6 6"/></svg><span>Suara</span>';

function isVisible(element: HTMLElement | null): element is HTMLElement {
  return !!element && element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden';
}

function findVisibleTarget(selector?: string): HTMLElement | null {
  if (!selector) return null;
  return Array.from(document.querySelectorAll<HTMLElement>(selector)).find(isVisible) ?? null;
}

function stopAudio(): void {
  if (!audio) return;
  audio.pause();
  audio.currentTime = 0;
  audio = null;
}

function playCurrentAudio(): void {
  stopAudio();
  const file = STEPS[stepIndex]?.audio;
  if (!voiceEnabled || !file) return;
  audio = new Audio(`./tutorial-audio/${file}`);
  audio.volume = 0.9;
  void audio.play().catch(() => {});
}

function drawArrow(): void {
  const path = document.querySelector<SVGPathElement>('#tutorialArrowPath');
  const svg = document.querySelector<SVGSVGElement>('#tutorialArrow');
  const card = document.getElementById('tutorialCard');
  const shade = document.querySelector<HTMLElement>('.tutorial-shade');
  if (!path || !svg || !card || !lastTarget || !isVisible(lastTarget)) {
    svg?.classList.add('hidden');
    if (shade) {
      shade.style.maskImage = '';
      shade.style.webkitMaskImage = '';
    }
    return;
  }
  const box = card.getBoundingClientRect();
  const target = lastTarget.getBoundingClientRect();
  if (shade) {
    const holeW = Math.max(34, target.width / 2 + 14);
    const holeH = Math.max(30, target.height / 2 + 14);
    const hole = `radial-gradient(ellipse ${holeW}px ${holeH}px at ${target.left + target.width / 2}px ${target.top + target.height / 2}px, transparent 68%, #000 100%)`;
    shade.style.maskImage = hole;
    shade.style.webkitMaskImage = hole;
  }
  const cx = box.left + box.width / 2, cy = box.top + box.height / 2;
  const tx = target.left + target.width / 2, ty = target.top + target.height / 2;
  const dx = tx - cx, dy = ty - cy;
  const cardScale = Math.min((box.width * 0.48) / Math.max(1, Math.abs(dx)), (box.height * 0.42) / Math.max(1, Math.abs(dy)));
  const sx = cx + dx * cardScale, sy = cy + dy * cardScale;
  const targetScale = Math.min((target.width * 0.42) / Math.max(1, Math.abs(dx)), (target.height * 0.42) / Math.max(1, Math.abs(dy)));
  const ex = tx - dx * targetScale, ey = ty - dy * targetScale;
  const bend = Math.min(90, Math.max(32, Math.hypot(dx, dy) * 0.14));
  const sign = dx >= 0 ? 1 : -1;
  path.setAttribute('d', `M ${sx} ${sy} Q ${(sx + ex) / 2 + sign * bend} ${(sy + ey) / 2 - 20} ${ex} ${ey}`);
  svg.setAttribute('viewBox', `0 0 ${window.innerWidth} ${window.innerHeight}`);
  svg.classList.remove('hidden');
}

function renderStep(): void {
  const step = STEPS[stepIndex];
  const overlay = document.getElementById('tutorialOverlay')!;
  // Reveal the practice menu item before resolving the step target. Otherwise
  // findVisibleTarget sees display:none and the arrow/spotlight have no target.
  const sampleImport = document.getElementById('btnTutorialSampleImport') as HTMLButtonElement | null;
  if (sampleImport) sampleImport.style.display = step.id === 'import-sample' ? 'flex' : 'none';
  if (lastTarget) lastTarget.classList.remove('tutorial-target');
  lastTarget = findVisibleTarget(step.target);
  if (lastTarget) {
    lastTarget.classList.add('tutorial-target');
    lastTarget.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
  }
  document.getElementById('tutorialTitle')!.textContent = step.title;
  document.getElementById('tutorialText')!.textContent = step.text;
  document.getElementById('tutorialProgress')!.textContent = `${Math.max(1, stepIndex)} / ${STEPS.length - 1}`;
  document.getElementById('tutorialNext')!.textContent = step.id === 'finish' ? 'Selesai' : 'Lanjutkan';
  (document.getElementById('tutorialNext') as HTMLButtonElement).hidden = step.id !== 'finish';
  overlay.style.zIndex = ['general-settings', 'prompt-settings', 'edit-prompt', 'save-settings'].includes(step.id) ? '2020' : '150';
  const sampleAction = document.getElementById('tutorialPracticeAction') as HTMLButtonElement;
  sampleAction.hidden = step.id !== 'copy-answer';
  sampleAction.textContent = 'Salin Jawaban Contoh';
  (document.getElementById('tutorialVoice') as HTMLButtonElement).innerHTML = voiceEnabled ? SOUND_ON : SOUND_OFF;
  document.getElementById('tutorialVoice')!.setAttribute('aria-pressed', String(voiceEnabled));
  overlay.setAttribute('aria-label', `Latihan interaktif, langkah ${Math.max(1, stepIndex)} dari ${STEPS.length - 1}`);
  if (step.id === 'edit-prompt') promptBeforeEdit = (document.getElementById('settingsPromptInput') as HTMLTextAreaElement | null)?.value || '';
  playCurrentAudio();
  requestAnimationFrame(() => {
    positionCardAwayFromTarget();
    drawArrow();
  });
}

function positionCardAwayFromTarget(): void {
  const card = document.getElementById('tutorialCard');
  if (!card || !lastTarget) return;
  card.classList.remove('tutorial-card-top', 'tutorial-card-bottom');
  const box = card.getBoundingClientRect();
  const target = lastTarget.getBoundingClientRect();
  const overlaps = box.left < target.right && box.right > target.left && box.top < target.bottom && box.bottom > target.top;
  if (!overlaps) return;
  card.classList.add(target.top + target.height / 2 < window.innerHeight / 2 ? 'tutorial-card-bottom' : 'tutorial-card-top');
}

function closeTutorial(): void {
  stopAudio();
  const overlay = document.getElementById('tutorialOverlay')!;
  overlay.setAttribute('hidden', '');
  overlay.style.zIndex = '';
  tutorialActive = false;
  if (lastTarget) lastTarget.classList.remove('tutorial-target');
  lastTarget = null;
  const sampleImport = document.getElementById('btnTutorialSampleImport') as HTMLButtonElement | null;
  if (sampleImport) sampleImport.style.display = 'none';
  localStorage.setItem(STORAGE_KEY, '1');
}

function waitFor(check: () => boolean, complete: () => void, timeoutMs = 120000): void {
  const started = Date.now();
  const timer = window.setInterval(() => {
    if (check()) {
      window.clearInterval(timer);
      complete();
    } else if (Date.now() - started > timeoutMs) {
      window.clearInterval(timer);
    }
  }, 120);
}

function goTo(id: StepId): void {
  const next = STEPS.findIndex((step) => step.id === id);
  if (next < 0) return;
  stepIndex = next;
  renderStep();
}

function handleGuidedClick(event: MouseEvent): void {
  if (!tutorialActive || document.getElementById('tutorialOverlay')?.hasAttribute('hidden')) return;
  const step = STEPS[stepIndex];
  const element = event.target instanceof Element ? event.target : null;
  if (!element) return;
  const clicked = (selector: string) => !!element.closest(selector);
  switch (step.id) {
    case 'dashboard':
      if (clicked('#btnBackToDashboard')) waitFor(() => isVisible(document.getElementById('btnNewProject')), () => goTo('create'));
      break;
    case 'create':
      if (clicked('#btnNewProject')) waitFor(() => isVisible(document.getElementById('workspaceView')), () => goTo('open-import'));
      break;
    case 'open-import':
      if (clicked('#btnDropdownImport')) window.setTimeout(() => goTo('import-sample'), 120);
      break;
    case 'select-line':
      if (clicked('.preview-row:not(.separator) input[type="checkbox"]')) waitFor(() => state.selectedLines.size > 0, () => goTo('copy-prompt'), 5000);
      break;
    case 'copy-prompt':
      if (clicked('#btnCopyForAi')) window.setTimeout(() => goTo('copy-answer'), 250);
      break;
    case 'copy-answer':
      if (clicked('#tutorialPracticeAction')) {
        void writeClipboardText(SAMPLE_TRANSLATION).then((ok) => {
          if (ok) goTo('paste-answer');
          else document.getElementById('tutorialText')!.textContent = 'Clipboard tidak tersedia. Salin teks ini secara manual: ' + SAMPLE_TRANSLATION;
        });
      }
      break;
    case 'paste-answer':
      if (clicked('#pasteArea')) {
        const pasteArea = document.getElementById('pasteArea') as HTMLTextAreaElement;
        const pasted = () => {
          if (pasteArea.value.includes('Halo! Hari ini cuacanya cerah')) {
            pasteArea.removeEventListener('input', pasted);
            pasteArea.removeEventListener('paste', onPaste);
            goTo('apply-answer');
          }
        };
        const onPaste = () => window.setTimeout(pasted, 0);
        pasteArea.addEventListener('input', pasted);
        pasteArea.addEventListener('paste', onPaste);
      }
      break;
    case 'apply-answer':
      if (clicked('#btnApply')) waitFor(() => state.lines.some((line) => line.is_translated && !!line.trans_message), () => goTo('open-settings'), 10000);
      break;
    case 'open-settings':
      if (clicked('#btnSettingsGeneral')) waitFor(() => isVisible(document.getElementById('settingsModal')), () => goTo('general-settings'), 10000);
      break;
    case 'general-settings':
      if (clicked('#btnTabSettingsGeneral')) window.setTimeout(() => goTo('prompt-settings'), 120);
      break;
    case 'prompt-settings':
      if (clicked('#btnTabSettingsPrompts')) window.setTimeout(() => goTo('edit-prompt'), 160);
      break;
    case 'edit-prompt': {
      const input = document.getElementById('settingsPromptInput') as HTMLTextAreaElement | null;
      if (input && element === input) {
        const changed = () => {
          if (input.value.trim() && input.value !== promptBeforeEdit) {
            input.removeEventListener('input', changed);
            goTo('save-settings');
          }
        };
        input.addEventListener('input', changed);
      }
      break;
    }
    case 'save-settings':
      if (clicked('#btnSettingsSave')) waitFor(() => !isVisible(document.getElementById('settingsModal')), () => goTo('finish'), 10000);
      break;
    default:
      break;
  }
}

export function initTutorial(): void {
  const overlay = document.getElementById('tutorialOverlay')!;
  document.getElementById('btnReplayTutorial')?.addEventListener('click', () => {
    stepIndex = 1;
    tutorialActive = true;
    overlay.removeAttribute('hidden');
    renderStep();
  });
  document.addEventListener('click', handleGuidedClick, true);
  document.getElementById('btnTutorialSampleImport')?.addEventListener('click', async () => {
    if (importBusy) return;
    importBusy = true;
    try {
      await handleImportLogic([SAMPLE_FILE]);
      if (state.lines.length > 0) goTo('select-line');
    } finally {
      importBusy = false;
    }
  });
  document.getElementById('tutorialNext')?.addEventListener('click', () => {
    if (STEPS[stepIndex].id === 'finish') closeTutorial();
  });
  document.getElementById('tutorialPracticeAction')?.addEventListener('click', () => {
    // The delegated guided handler writes the sample answer to the real clipboard.
  });
  document.getElementById('tutorialSkip')?.addEventListener('click', closeTutorial);
  document.getElementById('tutorialClose')?.addEventListener('click', closeTutorial);
  document.getElementById('tutorialVoice')?.addEventListener('click', () => {
    if (voiceEnabled && audio && !audio.paused) {
      voiceEnabled = false;
      stopAudio();
    } else {
      voiceEnabled = true;
      playCurrentAudio();
    }
    const button = document.getElementById('tutorialVoice')!;
    button.innerHTML = voiceEnabled ? SOUND_ON : SOUND_OFF;
    button.setAttribute('aria-pressed', String(voiceEnabled));
  });
  window.addEventListener('resize', drawArrow);
  window.addEventListener('scroll', drawArrow, true);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !overlay.hasAttribute('hidden')) closeTutorial();
  });
  if (!localStorage.getItem(STORAGE_KEY)) {
    window.setTimeout(() => {
      if (!localStorage.getItem(STORAGE_KEY)) {
        stepIndex = 1;
        const dashboard = document.getElementById('dashboardView');
        const workspace = document.getElementById('workspaceView');
        if (isVisible(dashboard) && !isVisible(workspace)) {
          tutorialActive = true;
          overlay.removeAttribute('hidden');
          renderStep();
        }
      }
    }, 700);
  }
}
