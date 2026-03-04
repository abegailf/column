/**
 * LutFilterCanvas.tsx
 *
 * WebGL2 canvas component that applies a 3D LUT colour grade to an image.
 *
 * Architecture
 * ────────────────────────────────────────────────────────────────────────────
 *  • The LUT is loaded directly from a .cube file (fetched as plain text,
 *    parsed by parseCubeLut.ts) and uploaded to a WebGL2 TEXTURE_3D.
 *    No intermediate PNG conversion is needed.
 *
 *  • The fragment shader samples the 3D texture with a single
 *    `texture(u_lut, lutCoord)` call — the GPU handles trilinear
 *    interpolation natively, which is more accurate and simpler than the
 *    manual two-bilinear-sample approach required for a 2D tiled PNG.
 *
 *  • Texel-centre remapping:
 *      UV = input * (size-1)/size + 0.5/size
 *    ensures that input 0.0 lands on the centre of the first texel and
 *    input 1.0 lands on the centre of the last texel, so GL_LINEAR
 *    never clamps the interpolation at the boundaries.
 *
 *  • Strength slider uses a lightweight renderRef so only the u_strength
 *    uniform is updated and redrawn — no image reload, no flash.
 *
 *  • The source image is fetched via fetch() → blob URL to avoid the
 *    CORS browser-cache conflict that arises when the same URL is first
 *    loaded by a plain <img> (no crossOrigin) and then re-requested with
 *    crossOrigin="anonymous" for WebGL.
 */

import React, { useEffect, useRef } from 'react';
import { fetchParseCubeLut } from '../lib/parseCubeLut';

// ── Vertex shader ─────────────────────────────────────────────────────────────
// Draws a full-screen quad.  Y is flipped because WebGL textures are uploaded
// with row 0 at the bottom while DOM images have row 0 at the top.
const vertexShaderSource = `#version 300 es
in vec2 a_position;
in vec2 a_texCoord;
out vec2 v_texCoord;

void main() {
  gl_Position = vec4(a_position, 0.0, 1.0);
  v_texCoord  = vec2(a_texCoord.x, 1.0 - a_texCoord.y);
}
`;

// ── Fragment shader ───────────────────────────────────────────────────────────
// Uses a sampler3D so the GPU performs native trilinear interpolation.
// No tile arithmetic needed — the whole LUT cube lives in a 3D texture.
const fragmentShaderSource = `#version 300 es
precision highp float;
precision highp sampler3D;

in vec2 v_texCoord;

uniform sampler2D u_image;   // source photograph
uniform sampler3D u_lut;     // 3D colour look-up table
uniform bool      u_hasLut;  // false → pass-through
uniform float     u_lutSize; // texels per axis (e.g. 32 or 25)
uniform float     u_strength;// 0.0 = original  1.0 = full grade

out vec4 outColor;

void main() {
  vec4 color = texture(u_image, v_texCoord);

  if (u_hasLut) {
    vec3 c = clamp(color.rgb, 0.0, 1.0);

    // Remap [0, 1] input to texel-centre UV coordinates so that:
    //   c = 0.0  →  UV = 0.5 / size          (centre of first texel)
    //   c = 1.0  →  UV = (size - 0.5) / size  (centre of last texel)
    // GL_LINEAR then trilinearly interpolates between adjacent texels.
    float scale  = (u_lutSize - 1.0) / u_lutSize;
    float offset = 0.5 / u_lutSize;
    vec3 lutCoord = c * scale + offset;

    vec3 lut_rgb = texture(u_lut, lutCoord).rgb;
    outColor = vec4(mix(color.rgb, lut_rgb, u_strength), color.a);
  } else {
    outColor = color;
  }
}
`;

// ── GL helpers ────────────────────────────────────────────────────────────────
function createShader(
  gl: WebGL2RenderingContext,
  type: number,
  source: string
): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    console.error('Shader compile error:', gl.getShaderInfoLog(shader));
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

function createProgram(
  gl: WebGL2RenderingContext,
  vs: WebGLShader,
  fs: WebGLShader
): WebGLProgram | null {
  const program = gl.createProgram();
  if (!program) return null;
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    console.error('Program link error:', gl.getProgramInfoLog(program));
    gl.deleteProgram(program);
    return null;
  }
  return program;
}

// ── Component ─────────────────────────────────────────────────────────────────
interface LutFilterCanvasProps {
  src: string;
  /** URL to a .cube LUT file served from public/ */
  lutUrl?: string | null;
  className?: string;
  style?: React.CSSProperties;
  /** Filter strength 0–100 (default 100 = full LUT applied) */
  strength?: number;
}

export function LutFilterCanvas({
  src,
  lutUrl,
  className,
  style,
  strength = 100,
}: LutFilterCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Always holds the latest strength so the async .then() callback and the
  // strength effect both read the current value without needing it in deps.
  const strengthRef = useRef(strength);
  strengthRef.current = strength;

  // Lightweight redraw function stored once GL resources are ready.
  // Calling it only updates u_strength and redraws — no image reload.
  const renderRef = useRef<((s: number) => void) | null>(null);

  // ── Main effect — runs when source image or LUT changes ──────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let cancelled = false;

    const gl = canvas.getContext('webgl2');
    if (!gl) {
      console.error('LutFilterCanvas: WebGL2 is not supported in this browser.');
      return;
    }

    // Show a transparent frame immediately while assets load
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    // GL resources — tracked so cleanup can free them precisely
    let imageTexture:  WebGLTexture | null = null;
    let lutTexture:    WebGLTexture | null = null;
    let program:       WebGLProgram | null = null;
    let positionBuffer: WebGLBuffer | null = null;
    let texCoordBuffer: WebGLBuffer | null = null;
    let vao:           WebGLVertexArrayObject | null = null;

    // Blob URLs created for the source image — revoked on cleanup
    const blobUrls: string[] = [];

    // Load the source image via fetch → blob URL so WebGL can use it as a
    // texture without triggering the CORS browser-cache conflict that occurs
    // when the same Unsplash URL is first cached without crossOrigin by a
    // plain <img> and then re-requested with crossOrigin="anonymous".
    const loadImage = async (url: string): Promise<HTMLImageElement> => {
      let imgSrc = url;
      if (!url.startsWith('blob:') && !url.startsWith('data:')) {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`Image fetch failed (${res.status}): ${url}`);
        const blob = await res.blob();
        imgSrc = URL.createObjectURL(blob);
        blobUrls.push(imgSrc);
      }
      return new Promise<HTMLImageElement>((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = imgSrc;
      });
    };

    // Fetch both assets in parallel
    Promise.all([
      loadImage(src),
      lutUrl ? fetchParseCubeLut(lutUrl) : Promise.resolve(null),
    ]).then(([image, lut]) => {
      if (cancelled) return;

      // ── Canvas / viewport setup ─────────────────────────────────────────
      const dpr = window.devicePixelRatio || 1;
      const maxWidth = 2048;
      let w = image.naturalWidth;
      let h = image.naturalHeight;
      if (w > maxWidth) { h = Math.floor(h * maxWidth / w); w = maxWidth; }

      canvas.width  = w * dpr;
      canvas.height = h * dpr;
      // Assigning canvas dimensions resets all WebGL state — re-clear
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.viewport(0, 0, canvas.width, canvas.height);

      // ── Shader program ─────────────────────────────────────────────────
      const vs = createShader(gl, gl.VERTEX_SHADER,   vertexShaderSource);
      const fs = createShader(gl, gl.FRAGMENT_SHADER, fragmentShaderSource);
      if (!vs || !fs) return;

      program = createProgram(gl, vs, fs);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      if (!program) return;
      gl.useProgram(program);

      // ── Full-screen quad geometry ──────────────────────────────────────
      const posLoc = gl.getAttribLocation(program, 'a_position');
      const texLoc = gl.getAttribLocation(program, 'a_texCoord');

      positionBuffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
        -1, -1,  1, -1, -1,  1,
        -1,  1,  1, -1,  1,  1,
      ]), gl.STATIC_DRAW);

      texCoordBuffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, texCoordBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
        0, 0,  1, 0,  0, 1,
        0, 1,  1, 0,  1, 1,
      ]), gl.STATIC_DRAW);

      vao = gl.createVertexArray();
      gl.bindVertexArray(vao);

      gl.enableVertexAttribArray(posLoc);
      gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
      gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

      gl.enableVertexAttribArray(texLoc);
      gl.bindBuffer(gl.ARRAY_BUFFER, texCoordBuffer);
      gl.vertexAttribPointer(texLoc, 2, gl.FLOAT, false, 0, 0);

      // Tight packing for all typed-array texture uploads below
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);

      // ── Source image → TEXTURE_2D on unit 0 ────────────────────────────
      imageTexture = gl.createTexture();
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, imageTexture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);

      // ── LUT → TEXTURE_3D on unit 1 ─────────────────────────────────────
      // WebGL2 TEXTURE_3D maps directly onto the .cube axis layout:
      //   X (width)  = R input axis    (R varies fastest in .cube)
      //   Y (height) = G input axis
      //   Z (depth)  = B input axis    (B varies slowest in .cube)
      // So we can upload the Float32 data as-is after converting to Uint8.
      //
      // RGBA8 (4 bytes/pixel) is used because:
      //   • Always row-aligned regardless of LUT size (no UNPACK_ALIGNMENT issue)
      //   • Filterable with GL_LINEAR in WebGL2 core without any extension
      //   • Sufficient precision (~0.2% max error) for a consumer filter app
      lutTexture = gl.createTexture();
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_3D, lutTexture);
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

      const hasLutLoc   = gl.getUniformLocation(program, 'u_hasLut');
      const lutSizeLoc  = gl.getUniformLocation(program, 'u_lutSize');
      const strengthLoc = gl.getUniformLocation(program, 'u_strength');
      const imageLoc    = gl.getUniformLocation(program, 'u_image');
      const lutLoc      = gl.getUniformLocation(program, 'u_lut');

      gl.uniform1i(imageLoc, 0); // TEXTURE0
      gl.uniform1i(lutLoc,   1); // TEXTURE1

      if (lut) {
        const { size, data } = lut;

        // Convert Float32 RGB → RGBA8 Uint8
        const pixels = new Uint8Array(size * size * size * 4);
        for (let i = 0; i < size * size * size; i++) {
          pixels[i * 4]     = Math.round(Math.max(0, Math.min(255, data[i * 3]     * 255)));
          pixels[i * 4 + 1] = Math.round(Math.max(0, Math.min(255, data[i * 3 + 1] * 255)));
          pixels[i * 4 + 2] = Math.round(Math.max(0, Math.min(255, data[i * 3 + 2] * 255)));
          pixels[i * 4 + 3] = 255;
        }

        gl.texImage3D(
          gl.TEXTURE_3D, 0, gl.RGBA8,
          size, size, size,
          0, gl.RGBA, gl.UNSIGNED_BYTE,
          pixels
        );
        gl.uniform1i(hasLutLoc,  1);
        gl.uniform1f(lutSizeLoc, size);
      } else {
        // No LUT — upload a 1×1×1 placeholder so the sampler3D binding
        // remains valid (avoids a "no texture" warning in some drivers)
        gl.texImage3D(
          gl.TEXTURE_3D, 0, gl.RGBA8,
          1, 1, 1,
          0, gl.RGBA, gl.UNSIGNED_BYTE,
          new Uint8Array([0, 0, 0, 255])
        );
        gl.uniform1i(hasLutLoc,  0);
        gl.uniform1f(lutSizeLoc, 1.0);
      }

      // ── Render function ────────────────────────────────────────────────
      // Lightweight redraw: only updates u_strength and calls drawArrays.
      // All other state (program, VAO, textures) is already bound.
      const render = (s: number) => {
        if (!program) return;
        gl.useProgram(program);
        gl.bindVertexArray(vao);
        gl.uniform1f(strengthLoc, s / 100);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
      };

      // Initial draw — use current strength at load time
      render(strengthRef.current);

      // Expose for the strength effect below
      renderRef.current = render;
    }).catch((err: unknown) => {
      if (!cancelled) console.error('LutFilterCanvas render error:', err);
    });

    // ── Cleanup ───────────────────────────────────────────────────────────
    return () => {
      cancelled = true;
      renderRef.current = null;
      blobUrls.forEach((u) => URL.revokeObjectURL(u));
      if (gl) {
        if (imageTexture)  gl.deleteTexture(imageTexture);
        if (lutTexture)    gl.deleteTexture(lutTexture);
        if (positionBuffer) gl.deleteBuffer(positionBuffer);
        if (texCoordBuffer) gl.deleteBuffer(texCoordBuffer);
        if (vao)           gl.deleteVertexArray(vao);
        if (program)       gl.deleteProgram(program);
        // DO NOT call loseContext() — it destroys the context on the DOM node
        // and breaks re-renders when React StrictMode re-runs the effect.
      }
    };
  }, [src, lutUrl]);

  // ── Strength effect ───────────────────────────────────────────────────────
  // When only `strength` changes, skip the expensive image/LUT reload and
  // just call the stored render function. No flash, no network round-trip.
  useEffect(() => {
    renderRef.current?.(strength);
  }, [strength]);

  return <canvas ref={canvasRef} className={className} style={style} />;
}
