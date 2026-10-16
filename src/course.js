/**
 * Procedurally generated course: runs of bhop platforms broken up by surf ramps.
 * Every solid gets an increasing index; platforms double as checkpoints.
 * Solids are generated ahead of the player and dropped behind them.
 *
 * A course is one kind of world. Worlds share this interface with BspWorld:
 * name, collision, faces, version, viewDistance, highlightIndex, score,
 * respawnPoint() and afterMove(player).
 */
import { COURSE, SURF, VIEW } from './config.js';
import { SolidGrid } from './collision.js';
import { createRng } from './random.js';
import { createOrientedBox, createRamp, reachAlong } from './solids.js';
import { toDegrees } from './vector.js';

const SHAPES = {
  pad: { depth: () => 16 },
  cube: { depth: (halfSize) => halfSize * 2 },
  pillar: { depth: (halfSize, rng) => rng.range(600, 1600) },
};
const BHOP_SHAPES = Object.keys(SHAPES);

const lerp = (a, b, t) => a + (b - a) * t;

function horizontalDistanceToBounds(point, solid) {
  const dx = Math.max(solid.min.x - point.x, 0, point.x - solid.max.x);
  const dy = Math.max(solid.min.y - point.y, 0, point.y - solid.max.y);
  return Math.hypot(dx, dy);
}

function createPlatform(index, top, heading, halfLength, halfWidth, depth, hue) {
  return createOrientedBox(
    { top, heading, halfLength, halfWidth, depth },
    { index, hue, kind: 'platform', approach: heading, floorZ: top.z },
  );
}

export class Course {
  constructor(seed) {
    this.rng = createRng(seed);
    this.heading = 0;
    this.version = 0;       // bumps whenever solids change, so meshes know to rebuild
    this.progress = 0;      // index of the furthest solid the player has been near
    this.bhopRemaining = COURSE.bhopSection.min;
    const half = COURSE.spawnHalfSize;
    this.solids = [createPlatform(0, { x: 0, y: 0, z: 0 }, 0, half, half, 64, 190)];
    this.checkpoint = this.solids[0];
    this.extendTo(COURSE.platformsAhead);

    this.name = 'Procedural course';
    this.kind = 'course';
    this.viewDistance = VIEW.viewDistance;
    this.cache = { version: -1 };
  }

  get spawn() {
    return this.solids[0];
  }

  get highlightIndex() {
    return this.checkpoint.index + 1;
  }

  get score() {
    return this.checkpoint.index;
  }

  /** Collision grid and render faces, rebuilt only when the solids change. */
  get collision() {
    return this.cached().collision;
  }

  get faces() {
    return this.cached().faces;
  }

  cached() {
    if (this.cache.version !== this.version) {
      this.cache = {
        version: this.version,
        collision: new SolidGrid(this.solids),
        faces: this.solids.flatMap((solid) => solid.faces.map((vertices, f) => ({
          vertices, normal: solid.faceNormals[f], hue: solid.hue, index: solid.index, line: 1,
        }))),
      };
    }
    return this.cache;
  }

  /** The glowing platforms sound like glass underfoot. */
  surfaceAt() {
    return 'glass';
  }

  /** The last platform landed on, facing along the course. */
  respawnPoint() {
    const next = this.solidAfter(this.checkpoint);
    return { feet: this.checkpoint.top, yaw: toDegrees(next.approach) };
  }

  /** Tracks checkpoints, keeps the course generated ahead, and reports deaths. */
  afterMove(player) {
    const ground = player.ground;
    if (ground && ground.kind === 'platform' && ground.index > this.checkpoint.index) {
      this.checkpoint = ground;
    }
    this.followPlayer(player.pos, this.checkpoint.index);
    return player.pos.z < this.killHeightAt(player.pos, this.checkpoint) ? { respawn: true } : null;
  }

  solidAfter(solid) {
    return this.solids.find((candidate) => candidate.index === solid.index + 1);
  }

  /**
   * Height below which the player dies. The course slopes down, so the border
   * follows the player: it sits killDepth under the lowest surface they could
   * still reach, meaning any solid ahead of the checkpoint that is close
   * horizontally, plus the next few solids in line.
   */
  killHeightAt(position, checkpoint) {
    const reachable = this.solids.filter((s) => s.index >= checkpoint.index && (
      s.index <= checkpoint.index + 2 ||
      horizontalDistanceToBounds(position, s) < COURSE.killSearchRadius));
    return Math.min(...reachable.map((s) => s.floorZ)) - COURSE.killDepth;
  }

  /**
   * Generates ahead of wherever the player is, landed or not, so fast surfing
   * or long jumps never outrun the course. Progress is the solid closest to
   * the player horizontally. Solids behind both progress and checkpoint are dropped.
   */
  followPlayer(position, checkpointIndex) {
    const nearest = this.nearestSolid(position, checkpointIndex);
    if (nearest.index <= this.progress) return;

    this.progress = nearest.index;
    this.extendTo(this.progress + COURSE.platformsAhead);
    const keepFrom = Math.min(this.progress, checkpointIndex) - COURSE.platformsBehind;
    this.solids = this.solids.filter((s) => s.index >= keepFrom);
    this.version++;
  }

  nearestSolid(position, fromIndex) {
    let nearest = null;
    let nearestDistance = Infinity;
    for (const solid of this.solids) {
      if (solid.index < fromIndex) continue;
      const distance = horizontalDistanceToBounds(position, solid);
      // On ties (standing inside several bounds) the furthest along wins.
      if (distance <= nearestDistance) {
        nearest = solid;
        nearestDistance = distance;
      }
    }
    return nearest;
  }

  extendTo(lastIndex) {
    while (this.solids[this.solids.length - 1].index < lastIndex) {
      this.solids.push(...this.nextSection(this.solids[this.solids.length - 1]));
    }
  }

  nextSection(previous) {
    if (this.bhopRemaining > 0) {
      this.bhopRemaining--;
      return [this.nextBhopPlatform(previous, this.rng.pick(BHOP_SHAPES))];
    }
    this.bhopRemaining = Math.round(this.rng.range(COURSE.bhopSection.min, COURSE.bhopSection.max));
    return this.surfSection(previous);
  }

  nextBhopPlatform(previous, shapeName) {
    const rng = this.rng;
    const index = previous.index + 1;
    const difficulty = Math.min(index / COURSE.rampPlatforms, 1);

    this.heading = this.heading * COURSE.headingPull + rng.range(-COURSE.headingJitter, COURSE.headingJitter);
    const direction = { x: Math.cos(this.heading), y: Math.sin(this.heading) };

    const halfSize = lerp(COURSE.halfSize.easy, COURSE.halfSize.hard, difficulty) * rng.range(0.85, 1.15);
    const rise = rng.range(COURSE.rise.min, COURSE.rise.max);
    // Jumping up shortens air time, so upward gaps are made shorter.
    const gap = lerp(COURSE.gap.easy, COURSE.gap.hard, difficulty)
      + rng.range(0, COURSE.gapJitter)
      - Math.max(rise, 0) * 1.5;

    const distance = reachAlong(previous, direction) + gap + halfSize;
    const top = {
      x: previous.top.x + direction.x * distance,
      y: previous.top.y + direction.y * distance,
      z: previous.top.z + rise,
    };
    const depth = SHAPES[shapeName].depth(halfSize, rng);
    const hue = (190 + index * 23 + rng.range(-15, 15)) % 360;
    return createPlatform(index, top, this.heading, halfSize, halfSize, depth, hue);
  }

  /**
   * A launch pad, a ramp beneath its front edge, and a long exit pad.
   * The ramp's ridge is offset sideways so the player drops onto the middle
   * of one sloped face instead of onto the ridge.
   */
  surfSection(previous) {
    const rng = this.rng;
    const launch = this.nextBhopPlatform(previous, 'pad');
    const heading = this.heading;
    const forward = { x: Math.cos(heading), y: Math.sin(heading), z: 0 };
    const left = { x: -forward.y, y: forward.x, z: 0 };
    const sideSign = rng.pick([-1, 1]);

    const height = SURF.rampHeight;
    const halfWidth = height / Math.tan(SURF.slopeDegrees * Math.PI / 180);
    const length = rng.range(SURF.length.min, SURF.length.max);
    const ridgeOffset = sideSign * halfWidth / 2;   // the player's line runs down the face's middle

    const startAlong = launch.halfLength - SURF.overlap;
    const start = {
      x: launch.top.x + forward.x * startAlong + left.x * ridgeOffset,
      y: launch.top.y + forward.y * startAlong + left.y * ridgeOffset,
      z: launch.top.z - SURF.dropToPeak,
    };
    const end = {
      x: start.x + forward.x * length,
      y: start.y + forward.y * length,
      z: start.z - length * SURF.descent,
    };
    const hue = (launch.hue + 120) % 360;
    const ramp = createRamp(
      { start, end, halfWidth, height },
      { index: launch.index + 1, hue, kind: 'ramp', approach: heading, floorZ: end.z - height },
    );

    const exitAlong = SURF.exitGap + SURF.exitHalfLength;
    const exitTop = {
      x: end.x - left.x * ridgeOffset + forward.x * exitAlong,
      y: end.y - left.y * ridgeOffset + forward.y * exitAlong,
      z: end.z - height - SURF.exitDrop,
    };
    const exit = createPlatform(
      launch.index + 2, exitTop, heading, SURF.exitHalfLength, SURF.exitHalfWidth, 32, launch.hue,
    );
    return [launch, ramp, exit];
  }
}
