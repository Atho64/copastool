// @module native-notify.ts — Fully local OS notifications via Tauri.
// Never touches the browser Notification API: Windows gets an Action Center
// toast, Android gets a real status-bar notification with a one-time runtime
// permission prompt (POST_NOTIFICATIONS on Android 13+), similar in spirit to
// the clipboard access prompt. On plain web builds this is a no-op and the
// in-app toast remains the only feedback.

import { isTauri } from './native-storage';

let permissionAsked = false;

export async function isNativeNotifySupported(): Promise<boolean> {
  return isTauri();
}

/**
 * Posts a local OS notification. Requests permission on first use; if the user
 * denies (or the platform has no notification support) it silently returns
 * false so callers keep relying on the in-app toast.
 */
export async function nativeNotify(title: string, body: string): Promise<boolean> {
  if (!isTauri()) return false;
  try {
    const notif: any = await import('@tauri-apps/plugin-notification');
    let granted = false;
    try {
      granted = await notif.isPermissionGranted();
    } catch (_) {
      // Desktop platforms don't need a runtime grant.
      granted = true;
    }
    if (!granted && !permissionAsked) {
      permissionAsked = true;
      try {
        const res = await notif.requestPermission();
        granted = res === 'granted' || res === true;
      } catch (_) {
        granted = false;
      }
      if (!granted) return false;
    } else if (!granted) {
      return false;
    }
    notif.sendNotification({ title, body });
    return true;
  } catch (err) {
    console.warn('[NativeNotify] failed to post native notification:', err);
    return false;
  }
}
