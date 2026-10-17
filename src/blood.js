/**
 * Blood spray where a bullet or knife hits someone: a quick mist and a few
 * droplets thrown out along the hit, falling under gravity and fading
 * within half a second. Drawn as camera-facing quads, depth tested.
 */
import { createProgram, Mesh } from './gl.js';
import { BLOOD_SHADER } from './shaders.js';

const MAX_PARTICLES = 160;
const DROPLETS = 12;
const GRAVITY = 500;
const LAYOUT = [['aPosition', 3], ['aCorner', 2], ['aFade', 1]];
const FLOATS_PER_PARTICLE = 6 * 6;
const CORNERS = [[-1, -1], [1, -1], [1, 1], [-1, -1], [1, 1], [-1, 1]];

const spread = (amount) => (Math.random() * 2 - 1) * amount;

export class Blood {
  constructor(gl) {
    this.gl = gl;
    this.program = createProgram(gl, BLOOD_SHADER);
    this.mesh = new Mesh(gl, this.program, LAYOUT);
    this.data = new Float32Array(MAX_PARTICLES * FLOATS_PER_PARTICLE);
    this.particles = [];
  }

  clear() {
    this.particles = [];
  }

  /** A spray at `point` from a hit travelling along the unit `direction`, at `time`. */
  spray(point, direction, time) {
    const add = (particle) => {
      if (this.particles.length >= MAX_PARTICLES) this.particles.shift();
      this.particles.push({ from: { ...point }, birth: time, ...particle });
    };
    add({ velocity: { x: direction.x * 30, y: direction.y * 30, z: 10 }, size: 5, grow: 18, life: 0.3, mist: true });
    for (let i = 0; i < DROPLETS; i++) {
      // Most droplets carry on with the bullet, a few spray back toward the shooter.
      const along = i < DROPLETS * 0.75 ? 60 + Math.random() * 120 : -(30 + Math.random() * 60);
      add({
        velocity: { x: direction.x * along + spread(70), y: direction.y * along + spread(70), z: direction.z * along + spread(50) + 40 },
        size: 0.6 + Math.random() * 1.1, grow: 0, life: 0.35 + Math.random() * 0.3, mist: false,
      });
    }
  }

  /** Draws the live particles facing the camera (`right` and `up`, unit world vectors). */
  draw(viewProjection, right, up, time) {
    this.particles = this.particles.filter((p) => time - p.birth < p.life);
    if (!this.particles.length) return;
    let count = 0;
    for (const p of this.particles) {
      const t = time - p.birth;
      const fall = p.mist ? 0 : 0.5 * GRAVITY * t * t;
      const center = [p.from.x + p.velocity.x * t, p.from.y + p.velocity.y * t, p.from.z + p.velocity.z * t - fall];
      const size = p.size + p.grow * t;
      const fade = (1 - t / p.life) * (p.mist ? 0.45 : 1);
      CORNERS.forEach(([cx, cy], i) => {
        this.data.set([
          center[0] + (right.x * cx + up.x * cy) * size,
          center[1] + (right.y * cx + up.y * cy) * size,
          center[2] + (right.z * cx + up.z * cy) * size,
          cx, cy, fade,
        ], (count * 6 + i) * 6);
      });
      count++;
    }
    const gl = this.gl;
    this.mesh.upload(this.data.subarray(0, count * FLOATS_PER_PARTICLE), gl.DYNAMIC_DRAW);
    gl.useProgram(this.program.program);
    gl.uniformMatrix4fv(this.program.uniforms.uViewProjection, false, viewProjection);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(false);
    this.mesh.draw(gl.TRIANGLES);
    gl.depthMask(true);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
  }
}
