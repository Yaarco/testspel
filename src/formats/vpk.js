/**
 * Reader for .vpk pack files (versions 1 and 2). A set is one "<name>_dir.vpk" index plus numbered
 * "<name>_000.vpk" archives. Only the directory tree is read up front; each
 * file is later sliced straight out of its archive on disk, so the archives
 * are never loaded into memory as a whole.
 */
import { normalizePath } from './zip.js';

const SIGNATURE = 0x55aa1234;
const IN_DIRECTORY_FILE = 0x7fff;
const TERMINATOR = 0xffff;

function readTree(bytes) {
  const decoder = new TextDecoder('latin1');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 0;
  const readString = () => {
    const start = at;
    while (bytes[at] !== 0) at++;
    return decoder.decode(bytes.subarray(start, at++));
  };

  const entries = new Map();
  for (let extension = readString(); extension; extension = readString()) {
    for (let folder = readString(); folder; folder = readString()) {
      for (let name = readString(); name; name = readString()) {
        const preloadSize = view.getUint16(at + 4, true);
        const entry = {
          archive: view.getUint16(at + 6, true),
          offset: view.getUint32(at + 8, true),
          length: view.getUint32(at + 12, true),
          preload: bytes.subarray(at + 18, at + 18 + preloadSize),
        };
        if (view.getUint16(at + 16, true) !== TERMINATOR) throw new Error('Damaged .vpk directory.');
        at += 18 + preloadSize;
        const path = folder === ' ' ? `${name}.${extension}` : `${folder}/${name}.${extension}`;
        entries.set(normalizePath(path), entry);
      }
    }
  }
  return entries;
}

export class VpkArchive {
  constructor(name, dirFile, archives, entries, dataOffset) {
    this.name = name;
    this.dirFile = dirFile;
    this.archives = archives;
    this.entries = entries;
    this.dataOffset = dataOffset;
  }

  static async open(name, dirFile, archives) {
    const header = new DataView(await dirFile.slice(0, 28).arrayBuffer());
    if (header.getUint32(0, true) !== SIGNATURE) throw new Error(`${dirFile.name} is not a .vpk file.`);
    const version = header.getUint32(4, true);
    const headerSize = version === 2 ? 28 : 12;
    const treeSize = header.getUint32(8, true);
    const tree = new Uint8Array(await dirFile.slice(headerSize, headerSize + treeSize).arrayBuffer());
    return new VpkArchive(name, dirFile, archives, readTree(tree), headerSize + treeSize);
  }

  has(path) {
    return this.entries.has(normalizePath(path));
  }

  /** File contents, or null if missing (including when its archive was not selected). */
  async read(path) {
    const entry = this.entries.get(normalizePath(path));
    if (!entry) return null;
    if (entry.length === 0) return entry.preload;

    const inDirectory = entry.archive === IN_DIRECTORY_FILE;
    const file = inDirectory ? this.dirFile : this.archives.get(entry.archive);
    if (!file) return null;
    const start = entry.offset + (inDirectory ? this.dataOffset : 0);
    const body = new Uint8Array(await file.slice(start, start + entry.length).arrayBuffer());
    if (entry.preload.length === 0) return body;

    const whole = new Uint8Array(entry.preload.length + body.length);
    whole.set(entry.preload);
    whole.set(body, entry.preload.length);
    return whole;
  }
}

/**
 * Groups picked files into VPK sets by name, e.g. textures_dir.vpk with
 * textures_000.vpk ... Sets without a _dir file are ignored.
 */
export async function openVpkSets(files) {
  const sets = new Map();
  for (const file of files) {
    const match = file.name.toLowerCase().match(/^(.*)_(dir|\d{3})\.vpk$/);
    if (!match) continue;
    const set = sets.get(match[1]) ?? { archives: new Map() };
    if (match[2] === 'dir') set.dirFile = file;
    else set.archives.set(Number(match[2]), file);
    sets.set(match[1], set);
  }
  const opened = [];
  for (const [name, set] of sets) {
    if (set.dirFile) opened.push(await VpkArchive.open(name, set.dirFile, set.archives));
  }
  return opened;
}
