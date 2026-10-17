/**
 * Bullets, hits and damage by the classic rules. A fighter's hitboxes are a
 * head sphere and capsules for chest, stomach and legs. A bullet flies up to
 * the weapon's range; its damage falls off with distance by the range
 * modifier, and it goes through up to four walls when the weapon's
 * penetration power allows, losing damage for each wall and more for thick
 * ones (walls over 90 units stop it). Damage is multiplied per hit group,
 * and kevlar (with a helmet for headshots) takes part of it by the weapon's
 * armor ratio.
 */
import { traceLine } from './collision.js';
import { add, dot, scale, sub } from './vector.js';

const PENETRATION = {
  maxWalls: 4,
  maxThickness: 90,         // units of solid a bullet can cross in one wall
  damageLost: 0.16,         // share of damage every wall takes
  joinGap: 1,               // solids closer than this along the bullet count as one wall
};

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

/** How far a ray from `point` (on or inside a convex solid) runs before leaving it, and the plane it leaves by. */
function exitThrough(solid, point, direction) {
  const planes = solid.planes;
  let distance = Infinity;
  let normal = null;
  for (let i = 0; i < planes.length; i += 4) {
    const facing = planes[i] * direction.x + planes[i + 1] * direction.y + planes[i + 2] * direction.z;
    if (facing <= 0) continue;
    const t = (planes[i + 3] - (planes[i] * point.x + planes[i + 1] * point.y + planes[i + 2] * point.z)) / facing;
    if (t < distance) {
      distance = Math.max(t, 0);
      normal = { x: planes[i], y: planes[i + 1], z: planes[i + 2] };
    }
  }
  return { distance, normal };
}

/**
 * Crosses the wall a bullet entered at `entry` through `solid`, including
 * solids that touch it along the way. Returns { thickness, exit, normal }, or
 * null when the wall is too thick.
 */
function crossWall(solid, entry, direction, collision) {
  let thickness = 0;
  let point = entry;
  for (;;) {
    const out = exitThrough(solid, point, direction);
    thickness += out.distance;
    if (thickness > PENETRATION.maxThickness) return null;
    point = add(point, scale(direction, out.distance));
    // Look just past the exit for a touching solid; start a little inside, which the trace skips.
    const next = traceLine(sub(point, scale(direction, 0.5)), add(point, scale(direction, PENETRATION.joinGap)), collision);
    if (!next.solid) return { thickness, exit: point, normal: out.normal };
    solid = next.solid;
    thickness += Math.max(0, dot(sub(next.endPos, point), direction));
    point = next.endPos;
  }
}

/**
 * One bullet from `origin` along a unit `direction`, through walls and into
 * the first of `boxes` it reaches. Returns { hit, impacts, end }: hit is
 * { group, distance, damage } with the damage it still carries (before hit
 * group and armor), impacts are the { point, normal } holes it left going in
 * and out of walls, and end is where it stopped.
 */
export function traceBullet(origin, direction, stats, collision, boxes = []) {
  const range = stats.range ?? 8192;
  const power = stats.penetration ?? 1;
  const impacts = [];
  let damage = stats.damage;
  let start = origin;
  let travelled = 0;
  for (let wall = 0; ; wall++) {
    const left = range - travelled;
    const trace = traceLine(start, add(start, scale(direction, left)), collision);
    const reach = trace.fraction * left;
    const body = boxes.length ? traceHitboxes(start, direction, reach, boxes) : null;
    const falloff = (distance) => damage * (stats.rangeModifier ?? 1) ** (distance / 500);
    if (body) {
      const end = add(start, scale(direction, body.distance));
      return { hit: { group: body.group, distance: travelled + body.distance, damage: falloff(body.distance) }, impacts, end };
    }
    if (!trace.solid || trace.solid.sky) return { hit: null, impacts, end: trace.endPos };
    impacts.push({ point: trace.endPos, normal: trace.normal });
    if (wall >= PENETRATION.maxWalls || power <= 0) return { hit: null, impacts, end: trace.endPos };

    const crossed = crossWall(trace.solid, trace.endPos, direction, collision);
    if (!crossed) return { hit: null, impacts, end: trace.endPos };
    const resistance = 1 / (trace.solid.penetrationModifier ?? 1);
    damage = falloff(reach);
    damage -= damage * PENETRATION.damageLost + (3 / power) * 1.25 * resistance * 3 + resistance * crossed.thickness ** 2 / 24;
    if (damage < 1) return { hit: null, impacts, end: trace.endPos };
    impacts.push({ point: crossed.exit, normal: crossed.normal });
    travelled += reach + crossed.thickness;
    start = crossed.exit;
  }
}

/**
 * Damages a fighter ({ health, armor, helmet }) hit in `group` by `damage`
 * (after range and walls) of a weapon with `stats`; returns the health it lost.
 */
export function applyDamage(fighter, stats, group, baseDamage) {
  const rule = HIT_GROUPS[group];
  let damage = baseDamage * (rule.multiplier ?? stats.headshotMultiplier ?? 4);
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

const KNIFE = { armorRatio: 1.7, headshotMultiplier: 1 };

/**
 * A knife swing, light or `heavy`, against `boxes`: { group, damage, stats }
 * ready for applyDamage, and the distance it reached, or null. Knives count
 * a head hit as a chest hit.
 */
export function knifeHit(origin, direction, stats, heavy, boxes) {
  const hit = traceHitboxes(origin, direction, heavy ? stats.range2 : stats.range, boxes);
  if (!hit) return null;
  return { group: hit.group === 'head' ? 'chest' : hit.group, damage: heavy ? stats.damage2 : stats.damage, stats: KNIFE, distance: hit.distance };
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
