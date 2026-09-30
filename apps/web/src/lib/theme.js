/**
 * Light, dark or follow the device. The choice is per device (an officer's
 * phone on nights, the dispatcher's desk in daylight), so it lives in
 * localStorage; the resolved theme goes on <html data-theme> for the CSS.
 * index.html runs the same resolution before the first paint.
 */
const KEY = 'usc.theme';
const media = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
const listeners = new Set();

export function themePreference() {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'auto';
  } catch {
    return 'auto';
  }
}

export const resolvedTheme = (pref = themePreference()) => (pref === 'auto' ? (media?.matches ? 'dark' : 'light') : pref);

function apply() {
  const theme = resolvedTheme();
  document.documentElement.dataset.theme = theme;
  // The browser chrome on phones follows the page.
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#060D17' : '#001F3F');
  listeners.forEach((fn) => fn(theme));
}

export function setThemePreference(pref) {
  try {
    if (pref === 'auto') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, pref);
  } catch {
    /* private mode: the choice lasts for this page only */
  }
  apply();
}

export function onThemeChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

media?.addEventListener?.('change', () => themePreference() === 'auto' && apply());
if (typeof document !== 'undefined') apply();
