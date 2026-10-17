/**
 * WebGL2 renderer. The procedural course is drawn as glowing glass over a
 * space sky, blended additively so nothing needs sorting. An imported map
 * that carries a scene is handed to MapRenderer and drawn with its own textures and lighting.
 */
import { VIEW } from './config.js';
import { Camera } from './camera.js';
import { createProgram, Mesh } from './gl.js';
import { MapRenderer, MAP_NEAR_PLANE, MAP_FAR_PLANE } from './mapRenderer.js';
import { Characters } from './characters.js';
import { Blood } from './blood.js';
import { viewAxes } from './combat.js';
import { Impacts } from './impacts.js';
import { SUN } from './modelLighting.js';
import { Tracers } from './tracers.js';
import { Viewmodels } from './viewmodel.js';
import { ARENA_SHADER, SURFACE_SHADER, POINT_SHADER, SPRITE_SHADER } from './shaders.js';
import { createOrientedBox } from './solids.js';
import { cross, normalize, sub, add, scale } from './vector.js';

const SURFACE_LAYOUT = [
  ['aPosition', 3], ['aColor', 3], ['aEdgesA', 4], ['aEdgesB', 4], ['aFill', 1], ['aLine', 1], ['aIndex', 1],
];
const SURFACE_STRIDE = 17;
const MAX_EDGES = 8;
const POINT_LAYOUT = [['aDirection', 3], ['aSize', 1], ['aColor', 4]];
const SPRITE_LAYOUT = [['aDirection', 3], ['aUv', 2]];
const ARENA_LAYOUT = [['aPosition', 3], ['aNormal', 3], ['aColor', 3]];
const ARENA_NEAR_PLANE = 2;
const ARENA_FAR_PLANE = 20000;
const NO_EDGE = 1e6;   // padding for faces with fewer than eight edges

function hslToRgb(hue, saturation, lightness) {
  const k = (n) => (n + hue / 30) % 12;
  const a = saturation * Math.min(lightness, 1 - lightness);
  const channel = (n) => lightness - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return [channel(0), channel(8), channel(4)];
}

/** Distances from a point on a face to each of the face's edge lines. */
function edgeDistances(face, point) {
  const distances = new Array(MAX_EDGES).fill(NO_EDGE);
  for (let j = 0; j < Math.min(face.length, MAX_EDGES); j++) {
    const a = face[j];
    const c = cross(sub(point, a), normalize(sub(face[(j + 1) % face.length], a)));
    distances[j] = Math.hypot(c.x, c.y, c.z);
  }
  return distances;
}

/**
 * Packs render faces ({ vertices, normal, hue, index, line }) into one vertex
 * buffer, fan-triangulating each convex face.
 */
function buildWorldVertices(faces) {
  const triangles = faces.reduce((sum, face) => sum + face.vertices.length - 2, 0);
  const data = new Float32Array(triangles * 3 * SURFACE_STRIDE);
  const colors = new Map();
  let offset = 0;

  for (const { vertices, normal, hue, index, line } of faces) {
    if (!colors.has(hue)) colors.set(hue, hslToRgb(hue, 1, 0.55));
    const color = colors.get(hue);
    // Upward-facing surfaces glow brighter, so floors and ramps read clearly.
    const fill = 0.05 + 0.17 * Math.max(normal.z, 0);
    const edges = vertices.map((vertex) => edgeDistances(vertices, vertex));

    for (let i = 1; i < vertices.length - 1; i++) {
      for (const k of [0, i, i + 1]) {
        const v = vertices[k];
        data.set([v.x, v.y, v.z, ...color, ...edges[k], fill, line, index], offset);
        offset += SURFACE_STRIDE;
      }
    }
  }
  return data;
}

/** Opaque faces ({ vertices, normal, color }) of the arena, fan-triangulated. */
function buildArenaVertices(faces) {
  const data = [];
  for (const { vertices, normal, color } of faces) {
    for (let i = 1; i < vertices.length - 1; i++) {
      for (const v of [vertices[0], vertices[i], vertices[i + 1]]) data.push(v.x, v.y, v.z, normal.x, normal.y, normal.z, ...color);
    }
  }
  return new Float32Array(data);
}

function buildPointVertices(points) {
  const data = new Float32Array(points.length * 8);
  points.forEach(({ dir, size, color }, i) => data.set([dir.x, dir.y, dir.z, size, ...color], i * 8));
  return data;
}

/** Two triangles per galaxy, laid on the sky sphere around its direction. */
function buildGalaxyVertices(galaxies) {
  const data = [];
  for (const { dir, angularSize, roll, uv } of galaxies) {
    const helper = Math.abs(dir.z) < 0.9 ? { x: 0, y: 0, z: 1 } : { x: 1, y: 0, z: 0 };
    const t1 = normalize(cross(dir, helper));
    const t2 = cross(dir, t1);
    const half = angularSize / 2;
    const a = scale(add(scale(t1, Math.cos(roll)), scale(t2, Math.sin(roll))), half);
    const b = scale(add(scale(t1, -Math.sin(roll)), scale(t2, Math.cos(roll))), half);
    const corner = (sa, sb, u, v) => {
      const p = add(dir, add(scale(a, sa), scale(b, sb)));
      return [p.x, p.y, p.z, u, v];
    };
    const c00 = corner(-1, -1, uv.left, 0);
    const c10 = corner(1, -1, uv.right, 0);
    const c11 = corner(1, 1, uv.right, 1);
    const c01 = corner(-1, 1, uv.left, 1);
    data.push(...c00, ...c10, ...c11, ...c00, ...c11, ...c01);
  }
  return new Float32Array(data);
}

export class Renderer {
  constructor(canvas, sky) {
    const gl = canvas.getContext('webgl2', { antialias: true, alpha: false, powerPreference: 'high-performance' });
    if (!gl) {
      throw new Error('WebGL 2 is off in this browser right now. After a graphics driver crash the browser turns it off '
        + 'until it is fully closed and reopened; chrome://gpu (or about:support in Firefox) shows its state.');
    }
    this.gl = gl;
    this.canvas = canvas;
    this.camera = new Camera();
    this.pixelRatio = 1;

    this.surfaceProgram = createProgram(gl, SURFACE_SHADER);
    this.pointProgram = createProgram(gl, POINT_SHADER);
    this.spriteProgram = createProgram(gl, SPRITE_SHADER);

    this.world = new Mesh(gl, this.surfaceProgram, SURFACE_LAYOUT);
    this.worldSource = { world: null, version: -1 };
    this.stars = new Mesh(gl, this.pointProgram, POINT_LAYOUT);
    this.stars.upload(buildPointVertices(sky.stars));
    this.comets = new Mesh(gl, this.pointProgram, POINT_LAYOUT);
    this.galaxies = new Mesh(gl, this.spriteProgram, SPRITE_LAYOUT);
    this.galaxies.upload(buildGalaxyVertices(sky.galaxies));
    this.galaxyAtlas = this.createTexture(sky.galaxyAtlas);

    this.viewmodels = new Viewmodels(gl);
    this.characters = new Characters(gl, this.viewmodels);
    this.impacts = new Impacts(gl);
    this.tracers = new Tracers(gl);
    this.blood = new Blood(gl);
    this.arenaProgram = createProgram(gl, ARENA_SHADER);
    this.arena = new Mesh(gl, this.arenaProgram, ARENA_LAYOUT);
    this.arenaSource = null;

    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  createTexture(image) {
    const gl = this.gl;
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return texture;
  }

  resize() {
    this.pixelRatio = Math.min(window.devicePixelRatio || 1, VIEW.maxPixelRatio);
    this.canvas.width = Math.round(window.innerWidth * this.pixelRatio);
    this.canvas.height = Math.round(window.innerHeight * this.pixelRatio);
  }

  /** Bullet holes, blood and tracers of the last world, gone. */
  clearEffects() {
    this.impacts.clear();
    this.blood.clear();
    this.tracers.clear();
  }

  /** The height of one pixel, one unit in front of the camera. */
  pixelAngle() {
    return 2 * VIEW.verticalHalfFovTan * this.camera.zoom / this.canvas.height;
  }

  /** Rebuilds the world mesh only when the world or its contents change. */
  syncWorld(world) {
    if (this.worldSource.world === world && this.worldSource.version === world.version) return;
    this.world.upload(buildWorldVertices(world.faces));
    this.worldSource = { world, version: world.version };
  }

  /** Keeps one MapRenderer for the current map's scene and frees it when the map changes. */
  syncMap(scene) {
    if (this.mapRenderer?.scene === scene) return;
    this.mapRenderer?.dispose();
    this.mapRenderer = scene ? new MapRenderer(this.gl, scene) : null;
  }

  /** `characters` are posed third-person agents (the bot) drawn into the world. */
  render({ eye, yaw, pitch, sky, world, time, viewmodel, characters = [] }) {
    const { gl, canvas, camera } = this;
    this.syncMap(world.scene ?? null);
    if (world.kind === 'arena') {
      this.renderArena({ eye, yaw, pitch, world });
      this.drawStandIns(characters.filter((c) => c.standIn).map((c) => c.standIn));
      this.characters.draw(camera.viewProjection, characters.filter((c) => !c.standIn), camera.projectionScale);
    } else if (this.mapRenderer) {
      camera.set(eye, yaw, pitch, canvas.width / canvas.height, MAP_NEAR_PLANE, MAP_FAR_PLANE);
      gl.viewport(0, 0, canvas.width, canvas.height);
      this.mapRenderer.render(camera, time);
      this.characters.draw(camera.viewProjection, characters, camera.projectionScale);
    } else {
      this.renderCourse({ eye, yaw, pitch, sky, world, time });
    }
    // The arena and maps fill the depth buffer; the glowing course does not.
    const depthTested = world.kind === 'arena' || Boolean(this.mapRenderer);
    this.impacts.draw(camera.viewProjection, time, !depthTested);
    if (depthTested) {
      const { right, up } = viewAxes(yaw, pitch);
      this.blood.draw(camera.viewProjection, right, up, time);
    }
    this.tracers.draw(camera.viewProjection, eye, time, this.pixelAngle(), depthTested);
    if (viewmodel) this.viewmodels.draw(viewmodel.id, viewmodel, canvas.width / canvas.height);
  }

  /**
   * The main menu's character, standing at the origin facing the camera,
   * drawn over whatever the frame already shows (your agent).
   */
  drawVanity(character) {
    const { gl, canvas } = this;
    this.vanityCamera ??= new Camera();
    const aspect = canvas.width / canvas.height;
    // The camera stands off the character's left shoulder so the character sits right of center.
    this.vanityCamera.set({ x: -150, y: 30 * aspect / 1.78, z: 40 }, 4, 4, aspect, 4, 1000);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clear(gl.DEPTH_BUFFER_BIT);
    this.characters.draw(this.vanityCamera.viewProjection, [character]);
    gl.disable(gl.DEPTH_TEST);
  }

  /** The arena: the space sky behind, then the lit boxes with depth. */
  renderArena({ eye, yaw, pitch, world }) {
    const { gl, canvas, camera } = this;
    if (this.arenaSource !== world) {
      this.arena.upload(buildArenaVertices(world.faces));
      this.arenaSource = world;
    }
    camera.set(eye, yaw, pitch, canvas.width / canvas.height, ARENA_NEAR_PLANE, ARENA_FAR_PLANE);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0.008, 0.012, 0.04, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    this.drawSky();
    gl.disable(gl.BLEND);

    const { program, uniforms } = this.arenaProgram;
    gl.useProgram(program);
    gl.uniformMatrix4fv(uniforms.uViewProjection, false, camera.viewProjection);
    gl.uniform3f(uniforms.uEye, eye.x, eye.y, eye.z);
    gl.uniform3f(uniforms.uSun, SUN.x, SUN.y, SUN.z);
    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.CULL_FACE);
    this.arena.draw(gl.TRIANGLES);
    gl.disable(gl.CULL_FACE);
  }

  /** Players without a character model ({ pos, ducked }): a plain upright box their size. */
  drawStandIns(standIns) {
    if (!standIns.length) return;
    const faces = standIns.flatMap(({ pos, ducked }) => {
      const height = ducked ? 54 : 72;
      const box = createOrientedBox({ top: { x: pos.x, y: pos.y, z: pos.z + height }, heading: 0, halfLength: 16, halfWidth: 16, depth: height }, {});
      return box.faces.map((vertices, f) => ({ vertices, normal: box.faceNormals[f], color: [0.85, 0.3, 0.2] }));
    });
    this.standInMesh ??= new Mesh(this.gl, this.arenaProgram, ARENA_LAYOUT);
    this.standInMesh.upload(buildArenaVertices(faces), this.gl.DYNAMIC_DRAW);
    this.gl.useProgram(this.arenaProgram.program);
    this.gl.enable(this.gl.DEPTH_TEST);
    this.standInMesh.draw(this.gl.TRIANGLES);
  }

  renderCourse({ eye, yaw, pitch, sky, world, time }) {
    const { gl, canvas, camera } = this;

    this.syncWorld(world);
    this.comets.upload(buildPointVertices(sky.cometPoints()), gl.DYNAMIC_DRAW);
    camera.set(eye, yaw, pitch, canvas.width / canvas.height);

    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0.008, 0.012, 0.04, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);

    this.drawSky();
    this.drawWorld(world, time);
  }

  drawSky() {
    const { gl, camera } = this;

    gl.useProgram(this.spriteProgram.program);
    gl.uniformMatrix4fv(this.spriteProgram.uniforms.uSkyViewProjection, false, camera.skyViewProjection);
    gl.uniform1f(this.spriteProgram.uniforms.uSkyRadius, VIEW.skyRadius);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.galaxyAtlas);
    gl.uniform1i(this.spriteProgram.uniforms.uAtlas, 0);
    this.galaxies.draw(gl.TRIANGLES);

    gl.useProgram(this.pointProgram.program);
    gl.uniformMatrix4fv(this.pointProgram.uniforms.uSkyViewProjection, false, camera.skyViewProjection);
    gl.uniform1f(this.pointProgram.uniforms.uSkyRadius, VIEW.skyRadius);
    gl.uniform1f(this.pointProgram.uniforms.uPixelRatio, this.pixelRatio);
    this.stars.draw(gl.POINTS);
    this.comets.draw(gl.POINTS);
  }

  drawWorld({ highlightIndex, viewDistance }, time) {
    const { gl, camera } = this;
    const { program, uniforms } = this.surfaceProgram;

    gl.useProgram(program);
    gl.uniformMatrix4fv(uniforms.uViewProjection, false, camera.viewProjection);
    gl.uniform3f(uniforms.uEye, camera.eye.x, camera.eye.y, camera.eye.z);
    gl.uniform1f(uniforms.uHighlightIndex, highlightIndex);
    gl.uniform1f(uniforms.uTime, time);
    gl.uniform1f(uniforms.uViewDistance, viewDistance);

    gl.enable(gl.CULL_FACE);   // faces wind counter-clockwise from outside, so back faces drop out
    this.world.draw(gl.TRIANGLES);
    gl.disable(gl.CULL_FACE);
  }
}
