import { PLAYER } from './config.js';
import { vec3 } from './vector.js';

/** Player state. Angles are in degrees: yaw turns left, positive pitch looks down. */
export class Player {
  constructor() {
    this.pos = vec3();          // feet origin
    this.vel = vec3();
    this.yaw = 0;
    this.pitch = 0;
    this.ground = null;         // the box we stand on (the ground entity)
    this.ducked = false;
    this.jumpHeld = false;      // jump held last tick, so holding it does not hop again
    this.viewOffset = PLAYER.standEyeHeight;
    this.maxSpeed = PLAYER.maxSpeed;   // set by the held weapon
    this.previousEye = this.eye();
  }

  get hullHeight() {
    return this.ducked ? PLAYER.duckHeight : PLAYER.standHeight;
  }

  get horizontalSpeed() {
    return Math.hypot(this.vel.x, this.vel.y);
  }

  eye() {
    return { x: this.pos.x, y: this.pos.y, z: this.pos.z + this.viewOffset };
  }

  /** Spawns just above a surface so the first ground trace finds it. */
  /** `speed` starts the player moving horizontally along `yaw`. */
  placeAt(feet, yaw, speed = 0) {
    const radians = yaw * Math.PI / 180;
    this.pos = { x: feet.x, y: feet.y, z: feet.z + 1 };
    this.vel = vec3(Math.cos(radians) * speed, Math.sin(radians) * speed, 0);
    this.yaw = yaw;
    this.pitch = 0;
    this.ground = null;
    this.ducked = false;
    this.viewOffset = PLAYER.standEyeHeight;
    this.previousEye = this.eye();
  }
}
