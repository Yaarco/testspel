/** Thin WebGL2 helpers: shader programs and interleaved float meshes. */

function compile(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error(gl.getShaderInfoLog(shader));
  }
  return shader;
}

export function createProgram(gl, { vertex, fragment }) {
  const program = gl.createProgram();
  gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, vertex));
  gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, fragment));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(gl.getProgramInfoLog(program));
  }

  const uniforms = {};
  const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < count; i++) {
    const { name } = gl.getActiveUniform(program, i);
    uniforms[name] = gl.getUniformLocation(program, name);
  }
  return { program, uniforms };
}

/**
 * A vertex buffer of interleaved floats, optionally drawn through an index buffer.
 * `layout` lists attributes in order, e.g. [['aPosition', 3], ['aColor', 3]].
 */
export class Mesh {
  constructor(gl, { program }, layout) {
    this.gl = gl;
    this.count = 0;
    this.stride = layout.reduce((sum, [, size]) => sum + size, 0);
    this.vao = gl.createVertexArray();
    this.buffer = gl.createBuffer();

    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    let offset = 0;
    for (const [name, size] of layout) {
      const location = gl.getAttribLocation(program, name);
      if (location >= 0) {
        gl.enableVertexAttribArray(location);
        gl.vertexAttribPointer(location, size, gl.FLOAT, false, this.stride * 4, offset * 4);
      }
      offset += size;
    }
    gl.bindVertexArray(null);
  }

  upload(data, usage = this.gl.STATIC_DRAW) {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, data, usage);
    this.count = data.length / this.stride;
  }

  /** 32-bit indices; once set, draw() draws them instead of the raw vertex order. */
  uploadIndices(indices) {
    const gl = this.gl;
    this.indexBuffer ??= gl.createBuffer();
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    this.indexCount = indices.length;
  }

  dispose() {
    this.gl.deleteBuffer(this.buffer);
    if (this.indexBuffer) this.gl.deleteBuffer(this.indexBuffer);
    this.gl.deleteVertexArray(this.vao);
  }

  draw(mode) {
    const gl = this.gl;
    if (this.count === 0) return;
    gl.bindVertexArray(this.vao);
    if (this.indexBuffer) gl.drawElements(mode, this.indexCount, gl.UNSIGNED_INT, 0);
    else gl.drawArrays(mode, 0, this.count);
  }
}
