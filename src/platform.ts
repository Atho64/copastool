// @module platform.ts — Capability checks shared by all UI entry points

export function isAndroidPlatform(): boolean {
  return /Android/i.test(navigator.userAgent);
}

/** Keep desktop keyboard and Luna integration controls out of every mobile
 * layout, including tablets wider than the responsive CSS breakpoint. */
export function syncPlatformFeatures(): void {
  const android = isAndroidPlatform();
  document.documentElement.classList.toggle('platform-android', android);
  const desktopOnlyIds = [
    'btnLunaHookerOpen',
    'btnShortcutsOpen',
    'btnWorkspaceShortcutsOpen',
    'btnOpenShortcutsFromSettings',
    'btnTabSettingsShortcuts',
  ];
  for (const id of desktopOnlyIds) {
    const el = document.getElementById(id);
    if (!el) continue;
    // The menu containers style their rows with higher-specificity selectors
    // than the global [hidden] rule, so hide the item itself as well.
    el.style.display = android ? 'none' : '';
    el.setAttribute('aria-hidden', String(android));
    if (el instanceof HTMLButtonElement) el.disabled = android;
    if (android && id === 'btnTabSettingsShortcuts' && el.getAttribute('aria-selected') === 'true') {
      (document.getElementById('btnTabSettingsGeneral') as HTMLButtonElement | null)?.click();
    }
  }
}
