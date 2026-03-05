/**
 * lutExport.ts
 *
 * Off-screen WebGL2 renderer for applying a 3D LUT during media export.
 *
 * Usage:
 *   const exporter = await LutExporter.create(lutUrl, strength);
 *   exporter.render(imageOrVideoFrame, width, height);
 *   ctx2d.drawImage(exporter.canvas, 0, 0);  // transfer to encoding canvas
 *   exporter.destroy();
 *
 * The canvas is created with `preserveDrawingBuffer: true` so its pixels
 * remain readable after each render call (required for ctx2d.drawImage).
 */

import { fetchParseCubeLut } from './parseCubeLut';

// ── Shaders (identical to LutFilterCanvas) ────────────────────────────────────
const VERTEX_SRC = `#version 300 es
in vec2 a_position;
in vec2 a_texCoord;
out vec2 v_texCoord;
void main() {
  gl_Position = vec4(a_position, 0.0, 1.0);
  v_texCoord  = vec2(a_texCoord.x, 1.0 - a_texCoord.y);
}
`;

const FRAGMENT_SRC = `#version 300 es
precision highp float;
precision highp sampler3D;
in vec2 v_texCoord;
uniform sampler2D u_image;
uniform sampler3D u_lut;
uniform bool      u_hasLut;
uniform float     u_lutSize;
uniform float     u_strength;
out vec4 outColor;
void main() {
  vec4 color = texture(u_image, v_texCoord);
  if (u_hasLut) {
    vec3 c = clamp(color.rgb, 0.0, 1.0);
    float scale  = (u_lutSize - 1.0) / u_lutSize;
    float offset = 0.5 / u_lutSize;
    vec3 lutCoord = c * scale + offset;
    vec3 lut_rgb  = texture(u_lut, lutCoord).rgb;
    outColor = vec4(mix(color.rgb, lut_rgb, u_strength), color.a);
  } else {
    outColor = color;
  }
}
`;

function compileShader(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader | null {
  const s = gl.createShader(type);
  if (!s) return null;
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    console.error('LutExporter shader error:', gl.getShaderInfoLog(s));
    gl.deleteShader(s);
    return null;
  }
  return s;
}

function linkProgram(gl: WebGL2RenderingContext, vs: WebGLShader, fs: WebGLShader): WebGLProgram | null {
  const p = gl.createProgram();
  if (!p) return null;
  gl.attachShader(p, vs);
  gl.attachShader(p, fs);
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    console.error('LutExporter program link error:', gl.getProgramInfoLog(p));
    gl.deleteProgram(p);
    return null;
  }
  return p;
}

export class LutExporter {
  readonly canvas: HTMLCanvasElement;
  private gl: WebGL2RenderingContext;
  private program: WebGLProgram;
  private vao: WebGLVertexArrayObject;
  private imageTexture: WebGLTexture;
  private lutTexture: WebGLTexture;
  private positionBuffer: WebGLBuffer;
  private texCoordBuffer: WebGLBuffer;
  private strengthLoc: WebGLUniformLocation | null;

  private constructor(
    canvas: HTMLCanvasElement,
    gl: WebGL2RenderingContext,
    program: WebGLProgram,
    vao: WebGLVertexArrayObject,
    imageTexture: WebGLTexture,
    lutTexture: WebGLTexture,
    positionBuffer: WebGLBuffer,
    texCoordBuffer: WebGLBuffer,
    strengthLoc: WebGLUniformLocation | null,
  ) {
    this.canvas         = canvas;
    this.gl             = gl;
    this.program        = program;
    this.vao            = vao;
    this.imageTexture   = imageTexture;
    this.lutTexture     = lutTexture;
    this.positionBuffer = positionBuffer;
    this.texCoordBuffer = texCoordBuffer;
    this.strengthLoc    = strengthLoc;
  }

  /**
   * Create an off-screen LUT renderer.
   * Returns null if WebGL2 is unavailable.
   * @param lutUrl  URL to the .cube file, or null for pass-through
   * @param strength  0–100
   */
  static async create(lutUrl: string | null, strength: number): Promise<LutExporter | null> {
    const canvas = document.createElement('canvas');
    // preserveDrawingBuffer lets ctx2d.drawImage read the pixels after render
    const gl = canvas.getContext('webgl2', { preserveDrawingBuffer: true }) as WebGL2RenderingContext | null;
    if (!gl) return null;

    // ── Shaders ─────────────────────────────────────────────────────────────
    const vs = compileShader(gl, gl.VERTEX_SHADER,   VERTEX_SRC);
    const fs = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SRC);
    if (!vs || !fs) return null;
    const program = linkProgram(gl, vs, fs);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!program) return null;
    gl.useProgram(program);

    // ── Full-screen quad ─────────────────────────────────────────────────────
    const posLoc = gl.getAttribLocation(program, 'a_position');
    const texLoc = gl.getAttribLocation(program, 'a_texCoord');

    const positionBuffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      -1, -1,  1, -1, -1,  1,
      -1,  1,  1, -1,  1,  1,
    ]), gl.STATIC_DRAW);

    const texCoordBuffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, texCoordBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      0, 0,  1, 0,  0, 1,
      0, 1,  1, 0,  1, 1,
    ]), gl.STATIC_DRAW);

    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    gl.enableVertexAttribArray(posLoc);
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);
    gl.enableVertexAttribArray(texLoc);
    gl.bindBuffer(gl.ARRAY_BUFFER, texCoordBuffer);
    gl.vertexAttribPointer(texLoc, 2, gl.FLOAT, false, 0, 0);

    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);

    // ── Image texture (unit 0) — re-uploaded each render() call ─────────────
    const imageTexture = gl.createTexture()!;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, imageTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));

    // ── LUT texture (unit 1) ─────────────────────────────────────────────────
    const lutTexture = gl.createTexture()!;
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_3D, lutTexture);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    const hasLutLoc  = gl.getUniformLocation(program, 'u_hasLut');
    const lutSizeLoc = gl.getUniformLocation(program, 'u_lutSize');
    const strengthLoc = gl.getUniformLocation(program, 'u_strength');
    gl.uniform1i(gl.getUniformLocation(program, 'u_image'), 0);
    gl.uniform1i(gl.getUniformLocation(program, 'u_lut'),   1);
    gl.uniform1f(strengthLoc, strength / 100);

    if (lutUrl) {
      try {
        const lut = await fetchParseCubeLut(lutUrl);
        const { size, data } = lut;
        const pixels = new Uint8Array(size * size * size * 4);
        for (let i = 0; i < size * size * size; i++) {
          pixels[i * 4]     = Math.round(Math.max(0, Math.min(255, data[i * 3]     * 255)));
          pixels[i * 4 + 1] = Math.round(Math.max(0, Math.min(255, data[i * 3 + 1] * 255)));
          pixels[i * 4 + 2] = Math.round(Math.max(0, Math.min(255, data[i * 3 + 2] * 255)));
          pixels[i * 4 + 3] = 255;
        }
        gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA8, size, size, size, 0, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        gl.uniform1i(hasLutLoc,  1);
        gl.uniform1f(lutSizeLoc, size);
      } catch (e) {
        console.error('LutExporter: failed to load LUT, exporting without colour grade:', e);
        gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA8, 1, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
        gl.uniform1i(hasLutLoc,  0);
        gl.uniform1f(lutSizeLoc, 1.0);
      }
    } else {
      gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA8, 1, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
      gl.uniform1i(hasLutLoc,  0);
      gl.uniform1f(lutSizeLoc, 1.0);
    }

    return new LutExporter(canvas, gl, program, vao, imageTexture, lutTexture, positionBuffer, texCoordBuffer, strengthLoc);
  }

  /**
   * Render a source frame through the LUT onto this.canvas.
   * Call ctx2d.drawImage(exporter.canvas, 0, 0) afterwards to blit to the
   * encoding canvas.
   */
  render(source: TexImageSource, width: number, height: number, strength: number): void {
    const gl = this.gl;

    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width  = width;
      this.canvas.height = height;
      gl.viewport(0, 0, width, height);
    }

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.imageTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);

    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);
    gl.uniform1f(this.strengthLoc, strength / 100);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  destroy(): void {
    const gl = this.gl;
    gl.deleteTexture(this.imageTexture);
    gl.deleteTexture(this.lutTexture);
    gl.deleteBuffer(this.positionBuffer);
    gl.deleteBuffer(this.texCoordBuffer);
    gl.deleteVertexArray(this.vao);
    gl.deleteProgram(this.program);
  }
}
