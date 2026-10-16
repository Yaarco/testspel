/**
 * Reader for .vtf texture files, versions 7.0 to 7.5.
 * Decodes the full-size mip level of every frame into RGBA8 pixels;
 * the renderer builds its own mipmaps from that.
 */
const FORMAT = {
  RGBA8888: 0, ABGR8888: 1, RGB888: 2, BGR888: 3, RGB565: 4, I8: 5, IA88: 6, A8: 8,
  ARGB8888: 11, BGRA8888: 12, DXT1: 13, DXT3: 14, DXT5: 15, BGRX8888: 16, DXT1_ONEBITALPHA: 20,
};
const BYTES_PER_PIXEL = {
  0: 4, 1: 4, 2: 3, 3: 3, 4: 2, 5: 1, 6: 2, 7: 1, 8: 1, 9: 3, 10: 3, 11: 4, 12: 4,
  16: 4, 17: 2, 18: 2, 19: 2, 21: 2, 22: 2, 23: 4, 24: 8, 25: 8, 26: 4,
};
const FLAG_ENVMAP = 0x4000;
const HIGH_RES_RESOURCE = 0x30;

function imageSize(format, width, height) {
  const blocks = Math.max(1, Math.ceil(width / 4)) * Math.max(1, Math.ceil(height / 4));
  if (format === FORMAT.DXT1 || format === FORMAT.DXT1_ONEBITALPHA) return blocks * 8;
  if (format === FORMAT.DXT3 || format === FORMAT.DXT5) return blocks * 16;
  return width * height * (BYTES_PER_PIXEL[format] ?? 4);
}

/** Expands a 5:6:5 color to 8-bit channels. */
function rgb565(value) {
  return [((value >> 11) & 31) * 255 / 31, ((value >> 5) & 63) * 255 / 63, (value & 31) * 255 / 31];
}

function decodeColorBlock(src, at, out, width, height, bx, by, punchThrough) {
  const c0 = src[at] | (src[at + 1] << 8);
  const c1 = src[at + 2] | (src[at + 3] << 8);
  const [a, b] = [rgb565(c0), rgb565(c1)];
  const palette = c0 > c1 || !punchThrough
    ? [a, b, a.map((v, i) => (2 * v + b[i]) / 3), a.map((v, i) => (v + 2 * b[i]) / 3)]
    : [a, b, a.map((v, i) => (v + b[i]) / 2), [0, 0, 0]];
  const transparentIndex = c0 > c1 || !punchThrough ? -1 : 3;

  for (let y = 0; y < 4; y++) {
    const bits = src[at + 4 + y];
    for (let x = 0; x < 4; x++) {
      const px = bx * 4 + x;
      const py = by * 4 + y;
      if (px >= width || py >= height) continue;
      const index = (bits >> (x * 2)) & 3;
      const o = (py * width + px) * 4;
      const color = palette[index];
      out[o] = color[0];
      out[o + 1] = color[1];
      out[o + 2] = color[2];
      out[o + 3] = index === transparentIndex ? 0 : 255;
    }
  }
}

function decodeDxt(src, format, width, height) {
  const out = new Uint8Array(width * height * 4);
  const blockBytes = format === FORMAT.DXT3 || format === FORMAT.DXT5 ? 16 : 8;
  const blocksWide = Math.max(1, Math.ceil(width / 4));
  const blocksHigh = Math.max(1, Math.ceil(height / 4));

  for (let by = 0; by < blocksHigh; by++) {
    for (let bx = 0; bx < blocksWide; bx++) {
      const at = (by * blocksWide + bx) * blockBytes;
      const colorAt = blockBytes === 16 ? at + 8 : at;
      decodeColorBlock(src, colorAt, out, width, height, bx, by, format !== FORMAT.DXT3 && format !== FORMAT.DXT5);
      if (format === FORMAT.DXT3) decodeExplicitAlpha(src, at, out, width, height, bx, by);
      if (format === FORMAT.DXT5) decodeInterpolatedAlpha(src, at, out, width, height, bx, by);
    }
  }
  return out;
}

function decodeExplicitAlpha(src, at, out, width, height, bx, by) {
  for (let i = 0; i < 16; i++) {
    const px = bx * 4 + (i % 4);
    const py = by * 4 + Math.floor(i / 4);
    if (px >= width || py >= height) continue;
    const nibble = (src[at + (i >> 1)] >> ((i & 1) * 4)) & 15;
    out[(py * width + px) * 4 + 3] = nibble * 17;
  }
}

function decodeInterpolatedAlpha(src, at, out, width, height, bx, by) {
  const a0 = src[at];
  const a1 = src[at + 1];
  const alphas = [a0, a1];
  for (let i = 1; i <= (a0 > a1 ? 6 : 4); i++) {
    const steps = a0 > a1 ? 7 : 5;
    alphas.push(((steps - i) * a0 + i * a1) / steps);
  }
  if (a0 <= a1) alphas.push(0, 255);

  // 16 three-bit indices in 48 bits, read as two 24-bit halves.
  const low = src[at + 2] | (src[at + 3] << 8) | (src[at + 4] << 16);
  const high = src[at + 5] | (src[at + 6] << 8) | (src[at + 7] << 16);
  for (let i = 0; i < 16; i++) {
    const px = bx * 4 + (i % 4);
    const py = by * 4 + Math.floor(i / 4);
    if (px >= width || py >= height) continue;
    const index = i < 8 ? (low >> (3 * i)) & 7 : (high >> (3 * (i - 8))) & 7;
    out[(py * width + px) * 4 + 3] = alphas[index];
  }
}

/** Converts uncompressed formats to RGBA8. */
function decodeUncompressed(src, format, width, height) {
  const out = new Uint8Array(width * height * 4);
  const bpp = BYTES_PER_PIXEL[format];
  for (let i = 0; i < width * height; i++) {
    const s = i * bpp;
    const o = i * 4;
    let rgba;
    switch (format) {
      case FORMAT.RGBA8888: rgba = [src[s], src[s + 1], src[s + 2], src[s + 3]]; break;
      case FORMAT.ABGR8888: rgba = [src[s + 3], src[s + 2], src[s + 1], src[s]]; break;
      case FORMAT.RGB888: rgba = [src[s], src[s + 1], src[s + 2], 255]; break;
      case FORMAT.BGR888: rgba = [src[s + 2], src[s + 1], src[s], 255]; break;
      case FORMAT.ARGB8888: rgba = [src[s + 1], src[s + 2], src[s + 3], src[s]]; break;
      case FORMAT.BGRA8888: rgba = [src[s + 2], src[s + 1], src[s], src[s + 3]]; break;
      case FORMAT.BGRX8888: rgba = [src[s + 2], src[s + 1], src[s], 255]; break;
      case FORMAT.I8: rgba = [src[s], src[s], src[s], 255]; break;
      case FORMAT.IA88: rgba = [src[s], src[s], src[s], src[s + 1]]; break;
      case FORMAT.A8: rgba = [255, 255, 255, src[s]]; break;
      case FORMAT.RGB565: rgba = [...rgb565(src[s] | (src[s + 1] << 8)), 255]; break;
      default: return null;
    }
    out.set(rgba, o);
  }
  return out;
}

const COMPRESSED = {
  [FORMAT.DXT1]: 'dxt1', [FORMAT.DXT1_ONEBITALPHA]: 'dxt1', [FORMAT.DXT3]: 'dxt3', [FORMAT.DXT5]: 'dxt5',
};
const FORMAT_FOR_NAME = { dxt1: FORMAT.DXT1, dxt3: FORMAT.DXT3, dxt5: FORMAT.DXT5 };

/** Expands one compressed mip level to RGBA8, for GPUs without S3TC support. */
export function decodeCompressed(format, data, width, height) {
  return decodeDxt(data, FORMAT_FOR_NAME[format], width, height);
}

/**
 * Parses a texture without decoding compressed data, so it can go to the GPU as is.
 * Returns { width, height, format, cube, frames } where format is 'dxt1', 'dxt3',
 * 'dxt5' or 'rgba', and frames[frame][face][mip] = { width, height, data },
 * largest mip first. Returns null for unsupported textures.
 */
export function parseVtf(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 64 || view.getUint32(0, true) !== 0x00465456) return null;   // "VTF\0"
  const minor = view.getUint32(8, true);
  const headerSize = view.getUint32(12, true);
  const width = view.getUint16(16, true);
  const height = view.getUint16(18, true);
  const flags = view.getUint32(20, true);
  const frameCount = Math.max(1, view.getUint16(24, true));
  const firstFrame = view.getUint16(26, true);
  const format = view.getInt32(52, true);
  const mipCount = Math.max(1, view.getUint8(56));
  const lowFormat = view.getInt32(57, true);
  const lowWidth = view.getUint8(61);
  const lowHeight = view.getUint8(62);
  const depth = minor >= 2 ? Math.max(1, view.getUint16(63, true)) : 1;
  const cube = (flags & FLAG_ENVMAP) !== 0;
  // Before 7.5, cubemaps carry a seventh sphere-map face unless firstFrame is 0xFFFF.
  const faceCount = cube ? (minor < 5 && firstFrame !== 0xffff ? 7 : 6) : 1;
  const compressed = COMPRESSED[format];
  if (!compressed && BYTES_PER_PIXEL[format] === undefined) return null;

  let offset = headerSize + (lowFormat >= 0 && lowWidth > 0 ? imageSize(lowFormat, lowWidth, lowHeight) : 0);
  if (minor >= 3) {
    const resourceCount = view.getUint32(68, true);
    for (let i = 0; i < resourceCount; i++) {
      if (view.getUint8(80 + i * 8) === HIGH_RES_RESOURCE) offset = view.getUint32(80 + i * 8 + 4, true);
    }
  }

  // Stored smallest mip first; within a mip: frames, then faces, then depth slices.
  const frames = Array.from({ length: frameCount }, () => Array.from({ length: Math.min(faceCount, 6) }, () => []));
  for (let mip = mipCount - 1; mip >= 0; mip--) {
    const w = Math.max(1, width >> mip);
    const h = Math.max(1, height >> mip);
    const size = imageSize(format, w, h);
    for (let frame = 0; frame < frameCount; frame++) {
      for (let face = 0; face < faceCount; face++) {
        if (offset + size * depth > bytes.length) return null;
        if (face < 6) {
          const raw = bytes.subarray(offset, offset + size);
          const data = compressed ? raw : decodeUncompressed(raw, format, w, h);
          if (!data) return null;
          frames[frame][face].unshift({ width: w, height: h, data });
        }
        offset += size * depth;
      }
    }
  }
  return { width, height, format: compressed ?? 'rgba', cube, frames };
}
