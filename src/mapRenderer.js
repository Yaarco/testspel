/**
 * Draws an imported map the way its engine does: skybox, then opaque world faces
 * and props with depth testing, then translucent and additive surfaces.
 * Owns the GPU copies of one scene from bspScene.js; dispose() frees them.
 */
import { Mesh, createProgram } from './gl.js';
import { MAP_WORLD_SHADER, MAP_PROP_SHADER, MAP_SKY_SHADER } from './shaders.js';
import { GpuTextures } from './textures.js';

const WORLD_LAYOUT = [
  ['aPosition', 3], ['aUv', 2], ['aLightmapUv', 2], ['aBlend', 1], ['aBumpStep', 1], ['aNormal', 3], ['aTangent', 4],
];
const PROP_LAYOUT = [['aPosition', 3], ['aUv', 2], ['aLight', 3], ['aNormal', 3]];
const SKY_LAYOUT = [['aDirection', 3], ['aUv', 2]];
const SKY_SIZE = 100;
export const MAP_NEAR_PLANE = 2;
export const MAP_FAR_PLANE = 65536;

const UNIT = { BASE: 0, BASE2: 1, LIGHTMAP: 2, BUMP: 3, ENVMAP: 4, ENVMAP_MASK: 5, DETAIL: 6 };

/**
 * Which world axis each skybox face covers, from Quake 2's st_to_vec table,
 * which the map format inherited: entry k means axis |k| of (s, t, 1), negated if k < 0.
 */
const SKY_FACE_AXES = {
  rt: [3, -1, 2], bk: [-3, 1, 2], lf: [1, 3, 2], ft: [-1, -3, 2], up: [-2, -1, 3], dn: [2, -1, -3],
};

function skyFaceVertices(axes) {
  const corner = (s, t) => {
    const b = [s * SKY_SIZE, t * SKY_SIZE, SKY_SIZE];
    const direction = axes.map((k) => (k < 0 ? -b[-k - 1] : b[k - 1]));
    return [...direction, (s + 1) / 2, 1 - (t + 1) / 2];
  };
  const [a, b, c, d] = [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)];
  return new Float32Array([...a, ...b, ...c, ...a, ...c, ...d]);
}

const isTransparent = ({ material, alpha }) => material.translucent || material.additive || alpha < 1;

export class MapRenderer {
  constructor(gl, scene) {
    this.gl = gl;
    this.scene = scene;
    this.textures = new GpuTextures(gl);

    this.worldProgram = createProgram(gl, MAP_WORLD_SHADER);
    this.propProgram = createProgram(gl, MAP_PROP_SHADER);
    this.skyProgram = createProgram(gl, MAP_SKY_SHADER);

    this.lightmap = this.uploadLightmap(scene.lightmap);
    this.world = scene.world.map((batch) => this.uploadBatch(batch, this.worldProgram, WORLD_LAYOUT));
    this.props = scene.props.map((batch) => this.uploadBatch(batch, this.propProgram, PROP_LAYOUT));
    this.sky = scene.sky ? Object.entries(SKY_FACE_AXES).map(([suffix, axes]) => {
      const mesh = new Mesh(gl, this.skyProgram, SKY_LAYOUT);
      mesh.upload(skyFaceVertices(axes));
      return { mesh, texture: this.textures.first(scene.sky[suffix]) };
    }) : [];
    this.releaseCpuCopies();
  }

  uploadBatch(batch, program, layout) {
    const { material } = batch;
    const mesh = new Mesh(this.gl, program, layout);
    mesh.upload(batch.vertices);
    mesh.uploadIndices(batch.indices);
    return {
      material,
      alpha: batch.alpha,
      mesh,
      frames: this.textures.get(material.base),
      base2: this.textures.first(material.base2),
      bump: this.textures.first(material.bump),
      envmapMask: this.textures.first(material.envmapMask),
      detail: this.textures.first(material.detail),
      envmap: this.textures.first(batch.envmap),
    };
  }

  /** The scene's pixel and vertex arrays live on the GPU now; drop them so they can be collected. */
  releaseCpuCopies() {
    const scene = this.scene;
    for (const batch of [...scene.world, ...scene.props]) {
      batch.vertices = null;
      batch.indices = null;
    }
    this.textures.releaseCpuCopies();
    scene.lightmap.data = null;
  }

  uploadLightmap({ width, height, data }) {
    const gl = this.gl;
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return texture;
  }

  render(camera, time) {
    const gl = this.gl;
    const fog = this.scene.fog;
    const clear = fog ? [fog.color.x, fog.color.y, fog.color.z].map((c) => c / 255) : [0, 0, 0];
    gl.clearColor(...clear, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.disable(gl.BLEND);
    gl.disable(gl.CULL_FACE);

    this.drawSky(camera);

    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(true);
    const opaque = (batch) => !isTransparent(batch);
    this.drawBatches(this.worldProgram, this.world.filter(opaque), camera, time);
    this.drawBatches(this.propProgram, this.props.filter(opaque), camera, time);

    gl.enable(gl.BLEND);
    gl.depthMask(false);
    this.drawBatches(this.worldProgram, this.world.filter(isTransparent), camera, time);
    this.drawBatches(this.propProgram, this.props.filter(isTransparent), camera, time);

    // Leave state as the glow renderer expects it.
    gl.depthMask(true);
    gl.disable(gl.DEPTH_TEST);
  }

  drawSky(camera) {
    const gl = this.gl;
    const { program, uniforms } = this.skyProgram;
    gl.useProgram(program);
    gl.uniformMatrix4fv(uniforms.uSkyViewProjection, false, camera.skyViewProjection);
    gl.uniform1i(uniforms.uBase, UNIT.BASE);
    gl.activeTexture(gl.TEXTURE0 + UNIT.BASE);
    for (const face of this.sky) {
      if (!face.texture) continue;
      gl.bindTexture(gl.TEXTURE_2D, face.texture);
      face.mesh.draw(gl.TRIANGLES);
    }
  }

  bind(unit, target, texture) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(target, texture);
  }

  drawBatches({ program, uniforms }, batches, camera, time) {
    const gl = this.gl;
    const fog = this.scene.fog;
    gl.useProgram(program);
    gl.uniformMatrix4fv(uniforms.uViewProjection, false, camera.viewProjection);
    gl.uniform3f(uniforms.uEye, camera.eye.x, camera.eye.y, camera.eye.z);
    gl.uniform1f(uniforms.uFogEnabled, fog ? 1 : 0);
    if (fog) {
      gl.uniform3f(uniforms.uFogColor, fog.color.x / 255, fog.color.y / 255, fog.color.z / 255);
      gl.uniform3f(uniforms.uFog, fog.start, fog.end, fog.maxDensity);
    }
    for (const [name, unit] of [['uBase', UNIT.BASE], ['uBase2', UNIT.BASE2], ['uLightmap', UNIT.LIGHTMAP], ['uBump', UNIT.BUMP],
      ['uEnvmap', UNIT.ENVMAP], ['uEnvmapMask', UNIT.ENVMAP_MASK], ['uDetail', UNIT.DETAIL]]) {
      gl.uniform1i(uniforms[name], unit);
    }
    this.bind(UNIT.LIGHTMAP, gl.TEXTURE_2D, this.lightmap);

    for (const batch of batches) {
      const { material, frames } = batch;
      const frame = frames ? frames[Math.floor(time * material.frameRate) % frames.length] : null;
      this.bind(UNIT.BASE, gl.TEXTURE_2D, frame);
      this.bind(UNIT.BASE2, gl.TEXTURE_2D, batch.base2);
      this.bind(UNIT.BUMP, gl.TEXTURE_2D, batch.bump);
      this.bind(UNIT.ENVMAP, gl.TEXTURE_CUBE_MAP, batch.envmap);
      this.bind(UNIT.ENVMAP_MASK, gl.TEXTURE_2D, batch.envmapMask);
      this.bind(UNIT.DETAIL, gl.TEXTURE_2D, batch.detail);

      gl.uniform1f(uniforms.uHasBase, frame ? 1 : 0);
      gl.uniform1f(uniforms.uHasBase2, batch.base2 ? 1 : 0);
      gl.uniform1f(uniforms.uHasBump, batch.bump ? 1 : 0);
      gl.uniform1f(uniforms.uSsbump, material.ssbump ? 1 : 0);
      gl.uniform1f(uniforms.uHasDetail, batch.detail ? 1 : 0);
      gl.uniform1f(uniforms.uDetailScale, material.detailScale);
      gl.uniform1f(uniforms.uDetailBlend, material.detailBlend);
      gl.uniform1f(uniforms.uHasEnvmap, batch.envmap ? 1 : 0);
      gl.uniform1f(uniforms.uEnvmapMaskMode, batch.envmapMask || material.envmapMaskMode !== 1 ? material.envmapMaskMode : 0);
      gl.uniform3f(uniforms.uEnvmapTint, ...material.envmapTint);
      gl.uniform1f(uniforms.uSelfIllum, material.selfIllum ? 1 : 0);
      gl.uniform1f(uniforms.uLit, material.shader === 'lit' || material.shader === 'blend' ? 1 : 0);
      gl.uniform1f(uniforms.uWater, material.shader === 'water' ? 1 : 0);
      gl.uniform3f(uniforms.uColor, ...material.color);
      gl.uniform1f(uniforms.uAlphaTest, material.alphaTest);
      gl.uniform1f(uniforms.uAlpha, material.alpha * batch.alpha);
      if (material.additive) gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
      else gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      batch.mesh.draw(gl.TRIANGLES);
    }
  }

  dispose() {
    const gl = this.gl;
    for (const batch of [...this.world, ...this.props]) batch.mesh.dispose();
    for (const face of this.sky) face.mesh.dispose();
    this.textures.dispose();
    gl.deleteTexture(this.lightmap);
    for (const { program } of [this.worldProgram, this.propProgram, this.skyProgram]) gl.deleteProgram(program);
  }
}
