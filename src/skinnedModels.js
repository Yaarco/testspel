/**
 * Skinned glTF models on the GPU, shared by the first-person viewmodel and
 * the third-person characters: vertex buffers, a bone texture per mesh, and
 * color textures loaded only for the meshes that are shown.
 *
 * A weapon with both a current and an older mesh ("body_hd", "body_legacy") shows
 * only the one its finish is painted for (its variant).
 */
import { createProgram, Mesh } from './gl.js';
import { parseGlb } from './formats/gltf.js';
import { loadTexture } from './finishes.js';
import { SKINNED_SHADER } from './shaders.js';
import { jointMatrices } from './skeleton.js';

const LAYOUT = [['aPosition', 3], ['aNormal', 3], ['aUv', 2], ['aJoints', 4], ['aWeights', 4]];
const MESH_VARIANTS = { hd: /\.body_hd$/, legacy: /\.body_legacy$/ };

function isShown(model, mesh, variant) {
  if (!model.hasVariants || !variant) return true;
  return !MESH_VARIANTS[variant === 'hd' ? 'legacy' : 'hd'].test(mesh.name);
}

/**
 * The middle of a model's front end (its largest z, which is forward for
 * these exports), in model space: a gun's muzzle.
 */
function frontPoint(meshes) {
  const positions = meshes.flatMap((mesh) => mesh.primitives.map((p) => p.position));
  let front = -Infinity;
  for (const position of positions) for (let i = 2; i < position.length; i += 3) front = Math.max(front, position[i]);
  const sum = [0, 0, 0];
  let count = 0;
  for (const position of positions) {
    for (let i = 0; i < position.length; i += 3) {
      if (position[i + 2] < front - 0.01) continue;
      sum[0] += position[i]; sum[1] += position[i + 1]; sum[2] += position[i + 2];
      count++;
    }
  }
  return count ? sum.map((v) => v / count) : null;
}

export class SkinnedModels {
  constructor(gl) {
    this.gl = gl;
    this.pack = null;
    this.program = createProgram(gl, SKINNED_SHADER);
    this.anisotropy = gl.getExtension('EXT_texture_filter_anisotropic');
  }

  async fetchGlb(path) {
    const response = await this.pack.fetch(path);
    if (!response.ok) throw new Error(`${path}: ${response.status}`);
    return parseGlb(await response.arrayBuffer());
  }

  /** Fetches and uploads a model; `meshes` (name endings) keeps only some of its meshes. */
  async load(path, meshes = null) {
    const model = await this.upload(await this.fetchGlb(path), path, meshes);
    return model;
  }

  /** GPU buffers for a skinned model, plus a bone texture per mesh. Textures come from loadTextures. */
  async upload(glb, path, keepMeshes = null) {
    const gl = this.gl;
    const folder = path.slice(0, path.lastIndexOf('/') + 1);
    const kept = glb.meshes.filter((mesh) => !keepMeshes || keepMeshes.some((name) => mesh.name.endsWith(name)));
    const meshes = kept.map((mesh) => ({
      name: mesh.name,
      skin: mesh.skin,
      bones: this.boneTexture(mesh.skin.joints.length),
      primitives: mesh.primitives.map((p) => {
        const count = p.position.length / 3;
        const data = new Float32Array(count * 16);
        for (let i = 0; i < count; i++) {
          data.set(p.position.subarray(i * 3, i * 3 + 3), i * 16);
          data.set(p.normal.subarray(i * 3, i * 3 + 3), i * 16 + 3);
          data.set(p.uv.subarray(i * 2, i * 2 + 2), i * 16 + 6);
          data.set(Array.from(p.joints.subarray(i * 4, i * 4 + 4)), i * 16 + 8);
          data.set(p.weights.subarray(i * 4, i * 4 + 4), i * 16 + 12);
        }
        const gpu = new Mesh(gl, this.program, LAYOUT);
        gpu.upload(data);
        gpu.uploadIndices(Uint32Array.from(p.indices));
        return { mesh: gpu, material: p.material, image: p.image ? folder + p.image : null };
      }),
    }));
    return {
      nodes: glb.nodes,
      meshes,
      front: frontPoint(kept),
      textures: new Map(),         // image path -> Promise of { texture, width, height } (or null)
      loadedTextures: new Map(),   // image path -> { texture, width, height }, for drawing
      hasVariants: Object.values(MESH_VARIANTS).every((v) => meshes.some((m) => v.test(m.name))),
    };
  }

  /**
   * Loads the color textures of the meshes a variant shows and frees the
   * rest, so a model only holds the textures it draws: not the other
   * mesh's, and not those painted over (materials in `painted`).
   */
  async loadTextures(model, variant = null, painted = new Map()) {
    const shown = model.meshes.filter((mesh) => isShown(model, mesh, variant));
    const needed = new Set(shown.flatMap((mesh) => mesh.primitives)
      .filter((p) => p.image && !painted.has(p.material)).map((p) => p.image));
    for (const [path, pending] of model.textures) {
      if (needed.has(path)) continue;
      model.textures.delete(path);
      model.loadedTextures.delete(path);
      pending.then((texture) => texture && this.gl.deleteTexture(texture.texture));
    }
    for (const path of needed) {
      if (model.textures.has(path)) continue;
      const pending = loadTexture(this.gl, this.pack, path, this.anisotropy).catch(() => null);
      model.textures.set(path, pending);
      pending.then((texture) => { if (texture && model.textures.get(path) === pending) model.loadedTextures.set(path, texture); });
    }
    await Promise.all([...needed].map((path) => model.textures.get(path)));
  }

  /** The color texture of a material (loading it if needed); null when none of its meshes is shown. */
  async baseTexture(model, material) {
    const primitive = model.meshes.flatMap((mesh) => mesh.primitives).find((p) => p.material === material && model.textures.has(p.image));
    return primitive ? model.textures.get(primitive.image) : null;
  }

  /**
   * Where a gun's muzzle sits relative to its "weapon" bone: { node, local },
   * so it follows the gun through every animation. Null for models without one.
   */
  muzzle(model) {
    if (model.muzzle !== undefined) return model.muzzle;
    model.muzzle = null;
    const node = model.nodes.findIndex((n) => n.name === 'weapon');
    const mesh = model.meshes.find((m) => m.skin?.joints.includes(node));
    if (node < 0 || !mesh || !model.front) return null;
    const m = mesh.skin.inverseBind.subarray(mesh.skin.joints.indexOf(node) * 16);
    const [x, y, z] = model.front;
    const local = [0, 1, 2].map((r) => m[r] * x + m[4 + r] * y + m[8 + r] * z + m[12 + r]);
    model.muzzle = { node, local };
    return model.muzzle;
  }

  /** Materials of a model, by name. */
  materials(model) {
    return [...new Set(model.meshes.flatMap((mesh) => mesh.primitives.map((p) => p.material)))];
  }

  dispose(model, painted = new Map()) {
    const gl = this.gl;
    for (const mesh of model.meshes) {
      gl.deleteTexture(mesh.bones);
      for (const primitive of mesh.primitives) primitive.mesh.dispose();
    }
    model.textures.forEach((pending) => pending.then((texture) => texture && gl.deleteTexture(texture.texture)));
    painted.forEach(({ texture }) => gl.deleteTexture(texture));
  }

  boneTexture(count) {
    const gl = this.gl;
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, count * 4, 1, 0, gl.RGBA, gl.FLOAT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    return texture;
  }

  /**
   * Starts drawing: `projection` and `view` (4x4, column-major), the light
   * direction toward the light in model space, its color and the ambient.
   */
  begin(projection, view, light) {
    const gl = this.gl;
    const { program, uniforms } = this.program;
    gl.useProgram(program);
    gl.uniformMatrix4fv(uniforms.uProjection, false, projection);
    gl.uniformMatrix4fv(uniforms.uModelView, false, view);
    gl.uniform3f(uniforms.uLightDirection, ...light.direction);
    gl.uniform3f(uniforms.uLightColor, ...light.color);
    gl.uniform3f(uniforms.uAmbient, ...light.ambient);
    gl.uniform1i(uniforms.uBase, 0);
    gl.uniform1i(uniforms.uBones, 1);
  }

  /** Draws a model's shown meshes posed by `world` (one matrix per node); `painted` overrides textures per material. */
  draw(model, world, variant = null, painted = new Map()) {
    const gl = this.gl;
    const { uniforms } = this.program;
    for (const mesh of model.meshes) {
      if (!isShown(model, mesh, variant)) continue;
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, mesh.bones);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, mesh.skin.joints.length * 4, 1, gl.RGBA, gl.FLOAT, jointMatrices(world, mesh.skin));
      for (const { mesh: gpu, material, image: path } of mesh.primitives) {
        const image = painted.get(material) ?? model.loadedTextures.get(path);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, image?.texture ?? null);
        gl.uniform1f(uniforms.uHasBase, image ? 1 : 0);
        gpu.draw(gl.TRIANGLES);
      }
    }
  }
}
