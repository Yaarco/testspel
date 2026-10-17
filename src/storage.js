/**
 * Settings and choices kept between sessions in localStorage. Storage can
 * be unavailable (private windows, blocked site data), so every read falls
 * back to a default and every write may silently do nothing.
 */
function read(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

export const storage = {
  number(key, fallback) {
    const stored = read(key);
    const value = Number(stored);
    return stored !== null && Number.isFinite(value) ? value : fallback;
  },
  text(key, fallback = '') {
    return read(key) ?? fallback;
  },
  json(key, fallback) {
    try { return JSON.parse(read(key)) ?? fallback; } catch { return fallback; }
  },
  /** Saves a number or string as is, anything else as JSON. */
  save(key, value) {
    try { localStorage.setItem(key, typeof value === 'object' ? JSON.stringify(value) : String(value)); } catch { /* storage unavailable */ }
  },
};
