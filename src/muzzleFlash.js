/**
 * Muzzle flashes: a brief additive flare at a gun's muzzle, for the
 * first-person weapon and for opponents' guns in the world.
 */
import { createProgram } from './gl.js';
import { MUZZLE_SHADER } from './shaders.js';

export const FLASH_TIME = 0.05;   // seconds a flash shows

export class MuzzleFlash {
  constructor(gl) {
    this.gl = gl;
    this.program = createProgram(gl, MUZZLE_SHADER);
    this.vao = gl.createVertexArray();
  }

  /**
   * Draws a flash at `center` (in the space `modelView` maps from) of half
   * width `size` (eye-space units); `scale` is the projection's x and y
   * scale and `age` the seconds since the shot.
   */
  draw(projection, modelView, center, size, scale, age, seed) {
    if (age < 0 || age > FLASH_TIME) return;
    const gl = this.gl;
    const { program, uniforms } = this.program;
    gl.useProgram(program);
    gl.uniformMatrix4fv(uniforms.uProjection, false, projection);
    gl.uniformMatrix4fv(uniforms.uModelView, false, modelView);
    gl.uniform3fv(uniforms.uCenter, center);
    gl.uniform1f(uniforms.uSize, size * (0.85 + 0.3 * ((seed * 7.31) % 1)));
    gl.uniform2fv(uniforms.uScale, scale);
    gl.uniform1f(uniforms.uRotation, seed * 6.283);
    gl.uniform1f(uniforms.uIntensity, 1 - age / FLASH_TIME * 0.6);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.disable(gl.DEPTH_TEST);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.bindVertexArray(null);
    gl.disable(gl.BLEND);
  }
}
