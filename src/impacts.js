/**
 * Marks on surfaces: bullet holes where bullets hit, and blood splats on
 * walls behind someone hit. The last few dozen are kept, each a small quad
 * on the surface, until newer ones replace them.
 */
import { createProgram, Mesh } from './gl.js';
import { IMPACT_SHADER } from './shaders.js';
import { cross, normalize } from './vector.js';

const MAX_IMPACTS = 96;
const HALF_SIZE = { hole: 2, blood: 7 };   // units; bullet holes are about 4 units across
const KIND = { hole: 0, blood: 1 };
const LIFT = 0.1;             // off the surface, so the quad does not fight it for depth
const LAYOUT = [['aPosition', 3], ['aUv', 2], ['aBirth', 1], ['aKind', 1]];
const FLOATS_PER_IMPACT = 6 * 7;

export class Impacts {
  constructor(gl) {
    this.gl = gl;
    this.program = createProgram(gl, IMPACT_SHADER);
    this.mesh = new Mesh(gl, this.program, LAYOUT);
    this.data = new Float32Array(MAX_IMPACTS * FLOATS_PER_IMPACT);
    this.count = 0;
    this.next = 0;
    this.dirty = false;
  }

  clear() {
    this.count = 0;
    this.next = 0;
    this.dirty = true;
  }

  /** A mark of `kind` ('hole' or 'blood') at `point` on a surface facing `normal`; blood splats get a random size and turn. */
  add(point, normal, time, kind = 'hole') {
    const helper = Math.abs(normal.z) < 0.9 ? { x: 0, y: 0, z: 1 } : { x: 1, y: 0, z: 0 };
    const turn = Math.random() * Math.PI * 2;
    const [c, s] = [Math.cos(turn), Math.sin(turn)];
    const a = normalize(cross(normal, helper));
    const b = cross(normal, a);
    const u = { x: a.x * c + b.x * s, y: a.y * c + b.y * s, z: a.z * c + b.z * s };
    const v = cross(normal, u);
    const size = HALF_SIZE[kind] * (kind === 'blood' ? 0.6 + Math.random() * 0.8 : 1);
    const corner = (su, sv) => [
      point.x + normal.x * LIFT + (u.x * su + v.x * sv) * size,
      point.y + normal.y * LIFT + (u.y * su + v.y * sv) * size,
      point.z + normal.z * LIFT + (u.z * su + v.z * sv) * size,
      (su + 1) / 2, (sv + 1) / 2, time, KIND[kind],
    ];
    const [q0, q1, q2, q3] = [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)];
    this.data.set([...q0, ...q1, ...q2, ...q0, ...q2, ...q3], this.next * FLOATS_PER_IMPACT);
    this.next = (this.next + 1) % MAX_IMPACTS;
    this.count = Math.min(this.count + 1, MAX_IMPACTS);
    this.dirty = true;
  }

  /** `glow`: the additive course look; otherwise dark holes blended over a depth-tested map. */
  draw(viewProjection, time, glow) {
    if (this.count === 0) return;
    const gl = this.gl;
    if (this.dirty) {
      this.mesh.upload(this.data.subarray(0, this.count * FLOATS_PER_IMPACT), gl.DYNAMIC_DRAW);
      this.dirty = false;
    }
    const { program, uniforms } = this.program;
    gl.useProgram(program);
    gl.uniformMatrix4fv(uniforms.uViewProjection, false, viewProjection);
    gl.uniform1f(uniforms.uTime, time);
    gl.uniform1f(uniforms.uGlow, glow ? 1 : 0);
    gl.enable(gl.BLEND);
    if (glow) {
      gl.blendFunc(gl.ONE, gl.ONE);
    } else {
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.enable(gl.DEPTH_TEST);
      gl.depthMask(false);
      gl.enable(gl.POLYGON_OFFSET_FILL);
      gl.polygonOffset(-1, -4);
    }
    this.mesh.draw(gl.TRIANGLES);
    gl.disable(gl.POLYGON_OFFSET_FILL);
    gl.depthMask(true);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
  }
}
