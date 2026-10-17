/**
 * All tunables in one place.
 * Movement values mirror classic server convars (names kept identical),
 * set up the way a typical bhop server runs: bunnyhopping enabled,
 * stamina disabled, no auto hop, raised air acceleration.
 * Units are map units (1 unit is about 1 inch) and seconds.
 */
export const CONVARS = {
  tickrate: 128,                // community bhop servers run 128 tick (matchmaking is 64)
  sv_gravity: 800,
  sv_friction: 5.2,
  sv_stopspeed: 80,
  sv_accelerate: 5.5,
  sv_airaccelerate: 100,        // stock is 12, bhop servers use 100 or more
  sv_air_max_wishspeed: 30,     // the air strafe cap that makes bhop gain possible
  sv_maxvelocity: 3500,
  sv_enablebunnyhopping: true,  // false caps speed at 1.1 x max speed on every jump
  sv_autobunnyhopping: false,   // true: holding jump hops on every landing. Toggled from the menu
  cl_forwardspeed: 450,
  cl_sidespeed: 450,
};

export const PLAYER = {
  maxSpeed: 250,                // knife out; other weapons set their own (weapons.js)
  walkModifier: 0.52,           // +speed (Shift)
  duckModifier: 0.34,           // +duck (Ctrl) on the ground
  jumpImpulse: Math.sqrt(2 * 800 * 57), // 301.993 u/s, a 57 unit jump
  accelerationScale: 250,       // ground acceleration scales with at least this speed (CS:GO)
  stepSize: 18,                 // sv_stepsize: ledges this high are walked up
  nonJumpVelocity: 140,         // moving up faster than this means not on ground
  minGroundNormalZ: 0.7,        // steeper surfaces are not ground: that is what makes surf ramps
  groundTraceDistance: 2,
  hullHalfWidth: 16,            // 32 x 32 hull
  standHeight: 72,
  duckHeight: 54,
  standEyeHeight: 64,
  duckEyeHeight: 46,
  viewOffsetSpeed: 120,         // how fast the eye slides when ducking, u/s
  taggedSpeed: 0.5,             // a hit slows you to this share of max speed (tagging)...
  tagRecovery: 0.4,             // ...and you win back this share per second
};

export const MOUSE = {
  defaultSensitivity: 2,
  m_yaw: 0.022,                 // degrees per mouse count, times sensitivity
  m_pitch: 0.022,
  maxPitch: 89,
  minSensitivity: 0.1,
  maxSensitivity: 10,
  maxEventDelta: 400,           // counts per mousemove event above this are treated as glitches
};

export const VIEW = {
  // fov 90 is horizontal at 4:3, so half the vertical fov has tan 0.75.
  verticalHalfFovTan: 0.75,
  nearPlane: 1,
  farPlane: 100000,             // no depth buffer is used, so a far plane costs nothing
  skyRadius: 1000,              // the sky is drawn on a sphere this size around the camera
  viewDistance: 12000,
  maxPixelRatio: 2,
};

export const COURSE = {
  spawnHalfSize: 160,
  platformsAhead: 40,
  platformsBehind: 6,
  rampPlatforms: 60,            // platforms until full difficulty
  gap: { easy: 60, hard: 150 },
  gapJitter: 50,
  halfSize: { easy: 110, hard: 56 },
  rise: { min: -64, max: 32 },
  headingJitter: 0.7,
  headingPull: 0.8,             // pulls the course back toward a straight line
  killDepth: 1000,              // the death border sits at least this far below any surface near you
  killSearchRadius: 2500,       // surfaces this close horizontally count as still reachable
  bhopSection: { min: 6, max: 12 }, // platforms between surf ramps
};

export const SURF = {
  rampHeight: 480,
  slopeDegrees: 60,             // normal z of 0.5, well under PLAYER.minGroundNormalZ
  length: { min: 2400, max: 4000 },
  descent: 0.12,                // the ridge drops this much per unit of length
  dropToPeak: 80,               // ridge start sits this far below the launch pad
  overlap: 32,                  // ramp starts this far under the launch pad's front edge
  exitGap: 250,
  exitHalfLength: 600,
  exitHalfWidth: 280,
  exitDrop: 120,                // exit pad sits this far below the ramp's base
};
