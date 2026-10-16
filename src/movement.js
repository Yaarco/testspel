/**
 * Classic player movement: ground friction and acceleration, air
 * acceleration with the wishspeed cap that makes strafing gain speed, jumps,
 * ducking, and sliding along surfaces.
 * Runs once per tick with a fixed frame time, exactly like the server does.
 *
 * Surfing needs no special code. A ramp steeper than PLAYER.minGroundNormalZ
 * is never ground, so the player stays in AirMove: air strafing pushes into
 * the ramp while TryPlayerMove clips velocity along its surface.
 */
import { CONVARS, PLAYER } from './config.js';
import { traceHull, hullFits } from './collision.js';
import { add, cross, dot, normalize, scale, sub, toRadians } from './vector.js';

const FRAME_TIME = 1 / CONVARS.tickrate;
const DUCK_ORIGIN_SHIFT = PLAYER.standHeight - PLAYER.duckHeight;
const MAX_BUMPS = 4;
const MAX_CLIP_PLANES = 5;

/** Runs one tick of movement for a user command against a SolidGrid. */
export function playerMove(player, cmd, collision) {
  duck(player, cmd, collision);
  const wish = wishMove(player, cmd);
  fullWalkMove(player, cmd, wish, collision);
  updateViewOffset(player);
}

function fullWalkMove(player, cmd, wish, collision) {
  startGravity(player);

  if (cmd.jump) checkJumpButton(player);
  else player.jumpHeld = false;

  // Friction runs only if we are still on the ground after the jump check.
  // A jump on the landing tick therefore loses no speed: that is bhop.
  if (player.ground) {
    player.vel.z = 0;
    friction(player);
  }

  checkVelocity(player);

  if (player.ground) walkMove(player, wish, collision);
  else airMove(player, wish, collision);

  categorizePosition(player, collision);
  finishGravity(player);
  if (player.ground) player.vel.z = 0;
}

/**
 * Turns key input into a horizontal wish direction and speed.
 * CheckParameters clamps input to max speed; the duck and walk crops then
 * apply only on the ground (HandleDuckingSpeedCrop).
 */
function wishMove(player, cmd) {
  let forward = cmd.forwardmove;
  let side = cmd.sidemove;

  const maxSpeed = player.maxSpeed;
  const inputSpeed = Math.hypot(forward, side);
  if (inputSpeed > maxSpeed) {
    forward *= maxSpeed / inputSpeed;
    side *= maxSpeed / inputSpeed;
  }

  if (player.ground) {
    const crop = player.ducked ? PLAYER.duckModifier : cmd.walk ? PLAYER.walkModifier : 1;
    forward *= crop;
    side *= crop;
  }

  // Forward and right vectors flattened onto the ground plane (the view's forward and right vectors).
  const yaw = toRadians(player.yaw);
  const x = Math.cos(yaw) * forward + Math.sin(yaw) * side;
  const y = Math.sin(yaw) * forward - Math.cos(yaw) * side;
  const speed = Math.hypot(x, y);

  return {
    x: speed > 0 ? x / speed : 0,
    y: speed > 0 ? y / speed : 0,
    speed: Math.min(speed, maxSpeed),
  };
}

function checkJumpButton(player) {
  // Holding jump in the air marks it as held, so it must be re-pressed to hop again.
  if (!player.ground) {
    player.jumpHeld = true;
    return;
  }
  if (player.jumpHeld && !CONVARS.sv_autobunnyhopping) return;

  if (!CONVARS.sv_enablebunnyhopping) preventBunnyJumping(player);

  player.ground = null;
  player.vel.z = PLAYER.jumpImpulse;
  finishGravity(player);
  player.jumpHeld = true;
}

/** Only active when sv_enablebunnyhopping is off: caps speed at 1.1x max speed on jump. */
function preventBunnyJumping(player) {
  const cap = 1.1 * player.maxSpeed;
  const speed = Math.hypot(player.vel.x, player.vel.y, player.vel.z);
  if (speed <= cap) return;
  const fraction = cap / speed;
  player.vel.x *= fraction;
  player.vel.y *= fraction;
  player.vel.z *= fraction;
}

function friction(player) {
  const vel = player.vel;
  const speed = Math.hypot(vel.x, vel.y, vel.z);
  if (speed < 0.1) return;

  const control = Math.max(speed, CONVARS.sv_stopspeed);
  const drop = control * CONVARS.sv_friction * FRAME_TIME;
  const newSpeed = Math.max(speed - drop, 0);
  const fraction = newSpeed / speed;

  vel.x *= fraction;
  vel.y *= fraction;
  vel.z *= fraction;
}

function accelerate(vel, wish, accel) {
  const currentSpeed = vel.x * wish.x + vel.y * wish.y;
  const addSpeed = wish.speed - currentSpeed;
  if (addSpeed <= 0) return;

  const accelSpeed = Math.min(accel * FRAME_TIME * wish.speed, addSpeed);
  vel.x += accelSpeed * wish.x;
  vel.y += accelSpeed * wish.y;
}

/**
 * The heart of air strafing. The speed added along the wish direction is
 * capped at sv_air_max_wishspeed (30), but the acceleration itself scales with
 * the full wish speed. Turning the mouse keeps the wish direction nearly
 * perpendicular to velocity, so every tick adds a little speed.
 */
function airAccelerate(vel, wish, accel) {
  const cappedWishSpeed = Math.min(wish.speed, CONVARS.sv_air_max_wishspeed);
  const currentSpeed = vel.x * wish.x + vel.y * wish.y;
  const addSpeed = cappedWishSpeed - currentSpeed;
  if (addSpeed <= 0) return;

  const accelSpeed = Math.min(accel * wish.speed * FRAME_TIME, addSpeed);
  vel.x += accelSpeed * wish.x;
  vel.y += accelSpeed * wish.y;
}

function walkMove(player, wish, collision) {
  const vel = player.vel;
  vel.z = 0;
  accelerate(vel, wish, CONVARS.sv_accelerate);
  vel.z = 0;

  if (Math.hypot(vel.x, vel.y) < 1) {
    vel.x = 0;
    vel.y = 0;
    return;
  }
  tryPlayerMove(player, collision);
}

function airMove(player, wish, collision) {
  airAccelerate(player.vel, wish, CONVARS.sv_airaccelerate);
  tryPlayerMove(player, collision);
}

/** Removes the part of a velocity that goes into a plane. */
function clipVelocity(velocity, normal, overbounce) {
  const out = sub(velocity, scale(normal, dot(velocity, normal) * overbounce));
  // Make sure we are not still moving through the plane.
  const adjust = dot(out, normal);
  return adjust < 0 ? sub(out, scale(normal, adjust)) : out;
}

/**
 * Moves along the velocity, sliding along every surface hit, up to MAX_BUMPS
 * times per tick. When two planes form a crease the velocity follows the crease.
 */
function tryPlayerMove(player, collision) {
  const height = player.hullHeight;
  const primalVelocity = { ...player.vel };
  let originalVelocity = { ...player.vel };
  const planes = [];
  let timeLeft = FRAME_TIME;
  let allFraction = 0;

  for (let bump = 0; bump < MAX_BUMPS; bump++) {
    if (player.vel.x === 0 && player.vel.y === 0 && player.vel.z === 0) break;

    const end = add(player.pos, scale(player.vel, timeLeft));
    const trace = traceHull(player.pos, end, height, collision);
    allFraction += trace.fraction;

    if (trace.fraction > 0) {
      player.pos = trace.endPos;
      originalVelocity = { ...player.vel };
      planes.length = 0;
    }
    if (trace.fraction === 1) break;

    timeLeft -= timeLeft * trace.fraction;
    if (planes.length >= MAX_CLIP_PLANES) {
      player.vel = { x: 0, y: 0, z: 0 };
      break;
    }

    // Hitting the same plane again is float noise on a sloped surface. Nudge
    // out along it (the Quake 3 slide move fix) instead of treating it as a crease.
    if (planes.some((plane) => dot(plane, trace.normal) > 0.99)) {
      player.vel = add(player.vel, trace.normal);
      continue;
    }
    planes.push(trace.normal);

    // In the air, the first plane hit simply clips the velocity.
    if (planes.length === 1 && !player.ground) {
      player.vel = clipVelocity(originalVelocity, planes[0], 1);
      originalVelocity = { ...player.vel };
      continue;
    }

    // Find a clip that does not push into any other plane we touch.
    const slide = planes
      .map((plane) => clipVelocity(originalVelocity, plane, 1))
      .find((clipped, i) => planes.every((other, j) => j === i || dot(clipped, other) >= 0));

    if (slide) {
      player.vel = slide;
    } else if (planes.length === 2) {
      const crease = normalize(cross(planes[0], planes[1]));
      player.vel = scale(crease, dot(crease, player.vel));
    } else {
      player.vel = { x: 0, y: 0, z: 0 };
      break;
    }

    // Stop dead rather than bounce back the way we came.
    if (dot(player.vel, primalVelocity) <= 0) {
      player.vel = { x: 0, y: 0, z: 0 };
      break;
    }
  }

  if (allFraction === 0) player.vel = { x: 0, y: 0, z: 0 };
}

/** Traces 2 units down. Only surfaces flatter than minGroundNormalZ count as ground. */
function categorizePosition(player, collision) {
  if (player.vel.z > PLAYER.nonJumpVelocity) {
    player.ground = null;
    return;
  }
  const below = { ...player.pos, z: player.pos.z - PLAYER.groundTraceDistance };
  const trace = traceHull(player.pos, below, player.hullHeight, collision);
  const standable = trace.solid && trace.normal.z >= PLAYER.minGroundNormalZ;

  player.ground = standable ? trace.solid : null;
  player.groundPlane = standable ? trace.plane : -1;   // which side of the solid, for footstep sounds
  if (standable) player.pos = trace.endPos;
}

function startGravity(player) {
  player.vel.z -= CONVARS.sv_gravity * 0.5 * FRAME_TIME;
}

function finishGravity(player) {
  player.vel.z -= CONVARS.sv_gravity * 0.5 * FRAME_TIME;
}

function checkVelocity(player) {
  for (const axis of ['x', 'y', 'z']) {
    player.vel[axis] = Math.max(-CONVARS.sv_maxvelocity, Math.min(player.vel[axis], CONVARS.sv_maxvelocity));
  }
}

/**
 * Ducking shrinks the hull from 72 to 54 units. In the air the feet are pulled
 * up instead of the head coming down, which is what makes crouch jumps reach
 * higher. The view offset absorbs the shift so the camera does not snap.
 */
function duck(player, cmd, collision) {
  if (cmd.duck && !player.ducked) {
    const raised = { ...player.pos, z: player.pos.z + DUCK_ORIGIN_SHIFT };
    if (!player.ground && hullFits(raised, PLAYER.duckHeight, collision)) shiftOrigin(player, DUCK_ORIGIN_SHIFT);
    player.ducked = true;
    return;
  }

  if (!cmd.duck && player.ducked) {
    const shift = player.ground ? 0 : -DUCK_ORIGIN_SHIFT;
    const standing = { ...player.pos, z: player.pos.z + shift };
    if (!hullFits(standing, PLAYER.standHeight, collision)) return;
    shiftOrigin(player, shift);
    player.ducked = false;
  }
}

function shiftOrigin(player, shift) {
  player.pos.z += shift;
  player.viewOffset -= shift;
}

function updateViewOffset(player) {
  const target = player.ducked ? PLAYER.duckEyeHeight : PLAYER.standEyeHeight;
  const step = PLAYER.viewOffsetSpeed * FRAME_TIME;
  const delta = target - player.viewOffset;
  player.viewOffset += Math.sign(delta) * Math.min(Math.abs(delta), step);
}
