/**
 * Minimal zip reader for the pakfile embedded in a BSP. Maps pack their files
 * uncompressed (stored), so only stored entries are read.
 * Paths are matched case-insensitively with forward slashes.
 */
const END_OF_DIRECTORY = 0x06054b50;
const DIRECTORY_ENTRY = 0x02014b50;
const STORED = 0;

export function normalizePath(path) {
  return path.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\//, '').toLowerCase();
}

export class ZipArchive {
  constructor(bytes) {
    this.bytes = bytes;
    this.entries = new Map();
    if (bytes.length < 22) return;

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let end = bytes.length - 22;
    while (end >= 0 && view.getUint32(end, true) !== END_OF_DIRECTORY) end--;
    if (end < 0) return;

    const count = view.getUint16(end + 10, true);
    let at = view.getUint32(end + 16, true);
    const decoder = new TextDecoder('latin1');
    for (let i = 0; i < count && view.getUint32(at, true) === DIRECTORY_ENTRY; i++) {
      const method = view.getUint16(at + 10, true);
      const size = view.getUint32(at + 20, true);
      const nameLength = view.getUint16(at + 28, true);
      const extraLength = view.getUint16(at + 30, true);
      const commentLength = view.getUint16(at + 32, true);
      const localHeader = view.getUint32(at + 42, true);
      const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength));
      if (method === STORED) this.entries.set(normalizePath(name), { localHeader, size });
      at += 46 + nameLength + extraLength + commentLength;
    }
    this.view = view;
  }

  has(path) {
    return this.entries.has(normalizePath(path));
  }

  /** Paths of every file in the archive (normalized). */
  paths() {
    return [...this.entries.keys()];
  }

  /** File contents as bytes, or null when the archive does not have it. */
  read(path) {
    const entry = this.entries.get(normalizePath(path));
    if (!entry) return null;
    const nameLength = this.view.getUint16(entry.localHeader + 26, true);
    const extraLength = this.view.getUint16(entry.localHeader + 28, true);
    const start = entry.localHeader + 30 + nameLength + extraLength;
    return this.bytes.subarray(start, start + entry.size);
  }

  readText(path) {
    const bytes = this.read(path);
    return bytes ? new TextDecoder('latin1').decode(bytes) : null;
  }
}
