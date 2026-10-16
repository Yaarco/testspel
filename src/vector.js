/** Minimal 3D vector helpers on plain {x, y, z} objects. */
export const vec3 = (x = 0, y = 0, z = 0) => ({ x, y, z });
export const copy = (v) => ({ x: v.x, y: v.y, z: v.z });
export const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
export const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
export const scale = (v, s) => ({ x: v.x * s, y: v.y * s, z: v.z * s });
export const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
export const lerp = (a, b, t) => add(a, scale(sub(b, a), t));

export function cross(a, b) {
  return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
}

export function normalize(v) {
  const length = Math.hypot(v.x, v.y, v.z);
  return length > 0 ? scale(v, 1 / length) : vec3();
}

export const toRadians = (degrees) => degrees * Math.PI / 180;
export const toDegrees = (radians) => radians * 180 / Math.PI;
export const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
