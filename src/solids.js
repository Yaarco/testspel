/**
 * World geometry as convex brushes, like BSP maps.
 * A solid keeps its faces (for drawing) and its planes (for collision,
 * packed as [nx, ny, nz, dist] quadruples, see collision.js).
 * Each solid also gets the six axis-aligned bevel planes of its bounds,
 * which BSP compilers add to every brush so box traces against it stay tight.
 */
import { add, sub, scale, cross, dot, normalize } from './vector.js';

const AXIAL_NORMALS = [
  { x: 1, y: 0, z: 0 }, { x: -1, y: 0, z: 0 },
  { x: 0, y: 1, z: 0 }, { x: 0, y: -1, z: 0 },
  { x: 0, y: 0, z: 1 }, { x: 0, y: 0, z: -1 },
];

/** Normal from the right-hand rule, so it points toward a viewer who sees the face counter-clockwise. */
function faceNormal(face) {
  return normalize(cross(sub(face[1], face[0]), sub(face[2], face[0])));
}

export function packPlanes(planes) {
  const packed = new Float64Array(planes.length * 4);
  planes.forEach(({ normal, dist }, i) => packed.set([normal.x, normal.y, normal.z, dist], i * 4));
  return packed;
}

export function axialBevels(min, max) {
  return AXIAL_NORMALS.map((normal) => ({
    normal,
    dist: dot(normal, normal.x + normal.y + normal.z > 0 ? max : min),
  }));
}

export function bounds(points) {
  const along = (axis, pick) => pick(...points.map((p) => p[axis]));
  return {
    min: { x: along('x', Math.min), y: along('y', Math.min), z: along('z', Math.min) },
    max: { x: along('x', Math.max), y: along('y', Math.max), z: along('z', Math.max) },
  };
}

/** Builds a solid from convex planar faces given in any winding order. */
export function createSolid(faces, properties) {
  const vertices = faces.flat();
  const center = scale(vertices.reduce(add), 1 / vertices.length);

  // Wind every face counter-clockwise seen from outside, so normals point out.
  const outwardFaces = faces.map((face) =>
    dot(faceNormal(face), sub(face[0], center)) < 0 ? [...face].reverse() : face);
  const facePlanes = outwardFaces.map((face) => {
    const normal = faceNormal(face);
    return { normal, dist: dot(normal, face[0]) };
  });

  const { min, max } = bounds(vertices);

  return {
    ...properties,
    faces: outwardFaces,
    faceNormals: facePlanes.map((plane) => plane.normal),
    planes: packPlanes([...facePlanes, ...axialBevels(min, max)]),
    min,
    max,
  };
}

/** A box whose top face is centered on `top` and whose long axis follows `heading` (radians). */
export function createOrientedBox({ top, heading, halfLength, halfWidth, depth }, properties) {
  const axis = { x: Math.cos(heading), y: Math.sin(heading), z: 0 };
  const side = { x: -Math.sin(heading), y: Math.cos(heading), z: 0 };
  const corner = (l, w, isTop) => ({
    x: top.x + axis.x * l * halfLength + side.x * w * halfWidth,
    y: top.y + axis.y * l * halfLength + side.y * w * halfWidth,
    z: isTop ? top.z : top.z - depth,
  });

  const faces = [
    [corner(-1, -1, true), corner(1, -1, true), corner(1, 1, true), corner(-1, 1, true)],
    [corner(-1, -1, false), corner(1, -1, false), corner(1, 1, false), corner(-1, 1, false)],
    [corner(1, -1, false), corner(1, 1, false), corner(1, 1, true), corner(1, -1, true)],
    [corner(-1, -1, false), corner(-1, -1, true), corner(-1, 1, true), corner(-1, 1, false)],
    [corner(-1, 1, false), corner(-1, 1, true), corner(1, 1, true), corner(1, 1, false)],
    [corner(-1, -1, false), corner(1, -1, false), corner(1, -1, true), corner(-1, -1, true)],
  ];
  return createSolid(faces, { ...properties, top, heading, halfLength, halfWidth });
}

/**
 * A surf ramp: a triangular prism with its ridge running from `start` to `end`.
 * Both sides slope down to a base `halfWidth` out from the ridge and `height` below it.
 */
export function createRamp({ start, end, halfWidth, height }, properties) {
  const along = sub(end, start);
  const side = normalize(cross({ x: 0, y: 0, z: 1 }, along));
  const base = (ridge, sign) => add(ridge, { x: side.x * sign * halfWidth, y: side.y * sign * halfWidth, z: -height });

  const [startLeft, startRight] = [base(start, 1), base(start, -1)];
  const [endLeft, endRight] = [base(end, 1), base(end, -1)];

  const faces = [
    [start, end, endLeft, startLeft],
    [start, startRight, endRight, end],
    [startLeft, endLeft, endRight, startRight],
    [start, startLeft, startRight],
    [end, endRight, endLeft],
  ];
  return createSolid(faces, properties);
}

/** Horizontal distance from a box's center to its edge along a unit direction. */
export function reachAlong(box, direction) {
  const axis = { x: Math.cos(box.heading), y: Math.sin(box.heading) };
  const alongAxis = Math.abs(direction.x * axis.x + direction.y * axis.y);
  const acrossAxis = Math.abs(direction.x * -axis.y + direction.y * axis.x);
  return box.halfLength * alongAxis + box.halfWidth * acrossAxis;
}
