/**
 * Where the game's extra content (weapons, skins, characters, sounds) comes
 * from: either an `assets/pack` folder served next to the page, or an asset
 * pack (.zip of that folder) the player picks. A picked pack is copied into
 * the browser's private file storage, so it is picked only once; files are
 * read from it on demand, never all at once.
 *
 * Both kinds answer the same calls: fetch(path) -> Response, and url(path)
 * for things the page shows directly (images, icons, fonts).
 */
import { ZipFile } from './formats/zipFile.js';

const FOLDER = 'assets/pack/';
const STORED_PACK = 'asset-pack.zip';
const MANIFEST = 'manifest.json';
const TYPES = { webp: 'image/webp', svg: 'image/svg+xml', png: 'image/png', wav: 'audio/wav', mp3: 'audio/mpeg', json: 'application/json', ttf: 'font/ttf' };

const typeOf = (path) => TYPES[path.slice(path.lastIndexOf('.') + 1)] ?? 'application/octet-stream';

/** Files served by the web server, next to the page. */
class FolderPack {
  constructor(base) {
    this.base = base;
  }

  fetch(path) {
    return fetch(this.base + path);
  }

  async url(path) {
    return this.base + path;
  }
}

/** Files inside a .zip. Paths inside may start at the folder itself or at its parent. */
class ZipPack {
  constructor(zip) {
    this.zip = zip;
    this.prefix = zip.has(MANIFEST) ? '' : [...zip.entries.keys()].find((path) => path.endsWith(`/${MANIFEST}`))?.slice(0, -MANIFEST.length) ?? '';
    this.urls = new Map();
  }

  async fetch(path) {
    const blob = await this.zip.read(this.prefix + path, typeOf(path));
    return blob ? new Response(blob, { headers: { 'Content-Type': blob.type } }) : new Response(null, { status: 404 });
  }

  /** An object URL for a file, made once and kept (icons are small and reused). */
  url(path) {
    if (!this.urls.has(path)) {
      this.urls.set(path, this.zip.read(this.prefix + path, typeOf(path)).then((blob) => (blob ? URL.createObjectURL(blob) : '')));
    }
    return this.urls.get(path);
  }
}

async function storage() {
  return navigator.storage?.getDirectory ? navigator.storage.getDirectory() : null;
}

async function openZip(blob) {
  const pack = new ZipPack(await ZipFile.open(blob));
  if (!pack.zip.has(pack.prefix + MANIFEST)) throw new Error('This .zip is not an asset pack (it has no manifest.json).');
  return pack;
}

/** The served folder if there is one, else a pack picked on an earlier visit, else null. */
export async function openAssetPack() {
  try {
    const response = await fetch(FOLDER + MANIFEST, { method: 'HEAD' });
    if (response.ok) return new FolderPack(FOLDER);
  } catch { /* no server folder */ }
  try {
    const directory = await storage();
    const handle = await directory?.getFileHandle(STORED_PACK);
    if (handle) return await openZip(await handle.getFile());
  } catch { /* nothing stored yet */ }
  return null;
}

/**
 * Uses a picked .zip: checks it, copies it into the browser's file storage
 * (reporting progress as a fraction) and opens the copy. Resolves to
 * { pack, stored }; when the browser has no room for it, the picked file
 * is used directly and stored is false (it is asked for again next visit).
 */
export async function installAssetPack(file, onProgress = () => {}) {
  await openZip(file);   // reject a wrong file before copying it
  const directory = await storage();
  if (!directory) return { pack: await openZip(file), stored: false };   // no file storage: this visit only
  await navigator.storage.persist?.();
  const { quota = Infinity, usage = 0 } = await navigator.storage.estimate?.() ?? {};
  if (quota - usage < file.size) return { pack: await openZip(file), stored: false };
  try {
    const handle = await directory.getFileHandle(STORED_PACK, { create: true });
    const writable = await handle.createWritable();
    let written = 0;
    const counting = new TransformStream({
      transform(chunk, controller) {
        written += chunk.byteLength;
        onProgress(written / file.size);
        controller.enqueue(chunk);
      },
    });
    await file.stream().pipeThrough(counting).pipeTo(writable);
    return { pack: await openZip(await handle.getFile()), stored: true };
  } catch {
    // Not enough room to keep it: use the picked file for this visit only.
    await directory.removeEntry(STORED_PACK).catch(() => {});
    return { pack: await openZip(file), stored: false };
  }
}

/** Forgets a stored pack. */
export async function removeAssetPack() {
  const directory = await storage();
  await directory?.removeEntry(STORED_PACK).catch(() => {});
}
