/**
 * Reads a .zip archive straight from a File (or Blob) without loading it:
 * only the central directory is read up front, and each file is sliced out
 * (and inflated, when deflated) when asked for. Handles archives larger
 * than 4 GB (zip64).
 */
const END_OF_DIRECTORY = 0x06054b50;
const ZIP64_END = 0x06064b50;
const ZIP64_LOCATOR = 0x07064b50;
const DIRECTORY_ENTRY = 0x02014b50;
const STORED = 0;
const DEFLATED = 8;
const TAIL = 66000;   // end of central directory record plus the longest comment

async function bytesOf(blob, start, end) {
  return new Uint8Array(await blob.slice(start, end).arrayBuffer());
}

export class ZipFile {
  /** Reads the directory of `blob`; resolves to the archive. */
  static async open(blob) {
    const archive = new ZipFile(blob);
    await archive.readDirectory();
    return archive;
  }

  constructor(blob) {
    this.blob = blob;
    this.entries = new Map();   // path -> { offset, size, compressed, method }
  }

  async readDirectory() {
    const size = this.blob.size;
    const tailStart = Math.max(0, size - TAIL);
    const tail = await bytesOf(this.blob, tailStart, size);
    const view = new DataView(tail.buffer);
    let end = tail.length - 22;
    while (end >= 0 && view.getUint32(end, true) !== END_OF_DIRECTORY) end--;
    if (end < 0) throw new Error('Not a .zip file.');

    let count = view.getUint16(end + 10, true);
    let directorySize = view.getUint32(end + 12, true);
    let directoryStart = view.getUint32(end + 16, true);
    if (directoryStart === 0xffffffff && end >= 20 && view.getUint32(end - 20, true) === ZIP64_LOCATOR) {
      const recordAt = Number(view.getBigUint64(end - 12, true));
      const record = new DataView((await bytesOf(this.blob, recordAt, recordAt + 56)).buffer);
      if (record.getUint32(0, true) !== ZIP64_END) throw new Error('Broken zip64 archive.');
      count = Number(record.getBigUint64(32, true));
      directorySize = Number(record.getBigUint64(40, true));
      directoryStart = Number(record.getBigUint64(48, true));
    }

    const directory = await bytesOf(this.blob, directoryStart, directoryStart + directorySize);
    const dir = new DataView(directory.buffer);
    const decoder = new TextDecoder();
    let at = 0;
    for (let i = 0; i < count && dir.getUint32(at, true) === DIRECTORY_ENTRY; i++) {
      const method = dir.getUint16(at + 10, true);
      let compressed = dir.getUint32(at + 20, true);
      let size = dir.getUint32(at + 24, true);
      const nameLength = dir.getUint16(at + 28, true);
      const extraLength = dir.getUint16(at + 30, true);
      const commentLength = dir.getUint16(at + 32, true);
      let offset = dir.getUint32(at + 42, true);
      const name = decoder.decode(directory.subarray(at + 46, at + 46 + nameLength));
      // zip64 sizes and offset live in an extra field when the 32-bit ones are full.
      let extra = at + 46 + nameLength;
      const extraEnd = extra + extraLength;
      while (extra + 4 <= extraEnd) {
        const id = dir.getUint16(extra, true);
        const length = dir.getUint16(extra + 2, true);
        if (id === 0x0001) {
          let field = extra + 4;
          const next = () => { const value = Number(dir.getBigUint64(field, true)); field += 8; return value; };
          if (size === 0xffffffff) size = next();
          if (compressed === 0xffffffff) compressed = next();
          if (offset === 0xffffffff) offset = next();
        }
        extra += 4 + length;
      }
      if (!name.endsWith('/')) this.entries.set(name.replace(/^\.?\//, ''), { offset, size, compressed, method });
      at = extraEnd + commentLength;
    }
  }

  has(path) {
    return this.entries.has(path);
  }

  /** A file's contents as a Blob, or null when the archive does not have it. */
  async read(path, type = '') {
    const entry = this.entries.get(path);
    if (!entry) return null;
    const header = new DataView((await bytesOf(this.blob, entry.offset, entry.offset + 30)).buffer);
    const start = entry.offset + 30 + header.getUint16(26, true) + header.getUint16(28, true);
    const data = this.blob.slice(start, start + entry.compressed, type);
    if (entry.method === STORED) return data;
    if (entry.method !== DEFLATED) throw new Error(`${path}: unsupported compression.`);
    const inflated = data.stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Blob([await new Response(inflated).arrayBuffer()], { type });
  }
}
