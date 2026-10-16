/**
 * GPU copies of parsed .vtf images, shared by everything that draws map assets.
 * Textures go up still DXT-compressed with their own mip levels when the
 * browser supports S3TC, which keeps memory low and loading fast.
 */
import { decodeCompressed } from './formats/vtf.js';

const ANISOTROPY = 8;

export class GpuTextures {
  constructor(gl) {
    this.gl = gl;
    this.cache = new Map();
    this.anisotropy = gl.getExtension('EXT_texture_filter_anisotropic');
    this.s3tc = gl.getExtension('WEBGL_compressed_texture_s3tc');
  }

  /** GL textures for an image, one per animation frame. Cached per image. */
  get(image) {
    if (!image) return null;
    if (!this.cache.has(image)) this.cache.set(image, image.frames.map((faces) => this.upload(image, faces)));
    return this.cache.get(image);
  }

  first(image) {
    return this.get(image)?.[0] ?? null;
  }

  upload(image, faces) {
    const gl = this.gl;
    const target = image.cube ? gl.TEXTURE_CUBE_MAP : gl.TEXTURE_2D;
    const texture = gl.createTexture();
    gl.bindTexture(target, texture);

    const formats = this.s3tc && {
      dxt1: this.s3tc.COMPRESSED_RGBA_S3TC_DXT1_EXT,
      dxt3: this.s3tc.COMPRESSED_RGBA_S3TC_DXT3_EXT,
      dxt5: this.s3tc.COMPRESSED_RGBA_S3TC_DXT5_EXT,
    };
    // WebGL needs compressed level 0 sizes in whole 4x4 blocks.
    const compressed = formats && formats[image.format] && image.width % 4 === 0 && image.height % 4 === 0;

    faces.forEach((mips, face) => {
      const faceTarget = image.cube ? gl.TEXTURE_CUBE_MAP_POSITIVE_X + face : gl.TEXTURE_2D;
      if (compressed) {
        mips.forEach((mip, level) => gl.compressedTexImage2D(faceTarget, level, formats[image.format], mip.width, mip.height, 0, mip.data));
      } else {
        const top = mips[0];
        const pixels = image.format === 'rgba' ? top.data : decodeCompressed(image.format, top.data, top.width, top.height);
        gl.texImage2D(faceTarget, 0, gl.RGBA, top.width, top.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      }
    });

    if (compressed) gl.texParameteri(target, gl.TEXTURE_MAX_LEVEL, faces[0].length - 1);
    else gl.generateMipmap(target);
    gl.texParameteri(target, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(target, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    if (image.cube) {
      gl.texParameteri(target, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(target, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    } else if (this.anisotropy) {
      gl.texParameterf(target, this.anisotropy.TEXTURE_MAX_ANISOTROPY_EXT, ANISOTROPY);
    }
    return texture;
  }

  /** Drops the CPU pixel data of every uploaded image; the GPU copies remain. */
  releaseCpuCopies() {
    for (const image of this.cache.keys()) image.frames = null;
  }

  dispose() {
    for (const textures of this.cache.values()) textures.forEach((texture) => this.gl.deleteTexture(texture));
    this.cache.clear();
  }
}
