/** Small helpers shared by the asset pack tools. */
import { readFileSync } from 'node:fs';

export const readText = (path) => readFileSync(path, 'utf8').replace(/^\uFEFF/, '');
export const first = (value) => (Array.isArray(value) ? value[0] : value);
export const lines = (list) => [...new Set(list)].filter(Boolean).sort().map((line) => `${line}\n`).join('');
export const withoutExtension = (path) => path.replace(/\.[^./]+$/, '');
export const compiled = (resource) => `${resource}_c`;
export const webp = (resource) => `${withoutExtension(resource)}.webp`;

/** KeyValues blocks that appear several times (items_game repeats "items", "paint_kits", ...) merged into one. */
export function mergeBlocks(blocks = []) {
  const merged = {};
  for (const block of blocks) for (const [key, values] of Object.entries(block)) merged[key] = values[0];
  return merged;
}

/** Strips the one-element arrays parseKeyValueList wraps every value in. */
export function unwrap(value) {
  if (!Array.isArray(value)) return value;
  const item = value[0];
  if (typeof item !== 'object') return item;
  return Object.fromEntries(Object.entries(item).map(([key, inner]) => [key, unwrap(inner)]));
}

export function deepAssign(target, source) {
  for (const [key, value] of Object.entries(source)) {
    if (value && typeof value === 'object' && target[key] && typeof target[key] === 'object') deepAssign(target[key], value);
    else target[key] = value;
  }
  return target;
}

