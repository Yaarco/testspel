/**
 * Writes a folder into a .zip without compression (the files are already
 * compressed images, models and sounds), streaming one file at a time.
 * Uses zip64 records when the archive passes 4 GB.
 */
import { closeSync, openSync, readdirSync, readFileSync, statSync, writeSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { crc32 } from 'node:zlib';

const LIMIT = 0xffffffff;

function u16(value) { const b = Buffer.alloc(2); b.writeUInt16LE(value); return b; }
function u32(value) { const b = Buffer.alloc(4); b.writeUInt32LE(value); return b; }
function u64(value) { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(value)); return b; }

export function zipFolder(folder, target, skip = () => false) {
  const files = readdirSync(folder, { recursive: true })
    .map((name) => join(folder, name))
    .filter((path) => statSync(path).isFile() && path !== target && !skip(path))
    .sort();
  const out = openSync(target, 'w');
  const directory = [];
  let offset = 0;
  const write = (buffer) => { writeSync(out, buffer); offset += buffer.length; };

  for (const path of files) {
    const name = Buffer.from(relative(folder, path).split(sep).join('/'));
    const data = readFileSync(path);
    const crc = crc32(data);
    const start = offset;
    const big = data.length >= LIMIT || start >= LIMIT;
    const extra = big ? Buffer.concat([u16(1), u16(16), u64(data.length), u64(data.length)]) : Buffer.alloc(0);
    write(Buffer.concat([
      u32(0x04034b50), u16(big ? 45 : 20), u16(0x0800), u16(0), u16(0), u16(0), u32(crc),
      u32(big ? LIMIT : data.length), u32(big ? LIMIT : data.length), u16(name.length), u16(extra.length), name, extra,
    ]));
    write(data);
    directory.push({ name, crc, size: data.length, start });
  }

  const directoryStart = offset;
  for (const { name, crc, size, start } of directory) {
    const big = size >= LIMIT || start >= LIMIT;
    const extra = big ? Buffer.concat([u16(1), u16(24), u64(size), u64(size), u64(start)]) : Buffer.alloc(0);
    write(Buffer.concat([
      u32(0x02014b50), u16(45), u16(big ? 45 : 20), u16(0x0800), u16(0), u16(0), u16(0), u32(crc),
      u32(big ? LIMIT : size), u32(big ? LIMIT : size), u16(name.length), u16(extra.length), u16(0), u16(0), u16(0),
      u32(0), u32(big ? LIMIT : start), name, extra,
    ]));
  }
  const directorySize = offset - directoryStart;
  const count = directory.length;
  const zip64 = directoryStart >= LIMIT || count >= 0xffff;
  if (zip64) {
    const recordAt = offset;
    write(Buffer.concat([
      u32(0x06064b50), u64(44), u16(45), u16(45), u32(0), u32(0), u64(count), u64(count), u64(directorySize), u64(directoryStart),
      u32(0x07064b50), u32(0), u64(recordAt), u32(1),
    ]));
  }
  write(Buffer.concat([
    u32(0x06054b50), u16(0), u16(0), u16(Math.min(count, 0xffff)), u16(Math.min(count, 0xffff)),
    u32(Math.min(directorySize, LIMIT)), u32(zip64 ? LIMIT : directoryStart), u16(0),
  ]));
  closeSync(out);
  return { files: count, bytes: offset };
}
