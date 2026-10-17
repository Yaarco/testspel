/**
 * Swept hull traces against convex brushes, the way Quake 3 does it
 * (CM_TraceThroughBrush). Each brush plane is pushed out by the hull's extent,
 * then the hull origin is traced as a point against the expanded brush.
 * The hull origin sits at the feet: it spans hullHalfWidth in x and y and
 * from z up to z + height.
 *
 * A solid is { planes, min, max } where planes is a Float64Array of
 * [nx, ny, nz, dist] quadruples with normals pointing out of the solid.
 */
import { PLAYER } from './config.js';

export const DIST_EPSILON = 0.03125;   // traces stop this far short of a surface
const CELL_SIZE = 512;
const MAX_CELLS_PER_SOLID = 4096; // bigger solids go in a list that every query checks

/** Plane distance pushed out so a hull (half width, height) just touches the original plane. */
function expandedDist(nx, ny, nz, dist, half, height) {
  const cornerX = nx < 0 ? half : -half;
  const cornerY = ny < 0 ? half : -half;
  const cornerZ = nz < 0 ? height : 0;
  return dist - (cornerX * nx + cornerY * ny + cornerZ * nz);
}

/**
 * Uniform grid over solids, so a trace only tests solids near its path.
 * Works the same for a 40-platform course and a 100k-triangle map.
 */
export class SolidGrid {
  constructor(solids) {
    this.cells = new Map();
    this.large = [];
    this.stamp = 0;
    for (const solid of solids) this.insert(solid);
  }

  insert(solid) {
    solid.queryStamp = 0;
    const [lo, hi] = [cellRange(solid.min), cellRange(solid.max)];
    const count = (hi.x - lo.x + 1) * (hi.y - lo.y + 1) * (hi.z - lo.z + 1);
    if (count > MAX_CELLS_PER_SOLID) {
      this.large.push(solid);
      return;
    }
    for (let x = lo.x; x <= hi.x; x++) {
      for (let y = lo.y; y <= hi.y; y++) {
        for (let z = lo.z; z <= hi.z; z++) {
          const key = cellKey(x, y, z);
          const cell = this.cells.get(key);
          if (cell) cell.push(solid);
          else this.cells.set(key, [solid]);
        }
      }
    }
  }

  /** Calls visit once for every solid whose bounds overlap the box. */
  query(min, max, visit) {
    const stamp = ++this.stamp;
    const check = (solid) => {
      if (solid.queryStamp === stamp) return;
      solid.queryStamp = stamp;
      if (boundsOverlap(solid, min, max)) visit(solid);
    };
    this.large.forEach(check);

    const [lo, hi] = [cellRange(min), cellRange(max)];
    const span = (hi.x - lo.x + 1) * (hi.y - lo.y + 1) * (hi.z - lo.z + 1);
    if (span > this.cells.size) {
      // Huge query box: cheaper to scan the occupied cells than every cell in range.
      for (const cell of this.cells.values()) cell.forEach(check);
      return;
    }
    for (let x = lo.x; x <= hi.x; x++) {
      for (let y = lo.y; y <= hi.y; y++) {
        for (let z = lo.z; z <= hi.z; z++) {
          const cell = this.cells.get(cellKey(x, y, z));
          if (cell) cell.forEach(check);
        }
      }
    }
  }
}

function cellRange(point) {
  return {
    x: Math.floor(point.x / CELL_SIZE),
    y: Math.floor(point.y / CELL_SIZE),
    z: Math.floor(point.z / CELL_SIZE),
  };
}

const cellKey = (x, y, z) => `${x},${y},${z}`;

function boundsOverlap(solid, min, max) {
  return solid.min.x <= max.x && solid.max.x >= min.x &&
    solid.min.y <= max.y && solid.max.y >= min.y &&
    solid.min.z <= max.z && solid.max.z >= min.z;
}

function traceThroughSolid(start, end, half, height, solid, trace) {
  const planes = solid.planes;
  let enterFraction = -1;
  let leaveFraction = 1;
  let hitPlane = -1;
  let startsOutside = false;

  for (let i = 0; i < planes.length; i += 4) {
    const nx = planes[i], ny = planes[i + 1], nz = planes[i + 2];
    const dist = expandedDist(nx, ny, nz, planes[i + 3], half, height);
    const d1 = start.x * nx + start.y * ny + start.z * nz - dist;
    const d2 = end.x * nx + end.y * ny + end.z * nz - dist;

    if (d1 > 0) startsOutside = true;
    if (d1 > 0 && (d2 >= DIST_EPSILON || d2 >= d1)) return;  // entirely in front of this plane
    if (d1 <= 0 && d2 <= 0) continue;                          // entirely behind this plane

    if (d1 > d2) {
      const fraction = Math.max((d1 - DIST_EPSILON) / (d1 - d2), 0);
      if (fraction > enterFraction) {
        enterFraction = fraction;
        hitPlane = i;
      }
    } else {
      leaveFraction = Math.min(leaveFraction, (d1 + DIST_EPSILON) / (d1 - d2));
    }
  }

  // Starting inside a solid would trap the player, so such solids are skipped.
  if (!startsOutside) return;

  if (hitPlane >= 0 && enterFraction < leaveFraction && enterFraction < trace.fraction) {
    trace.fraction = enterFraction;
    trace.normal = { x: planes[hitPlane], y: planes[hitPlane + 1], z: planes[hitPlane + 2] };
    trace.plane = hitPlane / 4;
    trace.solid = solid;
  }
}

function sweptBounds(start, end, half, height) {
  return {
    min: { x: Math.min(start.x, end.x) - half, y: Math.min(start.y, end.y) - half, z: Math.min(start.z, end.z) },
    max: { x: Math.max(start.x, end.x) + half, y: Math.max(start.y, end.y) + half, z: Math.max(start.z, end.z) + height },
  };
}

function sweep(start, end, half, height, grid) {
  const trace = { fraction: 1, normal: null, solid: null };
  const { min, max } = sweptBounds(start, end, half, height);
  grid.query(min, max, (solid) => traceThroughSolid(start, end, half, height, solid, trace));

  trace.endPos = {
    x: start.x + (end.x - start.x) * trace.fraction,
    y: start.y + (end.y - start.y) * trace.fraction,
    z: start.z + (end.z - start.z) * trace.fraction,
  };
  return trace;
}

/** Sweeps the player hull from start to end. Returns the fraction travelled, end position and hit surface. */
export function traceHull(start, end, height, grid) {
  return sweep(start, end, PLAYER.hullHalfWidth, height, grid);
}

/** Sweeps a cube of half size `radius` centered on start to end (ragdoll joints); positions are centers. */
export function traceBox(start, end, radius, grid) {
  const low = (p) => ({ x: p.x, y: p.y, z: p.z - radius });
  const trace = sweep(low(start), low(end), radius, radius * 2, grid);
  trace.endPos = { ...trace.endPos, z: trace.endPos.z + radius };
  return trace;
}

/**
 * Traces a line (a bullet) from start to end. Long lines are walked in
 * pieces so each grid query stays small and the walk stops at the first hit.
 */
export function traceLine(start, end, grid) {
  const length = Math.hypot(end.x - start.x, end.y - start.y, end.z - start.z);
  const pieces = Math.max(1, Math.ceil(length / CELL_SIZE));
  const at = (f) => ({ x: start.x + (end.x - start.x) * f, y: start.y + (end.y - start.y) * f, z: start.z + (end.z - start.z) * f });
  for (let i = 0; i < pieces; i++) {
    const hit = sweep(at(i / pieces), at((i + 1) / pieces), 0, 0, grid);
    if (hit.solid) return { ...hit, fraction: (i + hit.fraction) / pieces };
  }
  return { fraction: 1, normal: null, solid: null, endPos: end };
}

/** True when the hull at pos is inside this solid. */
export function hullInside(pos, height, solid) {
  const planes = solid.planes;
  for (let i = 0; i < planes.length; i += 4) {
    const nx = planes[i], ny = planes[i + 1], nz = planes[i + 2];
    if (pos.x * nx + pos.y * ny + pos.z * nz - expandedDist(nx, ny, nz, planes[i + 3], PLAYER.hullHalfWidth, height) >= 0) return false;
  }
  return true;
}

/** True when a hull of this height at pos overlaps no solid. */
export function hullFits(pos, height, grid) {
  let fits = true;
  const { min, max } = sweptBounds(pos, pos, PLAYER.hullHalfWidth, height);
  grid.query(min, max, (solid) => {
    if (fits && hullInside(pos, height, solid)) fits = false;
  });
  return fits;
}
