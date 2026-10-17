/**
 * Builds everything needed to draw a BSP the way its engine does: textured faces
 * with baked (and bump-mapped) lightmaps, displacements with texture blending,
 * cubemap reflections, static props lit by the map's light cubes and world
 * lights, the 2D skybox and fog. Assets come from the map's pakfile and any
 * game archives in the AssetLibrary. The result is plain typed arrays;
 * mapRenderer.js uploads it.
 *
 * Vertex layouts (indexed):
 *   world: position(3) uv(2) lightmapUv(2) blend(1) bumpStep(1) normal(3) tangent(4)
 *   props: position(3) uv(2) light(3) normal(3)
 */
import { AssetLibrary } from './assets.js';
import { traceHull } from './collision.js';
import { displacementGrid, faceCorners, parseVector } from './bspWorld.js';
import { loadModel } from './formats/mdl.js';
import { ZipArchive } from './formats/zip.js';
import { ENV_CUBEMAP, MaterialLibrary } from './materials.js';
import { add, cross, dot, normalize, scale, sub } from './vector.js';

export const WORLD_STRIDE = 16;
export const PROP_STRIDE = 11;

const HIDDEN_SURFACES = 0x2 | 0x4 | 0x40 | 0x80 | 0x100 | 0x200;   // sky, trigger, nodraw, hint, skip
const NO_LIGHTMAP = 0x400;
const VISIBLE_TOOL_TEXTURES = new Set(['tools/toolsblack']);
const INVISIBLE_BRUSH_ENTITIES = new Set([
  'func_areaportal', 'func_areaportalwindow', 'func_occluder', 'func_viscluster', 'func_clip_vphysics',
  'func_buyzone', 'func_bomb_target', 'func_hostage_rescue', 'func_ladder', 'func_precipitation',
  'func_dustmotes', 'func_dustcloud', 'func_smokevolume', 'func_nobuild', 'func_vehicleclip',
]);
const DYNAMIC_PROP_CLASSES = new Set(['prop_dynamic', 'prop_dynamic_override', 'prop_physics', 'prop_physics_multiplayer', 'prop_static']);
const SKY_SUFFIXES = ['rt', 'bk', 'lf', 'ft', 'up', 'dn'];

const ATLAS_WIDTH = 4096;
const LIGHTMAP_PADDING = 1;
const BUMPED_LIGHTMAPS = 4;   // one flat lightmap, then one per bump basis direction
/**
 * LDR lightmaps: stored as linear^(1/2.2) / 2 and doubled in the
 * shader, which leaves headroom for surfaces lit brighter than full.
 */
const OVERBRIGHT = 2;

const toLightmapByte = (linear) => Math.round(255 * Math.min(1, Math.pow(Math.max(linear, 0), 1 / 2.2) / OVERBRIGHT));
const toVertexLight = (linear) => Math.min(OVERBRIGHT, Math.pow(Math.max(linear, 0), 1 / 2.2));

/** ColorRGBExp32: three bytes and a signed exponent, as stored in lighting lumps. */
function decodeRgbExp(bytes, at) {
  const scale_ = Math.pow(2, (bytes[at + 3] << 24) >> 24) / 255;
  return [bytes[at] * scale_, bytes[at + 1] * scale_, bytes[at + 2] * scale_];
}

/** AngleMatrix: pitch, yaw, roll in degrees to a row-major 3x3 rotation. */
function angleMatrix({ x: pitch, y: yaw, z: roll }) {
  const r = Math.PI / 180;
  const [sp, cp, sy, cy, sr, cr] = [Math.sin(pitch * r), Math.cos(pitch * r), Math.sin(yaw * r), Math.cos(yaw * r), Math.sin(roll * r), Math.cos(roll * r)];
  return [
    [cp * cy, sr * sp * cy - cr * sy, cr * sp * cy + sr * sy],
    [cp * sy, sr * sp * sy + cr * cy, cr * sp * sy - sr * cy],
    [-sp, sr * cp, cr * cp],
  ];
}

const rotate = (m, v) => ({
  x: m[0][0] * v.x + m[0][1] * v.y + m[0][2] * v.z,
  y: m[1][0] * v.x + m[1][1] * v.y + m[1][2] * v.z,
  z: m[2][0] * v.x + m[2][1] * v.y + m[2][2] * v.z,
});

/** A placement for brush entities and props; the identity for the world. */
function placement(matrix, origin) {
  return {
    point: (p) => (matrix ? add(rotate(matrix, p), origin) : p),
    direction: (d) => (matrix ? rotate(matrix, d) : d),
  };
}
const IDENTITY = placement(null, null);

function isHidden(texinfo) {
  if (!texinfo || texinfo.flags & HIDDEN_SURFACES) return true;
  const name = texinfo.texture.toLowerCase();
  return name.startsWith('tools/') && !VISIBLE_TOOL_TEXTURES.has(name);
}

const vectorOf = (v) => ({ x: v[0], y: v[1], z: v[2] });

/** Packs every face's lightmaps into one atlas, side by side for bumped faces. */
class LightmapAtlas {
  constructor(bsp, faces, isBumped) {
    this.rects = new Map();
    const lit = faces.filter((face) => face.lightOffset >= 0 && !(bsp.texinfo[face.texinfo]?.flags & NO_LIGHTMAP));
    const cell = (face) => face.lightmapSize.map((s) => s + 1 + 2 * LIGHTMAP_PADDING);
    const count = (face) => (isBumped(face) ? BUMPED_LIGHTMAPS : 1);

    // A neutral 4x4 block at the origin serves faces without a lightmap.
    let x = 4, y = 0, rowHeight = 4;
    for (const face of [...lit].sort((a, b) => cell(b)[1] - cell(a)[1])) {
      const [w, h] = cell(face);
      const totalWidth = w * count(face);
      if (x + totalWidth > ATLAS_WIDTH) {
        x = 0;
        y += rowHeight;
        rowHeight = 0;
      }
      this.rects.set(face, { x, y, cellWidth: w, count: count(face) });
      x += totalWidth;
      rowHeight = Math.max(rowHeight, h);
    }
    this.width = ATLAS_WIDTH;
    this.height = Math.max(4, y + rowHeight);
    this.data = new Uint8Array(this.width * this.height * 4);
    this.fill(bsp, lit);
  }

  fill(bsp, faces) {
    const neutral = toLightmapByte(1);
    for (let i = 0; i < 16; i++) this.data.set([neutral, neutral, neutral, 255], (Math.floor(i / 4) * this.width + (i % 4)) * 4);

    for (const face of faces) {
      const rect = this.rects.get(face);
      const [w, h] = face.lightmapSize.map((s) => s + 1);
      for (let k = 0; k < rect.count; k++) {
        const source = face.lightOffset + k * w * h * 4;
        const left = rect.x + k * rect.cellWidth;
        for (let ty = -LIGHTMAP_PADDING; ty < h + LIGHTMAP_PADDING; ty++) {
          for (let tx = -LIGHTMAP_PADDING; tx < w + LIGHTMAP_PADDING; tx++) {
            // The padding repeats edge luxels so filtering never reaches a neighbour.
            const sx = Math.min(Math.max(tx, 0), w - 1);
            const sy = Math.min(Math.max(ty, 0), h - 1);
            const [r, g, b] = decodeRgbExp(bsp.lighting, source + (sy * w + sx) * 4);
            const o = ((rect.y + LIGHTMAP_PADDING + ty) * this.width + left + LIGHTMAP_PADDING + tx) * 4;
            this.data[o] = toLightmapByte(r);
            this.data[o + 1] = toLightmapByte(g);
            this.data[o + 2] = toLightmapByte(b);
            this.data[o + 3] = 255;
          }
        }
      }
    }
  }

  /** Atlas UV of the flat lightmap for a point on a face (in the face's own space). */
  uv(face, texinfo, point) {
    const rect = this.rects.get(face);
    if (!rect) return [2 / this.width, 2 / this.height];
    const [s, t] = texinfo.lightmapVecs.map((v, i) => dot(point, vectorOf(v)) + v[3] - face.lightmapMins[i]);
    return [(rect.x + LIGHTMAP_PADDING + s + 0.5) / this.width, (rect.y + LIGHTMAP_PADDING + t + 0.5) / this.height];
  }

  /** U distance between a bumped face's lightmaps, or 0 for a single lightmap. */
  bumpStep(face) {
    const rect = this.rects.get(face);
    return rect && rect.count > 1 ? rect.cellWidth / this.width : 0;
  }
}

function textureUv(texinfo, point) {
  const { width = 1, height = 1 } = texinfo.texdata ?? {};
  const [u, v] = texinfo.textureVecs.map((vec) => dot(point, vectorOf(vec)) + vec[3]);
  return [u / (width || 1), v / (height || 1)];
}

/**
 * Tangent frame from the texture axes. The map's normal maps point +Y toward
 * decreasing v, so the bitangent is the negated v axis; w carries handedness
 * so the shader can rebuild it as cross(normal, tangent) * w.
 */
function tangentFrame(texinfo, normal, place) {
  const tangent = normalize(place.direction(vectorOf(texinfo.textureVecs[0])));
  const bitangent = scale(normalize(place.direction(vectorOf(texinfo.textureVecs[1]))), -1);
  return [tangent.x, tangent.y, tangent.z, dot(cross(normal, tangent), bitangent) < 0 ? -1 : 1];
}

/** Indexed vertex groups, one per material, alpha and cubemap: each becomes one draw call. */
class Batches {
  constructor(stride) {
    this.stride = stride;
    this.groups = new Map();
  }

  group(material, alpha, envmap) {
    const key = `${material.key}|${alpha}|${envmap?.id ?? ''}`;
    if (!this.groups.has(key)) this.groups.set(key, { material, alpha, envmap: envmap?.image ?? null, values: [], indices: [], count: 0 });
    return this.groups.get(key);
  }

  /** Appends vertices (arrays of `stride` numbers) and triangles indexing them from 0. */
  add(group, vertices, triangles) {
    const first = group.count;
    for (const vertex of vertices) for (const value of vertex) group.values.push(value);
    for (const index of triangles) group.indices.push(first + index);
    group.count += vertices.length;
  }

  toArray() {
    return [...this.groups.values()].map(({ material, alpha, envmap, values, indices }) => ({
      material, alpha, envmap, vertices: new Float32Array(values), indices: new Uint32Array(indices),
    }));
  }
}

/** The LDR light cubes if the compiler filled them, otherwise the HDR ones. */
function chooseAmbientSet(bsp) {
  const brightness = ({ samples }) => samples.reduce((sum, sample) => sum + sample[0] + sample[1] + sample[2], 0);
  return bsp.leafAmbient.reduce((best, set) => (brightness(set) > brightness(best) ? set : best));
}

/** Ambient light cube for a point, from the leaf that contains it. Returns 6 linear colors. */
function ambientCube(bsp, ambient, point) {
  let node = bsp.models[0].headNode;
  while (node >= 0) {
    const plane = bsp.planes[bsp.nodePlanes[node]];
    node = bsp.nodes[node][dot(point, plane.normal) - plane.dist >= 0 ? 0 : 1];
  }
  const index = ambient.index[-1 - node];
  if (!index || index.count === 0) return null;

  const cube = Array.from({ length: 6 }, () => [0, 0, 0]);
  for (let s = 0; s < index.count; s++) {
    const sample = ambient.samples[index.first + s];
    for (let side = 0; side < 6; side++) {
      decodeRgbExp(sample, side * 4).forEach((c, i) => { cube[side][i] += c / index.count; });
    }
  }
  return cube;
}

const LIGHT = { POINT: 1, SPOT: 2, SKY: 3, SKY_AMBIENT: 5 };
const SKY_DISTANCE = 65536;
const MIN_AMBIENT_CUBE = 0.01;

/** True when nothing but sky lies between two points. */
function reaches(collision, from, to, toSky) {
  const trace = traceHull(from, to, 1, collision);
  return toSky ? trace.fraction === 1 || trace.solid?.sky === true : trace.fraction > 0.98;
}

/**
 * Lighting for one prop, the way the engine lights models at runtime: the leaf's
 * ambient light cube, plus the sun and nearby point and spot lights, each
 * tested for occlusion. Returns { cube, lights: [{ direction, color }] }.
 */
function propLighting(bsp, ambient, collision, point) {
  const from = { ...point, z: point.z + 32 };
  let cube = ambientCube(bsp, ambient, point);
  const cubeBrightness = cube ? cube.flat().reduce((a, b) => a + b, 0) / 18 : 0;
  const lights = [];

  for (const light of bsp.worldLights) {
    const intensity = [light.intensity.x, light.intensity.y, light.intensity.z];
    if (light.type === LIGHT.SKY_AMBIENT && cubeBrightness < MIN_AMBIENT_CUBE) {
      // The compiler left the cubes dark: use the sky's ambient where the sky is visible.
      const up = { ...from, z: from.z + SKY_DISTANCE };
      const level = reaches(collision, from, up, true) ? intensity : intensity.map((c) => c * 0.25);
      cube = Array.from({ length: 6 }, () => level);
    } else if (light.type === LIGHT.SKY) {
      const toSun = scale(light.normal, -1);
      if (reaches(collision, from, add(from, scale(toSun, SKY_DISTANCE)), true)) {
        lights.push({ direction: [toSun.x, toSun.y, toSun.z], color: intensity });
      }
    } else if (light.type === LIGHT.POINT || light.type === LIGHT.SPOT) {
      const delta = sub(light.origin, from);
      const distance = Math.hypot(delta.x, delta.y, delta.z);
      if (light.radius > 0 && distance > light.radius) continue;
      const direction = [delta.x / distance, delta.y / distance, delta.z / distance];
      const [c, l, q] = light.attenuation;
      let strength = 1 / Math.max(c + l * distance + q * distance * distance, 1e-6);
      if (light.type === LIGHT.SPOT) {
        const along = -(direction[0] * light.normal.x + direction[1] * light.normal.y + direction[2] * light.normal.z);
        if (along <= light.stopDot2) continue;
        if (along < light.stopDot) strength *= Math.pow((along - light.stopDot2) / (light.stopDot - light.stopDot2), light.exponent || 1);
      }
      if (strength * Math.max(...intensity) < 0.002 || !reaches(collision, from, light.origin, false)) continue;
      lights.push({ direction, color: intensity.map((v) => v * strength) });
    }
  }
  return { cube, lights };
}

/** Per-vertex model lighting: the ambient cube weighted by the normal, plus lambert from each light. */
function vertexLight(normal, { cube, lights }) {
  const light = [0, 0, 0];
  if (cube) {
    for (const [side, n] of [[0, normal[0]], [2, normal[1]], [4, normal[2]]]) {
      const face = cube[n >= 0 ? side : side + 1];
      for (let i = 0; i < 3; i++) light[i] += n * n * face[i];
    }
  }
  for (const { direction, color } of lights) {
    const lambert = Math.max(0, normal[0] * direction[0] + normal[1] * direction[1] + normal[2] * direction[2]);
    for (let i = 0; i < 3; i++) light[i] += color[i] * lambert;
  }
  return light.map(toVertexLight);
}

function readStaticProps(bsp) {
  const lump = bsp.gameLumps.sprp;
  if (!lump) return [];
  const view = new DataView(bsp.bytes.buffer, bsp.bytes.byteOffset, bsp.bytes.byteLength);
  let at = lump.offset;
  const nameCount = view.getInt32(at, true);
  const decoder = new TextDecoder('latin1');
  const names = [];
  for (let i = 0; i < nameCount; i++) {
    const raw = bsp.bytes.subarray(at + 4 + i * 128, at + 4 + (i + 1) * 128);
    names.push(decoder.decode(raw.subarray(0, raw.indexOf(0) >= 0 ? raw.indexOf(0) : 128)));
  }
  at += 4 + nameCount * 128;
  at += 4 + view.getInt32(at, true) * 2;   // skip the leaf list
  const count = view.getInt32(at, true);
  at += 4;
  const size = count ? Math.floor((lump.offset + lump.length - at) / count) : 0;

  const vec = (o) => ({ x: view.getFloat32(o, true), y: view.getFloat32(o + 4, true), z: view.getFloat32(o + 8, true) });
  const props = [];
  for (let i = 0; i < count; i++) {
    const p = at + i * size;
    const flags = view.getUint8(p + 31);
    props.push({
      model: names[view.getUint16(p + 24, true)],
      origin: vec(p),
      angles: vec(p + 12),
      skin: view.getInt32(p + 32, true),
      lightingOrigin: flags & 0x2 ? vec(p + 44) : vec(p),
    });
  }
  return props;
}

/**
 * Faces that carry bump lightmaps (a flat one, then one per bump direction).
 * vrad decided this from the material it compiled with, which may not be
 * available here, so it is read from the data: faces are stored back to back,
 * and the gap to the next face's lighting tells how many lightmaps a face has.
 */
function findBumpedFaces(bsp) {
  const lit = bsp.faces.filter((face) => face.lightOffset >= 0).sort((a, b) => a.lightOffset - b.lightOffset);
  const bumped = new Set();
  lit.forEach((face, i) => {
    const end = i + 1 < lit.length ? lit[i + 1].lightOffset : bsp.lighting.length;
    const luxels = (face.lightmapSize[0] + 1) * (face.lightmapSize[1] + 1);
    if (Math.floor((end - face.lightOffset) / (luxels * 4 * Math.max(face.styles, 1))) >= BUMPED_LIGHTMAPS) bumped.add(face);
  });
  return bumped;
}

/**
 * The map's baked cubemaps. vbsp names them materials/maps/<map>/c<x>_<y>_<z>.vtf
 * after their position; the map folder is found from the pakfile's contents.
 */
async function loadCubemaps(bsp, pak, materials) {
  const folder = pak.paths().map((path) => path.match(/^materials\/(maps\/[^/]+)\/c-?\d+_-?\d+_-?\d+\.vtf$/)?.[1]).find(Boolean);
  if (!folder) return [];
  const samples = await Promise.all(bsp.cubemaps.map(async (origin) => {
    const id = `${folder}/c${origin.x}_${origin.y}_${origin.z}`;
    return { origin, id, image: await materials.image(id) };
  }));
  return samples.filter((sample) => sample.image?.cube);
}

function nearest(samples, point) {
  let best = null;
  let bestDistance = Infinity;
  for (const sample of samples) {
    const d = (sample.origin.x - point.x) ** 2 + (sample.origin.y - point.y) ** 2 + (sample.origin.z - point.z) ** 2;
    if (d < bestDistance) {
      best = sample;
      bestDistance = d;
    }
  }
  return best;
}

/**
 * Builds the scene. `gameArchives` are opened .vpk sets (may be empty);
 * `collision` is the map's SolidGrid, used to test whether lights reach props.
 */
export async function buildBspScene(bsp, collision, gameArchives = []) {
  const pak = new ZipArchive(bsp.pakfile);
  const assets = new AssetLibrary([pak, ...gameArchives]);
  const materials = new MaterialLibrary(assets);
  const cubemaps = await loadCubemaps(bsp, pak, materials);

  const materialOf = (texinfo) => {
    const reflectivity = texinfo.texdata?.reflectivity ?? { x: 0.5, y: 0.5, z: 0.5 };
    return materials.get(texinfo.texture, [reflectivity.x, reflectivity.y, reflectivity.z]);
  };
  // Resolve every material up front, so the geometry pass below stays synchronous.
  const resolved = new Map();
  await Promise.all(bsp.texinfo.map(async (texinfo) => {
    if (!isHidden(texinfo)) resolved.set(texinfo, await materialOf(texinfo));
  }));

  const bumped = findBumpedFaces(bsp);
  const atlas = new LightmapAtlas(bsp, bsp.faces, (face) => bumped.has(face));
  const world = new Batches(WORLD_STRIDE);
  const envmapFor = (material, point) => {
    if (material.envmap === ENV_CUBEMAP) return nearest(cubemaps, point);
    return material.envmap ? { id: material.key, image: material.envmap } : null;
  };

  const addFace = (face, place, alpha) => {
    const texinfo = bsp.texinfo[face.texinfo];
    const material = resolved.get(texinfo);
    if (!material || face.dispinfo >= 0) return;   // displacements are added below
    const corners = faceCorners(bsp, face);
    const plane = bsp.planes[face.plane];
    const normal = place.direction(face.side ? scale(plane.normal, -1) : plane.normal);
    const tangent = tangentFrame(texinfo, normal, place);
    const bumpStep = atlas.bumpStep(face);
    const center = place.point(scale(corners.reduce(add), 1 / corners.length));

    const vertices = corners.map((p) => {
      const position = place.point(p);
      return [position.x, position.y, position.z, ...textureUv(texinfo, p), ...atlas.uv(face, texinfo, p), 0, bumpStep, normal.x, normal.y, normal.z, ...tangent];
    });
    const triangles = [];
    for (let i = 1; i < corners.length - 1; i++) triangles.push(0, i, i + 1);
    world.add(world.group(material, alpha, envmapFor(material, center)), vertices, triangles);
  };

  const addModelFaces = (modelIndex, place, alpha) => {
    const model = bsp.models[modelIndex];
    for (let f = model.firstFace; f < model.firstFace + model.numFaces; f++) addFace(bsp.faces[f], place, alpha);
  };

  addModelFaces(0, IDENTITY, 1);
  for (const entity of bsp.entities) {
    const name = entity.classname ?? '';
    if (!entity.model?.startsWith('*') || name.startsWith('trigger_') || INVISIBLE_BRUSH_ENTITIES.has(name)) continue;
    const alpha = entity.rendermode && entity.rendermode !== '0' ? Number(entity.renderamt ?? 255) / 255 : 1;
    addModelFaces(Number(entity.model.slice(1)), placement(angleMatrix(parseVector(entity.angles)), parseVector(entity.origin)), alpha);
  }

  for (const info of bsp.dispinfos) {
    const surface = displacementGrid(bsp, info);
    if (!surface) continue;
    const { grid, base, alpha, size, face, normal: faceNormal, texinfo } = surface;
    const material = resolved.get(texinfo);
    if (!material) continue;

    const triangles = [];
    for (let v = 0; v < size - 1; v++) {
      for (let u = 0; u < size - 1; u++) {
        const [i00, i01, i10, i11] = [v * size + u, v * size + u + 1, (v + 1) * size + u, (v + 1) * size + u + 1];
        // The engine alternates the split diagonal in a checkerboard.
        triangles.push(...((u + v) % 2 === 0 ? [i00, i10, i11, i00, i11, i01] : [i00, i10, i01, i10, i11, i01]));
      }
    }
    // Smooth normals: each point averages the triangles around it, facing the base face's side.
    const normals = grid.map(() => ({ x: 0, y: 0, z: 0 }));
    for (let t = 0; t < triangles.length; t += 3) {
      const [a, b, c] = [triangles[t], triangles[t + 1], triangles[t + 2]];
      let n = cross(sub(grid[b], grid[a]), sub(grid[c], grid[a]));
      if (dot(n, faceNormal) < 0) n = scale(n, -1);
      for (const i of [a, b, c]) normals[i] = add(normals[i], n);
    }
    const bumpStep = atlas.bumpStep(face);
    const vertices = grid.map((p, i) => {
      const n = normalize(normals[i]);
      return [p.x, p.y, p.z, ...textureUv(texinfo, base[i]), ...atlas.uv(face, texinfo, base[i]), alpha[i], bumpStep, n.x, n.y, n.z, ...tangentFrame(texinfo, n, IDENTITY)];
    });
    world.add(world.group(material, 1, envmapFor(material, grid[Math.floor(grid.length / 2)])), vertices, triangles);
  }

  const props = await buildProps(bsp, assets, materials, collision, cubemaps);

  const skyName = bsp.entities.find((e) => e.classname === 'worldspawn')?.skyname;
  const skyFaces = skyName ? await Promise.all(SKY_SUFFIXES.map(async (suffix) => (await materials.get(`skybox/${skyName}${suffix}`)).base)) : [];
  const fogEntity = bsp.entities.find((e) => e.classname === 'env_fog_controller' && e.fogenable === '1');
  const allMaterials = await Promise.all(materials.materials.values());

  return {
    lightmap: { width: atlas.width, height: atlas.height, data: atlas.data },
    world: world.toArray(),
    props: props.toArray(),
    sky: skyFaces.some(Boolean) ? Object.fromEntries(SKY_SUFFIXES.map((s, i) => [s, skyFaces[i]])) : null,
    fog: fogEntity ? {
      color: parseVector(fogEntity.fogcolor),
      start: Number(fogEntity.fogstart) || 0,
      end: Number(fogEntity.fogend) || 10000,
      maxDensity: fogEntity.fogmaxdensity !== undefined ? Number(fogEntity.fogmaxdensity) : 1,
    } : null,
    // Model lighting at a point (feet), for the viewmodel and characters (modelLighting.js).
    lightingAt: (point) => propLighting(bsp, ambient, collision, point),
    // Footstep surfaces by texinfo, from each material's $surfaceprop.
    surfaceProps: bsp.texinfo.map((texinfo) => resolved.get(texinfo)?.surfaceProp ?? 'default'),
    stats: {
      cubemaps: cubemaps.length,
      missingTextures: allMaterials.filter((m) => !m.base && m.shader !== 'water' && !m.key.startsWith('skybox/')).map((m) => m.key),
    },
  };
}

async function buildProps(bsp, assets, materials, collision, cubemaps) {
  const props = new Batches(PROP_STRIDE);
  const ambient = chooseAmbientSet(bsp);
  const placements = [
    ...readStaticProps(bsp),
    ...bsp.entities
      .filter((e) => DYNAMIC_PROP_CLASSES.has(e.classname) && e.model?.toLowerCase().endsWith('.mdl'))
      .map((e) => ({ model: e.model, origin: parseVector(e.origin), angles: parseVector(e.angles), skin: Number(e.skin) || 0, lightingOrigin: parseVector(e.origin) })),
  ];

  const models = new Map();
  for (const { model } of placements) if (!models.has(model)) models.set(model, loadModel(assets, model));

  for (const prop of placements) {
    const model = await models.get(prop.model);
    if (!model) continue;
    const place = placement(angleMatrix(prop.angles), prop.origin);
    const lighting = propLighting(bsp, ambient, collision, prop.lightingOrigin);
    const skin = model.skins[prop.skin] ?? model.skins[0] ?? [];

    for (const mesh of model.meshes) {
      const textureIndex = skin[mesh.textureIndex] ?? mesh.textureIndex;
      const candidates = model.materialPaths[textureIndex] ?? [];
      const path = candidates.find((candidate) => assets.has(`materials/${candidate}.vmt`)) ?? candidates[0] ?? '';
      const material = await materials.get(path);
      const envmap = material.envmap === ENV_CUBEMAP ? nearest(cubemaps, prop.origin)
        : material.envmap ? { id: material.key, image: material.envmap } : null;
      const vertices = mesh.vertices.map((v) => {
        const position = place.point(vectorOf(v.position));
        const n = normalize(place.direction(vectorOf(v.normal)));
        return [position.x, position.y, position.z, ...v.uv, ...vertexLight([n.x, n.y, n.z], lighting), n.x, n.y, n.z];
      });
      props.add(props.group(material, 1, envmap), vertices, mesh.indices);
    }
  }
  models.clear();
  return props;
}
