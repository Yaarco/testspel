/**
 * Weapon finishes (skins). A finish from the manifest is a set of paint
 * shader parameters (style, four colors, a pattern texture and its placement
 * ranges, a wear range); FinishPainter renders it into a texture that
 * replaces the weapon's color texture. The pattern seed picks the placement
 * within the finish's ranges, as an item's paint seed does, and the
 * wear value (float) sets how much paint has come off.
 */
import { createProgram } from './gl.js';
import { createRng } from './random.js';
import { FINISH_SHADER, GLOVE_SHADER } from './shaders.js';

const PROJECTED_STYLES = new Set([2, 5]);     // spray paint and anodized airbrushed
const MASK_STYLES = new Set([0, 3]);          // solid color and anodized: colored by paint-by-number masks
const ANISOTROPY = 8;
const REFERENCE_LENGTH = 32;                  // inches; spray patterns keep their size across weapons

/** Pattern placement for a seed: rotation (degrees) and offset rolled within the finish's ranges. */
export function patternPlacement(finish, composite, seed) {
  const rng = createRng(seed * 7919 + 17);
  const roll = ([min, max]) => min + (max - min) * rng.next();
  const projected = PROJECTED_STYLES.has(finish.style);
  const size = finish.ignoreSize ? 1 : projected ? composite.length / REFERENCE_LENGTH : composite.uvScale;
  const scale = finish.scale * size;
  const angle = roll(finish.rotation) * Math.PI / 180;
  return {
    basis: [Math.cos(angle) * scale, Math.sin(angle) * scale, -Math.sin(angle) * scale, Math.cos(angle) * scale],
    offset: [roll(finish.offset[0]), roll(finish.offset[1])],
    wearOffset: [rng.next(), rng.next()],
  };
}

export class FinishPainter {
  constructor(gl) {
    this.gl = gl;
    this.pack = null;
    this.program = createProgram(gl, FINISH_SHADER);
    this.vao = gl.createVertexArray();
    this.framebuffer = gl.createFramebuffer();
    this.anisotropy = gl.getExtension('EXT_texture_filter_anisotropic');
    this.cache = new Map();   // path -> Promise<{ texture, width, height }> of the inputs in use
    this.queue = Promise.resolve();
    this.white = this.solidTexture([255, 255, 255, 255]);
  }

  solidTexture(rgba) {
    const gl = this.gl;
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(rgba));
    return { texture, width: 1, height: 1 };
  }

  /** Loads an input texture from the asset folder (once per paint). */
  load(path) {
    if (!path) return Promise.resolve(this.white);
    if (!this.cache.has(path)) {
      const promise = loadTexture(this.gl, this.pack, path, this.anisotropy);
      promise.catch(() => this.cache.delete(path));
      this.cache.set(path, promise);
    }
    return this.cache.get(path);
  }

  /** Frees every input texture except the ones listed, which every finish uses. */
  release(keep) {
    for (const [path, pending] of this.cache) {
      if (keep.includes(path)) continue;
      this.cache.delete(path);
      pending.then((t) => this.gl.deleteTexture(t.texture)).catch(() => {});
    }
  }

  /**
   * Paints `finish` over a weapon material. `base` is that material's color
   * texture; `composite` its paint inputs from the manifest. Returns a new
   * texture the size of `base`, which the caller owns. Paints run one at a
   * time, and the pattern and mask textures are freed after each, so only
   * the painted results stay in memory.
   */
  paint(base, composite, finish, options, shared) {
    return this.enqueue(() => this.paintWeapon(base, composite, finish, options, shared), [shared.wear, shared.grunge]);
  }

  /** Paints a glove finish over a glove material (`base`), the same way. */
  paintGlove(base, finish, options) {
    return this.enqueue(() => this.paintGloveNow(base, finish, options), []);
  }

  enqueue(job, keep) {
    const result = this.queue.then(job);
    this.queue = result.catch(() => {}).then(() => this.release(keep));
    return result;
  }

  async inputs(paths) {
    return Promise.all(paths.map((path) => this.load(path).catch(() => this.white)));
  }

  async paintWeapon(base, composite, finish, options, shared) {
    const { wear, seed } = options;
    const [masks, cavity, position, pattern, wearTexture, grunge, ramp] = await this.inputs([
      finish.masks ?? composite.masks, composite.cavity, composite.position, finish.pattern, shared.wear, shared.grunge, finish.ramp,
    ]);
    const placement = patternPlacement(finish, composite, seed);
    return this.render(this.program, base, [
      ['uColor', base], ['uMasks', masks], ['uCavity', cavity], ['uPosition', position], ['uPattern', pattern],
      ['uWearTexture', wearTexture], ['uGrunge', grunge], ['uRamp', ramp],
    ], (gl, uniforms) => {
      gl.uniform1i(uniforms.uStyle, finish.style);
      gl.uniform3fv(uniforms['uColors[0]'], finish.colors.flat());
      gl.uniformMatrix2fv(uniforms.uPatternBasis, false, placement.basis);
      gl.uniform2fv(uniforms.uPatternOffset, placement.offset);
      gl.uniform1i(uniforms.uProjected, PROJECTED_STYLES.has(finish.style) ? 1 : 0);
      gl.uniform1i(uniforms.uPlacedMasks, finish.masks && MASK_STYLES.has(finish.style) ? 1 : 0);
      gl.uniform1i(uniforms.uHasRamp, finish.ramp ? 1 : 0);
      gl.uniform1i(uniforms.uKnife, options.knife ? 1 : 0);
      const hardening = finish.caseHardening ?? { pattern: 0, geometric: 0, offset: 0 };
      gl.uniform3f(uniforms.uCaseHardening, hardening.pattern, hardening.geometric, hardening.offset);
      gl.uniform1f(uniforms.uWearAmount, wear);
      gl.uniform2fv(uniforms.uWearOffset, placement.wearOffset);
    });
  }

  async paintGloveNow(base, finish, { wear, seed }) {
    this.gloveProgram ??= createProgram(this.gl, GLOVE_SHADER);
    const [mask, surface, pattern, ...details] = await this.inputs([finish.layerMask, finish.surface, finish.pattern, ...finish.details]);
    const rng = createRng(seed * 7919 + 17);
    const angle = (finish.patternRotation + rng.next() * 360) * Math.PI / 180;
    const scale = finish.patternScale;
    // A glove's own color texture is often a tiny placeholder: paint at the mask's size.
    const size = { width: Math.max(base.width, mask.width), height: Math.max(base.height, mask.height) };
    return this.render(this.gloveProgram, size, [
      ['uColor', base], ['uMask', mask], ['uSurface', surface], ['uPattern', pattern],
      ...details.map((detail, i) => [`uDetail${i}`, detail]),
    ], (gl, uniforms) => {
      gl.uniform3fv(uniforms['uTints[0]'], finish.tints.flat());
      gl.uniform4fv(uniforms.uPalette, finish.palette);
      gl.uniform1f(uniforms.uReplaceIndex, finish.replaceIndex);
      gl.uniform1i(uniforms.uHasPattern, finish.pattern ? 1 : 0);
      gl.uniformMatrix2fv(uniforms.uPatternBasis, false, [Math.cos(angle) * scale, Math.sin(angle) * scale, -Math.sin(angle) * scale, Math.cos(angle) * scale]);
      gl.uniform4fv(uniforms.uDetailScale, finish.detailScale);
      gl.uniform4fv(uniforms.uHasDetail, details.map((d) => (d === this.white ? 0 : 1)));
      gl.uniform1f(uniforms.uWearAmount, wear);
    });
  }

  /** Renders a painting pass into a new mipmapped texture of `size` ({ width, height }). */
  render({ program, uniforms }, size, inputs, setUniforms) {
    const base = size;
    const gl = this.gl;
    const target = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, target);
    gl.texStorage2D(gl.TEXTURE_2D, Math.floor(Math.log2(Math.max(base.width, base.height))) + 1, gl.RGBA8, base.width, base.height);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, target, 0);
    gl.useProgram(program);
    inputs.forEach(([name, input], unit) => {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, input.texture);
      gl.uniform1i(uniforms[name], unit);
    });
    setUniforms(gl, uniforms);

    gl.viewport(0, 0, base.width, base.height);
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    gl.bindTexture(gl.TEXTURE_2D, target);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    if (this.anisotropy) gl.texParameterf(gl.TEXTURE_2D, this.anisotropy.TEXTURE_MAX_ANISOTROPY_EXT, ANISOTROPY);
    return { texture: target, width: base.width, height: base.height };
  }
}

/** A mipmapped, repeating texture from an image file of the asset pack. */
export async function loadTexture(gl, pack, path, anisotropy) {
  const response = await pack.fetch(path);
  if (!response.ok) throw new Error(`${path}: ${response.status}`);
  const image = await createImageBitmap(await response.blob(), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
  gl.generateMipmap(gl.TEXTURE_2D);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  if (anisotropy) gl.texParameterf(gl.TEXTURE_2D, anisotropy.TEXTURE_MAX_ANISOTROPY_EXT, ANISOTROPY);
  const result = { texture, width: image.width, height: image.height };
  image.close();
  return result;
}
