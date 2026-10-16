/**
 * When movement sounds play, following the classic step logic:
 * a step every 300 ms while running (400 ms ducked), silent below the
 * walk threshold, so Shift-walking makes no noise. Jumping plays the jump
 * launch, and landing plays the surface's landing sound, louder for harder falls.
 */
const RUN_STEP_TIME = 0.3;
const DUCK_STEP_TIME = 0.4;
const SILENT_BELOW_SPEED = 135;
const RUN_VOLUME = 0.5;
const MIN_LANDING_SPEED = 180;
const HARD_LANDING_SPEED = 580;

export class Footsteps {
  constructor(sounds) {
    this.sounds = sounds;
    this.timer = 0;
    this.surface = 'default';
  }

  /** Call once per tick after movement, with the ground state from before it. */
  update(player, world, { wasOnGround, fallSpeed }, dt) {
    this.timer = Math.max(0, this.timer - dt);
    if (player.ground) this.surface = world.surfaceAt(player.ground, player.groundPlane);

    if (wasOnGround && !player.ground && player.vel.z > 0) {
      this.sounds.jump(0.8);
      return;
    }
    if (!wasOnGround && player.ground) {
      if (fallSpeed > MIN_LANDING_SPEED) {
        this.sounds.land(this.surface, Math.min(1, 0.4 + fallSpeed / HARD_LANDING_SPEED));
        this.timer = DUCK_STEP_TIME;
      }
      return;
    }
    if (player.ground && this.timer === 0 && player.horizontalSpeed > SILENT_BELOW_SPEED) {
      this.sounds.step(this.surface, RUN_VOLUME);
      this.timer = player.ducked ? DUCK_STEP_TIME : RUN_STEP_TIME;
    }
  }
}
