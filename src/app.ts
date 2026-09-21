// @module app.ts — Entry point: bootstraps the application on DOMContentLoaded
// All business logic lives in the other modules in this directory.

window.onerror = function(message, source, lineno, colno, error) {
  // ResizeObserver loop is a benign browser warning — ignore it
  if (typeof message === 'string' && message.includes('ResizeObserver')) return true;
  const errDiv = document.createElement('div');
  errDiv.style.cssText = 'position:fixed;top:0;left:0;width:100%;background:red;color:white;z-index:9999;padding:10px;font-family:monospace;white-space:pre-wrap;cursor:pointer;';
  errDiv.textContent = `[Klik untuk menutup]\nError: ${message}\nSource: ${source}\nLine: ${lineno}:${colno}\nStack: ${error?.stack}`;
  errDiv.onclick = () => errDiv.remove();
  document.body.appendChild(errDiv);
};

window.addEventListener('unhandledrejection', function(event) {
  const errDiv = document.createElement('div');
  errDiv.style.cssText = 'position:fixed;top:50px;left:0;width:100%;background:darkred;color:white;z-index:9999;padding:10px;font-family:monospace;white-space:pre-wrap;cursor:pointer;';
  errDiv.textContent = `[Klik untuk menutup]\nUnhandled Promise Rejection: ${event.reason?.message || event.reason}\nStack: ${event.reason?.stack}`;
  errDiv.onclick = () => errDiv.remove();
  document.body.appendChild(errDiv);
});

import { init } from './ui-init';
import { initExtensionBridge } from './extension-bridge';

// Inject critical dynamic CSS that Vite may strip from external stylesheet
(function injectDynamicStyles() {
  const style = document.createElement('style');
  style.id = 'cstl-dynamic-styles';
  style.textContent = [
    '.preview-row.row-translated { border-left: 3px solid #10b981 !important; }',
    '.preview-row.row-ai-checked { border-left: 3px solid #f59e0b !important; }',
  ].join('\n');
  document.head.appendChild(style);
})();

function removeLoader() {
  const loader = document.getElementById('startupLoader');
  if (!loader) return;
  loader.classList.add('fade-out');
  setTimeout(() => loader.remove(), 250);
}

async function bootstrap() {
  try {
    await init();
  } finally {
    removeLoader();
  }
  initExtensionBridge();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootstrap);
} else {
  bootstrap();
}
