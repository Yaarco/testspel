/**
 * Turns a parsed BSP into a playable world with the same interface as Course.
 * - Collision: world brushes and solid brush entities, using their own planes
 *   (the map already stores the bevel planes), plus displacement triangles.
 *   Brush bounds come from clipping each side's plane against the others.
 * - Gameplay: spawn point, trigger_teleport volumes, and a void respawn.
 * Drawing is separate: bspScene.js builds the textured scene.
 */
import { PLAYER } from './config.js';
import { SolidGrid, hullInside } from './collision.js';
import { axialBevels, bounds, packPlanes } from './solids.js';
import { add, cross, dot, lerp, normalize, scale, sub } from './vector.js';

const CONTENTS = { SOLID: 0x1, WINDOW: 0x2, GRATE: 0x8, MOVEABLE: 0x4000, PLAYERCLIP: 0x10000, MONSTER: 0x2000000 };
const PLAYER_SOLID = CONTENTS.SOLID | CONTENTS.WINDOW | CONTENTS.GRATE |
  CONTENTS.MOVEABLE | CONTENTS.PLAYERCLIP | CONTENTS.MONSTER;
const SURFACE = { SKY2D: 0x2, SKY: 0x4 };

const SOLID_BRUSH_ENTITIES = new Set(['func_brush', 'func_wall', 'func_wall_toggle']);
const SPAWN_CLASSES = ['info_player_counterterrorist', 'info_player_terrorist', 'info_player_start'];
const WINDING_SIZE = 65536;
const CLIP_EPSILON = 0.01;
const VOID_MARGIN = 512;


export const parseVector = (text = '0 0 0') => {
  const [x, y, z] = text.trim().split(/\s+/).map(Number);
  return { x: x || 0, y: y || 0, z: z || 0 };
};

/** Collects every brush in a model by walking its BSP tree down to the leaves. */
function brushesOfModel(bsp, modelIndex) {
  const found = new Set();
  const stack = [bsp.models[modelIndex].headNode];
  while (stack.length) {
    const node = stack.pop();
    if (node < 0) {
      const leaf = bsp.leafs[-1 - node];
      for (let i = 0; i < leaf.numLeafBrushes; i++) found.add(bsp.leafBrushes[leaf.firstLeafBrush + i]);
    } else {
      stack.push(...bsp.nodes[node]);
    }
  }
  return [...found];
}

/** A huge square on the plane, as in Quake's BaseWindingForPlane. */
function baseWinding({ normal, dist }) {
  const helper = Math.abs(normal.z) > Math.abs(normal.x) && Math.abs(normal.z) > Math.abs(normal.y)
    ? { x: 1, y: 0, z: 0 } : { x: 0, y: 0, z: 1 };
  const up = scale(normalize(sub(helper, scale(normal, dot(helper, normal)))), WINDING_SIZE);
  const right = cross(up, normal);
  const origin = scale(normal, dist);
  return [
    add(sub(origin, right), up), add(add(origin, right), up),
    sub(add(origin, right), up), sub(sub(origin, right), up),
  ];
}

/** Keeps the part of a polygon behind the plane (inside the brush). */
function clipWinding(points, { normal, dist }) {
  const result = [];
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    const da = dot(a, normal) - dist;
    const db = dot(b, normal) - dist;
    if (da <= CLIP_EPSILON) result.push(a);
    if ((da < -CLIP_EPSILON && db > CLIP_EPSILON) || (da > CLIP_EPSILON && db < -CLIP_EPSILON)) {
      result.push(lerp(a, b, da / (da - db)));
    }
  }
  return result;
}

function offsetPlane({ normal, dist }, origin) {
  return { normal, dist: dist + dot(normal, origin) };
}

/** Builds the collision solid for one brush, offset by its entity's origin. */
function convertBrush(bsp, brushIndex, origin) {
  const brush = bsp.brushes[brushIndex];
  const sides = bsp.brushSides.slice(brush.firstSide, brush.firstSide + brush.numSides);
  const planes = sides.map((side) => offsetPlane(bsp.planes[side.plane], origin));
  const corners = [];

  sides.forEach((side, i) => {
    if (side.bevel) return;
    let winding = baseWinding(planes[i]);
    planes.forEach((plane, j) => {
      if (j !== i && winding.length >= 3) winding = clipWinding(winding, plane);
    });
    if (winding.length >= 3) corners.push(...winding);
  });

  if (corners.length === 0) return null;
  const { min, max } = bounds(corners);
  const sky = sides.some((side) => (bsp.texinfo[side.texinfo]?.flags ?? 0) & (SURFACE.SKY | SURFACE.SKY2D));
  // Each plane's texinfo, in plane order, so a trace hit tells which material was touched.
  const texinfos = Int16Array.from(sides, (side) => side.texinfo);
  return { planes: packPlanes(planes), min, max, sky, texinfos };
}

export function faceCorners(bsp, face) {
  const corners = [];
  for (let i = 0; i < face.numEdges; i++) {
    const surfedge = bsp.surfedges[face.firstEdge + i];
    const edge = bsp.edges[Math.abs(surfedge)];
    corners.push(bsp.vertices[surfedge >= 0 ? edge[0] : edge[1]]);
  }
  return corners;
}

/**
 * Displacement grid points, laid out as in the SDK's CCoreDispInfo::GenerateDispSurf.
 * `base` holds the undisplaced points on the face, used for texture and lightmap
 * coordinates; `alpha` is the per-point blend between two textures.
 */
export function displacementGrid(bsp, info) {
  const face = bsp.faces[info.face];
  let corners = faceCorners(bsp, face);
  if (corners.length !== 4) return null;

  // The grid starts at the corner closest to the recorded start position.
  const distances = corners.map((c) => Math.hypot(c.x - info.start.x, c.y - info.start.y, c.z - info.start.z));
  const first = distances.indexOf(Math.min(...distances));
  corners = [...corners.slice(first), ...corners.slice(0, first)];

  const size = (1 << info.power) + 1;
  const grid = [];
  const base = [];
  const alpha = [];
  for (let v = 0; v < size; v++) {
    const left = lerp(corners[0], corners[1], v / (size - 1));
    const right = lerp(corners[3], corners[2], v / (size - 1));
    for (let u = 0; u < size; u++) {
      const vert = bsp.dispVerts[info.firstVert + v * size + u];
      const point = lerp(left, right, u / (size - 1));
      base.push(point);
      grid.push(add(point, scale(vert.offset, vert.dist)));
      alpha.push(vert.alpha / 255);
    }
  }

  const plane = bsp.planes[face.plane];
  const normal = face.side ? scale(plane.normal, -1) : plane.normal;
  return { grid, base, alpha, size, normal, face, texinfo: bsp.texinfo[face.texinfo] };
}

const TRIANGLE_PLANES = 11;   // two faces, three edges, six axial bevels

/**
 * A zero-thickness triangle as a convex solid. Its planes are written into
 * `storage` (a view into one buffer shared by all triangles) to save memory.
 */
function triangleSolid(a, b, c, storage, texinfo) {
  const n = cross(sub(b, a), sub(c, a));
  if (Math.hypot(n.x, n.y, n.z) < 1e-6) return null;
  const normal = normalize(n);
  const planes = [
    { normal, dist: dot(normal, a) },
    { normal: scale(normal, -1), dist: -dot(normal, a) },
  ];
  for (const [p, q, opposite] of [[a, b, c], [b, c, a], [c, a, b]]) {
    let edgeNormal = normalize(cross(sub(q, p), normal));
    if (dot(edgeNormal, sub(opposite, p)) > 0) edgeNormal = scale(edgeNormal, -1);
    planes.push({ normal: edgeNormal, dist: dot(edgeNormal, p) });
  }
  const { min, max } = bounds([a, b, c]);
  [...planes, ...axialBevels(min, max)].forEach(({ normal: pn, dist }, i) => storage.set([pn.x, pn.y, pn.z, dist], i * 4));
  return { planes: storage, min, max, texinfo };
}

function convertDisplacements(bsp, solids) {
  const grids = bsp.dispinfos.map((info) => displacementGrid(bsp, info)).filter(Boolean);
  const triangleCount = grids.reduce((sum, { size }) => sum + (size - 1) * (size - 1) * 2, 0);
  const planes = new Float64Array(triangleCount * TRIANGLE_PLANES * 4);
  const stride = TRIANGLE_PLANES * 4;
  let used = 0;

  for (const { grid, size, face } of grids) {
    for (let v = 0; v < size - 1; v++) {
      for (let u = 0; u < size - 1; u++) {
        const p00 = grid[v * size + u];
        const p01 = grid[v * size + u + 1];
        const p10 = grid[(v + 1) * size + u];
        const p11 = grid[(v + 1) * size + u + 1];
        // The engine alternates the split diagonal in a checkerboard.
        const triangles = (u + v) % 2 === 0
          ? [[p00, p10, p11], [p00, p11, p01]]
          : [[p00, p10, p01], [p10, p11, p01]];
        for (const triangle of triangles) {
          const solid = triangleSolid(...triangle, planes.subarray(used * stride, (used + 1) * stride), face.texinfo);
          if (solid) {
            solids.push(solid);
            used++;
          }
        }
      }
    }
  }
}

function findSpawn(entities) {
  for (const classname of SPAWN_CLASSES) {
    const spawn = entities.find((e) => e.classname === classname);
    if (spawn) return { feet: parseVector(spawn.origin), yaw: parseVector(spawn.angles).y };
  }
  return { feet: { x: 0, y: 0, z: 0 }, yaw: 0 };
}

/** Teleport volumes with their destination, skipping ones that start disabled. */
function convertTeleports(bsp, entities) {
  const triggers = [];
  for (const entity of entities) {
    if (entity.classname !== 'trigger_teleport' || entity.StartDisabled === '1') continue;
    const target = (entity.target ?? '').toLowerCase();
    const destination = entities.find((e) => e.targetname?.toLowerCase() === target && e !== entity);
    if (!destination || !entity.model?.startsWith('*')) continue;

    const teleport = { feet: parseVector(destination.origin), yaw: parseVector(destination.angles).y };
    const origin = parseVector(entity.origin);
    for (const brushIndex of brushesOfModel(bsp, Number(entity.model.slice(1)))) {
      const volume = convertBrush(bsp, brushIndex, origin);
      if (volume) triggers.push({ ...volume, teleport });
    }
  }
  return triggers;
}

export class BspWorld {
  constructor(bsp, name) {
    this.name = name;
    this.kind = 'map';
    this.version = 0;
    this.highlightIndex = -1;
    this.score = null;

    const solids = [];
    const addBrushes = (modelIndex, origin) => {
      for (const brushIndex of brushesOfModel(bsp, modelIndex)) {
        if (!(bsp.brushes[brushIndex].contents & PLAYER_SOLID)) continue;
        const solid = convertBrush(bsp, brushIndex, origin);
        if (solid) solids.push(solid);
      }
    };

    addBrushes(0, { x: 0, y: 0, z: 0 });
    for (const entity of bsp.entities) {
      const solidEntity = SOLID_BRUSH_ENTITIES.has(entity.classname) && entity.Solidity !== '1';
      if (solidEntity && entity.model?.startsWith('*')) addBrushes(Number(entity.model.slice(1)), parseVector(entity.origin));
    }
    convertDisplacements(bsp, solids);

    this.collision = new SolidGrid(solids);
    const teleports = convertTeleports(bsp, bsp.entities);
    this.triggers = new SolidGrid(teleports);
    this.spawn = findSpawn(bsp.entities);
    this.voidHeight = bsp.models[0].min.z - VOID_MARGIN;

    this.stats = { solids: solids.length, teleports: teleports.length };
  }

  respawnPoint() {
    return this.spawn;
  }

  /**
   * The surface property ("concrete", "metal", ...) of a solid's side, for
   * footsteps. `surfaceProps` (by texinfo) is filled in once materials load.
   */
  surfaceAt(solid, plane) {
    const texinfo = solid?.texinfos ? solid.texinfos[plane] : solid?.texinfo;
    return this.surfaceProps?.[texinfo] ?? 'default';
  }

  /** Touching a trigger_teleport moves the player and zeroes their velocity. */
  afterMove(player) {
    const height = player.hullHeight;
    const half = PLAYER.hullHalfWidth;
    const min = { x: player.pos.x - half, y: player.pos.y - half, z: player.pos.z };
    const max = { x: player.pos.x + half, y: player.pos.y + half, z: player.pos.z + height };
    let teleport = null;
    this.triggers.query(min, max, (trigger) => {
      if (!teleport && hullInside(player.pos, height, trigger)) teleport = trigger.teleport;
    });
    if (teleport) return { teleport };
    return player.pos.z < this.voidHeight ? { respawn: true } : null;
  }
}
