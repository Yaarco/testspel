/**
 * Perspective camera using the game's axes (X forward, Y left, Z up) and
 * view angles in degrees (yaw turns left, positive pitch looks down). Produces column-major
 * matrices for WebGL.
 */
import { VIEW } from './config.js';
import { toRadians } from './vector.js';

function multiply(a, b) {
  const out = new Float32Array(16);
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += a[k * 4 + row] * b[col * 4 + k];
      out[col * 4 + row] = sum;
    }
  }
  return out;
}

function perspective(aspect, near, far, zoom) {
  const f = 1 / (VIEW.verticalHalfFovTan * zoom);
  return new Float32Array([
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, (far + near) / (near - far), -1,
    0, 0, (2 * far * near) / (near - far), 0,
  ]);
}

/** World to eye space. GL looks down -Z, so the eye's Z axis is -forward. */
function lookMatrix(right, up, forward, eye) {
  const d = (v) => v.x * eye.x + v.y * eye.y + v.z * eye.z;
  return new Float32Array([
    right.x, up.x, -forward.x, 0,
    right.y, up.y, -forward.y, 0,
    right.z, up.z, -forward.z, 0,
    -d(right), -d(up), d(forward), 1,
  ]);
}

export class Camera {
  constructor() {
    this.eye = { x: 0, y: 0, z: 0 };
    this.zoom = 1;   // tan of half the field of view relative to the default 90 (scopes narrow it)
    this.viewProjection = new Float32Array(16);
    this.skyViewProjection = new Float32Array(16);  // rotation only, for things at infinity
  }

  set(eye, yawDegrees, pitchDegrees, aspect, near = VIEW.nearPlane, far = VIEW.farPlane) {
    const yaw = toRadians(yawDegrees);
    const pitch = toRadians(pitchDegrees);
    const [sy, cy, sp, cp] = [Math.sin(yaw), Math.cos(yaw), Math.sin(pitch), Math.cos(pitch)];

    const forward = { x: cp * cy, y: cp * sy, z: -sp };
    const right = { x: sy, y: -cy, z: 0 };
    const up = { x: sp * cy, y: sp * sy, z: cp };
    const projection = perspective(aspect, near, far, this.zoom);

    this.eye = eye;
    this.projectionScale = [projection[0], projection[5]];   // eye-space size to clip space, for sprites
    this.viewProjection = multiply(projection, lookMatrix(right, up, forward, eye));
    this.skyViewProjection = multiply(projection, lookMatrix(right, up, forward, { x: 0, y: 0, z: 0 }));
  }
}
