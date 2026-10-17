/**
 * Bullet tracers: a short bright streak that flies from the gun to where the
 * bullet stopped, fast enough to cross the arena in a blink.
 */
import { createProgram, Mesh } from './gl.js';
import { TRACER_SHADER } from './shaders.js';
import { cross, normalize, sub } from './vector.js';

const SPEED = 6000;          // units per second
const LENGTH = 200;          // units from tail to head
const HEAD_START = LENGTH / 2;   // a new tracer already shows as a streak out of the muzzle
const MAX_TRACERS = 64;
const LAYOUT = [['aPosition', 3], ['aUv', 2]];
const FLOATS_PER_TRACER = 6 * 5;

const HALF_WIDTH_PIXELS = 1.5;   // the streak is about three pixels wide at any distance
const MIN_HALF_WIDTH = 0.12;      // units, and a little wider close to the gun

export class Tracers {
  constructor(gl) {
    this.gl = gl;
    this.program = createProgram(gl, TRACER_SHADER);
    this.mesh = new Mesh(gl, this.program, LAYOUT);
    this.data = new Float32Array(MAX_TRACERS * FLOATS_PER_TRACER);
    this.list = [];
  }

  clear() {
    this.list = [];
  }

  /** A tracer from `from` to `to` (world points), starting at `time`. */
  add(from, to, time) {
    const offset = sub(to, from);
    const distance = Math.hypot(offset.x, offset.y, offset.z);
    if (distance < 1) return;
    if (this.list.length >= MAX_TRACERS) this.list.shift();
    this.list.push({ from, direction: normalize(offset), distance, birth: time });
  }

  /**
   * Draws the live tracers; `pixel` is the size of a pixel one unit from the
   * eye, and `depthTested` is set where the world fills the depth buffer.
   */
  draw(viewProjection, eye, time, pixel, depthTested) {
    const travel = (tracer) => HEAD_START + (time - tracer.birth) * SPEED;
    this.list = this.list.filter((tracer) => travel(tracer) - LENGTH < tracer.distance);
    if (!this.list.length) return;
    let count = 0;
    for (const tracer of this.list) {
      const { from, direction, distance } = tracer;
      const travelled = travel(tracer);
      const point = (along) => ({ x: from.x + direction.x * along, y: from.y + direction.y * along, z: from.z + direction.z * along });
      const tail = point(Math.max(0, travelled - LENGTH));
      const head = point(Math.min(travelled, distance));
      const corners = [tail, head].map((p) => {
        const toEye = sub(p, eye);
        const side = normalize(cross(direction, toEye));
        const w = Math.max(MIN_HALF_WIDTH, Math.hypot(toEye.x, toEye.y, toEye.z) * pixel * HALF_WIDTH_PIXELS);
        return [[p.x + side.x * w, p.y + side.y * w, p.z + side.z * w], [p.x - side.x * w, p.y - side.y * w, p.z - side.z * w]];
      });
      const [[t1, t2], [h1, h2]] = corners;
      const fade = Math.min(travelled, LENGTH) / LENGTH;   // a streak just leaving the gun is still short and dim
      this.data.set([
        ...t1, 0, 1, ...h1, fade, 1, ...h2, fade, -1,
        ...t1, 0, 1, ...h2, fade, -1, ...t2, 0, -1,
      ], count * FLOATS_PER_TRACER);
      count++;
    }
    if (!count) return;
    const gl = this.gl;
    this.mesh.upload(this.data.subarray(0, count * FLOATS_PER_TRACER), gl.DYNAMIC_DRAW);
    gl.useProgram(this.program.program);
    gl.uniformMatrix4fv(this.program.uniforms.uViewProjection, false, viewProjection);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    if (depthTested) gl.enable(gl.DEPTH_TEST);
    gl.depthMask(false);
    this.mesh.draw(gl.TRIANGLES);
    gl.depthMask(true);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
  }
}
