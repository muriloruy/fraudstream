export type Theme = 'light' | 'dark';
const KEY = 'fraudstream.theme'; // a UI preference only; never tokens (SPEC §8.2)

export function storedTheme(): Theme | null {
  try {
    const value = localStorage.getItem(KEY);
    return value === 'light' || value === 'dark' ? value : null;
  } catch {
    return null;
  }
}

export function preferredTheme(): Theme {
  return storedTheme() ?? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
}

export function applyTheme(theme: Theme, persist = true): void {
  document.documentElement.classList.toggle('dark', theme === 'dark');
  if (persist) {
    try {
      localStorage.setItem(KEY, theme);
    } catch {
      // storage unavailable (private mode): the choice lasts for this page only
    }
  }
}
