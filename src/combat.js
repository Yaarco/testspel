/**
 * Hits and damage by the classic rules. A fighter's hitboxes are a head sphere and
 * capsules for chest, stomach and legs; damage falls off with distance by
 * the weapon's range modifier, is multiplied per hit group, and kevlar (with
 * a helmet for headshots) takes part of it by the weapon's armor ratio.
 */
import { add, dot, scale, sub } from './vector.js';

const HIT_GROUPS = {
  head: { multiplier: null, armored: true },   // the weapon's headshot multiplier
  chest: { multiplier: 1, armored: true },
  stomach: { multiplier: 1.25, armored: true },
  legs: { multiplier: 0.75, armored: false },
};
const ARMOR_BONUS = 0.5;   // each point of armor absorbs two points of damage

/**
 * Hitboxes of a standing or ducking fighter at `feet`; `head` is the head
 * center when an animated model gives one.
 */
export function hitboxes(feet, ducked, head = null) {
  const height = ducked ? 54 : 72;
  const at = (z) => ({ x: feet.x, y: feet.y, z: feet.z + z * height / 72 });
  return [
    { group: 'head', sphere: head ?? at(65), radius: 5.5 },
    { group: 'chest', a: at(44), b: at(58), radius: 9 },
    { group: 'stomach', a: at(32), b: at(44), radius: 8 },
    { group: 'legs', a: at(3), b: at(32), radius: 7 },
  ];
}

/** Distance along a unit-direction ray to a sphere, or Infinity. */
function raySphere(origin, direction, center, radius) {
  const toCenter = sub(center, origin);
  const along = dot(toCenter, direction);
  const miss = dot(toCenter, toCenter) - along * along;
  if (miss > radius * radius) return Infinity;
  const t = along - Math.sqrt(radius * radius - miss);
  return t >= 0 ? t : Infinity;
}

/** Distance to a capsule, found as the nearest sphere along its axis (a few samples are plenty here). */
function rayCapsule(origin, direction, a, b, radius) {
  let best = Infinity;
  const steps = 6;
  for (let i = 0; i <= steps; i++) best = Math.min(best, raySphere(origin, direction, add(a, scale(sub(b, a), i / steps)), radius));
  return best;
}

/** The nearest hitbox a ray crosses within `range`: { group, distance } or null. */
export function traceHitboxes(origin, direction, range, boxes) {
  let hit = null;
  for (const box of boxes) {
    const distance = box.sphere
      ? raySphere(origin, direction, box.sphere, box.radius)
      : rayCapsule(origin, direction, box.a, box.b, box.radius);
    if (distance <= range && (!hit || distance < hit.distance)) hit = { group: box.group, distance };
  }
  return hit;
}

/**
 * Damages a fighter ({ health, armor, helmet }) hit in `group` from
 * `distance` by a weapon's stats; returns the health it lost.
 */
export function applyDamage(fighter, stats, group, distance, baseDamage = stats.damage) {
  const rule = HIT_GROUPS[group];
  let damage = baseDamage * (stats.rangeModifier ?? 1) ** (distance / 500);
  damage *= rule.multiplier ?? stats.headshotMultiplier ?? 4;
  let health = damage;
  const armored = fighter.armor > 0 && rule.armored && (group !== 'head' || fighter.helmet);
  if (armored) {
    health = damage * (stats.armorRatio ?? 1) * 0.5;
    let armorTaken = (damage - health) * ARMOR_BONUS;
    if (armorTaken > fighter.armor) {
      health = damage - fighter.armor / ARMOR_BONUS;
      armorTaken = fighter.armor;
    }
    fighter.armor = Math.max(0, fighter.armor - Math.round(armorTaken));
  }
  const lost = Math.min(fighter.health, Math.max(1, Math.floor(health)));
  fighter.health -= lost;
  return lost;
}

/** Unit forward, right and up vectors for view angles (degrees; positive pitch looks down). */
export function viewAxes(yaw, pitch) {
  const [y, p] = [yaw * Math.PI / 180, pitch * Math.PI / 180];
  const [sy, cy, sp, cp] = [Math.sin(y), Math.cos(y), Math.sin(p), Math.cos(p)];
  return {
    forward: { x: cp * cy, y: cp * sy, z: -sp },
    right: { x: sy, y: -cy, z: 0 },
    up: { x: sp * cy, y: sp * sy, z: cp },
  };
}

/**
 * Directions of one shot's bullets (shotguns fire several), each scattered
 * within the inaccuracy cone plus the weapon's own spread.
 */
export function bulletDirections(yaw, pitch, stats, inaccuracy) {
  const { forward, right, up } = viewAxes(yaw, pitch);
  return Array.from({ length: stats.bullets ?? 1 }, () => {
    const radius = Math.random() * inaccuracy;
    const angle = Math.random() * Math.PI * 2;
    const spread = Math.random() * (stats.spread ?? 0);
    const spreadAngle = Math.random() * Math.PI * 2;
    const x = Math.cos(angle) * radius + Math.cos(spreadAngle) * spread;
    const y = Math.sin(angle) * radius + Math.sin(spreadAngle) * spread;
    const direction = add(forward, add(scale(right, x), scale(up, y)));
    return scale(direction, 1 / Math.hypot(direction.x, direction.y, direction.z));
  });
}
