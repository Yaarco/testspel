/**
 * Ragdolls: a fighter who dies goes limp from the pose they died in and
 * falls under gravity, knocked along by the killing hit, and comes to rest
 * on whatever is below.
 *
 * The body is a set of joint particles (pelvis, chest, neck, head, shoulders,
 * elbows, hands, hips, knees, ankles, toes) moved by Verlet integration,
 * held together by distance constraints with a few cross braces, and kept
 * from folding through itself by minimum distances across elbows, knees and
 * the spine. Each joint is a small box swept against the world.
 *
 * The skeleton follows the particles in body parts (pelvis, chest, head,
 * upper and lower arms and legs, feet): each part's frame is built from
 * three of its particles, and every bone of the part moves rigidly with
 * that frame from where it was at death.
 */
import { traceBox } from './collision.js';
import { multiply } from './skeleton.js';

const GRAVITY = 800;
const STEP = 1 / 120;
const ITERATIONS = 8;
const MAX_STEPS_PER_FRAME = 8;
const REST_TIME = 6;            // seconds before the body is left as it lies
const HEAD_LENGTH = 8;          // units from the head bone to the top of the head
const IMPULSE = 320;            // units per second given to the joint nearest the killing hit
const MAX_LIFT = 12;            // units the body may be raised at the start to clear the floor
const FRICTION = 0.6;           // share of sliding speed kept on touching a surface

const JOINT_BONES = {
  pelvis: 'pelvis', chest: 'spine_2', neck: 'neck_0', head: 'head_0',
  shoulderL: 'arm_upper_L', elbowL: 'arm_lower_L', handL: 'hand_L',
  shoulderR: 'arm_upper_R', elbowR: 'arm_lower_R', handR: 'hand_R',
  hipL: 'leg_upper_L', kneeL: 'leg_lower_L', ankleL: 'ankle_L', toeL: 'ball_L',
  hipR: 'leg_upper_R', kneeR: 'leg_lower_R', ankleR: 'ankle_R', toeR: 'ball_R',
};
const RADIUS = { pelvis: 5, chest: 6, neck: 3, head: 4, headTop: 4 };
const DEFAULT_RADIUS = 2.5;
const STICKS = [
  ['pelvis', 'chest'], ['chest', 'neck'], ['neck', 'head'], ['head', 'headTop'], ['neck', 'headTop'],
  ['chest', 'shoulderL'], ['chest', 'shoulderR'], ['neck', 'shoulderL'], ['neck', 'shoulderR'], ['shoulderL', 'shoulderR'],
  ['shoulderL', 'elbowL'], ['elbowL', 'handL'], ['shoulderR', 'elbowR'], ['elbowR', 'handR'],
  ['pelvis', 'hipL'], ['pelvis', 'hipR'], ['hipL', 'hipR'], ['chest', 'hipL'], ['chest', 'hipR'],
  ['shoulderL', 'hipL'], ['shoulderR', 'hipR'], ['shoulderL', 'hipR'], ['shoulderR', 'hipL'],
  ['hipL', 'kneeL'], ['kneeL', 'ankleL'], ['ankleL', 'toeL'], ['kneeL', 'toeL'],
  ['hipR', 'kneeR'], ['kneeR', 'ankleR'], ['ankleR', 'toeR'], ['kneeR', 'toeR'],
];
// [a, b, share]: a and b stay at least `share` of their straightened length apart.
const LIMITS = [
  ['shoulderL', 'handL', 0.35], ['shoulderR', 'handR', 0.35],
  ['hipL', 'ankleL', 0.55], ['hipR', 'ankleR', 0.55],
  ['pelvis', 'neck', 0.85], ['chest', 'headTop', 0.85], ['pelvis', 'headTop', 0.8],
];
// Body parts: [first bone, origin, aim, side]. Each bone follows the part of its nearest listed ancestor.
const PARTS = [
  ['pelvis', 'pelvis', 'chest', 'hipL'],
  ['spine_2', 'chest', 'neck', 'shoulderL'],
  ['neck_0', 'neck', 'headTop', 'shoulderL'],
  ['arm_upper_L', 'shoulderL', 'elbowL', 'handL'], ['arm_lower_L', 'elbowL', 'handL', 'shoulderL'],
  ['arm_upper_R', 'shoulderR', 'elbowR', 'handR'], ['arm_lower_R', 'elbowR', 'handR', 'shoulderR'],
  ['leg_upper_L', 'hipL', 'kneeL', 'ankleL'], ['leg_lower_L', 'kneeL', 'ankleL', 'hipL'], ['ankle_L', 'ankleL', 'toeL', 'kneeL'],
  ['leg_upper_R', 'hipR', 'kneeR', 'ankleR'], ['leg_lower_R', 'kneeR', 'ankleR', 'hipR'], ['ankle_R', 'ankleR', 'toeR', 'kneeR'],
];

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const length = (a) => Math.hypot(a[0], a[1], a[2]);
const scaled = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a) => scaled(a, 1 / (length(a) || 1));
const toPoint = ([x, y, z]) => ({ x, y, z });

/** Inverse of a rotation-and-uniform-scale plus translation matrix. */
function invertScaledRigid(m) {
  const k2 = m[0] * m[0] + m[1] * m[1] + m[2] * m[2];
  const t = [m[12], m[13], m[14]];
  const r = (row) => [m[row * 4] / k2, m[row * 4 + 1] / k2, m[row * 4 + 2] / k2];   // a row of the inverse rotation
  const [r0, r1, r2] = [r(0), r(1), r(2)];
  return [r0[0], r1[0], r2[0], 0, r0[1], r1[1], r2[1], 0, r0[2], r1[2], r2[2], 0, -dot(r0, t), -dot(r1, t), -dot(r2, t), 1];
}

/** An orthonormal frame (columns: along the part, toward its side, and their cross). */
function frame(origin, aim, side, fallback) {
  const along = unit(sub(aim, origin));
  let toward = sub(side, origin);
  toward = sub(toward, scaled(along, dot(toward, along)));
  if (length(toward) < 1e-3) toward = sub(fallback, scaled(along, dot(fallback, along)));
  toward = unit(toward);
  return [along, toward, cross(along, toward)];
}

export class Ragdoll {
  /**
   * `body` is the agent model, `pose` its { matrix, world } as it died,
   * `velocity` how it was moving, `hit` the killing { point, direction } or
   * null, and `collision` the world.
   */
  constructor(body, pose, velocity, hit, collision) {
    this.body = body;
    this.matrix = pose.matrix;
    this.inverse = invertScaledRigid(pose.matrix);
    this.startWorld = pose.world;
    const placed = pose.world.map((world) => multiply(pose.matrix, world));
    const at = (bone) => {
      const index = body.nodes.findIndex((node) => node.name === bone);
      return index >= 0 ? [placed[index][12], placed[index][13], placed[index][14]] : null;
    };
    this.joints = {};
    for (const [joint, bone] of Object.entries(JOINT_BONES)) this.joints[joint] = at(bone);
    this.valid = Object.values(this.joints).every(Boolean);
    if (!this.valid) return;   // not the usual skeleton: no ragdoll
    const { head, neck } = this.joints;
    this.joints.headTop = [...sub(head, scaled(unit(sub(neck, head)), HEAD_LENGTH))];

    const names = Object.keys(this.joints);
    this.particles = names.map((name) => {
      const pos = this.joints[name];
      return { name, pos: [...pos], prev: sub(pos, scaled([velocity.x, velocity.y, velocity.z], STEP)), radius: RADIUS[name] ?? DEFAULT_RADIUS };
    });
    this.byName = Object.fromEntries(this.particles.map((p) => [p.name, p]));
    this.lift(collision);
    if (hit) this.knock(hit);
    const rest = (a, b) => length(sub(this.byName[a].pos, this.byName[b].pos));
    this.sticks = STICKS.map(([a, b]) => [this.byName[a], this.byName[b], rest(a, b)]);
    const straight = (a, b) => {
      const chain = { handL: ['shoulderL', 'elbowL', 'handL'], handR: ['shoulderR', 'elbowR', 'handR'], ankleL: ['hipL', 'kneeL', 'ankleL'], ankleR: ['hipR', 'kneeR', 'ankleR'] }[b];
      return chain ? rest(chain[0], chain[1]) + rest(chain[1], chain[2]) : rest(a, b);
    };
    this.limits = LIMITS.map(([a, b, share]) => [this.byName[a], this.byName[b], straight(a, b) * share]);

    // Each bone's part, and each part's frame at death.
    const partOf = new Map(PARTS.map((part, i) => [part[0], i]));
    this.boneParts = body.nodes.map((node, i) => {
      for (let n = i; n >= 0; n = body.nodes[n].parent) {
        if (partOf.has(body.nodes[n].name)) return partOf.get(body.nodes[n].name);
      }
      return 0;
    });
    this.startFrames = PARTS.map((part) => this.partFrame(part));
    this.pelvisNode = body.nodes.findIndex((node) => node.name === 'pelvis');
    this.time = 0;
    this.accumulator = 0;
  }

  /** Raises the body just enough that no joint starts inside the floor (feet stand closer to it than a joint's size). */
  lift(collision) {
    let raise = 0;
    for (const p of this.particles) {
      const above = toPoint([p.pos[0], p.pos[1], p.pos[2] + MAX_LIFT]);
      const settled = traceBox(above, toPoint(p.pos), p.radius, collision);
      if (settled.fraction < 1) raise = Math.max(raise, settled.endPos.z - p.pos[2]);
    }
    for (const p of this.particles) {
      p.pos[2] += raise;
      p.prev[2] += raise;
    }
  }

  /** The joint nearest the killing hit is knocked along it, its neighbours less. */
  knock({ point, direction }) {
    const p = [point.x, point.y, point.z];
    const nearest = this.particles.reduce((best, particle) => (length(sub(particle.pos, p)) < length(sub(best.pos, p)) ? particle : best));
    for (const particle of this.particles) {
      const near = length(sub(particle.pos, nearest.pos));
      const share = particle === nearest ? 1 : near < 16 ? 0.5 : 0.1;
      const push = scaled([direction.x, direction.y, direction.z], IMPULSE * share * STEP);
      particle.prev = sub(particle.prev, push);
    }
  }

  partFrame([, origin, aim, side]) {
    const { pelvis, chest, hipL, hipR } = this.byName;
    const fallback = sub(hipL.pos, hipR.pos);
    const axes = frame(this.byName[origin].pos, this.byName[aim].pos, this.byName[side].pos, length(fallback) ? fallback : sub(chest.pos, pelvis.pos));
    return { origin: this.byName[origin].pos.slice(), axes };
  }

  /** Advances the simulation by `dt` seconds against the world's `collision`. */
  update(dt, collision) {
    if (!this.valid || this.time > REST_TIME) return;
    this.accumulator = Math.min(this.accumulator + dt, MAX_STEPS_PER_FRAME * STEP);
    while (this.accumulator >= STEP) {
      this.accumulator -= STEP;
      this.time += STEP;
      this.step(collision);
    }
  }

  step(collision) {
    for (const p of this.particles) {
      const velocity = sub(p.pos, p.prev);
      p.prev = p.pos;
      p.pos = [p.pos[0] + velocity[0], p.pos[1] + velocity[1], p.pos[2] + velocity[2] - GRAVITY * STEP * STEP];
    }
    for (let i = 0; i < ITERATIONS; i++) {
      for (const [a, b, rest] of this.sticks) this.hold(a, b, rest, false);
      for (const [a, b, least] of this.limits) this.hold(a, b, least, true);
    }
    for (const p of this.particles) this.collide(p, collision);
  }

  /** Moves two particles to `distance` apart (or only apart, for a minimum). */
  hold(a, b, distance, minimum) {
    const delta = sub(b.pos, a.pos);
    const current = length(delta) || 1e-6;
    if (minimum && current >= distance) return;
    const shift = scaled(delta, (current - distance) / current / 2);
    a.pos = [a.pos[0] + shift[0], a.pos[1] + shift[1], a.pos[2] + shift[2]];
    b.pos = sub(b.pos, shift);
  }

  /** Sweeps a particle from its last position to its new one; on touching a surface it stops there and slides with friction. */
  collide(p, collision) {
    const trace = traceBox(toPoint(p.prev), toPoint(p.pos), p.radius, collision);
    if (trace.fraction >= 1) return;
    const n = [trace.normal.x, trace.normal.y, trace.normal.z];
    const hit = [trace.endPos.x, trace.endPos.y, trace.endPos.z];
    const moved = sub(p.pos, p.prev);
    const slide = scaled(sub(moved, scaled(n, dot(moved, n))), FRICTION * (1 - trace.fraction));
    p.pos = [hit[0] + slide[0], hit[1] + slide[1], hit[2] + slide[2]];
    p.prev = sub(p.pos, scaled(slide, 0.5));
  }

  /** The body's pose now: { matrix, world } like a posed character's. */
  pose() {
    const parts = PARTS.map((part, i) => {
      const now = this.partFrame(part);
      const before = this.startFrames[i];
      // Rotation taking the death frame to the current one: now * before^T (axes as columns).
      const r = (row, col) => now.axes[0][row] * before.axes[0][col] + now.axes[1][row] * before.axes[1][col] + now.axes[2][row] * before.axes[2][col];
      const rotation = [r(0, 0), r(1, 0), r(2, 0), 0, r(0, 1), r(1, 1), r(2, 1), 0, r(0, 2), r(1, 2), r(2, 2), 0, 0, 0, 0, 1];
      const turned = [rotation[0], rotation[1], rotation[2]].map((_, row) => rotation[row] * before.origin[0] + rotation[4 + row] * before.origin[1] + rotation[8 + row] * before.origin[2]);
      rotation[12] = now.origin[0] - turned[0];
      rotation[13] = now.origin[1] - turned[1];
      rotation[14] = now.origin[2] - turned[2];
      return multiply(this.inverse, multiply(rotation, this.matrix));
    });
    return { matrix: this.matrix, world: this.startWorld.map((world, i) => multiply(parts[this.boneParts[i]], world)) };
  }
}
