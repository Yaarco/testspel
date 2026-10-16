/**
 * Classic recoil and accuracy, driven by each weapon's data
 * (weapons.vdata: recoil angle, magnitude and their variance, recoil seed,
 * spread and inaccuracy).
 *
 * Every shot adds to the aim punch velocity along the next entry of the
 * weapon's recoil table: a fixed pattern generated once from the weapon's
 * recoil seed, so a spray always climbs the same way. The punch decays back
 * toward zero. Bullets fly along the view angles plus the punch times
 * weapon_recoil_scale; the camera shows only view_recoil_tracking of that,
 * which is why the crosshair stays below where a spray lands.
 */
export const RECOIL_CONVARS = {
  weapon_recoil_scale: 2,
  view_recoil_tracking: 0.45,
  weapon_recoil_decay2_exp: 8,
  weapon_recoil_decay2_lin: 18,
  weapon_recoil_vel_decay: 4.5,
  weapon_recoil_suppression_shots: 4,
  weapon_recoil_suppression_factor: 0.75,
  weapon_recoil_variance: 0.55,
};
const TABLE_SIZE = 64;
const RECOVERY_DECADE = Math.log(10);   // recovery time is how long a penalty takes to fall to a tenth

/** A Park-Miller random stream with a shuffle table, so a seed always gives the same sequence. */
class UniformRandomStream {
  constructor(seed) {
    this.idum = seed < 0 ? seed : -seed;
    this.iy = 0;
    this.iv = new Int32Array(32);
  }

  next() {
    const IA = 16807, IM = 2147483647, IQ = 127773, IR = 2836, NDIV = 1 + Math.floor((IM - 1) / 32);
    const step = () => {
      const k = Math.floor(this.idum / IQ);
      this.idum = IA * (this.idum - k * IQ) - IR * k;
      if (this.idum < 0) this.idum += IM;
    };
    if (this.idum <= 0 || !this.iy) {
      this.idum = Math.max(-this.idum, 1);
      for (let j = 32 + 7; j >= 0; j--) {
        step();
        if (j < 32) this.iv[j] = this.idum;
      }
      this.iy = this.iv[0];
    }
    step();
    const j = Math.floor(this.iy / NDIV);
    this.iy = this.iv[j];
    this.iv[j] = this.idum;
    return this.iy;
  }

  float(low, high) {
    const value = Math.min(this.next() / 2147483647, 1 - 1.2e-7);
    return low + value * (high - low);
  }
}

const lerp = (t, a, b) => a + (b - a) * t;

/** Angle (degrees from straight up, positive to the right) and magnitude of each shot of a spray. */
export function recoilTable({ recoil, fullAuto }) {
  const random = new UniformRandomStream(recoil.seed);
  const c = RECOIL_CONVARS;
  const table = [];
  let angle = 0;
  let magnitude = 0;
  for (let shot = 0; shot < TABLE_SIZE; shot++) {
    const newAngle = recoil.angle + random.float(-recoil.angleVariance, recoil.angleVariance);
    const newMagnitude = recoil.magnitude + random.float(-recoil.magnitudeVariance, recoil.magnitudeVariance);
    if (fullAuto && shot > 0) {
      angle = lerp(c.weapon_recoil_variance, angle, newAngle);
      magnitude = lerp(c.weapon_recoil_variance, magnitude, newMagnitude);
    } else {
      angle = newAngle;
      magnitude = newMagnitude;
    }
    const suppression = fullAuto && shot < c.weapon_recoil_suppression_shots
      ? lerp(shot / c.weapon_recoil_suppression_shots, c.weapon_recoil_suppression_factor, 1)
      : 1;
    table.push({ angle, magnitude: magnitude * suppression });
  }
  return table;
}

/** Aim punch and accuracy of the held gun. Angles are degrees: positive pitch looks down, positive yaw turns left. */
export class Recoil {
  constructor() {
    this.tables = new WeakMap();
    this.reset();
  }

  reset() {
    this.punch = { pitch: 0, yaw: 0 };
    this.velocity = { pitch: 0, yaw: 0 };
    this.index = 0;          // shots into the current spray
    this.penalty = 0;        // inaccuracy added by firing
    this.lastShot = -Infinity;
  }

  table(stats) {
    if (!this.tables.has(stats)) this.tables.set(stats, recoilTable(stats));
    return this.tables.get(stats);
  }

  /** One shot: kicks the punch along the next entry of the pattern. Call before aiming the bullet's spread. */
  shoot(stats, time) {
    const { angle, magnitude } = this.table(stats)[Math.min(Math.floor(this.index), TABLE_SIZE - 1)];
    const radians = angle * Math.PI / 180;
    this.velocity.pitch -= Math.cos(radians) * magnitude;
    this.velocity.yaw -= Math.sin(radians) * magnitude;
    this.index++;
    this.penalty += stats.inaccuracy.fire;
    this.lastShot = time;
  }

  /** Inaccuracy (radians of cone) for the player's stance and speed. */
  inaccuracy(stats, player) {
    const { inaccuracy: values, spread } = stats;
    const base = player.ducked ? values.crouch : values.stand;
    const slow = player.maxSpeed * 0.34;
    const moving = Math.min(Math.max((player.horizontalSpeed - slow) / (player.maxSpeed * 0.95 - slow), 0), 1);
    const air = player.ground ? 0 : values.jump;
    return spread + base + values.move * moving + air + this.penalty;
  }

  /** Per tick: the punch springs back and, once the trigger is released, the spray and accuracy recover. */
  update(stats, ducked, time, dt) {
    const c = RECOIL_CONVARS;
    const punch = this.punch;
    const decay = Math.exp(-c.weapon_recoil_decay2_exp * dt);
    punch.pitch *= decay;
    punch.yaw *= decay;
    const length = Math.hypot(punch.pitch, punch.yaw);
    const linear = c.weapon_recoil_decay2_lin * dt;
    const keep = length > linear ? 1 - linear / length : 0;
    punch.pitch = punch.pitch * keep + this.velocity.pitch * dt * 0.5;
    punch.yaw = punch.yaw * keep + this.velocity.yaw * dt * 0.5;
    const velocityDecay = Math.exp(-c.weapon_recoil_vel_decay * dt);
    this.velocity.pitch *= velocityDecay;
    this.velocity.yaw *= velocityDecay;
    punch.pitch += this.velocity.pitch * dt * 0.5;
    punch.yaw += this.velocity.yaw * dt * 0.5;

    if (!stats?.recoveryTime) return;
    const recovery = ducked ? stats.recoveryTime.crouch : stats.recoveryTime.stand;
    const fall = Math.exp(-RECOVERY_DECADE * dt / recovery);
    this.penalty *= fall;
    if (time - this.lastShot > stats.cycleTime) this.index *= fall;
  }

  /** Where bullets go, relative to the view angles. */
  get aimOffset() {
    const scale = RECOIL_CONVARS.weapon_recoil_scale;
    return { pitch: this.punch.pitch * scale, yaw: this.punch.yaw * scale };
  }

  /** How far the camera itself is kicked. */
  get viewOffset() {
    const scale = RECOIL_CONVARS.weapon_recoil_scale * RECOIL_CONVARS.view_recoil_tracking;
    return { pitch: this.punch.pitch * scale, yaw: this.punch.yaw * scale };
  }
}
